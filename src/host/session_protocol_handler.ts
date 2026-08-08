import { randomUUID } from "node:crypto";
import {
  createSessionProtocolErrorResponse,
  createSessionProtocolPendingUserMessagesMessage,
  createSessionProtocolReadyMessage,
  createSessionProtocolSuccessResponse,
  SESSION_PROTOCOL_ERROR_CODES,
  SESSION_PROTOCOL_METHODS,
  SESSION_PROTOCOL_VERSION,
  type SessionProtocolClientToolDefinition,
  type SessionProtocolDeltaMessage,
  type SessionProtocolOutgoingMessage,
  type SessionProtocolPendingUserMessage,
  type SessionProtocolPendingUserMessagesMessage,
  type SessionProtocolPendingUserMessagesState,
  type SessionProtocolRequestId,
  type SessionProtocolRequestMessage,
  type SessionProtocolResultByMethod,
  type SessionProtocolSubagentActivitiesMessage,
} from "../protocol/session_protocol.js";
import {
  EphemeralThreadBusyError,
  SessionExecBusyError,
  SessionRetryUnavailableError,
  type TauHostedSession,
  type TauSessionHost,
} from "./session_host.js";

export type SessionProtocolHandlerOptions = {
  host: TauSessionHost;
  send: (message: SessionProtocolOutgoingMessage) => void;
};

type SessionProtocolHandlerCloseMode = "detach" | "interrupt" | "shutdown-host";

type SessionProtocolActiveSubmit = {
  promise: Promise<void>;
};

type SessionProtocolUserSubmissionRequest = Extract<
  SessionProtocolRequestMessage,
  { method: "session.submit" | "session.queue" | "session.steer" }
>;

type SessionProtocolPendingIdleSubmission = {
  id: string;
  delivery: "when-idle";
  handler: SessionProtocolHandler;
  request: Extract<SessionProtocolRequestMessage, { method: "session.queue" | "session.steer" }>;
};

type SessionProtocolPendingBoundarySubmission = {
  id: string;
  delivery: "turn-boundary";
  steeringId: string;
  handler: SessionProtocolHandler;
  request: Extract<SessionProtocolRequestMessage, { method: "session.steer" }>;
};

type SessionProtocolPendingUserSubmission =
  | SessionProtocolPendingIdleSubmission
  | SessionProtocolPendingBoundarySubmission;

type SessionProtocolUserSubmissionAction =
  | { type: "busy" }
  | { type: "pending" }
  | { type: "started"; activeSubmit: SessionProtocolActiveSubmit }
  | {
      type: "boundary";
      pending: SessionProtocolPendingBoundarySubmission;
      submission: ReturnType<TauHostedSession["steer"]>;
    };

type SessionProtocolLiveSessionState = {
  activeSubmit?: SessionProtocolActiveSubmit;
  interrupting: boolean;
  revision: number;
  pendingSubmissions: SessionProtocolPendingUserSubmission[];
  listeners: Set<(message: SessionProtocolPendingUserMessagesMessage) => void>;
};

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

type SessionProtocolHandlerSessionState = {
  session: TauHostedSession;
  live: SessionProtocolLiveSessionState;
  unsubscribeDelta?: () => void;
  unsubscribeEphemeral?: () => void;
  unsubscribePendingUserMessages?: () => void;
  unsubscribeSubagentActivities?: () => void;
  bufferedDeltas?: SessionProtocolDeltaMessage[];
  bufferedPendingUserMessages?: SessionProtocolPendingUserMessagesMessage[];
  bufferedSubagentActivities?: SessionProtocolSubagentActivitiesMessage[];
};

type SessionMutationQueueState = {
  queue: Promise<void>;
  pending: number;
};

const sessionMutationQueues = new WeakMap<TauHostedSession, SessionMutationQueueState>();
const sessionLiveStates = new WeakMap<TauHostedSession, SessionProtocolLiveSessionState>();

function getSessionLiveState(session: TauHostedSession): SessionProtocolLiveSessionState {
  let state = sessionLiveStates.get(session);
  if (!state) {
    state = {
      interrupting: false,
      revision: 1,
      pendingSubmissions: [],
      listeners: new Set(),
    };
    sessionLiveStates.set(session, state);
  }
  return state;
}

function pendingSubmissionsInDeliveryOrder(
  state: SessionProtocolLiveSessionState,
): SessionProtocolPendingUserSubmission[] {
  return [
    ...state.pendingSubmissions.filter((pending) => pending.delivery === "turn-boundary"),
    ...state.pendingSubmissions.filter((pending) => pending.delivery === "when-idle"),
  ];
}

function toPendingUserMessage(
  pending: SessionProtocolPendingUserSubmission,
): SessionProtocolPendingUserMessage {
  return {
    id: pending.id,
    mode: pending.request.method === "session.queue" ? "queue" : "steer",
    text: pending.request.params.text,
  };
}

function buildPendingUserMessagesState(
  state: SessionProtocolLiveSessionState,
): SessionProtocolPendingUserMessagesState {
  return {
    revision: state.revision,
    messages: pendingSubmissionsInDeliveryOrder(state).map(toPendingUserMessage),
  };
}

function publishPendingUserMessages(
  session: TauHostedSession,
  state: SessionProtocolLiveSessionState,
): void {
  state.revision += 1;
  const message = createSessionProtocolPendingUserMessagesMessage({
    sessionId: session.sessionId,
    state: buildPendingUserMessagesState(state),
  });
  for (const listener of [...state.listeners]) {
    try {
      listener(message);
    } catch {
      // Pending-message observers must not be able to fail shared session work.
    }
  }
}

function getSessionMutationQueueState(session: TauHostedSession): SessionMutationQueueState {
  let state = sessionMutationQueues.get(session);
  if (!state) {
    state = { queue: Promise.resolve(), pending: 0 };
    sessionMutationQueues.set(session, state);
  }
  return state;
}

type SessionProtocolMutationRequest = Extract<
  SessionProtocolRequestMessage,
  {
    method:
      | "session.record"
      | "session.setPersona"
      | "session.reload"
      | "session.compact"
      | "session.rewind"
      | "session.interruptSubagent";
  }
>;

export class SessionProtocolHandler {
  private readonly host: TauSessionHost;
  private readonly send: (message: SessionProtocolOutgoingMessage) => void;
  private readonly sessionStates = new Map<string, SessionProtocolHandlerSessionState>();
  private readonly connectionAbortController = new AbortController();
  private readonly activeSideChannels = new Set<Promise<void>>();
  private readonly activeExecAbortControllers = new Map<string, AbortController>();
  private initialized = false;
  private clientToolRegistration?: {
    attachSession: (sessionId: string) => void;
    detachSession: (sessionId: string) => void;
    unregister: () => void;
  };
  private closed = false;

  constructor(options: SessionProtocolHandlerOptions) {
    this.host = options.host;
    this.send = options.send;
    this.emitReady();
  }

