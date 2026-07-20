import type {
  SessionProtocolClientToolCallMessage,
  SessionProtocolClientToolCancelMessage,
  SessionProtocolCreateParams,
  SessionProtocolEphemeralAgentTool,
  SessionProtocolInitializeParams,
  SessionProtocolResultByMethod,
  SessionProtocolSampleParams,
} from "../protocol/session_protocol.js";
import {
  SESSION_PROTOCOL_VERSION,
  validateSessionProtocolParams,
} from "../protocol/session_protocol.js";
import {
  type SessionProtocolTransport,
  TauSessionClientError,
  TauTransportError,
} from "../transport/index.js";
import type {
  TauSdkClient,
  TauSdkClientTool,
  TauSdkDeltaListener,
  TauSdkEphemeralListener,
  TauSdkInitializeParams,
  TauSdkPendingUserMessagesListener,
  TauSdkSession,
  TauSdkSessionClient,
  TauSdkSessionUserMessageOptions,
  TauSdkTransportClientOptions,
} from "./types.js";

const DEFAULT_CONNECT_TIMEOUT_MS = 5_000;
const DEFAULT_INITIALIZE_PARAMS: SessionProtocolInitializeParams = {
  client: {
    name: "tau-sdk",
    version: "1",
  },
};

export async function createTauSdkClientFromTransport(
  transport: SessionProtocolTransport,
  options: TauSdkTransportClientOptions = {},
): Promise<TauSdkClient> {
  const initializeParams = resolveTauSdkInitializeParams(options.initialize, options.clientTools);
  const client = new TauSdkClientImpl(transport, options.clientTools ?? []);

  try {
    await transport.connect(
      initializeParams,
      options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
    );
    return client;
  } catch (error) {
    await client.close();
    throw error;
  }
}

class TauSdkClientImpl implements TauSdkClient {
  readonly sessions: TauSdkSessionClient;

  private readonly clientToolAbortControllers = new Map<string, AbortController>();
  private readonly unsubscribeClientTool: () => void;

  constructor(
    private readonly transport: SessionProtocolTransport,
    private readonly clientTools: TauSdkClientTool[],
  ) {
    this.sessions = new TauSdkSessionClientImpl(this);
    this.unsubscribeClientTool = this.transport.onClientTool((message) =>
      this.handleClientTool(message),
    );
  }

  get ready() {
    return this.transport.ready;
  }

  subscribe(listener: TauSdkDeltaListener): () => void {
    return this.transport.onDelta(listener);
  }

  subscribeEphemeral(listener: TauSdkEphemeralListener): () => void {
    return this.transport.onEphemeral(listener);
  }

  subscribePendingUserMessages(listener: TauSdkPendingUserMessagesListener): () => void {
    return this.transport.onPendingUserMessages(listener);
  }

  createObservedSession(sessionId: string): TauSdkSessionImpl {
    return new TauSdkSessionImpl(this, sessionId);
  }

  createSession(
    input: SessionProtocolCreateParams,
  ): Promise<SessionProtocolResultByMethod["session.create"]> {
    return this.transport.request("session.create", input);
  }

  listSessions(): Promise<SessionProtocolResultByMethod["session.list"]> {
    return this.transport.request("session.list", {});
  }

  observeSession(sessionId: string): Promise<SessionProtocolResultByMethod["session.observe"]> {
    return this.transport.request("session.observe", { sessionId });
  }

  unobserveSession(sessionId: string): Promise<SessionProtocolResultByMethod["session.unobserve"]> {
    return this.transport.request("session.unobserve", { sessionId });
  }

  async close(): Promise<void> {
    this.unsubscribeClientTool();
    for (const controller of this.clientToolAbortControllers.values()) {
      controller.abort();
    }
    this.clientToolAbortControllers.clear();
    await this.transport.close();
  }

  private handleClientTool(
    message: SessionProtocolClientToolCallMessage | SessionProtocolClientToolCancelMessage,
  ): void {
    if (message.type === "session.clientTool.cancel") {
      this.clientToolAbortControllers.get(message.callId)?.abort();
      this.clientToolAbortControllers.delete(message.callId);
      return;
    }

    const tool = this.clientTools.find((candidate) => candidate.schema.name === message.toolName);
    if (!tool) {
      return;
    }

    const abortController = new AbortController();
    this.clientToolAbortControllers.set(message.callId, abortController);
    void this.runClientTool(tool, message, abortController)
      .catch(() => undefined)
      .finally(() => {
        this.clientToolAbortControllers.delete(message.callId);
      });
  }

