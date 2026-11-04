import { PersonaSelectionError } from "../core/persona_selection.js";
import {
  createSessionProtocolErrorResponse,
  createSessionProtocolReadyMessage,
  createSessionProtocolSuccessResponse,
  isSessionProtocolObservationMethod,
  SESSION_PROTOCOL_ERROR_CODES,
  SESSION_PROTOCOL_METHODS,
  SESSION_PROTOCOL_VERSION,
  type SessionProtocolClientToolDefinition,
  type SessionProtocolDeltaMessage,
  type SessionProtocolOutgoingMessage,
  type SessionProtocolPendingUserMessagesMessage,
  type SessionProtocolRequestId,
  type SessionProtocolRequestMessage,
  type SessionProtocolResultByMethod,
  type SessionProtocolSubagentActivitiesMessage,
} from "../protocol/session_protocol.js";
import {
  type HostedSessionInput,
  SessionInputBusyError,
  SessionInputCancelledError,
} from "./hosted_session_input.js";
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

type SessionProtocolHandlerCloseMode = "detach" | "shutdown-host";

type SessionProtocolUserSubmissionRequest = Extract<
  SessionProtocolRequestMessage,
  { method: "session.submit" | "session.queue" | "session.steer" }
>;

function isAbortError(error: unknown): boolean {
  return error instanceof Error && error.name === "AbortError";
}