  async handleRequest(request: SessionProtocolRequestMessage): Promise<void> {
    if (this.closed) {
      return;
    }

    try {
      switch (request.method) {
        case "initialize":
          this.handleInitialize(request);
          return;
        case "session.create":
          await this.handleCreate(request);
          return;
        case "session.list":
          await this.handleList(request);
          return;
        case "session.observe":
          await this.handleAttach(request);
          return;
        case "session.unobserve":
          await this.handleUnobserve(request);
          return;
        case "session.record":
          await this.handleRecord(request);
          return;
        case "session.submit":
          await this.handleSubmit(request);
          return;
        case "session.queue":
          await this.handleQueue(request);
          return;
        case "session.steer":
          await this.handleSteer(request);
          return;
        case "session.cancelPendingMessages":
          await this.handleCancelPendingMessages(request);
          return;
        case "session.retry":
          await this.handleRetry(request);
          return;
        case "session.exec":
          await this.handleExec(request);
          return;
        case "session.cancelExec":
          await this.handleCancelExec(request);
          return;
        case "session.sample":
          await this.handleSample(request);
          return;
        case "session.interrupt":
          await this.handleInterrupt(request);
          return;
        case "session.snapshot":
          await this.handleSnapshot(request);
          return;
        case "session.startGoal":
          await this.handleStartGoal(request);
          return;
        case "session.resumeGoal":
          await this.handleResumeGoal(request);
          return;
        case "session.clearGoal":
          await this.handleClearGoal(request);
          return;
        case "session.setReasoning":
          await this.handleSetReasoning(request);
          return;
        case "session.setPersona":
          await this.handleSetPersona(request);
          return;
        case "session.resolvePrompt":
          await this.handleResolvePrompt(request);
          return;
        case "session.autocompletePaths":
          await this.handleAutocompletePaths(request);
          return;
        case "session.reload":
          await this.handleReload(request);
          return;
        case "session.compact":
          await this.handleCompact(request);
          return;
        case "session.rewind":
          await this.handleRewind(request);
          return;
        case "session.interruptSubagent":
          await this.handleInterruptSubagent(request);
          return;
        case "session.ephemeral.create":
          await this.handleEphemeralCreate(request);
          return;
        case "session.ephemeral.submit":
          await this.handleEphemeralSubmit(request);
          return;
        case "session.ephemeral.close":
          await this.handleEphemeralClose(request);
          return;
        case "session.clientTool.ack":
          this.handleClientToolAck(request);
          return;
        case "session.clientTool.result":
          this.handleClientToolResult(request);
          return;
      }
    } catch (error) {
      this.sendMessage(
        createSessionProtocolErrorResponse(
          request.id,
          SESSION_PROTOCOL_ERROR_CODES.internalError,
          "session protocol request failed",
          {
            cause: error instanceof Error ? error.message : String(error),
          },
        ),
      );
    }
  }

  async close(mode: SessionProtocolHandlerCloseMode): Promise<void> {
    if (this.closed) {
      return;
    }

    this.closed = true;
    const shutdownHost = mode === "shutdown-host";
    const interruptActiveTurns = mode === "interrupt" || shutdownHost;

    const states = [...this.sessionStates.values()];
    const activeSideChannels = [...this.activeSideChannels];
    this.connectionAbortController.abort();

    for (const state of states) {
      this.unsubscribeSessionListeners(state);
      if (interruptActiveTurns) {
        state.session.interruptActiveWork();
      }
    }

    if (interruptActiveTurns) {
      await Promise.allSettled(states.map((state) => state.session.waitForActiveWork()));
      await Promise.allSettled(
        states.map((state) => state.live.activeSubmit?.promise).filter((promise) => promise),
      );
      await Promise.allSettled(
        states.map((state) => getSessionMutationQueueState(state.session).queue),
      );
    }
    await Promise.allSettled(activeSideChannels);

    this.sessionStates.clear();
    this.clientToolRegistration?.unregister();
    this.clientToolRegistration = undefined;

    if (shutdownHost) {
      await this.host.shutdown();
    }
  }

  private emitReady(): void {
    this.sendMessage(createSessionProtocolReadyMessage());
  }

  private handleInitialize(
    request: Extract<SessionProtocolRequestMessage, { method: "initialize" }>,
  ): void {
    const result: SessionProtocolResultByMethod["initialize"] = {
      protocolVersion: SESSION_PROTOCOL_VERSION,
      methods: [...SESSION_PROTOCOL_METHODS],
      alreadyInitialized: this.initialized,
    };

    if (!this.initialized && request.params.client.tools?.length) {
      this.registerClientTools(request.params.client.tools);
    }

    this.initialized = true;
    this.sendMessage(createSessionProtocolSuccessResponse(request.id, "initialize", result));
  }

  private registerClientTools(tools: SessionProtocolClientToolDefinition[]): void {
    if (!this.host.registerClientTools) {
      throw new Error("session host does not support client tools");
    }

    this.clientToolRegistration = this.host.registerClientTools({
      tools,
      sendCall: (message) => this.sendMessage(message),
      sendCancel: (message) => this.sendMessage(message),
    });
  }

  private handleClientToolAck(
    request: Extract<SessionProtocolRequestMessage, { method: "session.clientTool.ack" }>,
  ): void {
    const accepted =
      this.host.acknowledgeClientToolCall?.(request.params.sessionId, request.params.callId) ??
      false;
    this.sendMessage(
      createSessionProtocolSuccessResponse(request.id, "session.clientTool.ack", { accepted }),
    );
  }

  private handleClientToolResult(
    request: Extract<SessionProtocolRequestMessage, { method: "session.clientTool.result" }>,
  ): void {
    const result = request.params.ok
      ? { ok: true as const, content: request.params.content }
      : { ok: false as const, error: request.params.error };
    const accepted =
      this.host.completeClientToolCall?.(request.params.sessionId, request.params.callId, result) ??
      false;
    this.sendMessage(
      createSessionProtocolSuccessResponse(request.id, "session.clientTool.result", { accepted }),
    );
  }

  private async handleSubmit(
    request: Extract<SessionProtocolRequestMessage, { method: "session.submit" }>,
  ): Promise<void> {
    await this.handleUserSubmission(request);
  }

  private async handleQueue(
    request: Extract<SessionProtocolRequestMessage, { method: "session.queue" }>,
  ): Promise<void> {
    await this.handleUserSubmission(request);
  }

  private async handleSteer(
    request: Extract<SessionProtocolRequestMessage, { method: "session.steer" }>,
  ): Promise<void> {
    await this.handleUserSubmission(request);
  }

  private async handleUserSubmission(request: SessionProtocolUserSubmissionRequest): Promise<void> {
    const state = await this.getSessionState(request.params.sessionId);
    if (!state) {
      this.sendSessionNotFound(request.id, request.params.sessionId);
      return;
    }
    if (this.getPendingMutationCount(state) > 0) {
      this.sendSubmitBusy(state, request.id);
      return;
    }

    const action = await this.enqueueMutation(state, () =>
      this.dispatchUserSubmission(state, request),
    );
    if (action.type === "busy") {
      this.sendSubmitBusy(state, request.id);
      return;
    }
    if (action.type === "pending") {
      return;
    }
    if (action.type === "started") {
      await this.finishActiveSubmit(state, action.activeSubmit);
      return;
    }

    await this.finishBoundarySteering(state, action.pending, action.submission);
  }