  private async runClientTool(
    tool: TauSdkClientTool,
    message: SessionProtocolClientToolCallMessage,
    abortController: AbortController,
  ): Promise<void> {
    const ack = await this.transport.request("session.clientTool.ack", {
      sessionId: message.sessionId,
      callId: message.callId,
    });
    if (!ack.accepted || abortController.signal.aborted) {
      return;
    }

    try {
      const result = await tool.execute(message.arguments, {
        sessionId: message.sessionId,
        callId: message.callId,
        signal: abortController.signal,
      });
      if (abortController.signal.aborted) {
        return;
      }
      const content = typeof result === "string" ? result : result.content;
      await this.transport.request("session.clientTool.result", {
        sessionId: message.sessionId,
        callId: message.callId,
        ok: true,
        content,
      });
    } catch (error) {
      if (abortController.signal.aborted) {
        return;
      }
      await this.transport.request("session.clientTool.result", {
        sessionId: message.sessionId,
        callId: message.callId,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  sendSubmit(
    sessionId: string,
    text: string,
    options: TauSdkSessionUserMessageOptions,
  ): Promise<SessionProtocolResultByMethod["session.submit"]> {
    return this.transport.request("session.submit", {
      sessionId,
      text,
      ...(options.historyEntryId === undefined ? {} : { historyEntryId: options.historyEntryId }),
    });
  }

  sendQueue(
    sessionId: string,
    text: string,
    options: TauSdkSessionUserMessageOptions,
  ): Promise<SessionProtocolResultByMethod["session.queue"]> {
    return this.transport.request("session.queue", {
      sessionId,
      text,
      ...(options.historyEntryId === undefined ? {} : { historyEntryId: options.historyEntryId }),
    });
  }

  sendSteer(
    sessionId: string,
    text: string,
    options: TauSdkSessionUserMessageOptions,
  ): Promise<SessionProtocolResultByMethod["session.steer"]> {
    return this.transport.request("session.steer", {
      sessionId,
      text,
      ...(options.historyEntryId === undefined ? {} : { historyEntryId: options.historyEntryId }),
    });
  }

  sendCancelPendingMessages(
    sessionId: string,
  ): Promise<SessionProtocolResultByMethod["session.cancelPendingMessages"]> {
    return this.transport.request("session.cancelPendingMessages", { sessionId });
  }

  sendRecord(
    sessionId: string,
    text: string,
    options: TauSdkSessionUserMessageOptions,
  ): Promise<SessionProtocolResultByMethod["session.record"]> {
    return this.transport.request("session.record", {
      sessionId,
      text,
      ...(options.historyEntryId === undefined ? {} : { historyEntryId: options.historyEntryId }),
    });
  }

  sendRetry(sessionId: string): Promise<SessionProtocolResultByMethod["session.retry"]> {
    return this.transport.request("session.retry", { sessionId });
  }

  sendExec(
    sessionId: string,
    command: string,
    options: { cwd?: string; timeoutMs?: number } = {},
  ): Promise<SessionProtocolResultByMethod["session.exec"]> {
    return this.transport.request("session.exec", {
      sessionId,
      command,
      ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
    });
  }

  sendSample(
    sessionId: string,
    input: Omit<SessionProtocolSampleParams, "sessionId">,
  ): Promise<SessionProtocolResultByMethod["session.sample"]> {
    return this.transport.request("session.sample", { sessionId, ...input });
  }

  sendInterrupt(sessionId: string): Promise<SessionProtocolResultByMethod["session.interrupt"]> {
    return this.transport.request("session.interrupt", { sessionId });
  }

  sendSnapshot(sessionId: string): Promise<SessionProtocolResultByMethod["session.snapshot"]> {
    return this.transport.request("session.snapshot", { sessionId });
  }

  sendSetReasoning(
    sessionId: string,
    reasoning: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max",
  ): Promise<SessionProtocolResultByMethod["session.setReasoning"]> {
    return this.transport.request("session.setReasoning", {
      sessionId,
      reasoning,
    });
  }

  sendSetPersona(
    sessionId: string,
    personaId: string,
  ): Promise<SessionProtocolResultByMethod["session.setPersona"]> {
    return this.transport.request("session.setPersona", {
      sessionId,
      personaId,
    });
  }

  sendResolvePrompt(
    sessionId: string,
    promptId: string,
  ): Promise<SessionProtocolResultByMethod["session.resolvePrompt"]> {
    return this.transport.request("session.resolvePrompt", {
      sessionId,
      promptId,
    });
  }

  sendAutocompletePaths(
    sessionId: string,
    options: { query: string; limit: number },
  ): Promise<SessionProtocolResultByMethod["session.autocompletePaths"]> {
    return this.transport.request("session.autocompletePaths", {
      sessionId,
      query: options.query,
      limit: options.limit,
    });
  }

  sendReload(sessionId: string): Promise<SessionProtocolResultByMethod["session.reload"]> {
    return this.transport.request("session.reload", { sessionId });
  }

  sendCompact(
    sessionId: string,
    mode: "summary-only" | "summary-and-last",
    options: { guidance?: string },
  ): Promise<SessionProtocolResultByMethod["session.compact"]> {
    return this.transport.request("session.compact", {
      sessionId,
      mode,
      ...(options.guidance !== undefined ? { guidance: options.guidance } : {}),
    });
  }

  sendPrune(
    sessionId: string,
    strategy: "earliest" | "largest" | "smart",
    options: { fraction: number; guidance?: string },
  ): Promise<SessionProtocolResultByMethod["session.prune"]> {
    return this.transport.request("session.prune", {
      sessionId,
      strategy,
      fraction: options.fraction,
      ...(options.guidance !== undefined ? { guidance: options.guidance } : {}),
    });
  }

  sendRewind(
    sessionId: string,
    historyEntryId: string,
  ): Promise<SessionProtocolResultByMethod["session.rewind"]> {
    return this.transport.request("session.rewind", {
      sessionId,
      historyEntryId,
    });
  }

  sendTerminateSubagent(
    sessionId: string,
    subagentId: string,
  ): Promise<SessionProtocolResultByMethod["session.terminateSubagent"]> {
    return this.transport.request("session.terminateSubagent", {
      sessionId,
      subagentId,
    });
  }

  sendEphemeralCreate(
    sessionId: string,
    options: {
      instructions: string;
      tools: SessionProtocolEphemeralAgentTool[];
    },
  ): Promise<SessionProtocolResultByMethod["session.ephemeral.create"]> {
    return this.transport.request("session.ephemeral.create", {
      sessionId,
      instructions: options.instructions,
      tools: options.tools,
    });
  }

  sendEphemeralSubmit(
    sessionId: string,
    options: {
      contextId: string;
      threadId: string;
      forkFromThreadId?: string;
      message: string;
    },
  ): Promise<SessionProtocolResultByMethod["session.ephemeral.submit"]> {
    return this.transport.request("session.ephemeral.submit", {
      sessionId,
      contextId: options.contextId,
      threadId: options.threadId,
      ...(options.forkFromThreadId !== undefined
        ? { forkFromThreadId: options.forkFromThreadId }
        : {}),
      message: options.message,
    });
  }

  sendEphemeralClose(
    sessionId: string,
    contextId: string,
  ): Promise<SessionProtocolResultByMethod["session.ephemeral.close"]> {
    return this.transport.request("session.ephemeral.close", {
      sessionId,
      contextId,
    });
  }
}

export function resolveTauSdkInitializeParams(
  params: TauSdkInitializeParams | undefined,
  clientTools: TauSdkClientTool[] = [],
): SessionProtocolInitializeParams {
  const base = params ?? DEFAULT_INITIALIZE_PARAMS;
  const candidate: SessionProtocolInitializeParams = {
    client: {
      name: base.client.name,
      version: base.client.version,
      ...(clientTools.length > 0 ? { tools: clientTools.map((tool) => tool.schema) } : {}),
    },
  };
  const validated = validateSessionProtocolParams("initialize", candidate);
  if (!validated.ok) {
    throw new TauTransportError(validated.error.message);
  }

  return validated.value;
}

class TauSdkSessionClientImpl implements TauSdkSessionClient {
  constructor(private readonly client: TauSdkClientImpl) {}

  async create(input: SessionProtocolCreateParams): Promise<TauSdkSession> {
    const { sessionId } = await this.client.createSession(input);
    return this.observe(sessionId);
  }

  async list() {
    const result = await this.client.listSessions();
    return result.sessions;
  }

  async observe(sessionId: string): Promise<TauSdkSession> {
    const session = this.client.createObservedSession(sessionId);
    try {
      const initialState = await this.client.observeSession(sessionId);
      session.assertSessionId(initialState.snapshot.sessionId);
      session.setInitialSnapshot(initialState.snapshot);
      session.setInitialPendingUserMessages(initialState.pendingUserMessages);
      session.discardBufferedDeltasThrough(initialState.snapshot.revision);
      return session;
    } catch (error) {
      session.disposeLocal();
      throw error;
    }
  }
}

class TauSdkSessionImpl implements TauSdkSession {
  private isUnobserved = false;
  private readonly deltaListeners = new Set<TauSdkDeltaListener>();
  private readonly ephemeralListeners = new Set<TauSdkEphemeralListener>();
  private readonly pendingUserMessagesListeners = new Set<TauSdkPendingUserMessagesListener>();
  private readonly bufferedDeltas: Parameters<TauSdkDeltaListener>[0][] = [];
  private readonly unsubscribeClientDeltas: () => void;
  private readonly unsubscribeClientEphemeral: () => void;
  private readonly unsubscribeClientPendingUserMessages: () => void;
  private initialSnapshot?: SessionProtocolResultByMethod["session.snapshot"];
  private pendingUserMessagesValue?: Parameters<TauSdkPendingUserMessagesListener>[0]["state"];

  constructor(
    private readonly client: TauSdkClientImpl,
    private sessionId: string,
  ) {
    this.unsubscribeClientDeltas = this.client.subscribe((delta) => this.handleDelta(delta));
    this.unsubscribeClientEphemeral = this.client.subscribeEphemeral((message) =>
      this.handleEphemeral(message),
    );
    this.unsubscribeClientPendingUserMessages = this.client.subscribePendingUserMessages(
      (message) => this.handlePendingUserMessages(message),
    );
  }

  get id(): string {
    return this.sessionId;
  }

  pendingUserMessages(): Parameters<TauSdkPendingUserMessagesListener>[0]["state"] {
    this.assertActive();
    if (!this.pendingUserMessagesValue) {
      throw new TauSessionClientError("tau sdk pending user messages are not initialized");
    }
    return structuredClone(this.pendingUserMessagesValue);
  }

  onDelta(listener: TauSdkDeltaListener): () => void {
    this.assertActive();
    this.deltaListeners.add(listener);
    for (const delta of this.bufferedDeltas.splice(0)) {
      try {
        listener(delta);
      } catch {
        // SDK delta listeners must not break session event delivery.
      }
    }
    return () => {
      this.deltaListeners.delete(listener);
    };
  }

  onEphemeral(listener: TauSdkEphemeralListener): () => void {
    this.assertActive();
    this.ephemeralListeners.add(listener);
    return () => {
      this.ephemeralListeners.delete(listener);
    };
  }

  onPendingUserMessages(listener: TauSdkPendingUserMessagesListener): () => void {
    this.assertActive();
    this.pendingUserMessagesListeners.add(listener);
    if (this.pendingUserMessagesValue) {
      try {
        listener({
          version: SESSION_PROTOCOL_VERSION,
          type: "session.pendingUserMessages",
          sessionId: this.sessionId,
          state: structuredClone(this.pendingUserMessagesValue),
        });
      } catch {
        // SDK pending-message listeners must not break session event delivery.
      }
    }
    return () => {
      this.pendingUserMessagesListeners.delete(listener);
    };
  }

  submit(
    text: string,
    options: TauSdkSessionUserMessageOptions = {},
  ): Promise<SessionProtocolResultByMethod["session.submit"]> {
    return this.client.sendSubmit(this.activeSessionId(), text, options);
  }

  async record(
    text: string,
    options: TauSdkSessionUserMessageOptions = {},
  ): Promise<SessionProtocolResultByMethod["session.record"]> {
    return await this.client.sendRecord(this.activeSessionId(), text, options);
  }

  queue(
    text: string,
    options: TauSdkSessionUserMessageOptions = {},
  ): Promise<SessionProtocolResultByMethod["session.queue"]> {
    return this.client.sendQueue(this.activeSessionId(), text, options);
  }

  steer(
    text: string,
    options: TauSdkSessionUserMessageOptions = {},
  ): Promise<SessionProtocolResultByMethod["session.steer"]> {
    return this.client.sendSteer(this.activeSessionId(), text, options);
  }

  cancelPendingMessages(): Promise<SessionProtocolResultByMethod["session.cancelPendingMessages"]> {
    return this.client.sendCancelPendingMessages(this.activeSessionId());
  }

  async retry(): Promise<SessionProtocolResultByMethod["session.retry"]> {
    return await this.client.sendRetry(this.activeSessionId());
  }

  async exec(
    command: string,
    options: { cwd?: string; timeoutMs?: number } = {},
  ): Promise<SessionProtocolResultByMethod["session.exec"]> {
    return await this.client.sendExec(this.activeSessionId(), command, options);
  }

  async sample(
    input: Omit<SessionProtocolSampleParams, "sessionId">,
  ): Promise<SessionProtocolResultByMethod["session.sample"]> {
    return await this.client.sendSample(this.activeSessionId(), input);
  }

  async interrupt(): Promise<SessionProtocolResultByMethod["session.interrupt"]> {
    return await this.client.sendInterrupt(this.activeSessionId());
  }

  async snapshot(): Promise<SessionProtocolResultByMethod["session.snapshot"]> {
    this.assertActive();
    const initialSnapshot = this.initialSnapshot;
    if (initialSnapshot) {
      this.initialSnapshot = undefined;
      if (this.bufferedDeltas.every((delta) => delta.toRevision <= initialSnapshot.revision)) {
        this.discardBufferedDeltasThrough(initialSnapshot.revision);
        return initialSnapshot;
      }
    }

    const snapshot = await this.client.sendSnapshot(this.sessionId);
    this.discardBufferedDeltasThrough(snapshot.revision);
    return snapshot;
  }

  async setReasoning(
    reasoning: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max",
  ): Promise<SessionProtocolResultByMethod["session.setReasoning"]> {
    const snapshot = await this.client.sendSetReasoning(this.activeSessionId(), reasoning);
    this.discardBufferedDeltasThrough(snapshot.revision);
    return snapshot;
  }

  async setPersona(
    personaId: string,
  ): Promise<SessionProtocolResultByMethod["session.setPersona"]> {
    const snapshot = await this.client.sendSetPersona(this.activeSessionId(), personaId);
    this.discardBufferedDeltasThrough(snapshot.revision);
    return snapshot;
  }

  async resolvePrompt(
    promptId: string,
  ): Promise<SessionProtocolResultByMethod["session.resolvePrompt"]> {
    return await this.client.sendResolvePrompt(this.activeSessionId(), promptId);
  }

  async autocompletePaths(options: {
    query: string;
    limit: number;
  }): Promise<SessionProtocolResultByMethod["session.autocompletePaths"]> {
    return await this.client.sendAutocompletePaths(this.activeSessionId(), options);
  }

  async reload(): Promise<SessionProtocolResultByMethod["session.reload"]> {
    const result = await this.client.sendReload(this.activeSessionId());
    this.discardBufferedDeltasThrough(result.snapshot.revision);
    return result;
  }

  async compact(
    mode: "summary-only" | "summary-and-last",
    options: { guidance?: string } = {},
  ): Promise<SessionProtocolResultByMethod["session.compact"]> {
    const result = await this.client.sendCompact(this.activeSessionId(), mode, options);
    this.discardBufferedDeltasThrough(result.snapshot.revision);
    return result;
  }

  async pruneToolResults(
    strategy: "earliest" | "largest" | "smart",
    options: { fraction: number; guidance?: string },
  ): Promise<SessionProtocolResultByMethod["session.prune"]> {
    const result = await this.client.sendPrune(this.activeSessionId(), strategy, options);
    this.discardBufferedDeltasThrough(result.snapshot.revision);
    return result;
  }

  async rewindToHistoryEntryId(
    historyEntryId: string,
  ): Promise<SessionProtocolResultByMethod["session.rewind"]> {
    const result = await this.client.sendRewind(this.activeSessionId(), historyEntryId);
    this.discardBufferedDeltasThrough(result.snapshot.revision);
    return result;
  }

  async terminateSubagent(
    subagentId: string,
  ): Promise<SessionProtocolResultByMethod["session.terminateSubagent"]> {
    return await this.client.sendTerminateSubagent(this.activeSessionId(), subagentId);
  }

  async createEphemeralContext(options: {
    instructions: string;
    tools: SessionProtocolEphemeralAgentTool[];
  }): Promise<SessionProtocolResultByMethod["session.ephemeral.create"]> {
    return await this.client.sendEphemeralCreate(this.activeSessionId(), options);
  }

  async submitEphemeralThread(options: {
    contextId: string;
    threadId: string;
    forkFromThreadId?: string;
    message: string;
  }): Promise<SessionProtocolResultByMethod["session.ephemeral.submit"]> {
    return await this.client.sendEphemeralSubmit(this.activeSessionId(), options);
  }

  async closeEphemeralContext(
    contextId: string,
  ): Promise<SessionProtocolResultByMethod["session.ephemeral.close"]> {
    return await this.client.sendEphemeralClose(this.activeSessionId(), contextId);
  }

  async unobserve(): Promise<SessionProtocolResultByMethod["session.unobserve"]> {
    const result = await this.client.unobserveSession(this.activeSessionId());
    this.disposeLocal();
    return result;
  }

  private handleDelta(delta: Parameters<TauSdkDeltaListener>[0]): void {
    if (this.isUnobserved || delta.sessionId !== this.sessionId) {
      return;
    }

    if (this.initialSnapshot && delta.toRevision > this.initialSnapshot.revision) {
      this.initialSnapshot = undefined;
    }

    if (this.deltaListeners.size === 0) {
      this.bufferedDeltas.push(delta);
      return;
    }

    for (const listener of [...this.deltaListeners]) {
      try {
        listener(delta);
      } catch {
        // SDK delta listeners must not break session event delivery.
      }
    }
  }

  private handleEphemeral(message: Parameters<TauSdkEphemeralListener>[0]): void {
    if (this.isUnobserved || message.sessionId !== this.sessionId) {
      return;
    }

    for (const listener of [...this.ephemeralListeners]) {
      try {
        listener(message);
      } catch {
        // SDK ephemeral listeners must not break event delivery.
      }
    }
  }

  private handlePendingUserMessages(
    message: Parameters<TauSdkPendingUserMessagesListener>[0],
  ): void {
    if (
      this.isUnobserved ||
      message.sessionId !== this.sessionId ||
      (this.pendingUserMessagesValue &&
        message.state.revision <= this.pendingUserMessagesValue.revision)
    ) {
      return;
    }

    this.pendingUserMessagesValue = structuredClone(message.state);
    for (const listener of [...this.pendingUserMessagesListeners]) {
      try {
        listener(message);
      } catch {
        // SDK pending-message listeners must not break event delivery.
      }
    }
  }

  assertSessionId(sessionId: string): void {
    if (sessionId !== this.sessionId) {
      throw new TauSessionClientError(
        `observed session id '${sessionId}' did not match requested session id '${this.sessionId}'`,
      );
    }
  }

  setInitialSnapshot(snapshot: SessionProtocolResultByMethod["session.snapshot"]): void {
    this.initialSnapshot = snapshot;
  }

  setInitialPendingUserMessages(
    state: Parameters<TauSdkPendingUserMessagesListener>[0]["state"],
  ): void {
    if (!this.pendingUserMessagesValue || state.revision > this.pendingUserMessagesValue.revision) {
      this.pendingUserMessagesValue = structuredClone(state);
    }
  }

  discardBufferedDeltasThrough(revision: number): void {
    const retained = this.bufferedDeltas.filter((delta) => delta.toRevision > revision);
    this.bufferedDeltas.splice(0, this.bufferedDeltas.length, ...retained);
  }

  disposeLocal(): void {
    if (this.isUnobserved) {
      return;
    }
    this.isUnobserved = true;
    this.unsubscribeClientDeltas();
    this.unsubscribeClientEphemeral();
    this.unsubscribeClientPendingUserMessages();
    this.deltaListeners.clear();
    this.ephemeralListeners.clear();
    this.pendingUserMessagesListeners.clear();
    this.bufferedDeltas.splice(0);
  }

  private activeSessionId(): string {
    this.assertActive();
    return this.sessionId;
  }

  private assertActive(): void {
    if (this.isUnobserved) {
      throw new TauSessionClientError("tau sdk session is unobserved");
    }
  }
}
