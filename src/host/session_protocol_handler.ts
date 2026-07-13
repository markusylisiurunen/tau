import { randomUUID } from "node:crypto";
import { formatSteeringUserMessage } from "../core/runtime/steering.js";
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
} from "../protocol/session_protocol.js";
import type { TauHostedSession, TauSessionHost } from "./session_host.js";

export type SessionProtocolHandlerOptions = {
  host: TauSessionHost;
  send: (message: SessionProtocolOutgoingMessage) => void;
};

type SessionProtocolHandlerCloseMode = "detach" | "interrupt" | "shutdown-host";

type SessionProtocolActiveSubmit = {
  requestId: SessionProtocolRequestId;
  promise: Promise<void>;
};

type SessionProtocolActiveBash = {
  requestId: SessionProtocolRequestId;
  abortController: AbortController;
  promise: Promise<void>;
};

type SessionProtocolPendingRequest<Method extends "session.queue" | "session.steer"> = {
  id: string;
  handler: SessionProtocolHandler;
  request: Extract<SessionProtocolRequestMessage, { method: Method }>;
};

type SessionProtocolPendingUserMessageRequest =
  | SessionProtocolPendingRequest<"session.queue">
  | SessionProtocolPendingRequest<"session.steer">;

type SessionProtocolLiveSessionState = {
  activeSubmit?: SessionProtocolActiveSubmit;
  activeBash?: SessionProtocolActiveBash;
  revision: number;
  pendingSteeringSubmits: Array<SessionProtocolPendingRequest<"session.steer">>;
  pendingQueuedSubmits: Array<SessionProtocolPendingRequest<"session.queue">>;
  listeners: Set<(message: SessionProtocolPendingUserMessagesMessage) => void>;
};

type SessionProtocolHandlerSessionState = {
  session: TauHostedSession;
  live: SessionProtocolLiveSessionState;
  unsubscribeDelta?: () => void;
  unsubscribeEphemeral?: () => void;
  unsubscribePendingUserMessages?: () => void;
  bufferedDeltas?: SessionProtocolDeltaMessage[];
  bufferedPendingUserMessages?: SessionProtocolPendingUserMessagesMessage[];
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
      revision: 1,
      pendingSteeringSubmits: [],
      pendingQueuedSubmits: [],
      listeners: new Set(),
    };
    sessionLiveStates.set(session, state);
  }
  return state;
}