  private async dispatchUserSubmission(
    state: SessionProtocolHandlerSessionState,
    request: SessionProtocolUserSubmissionRequest,
  ): Promise<SessionProtocolUserSubmissionAction> {
    if (request.method === "session.steer") {
      if (state.live.interrupting) {
        return { type: "busy" as const };
      }
      if (state.session.canAcceptSteering) {
        const submission = state.session.steer(request.params.text);
        const pending: SessionProtocolPendingBoundarySubmission = {
          id: randomUUID(),
          delivery: "turn-boundary",
          steeringId: submission.id,
          handler: this,
          request,
        };
        this.addPendingSubmission(state, pending);
        return { type: "boundary" as const, pending, submission };
      }
    }

    if (state.live.activeSubmit || state.session.isTurnRunning) {
      if (request.method === "session.submit") {
        return { type: "busy" as const };
      }
      const pending: SessionProtocolPendingIdleSubmission = {
        id: randomUUID(),
        delivery: "when-idle",
        handler: this,
        request,
      };
      this.addPendingSubmission(state, pending);
      return { type: "pending" as const };
    }

    return {
      type: "started",
      activeSubmit: await this.startUserMessageTurn(state, request),
    };
  }

  private async finishBoundarySteering(
    state: SessionProtocolHandlerSessionState,
    pending: SessionProtocolPendingBoundarySubmission,
    submission: ReturnType<TauHostedSession["steer"]>,
  ): Promise<void> {
    let applied = false;
    void submission.result.catch(() => {});
    try {
      await submission.applied;
      applied = true;
      await this.enqueueMutation(state, () => this.removePendingSubmission(state, pending));
      const result = await submission.result;
      this.sendMessage(
        createSessionProtocolSuccessResponse(pending.request.id, "session.steer", result),
      );
    } catch (error) {
      if (applied || state.live.pendingSubmissions.includes(pending)) {
        this.sendMessage(
          createSessionProtocolErrorResponse(
            pending.request.id,
            SESSION_PROTOCOL_ERROR_CODES.internalError,
            "steering turn failed",
            { cause: error instanceof Error ? error.message : String(error) },
          ),
        );
      }
    } finally {
      await this.enqueueMutation(state, () => this.removePendingSubmission(state, pending));
    }
  }

  private addPendingSubmission(
    state: SessionProtocolHandlerSessionState,
    pending: SessionProtocolPendingUserSubmission,
  ): void {
    state.live.pendingSubmissions.push(pending);
    publishPendingUserMessages(state.session, state.live);
  }

  private removePendingSubmission(
    state: SessionProtocolHandlerSessionState,
    pending: SessionProtocolPendingUserSubmission,
  ): boolean {
    return this.removePendingSubmissions(state, [pending]);
  }

  private removePendingSubmissions(
    state: SessionProtocolHandlerSessionState,
    pending: SessionProtocolPendingUserSubmission[],
  ): boolean {
    const removed = new Set(pending);
    const remaining = state.live.pendingSubmissions.filter(
      (submission) => !removed.has(submission),
    );
    if (remaining.length === state.live.pendingSubmissions.length) {
      return false;
    }
    state.live.pendingSubmissions = remaining;
    publishPendingUserMessages(state.session, state.live);
    return true;
  }

  private async finishActiveSubmit(
    state: SessionProtocolHandlerSessionState,
    activeSubmit: SessionProtocolActiveSubmit,
  ): Promise<void> {
    try {
      await activeSubmit.promise;
    } finally {
      await this.enqueueMutation(state, () => {
        if (state.live.activeSubmit === activeSubmit) {
          state.live.activeSubmit = undefined;
        }
      });
      this.schedulePendingSubmissionDrain(state);
    }
  }

  private async handleCancelPendingMessages(
    request: Extract<SessionProtocolRequestMessage, { method: "session.cancelPendingMessages" }>,
  ): Promise<void> {
    const state = await this.getSessionState(request.params.sessionId);
    if (!state) {
      this.sendSessionNotFound(request.id, request.params.sessionId);
      return;
    }

    const cancelled = await this.enqueueMutation(state, () => {
      const cancelledSteeringIds = new Set(
        state.session.cancelSteering().map((submission) => submission.id),
      );
      const pending = pendingSubmissionsInDeliveryOrder(state.live).filter(
        (submission) =>
          submission.delivery === "when-idle" || cancelledSteeringIds.has(submission.steeringId),
      );
      if (pending.length === 0) {
        return [];
      }

      this.removePendingSubmissions(state, pending);
      for (const item of pending) {
        item.handler.sendMessage(
          createSessionProtocolErrorResponse(
            item.request.id,
            SESSION_PROTOCOL_ERROR_CODES.cancelled,
            "pending user message was cancelled",
          ),
        );
      }
      return pending.map(toPendingUserMessage);
    });

    this.sendMessage(
      createSessionProtocolSuccessResponse(request.id, "session.cancelPendingMessages", {
        cancelled,
      }),
    );
  }

  private async handleExec(
    request: Extract<SessionProtocolRequestMessage, { method: "session.exec" }>,
  ): Promise<void> {
    const key = this.execKey(request.params.sessionId, request.params.execId);
    if (this.activeExecAbortControllers.has(key)) {
      this.sendMessage(
        createSessionProtocolErrorResponse(
          request.id,
          SESSION_PROTOCOL_ERROR_CODES.busy,
          `execution '${request.params.execId}' is already active`,
        ),
      );
      return;
    }

    const abortController = new AbortController();
    this.activeExecAbortControllers.set(key, abortController);
    try {
      const state = await this.getSessionState(request.params.sessionId);
      if (!state) {
        this.sendSessionNotFound(request.id, request.params.sessionId);
        return;
      }
      if (this.closed) {
        return;
      }

      await this.runSideChannel((signal) =>
        this.executeExec(state, request, AbortSignal.any([signal, abortController.signal])),
      );
    } finally {
      if (this.activeExecAbortControllers.get(key) === abortController) {
        this.activeExecAbortControllers.delete(key);
      }
    }
  }

  private async handleCancelExec(
    request: Extract<SessionProtocolRequestMessage, { method: "session.cancelExec" }>,
  ): Promise<void> {
    const key = this.execKey(request.params.sessionId, request.params.execId);
    const localController = this.activeExecAbortControllers.get(key);
    let cancelled = false;
    if (localController && !localController.signal.aborted) {
      localController.abort();
      cancelled = true;
    }

    const state = await this.getSessionState(request.params.sessionId);
    if (!state) {
      this.sendSessionNotFound(request.id, request.params.sessionId);
      return;
    }
    cancelled = state.session.cancelExec(request.params.execId) || cancelled;
    this.sendMessage(
      createSessionProtocolSuccessResponse(request.id, "session.cancelExec", { cancelled }),
    );
  }

