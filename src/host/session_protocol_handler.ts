import { formatSteeringUserMessage } from "../core/runtime/steering.js";
import {
  createSessionProtocolErrorResponse,
  createSessionProtocolReadyMessage,
  createSessionProtocolSuccessResponse,
  SESSION_PROTOCOL_ERROR_CODES,
  SESSION_PROTOCOL_METHODS,
  SESSION_PROTOCOL_VERSION,
  type SessionProtocolDeltaMessage,
  type SessionProtocolOutgoingMessage,
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

type SessionProtocolHandlerSessionState = {
  session: TauHostedSession;
  unsubscribeDelta?: () => void;
  unsubscribeEphemeral?: () => void;
  bufferedDeltas?: SessionProtocolDeltaMessage[];
  activeSubmit?: {
    requestId: SessionProtocolRequestId;
    promise: Promise<void>;
  };
  activeBash?: {
    requestId: SessionProtocolRequestId;
    abortController: AbortController;
    promise: Promise<void>;
  };
  pendingSteeringSubmits: Array<
    Extract<SessionProtocolRequestMessage, { method: "session.steer" }>
  >;
  pendingQueuedSubmits: Array<Extract<SessionProtocolRequestMessage, { method: "session.queue" }>>;
};

type SessionMutationQueueState = {
  queue: Promise<void>;
  pending: number;
};

const sessionMutationQueues = new WeakMap<TauHostedSession, SessionMutationQueueState>();

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
      | "session.setRisk"
      | "session.setReasoning"
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
        case "session.setRisk":
          await this.handleSetRisk(request);
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
      this.unsubscribeDeltaListener(state);

      if (interruptActiveTurns && (state.activeSubmit || state.session.isTurnRunning)) {
        state.session.interruptTurn();
      }
      if (interruptActiveTurns && state.activeBash) {
        state.activeBash.abortController.abort();
      }
    }

    if (interruptActiveTurns) {
      await Promise.allSettled(
        states.map((state) => state.activeSubmit?.promise).filter((promise) => promise),
      );
      await Promise.allSettled(
        states.map((state) => state.activeBash?.promise).filter((promise) => promise),
      );
    }

    this.sessionStates.clear();

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

    this.initialized = true;
    this.sendMessage(createSessionProtocolSuccessResponse(request.id, "initialize", result));
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
        if (state.activeSubmit === activeSubmit) {
          state.activeSubmit = undefined;
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
      if (state.activeSubmit || state.session.isTurnRunning || state.activeBash) {
        state.pendingQueuedSubmits.push(request);
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
        if (state.activeSubmit === activeSubmit) {
          state.activeSubmit = undefined;
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
      if (state.activeSubmit || state.session.isTurnRunning || state.activeBash) {
        state.pendingSteeringSubmits.push(request);
        state.session.requestTurnBoundaryStop();
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
        if (state.activeSubmit === activeSubmit) {
          state.activeSubmit = undefined;
        }
      });
      this.schedulePendingSubmitDrains(state);
    }
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
      state.activeSubmit ||
      state.session.isTurnRunning ||
      state.activeBash
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
        if (state.activeBash === activeBash) {
          state.activeBash = undefined;
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
        if (state.activeSubmit === activeSubmit) {
          state.activeSubmit = undefined;
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
    this.registerSession(session);
    this.sendMessage(
      createSessionProtocolSuccessResponse(request.id, "session.create", await session.snapshot()),
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
    const state = await this.getSessionState(request.params.sessionId, {
      bufferInitialDeltas: !wasObserved,
    });
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
    if (!wasObserved && !state.bufferedDeltas) {
      state.bufferedDeltas = [];
    }

    let observed = false;
    try {
      const snapshot = await state.session.snapshot();
      this.sendMessage(
        createSessionProtocolSuccessResponse(request.id, "session.observe", snapshot),
      );
      observed = true;
      this.flushBufferedDeltasAfterSnapshot(state, snapshot.revision);
    } finally {
      if (!observed && !wasObserved) {
        this.unsubscribeDeltaListener(state);
        this.sessionStates.delete(request.params.sessionId);
      } else if (!observed) {
        this.flushBufferedDeltasAfterSnapshot(state, 0);
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

    this.unsubscribeDeltaListener(state);
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
    if (state.activeSubmit || state.session.isTurnRunning || state.activeBash) {
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
    state.activeSubmit = activeSubmit;

    return {
      activeSubmit,
    };
  }

  private startRetry(
    state: SessionProtocolHandlerSessionState,
    request: Extract<SessionProtocolRequestMessage, { method: "session.retry" }>,
  ) {
    if (state.activeSubmit || state.session.isTurnRunning || state.activeBash) {
      this.sendSubmitBusy(state, request.id);
      return undefined;
    }

    const retryPromise = this.executeRetry(state, request.id);
    const activeSubmit = { requestId: request.id, promise: retryPromise };
    state.activeSubmit = activeSubmit;

    return {
      activeSubmit,
    };
  }

  private startExec(
    state: SessionProtocolHandlerSessionState,
    request: Extract<SessionProtocolRequestMessage, { method: "session.exec" }>,
  ) {
    if (state.activeSubmit || state.session.isTurnRunning || state.activeBash) {
      this.sendSubmitBusy(state, request.id);
      return undefined;
    }

    const abortController = new AbortController();
    const promise = this.executeExec(state, request, abortController.signal);
    const activeBash = { requestId: request.id, abortController, promise };
    state.activeBash = activeBash;
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
        state.pendingSteeringSubmits.length === 0 ||
        state.activeSubmit ||
        state.session.isTurnRunning
      ) {
        return undefined;
      }

      const requests = state.pendingSteeringSubmits.splice(0);
      const primaryRequest = requests[0]!;
      const preferredHistoryEntryId =
        requests.length === 1 ? primaryRequest.params.historyEntryId : undefined;
      let userHistoryEntryId: string;
      try {
        ({ userHistoryEntryId } = await state.session.record({
          text: formatSteeringUserMessage(requests.map((item) => item.params.text)),
          ...(preferredHistoryEntryId ? { historyEntryId: preferredHistoryEntryId } : {}),
        }));
      } catch (error) {
        this.sendUserMessageDrainFailure("session.steer", requests, error);
        return undefined;
      }
      const submitPromise = this.executeSubmit(
        state,
        primaryRequest.id,
        "session.steer",
        userHistoryEntryId,
        requests,
      );
      const activeSubmit = {
        requestId: primaryRequest.id,
        promise: submitPromise,
      };
      state.activeSubmit = activeSubmit;

      return { activeSubmit };
    });

    if (!batch) {
      return;
    }

    try {
      await batch.activeSubmit.promise;
    } finally {
      await this.enqueueMutation(state, () => {
        if (state.activeSubmit === batch.activeSubmit) {
          state.activeSubmit = undefined;
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
        state.pendingQueuedSubmits.length === 0 ||
        state.activeSubmit ||
        state.session.isTurnRunning
      ) {
        return undefined;
      }

      const request = state.pendingQueuedSubmits.shift()!;
      try {
        return await this.startUserMessageTurn(state, request);
      } catch (error) {
        this.sendUserMessageDrainFailure("session.queue", [request], error);
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
        if (state.activeSubmit === next.activeSubmit) {
          state.activeSubmit = undefined;
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
        ? state.pendingSteeringSubmits.splice(0)
        : state.pendingQueuedSubmits.splice(0);
    this.sendUserMessageDrainFailure(method, pending, error);
  }

  private sendUserMessageDrainFailure(
    method: "session.queue" | "session.steer",
    requests: Array<Extract<SessionProtocolRequestMessage, { method: typeof method }>>,
    error: unknown,
  ): void {
    for (const request of requests) {
      this.sendMessage(
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
    responseRequests?: Array<Extract<SessionProtocolRequestMessage, { method: typeof method }>>,
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
        for (const request of responseRequests) {
          this.sendMessage(createSessionProtocolSuccessResponse(request.id, method, result));
        }
      } else {
        this.sendMessage(createSessionProtocolSuccessResponse(requestId, method, result));
      }
    } catch (error) {
      await this.snapshotAfterFailedSubmit(state);
      const requests = responseRequests ?? [{ id: requestId }];
      for (const request of requests) {
        this.sendMessage(
          createSessionProtocolErrorResponse(
            request.id,
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

    const interrupted = state.session.interruptTurn();
    const interruptedBash = Boolean(state.activeBash);
    state.activeBash?.abortController.abort();
    this.rejectPendingSteeringSubmits(state, "session was interrupted");

    const result: SessionProtocolResultByMethod["session.interrupt"] = {
      interrupted: interrupted || interruptedBash,
      isTurnRunning: state.session.isTurnRunning || interruptedBash,
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

  private async handleSetRisk(
    request: Extract<SessionProtocolRequestMessage, { method: "session.setRisk" }>,
  ): Promise<void> {
    await this.withSessionMutation(request, "session risk level changed", async (state) => {
      const snapshot = await state.session.setRiskLevel(request.params.riskLevel);
      this.sendMessage(
        createSessionProtocolSuccessResponse(request.id, "session.setRisk", snapshot),
      );
    });
  }

  private async handleSetReasoning(
    request: Extract<SessionProtocolRequestMessage, { method: "session.setReasoning" }>,
  ): Promise<void> {
    await this.withSessionMutation(request, "session reasoning changed", async (state) => {
      const snapshot = await state.session.setReasoning(request.params.reasoning);
      this.sendMessage(
        createSessionProtocolSuccessResponse(request.id, "session.setReasoning", snapshot),
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
    await this.withSessionMutation(request, "subagent termination requested", async (state) => {
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
        riskLevel: request.params.riskLevel,
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

  private rejectPendingSteeringSubmits(
    state: SessionProtocolHandlerSessionState,
    message: string,
  ): void {
    const requests = state.pendingSteeringSubmits.splice(0);
    for (const request of requests) {
      this.sendMessage(
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
    const requests = state.pendingQueuedSubmits.splice(0);
    for (const request of requests) {
      this.sendMessage(
        createSessionProtocolErrorResponse(
          request.id,
          SESSION_PROTOCOL_ERROR_CODES.invalidRequest,
          message,
        ),
      );
    }
  }

  private registerSession(
    session: TauHostedSession,
    options: { bufferInitialDeltas?: boolean } = {},
  ): SessionProtocolHandlerSessionState {
    const existing = this.sessionStates.get(session.sessionId);
    if (existing) {
      return existing;
    }

    const state: SessionProtocolHandlerSessionState = {
      session,
      ...(options.bufferInitialDeltas ? { bufferedDeltas: [] } : {}),
      pendingSteeringSubmits: [],
      pendingQueuedSubmits: [],
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

    this.sessionStates.set(session.sessionId, state);
    return state;
  }

  private async getSessionState(
    sessionId: string,
    options: { bufferInitialDeltas?: boolean } = {},
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
    return session ? this.registerSession(session, options) : undefined;
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
        : state.activeBash
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
    const activeSubmit = state.activeSubmit;
    const activeBash = state.activeBash;
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

  private unsubscribeDeltaListener(state: SessionProtocolHandlerSessionState): void {
    this.unsubscribeSessionListeners(state);
  }

  private unsubscribeSessionListeners(state: SessionProtocolHandlerSessionState): void {
    if (!state.unsubscribeDelta) {
      // continue to ephemeral cleanup below
    } else {
      state.unsubscribeDelta();
      state.unsubscribeDelta = undefined;
    }

    if (state.unsubscribeEphemeral) {
      state.unsubscribeEphemeral();
      state.unsubscribeEphemeral = undefined;
    }
  }

  private sendMessage(message: SessionProtocolOutgoingMessage): void {
    if (this.closed) {
      return;
    }

    this.send(message);
  }
}
