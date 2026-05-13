import { createInterface } from "node:readline";
import type { Message } from "@earendil-works/pi-ai";
import { type CoreEvent, wrapCoreEvent } from "../events/types.js";
import type { ChatRuntime } from "../runtime/chat_runtime.js";
import type { HistoryEntry } from "../session/core_session.js";
import {
  createRpcErrorResponse,
  createRpcEventMessage,
  createRpcReadyMessage,
  createRpcSuccessResponse,
  parseRpcRequestLine,
  RPC_ERROR_CODES,
  RPC_METHODS,
  RPC_PROTOCOL_VERSION,
  type RpcParseFailure,
  type RpcRequestId,
  type RpcRequestMessage,
  type RpcResultByMethod,
  serializeRpcMessage,
} from "./rpc_protocol.js";

export type RpcServerRuntime = Pick<ChatRuntime, "runTurn" | "interruptTurn" | "isTurnRunning"> & {
  session: {
    addUserText(text: string, options?: { historyEntryId?: string }): string;
    onEvent(handler: (event: CoreEvent) => void): () => void;
    reset(): void;
    dispose(): void;
    readonly history: readonly Message[];
    readonly historyEntries: readonly HistoryEntry[];
    readonly sessionId: string;
  };
};

export type RpcServerOptions = {
  runtime: RpcServerRuntime;
  send: (line: string) => void;
  emitReadyOnStart?: boolean;
};

export type RunRpcServerOptions = {
  runtime: RpcServerRuntime;
  input: NodeJS.ReadableStream;
  output: NodeJS.WritableStream;
  signal?: AbortSignal;
};

export class RpcServer {
  private readonly runtime: RpcServerRuntime;
  private readonly send: (line: string) => void;
  private unsubscribeEvent?: () => void;
  private activeSubmit?: Promise<void>;
  private activeSubmitRequestId?: RpcRequestId;
  private readonly submitRequestByUserHistoryEntryId = new Map<string, RpcRequestId>();
  private mutationQueue: Promise<void> = Promise.resolve();
  private pendingSessionMutations = 0;
  private initialized = false;
  private rpcShutdown = false;
  private closed = false;

  constructor(options: RpcServerOptions) {
    this.runtime = options.runtime;
    this.send = options.send;

    this.unsubscribeEvent = this.runtime.session.onEvent((event) => {
      if (this.rpcShutdown || this.closed) {
        return;
      }

      const requestId = this.resolveEventRequestId(event);
      this.sendMessage(createRpcEventMessage(wrapCoreEvent(event), { requestId }));
    });

    if (options.emitReadyOnStart ?? true) {
      this.emitReady();
    }
  }