  private async handleSample(
    request: Extract<SessionProtocolRequestMessage, { method: "session.sample" }>,
  ): Promise<void> {
    const state = await this.getSessionState(request.params.sessionId);
    if (!state) {
      this.sendSessionNotFound(request.id, request.params.sessionId);
      return;
    }
    if (this.closed) {
      return;
    }

    await this.runSideChannel((signal) => this.executeSample(state, request, signal));
  }

  private async handleRetry(
    request: Extract<SessionProtocolRequestMessage, { method: "session.retry" }>,
  ): Promise<void> {
    const state = await this.getSessionState(request.params.sessionId);
    if (!state) {
      this.sendSessionNotFound(request.id, request.params.sessionId);
      return;
    }

    if (this.getPendingMutationCount(state) > 0) {
      this.sendSubmitBusy(state, request.id);
      return;
    }

    const activeSubmit = await this.enqueueMutation(state, () => this.startRetry(state, request));
    if (activeSubmit) {
      await this.finishActiveSubmit(state, activeSubmit);
    }
  }

  private async handleCreate(
    request: Extract<SessionProtocolRequestMessage, { method: "session.create" }>,
  ): Promise<void> {
    const session = await this.host.createSession(request.params);
    if (this.closed) {
      await session.dispose();
      return;
    }
    this.sendMessage(
      createSessionProtocolSuccessResponse(request.id, "session.create", {
        sessionId: session.sessionId,
      }),
    );
  }

  private async handleList(
    request: Extract<SessionProtocolRequestMessage, { method: "session.list" }>,
  ): Promise<void> {
    const result: SessionProtocolResultByMethod["session.list"] = {
      sessions: await this.host.listSessions(),
    };

    this.sendMessage(createSessionProtocolSuccessResponse(request.id, "session.list", result));
  }

  private async handleAttach(
    request: Extract<SessionProtocolRequestMessage, { method: "session.observe" }>,
  ): Promise<void> {
    const wasObserved = this.sessionStates.has(request.params.sessionId);
    const state = await this.getSessionState(request.params.sessionId);
    if (!state) {
      this.sendMessage(
        createSessionProtocolErrorResponse(
          request.id,
          SESSION_PROTOCOL_ERROR_CODES.notFound,
          "session not found",
          { sessionId: request.params.sessionId },
        ),
      );
      return;
    }
    state.bufferedDeltas ??= [];
    state.bufferedPendingUserMessages ??= [];
    state.bufferedSubagentActivities ??= [];

    let observed = false;
    try {
      const snapshot = await state.session.snapshot();
      const pendingUserMessages = buildPendingUserMessagesState(state.live);
      const subagentActivities = state.session.subagentActivities();
      this.sendMessage(
        createSessionProtocolSuccessResponse(request.id, "session.observe", {
          snapshot,
          pendingUserMessages,
          subagentActivities,
        }),
      );
      observed = true;
      this.flushBufferedDeltasAfterSnapshot(state, snapshot.revision);
      this.flushBufferedPendingUserMessagesAfter(state, pendingUserMessages.revision);
      this.flushBufferedSubagentActivitiesAfter(state, subagentActivities.revision);
    } finally {
      if (!observed && !wasObserved) {
        this.unsubscribeSessionListeners(state);
        this.sessionStates.delete(request.params.sessionId);
      } else if (!observed) {
        this.flushBufferedDeltasAfterSnapshot(state, 0);
        this.flushBufferedPendingUserMessagesAfter(state, 0);
        this.flushBufferedSubagentActivitiesAfter(state, 0);
      }
    }
  }

  private async handleUnobserve(
    request: Extract<SessionProtocolRequestMessage, { method: "session.unobserve" }>,
  ): Promise<void> {
    const state = this.sessionStates.get(request.params.sessionId);
    if (!state) {
      this.sendSessionNotFound(request.id, request.params.sessionId);
      return;
    }

    this.unsubscribeSessionListeners(state);
    this.sessionStates.delete(request.params.sessionId);

    const result: SessionProtocolResultByMethod["session.unobserve"] = {
      unobserved: true,
    };
    this.sendMessage(createSessionProtocolSuccessResponse(request.id, "session.unobserve", result));
  }

  private async handleRecord(
    request: Extract<SessionProtocolRequestMessage, { method: "session.record" }>,
  ): Promise<void> {
    const state = await this.getSessionState(request.params.sessionId);
    if (!state) {
      this.sendSessionNotFound(request.id, request.params.sessionId);
      return;
    }

    await this.withSessionMutation(request, "user message added", async (mutationState) => {
      const result = await mutationState.session.record({
        text: request.params.text,
        ...(request.params.historyEntryId !== undefined
          ? { historyEntryId: request.params.historyEntryId }
          : {}),
      });
      this.sendMessage(createSessionProtocolSuccessResponse(request.id, "session.record", result));
    });
  }

  private async startUserMessageTurn(
    state: SessionProtocolHandlerSessionState,
    request: SessionProtocolUserSubmissionRequest,
  ): Promise<SessionProtocolActiveSubmit> {
    const addOptions =
      request.method !== "session.steer" && request.params.historyEntryId
        ? { historyEntryId: request.params.historyEntryId }
        : undefined;
    const { userHistoryEntryId } = await state.session.acceptTurn({
      text: request.params.text,
      ...(addOptions ? { historyEntryId: addOptions.historyEntryId } : {}),
    });

    const activeSubmit = {
      promise: this.executeSubmit(state, request.id, request.method, userHistoryEntryId),
    };
    state.live.activeSubmit = activeSubmit;
    return activeSubmit;
  }

  private startRetry(
    state: SessionProtocolHandlerSessionState,
    request: Extract<SessionProtocolRequestMessage, { method: "session.retry" }>,
  ) {
    if (state.live.activeSubmit || state.session.isTurnRunning) {
      this.sendSubmitBusy(state, request.id);
      return undefined;
    }

    const activeSubmit = {
      promise: this.executeRetry(state, request.id),
    };
    state.live.activeSubmit = activeSubmit;
    return activeSubmit;
  }

  private schedulePendingSubmissionDrain(state: SessionProtocolHandlerSessionState): void {
    void this.drainPendingIdleSubmissions(state).catch((error) => {
      this.failPendingIdleSubmissions(state, error);
    });
  }