type SessionProtocolHandlerSessionState = {
  observationId: string;
  unsubscribeClosing?: () => void;
  session: TauHostedSession;
  live: HostedSessionInput;
  unsubscribeDelta?: () => void;
  unsubscribeEphemeral?: () => void;
  unsubscribePendingUserMessages?: () => void;
  unsubscribeSubagentActivities?: () => void;
  bufferedDeltas?: SessionProtocolDeltaMessage[];
  bufferedPendingUserMessages?: SessionProtocolPendingUserMessagesMessage[];
  bufferedSubagentActivities?: SessionProtocolSubagentActivitiesMessage[];
  observed: boolean;
  released: boolean;
};

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
  private readonly createdSessionHolds = new Map<
    string,
    { session: TauHostedSession; unsubscribeClosing: () => void }
  >();
  private readonly sessionObservationQueues = new Map<string, Promise<void>>();
  private readonly connectionAbortController = new AbortController();
  private readonly activeSideChannels = new Set<Promise<void>>();
  private readonly activeExecs = new Map<
    string,
    { observationId: string; abortController: AbortController }
  >();
  private initialized = false;
  private clientToolRegistration?: {
    attachSession: (sessionId: string, observationId: string) => void;
    detachSession: (sessionId: string, observationId: string) => void;
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
      if (
        isSessionProtocolObservationMethod(request.method) &&
        request.method !== "session.observe" &&
        request.method !== "session.unobserve" &&
        request.method !== "session.cancelExec" &&
        "sessionId" in request.params
      ) {
        const state = this.sessionStates.get(request.params.sessionId);
        if (!state || state.released || state.observationId !== request.observationId) {
          this.sendSessionNotFound(request.id, request.params.sessionId);
          return;
        }
      }
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
        case "session.retain": {
          const state = this.sessionStates.get(request.params.sessionId);
          if (!state?.observed) {
            this.sendSessionNotFound(request.id, request.params.sessionId);
            return;
          }
          const retainedUntil = this.host.retainSessionRuntime(
            state.session,
            request.params.durationMs,
          );
          if (retainedUntil === undefined) {
            this.sendSessionNotFound(request.id, request.params.sessionId);
            return;
          }
          this.sendMessage(
            createSessionProtocolSuccessResponse(request.id, "session.retain", { retainedUntil }),
          );
          return;
        }
        case "session.runtimeState": {
          const result = this.host.sessionRuntimeState(request.params.sessionId);
          this.sendMessage(
            createSessionProtocolSuccessResponse(request.id, "session.runtimeState", result),
          );
          return;
        }
        case "session.unload": {
          const unloaded = await this.host.unloadSession(request.params.sessionId);
          this.sendMessage(
            createSessionProtocolSuccessResponse(request.id, "session.unload", { unloaded }),
          );
          return;
        }
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
        case "session.setAutoCompactThreshold":
          await this.handleSetAutoCompactThreshold(request);
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
          await this.handleClientToolAck(request);
          return;
        case "session.clientTool.result":
          this.handleClientToolResult(request);
          return;
      }
    } catch (error) {
      if (
        error instanceof SessionInputBusyError ||
        error instanceof SessionInputCancelledError ||
        error instanceof SessionRetryUnavailableError
      ) {
        this.sendMessage(
          createSessionProtocolErrorResponse(
            request.id,
            error instanceof SessionInputBusyError
              ? SESSION_PROTOCOL_ERROR_CODES.busy
              : error instanceof SessionInputCancelledError
                ? SESSION_PROTOCOL_ERROR_CODES.cancelled
                : SESSION_PROTOCOL_ERROR_CODES.invalidRequest,
            error.message,
          ),
        );
        return;
      }
      if (error instanceof PersonaSelectionError) {
        this.sendMessage(
          createSessionProtocolErrorResponse(
            request.id,
            SESSION_PROTOCOL_ERROR_CODES.invalidRequest,
            error.message,
          ),
        );
        return;
      }
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

    const states = [...this.sessionStates.values()];
    const activeSideChannels = [...this.activeSideChannels];
    this.connectionAbortController.abort();

    for (const state of states) {
      this.unsubscribeSessionListeners(state);
    }

    for (const sessionId of this.createdSessionHolds.keys()) this.releaseCreatedSession(sessionId);
    this.sessionStates.clear();
    this.clientToolRegistration?.unregister();
    this.clientToolRegistration = undefined;

    await Promise.all([
      Promise.allSettled(activeSideChannels),
      shutdownHost ? this.host.shutdown() : undefined,
    ]);
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

  private async handleClientToolAck(
    request: Extract<SessionProtocolRequestMessage, { method: "session.clientTool.ack" }>,
  ): Promise<void> {
    const accepted =
      (await this.host.acknowledgeClientToolCall?.(
        request.params.sessionId,
        request.params.callId,
        request.params.presentation,
      )) ?? false;
    this.sendMessage(
      createSessionProtocolSuccessResponse(request.id, "session.clientTool.ack", { accepted }),
    );
  }

  private handleClientToolResult(
    request: Extract<SessionProtocolRequestMessage, { method: "session.clientTool.result" }>,
  ): void {
    const result = request.params.ok
      ? {
          ok: true as const,
          content: request.params.content,
          ...(request.params.presentation === undefined
            ? {}
            : { presentation: request.params.presentation }),
        }
      : {
          ok: false as const,
          error: request.params.error,
          ...(request.params.presentation === undefined
            ? {}
            : { presentation: request.params.presentation }),
        };
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
    const state = this.getSessionState(request);
    if (!state) {
      this.sendSessionNotFound(request.id, request.params.sessionId);
      return;
    }
    const mode =
      request.method === "session.submit"
        ? "submit"
        : request.method === "session.queue"
          ? "queue"
          : "steer";
    const result = state.live.submit(mode, request.params);
    this.sendMessage(
      createSessionProtocolSuccessResponse(request.id, request.method, await result),
    );
  }

  private async handleCancelPendingMessages(
    request: Extract<SessionProtocolRequestMessage, { method: "session.cancelPendingMessages" }>,
  ): Promise<void> {
    const state = this.getSessionState(request);
    if (!state) {
      this.sendSessionNotFound(request.id, request.params.sessionId);
      return;
    }
    const cancelled = await state.live.enqueue(() => state.live.cancelPending());
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
    if (this.activeExecs.has(key)) {
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
    this.activeExecs.set(key, { observationId: request.observationId, abortController });
    try {
      const state = this.getSessionState(request);
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
      if (this.activeExecs.get(key)?.abortController === abortController) {
        this.activeExecs.delete(key);
      }
    }
  }

  private async handleCancelExec(
    request: Extract<SessionProtocolRequestMessage, { method: "session.cancelExec" }>,
  ): Promise<void> {
    const key = this.execKey(request.params.sessionId, request.params.execId);
    const execution = this.activeExecs.get(key);
    let cancelled = false;
    if (
      execution?.observationId === request.observationId &&
      !execution.abortController.signal.aborted
    ) {
      execution.abortController.abort();
      cancelled = true;
    }
    this.sendMessage(
      createSessionProtocolSuccessResponse(request.id, "session.cancelExec", { cancelled }),
    );
  }

  private async handleSample(
    request: Extract<SessionProtocolRequestMessage, { method: "session.sample" }>,
  ): Promise<void> {
    const state = this.getSessionState(request);
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
    const state = this.getSessionState(request);
    if (!state) {
      this.sendSessionNotFound(request.id, request.params.sessionId);
      return;
    }

    const result = state.live.retry();
    this.sendMessage(
      createSessionProtocolSuccessResponse(request.id, "session.retry", { turn: await result }),
    );
  }

  private async handleCreate(
    request: Extract<SessionProtocolRequestMessage, { method: "session.create" }>,
  ): Promise<void> {
    const session = await this.host.createSession(request.params);
    if (this.closed) {
      await this.host.unloadSession(session.sessionId);
      return;
    }
    this.createdSessionHolds.set(session.sessionId, {
      session,
      unsubscribeClosing: session.onClosing(() => this.releaseCreatedSession(session.sessionId)),
    });
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
    const sessionId = request.params.sessionId;
    const previous = this.sessionObservationQueues.get(sessionId) ?? Promise.resolve();
    const observation = previous.catch(() => undefined).then(() => this.handleAttachNow(request));
    this.sessionObservationQueues.set(sessionId, observation);
    try {
      await observation;
    } finally {
      if (this.sessionObservationQueues.get(sessionId) === observation) {
        this.sessionObservationQueues.delete(sessionId);
      }
    }
  }

  private async handleAttachNow(
    request: Extract<SessionProtocolRequestMessage, { method: "session.observe" }>,
  ): Promise<void> {
    const session = await this.host.observeSession(request.params.sessionId);
    if (!session) {
      this.sendSessionNotFound(request.id, request.params.sessionId);
      return;
    }
    if (this.closed) {
      this.host.releaseSession(session);
      return;
    }
    this.releaseCreatedSession(request.params.sessionId);
    const previous = this.sessionStates.get(request.params.sessionId);
    if (previous) this.endObservation(previous);
    const state = this.registerSession(session, request.observationId);
    state.bufferedDeltas ??= [];
    state.bufferedPendingUserMessages ??= [];
    state.bufferedSubagentActivities ??= [];

    let observed = false;
    try {
      this.clientToolRegistration?.attachSession(session.sessionId, state.observationId);
      const snapshot = await state.session.snapshot();
      if (state.released) {
        this.sendSessionNotFound(request.id, request.params.sessionId);
        return;
      }
      const pendingUserMessages = state.live.snapshot();
      const subagentActivities = state.session.subagentActivities();
      this.sendMessage(
        createSessionProtocolSuccessResponse(request.id, "session.observe", {
          snapshot,
          pendingUserMessages,
          subagentActivities,
        }),
      );
      observed = true;
      state.observed = true;
      this.flushBufferedDeltasAfterSnapshot(state, snapshot.revision);
      this.flushBufferedPendingUserMessagesAfter(state, pendingUserMessages.revision);
      this.flushBufferedSubagentActivitiesAfter(state, subagentActivities.revision);
    } finally {
      if (!observed) {
        this.unsubscribeSessionListeners(state);
        if (this.sessionStates.get(request.params.sessionId) === state)
          this.sessionStates.delete(request.params.sessionId);
      }
    }
  }

  private async handleUnobserve(
    request: Extract<SessionProtocolRequestMessage, { method: "session.unobserve" }>,
  ): Promise<void> {
    this.releaseCreatedSession(request.params.sessionId);
    const state = this.sessionStates.get(request.params.sessionId);
    if (state && state.observationId === request.observationId) this.endObservation(state);

    const result: SessionProtocolResultByMethod["session.unobserve"] = {
      unobserved: true,
    };
    this.sendMessage(createSessionProtocolSuccessResponse(request.id, "session.unobserve", result));
  }

  private async handleRecord(
    request: Extract<SessionProtocolRequestMessage, { method: "session.record" }>,
  ): Promise<void> {
    const state = this.getSessionState(request);
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
    const state = this.getSessionState(request);
    if (!state) {
      this.sendSessionNotFound(request.id, request.params.sessionId);
      return;
    }

    // Cancellation must reach maintenance work while it holds the mutation queue.
    const interrupted = state.session.interruptActiveWork();
    if (interrupted) state.live.interrupting = true;
    const result = await state.live.enqueue(async () => {
      state.live.cancelBoundary("session was interrupted");
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
          state.live.enqueue(() => {
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
    const state = this.getSessionState(request);
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

  private async handleSetAutoCompactThreshold(
    request: Extract<SessionProtocolRequestMessage, { method: "session.setAutoCompactThreshold" }>,
  ): Promise<void> {
    const state = this.getSessionState(request);
    if (!state) {
      this.sendSessionNotFound(request.id, request.params.sessionId);
      return;
    }

    await state.live.mutate(async () => {
      const result = await state.session.setAutoCompactThreshold(request.params.thresholdTokens);
      this.sendMessage(
        createSessionProtocolSuccessResponse(request.id, "session.setAutoCompactThreshold", result),
      );
    });
  }

  private async handleSetReasoning(
    request: Extract<SessionProtocolRequestMessage, { method: "session.setReasoning" }>,
  ): Promise<void> {
    const state = this.getSessionState(request);
    if (!state) {
      this.sendSessionNotFound(request.id, request.params.sessionId);
      return;
    }

    await state.live.mutate(async () => {
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
      const snapshot = await state.session.setPersona(request.params.personaId, {
        reasoning: request.params.reasoning,
        autoCompactThresholdTokens: request.params.autoCompactThresholdTokens,
      });
      this.sendMessage(
        createSessionProtocolSuccessResponse(request.id, "session.setPersona", snapshot),
      );
    });
  }

  private async handleResolvePrompt(
    request: Extract<SessionProtocolRequestMessage, { method: "session.resolvePrompt" }>,
  ): Promise<void> {
    const state = this.getSessionState(request);
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
    const state = this.getSessionState(request);
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
      if (state.live.busy || state.live.hasPending) {
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
    const state = this.getSessionState(request);
    if (!state) {
      this.sendSessionNotFound(request.id, request.params.sessionId);
      return;
    }
    if (this.closed) {
      return;
    }

    const result = await state.session.createEphemeralContext({
      ...(request.params.workingDirectory !== undefined
        ? { workingDirectory: request.params.workingDirectory }
        : {}),
      instructions: request.params.instructions,
      tools: request.params.tools,
      ...(request.params.reasoning !== undefined ? { reasoning: request.params.reasoning } : {}),
    });
    this.sendMessage(
      createSessionProtocolSuccessResponse(request.id, "session.ephemeral.create", result),
    );
  }

  private async handleEphemeralSubmit(
    request: Extract<SessionProtocolRequestMessage, { method: "session.ephemeral.submit" }>,
  ): Promise<void> {
    const state = this.getSessionState(request);
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
        ...(request.params.reasoning !== undefined ? { reasoning: request.params.reasoning } : {}),
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
    const state = this.getSessionState(request);
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
    const state = this.getSessionState(request);
    if (!state) {
      this.sendSessionNotFound(request.id, request.params.sessionId);
      return;
    }

    await state.live.mutate(async () => {
      if (this.closed) {
        return;
      }
      await this.interruptAndWaitForActiveSubmit(state);
      state.live.rejectPending(queuedSteeringRejectionMessage);
      await handler(state);
    });
  }

  private async withNonInterruptingSessionMutation(
    request: SessionProtocolMutationRequest,
    handler: (state: SessionProtocolHandlerSessionState) => Promise<void>,
  ): Promise<void> {
    const state = this.getSessionState(request);
    if (!state) {
      this.sendSessionNotFound(request.id, request.params.sessionId);
      return;
    }

    await state.live.mutate(async () => {
      if (this.closed) {
        return;
      }
      await handler(state);
    });
  }

  private releaseCreatedSession(sessionId: string): void {
    const hold = this.createdSessionHolds.get(sessionId);
    if (!hold) return;
    this.createdSessionHolds.delete(sessionId);
    hold.unsubscribeClosing();
    this.host.releaseSession(hold.session);
  }

  private registerSession(
    session: TauHostedSession,
    observationId: string,
  ): SessionProtocolHandlerSessionState {
    if (session.isDisposing || session.isDisposed) {
      this.host.releaseSession(session);
      throw new Error("session observation ended");
    }
    const state: SessionProtocolHandlerSessionState = {
      observationId,
      session,
      live: session.input,
      observed: false,
      released: false,
    };

    state.unsubscribeDelta = session.onDelta((delta) => {
      if (this.closed || this.sessionStates.get(session.sessionId) !== state) {
        return;
      }
      if (state.bufferedDeltas) {
        state.bufferedDeltas.push(delta);
        return;
      }
      this.sendMessage({ ...delta, observationId });
    });

    state.unsubscribeEphemeral = session.onEphemeral((message) => {
      if (this.closed || this.sessionStates.get(session.sessionId) !== state) {
        return;
      }
      this.sendMessage({ ...message, observationId });
    });

    const pendingUserMessagesListener = (
      message: SessionProtocolPendingUserMessagesMessage,
    ): void => {
      if (this.closed || this.sessionStates.get(session.sessionId) !== state) {
        return;
      }
      if (state.bufferedPendingUserMessages) {
        state.bufferedPendingUserMessages.push(message);
        return;
      }
      this.sendMessage({ ...message, observationId });
    };
    state.unsubscribePendingUserMessages = state.live.onChange(pendingUserMessagesListener);

    state.unsubscribeSubagentActivities = session.onSubagentActivities((message) => {
      if (this.closed || this.sessionStates.get(session.sessionId) !== state) {
        return;
      }
      if (state.bufferedSubagentActivities) {
        state.bufferedSubagentActivities.push(message);
        return;
      }
      this.sendMessage({ ...message, observationId });
    });

    state.unsubscribeClosing = session.onClosing(() => {
      this.endObservation(state);
    });
    this.sessionStates.set(session.sessionId, state);
    return state;
  }

  private getSessionState(request: {
    params: { sessionId: string };
    observationId: string;
  }): SessionProtocolHandlerSessionState | undefined {
    const state = this.sessionStates.get(request.params.sessionId);
    return state && !state.released && state.observationId === request.observationId
      ? state
      : undefined;
  }

  private endObservation(state: SessionProtocolHandlerSessionState): void {
    if (state.released) return;
    this.unsubscribeSessionListeners(state);
    if (this.sessionStates.get(state.session.sessionId) === state) {
      this.sessionStates.delete(state.session.sessionId);
    }
    this.sendMessage({
      version: SESSION_PROTOCOL_VERSION,
      type: "session.observationEnded",
      sessionId: state.session.sessionId,
      observationId: state.observationId,
    });
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
        this.sendMessage({ ...delta, observationId: state.observationId });
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
        this.sendMessage({ ...message, observationId: state.observationId });
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
        this.sendMessage({ ...message, observationId: state.observationId });
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

  private async interruptAndWaitForActiveSubmit(
    state: SessionProtocolHandlerSessionState,
  ): Promise<void> {
    if (!state.live.busy) return;
    state.session.interruptTurn();
    await state.live.waitForIdle();
  }

  private unsubscribeSessionListeners(state: SessionProtocolHandlerSessionState): void {
    if (state.released) return;
    state.released = true;
    state.unsubscribeClosing?.();
    state.unsubscribeClosing = undefined;
    state.unsubscribeDelta?.();
    state.unsubscribeDelta = undefined;
    state.unsubscribeEphemeral?.();
    state.unsubscribeEphemeral = undefined;
    state.unsubscribePendingUserMessages?.();
    state.unsubscribePendingUserMessages = undefined;
    state.unsubscribeSubagentActivities?.();
    state.unsubscribeSubagentActivities = undefined;
    try {
      this.clientToolRegistration?.detachSession(state.session.sessionId, state.observationId);
    } finally {
      this.host.releaseSession(state.session);
    }
  }

  private sendMessage(message: SessionProtocolOutgoingMessage): void {
    if (this.closed) {
      return;
    }

    this.send(message);
  }
}
