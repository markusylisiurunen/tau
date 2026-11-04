import { randomUUID } from "node:crypto";
import type {
  SessionProtocolClientToolCallMessage,
  SessionProtocolClientToolCancelMessage,
  SessionProtocolCreateParams,
  SessionProtocolEphemeralAgentTool,
  SessionProtocolInitializeParams,
  SessionProtocolPersonaOverrides,
  SessionProtocolReasoningEffort,
  SessionProtocolResultByMethod,
  SessionProtocolSampleParams,
} from "../protocol/session_protocol.js";
import {
  applySessionProtocolSubagentActivitiesMessage,
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
  TauSdkClientToolContext,
  TauSdkClientToolDescribeContext,
  TauSdkClientToolExecutionEnvironment,
  TauSdkDeltaListener,
  TauSdkEphemeralListener,
  TauSdkInitializeParams,
  TauSdkPendingUserMessagesListener,
  TauSdkSession,
  TauSdkSessionClient,
  TauSdkSessionExecOptions,
  TauSdkSessionUserMessageOptions,
  TauSdkSubagentActivitiesListener,
  TauSdkSubagentActivitiesState,
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

type SessionObservation = { sessionId: string; observationId: string };

class TauSdkClientImpl implements TauSdkClient {
  readonly sessions: TauSdkSessionClient;

  private readonly clientToolAbortControllers = new Map<string, AbortController>();
  private readonly clientToolExecutions = new Map<string, Promise<void>>();
  private readonly unsubscribeClientTool: () => void;
  private readonly unsubscribeTransportFailure: () => void;
  private closePromise?: Promise<void>;

  constructor(
    private readonly transport: SessionProtocolTransport,
    private readonly clientTools: TauSdkClientTool[],
  ) {
    this.sessions = new TauSdkSessionClientImpl(this);
    this.unsubscribeClientTool = this.transport.onClientTool((message) =>
      this.handleClientTool(message),
    );
    this.unsubscribeTransportFailure = this.transport.onFailure(() => this.abortClientTools());
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

  subscribeSubagentActivities(listener: TauSdkSubagentActivitiesListener): () => void {
    return this.transport.onSubagentActivities(listener);
  }

  subscribeObservationEnded(
    listener: Parameters<SessionProtocolTransport["onObservationEnded"]>[0],
  ): () => void {
    return this.transport.onObservationEnded(listener);
  }

  createObservedSession(observation: SessionObservation): TauSdkSessionImpl {
    return new TauSdkSessionImpl(this, observation.sessionId, observation.observationId);
  }

  createSession(
    input: SessionProtocolCreateParams,
  ): Promise<SessionProtocolResultByMethod["session.create"]> {
    return this.transport.request("session.create", input);
  }

  listSessions(): Promise<SessionProtocolResultByMethod["session.list"]> {
    return this.transport.request("session.list", {});
  }

  observeSession({
    sessionId,
    observationId,
  }: SessionObservation): Promise<SessionProtocolResultByMethod["session.observe"]> {
    return this.transport.request("session.observe", { sessionId }, observationId);
  }

  unobserveSession({
    sessionId,
    observationId,
  }: SessionObservation): Promise<SessionProtocolResultByMethod["session.unobserve"]> {
    return this.transport.request("session.unobserve", { sessionId }, observationId);
  }

  retainSession({ sessionId, observationId }: SessionObservation, durationMs: number) {
    return this.transport.request("session.retain", { sessionId, durationMs }, observationId);
  }

  runtimeState(sessionId: string) {
    return this.transport.request("session.runtimeState", { sessionId });
  }

  unloadSession(sessionId: string) {
    return this.transport.request("session.unload", { sessionId });
  }

  close(): Promise<void> {
    this.closePromise ??= this.closeClient();
    return this.closePromise;
  }

  private async closeClient(): Promise<void> {
    this.unsubscribeClientTool();
    this.unsubscribeTransportFailure();
    const executions = [...this.clientToolExecutions.values()];
    this.abortClientTools();
    const transportClose = Promise.resolve().then(() => this.transport.close());
    const [transportResult] = await Promise.allSettled([transportClose, ...executions]);
    if (transportResult.status === "rejected") {
      throw transportResult.reason;
    }
  }

  private abortClientTools(): void {
    for (const controller of this.clientToolAbortControllers.values()) {
      controller.abort();
    }
    this.clientToolAbortControllers.clear();
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
    const execution = this.runClientTool(tool, message, abortController)
      .catch(() => undefined)
      .finally(() => {
        this.clientToolAbortControllers.delete(message.callId);
        this.clientToolExecutions.delete(message.callId);
      });
    this.clientToolExecutions.set(message.callId, execution);
  }

  private async runClientTool(
    tool: TauSdkClientTool,
    message: SessionProtocolClientToolCallMessage,
    abortController: AbortController,
  ): Promise<void> {
    const describeContext: TauSdkClientToolDescribeContext = {
      sessionId: message.sessionId,
      agentId: message.agentId,
      callId: message.callId,
      signal: abortController.signal,
    };

    try {
      const presentation = await tool.describe?.(message.arguments, describeContext);
      const ack = await this.transport.request("session.clientTool.ack", {
        sessionId: message.sessionId,
        callId: message.callId,
        ...(presentation === undefined ? {} : { presentation }),
      });
      if (!ack.accepted || abortController.signal.aborted) {
        abortController.abort();
        return;
      }

      const context: TauSdkClientToolContext = {
        ...describeContext,
        executionEnvironment: this.createClientToolExecutionEnvironment(
          { sessionId: message.sessionId, observationId: message.observationId },
          abortController.signal,
        ),
      };
      const result = await tool.execute(message.arguments, context);
      if (abortController.signal.aborted) {
        return;
      }
      if (typeof result !== "string" && result.ok === false) {
        await this.transport.request("session.clientTool.result", {
          sessionId: message.sessionId,
          callId: message.callId,
          ok: false,
          error: result.error,
          ...(result.presentation === undefined ? {} : { presentation: result.presentation }),
        });
        return;
      }
      const content = typeof result === "string" ? result : result.content;
      const terminalPresentation = typeof result === "string" ? undefined : result.presentation;
      await this.transport.request("session.clientTool.result", {
        sessionId: message.sessionId,
        callId: message.callId,
        ok: true,
        content: typeof content === "string" ? [{ type: "text", text: content }] : content,
        ...(terminalPresentation === undefined ? {} : { presentation: terminalPresentation }),
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

  createClientToolExecutionEnvironment(
    observation: SessionObservation,
    toolSignal: AbortSignal,
  ): TauSdkClientToolExecutionEnvironment {
    return {
      exec: (command, options = {}) =>
        this.executeInSession(observation, command, {
          ...options,
          signal: options.signal ? AbortSignal.any([toolSignal, options.signal]) : toolSignal,
        }),
    };
  }

  async executeInSession(
    observation: SessionObservation,
    command: string,
    options: TauSdkSessionExecOptions = {},
  ): Promise<SessionProtocolResultByMethod["session.exec"]> {
    const { signal, stdin, ...execOptions } = options;
    const execId = randomUUID();
    return await this.runExecRequest(observation, execId, signal, () =>
      this.sendExec(observation, execId, command, {
        ...execOptions,
        ...(stdin !== undefined ? { stdinBase64: stdin.toString("base64") } : {}),
      }),
    );
  }

  sendSubmit(
    observation: SessionObservation,
    text: string,
    options: TauSdkSessionUserMessageOptions,
  ): Promise<SessionProtocolResultByMethod["session.submit"]> {
    return this.transport.request(
      "session.submit",
      {
        sessionId: observation.sessionId,
        text,
        ...(options.historyEntryId === undefined ? {} : { historyEntryId: options.historyEntryId }),
      },
      observation.observationId,
    );
  }

  sendQueue(
    observation: SessionObservation,
    text: string,
    options: TauSdkSessionUserMessageOptions,
  ): Promise<SessionProtocolResultByMethod["session.queue"]> {
    return this.transport.request(
      "session.queue",
      {
        sessionId: observation.sessionId,
        text,
        ...(options.historyEntryId === undefined ? {} : { historyEntryId: options.historyEntryId }),
      },
      observation.observationId,
    );
  }

  sendSteer(
    observation: SessionObservation,
    text: string,
  ): Promise<SessionProtocolResultByMethod["session.steer"]> {
    return this.transport.request(
      "session.steer",
      { sessionId: observation.sessionId, text },
      observation.observationId,
    );
  }

  sendCancelPendingMessages(
    observation: SessionObservation,
  ): Promise<SessionProtocolResultByMethod["session.cancelPendingMessages"]> {
    return this.transport.request(
      "session.cancelPendingMessages",
      { sessionId: observation.sessionId },
      observation.observationId,
    );
  }

  sendRecord(
    observation: SessionObservation,
    text: string,
    options: TauSdkSessionUserMessageOptions,
  ): Promise<SessionProtocolResultByMethod["session.record"]> {
    return this.transport.request(
      "session.record",
      {
        sessionId: observation.sessionId,
        text,
        ...(options.historyEntryId === undefined ? {} : { historyEntryId: options.historyEntryId }),
      },
      observation.observationId,
    );
  }

  sendRetry(
    observation: SessionObservation,
  ): Promise<SessionProtocolResultByMethod["session.retry"]> {
    return this.transport.request(
      "session.retry",
      { sessionId: observation.sessionId },
      observation.observationId,
    );
  }

  sendExec(
    observation: SessionObservation,
    execId: string,
    command: string,
    options: {
      args?: string[];
      env?: Record<string, string>;
      stdinBase64?: string;
      cwd?: string;
      timeoutMs?: number;
      maxCaptureBytes?: number;
    } = {},
  ): Promise<SessionProtocolResultByMethod["session.exec"]> {
    return this.transport.request(
      "session.exec",
      {
        sessionId: observation.sessionId,
        execId,
        command,
        ...(options.args !== undefined ? { args: options.args } : {}),
        ...(options.env !== undefined ? { env: options.env } : {}),
        ...(options.stdinBase64 !== undefined ? { stdinBase64: options.stdinBase64 } : {}),
        ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
        ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
        ...(options.maxCaptureBytes !== undefined
          ? { maxCaptureBytes: options.maxCaptureBytes }
          : {}),
      },
      observation.observationId,
    );
  }

  sendCancelExec(
    observation: SessionObservation,
    execId: string,
  ): Promise<SessionProtocolResultByMethod["session.cancelExec"]> {
    return this.transport.request(
      "session.cancelExec",
      { sessionId: observation.sessionId, execId },
      observation.observationId,
    );
  }

  private async runExecRequest<T>(
    observation: SessionObservation,
    execId: string,
    signal: AbortSignal | undefined,
    request: () => Promise<T>,
  ): Promise<T> {
    signal?.throwIfAborted();
    if (!signal) {
      return await request();
    }

    return await new Promise<T>((resolve, reject) => {
      let settled = false;
      const finish = (callback: () => void) => {
        if (settled) return;
        settled = true;
        signal.removeEventListener("abort", onAbort);
        callback();
      };
      const onAbort = () => {
        void this.sendCancelExec(observation, execId).catch(() => {});
        finish(() => reject(signal.reason));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      let pending: Promise<T>;
      try {
        pending = request();
      } catch (error) {
        finish(() => reject(error));
        return;
      }
      void pending.then(
        (result) => finish(() => resolve(result)),
        (error) => finish(() => reject(error)),
      );
      if (signal.aborted) {
        onAbort();
      }
    });
  }

  sendSample(
    observation: SessionObservation,
    input: Omit<SessionProtocolSampleParams, "sessionId">,
  ): Promise<SessionProtocolResultByMethod["session.sample"]> {
    return this.transport.request(
      "session.sample",
      { sessionId: observation.sessionId, ...input },
      observation.observationId,
    );
  }

  sendInterrupt(
    observation: SessionObservation,
  ): Promise<SessionProtocolResultByMethod["session.interrupt"]> {
    return this.transport.request(
      "session.interrupt",
      { sessionId: observation.sessionId },
      observation.observationId,
    );
  }

  sendSnapshot(
    observation: SessionObservation,
  ): Promise<SessionProtocolResultByMethod["session.snapshot"]> {
    return this.transport.request(
      "session.snapshot",
      { sessionId: observation.sessionId },
      observation.observationId,
    );
  }

  sendSetAutoCompactThreshold(
    observation: SessionObservation,
    thresholdTokens: number | null,
  ): Promise<SessionProtocolResultByMethod["session.setAutoCompactThreshold"]> {
    return this.transport.request(
      "session.setAutoCompactThreshold",
      {
        sessionId: observation.sessionId,
        thresholdTokens,
      },
      observation.observationId,
    );
  }

  sendSetReasoning(
    observation: SessionObservation,
    reasoning: "none" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max",
  ): Promise<SessionProtocolResultByMethod["session.setReasoning"]> {
    return this.transport.request(
      "session.setReasoning",
      {
        sessionId: observation.sessionId,
        reasoning,
      },
      observation.observationId,
    );
  }

  sendSetPersona(
    observation: SessionObservation,
    personaId: string | null,
    overrides?: SessionProtocolPersonaOverrides,
  ): Promise<SessionProtocolResultByMethod["session.setPersona"]> {
    return this.transport.request(
      "session.setPersona",
      {
        sessionId: observation.sessionId,
        personaId,
        ...overrides,
      },
      observation.observationId,
    );
  }

  sendResolvePrompt(
    observation: SessionObservation,
    promptId: string,
  ): Promise<SessionProtocolResultByMethod["session.resolvePrompt"]> {
    return this.transport.request(
      "session.resolvePrompt",
      {
        sessionId: observation.sessionId,
        promptId,
      },
      observation.observationId,
    );
  }

  sendAutocompletePaths(
    observation: SessionObservation,
    options: { query: string; limit: number },
  ): Promise<SessionProtocolResultByMethod["session.autocompletePaths"]> {
    return this.transport.request(
      "session.autocompletePaths",
      {
        sessionId: observation.sessionId,
        query: options.query,
        limit: options.limit,
      },
      observation.observationId,
    );
  }

  sendReload(
    observation: SessionObservation,
  ): Promise<SessionProtocolResultByMethod["session.reload"]> {
    return this.transport.request(
      "session.reload",
      { sessionId: observation.sessionId },
      observation.observationId,
    );
  }

  sendCompact(
    observation: SessionObservation,
    mode: "summary-only" | "summary-and-last",
    options: { guidance?: string },
  ): Promise<SessionProtocolResultByMethod["session.compact"]> {
    return this.transport.request(
      "session.compact",
      {
        sessionId: observation.sessionId,
        mode,
        ...(options.guidance !== undefined ? { guidance: options.guidance } : {}),
      },
      observation.observationId,
    );
  }

  sendRewind(
    observation: SessionObservation,
    historyEntryId: string,
  ): Promise<SessionProtocolResultByMethod["session.rewind"]> {
    return this.transport.request(
      "session.rewind",
      {
        sessionId: observation.sessionId,
        historyEntryId,
      },
      observation.observationId,
    );
  }

  sendInterruptSubagent(
    observation: SessionObservation,
    subagentId: string,
  ): Promise<SessionProtocolResultByMethod["session.interruptSubagent"]> {
    return this.transport.request(
      "session.interruptSubagent",
      {
        sessionId: observation.sessionId,
        subagentId,
      },
      observation.observationId,
    );
  }

  sendEphemeralCreate(
    observation: SessionObservation,
    options: {
      instructions: string;
      tools: SessionProtocolEphemeralAgentTool[];
      reasoning?: SessionProtocolReasoningEffort;
    },
  ): Promise<SessionProtocolResultByMethod["session.ephemeral.create"]> {
    return this.transport.request(
      "session.ephemeral.create",
      {
        sessionId: observation.sessionId,
        instructions: options.instructions,
        tools: options.tools,
        ...(options.reasoning !== undefined ? { reasoning: options.reasoning } : {}),
      },
      observation.observationId,
    );
  }

  sendEphemeralSubmit(
    observation: SessionObservation,
    options: {
      contextId: string;
      threadId: string;
      forkFromThreadId?: string;
      message: string;
      reasoning?: SessionProtocolReasoningEffort;
    },
  ): Promise<SessionProtocolResultByMethod["session.ephemeral.submit"]> {
    return this.transport.request(
      "session.ephemeral.submit",
      {
        sessionId: observation.sessionId,
        contextId: options.contextId,
        threadId: options.threadId,
        ...(options.forkFromThreadId !== undefined
          ? { forkFromThreadId: options.forkFromThreadId }
          : {}),
        message: options.message,
        ...(options.reasoning !== undefined ? { reasoning: options.reasoning } : {}),
      },
      observation.observationId,
    );
  }

  sendEphemeralClose(
    observation: SessionObservation,
    contextId: string,
  ): Promise<SessionProtocolResultByMethod["session.ephemeral.close"]> {
    return this.transport.request(
      "session.ephemeral.close",
      {
        sessionId: observation.sessionId,
        contextId,
      },
      observation.observationId,
    );
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

  async runtimeState(sessionId: string) {
    return await this.client.runtimeState(sessionId);
  }

  async unload(sessionId: string) {
    return await this.client.unloadSession(sessionId);
  }

  async observe(sessionId: string): Promise<TauSdkSession> {
    const observation = { sessionId, observationId: randomUUID() };
    const session = this.client.createObservedSession(observation);
    try {
      const initialState = await this.client.observeSession(observation);
      session.assertSessionId(initialState.snapshot.sessionId);
      session.setInitialSnapshot(initialState.snapshot);
      session.setInitialPendingUserMessages(initialState.pendingUserMessages);
      session.setInitialSubagentActivities(initialState.subagentActivities);
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
  private readonly subagentActivitiesListeners = new Set<TauSdkSubagentActivitiesListener>();
  private readonly bufferedDeltas: Parameters<TauSdkDeltaListener>[0][] = [];
  private readonly bufferedSubagentActivities: Parameters<TauSdkSubagentActivitiesListener>[0][] =
    [];
  private readonly unsubscribeObservationEnded: () => void;
  private readonly unsubscribeClientDeltas: () => void;
  private readonly unsubscribeClientEphemeral: () => void;
  private readonly unsubscribeClientPendingUserMessages: () => void;
  private readonly unsubscribeClientSubagentActivities: () => void;
  private initialSnapshot?: SessionProtocolResultByMethod["session.snapshot"];
  private pendingUserMessagesValue?: Parameters<TauSdkPendingUserMessagesListener>[0]["state"];
  private subagentActivitiesValue?: TauSdkSubagentActivitiesState;

  constructor(
    private readonly client: TauSdkClientImpl,
    private sessionId: string,
    private readonly observationId: string,
  ) {
    this.unsubscribeObservationEnded = this.client.subscribeObservationEnded((message) => {
      if (message.sessionId === this.sessionId && message.observationId === this.observationId)
        this.disposeLocal();
    });
    this.unsubscribeClientDeltas = this.client.subscribe((delta) => this.handleDelta(delta));
    this.unsubscribeClientEphemeral = this.client.subscribeEphemeral((message) =>
      this.handleEphemeral(message),
    );
    this.unsubscribeClientPendingUserMessages = this.client.subscribePendingUserMessages(
      (message) => this.handlePendingUserMessages(message),
    );
    this.unsubscribeClientSubagentActivities = this.client.subscribeSubagentActivities((message) =>
      this.handleSubagentActivities(message),
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

  subagentActivities(): TauSdkSubagentActivitiesState {
    this.assertActive();
    if (!this.subagentActivitiesValue) {
      throw new TauSessionClientError("tau sdk subagent activities are not initialized");
    }
    return structuredClone(this.subagentActivitiesValue);
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
          observationId: this.observationId,
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

  onSubagentActivities(listener: TauSdkSubagentActivitiesListener): () => void {
    this.assertActive();
    this.subagentActivitiesListeners.add(listener);
    if (this.subagentActivitiesValue) {
      try {
        listener({
          version: SESSION_PROTOCOL_VERSION,
          type: "session.subagentActivities",
          observationId: this.observationId,
          sessionId: this.sessionId,
          revision: this.subagentActivitiesValue.revision,
          changes: Object.entries(this.subagentActivitiesValue.agents).map(([agentId, state]) => ({
            type: "agent.set",
            agentId,
            state: structuredClone(state),
          })),
        });
      } catch {
        // SDK subagent-activity listeners must not break session event delivery.
      }
    }
    return () => {
      this.subagentActivitiesListeners.delete(listener);
    };
  }

  async submit(
    text: string,
    options: TauSdkSessionUserMessageOptions = {},
  ): Promise<SessionProtocolResultByMethod["session.submit"]> {
    return await this.client.sendSubmit(this.activeObservation(), text, options);
  }

  async record(
    text: string,
    options: TauSdkSessionUserMessageOptions = {},
  ): Promise<SessionProtocolResultByMethod["session.record"]> {
    return await this.client.sendRecord(this.activeObservation(), text, options);
  }

  async queue(
    text: string,
    options: TauSdkSessionUserMessageOptions = {},
  ): Promise<SessionProtocolResultByMethod["session.queue"]> {
    return await this.client.sendQueue(this.activeObservation(), text, options);
  }

  async steer(text: string): Promise<SessionProtocolResultByMethod["session.steer"]> {
    return await this.client.sendSteer(this.activeObservation(), text);
  }

  async cancelPendingMessages(): Promise<
    SessionProtocolResultByMethod["session.cancelPendingMessages"]
  > {
    return await this.client.sendCancelPendingMessages(this.activeObservation());
  }

  async retry(): Promise<SessionProtocolResultByMethod["session.retry"]> {
    return await this.client.sendRetry(this.activeObservation());
  }

  async exec(
    command: string,
    options: TauSdkSessionExecOptions = {},
  ): Promise<SessionProtocolResultByMethod["session.exec"]> {
    return await this.client.executeInSession(this.activeObservation(), command, options);
  }

  async sample(
    input: Omit<SessionProtocolSampleParams, "sessionId">,
  ): Promise<SessionProtocolResultByMethod["session.sample"]> {
    return await this.client.sendSample(this.activeObservation(), input);
  }

  async interrupt(): Promise<SessionProtocolResultByMethod["session.interrupt"]> {
    return await this.client.sendInterrupt(this.activeObservation());
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

    const snapshot = await this.client.sendSnapshot(this.activeObservation());
    this.discardBufferedDeltasThrough(snapshot.revision);
    return snapshot;
  }

  async setAutoCompactThreshold(
    thresholdTokens: number | null,
  ): Promise<SessionProtocolResultByMethod["session.setAutoCompactThreshold"]> {
    const snapshot = await this.client.sendSetAutoCompactThreshold(
      this.activeObservation(),
      thresholdTokens,
    );
    this.discardBufferedDeltasThrough(snapshot.revision);
    return snapshot;
  }

  async setReasoning(
    reasoning: SessionProtocolReasoningEffort,
  ): Promise<SessionProtocolResultByMethod["session.setReasoning"]> {
    const snapshot = await this.client.sendSetReasoning(this.activeObservation(), reasoning);
    this.discardBufferedDeltasThrough(snapshot.revision);
    return snapshot;
  }

  async setPersona(
    personaId: string | null,
    overrides?: SessionProtocolPersonaOverrides,
  ): Promise<SessionProtocolResultByMethod["session.setPersona"]> {
    const snapshot = await this.client.sendSetPersona(
      this.activeObservation(),
      personaId,
      overrides,
    );
    this.discardBufferedDeltasThrough(snapshot.revision);
    return snapshot;
  }

  async resolvePrompt(
    promptId: string,
  ): Promise<SessionProtocolResultByMethod["session.resolvePrompt"]> {
    return await this.client.sendResolvePrompt(this.activeObservation(), promptId);
  }

  async autocompletePaths(options: {
    query: string;
    limit: number;
  }): Promise<SessionProtocolResultByMethod["session.autocompletePaths"]> {
    return await this.client.sendAutocompletePaths(this.activeObservation(), options);
  }

  async reload(): Promise<SessionProtocolResultByMethod["session.reload"]> {
    const result = await this.client.sendReload(this.activeObservation());
    this.discardBufferedDeltasThrough(result.snapshot.revision);
    return result;
  }

  async compact(
    mode: "summary-only" | "summary-and-last",
    options: { guidance?: string } = {},
  ): Promise<SessionProtocolResultByMethod["session.compact"]> {
    const result = await this.client.sendCompact(this.activeObservation(), mode, options);
    this.discardBufferedDeltasThrough(result.snapshot.revision);
    return result;
  }

  async rewindToHistoryEntryId(
    historyEntryId: string,
  ): Promise<SessionProtocolResultByMethod["session.rewind"]> {
    const result = await this.client.sendRewind(this.activeObservation(), historyEntryId);
    this.discardBufferedDeltasThrough(result.snapshot.revision);
    return result;
  }

  async interruptSubagent(
    subagentId: string,
  ): Promise<SessionProtocolResultByMethod["session.interruptSubagent"]> {
    return await this.client.sendInterruptSubagent(this.activeObservation(), subagentId);
  }

  async createEphemeralContext(options: {
    workingDirectory?: string;
    instructions: string;
    tools: SessionProtocolEphemeralAgentTool[];
    reasoning?: SessionProtocolReasoningEffort;
  }): Promise<SessionProtocolResultByMethod["session.ephemeral.create"]> {
    return await this.client.sendEphemeralCreate(this.activeObservation(), options);
  }

  async submitEphemeralThread(options: {
    contextId: string;
    threadId: string;
    forkFromThreadId?: string;
    message: string;
    reasoning?: SessionProtocolReasoningEffort;
  }): Promise<SessionProtocolResultByMethod["session.ephemeral.submit"]> {
    return await this.client.sendEphemeralSubmit(this.activeObservation(), options);
  }

  async closeEphemeralContext(
    contextId: string,
  ): Promise<SessionProtocolResultByMethod["session.ephemeral.close"]> {
    return await this.client.sendEphemeralClose(this.activeObservation(), contextId);
  }

  async retain(durationMs: number) {
    return await this.client.retainSession(this.activeObservation(), durationMs);
  }

  async unobserve(): Promise<SessionProtocolResultByMethod["session.unobserve"]> {
    if (this.isUnobserved) return { unobserved: true };
    try {
      return await this.client.unobserveSession(this.activeObservation());
    } finally {
      this.disposeLocal();
    }
  }

  private handleDelta(delta: Parameters<TauSdkDeltaListener>[0]): void {
    if (
      this.isUnobserved ||
      delta.sessionId !== this.sessionId ||
      delta.observationId !== this.observationId
    ) {
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
    if (
      this.isUnobserved ||
      message.sessionId !== this.sessionId ||
      message.observationId !== this.observationId
    ) {
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
      message.observationId !== this.observationId ||
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

  private handleSubagentActivities(message: Parameters<TauSdkSubagentActivitiesListener>[0]): void {
    if (
      this.isUnobserved ||
      message.sessionId !== this.sessionId ||
      message.observationId !== this.observationId
    ) {
      return;
    }
    if (!this.subagentActivitiesValue) {
      this.bufferedSubagentActivities.push(structuredClone(message));
      return;
    }
    if (message.revision <= this.subagentActivitiesValue.revision) {
      return;
    }

    this.subagentActivitiesValue = applySessionProtocolSubagentActivitiesMessage(
      this.subagentActivitiesValue,
      message,
    );
    for (const listener of [...this.subagentActivitiesListeners]) {
      try {
        listener(message);
      } catch {
        // SDK subagent-activity listeners must not break session event delivery.
      }
    }
  }

  assertSessionId(sessionId: string): void {
    this.assertActive();
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

  setInitialSubagentActivities(state: TauSdkSubagentActivitiesState): void {
    this.subagentActivitiesValue = structuredClone(state);
    for (const message of this.bufferedSubagentActivities.splice(0)) {
      this.handleSubagentActivities(message);
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
    this.unsubscribeObservationEnded();
    this.unsubscribeClientDeltas();
    this.unsubscribeClientEphemeral();
    this.unsubscribeClientPendingUserMessages();
    this.unsubscribeClientSubagentActivities();
    this.deltaListeners.clear();
    this.ephemeralListeners.clear();
    this.pendingUserMessagesListeners.clear();
    this.subagentActivitiesListeners.clear();
    this.bufferedDeltas.splice(0);
    this.bufferedSubagentActivities.splice(0);
  }

  private activeObservation(): SessionObservation {
    this.assertActive();
    return { sessionId: this.sessionId, observationId: this.observationId };
  }

  private assertActive(): void {
    if (this.isUnobserved) {
      throw new TauSessionClientError("tau sdk session is unobserved");
    }
  }
}