  private async drainPendingIdleSubmissions(
    state: SessionProtocolHandlerSessionState,
  ): Promise<void> {
    const action = await this.enqueueMutation(state, async () => {
      const pendingIndex = state.live.pendingSubmissions.findIndex(
        (pending) => pending.delivery === "when-idle",
      );
      if (pendingIndex < 0 || state.live.activeSubmit || state.session.isTurnRunning) {
        return { type: "idle" as const };
      }

      const [pending] = state.live.pendingSubmissions.splice(pendingIndex, 1) as [
        SessionProtocolPendingIdleSubmission,
      ];
      publishPendingUserMessages(state.session, state.live);
      try {
        return {
          type: "started" as const,
          activeSubmit: await pending.handler.startUserMessageTurn(state, pending.request),
        };
      } catch (error) {
        this.sendUserMessageDrainFailure([pending], error);
        return { type: "failed" as const, error };
      }
    });

    if (action.type === "idle") {
      return;
    }
    if (action.type === "failed") {
      this.failPendingIdleSubmissions(state, action.error);
      return;
    }

    await this.finishActiveSubmit(state, action.activeSubmit);
  }

  private failPendingIdleSubmissions(
    state: SessionProtocolHandlerSessionState,
    error: unknown,
  ): void {
    const pending = state.live.pendingSubmissions.filter(
      (submission): submission is SessionProtocolPendingIdleSubmission =>
        submission.delivery === "when-idle",
    );
    this.removePendingSubmissions(state, pending);
    this.sendUserMessageDrainFailure(pending, error);
  }

  private sendUserMessageDrainFailure(
    requests: SessionProtocolPendingIdleSubmission[],
    error: unknown,
  ): void {
    for (const { handler, request } of requests) {
      handler.sendMessage(
        createSessionProtocolErrorResponse(
          request.id,
          SESSION_PROTOCOL_ERROR_CODES.internalError,
          "failed to drain pending user message",
          { cause: error instanceof Error ? error.message : String(error) },
        ),
      );
    }
  }

  private async executeSubmit(
    state: SessionProtocolHandlerSessionState,
    requestId: SessionProtocolRequestId,
    method: "session.submit" | "session.queue" | "session.steer",
    userHistoryEntryId: string,
  ): Promise<void> {
    try {
      const result: SessionProtocolResultByMethod[typeof method] =
        await state.session.runAcceptedTurn(userHistoryEntryId);
      this.sendMessage(createSessionProtocolSuccessResponse(requestId, method, result));
    } catch (error) {
      await this.snapshotAfterFailedSubmit(state);
      this.sendMessage(
        createSessionProtocolErrorResponse(
          requestId,
          SESSION_PROTOCOL_ERROR_CODES.internalError,
          "failed to run session turn",
          { cause: error instanceof Error ? error.message : String(error) },
        ),
      );
    }
  }

  private async snapshotAfterFailedSubmit(
    state: SessionProtocolHandlerSessionState,
  ): Promise<void> {
    try {
      await state.session.snapshot();
    } catch {
      // Preserve the original turn failure response; the accepted user message was already
      // committed before model work started.
    }
  }

  private async executeRetry(
    state: SessionProtocolHandlerSessionState,
    requestId: SessionProtocolRequestId,
  ): Promise<void> {
    try {
      const turnResult = await state.session.retryTurn();
      await state.session.snapshot();

      const result: SessionProtocolResultByMethod["session.retry"] = {
        turn: turnResult,
      };

      this.sendMessage(createSessionProtocolSuccessResponse(requestId, "session.retry", result));
    } catch (error) {
      const retryUnavailable = error instanceof SessionRetryUnavailableError;
      this.sendMessage(
        createSessionProtocolErrorResponse(
          requestId,
          retryUnavailable
            ? SESSION_PROTOCOL_ERROR_CODES.invalidRequest
            : SESSION_PROTOCOL_ERROR_CODES.internalError,
          retryUnavailable ? error.message : "failed to run session turn",
          retryUnavailable
            ? undefined
            : { cause: error instanceof Error ? error.message : String(error) },
        ),
      );
    }
  }

  private execKey(sessionId: string, execId: string): string {
    return `${sessionId}\0${execId}`;
  }

  private async runSideChannel(operation: (signal: AbortSignal) => Promise<void>): Promise<void> {
    const promise = operation(this.connectionAbortController.signal);
    this.activeSideChannels.add(promise);
    try {
      await promise;
    } finally {
      this.activeSideChannels.delete(promise);
    }
  }