function buildPendingUserMessagesState(
  state: SessionProtocolLiveSessionState,
): SessionProtocolPendingUserMessagesState {
  return {
    revision: state.revision,
    messages: [
      ...state.pendingSteeringSubmits.map(
        (pending): SessionProtocolPendingUserMessage => ({
          id: pending.id,
          mode: "steer",
          text: pending.request.params.text,
        }),
      ),
      ...state.pendingQueuedSubmits.map(
        (pending): SessionProtocolPendingUserMessage => ({
          id: pending.id,
          mode: "queue",
          text: pending.request.params.text,
        }),
      ),
    ],
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
    listener(message);
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
      | "session.prune"
      | "session.rewind"
      | "session.terminateSubagent"
      | "session.ephemeral.create"
      | "session.ephemeral.close";
  }
>;

export class SessionProtocolHandler {
  private readonly host: TauSessionHost;
  private readonly send: (message: SessionProtocolOutgoingMessage) => void;
  private readonly sessionStates = new Map<string, SessionProtocolHandlerSessionState>();
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
        case "session.interrupt":
          await this.handleInterrupt(request);
          return;
        case "session.snapshot":
          await this.handleSnapshot(request);
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
        case "session.prune":
          await this.handlePrune(request);
          return;
        case "session.rewind":
          await this.handleRewind(request);
          return;
        case "session.terminateSubagent":
          await this.handleTerminateSubagent(request);
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

    for (const state of states) {
      this.unsubscribeSessionListeners(state);

      if (interruptActiveTurns && (state.live.activeSubmit || state.session.isTurnRunning)) {
        state.session.interruptTurn();
      }
      if (interruptActiveTurns) {
        state.session.interruptMaintenance();
      }
      if (interruptActiveTurns && state.live.activeBash) {
        state.live.activeBash.abortController.abort();
      }
    }

    if (interruptActiveTurns) {
      await Promise.allSettled(states.map((state) => state.session.waitForActiveWork()));
      await Promise.allSettled(
        states.map((state) => state.live.activeSubmit?.promise).filter((promise) => promise),
      );
      await Promise.allSettled(
        states.map((state) => state.live.activeBash?.promise).filter((promise) => promise),
      );
      await Promise.allSettled(
        states.map((state) => getSessionMutationQueueState(state.session).queue),
      );
    }

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
    const state = await this.getSessionState(request.params.sessionId);
    if (!state) {
      this.sendSessionNotFound(request.id, request.params.sessionId);
      return;
    }

    if (this.getPendingMutationCount(state) > 0) {
      this.sendSubmitBusy(state, request.id);
      return;
    }

    const startedSubmit = await this.enqueueMutation(state, () =>
      this.startUserMessageTurn(state, request),
    );

    if (!startedSubmit) {
      return;
    }

    const { activeSubmit } = startedSubmit;

    try {
      await activeSubmit.promise;
    } finally {
      await this.enqueueMutation(state, () => {
        if (state.live.activeSubmit === activeSubmit) {
          state.live.activeSubmit = undefined;
        }
      });
      this.schedulePendingSubmitDrains(state);
    }
  }

  private async handleQueue(
    request: Extract<SessionProtocolRequestMessage, { method: "session.queue" }>,
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

    const startedSubmit = await this.enqueueMutation(state, () => {
      if (state.live.activeSubmit || state.session.isTurnRunning || state.live.activeBash) {
        state.live.pendingQueuedSubmits.push({ id: randomUUID(), handler: this, request });
        publishPendingUserMessages(state.session, state.live);
        return undefined;
      }
      return this.startUserMessageTurn(state, request);
    });

    if (!startedSubmit) {
      return;
    }

    const { activeSubmit } = startedSubmit;

    try {
      await activeSubmit.promise;
    } finally {
      await this.enqueueMutation(state, () => {
        if (state.live.activeSubmit === activeSubmit) {
          state.live.activeSubmit = undefined;
        }
      });
      this.schedulePendingSubmitDrains(state);
    }
  }

  private async handleSteer(
    request: Extract<SessionProtocolRequestMessage, { method: "session.steer" }>,
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

    const startedSubmit = await this.enqueueMutation(state, () => {
      const hasActiveSessionWork =
        state.live.activeSubmit || state.session.isTurnRunning || state.live.activeBash;
      if (state.live.pendingSteeringSubmits.length > 0 || hasActiveSessionWork) {
        state.live.pendingSteeringSubmits.push({ id: randomUUID(), handler: this, request });
        publishPendingUserMessages(state.session, state.live);
        if (hasActiveSessionWork) {
          state.session.requestTurnBoundaryStop();
        }
        return undefined;
      }
      return this.startUserMessageTurn(state, request);
    });

    if (!startedSubmit) {
      return;
    }

    const { activeSubmit } = startedSubmit;

    try {
      await activeSubmit.promise;
    } finally {
      await this.enqueueMutation(state, () => {
        if (state.live.activeSubmit === activeSubmit) {
          state.live.activeSubmit = undefined;
        }
      });
      this.schedulePendingSubmitDrains(state);
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
      const pending = [
        ...state.live.pendingSteeringSubmits.splice(0),
        ...state.live.pendingQueuedSubmits.splice(0),
      ];
      if (pending.length === 0) {
        return [];
      }

      state.session.cancelTurnBoundaryStop();
      publishPendingUserMessages(state.session, state.live);
      for (const item of pending) {
        item.handler.sendMessage(
          createSessionProtocolErrorResponse(
            item.request.id,
            SESSION_PROTOCOL_ERROR_CODES.cancelled,
            "pending user message was cancelled",
          ),
        );
      }
      return pending.map(
        (item): SessionProtocolPendingUserMessage => ({
          id: item.id,
          mode: item.request.method === "session.steer" ? "steer" : "queue",
          text: item.request.params.text,
        }),
      );
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
    const state = await this.getSessionState(request.params.sessionId);
    if (!state) {
      this.sendSessionNotFound(request.id, request.params.sessionId);
      return;
    }

    if (
      this.getPendingMutationCount(state) > 0 ||
      state.live.activeSubmit ||
      state.session.isTurnRunning ||
      state.live.activeBash
    ) {
      this.sendSubmitBusy(state, request.id);
      return;
    }

    const activeBash = await this.enqueueMutation(state, () => this.startExec(state, request));
    if (!activeBash) {
      return;
    }

    try {
      await activeBash.promise;
    } finally {
      await this.enqueueMutation(state, () => {
        if (state.live.activeBash === activeBash) {
          state.live.activeBash = undefined;
        }
      });
      this.schedulePendingSubmitDrains(state);
    }
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

    const startedRetry = await this.enqueueMutation(state, () => this.startRetry(state, request));

    if (!startedRetry) {
      return;
    }

    const { activeSubmit } = startedRetry;

    try {
      await activeSubmit.promise;
    } finally {
      await this.enqueueMutation(state, () => {
        if (state.live.activeSubmit === activeSubmit) {
          state.live.activeSubmit = undefined;
        }
      });
      this.schedulePendingSubmitDrains(state);
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

    let observed = false;
    try {
      const snapshot = await state.session.snapshot();
      const pendingUserMessages = buildPendingUserMessagesState(state.live);
      this.sendMessage(
        createSessionProtocolSuccessResponse(request.id, "session.observe", {
          snapshot,
          pendingUserMessages,
        }),
      );
      observed = true;
      this.flushBufferedDeltasAfterSnapshot(state, snapshot.revision);
      this.flushBufferedPendingUserMessagesAfter(state, pendingUserMessages.revision);
    } finally {
      if (!observed && !wasObserved) {
        this.unsubscribeSessionListeners(state);
        this.sessionStates.delete(request.params.sessionId);
      } else if (!observed) {
        this.flushBufferedDeltasAfterSnapshot(state, 0);
        this.flushBufferedPendingUserMessagesAfter(state, 0);
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
    request: Extract<
      SessionProtocolRequestMessage,
      {
        method: "session.submit" | "session.queue" | "session.steer";
      }
    >,
  ): Promise<
    | {
        activeSubmit: {
          requestId: SessionProtocolRequestId;
          promise: Promise<void>;
        };
      }
    | undefined
  > {
    if (state.live.activeSubmit || state.session.isTurnRunning || state.live.activeBash) {
      this.sendSubmitBusy(state, request.id);
      return undefined;
    }

    const addOptions = request.params.historyEntryId
      ? { historyEntryId: request.params.historyEntryId }
      : undefined;
    const { userHistoryEntryId } = await state.session.record({
      text: request.params.text,
      ...(addOptions ? { historyEntryId: addOptions.historyEntryId } : {}),
    });

    const submitPromise = this.executeSubmit(state, request.id, request.method, userHistoryEntryId);
    const activeSubmit = { requestId: request.id, promise: submitPromise };
    state.live.activeSubmit = activeSubmit;

    return {
      activeSubmit,
    };
  }

  private startRetry(
    state: SessionProtocolHandlerSessionState,
    request: Extract<SessionProtocolRequestMessage, { method: "session.retry" }>,
  ) {
    if (state.live.activeSubmit || state.session.isTurnRunning || state.live.activeBash) {
      this.sendSubmitBusy(state, request.id);
      return undefined;
    }

    const retryPromise = this.executeRetry(state, request.id);
    const activeSubmit = { requestId: request.id, promise: retryPromise };
    state.live.activeSubmit = activeSubmit;

    return {
      activeSubmit,
    };
  }

  private startExec(
    state: SessionProtocolHandlerSessionState,
    request: Extract<SessionProtocolRequestMessage, { method: "session.exec" }>,
  ) {
    if (state.live.activeSubmit || state.session.isTurnRunning || state.live.activeBash) {
      this.sendSubmitBusy(state, request.id);
      return undefined;
    }

    const abortController = new AbortController();
    const promise = this.executeExec(state, request, abortController.signal);
    const activeBash = { requestId: request.id, abortController, promise };
    state.live.activeBash = activeBash;
    return activeBash;
  }

  private schedulePendingSubmitDrains(state: SessionProtocolHandlerSessionState): void {
    void this.drainPendingSteeringSubmits(state).catch((error) => {
      this.failPendingUserMessageRequests(state, "session.steer", error);
    });
    void this.drainPendingQueuedSubmits(state).catch((error) => {
      this.failPendingUserMessageRequests(state, "session.queue", error);
    });
  }

  private async drainPendingSteeringSubmits(
    state: SessionProtocolHandlerSessionState,
  ): Promise<void> {
    const batch = await this.enqueueMutation(state, async () => {
      if (
        state.live.pendingSteeringSubmits.length === 0 ||
        state.live.activeSubmit ||
        state.session.isTurnRunning
      ) {
        return undefined;
      }

      const requests = state.live.pendingSteeringSubmits.splice(0);
      publishPendingUserMessages(state.session, state.live);
      const primaryRequest = requests[0]!;
      const preferredHistoryEntryId =
        requests.length === 1 ? primaryRequest.request.params.historyEntryId : undefined;
      let userHistoryEntryId: string;
      try {
        ({ userHistoryEntryId } = await state.session.record({
          text: formatSteeringUserMessage(requests.map((item) => item.request.params.text)),
          ...(preferredHistoryEntryId ? { historyEntryId: preferredHistoryEntryId } : {}),
        }));
      } catch (error) {
        this.sendUserMessageDrainFailure(requests, error);
        return undefined;
      }
      const submitPromise = primaryRequest.handler.executeSubmit(
        state,
        primaryRequest.request.id,
        "session.steer",
        userHistoryEntryId,
        requests,
      );
      const activeSubmit = {
        requestId: primaryRequest.request.id,
        promise: submitPromise,
      };
      state.live.activeSubmit = activeSubmit;

      return { activeSubmit };
    });

    if (!batch) {
      return;
    }

    try {
      await batch.activeSubmit.promise;
    } finally {
      await this.enqueueMutation(state, () => {
        if (state.live.activeSubmit === batch.activeSubmit) {
          state.live.activeSubmit = undefined;
        }
      });
      this.schedulePendingSubmitDrains(state);
    }
  }

  private async drainPendingQueuedSubmits(
    state: SessionProtocolHandlerSessionState,
  ): Promise<void> {
    const next = await this.enqueueMutation(state, async () => {
      if (
        state.live.pendingQueuedSubmits.length === 0 ||
        state.live.activeSubmit ||
        state.session.isTurnRunning
      ) {
        return undefined;
      }

      const pending = state.live.pendingQueuedSubmits.shift()!;
      publishPendingUserMessages(state.session, state.live);
      try {
        return await pending.handler.startUserMessageTurn(state, pending.request);
      } catch (error) {
        this.sendUserMessageDrainFailure([pending], error);
        return undefined;
      }
    });

    if (!next) {
      return;
    }

    try {
      await next.activeSubmit.promise;
    } finally {
      await this.enqueueMutation(state, () => {
        if (state.live.activeSubmit === next.activeSubmit) {
          state.live.activeSubmit = undefined;
        }
      });
      this.schedulePendingSubmitDrains(state);
    }
  }

  private failPendingUserMessageRequests(
    state: SessionProtocolHandlerSessionState,
    method: "session.queue" | "session.steer",
    error: unknown,
  ): void {
    const pending =
      method === "session.steer"
        ? state.live.pendingSteeringSubmits.splice(0)
        : state.live.pendingQueuedSubmits.splice(0);
    if (pending.length > 0) {
      publishPendingUserMessages(state.session, state.live);
    }
    this.sendUserMessageDrainFailure(pending, error);
  }

  private sendUserMessageDrainFailure(
    requests: SessionProtocolPendingUserMessageRequest[],
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
    responseRequests?: SessionProtocolPendingUserMessageRequest[],
  ): Promise<void> {
    try {
      const turnResult = await state.session.runTurn();
      await state.session.snapshot();

      const result: SessionProtocolResultByMethod[typeof method] = {
        userHistoryEntryId,
        turn: {
          aborted: turnResult.aborted,
          ...(turnResult.blocked ? { blocked: turnResult.blocked } : {}),
        },
      };

      if (responseRequests) {
        for (const { handler, request } of responseRequests) {
          handler.sendMessage(createSessionProtocolSuccessResponse(request.id, method, result));
        }
      } else {
        this.sendMessage(createSessionProtocolSuccessResponse(requestId, method, result));
      }
    } catch (error) {
      await this.snapshotAfterFailedSubmit(state);
      if (responseRequests) {
        for (const { handler, request } of responseRequests) {
          handler.sendMessage(
            createSessionProtocolErrorResponse(
              request.id,
              SESSION_PROTOCOL_ERROR_CODES.internalError,
              "failed to run session turn",
              { cause: error instanceof Error ? error.message : String(error) },
            ),
          );
        }
      } else {
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
      const turnResult = await state.session.runTurn();
      await state.session.snapshot();

      const result: SessionProtocolResultByMethod["session.retry"] = {
        turn: {
          aborted: turnResult.aborted,
          ...(turnResult.blocked ? { blocked: turnResult.blocked } : {}),
        },
      };

      this.sendMessage(createSessionProtocolSuccessResponse(requestId, "session.retry", result));
    } catch (error) {
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

  private async executeExec(
    state: SessionProtocolHandlerSessionState,
    request: Extract<SessionProtocolRequestMessage, { method: "session.exec" }>,
    signal: AbortSignal,
  ): Promise<void> {
    try {
      const result = await state.session.exec({
        command: request.params.command,
        ...(request.params.cwd !== undefined ? { cwd: request.params.cwd } : {}),
        ...(request.params.timeoutMs !== undefined ? { timeoutMs: request.params.timeoutMs } : {}),
        signal,
      });
      this.sendMessage(createSessionProtocolSuccessResponse(request.id, "session.exec", result));
    } catch (error) {
      this.sendMessage(
        createSessionProtocolErrorResponse(
          request.id,
          signal.aborted
            ? SESSION_PROTOCOL_ERROR_CODES.invalidRequest
            : SESSION_PROTOCOL_ERROR_CODES.internalError,
          signal.aborted ? "execution command was interrupted" : "failed to run execution command",
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

    const interruptedTurn = state.session.interruptTurn();
    const interruptedMaintenance = state.session.interruptMaintenance();
    const interruptedBash = Boolean(state.live.activeBash);
    state.live.activeBash?.abortController.abort();
    this.rejectPendingSteeringSubmits(state, "session was interrupted");

    const result: SessionProtocolResultByMethod["session.interrupt"] = {
      interrupted: interruptedTurn || interruptedMaintenance || interruptedBash,
      isTurnRunning: state.session.isTurnRunning || interruptedMaintenance || interruptedBash,
    };

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

  private async handlePrune(
    request: Extract<SessionProtocolRequestMessage, { method: "session.prune" }>,
  ): Promise<void> {
    await this.withSessionMutation(request, "session pruned", async (state) => {
      const result = await state.session.pruneToolResults({
        strategy: request.params.strategy,
        fraction: request.params.fraction,
        ...(request.params.guidance !== undefined ? { guidance: request.params.guidance } : {}),
      });
      this.sendMessage(createSessionProtocolSuccessResponse(request.id, "session.prune", result));
    });
  }

  private async handleRewind(
    request: Extract<SessionProtocolRequestMessage, { method: "session.rewind" }>,
  ): Promise<void> {
    await this.withSessionMutation(request, "session rewound", async (state) => {
      const result = await state.session.rewindToHistoryEntryId(request.params.historyEntryId);
      this.sendMessage(createSessionProtocolSuccessResponse(request.id, "session.rewind", result));
    });
  }

  private async handleTerminateSubagent(
    request: Extract<SessionProtocolRequestMessage, { method: "session.terminateSubagent" }>,
  ): Promise<void> {
    await this.withNonInterruptingSessionMutation(request, async (state) => {
      this.sendMessage(
        createSessionProtocolSuccessResponse(
          request.id,
          "session.terminateSubagent",
          await state.session.terminateSubagent(request.params.subagentId),
        ),
      );
    });
  }

  private async handleEphemeralCreate(
    request: Extract<SessionProtocolRequestMessage, { method: "session.ephemeral.create" }>,
  ): Promise<void> {
    await this.withSessionMutation(request, "ephemeral context created", async (mutationState) => {
      const result = await mutationState.session.createEphemeralContext({
        instructions: request.params.instructions,
        tools: request.params.tools,
      });
      this.sendMessage(
        createSessionProtocolSuccessResponse(request.id, "session.ephemeral.create", result),
      );
    });
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
          SESSION_PROTOCOL_ERROR_CODES.internalError,
          error instanceof Error ? error.message : String(error),
        ),
      );
    }
  }

  private async handleEphemeralClose(
    request: Extract<SessionProtocolRequestMessage, { method: "session.ephemeral.close" }>,
  ): Promise<void> {
    await this.withSessionMutation(request, "ephemeral context closed", async (mutationState) => {
      const result = await mutationState.session.closeEphemeralContext(request.params.contextId);
      this.sendMessage(
        createSessionProtocolSuccessResponse(request.id, "session.ephemeral.close", result),
      );
    });
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
      this.rejectPendingSteeringSubmits(state, queuedSteeringRejectionMessage);
      this.rejectPendingQueuedSubmits(state, queuedSteeringRejectionMessage);
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

  private rejectPendingSteeringSubmits(
    state: SessionProtocolHandlerSessionState,
    message: string,
  ): void {
    const requests = state.live.pendingSteeringSubmits.splice(0);
    if (requests.length > 0) {
      state.session.cancelTurnBoundaryStop();
      publishPendingUserMessages(state.session, state.live);
    }
    for (const { handler, request } of requests) {
      handler.sendMessage(
        createSessionProtocolErrorResponse(
          request.id,
          SESSION_PROTOCOL_ERROR_CODES.invalidRequest,
          message,
        ),
      );
    }
  }

  private rejectPendingQueuedSubmits(
    state: SessionProtocolHandlerSessionState,
    message: string,
  ): void {
    const requests = state.live.pendingQueuedSubmits.splice(0);
    if (requests.length > 0) {
      publishPendingUserMessages(state.session, state.live);
    }
    for (const { handler, request } of requests) {
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
    return session ? this.registerSession(session) : undefined;
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
        : state.live.activeBash
          ? "a bash command is already running"
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
    const activeBash = state.live.activeBash;
    if (!activeSubmit && !state.session.isTurnRunning && !activeBash) {
      return;
    }

    state.session.interruptTurn();
    activeBash?.abortController.abort();

    if (!activeSubmit && !activeBash) {
      return;
    }

    try {
      await activeSubmit?.promise;
    } catch {
      // ignore submit failure while finishing active mutation
    }
    try {
      await activeBash?.promise;
    } catch {
      // ignore bash failure while finishing active mutation
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
  }

  private sendMessage(message: SessionProtocolOutgoingMessage): void {
    if (this.closed) {
      return;
    }

    this.send(message);
  }
}
