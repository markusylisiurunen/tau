import { randomUUID } from "node:crypto";
import {
  createSessionProtocolPendingUserMessagesMessage,
  type SessionProtocolPendingUserMessage,
  type SessionProtocolPendingUserMessagesMessage,
  type SessionProtocolPendingUserMessagesState,
  type SessionProtocolTurnOutcome,
  type SessionProtocolUserMessageTurnResult,
} from "../protocol/session_protocol.js";
import type { TauHostedSession } from "./session_host.js";

export class SessionInputBusyError extends Error {}
export class SessionInputCancelledError extends Error {}

type PendingInput = {
  message: SessionProtocolPendingUserMessage;
  resolve: (result: SessionProtocolUserMessageTurnResult) => void;
  reject: (error: unknown) => void;
} & (
  | { delivery: "when-idle"; start: () => Promise<SessionProtocolUserMessageTurnResult> }
  | { delivery: "turn-boundary"; steeringId: string }
);

export class HostedSessionInput {
  private mutationQueue = Promise.resolve();
  private pendingMutations = 0;
  private readonly listeners = new Set<
    (message: SessionProtocolPendingUserMessagesMessage) => void
  >();
  private pending: PendingInput[] = [];
  private revision = 1;
  private active?: Promise<unknown>;
  private closed = false;
  interrupting = false;

  constructor(private readonly session: TauHostedSession) {}

  get busy(): boolean {
    return Boolean(this.active) || this.session.isTurnRunning;
  }

  get hasPending(): boolean {
    return this.pending.length > 0;
  }

  snapshot(): SessionProtocolPendingUserMessagesState {
    return {
      revision: this.revision,
      messages: this.inDeliveryOrder().map((input) => ({ ...input.message })),
    };
  }

  onChange(listener: (message: SessionProtocolPendingUserMessagesMessage) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  submit(
    mode: "submit" | "queue" | "steer",
    options: { text: string; historyEntryId?: string },
  ): Promise<SessionProtocolUserMessageTurnResult> {
    if (this.closed) throw new SessionInputCancelledError("session was unloaded");
    if (this.pendingMutations > 0 || (mode === "steer" && this.interrupting)) {
      throw new SessionInputBusyError("a mutating session request is in progress");
    }
    if (mode === "steer" && this.session.canAcceptSteering) {
      const submission = this.session.steer(options.text);
      return new Promise((resolve, reject) => {
        const input: PendingInput = {
          message: { id: randomUUID(), mode, text: options.text },
          delivery: "turn-boundary",
          steeringId: submission.id,
          resolve,
          reject,
        };
        this.pending.push(input);
        this.publish();
        void submission.applied.then(
          () => this.remove([input]),
          () => undefined,
        );
        void submission.result
          .then(resolve, async (error) => {
            const applied = await submission.applied.then(
              () => true,
              () => false,
            );
            reject(
              this.closed && !applied
                ? new SessionInputCancelledError("session was unloaded")
                : error,
            );
          })
          .finally(() => this.remove([input]));
      });
    }
    if (!this.busy) return this.start(() => this.session.submitTurn(options));
    if (mode === "submit") throw new SessionInputBusyError("a session turn is already running");
    return new Promise((resolve, reject) => {
      this.pending.push({
        delivery: "when-idle",
        message: { id: randomUUID(), mode, text: options.text },
        start: () => this.session.submitTurn(options),
        resolve,
        reject,
      });
      this.publish();
    });
  }

  retry(): Promise<SessionProtocolTurnOutcome> {
    if (this.closed) throw new SessionInputCancelledError("session was unloaded");
    if (this.busy || this.pendingMutations > 0)
      throw new SessionInputBusyError("a session turn is already running");
    return this.start(() => this.session.retryTurn());
  }

  cancelPending(): SessionProtocolPendingUserMessage[] {
    const cancelled = new Set(this.session.cancelSteering().map((input) => input.id));
    const inputs = this.inDeliveryOrder().filter(
      (input) => input.delivery === "when-idle" || cancelled.has(input.steeringId),
    );
    this.reject(inputs, "pending user message was cancelled");
    return inputs.map((input) => ({ ...input.message }));
  }

  cancelBoundary(message: string): void {
    const cancelled = new Set(this.session.cancelSteering().map((input) => input.id));
    this.reject(
      this.pending.filter(
        (input) => input.delivery === "turn-boundary" && cancelled.has(input.steeringId),
      ),
      message,
    );
  }

  rejectPending(message: string): void {
    this.cancelBoundary(message);
    this.reject(
      this.pending.filter((input) => input.delivery === "when-idle"),
      message,
    );
  }

  close(): void {
    this.closed = true;
    this.reject(
      this.pending.filter((input) => input.delivery === "when-idle"),
      "session was unloaded",
    );
  }

  async waitForIdle(): Promise<void> {
    if (this.active) await this.active.catch(() => undefined);
  }

  enqueue<T>(operation: () => Promise<T> | T): Promise<T> {
    const run = this.mutationQueue.then(() => {
      if (this.closed) throw new SessionInputCancelledError("session was unloaded");
      return operation();
    });
    this.mutationQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  async mutate<T>(operation: () => Promise<T>): Promise<T> {
    this.pendingMutations += 1;
    try {
      return await this.enqueue(operation);
    } finally {
      this.pendingMutations -= 1;
      this.drain();
    }
  }

  async waitForMutations(): Promise<void> {
    await this.mutationQueue;
  }

  private drain(): void {
    if (this.closed || this.busy || this.pendingMutations > 0) return;
    const input = this.pending.find((candidate) => candidate.delivery === "when-idle");
    if (!input) return;
    this.remove([input]);
    void this.start(input.start).then(input.resolve, input.reject);
  }

  private start<T>(operation: () => Promise<T>): Promise<T> {
    const result = operation();
    const completion = result
      .catch((error) => {
        const pending = this.pending.filter((input) => input.delivery === "when-idle");
        this.remove(pending);
        for (const input of pending) input.reject(error);
        throw error;
      })
      .finally(() => {
        if (this.active === completion) this.active = undefined;
        this.drain();
      });
    this.active = completion;
    return completion;
  }

  private inDeliveryOrder(): PendingInput[] {
    return [
      ...this.pending.filter((input) => input.delivery === "turn-boundary"),
      ...this.pending.filter((input) => input.delivery === "when-idle"),
    ];
  }

  private reject(inputs: PendingInput[], message: string): void {
    this.remove(inputs);
    for (const input of inputs) input.reject(new SessionInputCancelledError(message));
  }

  private remove(inputs: PendingInput[]): void {
    const removed = new Set(inputs);
    const remaining = this.pending.filter((input) => !removed.has(input));
    if (remaining.length === this.pending.length) return;
    this.pending = remaining;
    this.publish();
  }

  private publish(): void {
    this.revision += 1;
    const message = createSessionProtocolPendingUserMessagesMessage({
      sessionId: this.session.sessionId,
      state: this.snapshot(),
    });
    for (const listener of this.listeners) {
      try {
        listener(message);
      } catch {
        // Observer failures must not break shared session input.
      }
    }
  }
}