  private async executeExec(
    state: SessionProtocolHandlerSessionState,
    request: Extract<SessionProtocolRequestMessage, { method: "session.exec" }>,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      const result = await state.session.exec({
        execId: request.params.execId,
        command: request.params.command,
        ...(request.params.args !== undefined ? { args: request.params.args } : {}),
        ...(request.params.env !== undefined ? { env: request.params.env } : {}),
        ...(request.params.stdinBase64 !== undefined
          ? { stdinBase64: request.params.stdinBase64 }
          : {}),
        ...(request.params.cwd !== undefined ? { cwd: request.params.cwd } : {}),
        ...(request.params.timeoutMs !== undefined ? { timeoutMs: request.params.timeoutMs } : {}),
        ...(request.params.maxCaptureBytes !== undefined
          ? { maxCaptureBytes: request.params.maxCaptureBytes }
          : {}),
        signal,
      });
      this.sendMessage(createSessionProtocolSuccessResponse(request.id, "session.exec", result));
    } catch (error) {
      const cancelled = signal.aborted || isAbortError(error);
      const busy = error instanceof SessionExecBusyError;
      this.sendMessage(
        createSessionProtocolErrorResponse(
          request.id,
          cancelled
            ? SESSION_PROTOCOL_ERROR_CODES.cancelled
            : busy
              ? SESSION_PROTOCOL_ERROR_CODES.busy
              : SESSION_PROTOCOL_ERROR_CODES.internalError,
          cancelled ? "execution was cancelled" : busy ? error.message : "failed to run execution",
          { cause: error instanceof Error ? error.message : String(error) },
        ),
      );
    }
  }

  private async executeSample(
    state: SessionProtocolHandlerSessionState,
    request: Extract<SessionProtocolRequestMessage, { method: "session.sample" }>,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      const result = await state.session.sample({
        context: request.params.context,
        options: request.params.options,
        signal,
      });
      this.sendMessage(createSessionProtocolSuccessResponse(request.id, "session.sample", result));
    } catch (error) {
      const cancelled = signal.aborted || isAbortError(error);
      this.sendMessage(
        createSessionProtocolErrorResponse(
          request.id,
          cancelled
            ? SESSION_PROTOCOL_ERROR_CODES.cancelled
            : SESSION_PROTOCOL_ERROR_CODES.internalError,
          cancelled ? "model sample was cancelled" : "failed to sample model",
          { cause: error instanceof Error ? error.message : String(error) },
        ),
      );
    }
  }

  private async handleInterrupt(
    request: Extract<SessionProtocolRequestMessage, { method: "session.interrupt" }>,
  ): Promise<void> {
    const state = await this.getSessionState(request.params.sessionId);
    if (!state) {
      this.sendSessionNotFound(request.id, request.params.sessionId);
      return;
    }

    const result = await this.enqueueMutation(state, async () => {
      const interrupted = state.session.interruptActiveWork();
      if (interrupted) {
        state.live.interrupting = true;
      }
      this.rejectPendingBoundarySubmissions(state, "session was interrupted");
      return {
        interrupted,
        isTurnRunning: state.session.isTurnRunning || interrupted,
      } satisfies SessionProtocolResultByMethod["session.interrupt"];
    });

    if (result.interrupted) {
      void state.session
        .waitForActiveWork()
        .catch(() => undefined)
        .then(() =>
          this.enqueueMutation(state, () => {
            state.live.interrupting = false;
          }),
        )
        .catch(() => undefined);
    }
    this.sendMessage(createSessionProtocolSuccessResponse(request.id, "session.interrupt", result));
  }

  private async handleSnapshot(
    request: Extract<SessionProtocolRequestMessage, { method: "session.snapshot" }>,
  ): Promise<void> {
    const state = await this.getSessionState(request.params.sessionId);
    if (!state) {
      this.sendSessionNotFound(request.id, request.params.sessionId);
      return;
    }

    this.sendMessage(
      createSessionProtocolSuccessResponse(
        request.id,
        "session.snapshot",
        await state.session.snapshot(),
      ),
    );
  }

  private async handleStartGoal(
    request: Extract<SessionProtocolRequestMessage, { method: "session.startGoal" }>,
  ): Promise<void> {
    await this.handleGoalTurn(request);
  }

  private async handleResumeGoal(
    request: Extract<SessionProtocolRequestMessage, { method: "session.resumeGoal" }>,
  ): Promise<void> {
    await this.handleGoalTurn(request);
  }

  private async handleGoalTurn(
    request: Extract<
      SessionProtocolRequestMessage,
      { method: "session.startGoal" | "session.resumeGoal" }
    >,
  ): Promise<void> {
    const state = await this.getSessionState(request.params.sessionId);
    if (!state) {
      this.sendSessionNotFound(request.id, request.params.sessionId);
      return;
    }
    if (this.getPendingMutationCount(state) > 0) {
      this.sendSubmitBusy(state, request.id);
      return;
    }

    const started = await this.enqueueMutation(state, () => {
      if (state.live.activeSubmit || state.session.isTurnRunning) {
        this.sendSubmitBusy(state, request.id);
        return undefined;
      }
      const promise = this.executeGoalTurn(state, request);
      const activeSubmit = { requestId: request.id, promise };
      state.live.activeSubmit = activeSubmit;
      return { activeSubmit };
    });
    if (!started) return;

    try {
      await started.activeSubmit.promise;
    } finally {
      await this.enqueueMutation(state, () => {
        if (state.live.activeSubmit === started.activeSubmit) {
          state.live.activeSubmit = undefined;
        }
      });
      this.schedulePendingSubmissionDrain(state);
    }
  }

  private async executeGoalTurn(
    state: SessionProtocolHandlerSessionState,
    request: Extract<
      SessionProtocolRequestMessage,
      { method: "session.startGoal" | "session.resumeGoal" }
    >,
  ): Promise<void> {
    try {
      if (request.method === "session.startGoal") {
        const result = await state.session.startGoal(request.params.objective);
        await state.session.snapshot();
        this.sendMessage(
          createSessionProtocolSuccessResponse(request.id, "session.startGoal", result),
        );
      } else {
        const result = await state.session.resumeGoal();
        await state.session.snapshot();
        this.sendMessage(
          createSessionProtocolSuccessResponse(request.id, "session.resumeGoal", result),
        );
      }
    } catch (error) {
      await this.snapshotAfterFailedSubmit(state);
      this.sendMessage(
        createSessionProtocolErrorResponse(
          request.id,
          SESSION_PROTOCOL_ERROR_CODES.internalError,
          "failed to run session goal",
          { cause: error instanceof Error ? error.message : String(error) },
        ),
      );
    }
  }

  private async handleClearGoal(
    request: Extract<SessionProtocolRequestMessage, { method: "session.clearGoal" }>,
  ): Promise<void> {
    const state = await this.getSessionState(request.params.sessionId);
    if (!state) {
      this.sendSessionNotFound(request.id, request.params.sessionId);
      return;
    }
    if (!state.session.getGoal()) {
      this.sendMessage(
        createSessionProtocolErrorResponse(
          request.id,
          SESSION_PROTOCOL_ERROR_CODES.invalidRequest,
          "no goal exists",
        ),
      );
      return;
    }

    await this.runSessionMutation(state, async () => {
      if (this.closed) {
        return;
      }
      if (state.session.sessionId !== request.params.sessionId) {
        this.sendSessionNotFound(request.id, request.params.sessionId);
        return;
      }
      if (!state.session.getGoal()) {
        this.sendMessage(
          createSessionProtocolErrorResponse(
            request.id,
            SESSION_PROTOCOL_ERROR_CODES.invalidRequest,
            "no goal exists",
          ),
        );
        return;
      }

      await this.interruptAndWaitForActiveSubmit(state);
      this.rejectPendingBoundarySubmissions(state, "session goal cleared");
      this.rejectPendingIdleSubmissions(state, "session goal cleared");
      const snapshot = state.session.getGoal()
        ? await state.session.clearGoal()
        : await state.session.snapshot();
      this.sendMessage(
        createSessionProtocolSuccessResponse(request.id, "session.clearGoal", snapshot),
      );
    });
  }

  private async handleSetReasoning(
    request: Extract<SessionProtocolRequestMessage, { method: "session.setReasoning" }>,
  ): Promise<void> {
    const state = await this.getSessionState(request.params.sessionId);
    if (!state) {
      this.sendSessionNotFound(request.id, request.params.sessionId);
      return;
    }

    await this.runSessionMutation(state, async () => {
      if (state.session.sessionId !== request.params.sessionId) {
        this.sendSessionNotFound(request.id, request.params.sessionId);
        return;
      }
      const result = await state.session.setReasoning(request.params.reasoning);
      this.sendMessage(
        createSessionProtocolSuccessResponse(request.id, "session.setReasoning", result),
      );
    });
  }

  private async handleSetPersona(
    request: Extract<SessionProtocolRequestMessage, { method: "session.setPersona" }>,
  ): Promise<void> {
    await this.withSessionMutation(request, "session persona changed", async (state) => {
      const snapshot = await state.session.setPersona(request.params.personaId);
      this.sendMessage(
        createSessionProtocolSuccessResponse(request.id, "session.setPersona", snapshot),
      );
    });
  }

  private async handleResolvePrompt(
    request: Extract<SessionProtocolRequestMessage, { method: "session.resolvePrompt" }>,
  ): Promise<void> {
    const state = await this.getSessionState(request.params.sessionId);
    if (!state) {
      this.sendSessionNotFound(request.id, request.params.sessionId);
      return;
    }
    const result = await state.session.resolvePrompt(request.params.promptId);
    this.sendMessage(
      createSessionProtocolSuccessResponse(request.id, "session.resolvePrompt", result),
    );
  }

  private async handleAutocompletePaths(
    request: Extract<SessionProtocolRequestMessage, { method: "session.autocompletePaths" }>,
  ): Promise<void> {
    const state = await this.getSessionState(request.params.sessionId);
    if (!state) {
      this.sendSessionNotFound(request.id, request.params.sessionId);
      return;
    }
    const result = await state.session.autocompletePaths({
      query: request.params.query,
      limit: request.params.limit,
    });
    this.sendMessage(
      createSessionProtocolSuccessResponse(request.id, "session.autocompletePaths", result),
    );
  }

  private async handleReload(
    request: Extract<SessionProtocolRequestMessage, { method: "session.reload" }>,
  ): Promise<void> {
    await this.withSessionMutation(request, "session reloaded", async (state) => {
      const result = await state.session.reload();
      this.sendMessage(createSessionProtocolSuccessResponse(request.id, "session.reload", result));
    });
  }

  private async handleCompact(
    request: Extract<SessionProtocolRequestMessage, { method: "session.compact" }>,
  ): Promise<void> {
    await this.withSessionMutation(request, "session compacted", async (state) => {
      const result = await state.session.compact({
        mode: request.params.mode,
        ...(request.params.guidance !== undefined ? { guidance: request.params.guidance } : {}),
      });
      this.sendMessage(createSessionProtocolSuccessResponse(request.id, "session.compact", result));
    });
  }

  private async handleRewind(
    request: Extract<SessionProtocolRequestMessage, { method: "session.rewind" }>,
  ): Promise<void> {
    await this.withNonInterruptingSessionMutation(request, async (state) => {
      if (
        state.live.activeSubmit ||
        state.session.isTurnRunning ||
        state.live.pendingSubmissions.length > 0
      ) {
        this.sendMessage(
          createSessionProtocolErrorResponse(
            request.id,
            SESSION_PROTOCOL_ERROR_CODES.busy,
            "cannot rewind while session work is active or pending",
          ),
        );
        return;
      }
      const result = await state.session.rewindToHistoryEntryId(request.params.historyEntryId);
      this.sendMessage(createSessionProtocolSuccessResponse(request.id, "session.rewind", result));
    });
  }

  private async handleInterruptSubagent(
    request: Extract<SessionProtocolRequestMessage, { method: "session.interruptSubagent" }>,
  ): Promise<void> {
    await this.withNonInterruptingSessionMutation(request, async (state) => {
      this.sendMessage(
        createSessionProtocolSuccessResponse(
          request.id,
          "session.interruptSubagent",
          await state.session.interruptSubagent(request.params.subagentId),
        ),
      );
    });
  }

  private async handleEphemeralCreate(
    request: Extract<SessionProtocolRequestMessage, { method: "session.ephemeral.create" }>,
  ): Promise<void> {
    const state = await this.getSessionState(request.params.sessionId);
    if (!state) {
      this.sendSessionNotFound(request.id, request.params.sessionId);
      return;
    }
    if (this.closed) {
      return;
    }

    const result = await state.session.createEphemeralContext({
      instructions: request.params.instructions,
      tools: request.params.tools,
    });
    this.sendMessage(
      createSessionProtocolSuccessResponse(request.id, "session.ephemeral.create", result),
    );
  }

  private async handleEphemeralSubmit(
    request: Extract<SessionProtocolRequestMessage, { method: "session.ephemeral.submit" }>,
  ): Promise<void> {
    const state = await this.getSessionState(request.params.sessionId);
    if (!state) {
      this.sendSessionNotFound(request.id, request.params.sessionId);
      return;
    }

    try {
      const result = await state.session.submitEphemeralThread({
        contextId: request.params.contextId,
        threadId: request.params.threadId,
        ...(request.params.forkFromThreadId !== undefined
          ? { forkFromThreadId: request.params.forkFromThreadId }
          : {}),
        message: request.params.message,
      });
      this.sendMessage(
        createSessionProtocolSuccessResponse(request.id, "session.ephemeral.submit", result),
      );
    } catch (error) {
      this.sendMessage(
        createSessionProtocolErrorResponse(
          request.id,
          error instanceof EphemeralThreadBusyError
            ? SESSION_PROTOCOL_ERROR_CODES.busy
            : SESSION_PROTOCOL_ERROR_CODES.internalError,
          error instanceof Error ? error.message : String(error),
        ),
      );
    }
  }

  private async handleEphemeralClose(
    request: Extract<SessionProtocolRequestMessage, { method: "session.ephemeral.close" }>,
  ): Promise<void> {
    const state = await this.getSessionState(request.params.sessionId);
    if (!state) {
      this.sendSessionNotFound(request.id, request.params.sessionId);
      return;
    }

    const result = await state.session.closeEphemeralContext(request.params.contextId);
    this.sendMessage(
      createSessionProtocolSuccessResponse(request.id, "session.ephemeral.close", result),
    );
  }

  private async withSessionMutation(
    request: SessionProtocolMutationRequest,
    queuedSteeringRejectionMessage: string,
    handler: (state: SessionProtocolHandlerSessionState) => Promise<void>,
  ): Promise<void> {
    const state = await this.getSessionState(request.params.sessionId);
    if (!state) {
      this.sendSessionNotFound(request.id, request.params.sessionId);
      return;
    }

    await this.runSessionMutation(state, async () => {
      if (this.closed) {
        return;
      }
      if (state.session.sessionId !== request.params.sessionId) {
        this.sendSessionNotFound(request.id, request.params.sessionId);
        return;
      }
      await this.interruptAndWaitForActiveSubmit(state);
      this.rejectPendingBoundarySubmissions(state, queuedSteeringRejectionMessage);
      this.rejectPendingIdleSubmissions(state, queuedSteeringRejectionMessage);
      await handler(state);
    });
  }

  private async withNonInterruptingSessionMutation(
    request: SessionProtocolMutationRequest,
    handler: (state: SessionProtocolHandlerSessionState) => Promise<void>,
  ): Promise<void> {
    const state = await this.getSessionState(request.params.sessionId);
    if (!state) {
      this.sendSessionNotFound(request.id, request.params.sessionId);
      return;
    }

    await this.runSessionMutation(state, async () => {
      if (this.closed) {
        return;
      }
      if (state.session.sessionId !== request.params.sessionId) {
        this.sendSessionNotFound(request.id, request.params.sessionId);
        return;
      }
      await handler(state);
    });
  }

  private rejectPendingBoundarySubmissions(
    state: SessionProtocolHandlerSessionState,
    message: string,
  ): void {
    const cancelledIds = new Set(state.session.cancelSteering().map((submission) => submission.id));
    this.rejectPendingSubmissions(
      state,
      state.live.pendingSubmissions.filter(
        (pending) => pending.delivery === "turn-boundary" && cancelledIds.has(pending.steeringId),
      ),
      message,
    );
  }

  private rejectPendingIdleSubmissions(
    state: SessionProtocolHandlerSessionState,
    message: string,
  ): void {
    this.rejectPendingSubmissions(
      state,
      state.live.pendingSubmissions.filter((pending) => pending.delivery === "when-idle"),
      message,
    );
  }

  private rejectPendingSubmissions(
    state: SessionProtocolHandlerSessionState,
    pending: SessionProtocolPendingUserSubmission[],
    message: string,
  ): void {
    if (pending.length === 0) {
      return;
    }
    this.removePendingSubmissions(state, pending);
    for (const { handler, request } of pending) {
      handler.sendMessage(
        createSessionProtocolErrorResponse(
          request.id,
          SESSION_PROTOCOL_ERROR_CODES.invalidRequest,
          message,
        ),
      );
    }
  }

  private registerSession(session: TauHostedSession): SessionProtocolHandlerSessionState {
    const existing = this.sessionStates.get(session.sessionId);
    if (existing) {
      return existing;
    }

    const state: SessionProtocolHandlerSessionState = {
      session,
      live: getSessionLiveState(session),
    };

    state.unsubscribeDelta = session.onDelta((delta) => {
      if (this.closed || !this.sessionStates.has(session.sessionId)) {
        return;
      }
      if (state.bufferedDeltas) {
        state.bufferedDeltas.push(delta);
        return;
      }
      this.sendMessage(delta);
    });

    state.unsubscribeEphemeral = session.onEphemeral((message) => {
      if (this.closed || !this.sessionStates.has(session.sessionId)) {
        return;
      }
      this.sendMessage(message);
    });

    const pendingUserMessagesListener = (
      message: SessionProtocolPendingUserMessagesMessage,
    ): void => {
      if (this.closed || !this.sessionStates.has(session.sessionId)) {
        return;
      }
      if (state.bufferedPendingUserMessages) {
        state.bufferedPendingUserMessages.push(message);
        return;
      }
      this.sendMessage(message);
    };
    state.live.listeners.add(pendingUserMessagesListener);
    state.unsubscribePendingUserMessages = () =>
      state.live.listeners.delete(pendingUserMessagesListener);

    state.unsubscribeSubagentActivities = session.onSubagentActivities((message) => {
      if (this.closed || !this.sessionStates.has(session.sessionId)) {
        return;
      }
      if (state.bufferedSubagentActivities) {
        state.bufferedSubagentActivities.push(message);
        return;
      }
      this.sendMessage(message);
    });

    this.sessionStates.set(session.sessionId, state);
    try {
      this.clientToolRegistration?.attachSession(session.sessionId);
    } catch (error) {
      this.unsubscribeSessionListeners(state);
      this.sessionStates.delete(session.sessionId);
      throw error;
    }
    return state;
  }

  private async getSessionState(
    sessionId: string,
  ): Promise<SessionProtocolHandlerSessionState | undefined> {
    const existing = this.sessionStates.get(sessionId);
    if (existing) {
      if (existing.session.isDisposed || existing.session.sessionId !== sessionId) {
        this.unsubscribeSessionListeners(existing);
        this.sessionStates.delete(sessionId);
        return undefined;
      }
      return existing;
    }

    const session = await this.host.observeSession(sessionId);
    if (!session || this.closed) {
      return undefined;
    }
    return this.registerSession(session);
  }

  private flushBufferedDeltasAfterSnapshot(
    state: SessionProtocolHandlerSessionState,
    snapshotRevision: number,
  ): void {
    const bufferedDeltas = state.bufferedDeltas;
    if (!bufferedDeltas) {
      return;
    }

    state.bufferedDeltas = undefined;
    for (const delta of bufferedDeltas) {
      if (delta.toRevision > snapshotRevision) {
        this.sendMessage(delta);
      }
    }
  }

  private flushBufferedPendingUserMessagesAfter(
    state: SessionProtocolHandlerSessionState,
    pendingRevision: number,
  ): void {
    const bufferedPendingUserMessages = state.bufferedPendingUserMessages;
    if (!bufferedPendingUserMessages) {
      return;
    }

    state.bufferedPendingUserMessages = undefined;
    for (const message of bufferedPendingUserMessages) {
      if (message.state.revision > pendingRevision) {
        this.sendMessage(message);
      }
    }
  }

  private flushBufferedSubagentActivitiesAfter(
    state: SessionProtocolHandlerSessionState,
    activitiesRevision: number,
  ): void {
    const bufferedSubagentActivities = state.bufferedSubagentActivities;
    if (!bufferedSubagentActivities) {
      return;
    }

    state.bufferedSubagentActivities = undefined;
    for (const message of bufferedSubagentActivities) {
      if (message.revision > activitiesRevision) {
        this.sendMessage(message);
      }
    }
  }

  private sendSessionNotFound(id: SessionProtocolRequestId, sessionId: string): void {
    this.sendMessage(
      createSessionProtocolErrorResponse(
        id,
        SESSION_PROTOCOL_ERROR_CODES.notFound,
        "session not found",
        { sessionId },
      ),
    );
  }

  private sendSubmitBusy(
    state: SessionProtocolHandlerSessionState,
    id: SessionProtocolRequestId,
  ): void {
    const message =
      this.getPendingMutationCount(state) > 0
        ? "a mutating session request is in progress"
        : "a session turn is already running";

    this.sendMessage(
      createSessionProtocolErrorResponse(id, SESSION_PROTOCOL_ERROR_CODES.busy, message),
    );
  }

  private enqueueMutation<T>(
    state: SessionProtocolHandlerSessionState,
    handler: () => Promise<T> | T,
  ): Promise<T> {
    const queue = getSessionMutationQueueState(state.session);
    const run = queue.queue.then(handler);
    queue.queue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async runSessionMutation<T>(
    state: SessionProtocolHandlerSessionState,
    handler: () => Promise<T>,
  ): Promise<T> {
    const queue = getSessionMutationQueueState(state.session);
    queue.pending += 1;
    try {
      return await this.enqueueMutation(state, handler);
    } finally {
      queue.pending -= 1;
    }
  }

  private getPendingMutationCount(state: SessionProtocolHandlerSessionState): number {
    return getSessionMutationQueueState(state.session).pending;
  }

  private async interruptAndWaitForActiveSubmit(
    state: SessionProtocolHandlerSessionState,
  ): Promise<void> {
    const activeSubmit = state.live.activeSubmit;
    if (!activeSubmit && !state.session.isTurnRunning) {
      return;
    }

    state.session.interruptTurn();
    if (!activeSubmit) {
      return;
    }

    try {
      await activeSubmit.promise;
    } catch {
      // ignore submit failure while finishing active mutation
    }
  }

  private unsubscribeSessionListeners(state: SessionProtocolHandlerSessionState): void {
    this.clientToolRegistration?.detachSession(state.session.sessionId);

    state.unsubscribeDelta?.();
    state.unsubscribeDelta = undefined;
    state.unsubscribeEphemeral?.();
    state.unsubscribeEphemeral = undefined;
    state.unsubscribePendingUserMessages?.();
    state.unsubscribePendingUserMessages = undefined;
    state.unsubscribeSubagentActivities?.();
    state.unsubscribeSubagentActivities = undefined;
  }

  private sendMessage(message: SessionProtocolOutgoingMessage): void {
    if (this.closed) {
      return;
    }

    this.send(message);
  }
}