  async handleLine(line: string): Promise<void> {
    if (this.closed) {
      return;
    }

    const parsed = parseRpcRequestLine(line);
    if (!parsed.ok) {
      this.sendParseFailure(parsed);
      return;
    }

    const request = parsed.request;

    if (this.rpcShutdown && request.method !== "initialize") {
      this.sendServerShutdownError(request.id);
      return;
    }

    try {
      switch (request.method) {
        case "initialize":
          this.handleInitialize(request);
          return;
        case "session.submit":
          await this.handleSubmit(request);
          return;
        case "session.interrupt":
          this.handleInterrupt(request);
          return;
        case "session.snapshot":
          this.handleSnapshot(request);
          return;
        case "session.reset":
          await this.handleReset(request);
          return;
        case "session.shutdown":
          await this.handleShutdown(request);
          return;
      }
    } catch (error) {
      this.sendMessage(
        createRpcErrorResponse(request.id, RPC_ERROR_CODES.internalError, "rpc request failed", {
          cause: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }

  async close(options: { interruptActiveSubmit?: boolean } = {}): Promise<void> {
    if (this.closed) {
      return;
    }

    this.closed = true;
    this.clearEventCorrelationState();
    this.unsubscribeEventListener();

    if (options.interruptActiveSubmit && (this.activeSubmit || this.runtime.isTurnRunning)) {
      this.runtime.interruptTurn();
    }

    this.runtime.session.dispose();
  }

  async shutdown(options: { interruptActiveSubmit?: boolean } = {}): Promise<void> {
    await this.close(options);
  }

  private emitReady(): void {
    this.sendMessage(
      createRpcReadyMessage({
        sessionId: this.runtime.session.sessionId,
      }),
    );
  }

  private sendParseFailure(parsed: RpcParseFailure): void {
    this.sendMessage(
      createRpcErrorResponse(parsed.id, parsed.error.code, parsed.error.message, parsed.error.data),
    );
  }

  private handleInitialize(request: Extract<RpcRequestMessage, { method: "initialize" }>): void {
    const result: RpcResultByMethod["initialize"] = {
      protocolVersion: RPC_PROTOCOL_VERSION,
      sessionId: this.runtime.session.sessionId,
      methods: [...RPC_METHODS],
      alreadyInitialized: this.initialized,
    };

    this.initialized = true;
    this.sendMessage(createRpcSuccessResponse(request.id, result));
  }

  private async handleSubmit(
    request: Extract<RpcRequestMessage, { method: "session.submit" }>,
  ): Promise<void> {
    if (this.pendingSessionMutations > 0) {
      this.sendSubmitBusy(request.id);
      return;
    }

    const startedSubmit = await this.enqueueMutation(() => {
      if (this.rpcShutdown) {
        this.sendServerShutdownError(request.id);
        return undefined;
      }

      if (this.activeSubmit || this.runtime.isTurnRunning) {
        this.sendSubmitBusy(request.id);
        return undefined;
      }

      const addOptions = request.params.historyEntryId
        ? { historyEntryId: request.params.historyEntryId }
        : undefined;
      const userHistoryEntryId = this.runtime.session.addUserText(request.params.text, addOptions);
      this.submitRequestByUserHistoryEntryId.set(userHistoryEntryId, request.id);
      this.activeSubmitRequestId = request.id;

      const submitPromise = this.executeSubmit(request.id, userHistoryEntryId);
      this.activeSubmit = submitPromise;

      return {
        submitPromise,
      };
    });

    if (!startedSubmit) {
      return;
    }

    const { submitPromise } = startedSubmit;

    try {
      await submitPromise;
    } finally {
      await this.enqueueMutation(() => {
        if (this.activeSubmit === submitPromise) {
          this.activeSubmit = undefined;
          this.activeSubmitRequestId = undefined;
        }
      });
    }
  }

  private async executeSubmit(requestId: RpcRequestId, userHistoryEntryId: string): Promise<void> {
    try {
      const turnResult = await this.runtime.runTurn();

      const result: RpcResultByMethod["session.submit"] = {
        userHistoryEntryId,
        turn: {
          aborted: turnResult.aborted,
          ...(turnResult.blocked ? { blocked: turnResult.blocked } : {}),
        },
      };

      this.sendMessage(createRpcSuccessResponse(requestId, result));
    } catch (error) {
      this.sendMessage(
        createRpcErrorResponse(
          requestId,
          RPC_ERROR_CODES.internalError,
          "failed to run session turn",
          { cause: error instanceof Error ? error.message : String(error) },
        ),
      );
    }
  }

  private handleInterrupt(
    request: Extract<RpcRequestMessage, { method: "session.interrupt" }>,
  ): void {
    const interrupted = this.runtime.interruptTurn();

    const result: RpcResultByMethod["session.interrupt"] = {
      interrupted,
      isTurnRunning: this.runtime.isTurnRunning,
    };

    this.sendMessage(createRpcSuccessResponse(request.id, result));
  }

  private handleSnapshot(
    request: Extract<RpcRequestMessage, { method: "session.snapshot" }>,
  ): void {
    const result: RpcResultByMethod["session.snapshot"] = {
      sessionId: this.runtime.session.sessionId,
      isTurnRunning: this.runtime.isTurnRunning,
      historyLength: this.runtime.session.history.length,
      history: [...this.runtime.session.history],
      historyEntries: this.runtime.session.historyEntries.map((entry) => ({
        id: entry.id,
        message: entry.message,
      })),
    };

    this.sendMessage(createRpcSuccessResponse(request.id, result));
  }

  private async handleReset(
    request: Extract<RpcRequestMessage, { method: "session.reset" }>,
  ): Promise<void> {
    await this.runSessionMutation(async () => {
      if (this.rpcShutdown) {
        this.sendServerShutdownError(request.id);
        return;
      }

      await this.interruptAndWaitForActiveSubmit();

      const previousSessionId = this.runtime.session.sessionId;
      this.runtime.session.reset();
      this.clearEventCorrelationState();

      const result: RpcResultByMethod["session.reset"] = {
        previousSessionId,
        sessionId: this.runtime.session.sessionId,
      };

      this.sendMessage(createRpcSuccessResponse(request.id, result));
    });
  }

  private async handleShutdown(
    request: Extract<RpcRequestMessage, { method: "session.shutdown" }>,
  ): Promise<void> {
    await this.runSessionMutation(async () => {
      if (this.rpcShutdown) {
        const result: RpcResultByMethod["session.shutdown"] = {
          shutdown: true,
        };
        this.sendMessage(createRpcSuccessResponse(request.id, result));
        return;
      }

      await this.interruptAndWaitForActiveSubmit();

      this.rpcShutdown = true;
      this.clearEventCorrelationState();
      this.unsubscribeEventListener();

      const result: RpcResultByMethod["session.shutdown"] = {
        shutdown: true,
      };

      this.sendMessage(createRpcSuccessResponse(request.id, result));
    });
  }

  private sendServerShutdownError(id: RpcRequestId): void {
    this.sendMessage(
      createRpcErrorResponse(id, RPC_ERROR_CODES.invalidRequest, "rpc server is shut down"),
    );
  }

  private sendSubmitBusy(id: RpcRequestId): void {
    const message =
      this.pendingSessionMutations > 0
        ? "a mutating session request is in progress"
        : "a session turn is already running";

    this.sendMessage(createRpcErrorResponse(id, RPC_ERROR_CODES.busy, message));
  }

  private enqueueMutation<T>(handler: () => Promise<T> | T): Promise<T> {
    const run = this.mutationQueue.then(handler);
    this.mutationQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async runSessionMutation<T>(handler: () => Promise<T>): Promise<T> {
    this.pendingSessionMutations += 1;
    try {
      return await this.enqueueMutation(handler);
    } finally {
      this.pendingSessionMutations -= 1;
    }
  }

  private async interruptAndWaitForActiveSubmit(): Promise<void> {
    if (!this.activeSubmit && !this.runtime.isTurnRunning) {
      return;
    }

    this.runtime.interruptTurn();

    if (!this.activeSubmit) {
      return;
    }

    try {
      await this.activeSubmit;
    } catch {
      // ignore submit failure while finishing active mutation
    }
  }

  private resolveEventRequestId(event: CoreEvent): RpcRequestId | undefined {
    if (event.type === "subagent_ui") {
      return this.submitRequestByUserHistoryEntryId.get(event.originHistoryEntryId);
    }

    return this.activeSubmitRequestId;
  }

  private clearEventCorrelationState(): void {
    this.activeSubmitRequestId = undefined;
    this.submitRequestByUserHistoryEntryId.clear();
  }

  private unsubscribeEventListener(): void {
    if (!this.unsubscribeEvent) {
      return;
    }

    this.unsubscribeEvent();
    this.unsubscribeEvent = undefined;
  }

  private sendMessage(message: Parameters<typeof serializeRpcMessage>[0]): void {
    this.send(serializeRpcMessage(message));
  }
}

export async function runRpcServer(options: RunRpcServerOptions): Promise<void> {
  const server = new RpcServer({
    runtime: options.runtime,
    send: (line) => {
      options.output.write(`${line}\n`);
    },
    emitReadyOnStart: true,
  });

  const lineReader = createInterface({
    input: options.input,
    crlfDelay: Number.POSITIVE_INFINITY,
  });

  const inFlightHandlers = new Set<Promise<void>>();
  let firstError: unknown;
  let stopRequested = false;

  const trackInFlight = (promise: Promise<void>) => {
    inFlightHandlers.add(promise);
    void promise
      .catch((error) => {
        if (firstError === undefined) {
          firstError = error;
        }
      })
      .finally(() => {
        inFlightHandlers.delete(promise);
      });
  };

  const requestStop = () => {
    if (stopRequested) {
      return;
    }

    stopRequested = true;
    lineReader.close();

    if (typeof options.input.pause === "function") {
      options.input.pause();
    }
  };

  const onLine = (line: string) => {
    const handler = server.handleLine(line);
    trackInFlight(handler);
  };

  const onAbort = () => {
    requestStop();
  };

  lineReader.on("line", onLine);

  const closePromise = new Promise<void>((resolve) => {
    lineReader.once("close", resolve);
  });

  if (options.signal) {
    if (options.signal.aborted) {
      requestStop();
    }
    options.signal.addEventListener("abort", onAbort);
  }

  try {
    await closePromise;
  } finally {
    lineReader.off("line", onLine);
    options.signal?.removeEventListener("abort", onAbort);

    await server.shutdown({ interruptActiveSubmit: true });

    if (inFlightHandlers.size > 0) {
      await Promise.allSettled([...inFlightHandlers]);
    }
  }

  if (firstError !== undefined) {
    throw firstError;
  }
}
