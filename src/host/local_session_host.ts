import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { Api, AssistantMessage, Message, Model, ToolCall } from "@earendil-works/pi-ai";
import type { AgentStateRecovery, AgentTurnResult } from "../core/agent/agent_runtime.js";
import type { AgentEvent } from "../core/agent/events.js";
import { type Config, resolvePromptTemplateWithBackend } from "../core/config/index.js";
import type { ModelResolver } from "../core/models/catalog.js";
import type { PromptTemplate } from "../core/prompts.js";
import { ChatRuntime, type ChatRuntimeEnvironment } from "../core/runtime/chat_runtime.js";
import type { CoreDeps } from "../core/runtime/deps.js";
import type { RuntimePromptBootstrap } from "../core/runtime/runtime_bootstrap.js";
import type { SessionPromptComposition } from "../core/runtime/session_prompt_composer.js";
import type { SubagentUiEvent } from "../core/subagents/types.js";
import type { ToolUiEvent } from "../core/tools/registry.js";
import type { Persona, ReasoningEffort, Skill } from "../core/types.js";
import {
  appendUsageLogEntry,
  getUsageCostTotal,
  getUsageTotals,
  type UsageRecorder,
} from "../core/usage/logs.js";
import {
  filterProjectPathAutocompleteEntries,
  loadProjectPathAutocompleteEntriesWithBackend,
} from "../core/utils/project_files.js";
import {
  hasAutoCompactionContinuationMetadata,
  isTauUserMessageHidden,
} from "../core/utils/user_metadata.js";
import type {
  ExecutionEnvironment,
  ExecutionEnvironmentResolver,
} from "../execution/execution_environment.js";
import type {
  SessionProtocolAgentRun,
  SessionProtocolAutocompletePathsParams,
  SessionProtocolAutocompletePathsResult,
  SessionProtocolChange,
  SessionProtocolCompactParams,
  SessionProtocolCompactResult,
  SessionProtocolContentCatalogSnapshot,
  SessionProtocolCreateParams,
  SessionProtocolDeltaMessage,
  SessionProtocolDeltaReason,
  SessionProtocolDraftAssistantMessage,
  SessionProtocolEphemeralCloseResult,
  SessionProtocolEphemeralCreateParams,
  SessionProtocolEphemeralCreateResult,
  SessionProtocolEphemeralMessage,
  SessionProtocolEphemeralSubmitParams,
  SessionProtocolEphemeralSubmitResult,
  SessionProtocolExecParams,
  SessionProtocolExecResult,
  SessionProtocolFacet,
  SessionProtocolMessage,
  SessionProtocolModelSnapshot,
  SessionProtocolPersonaSnapshot,
  SessionProtocolRecordParams,
  SessionProtocolRecordResult,
  SessionProtocolReloadResult,
  SessionProtocolResolvePromptParams,
  SessionProtocolResolvePromptResult,
  SessionProtocolRewindResult,
  SessionProtocolSampleParams,
  SessionProtocolSampleResult,
  SessionProtocolSessionSummary,
  SessionProtocolSettingsUpdateResult,
  SessionProtocolSnapshot,
  SessionProtocolSubagentSnapshot,
  SessionProtocolTerminateSubagentResult,
  SessionProtocolTimelineItem,
  SessionProtocolToolRun,
  SessionProtocolTurnOutcome,
} from "../protocol/session_protocol.js";
import {
  applySessionProtocolDelta,
  createSessionProtocolDeltaMessage,
  createSessionProtocolEphemeralMessage,
} from "../protocol/session_protocol.js";
import type { SessionStore } from "../store/session_store.js";
import { ClientToolBroker } from "./client_tool_broker.js";
import { createExecutionEnvironmentSubagentRuntimeResolver } from "./execution_runtime.js";
import { HostedEphemeralAgentSession } from "./hosted_ephemeral_agent_session.js";
import {
  SessionExecBusyError,
  type TauHostedSession,
  type TauSessionHost,
} from "./session_host.js";

const PATH_AUTOCOMPLETE_CACHE_TTL_MS = 5_000;

export type LocalSessionResolvedBootstrap = {
  persona: Persona;
  discoveredSkills: Skill[];
  personas: Persona[];
  prompts: PromptTemplate[];
  modelResolver: ModelResolver;
  config?: Config;
};

export type LocalSessionBootstrapResolver = (args: {
  executionEnvironment: ExecutionEnvironment;
}) => Promise<LocalSessionResolvedBootstrap>;

export type LocalSessionHostSessionOptions = {
  executionEnvironmentResolver: ExecutionEnvironmentResolver;
  includeAgentContext: boolean;
  environment: ChatRuntimeEnvironment;
  recordUsage?: UsageRecorder;
  deps?: CoreDeps;
} & (
  | {
      defaultBootstrap: LocalSessionResolvedBootstrap;
      resolveSessionBootstrap?: LocalSessionBootstrapResolver;
    }
  | {
      defaultBootstrap?: LocalSessionResolvedBootstrap;
      resolveSessionBootstrap: LocalSessionBootstrapResolver;
    }
);

export type LocalSessionHostOptions = LocalSessionHostSessionOptions & {
  store: SessionStore;
};

export type LocalHostedSession = TauHostedSession & {
  runtime: ChatRuntime;
  session: ChatRuntime;
  promptBootstrap: RuntimePromptBootstrap;
};

export class LocalSessionHost implements TauSessionHost {
  private readonly sessions = new Set<LocalHostedSessionHandle>();
  private readonly sessionRecoveryPromises = new Map<
    string,
    Promise<LocalHostedSession | undefined>
  >();
  private readonly store: SessionStore;
  private readonly clientToolBroker = new ClientToolBroker();
  private readonly sessionOptions: LocalSessionHostSessionOptions;
  private shutdownPromise?: Promise<void>;
  private shuttingDown = false;

  constructor(options: LocalSessionHostOptions) {
    const { store, ...sessionOptions } = options;
    this.store = store;
    this.sessionOptions = sessionOptions;
  }

  registerClientTools(options: Parameters<NonNullable<TauSessionHost["registerClientTools"]>>[0]) {
    return this.clientToolBroker.registerClient(options);
  }

  acknowledgeClientToolCall(sessionId: string, callId: string): boolean {
    return this.clientToolBroker.ack(sessionId, callId);
  }

  completeClientToolCall(
    sessionId: string,
    callId: string,
    result: { ok: true; content: string } | { ok: false; error: string },
  ): boolean {
    return this.clientToolBroker.result(sessionId, callId, result);
  }

  async createSession(input: SessionProtocolCreateParams): Promise<LocalHostedSession> {
    this.assertHostActive();
    const executionEnvironment = await this.sessionOptions.executionEnvironmentResolver.resolve(
      input.executionEnvironment,
    );
    if (this.shuttingDown) {
      await executionEnvironment.dispose();
      throw new Error("local session host is shut down");
    }

    let hostedSession: LocalHostedSessionHandle;
    try {
      hostedSession = await this.createLocalSessionHandle(executionEnvironment, undefined, input);
    } catch (error) {
      if (!this.sessionsHasExecutionEnvironment(executionEnvironment)) {
        await executionEnvironment.dispose();
      }
      throw error;
    }

    if (this.shuttingDown) {
      await hostedSession.dispose();
      this.sessions.delete(hostedSession);
      throw new Error("local session host is shut down");
    }

    return hostedSession;
  }

  private async createRecoveredSession(
    snapshot: SessionProtocolSnapshot,
    executionEnvironment: ExecutionEnvironment,
  ): Promise<LocalHostedSession> {
    let hostedSession: LocalHostedSessionHandle | undefined;
    try {
      const recovered = normalizeRecoveredSnapshot(snapshot);
      hostedSession = await this.createLocalSessionHandle(
        executionEnvironment,
        recovered.snapshot,
        undefined,
        recovered.changed,
      );
      const agentRecovery = hostedSession.runtime.restoreState({
        agentId: recovered.snapshot.sessionId,
        revision: recovered.snapshot.agentState.revision,
        contextEpoch: recovered.snapshot.agentState.contextEpoch,
        historyEntries: recovered.snapshot.messages.flatMap((entry) =>
          entry.modelVisible && isCoreMessage(entry.message)
            ? [{ id: entry.id, message: entry.message }]
            : [],
        ),
        ...(recovered.snapshot.agentState.usageCheckpoint
          ? { usageCheckpoint: { ...recovered.snapshot.agentState.usageCheckpoint } }
          : {}),
      });
      if (agentRecovery.recoveredToolResults.length > 0) {
        await hostedSession.persistRecoveredAgentState(agentRecovery);
      }
      return hostedSession;
    } catch (error) {
      if (hostedSession) {
        await hostedSession.dispose();
      } else {
        await executionEnvironment.dispose();
      }
      throw error;
    }
  }

  private async createLocalSessionHandle(
    executionEnvironment: ExecutionEnvironment,
    committedSnapshot?: SessionProtocolSnapshot,
    createParams?: SessionProtocolCreateParams,
    forceNextSnapshotRevision = false,
  ): Promise<LocalHostedSessionHandle> {
    const bootstrap = await this.resolveNewSessionBootstrap(executionEnvironment);
    if (committedSnapshot) {
      this.applySnapshotSettingsToBootstrap(bootstrap, committedSnapshot);
    } else if (createParams) {
      this.applyCreateParamsToBootstrap(bootstrap, createParams);
    }
    const runtimeContext = await executionEnvironment.resolveRuntimeContext({
      cwd: executionEnvironment.snapshot().cwd,
      persona: bootstrap.persona,
      discoveredSkills: bootstrap.discoveredSkills,
      includeAgentContext: this.sessionOptions.includeAgentContext,
      agentContextFiles: bootstrap.config?.agentContextFiles ?? [],
    });
    const catalog = createContentCatalogSnapshot(bootstrap);
    return this.createLocalSessionHandleFromRuntimeContext(
      executionEnvironment,
      runtimeContext,
      bootstrap,
      catalog,
      committedSnapshot,
      forceNextSnapshotRevision,
    );
  }

  private createLocalSessionHandleFromRuntimeContext(
    executionEnvironment: ExecutionEnvironment,
    runtimeContext: Awaited<ReturnType<ExecutionEnvironment["resolveRuntimeContext"]>>,
    bootstrap: LocalSessionResolvedBootstrap,
    catalog: SessionProtocolContentCatalogSnapshot,
    committedSnapshot?: SessionProtocolSnapshot,
    forceNextSnapshotRevision = false,
  ): LocalHostedSessionHandle {
    let hostedSession: LocalHostedSessionHandle;
    const runtime = ChatRuntime.create({
      persona: bootstrap.persona,
      backend: executionEnvironment.getToolExecutionBackend(),
      clientTools: (sessionId) => this.clientToolBroker.getToolDefinitions(sessionId),
      modelResolver: bootstrap.modelResolver,
      resolveSubagentRuntime: createExecutionEnvironmentSubagentRuntimeResolver({
        executionEnvironment,
        includeAgentContext: this.sessionOptions.includeAgentContext,
        now: this.sessionOptions.environment.now,
      }),
      promptContext: runtimeContext.promptBootstrap.promptContext,
      environment: this.sessionOptions.environment,
      eventSink: async (event) => await hostedSession.enqueueRuntimeEvent(event),
      subagentEventSink: async (event) => await hostedSession.recordSubagentEvent(event),
      initialPromptComposition: committedSnapshot
        ? promptCompositionFromSnapshot(committedSnapshot)
        : undefined,
      config: bootstrap.config ?? {},
      recordUsage: this.sessionOptions.recordUsage,
      deps: this.sessionOptions.deps,
    });

    hostedSession = new LocalHostedSessionHandle(
      runtime,
      runtimeContext.promptBootstrap,
      catalog,
      bootstrap,
      this.sessionOptions.includeAgentContext,
      executionEnvironment,
      this.store,
      committedSnapshot,
      forceNextSnapshotRevision,
      this.sessionOptions.recordUsage ?? appendUsageLogEntry,
      (session) => this.sessions.delete(session),
    );
    this.sessions.add(hostedSession);
    return hostedSession;
  }

  private async resolveNewSessionBootstrap(
    executionEnvironment: ExecutionEnvironment,
  ): Promise<LocalSessionResolvedBootstrap> {
    const resolver = this.sessionOptions.resolveSessionBootstrap;
    if (!resolver) {
      return this.defaultSessionBootstrap();
    }

    const bootstrap = await resolver({ executionEnvironment });
    return cloneResolvedBootstrap(bootstrap);
  }

  private applySnapshotSettingsToBootstrap(
    bootstrap: LocalSessionResolvedBootstrap,
    snapshot: SessionProtocolSnapshot,
  ): LocalSessionResolvedBootstrap {
    const requested = snapshot.settings.personaId.toLowerCase();
    const persona =
      bootstrap.personas.find((candidate) => candidate.id.toLowerCase() === requested) ??
      bootstrap.persona;
    bootstrap.persona = clonePersona(persona);
    if (snapshot.settings.reasoning !== undefined) {
      bootstrap.persona.settings.reasoning = snapshot.settings.reasoning;
    }
    if (snapshot.settings.serviceTier !== undefined) {
      bootstrap.persona.settings.serviceTier = snapshot.settings.serviceTier;
    }
    return bootstrap;
  }

  private applyCreateParamsToBootstrap(
    bootstrap: LocalSessionResolvedBootstrap,
    createParams: SessionProtocolCreateParams,
  ): void {
    if (createParams.personaId !== undefined) {
      const requested = createParams.personaId.toLowerCase();
      const persona = bootstrap.personas.find(
        (candidate) => candidate.id.toLowerCase() === requested,
      );
      if (!persona) {
        throw new Error(`unknown persona '${createParams.personaId}'`);
      }
      bootstrap.persona = clonePersona(persona);
    }

    if (createParams.reasoning !== undefined) {
      bootstrap.persona.settings.reasoning = createParams.reasoning;
    }
  }

  private defaultSessionBootstrap(): LocalSessionResolvedBootstrap {
    const bootstrap = this.sessionOptions.defaultBootstrap;
    if (!bootstrap) {
      throw new Error("local session host has no default session bootstrap");
    }
    return cloneResolvedBootstrap(bootstrap);
  }

  async observeSession(sessionId: string): Promise<LocalHostedSession | undefined> {
    this.assertHostActive();
    const liveSession = this.findLiveSession(sessionId);
    if (liveSession) {
      return liveSession;
    }

    await this.refreshStore();
    const refreshedLiveSession = this.findLiveSession(sessionId);
    if (refreshedLiveSession) {
      return refreshedLiveSession;
    }

    const existingRecovery = this.sessionRecoveryPromises.get(sessionId);
    if (existingRecovery) {
      return await existingRecovery;
    }

    const recovery = this.recoverSession(sessionId);
    this.sessionRecoveryPromises.set(sessionId, recovery);
    try {
      return await recovery;
    } finally {
      if (this.sessionRecoveryPromises.get(sessionId) === recovery) {
        this.sessionRecoveryPromises.delete(sessionId);
      }
    }
  }

  private async recoverSession(sessionId: string): Promise<LocalHostedSession | undefined> {
    if (this.shuttingDown) {
      return undefined;
    }

    const liveSession = this.findLiveSession(sessionId);
    if (liveSession) {
      return liveSession;
    }

    const snapshot = await this.store.loadSession(sessionId);
    if (!snapshot || !this.canRestoreSnapshot(snapshot)) {
      return undefined;
    }

    const executionEnvironment = await this.sessionOptions.executionEnvironmentResolver.restore(
      snapshot.executionEnvironment,
    );

    if (this.shuttingDown) {
      await executionEnvironment.dispose();
      return undefined;
    }

    const restoredLiveSession = this.findLiveSession(sessionId);
    if (restoredLiveSession) {
      await executionEnvironment.dispose();
      return restoredLiveSession;
    }

    return await this.createRecoveredSession(snapshot, executionEnvironment);
  }

  private canRestoreSnapshot(snapshot: SessionProtocolSnapshot): boolean {
    return this.sessionOptions.executionEnvironmentResolver.canRestore(
      snapshot.executionEnvironment,
    );
  }

  private findLiveSession(sessionId: string): LocalHostedSessionHandle | undefined {
    for (const session of this.sessions) {
      if (session.sessionId === sessionId) {
        return session;
      }
    }
    return undefined;
  }

  async listSessions(): Promise<SessionProtocolSessionSummary[]> {
    this.assertHostActive();
    await this.refreshStore();
    const snapshots = await this.store.listSessionSnapshots();
    return snapshots
      .filter((snapshot) => this.canRestoreSnapshot(snapshot))
      .map((snapshot) => ({
        sessionId: snapshot.sessionId,
        lifecycle: this.findLiveSession(snapshot.sessionId) ? snapshot.lifecycle : "idle",
      }));
  }

  async shutdown(): Promise<void> {
    if (this.shutdownPromise) {
      return await this.shutdownPromise;
    }

    this.shuttingDown = true;
    this.shutdownPromise = this.shutdownNow();
    return await this.shutdownPromise;
  }

  private async shutdownNow(): Promise<void> {
    const errors: unknown[] = [];
    const recoveryResults = await Promise.allSettled(this.sessionRecoveryPromises.values());
    for (const result of recoveryResults) {
      if (result.status === "rejected") {
        errors.push(result.reason);
      }
    }

    for (const session of this.sessions) {
      session.interruptActiveWork();
    }

    const settlementResults = await Promise.allSettled(
      [...this.sessions].map((session) => session.waitForActiveWork()),
    );
    for (const result of settlementResults) {
      if (result.status === "rejected") {
        errors.push(result.reason);
      }
    }

    for (const session of this.sessions) {
      try {
        await session.snapshot();
      } catch (error) {
        errors.push(error);
      }

      try {
        await session.dispose();
      } catch (error) {
        errors.push(error);
      }
    }
    this.sessions.clear();

    if (errors.length > 0) {
      throw new AggregateError(errors, "failed to shut down local session host");
    }
  }

  private async refreshStore(): Promise<void> {
    for (const session of this.sessions) {
      await session.snapshot();
    }
  }

  private assertHostActive(): void {
    if (this.shuttingDown) {
      throw new Error("local session host is shut down");
    }
  }

  private sessionsHasExecutionEnvironment(executionEnvironment: ExecutionEnvironment): boolean {
    for (const session of this.sessions) {
      if (session.hasExecutionEnvironment(executionEnvironment)) {
        return true;
      }
    }
    return false;
  }
}

class LocalHostedSessionHandle implements LocalHostedSession {
  readonly session: ChatRuntime;
  private committedSessionId: string;
  private committedSnapshot?: SessionProtocolSnapshot;
  private persistedSnapshot?: SessionProtocolSnapshot;
  private draftAssistantMessage?: SessionProtocolMessage;
  private readonly messageStates = new Map<string, SessionProtocolMessage["state"]>();
  private readonly turnOutcomes = new Map<string, SessionProtocolTurnOutcome>();
  private restoredMessageIds?: Set<string>;
  private restoredTimelineMessageIds?: Set<string>;
  private readonly timelineExtras: SessionProtocolTimelineItem[] = [];
  private readonly tools = new Map<string, SessionProtocolToolRun>();
  private readonly agents = new Map<string, SessionProtocolAgentRun>();
  private readonly agentCostTotals = new Map<string, number>();
  private readonly facets = new Map<string, SessionProtocolFacet>();
  private readonly deltaListeners = new Set<(delta: SessionProtocolDeltaMessage) => void>();
  private readonly ephemeralListeners = new Set<
    (message: SessionProtocolEphemeralMessage) => void
  >();
  private readonly ephemeralAgentSessions = new Map<string, HostedEphemeralAgentSession>();
  private pathAutocompleteCache?: {
    expiresAt: number;
    entries: string[];
  };
  private pathAutocompleteLoad?: Promise<string[]>;
  private runtimeEventQueue: Promise<void> = Promise.resolve();
  private snapshotQueue: Promise<unknown> = Promise.resolve();
  private snapshotGeneration = 0;
  private readonly activeWorkAbortControllers = new Set<AbortController>();
  private readonly activeWorkPromises = new Set<Promise<unknown>>();
  private readonly activeExecAbortControllers = new Map<string, AbortController>();
  private activeTurnPromise?: Promise<SessionProtocolTurnOutcome>;
  private disposePromise?: Promise<void>;
  private disposing = false;
  private costTotal = 0;
  private forceNextSnapshotRevision: boolean;
  private disposed = false;

  constructor(
    readonly runtime: ChatRuntime,
    readonly promptBootstrap: RuntimePromptBootstrap,
    private catalog: SessionProtocolContentCatalogSnapshot,
    private bootstrap: LocalSessionResolvedBootstrap,
    private readonly includeAgentContext: boolean,
    private readonly executionEnvironment: ExecutionEnvironment,
    private readonly store: SessionStore,
    committedSnapshot: SessionProtocolSnapshot | undefined,
    forceNextSnapshotRevision: boolean,
    private readonly recordUsage: UsageRecorder,
    private readonly removeFromHost: (session: LocalHostedSessionHandle) => void = () => {},
  ) {
    this.session = runtime;
    this.committedSessionId = committedSnapshot?.sessionId ?? this.session.sessionId;
    this.committedSnapshot = committedSnapshot
      ? cloneSessionProtocolSnapshot(committedSnapshot)
      : undefined;
    this.persistedSnapshot = committedSnapshot
      ? cloneSessionProtocolSnapshot(committedSnapshot)
      : undefined;
    this.forceNextSnapshotRevision = forceNextSnapshotRevision;
    this.restoreProtocolState(committedSnapshot);
  }

  get isTurnRunning(): boolean {
    return this.runtime.isTurnRunning;
  }

  get sessionId(): string {
    return this.session.sessionId;
  }

  get isDisposed(): boolean {
    return this.disposed;
  }

  hasExecutionEnvironment(executionEnvironment: ExecutionEnvironment): boolean {
    return this.executionEnvironment === executionEnvironment;
  }

  onDelta(handler: (delta: SessionProtocolDeltaMessage) => void): () => void {
    this.deltaListeners.add(handler);
    return () => {
      this.deltaListeners.delete(handler);
    };
  }

  onEphemeral(handler: (message: SessionProtocolEphemeralMessage) => void): () => void {
    this.ephemeralListeners.add(handler);
    return () => {
      this.ephemeralListeners.delete(handler);
    };
  }

  async record(
    options: Omit<SessionProtocolRecordParams, "sessionId">,
  ): Promise<SessionProtocolRecordResult> {
    this.assertActive();
    const userHistoryEntryId = await this.session.commitUserText(
      options.text,
      options.historyEntryId ? { historyEntryId: options.historyEntryId } : undefined,
    );
    return {
      snapshot: await this.snapshot(),
      userHistoryEntryId,
    };
  }

  async runTurn(): Promise<SessionProtocolTurnOutcome> {
    this.assertActive();
    const run = this.runTurnNow();
    this.activeTurnPromise = run;
    try {
      return await run;
    } finally {
      if (this.activeTurnPromise === run) {
        this.activeTurnPromise = undefined;
      }
    }
  }

  private async runTurnNow(): Promise<SessionProtocolTurnOutcome> {
    const userMessage = this.session.rawHistoryEntries.findLast(
      (entry) => entry.message.role === "user",
    );
    if (!userMessage) {
      throw new Error("cannot run a turn without a user message");
    }

    let lastAssistantMessage: AssistantMessage | undefined;
    try {
      const result = await this.runtime.runTurn();
      lastAssistantMessage = result.finalMessage;
      if (result.aborted && this.draftAssistantMessage) {
        await this.interruptDraftAssistantMessage();
      }
      const outcome = turnOutcomeFromResult(result, lastAssistantMessage);
      this.turnOutcomes.set(userMessage.id, outcome);
      await this.emitSnapshotResetIfChanged("assistant-message");
      return outcome;
    } catch (error) {
      try {
        await this.cleanupFailedTurn();
      } catch {
        // Preserve the original turn failure for the protocol response.
      }
      throw error;
    }
  }

  interruptTurn(): boolean {
    this.assertActive();
    return this.runtime.interruptTurn();
  }

  interruptActiveWork(): boolean {
    let interrupted = this.runtime.interruptTurn();
    for (const abortController of this.activeWorkAbortControllers) {
      if (!abortController.signal.aborted) {
        abortController.abort();
        interrupted = true;
      }
    }
    return interrupted;
  }

  async waitForActiveWork(): Promise<void> {
    await Promise.allSettled([
      ...(this.activeTurnPromise ? [this.activeTurnPromise] : []),
      ...this.activeWorkPromises,
    ]);
    await this.runtimeEventQueue;
  }

  requestTurnBoundaryStop(): boolean {
    this.assertActive();
    return this.runtime.requestTurnBoundaryStop();
  }

  cancelTurnBoundaryStop(): boolean {
    this.assertActive();
    return this.runtime.cancelTurnBoundaryStop();
  }

  steer(text: string): {
    id: string;
    applied: Promise<{ userHistoryEntryId: string }>;
    result: Promise<{
      userHistoryEntryId: string;
      turn: SessionProtocolTurnOutcome;
    }>;
  } {
    this.assertActive();
    if (!this.activeTurnPromise) {
      throw new Error("cannot steer without an active turn");
    }
    const submission = this.runtime.steer(text);
    return {
      id: submission.id,
      applied: submission.applied.then(async (association) => {
        await this.commitSnapshot();
        return { userHistoryEntryId: association.historyEntryId };
      }),
      result: submission.result.then(async (association) => {
        const turn = turnOutcomeFromResult(association.result, association.result.finalMessage);
        this.turnOutcomes.set(association.historyEntryId, turn);
        await this.emitSnapshotResetIfChanged("assistant-message");
        return {
          userHistoryEntryId: association.historyEntryId,
          turn,
        };
      }),
    };
  }

  cancelSteering(): ReturnType<ChatRuntime["cancelSteering"]> {
    this.assertActive();
    return this.runtime.cancelSteering();
  }

  async exec(
    options: Omit<SessionProtocolExecParams, "sessionId"> & {
      signal?: AbortSignal;
    },
  ): Promise<SessionProtocolExecResult> {
    return await this.runExec(options.execId, options.signal, async (signal) => {
      const backend = this.executionEnvironment.getToolExecutionBackend();
      const result = await backend.runBash(options.command, {
        ...(options.args !== undefined ? { args: options.args } : {}),
        ...(options.env !== undefined ? { env: options.env } : {}),
        ...(options.stdinBase64 !== undefined
          ? { stdin: Buffer.from(options.stdinBase64, "base64") }
          : {}),
        ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
        ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
        ...(options.maxCaptureBytes !== undefined
          ? { maxCaptureBytes: options.maxCaptureBytes }
          : {}),
        signal,
      });
      signal.throwIfAborted();
      return result;
    });
  }

  cancelExec(execId: string): boolean {
    const controller = this.activeExecAbortControllers.get(execId);
    if (!controller || controller.signal.aborted) {
      return false;
    }
    controller.abort();
    return true;
  }

  async sample(
    options: Omit<SessionProtocolSampleParams, "sessionId"> & {
      signal?: AbortSignal;
    },
  ): Promise<SessionProtocolSampleResult> {
    this.assertActive();
    return await this.runActiveWork(
      async (signal) => ({
        message: await this.session.sample({ ...options, signal }),
      }),
      options.signal,
    );
  }

  async setReasoning(reasoning: ReasoningEffort): Promise<SessionProtocolSettingsUpdateResult> {
    this.assertActive();
    const write = this.runtimeEventQueue
      .catch(() => undefined)
      .then(async () => {
        const fromRevision = this.committedSnapshot?.revision;
        this.runtime.setReasoning(reasoning);
        this.bootstrap.persona.settings.reasoning = reasoning;
        const snapshot = await this.commitSnapshot();
        if (fromRevision === undefined) {
          this.emitSnapshotReset("configuration", snapshot);
        } else if (snapshot.revision !== fromRevision) {
          this.emitDelta(
            createSessionProtocolDeltaMessage({
              sessionId: snapshot.sessionId,
              fromRevision,
              toRevision: snapshot.revision,
              reason: "configuration",
              delta: {
                type: "snapshot.patch",
                changes: [{ type: "settings.set", settings: snapshot.settings }],
              },
            }),
          );
        }
        return { revision: snapshot.revision, settings: snapshot.settings };
      });
    this.runtimeEventQueue = write.then(
      () => undefined,
      () => undefined,
    );
    return await write;
  }

  async setPersona(personaId: string): Promise<SessionProtocolSnapshot> {
    this.assertActive();
    const runtimeConfig = await this.executionEnvironment.resolveRuntimeConfig(
      this.executionEnvironment.snapshot().cwd,
    );
    const personas = runtimeConfig.personas.map((persona) =>
      this.normalizeReloadedPersona(persona),
    );
    const persona = personas.find(
      (persona) => persona.id.toLowerCase() === personaId.toLowerCase(),
    );
    if (!persona) {
      throw new Error(`unknown persona '${personaId}'`);
    }

    const selectedPersona = clonePersona(persona);
    const runtimeContext = await this.executionEnvironment.resolveRuntimeContext({
      cwd: this.executionEnvironment.snapshot().cwd,
      persona: selectedPersona,
      discoveredSkills: runtimeConfig.skills,
      includeAgentContext: this.includeAgentContext,
      agentContextFiles: runtimeConfig.config.agentContextFiles ?? [],
    });
    this.runtime.setRuntimeConfig(
      runtimeConfig.config,
      runtimeConfig.bootstrap.modelResolver.resolveModel,
    );
    this.runtime.updatePromptContext(runtimeContext.promptBootstrap.promptContext);
    this.runtime.setPersona(selectedPersona, {
      skillsBlock: runtimeContext.promptBootstrap.promptContext.skillsBlock,
    });
    this.bootstrap = {
      persona: clonePersona(selectedPersona),
      discoveredSkills: structuredClone(runtimeConfig.skills),
      personas: personas.map(clonePersona),
      prompts: structuredClone(runtimeConfig.prompts),
      modelResolver: runtimeConfig.bootstrap.modelResolver.resolveModel,
      config: runtimeConfig.config,
    };
    this.catalog = createContentCatalogSnapshot(this.bootstrap);
    const snapshot = await this.commitSnapshot();
    this.emitSnapshotReset("configuration", snapshot);
    return snapshot;
  }

  async reload(): Promise<SessionProtocolReloadResult> {
    this.assertActive();
    const runtimeConfig = await this.executionEnvironment.resolveRuntimeConfig(
      this.executionEnvironment.snapshot().cwd,
    );
    if (runtimeConfig.personas.length === 0) {
      throw new Error("reload failed: no personas available");
    }

    const personas = runtimeConfig.personas.map((persona) =>
      this.normalizeReloadedPersona(persona),
    );
    const currentPersonaId = this.runtime.persona.id.toLowerCase();
    const nextPersona =
      personas.find((persona) => persona.id.toLowerCase() === currentPersonaId) ?? personas[0]!;

    const runtimeContext = await this.executionEnvironment.resolveRuntimeContext({
      cwd: this.executionEnvironment.snapshot().cwd,
      persona: nextPersona,
      discoveredSkills: runtimeConfig.skills,
      includeAgentContext: this.includeAgentContext,
      agentContextFiles: runtimeConfig.config.agentContextFiles ?? [],
    });

    this.runtime.setRuntimeConfig(
      runtimeConfig.config,
      runtimeConfig.bootstrap.modelResolver.resolveModel,
    );
    this.runtime.updatePromptContext(runtimeContext.promptBootstrap.promptContext);
    this.runtime.setPersona(nextPersona, {
      skillsBlock: runtimeContext.promptBootstrap.promptContext.skillsBlock,
    });
    this.bootstrap = {
      persona: clonePersona(nextPersona),
      discoveredSkills: structuredClone(runtimeConfig.skills),
      personas: personas.map(clonePersona),
      prompts: structuredClone(runtimeConfig.prompts),
      modelResolver: runtimeConfig.bootstrap.modelResolver.resolveModel,
      config: runtimeConfig.config,
    };

    this.catalog = createContentCatalogSnapshot(this.bootstrap);

    const unknownSkillWarnings = runtimeContext.promptBootstrap.unknownSkills.map(
      (skill) => `unknown skill enabled by persona '${nextPersona.id}': ${skill}`,
    );

    const snapshot = await this.commitSnapshot();
    this.emitSnapshotReset("configuration", snapshot);
    return {
      snapshot,
      warnings: [...runtimeConfig.warnings, ...unknownSkillWarnings],
      counts: {
        personas: runtimeConfig.personas.length,
        prompts: runtimeConfig.prompts.length,
        skills: runtimeConfig.skills.length,
      },
    };
  }

  private normalizeReloadedPersona(persona: Persona): Persona {
    return clonePersona(persona);
  }

  async resolvePrompt(
    promptId: SessionProtocolResolvePromptParams["promptId"],
  ): Promise<SessionProtocolResolvePromptResult> {
    this.assertActive();
    const executionSnapshot = this.executionEnvironment.snapshot();
    const prompt = await resolvePromptTemplateWithBackend({
      backend: this.executionEnvironment.getToolExecutionBackend(),
      cwd: executionSnapshot.cwd,
      home: executionSnapshot.home,
      promptId,
    });
    if (!prompt) {
      throw new Error(`unknown prompt '${promptId}'`);
    }
    return { promptId: prompt.id, text: prompt.template };
  }

  async autocompletePaths(
    options: Omit<SessionProtocolAutocompletePathsParams, "sessionId">,
  ): Promise<SessionProtocolAutocompletePathsResult> {
    this.assertActive();
    const entries = await this.getPathAutocompleteEntries();
    return {
      paths: filterProjectPathAutocompleteEntries(entries, options),
    };
  }

  private async getPathAutocompleteEntries(): Promise<string[]> {
    const now = Date.now();
    if (this.pathAutocompleteCache && this.pathAutocompleteCache.expiresAt > now) {
      return this.pathAutocompleteCache.entries;
    }

    this.pathAutocompleteLoad ??= loadProjectPathAutocompleteEntriesWithBackend(
      this.executionEnvironment.getToolExecutionBackend(),
    )
      .then((entries) => {
        this.pathAutocompleteCache = {
          entries,
          expiresAt: Date.now() + PATH_AUTOCOMPLETE_CACHE_TTL_MS,
        };
        return entries;
      })
      .catch(() => [])
      .finally(() => {
        this.pathAutocompleteLoad = undefined;
      });

    return await this.pathAutocompleteLoad;
  }

  async compact(
    options: Omit<SessionProtocolCompactParams, "sessionId">,
  ): Promise<SessionProtocolCompactResult> {
    return await this.runMaintenance(async (signal) => {
      const result = await this.session.compact({
        mode: options.mode === "summary-only" ? "only-summary" : "with-last-assistant",
        ...(options.guidance !== undefined ? { guidance: options.guidance } : {}),
        signal,
      });

      signal.throwIfAborted();
      await this.runtimeEventQueue;
      this.reconcileProjections();
      const snapshot = await this.commitSnapshot();
      this.emitSnapshotReset("maintenance", snapshot);
      return {
        snapshot,
        compactionMessage: result.compactionMessage,
        includedLastAssistant: result.includedLastAssistant,
      };
    });
  }

  private async runMaintenance<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    this.assertActive();
    return await this.runActiveWork(operation);
  }

  private async runExec<T>(
    execId: string,
    externalSignal: AbortSignal | undefined,
    operation: (signal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    this.assertActive();
    if (this.activeExecAbortControllers.has(execId)) {
      throw new SessionExecBusyError(execId);
    }
    const abortController = new AbortController();
    this.activeExecAbortControllers.set(execId, abortController);
    const signal = externalSignal
      ? AbortSignal.any([externalSignal, abortController.signal])
      : abortController.signal;
    try {
      return await this.runActiveWork(operation, signal);
    } finally {
      if (this.activeExecAbortControllers.get(execId) === abortController) {
        this.activeExecAbortControllers.delete(execId);
      }
    }
  }

  private async runActiveWork<T>(
    operation: (signal: AbortSignal) => Promise<T>,
    externalSignal?: AbortSignal,
  ): Promise<T> {
    const abortController = new AbortController();
    const signal = externalSignal
      ? AbortSignal.any([externalSignal, abortController.signal])
      : abortController.signal;
    this.activeWorkAbortControllers.add(abortController);
    const promise = operation(signal);
    this.activeWorkPromises.add(promise);
    try {
      return await promise;
    } finally {
      this.activeWorkAbortControllers.delete(abortController);
      this.activeWorkPromises.delete(promise);
    }
  }

  async rewindToHistoryEntryId(historyEntryId: string): Promise<SessionProtocolRewindResult> {
    this.assertActive();
    const result = await this.session.rewindToHistoryEntryId(historyEntryId);
    if (!result) {
      throw new Error("rewind failed");
    }

    return {
      snapshot: await this.snapshot(),
      ...result,
    };
  }

  async terminateSubagent(subagentId: string): Promise<SessionProtocolTerminateSubagentResult> {
    this.assertActive();
    return { found: await this.session.terminateSubagent(subagentId) };
  }

  async createEphemeralContext(
    options: Omit<SessionProtocolEphemeralCreateParams, "sessionId">,
  ): Promise<SessionProtocolEphemeralCreateResult> {
    this.assertActive();
    const contextId = `ephemeral-${randomUUID()}`;
    const session = new HostedEphemeralAgentSession({
      contextId,
      persona: this.runtime.persona,
      config: this.bootstrap.config ?? {},
      discoveredSkills: this.bootstrap.discoveredSkills,
      includeAgentContext: this.includeAgentContext,
      executionEnvironment: this.executionEnvironment,
      instructions: options.instructions,
      tools: options.tools,
      recordUsage: this.recordUsage,
      emitUpdate: (threadId, update) => {
        this.emitEphemeral(
          createSessionProtocolEphemeralMessage({
            sessionId: this.session.sessionId,
            event: {
              type: "ephemeral-agent.thread-update",
              contextId,
              threadId,
              update,
            },
          }),
        );
      },
    });
    this.ephemeralAgentSessions.set(contextId, session);
    return { contextId };
  }

  async submitEphemeralThread(
    options: Omit<SessionProtocolEphemeralSubmitParams, "sessionId">,
  ): Promise<SessionProtocolEphemeralSubmitResult> {
    this.assertActive();
    const session = this.ephemeralAgentSessions.get(options.contextId);
    if (!session) {
      throw new Error(`unknown ephemeral context '${options.contextId}'`);
    }
    return await session.submitThreadMessage(options);
  }

  async closeEphemeralContext(contextId: string): Promise<SessionProtocolEphemeralCloseResult> {
    const session = this.ephemeralAgentSessions.get(contextId);
    if (!session) {
      return { closed: false };
    }
    this.ephemeralAgentSessions.delete(contextId);
    session.dispose();
    return { closed: true };
  }

  async snapshot(): Promise<SessionProtocolSnapshot> {
    this.assertActive();
    return await this.commitSnapshot();
  }

  async persistRecoveredAgentState(recovery: AgentStateRecovery): Promise<void> {
    this.assertActive();
    for (const recovered of recovery.recoveredToolResults) {
      const tool = this.tools.get(recovered.message.toolCallId);
      if (!tool || tool.status === "streaming") {
        continue;
      }
      this.tools.set(tool.id, {
        ...tool,
        status: "cancelled",
        finishedAt: recovered.message.timestamp,
        resultMessageId: recovered.historyEntryId,
        error: "Tool completion status is unknown after session recovery.",
      });
    }
    await this.commitSnapshot();
  }

  async dispose(): Promise<void> {
    if (!this.disposePromise) {
      this.disposing = true;
      this.disposePromise = this.disposeNow();
    }
    return await this.disposePromise;
  }

  private async disposeNow(): Promise<void> {
    if (this.disposed) {
      return;
    }

    const errors: unknown[] = [];
    this.interruptActiveWork();
    try {
      await this.waitForActiveWork();
    } catch (error) {
      errors.push(error);
    }

    this.disposed = true;
    for (const session of this.ephemeralAgentSessions.values()) {
      try {
        session.dispose();
      } catch (error) {
        errors.push(error);
      }
    }
    this.ephemeralAgentSessions.clear();
    try {
      this.session.dispose();
    } catch (error) {
      errors.push(error);
    }

    try {
      await this.executionEnvironment.dispose();
    } catch (error) {
      errors.push(error);
    } finally {
      this.removeFromHost(this);
    }

    if (errors.length > 0) {
      throw new AggregateError(errors, "failed to dispose hosted session");
    }
  }

  private async commitSnapshot(): Promise<SessionProtocolSnapshot> {
    const write = this.snapshotQueue.catch(() => undefined).then(() => this.writeSnapshot());
    this.snapshotQueue = write.catch(() => undefined);
    return await write;
  }

  private async commitSnapshotWithRevision(revision: number): Promise<SessionProtocolSnapshot> {
    const write = this.snapshotQueue
      .catch(() => undefined)
      .then(() => this.writeSnapshotWithRevision(revision));
    this.snapshotQueue = write.catch(() => undefined);
    return await write;
  }

  private async writeSnapshot(): Promise<SessionProtocolSnapshot> {
    this.assertNotDisposed();
    const generation = this.snapshotGeneration;
    const draft = this.buildSnapshotDraft();

    await this.switchSnapshotSession(draft.sessionId);

    const snapshot: SessionProtocolSnapshot = {
      ...draft,
      revision: this.nextSnapshotRevision(draft),
    };
    if (this.persistedSnapshot && isDeepStrictEqual(this.persistedSnapshot, snapshot)) {
      return cloneSessionProtocolSnapshot(this.committedSnapshot ?? snapshot);
    }

    await this.store.commitSessionSnapshot(snapshot, {
      expectedRevision: this.persistedSnapshot?.revision ?? 0,
    });
    this.persistedSnapshot = cloneSessionProtocolSnapshot(snapshot);
    if (generation !== this.snapshotGeneration) {
      return await this.writeSnapshot();
    }
    return cloneSessionProtocolSnapshot(this.updateCommittedSnapshotAfterWrite(snapshot));
  }

  private async writeSnapshotWithRevision(revision: number): Promise<SessionProtocolSnapshot> {
    this.assertNotDisposed();
    const generation = this.snapshotGeneration;
    const draft = this.buildSnapshotDraft();

    await this.switchSnapshotSession(draft.sessionId);

    const snapshot: SessionProtocolSnapshot = {
      ...draft,
      revision,
    };
    await this.store.commitSessionSnapshot(snapshot, {
      expectedRevision: this.persistedSnapshot?.revision ?? 0,
    });
    this.persistedSnapshot = cloneSessionProtocolSnapshot(snapshot);
    if (generation !== this.snapshotGeneration) {
      return await this.writeSnapshot();
    }
    return cloneSessionProtocolSnapshot(this.updateCommittedSnapshotAfterWrite(snapshot));
  }

  private async switchSnapshotSession(sessionId: string): Promise<void> {
    if (this.committedSessionId === sessionId) {
      return;
    }

    await this.store.deleteSession(this.committedSessionId, {
      ...(this.persistedSnapshot ? { expectedRevision: this.persistedSnapshot.revision } : {}),
    });
    this.committedSessionId = sessionId;
    this.committedSnapshot = undefined;
    this.persistedSnapshot = undefined;
  }

  private updateCommittedSnapshotAfterWrite(
    snapshot: SessionProtocolSnapshot,
  ): SessionProtocolSnapshot {
    if (!this.committedSnapshot || this.committedSnapshot.revision < snapshot.revision) {
      this.committedSnapshot = cloneSessionProtocolSnapshot(snapshot);
      this.snapshotGeneration += 1;
    }
    return this.committedSnapshot;
  }

  private reconcileProjections(options: { removeMissingAgents?: boolean } = {}): void {
    const messageIds = new Set(this.session.rawHistoryEntries.map((entry) => entry.id));
    messageIds.add("system");

    for (const id of this.turnOutcomes.keys()) {
      if (!messageIds.has(id)) {
        this.turnOutcomes.delete(id);
      }
    }

    for (const [id, tool] of this.tools) {
      const messageId = tool.status === "streaming" ? tool.origin.messageId : tool.call.messageId;
      if (
        !messageIds.has(messageId) ||
        (tool.status !== "streaming" &&
          tool.resultMessageId !== undefined &&
          !messageIds.has(tool.resultMessageId))
      ) {
        this.tools.delete(id);
      }
    }
    if (options.removeMissingAgents) {
      for (const id of this.agents.keys()) {
        if (!this.session.hasSubagent(id)) {
          this.agents.delete(id);
          this.agentCostTotals.delete(id);
        }
      }
    }

    const operationIds = new Set(
      this.timelineExtras.filter((item) => item.type === "operation").map((item) => item.id),
    );
    for (const [id, facet] of this.facets) {
      const subjectExists =
        facet.subject.type === "session" ||
        (facet.subject.type === "message" && messageIds.has(facet.subject.id)) ||
        (facet.subject.type === "tool" && this.tools.has(facet.subject.id)) ||
        (facet.subject.type === "agent" && this.agents.has(facet.subject.id)) ||
        (facet.subject.type === "operation" && operationIds.has(facet.subject.id));
      if (!subjectExists) {
        this.facets.delete(id);
      }
    }
  }

  private buildSnapshotDraft(): Omit<SessionProtocolSnapshot, "revision"> {
    const messages = this.buildProtocolMessages();
    const agentState = this.session.snapshot();
    return {
      sessionId: this.session.sessionId,
      agentState: {
        revision: agentState.revision,
        contextEpoch: agentState.contextEpoch,
        ...(agentState.usageCheckpoint
          ? { usageCheckpoint: { ...agentState.usageCheckpoint } }
          : {}),
      },
      lifecycle: this.runtime.isTurnRunning ? "running" : "idle",
      costTotal: this.costTotal,
      settings: {
        personaId: this.runtime.persona.id,
        ...(this.runtime.persona.settings.reasoning !== undefined
          ? { reasoning: this.runtime.persona.settings.reasoning }
          : {}),
        ...(this.runtime.persona.settings.serviceTier !== undefined
          ? { serviceTier: this.runtime.persona.settings.serviceTier }
          : {}),
      },
      bootstrap: {
        model: modelSnapshotFromModel(this.runtime.persona.model),
        prompt: {
          environmentTag: this.runtime.promptComposition.environmentTag,
          subagentPrompts: cloneSubagentPrompts(this.runtime.promptComposition.subagentPrompts),
        },
      },
      catalog: structuredClone(this.catalog),
      executionEnvironment: this.executionEnvironment.snapshot(),
      messages,
      timeline: this.buildTimeline(messages),
      tools: Object.fromEntries(this.tools),
      agents: Object.fromEntries(this.agents),
      facets: Object.fromEntries(this.facets),
    };
  }

  private buildProtocolMessages(): SessionProtocolMessage[] {
    const systemMessage: SessionProtocolMessage = {
      id: "system",
      state: "committed",
      modelVisible: true,
      message: {
        role: "system",
        content: this.runtime.promptComposition.baseSystemPrompt,
        timestamp: 0,
      },
    };
    const historyMessages = this.session.rawHistoryEntries.map((entry): SessionProtocolMessage => {
      const turn = this.turnOutcomes.get(entry.id);
      return {
        id: entry.id,
        state: this.messageStates.get(entry.id) ?? "committed",
        modelVisible: true,
        message: entry.message,
        ...(turn ? { turn } : {}),
      };
    });
    return [
      systemMessage,
      ...historyMessages,
      ...(this.draftAssistantMessage ? [structuredClone(this.draftAssistantMessage)] : []),
    ];
  }

  private buildTimeline(
    messages: readonly SessionProtocolMessage[],
  ): SessionProtocolTimelineItem[] {
    const messageItems = messages
      .filter((message) => this.shouldIncludeMessageInTimeline(message))
      .map(
        (message): SessionProtocolTimelineItem => ({
          type: "message",
          id: `timeline-${message.id}`,
          messageId: message.id,
        }),
      );
    return [...messageItems, ...structuredClone(this.timelineExtras)];
  }

  private shouldIncludeMessageInTimeline(message: SessionProtocolMessage): boolean {
    if (message.id === "system") {
      return false;
    }
    if (
      isCoreMessage(message.message) &&
      (isTauUserMessageHidden(message.message) ||
        hasAutoCompactionContinuationMetadata(message.message))
    ) {
      return false;
    }
    if (!this.restoredTimelineMessageIds || !this.restoredMessageIds) {
      return true;
    }
    return (
      this.restoredTimelineMessageIds.has(message.id) || !this.restoredMessageIds.has(message.id)
    );
  }

  private clearRunningAutoCompactionOperations(): void {
    this.timelineExtras.splice(
      0,
      this.timelineExtras.length,
      ...this.timelineExtras.filter(
        (item) =>
          item.type !== "operation" ||
          item.operation.kind !== "auto-compaction" ||
          item.operation.status !== "running",
      ),
    );
  }

  private restoreProtocolState(snapshot: SessionProtocolSnapshot | undefined): void {
    if (!snapshot) {
      return;
    }
    this.restoredMessageIds = new Set(snapshot.messages.map((message) => message.id));
    this.restoredTimelineMessageIds = new Set(
      snapshot.timeline.filter((item) => item.type === "message").map((item) => item.messageId),
    );
    this.timelineExtras.splice(
      0,
      this.timelineExtras.length,
      ...snapshot.timeline
        .filter((item) => item.type !== "message")
        .map((item) => structuredClone(item)),
    );
    this.tools.clear();
    for (const [id, tool] of Object.entries(snapshot.tools)) {
      this.tools.set(id, structuredClone(tool));
    }
    this.agents.clear();
    this.agentCostTotals.clear();
    for (const [id, agent] of Object.entries(snapshot.agents)) {
      this.agents.set(id, structuredClone(agent));
      this.agentCostTotals.set(id, agent.costTotal);
    }
    this.costTotal = snapshot.costTotal;
    this.facets.clear();
    for (const [id, facet] of Object.entries(snapshot.facets)) {
      this.facets.set(id, structuredClone(facet));
    }
    this.draftAssistantMessage = snapshot.messages.find((message) => message.state === "draft");
    this.messageStates.clear();
    this.turnOutcomes.clear();
    for (const message of snapshot.messages) {
      if (message.state !== "committed" && message.state !== "draft") {
        this.messageStates.set(message.id, message.state);
      }
      if (message.turn) {
        this.turnOutcomes.set(message.id, message.turn);
      }
    }
  }

  private assertActive(): void {
    if (this.disposing || this.disposed) {
      throw new Error(`session is shut down: ${this.committedSessionId}`);
    }
  }

  private assertNotDisposed(): void {
    if (this.disposed) {
      throw new Error(`session is shut down: ${this.committedSessionId}`);
    }
  }

  private nextSnapshotRevision(
    next: Omit<SessionProtocolSnapshot, "revision">,
  ): SessionProtocolSnapshot["revision"] {
    if (!this.committedSnapshot) {
      return 1;
    }

    if (this.forceNextSnapshotRevision) {
      this.forceNextSnapshotRevision = false;
      return this.committedSnapshot.revision + 1;
    }

    const { revision, ...current } = this.committedSnapshot;
    return JSON.stringify(current) === JSON.stringify(next) ? revision : revision + 1;
  }

  async recordSubagentEvent(event: SubagentUiEvent): Promise<void> {
    const write = this.runtimeEventQueue
      .catch(() => undefined)
      .then(() => this.recordSubagentUiEvent(event));
    this.runtimeEventQueue = write.catch(() => undefined);
    return await write;
  }

  async enqueueRuntimeEvent(event: AgentEvent): Promise<void> {
    const write = this.runtimeEventQueue
      .catch(() => undefined)
      .then(() => this.recordRuntimeEvent(event));
    this.runtimeEventQueue = write.catch(() => undefined);
    return write;
  }

  private removeToolRun(tool: SessionProtocolToolRun, changes: SessionProtocolChange[]): void {
    this.tools.delete(tool.id);
    for (const facetId of tool.facetIds) {
      this.facets.delete(facetId);
      changes.push({ type: "facet.remove", id: facetId });
    }
    changes.push({ type: "tool.remove", id: tool.id });
  }

  private agentStateChange(): SessionProtocolChange {
    const state = this.session.snapshot();
    return {
      type: "agent-state.set",
      agentState: {
        revision: state.revision,
        contextEpoch: state.contextEpoch,
        ...(state.usageCheckpoint ? { usageCheckpoint: { ...state.usageCheckpoint } } : {}),
      },
    };
  }

  private async recordRuntimeEvent(event: AgentEvent): Promise<void> {
    switch (event.type) {
      case "assistant_start": {
        this.draftAssistantMessage = {
          id: event.historyEntryId,
          state: "draft",
          modelVisible: false,
          message: { role: "assistant", content: [], timestamp: Date.now() },
        };
        const timelineItem = timelineItemForMessage(this.draftAssistantMessage.id);
        await this.emitPatch(
          "assistant-stream",
          [
            {
              type: "message.append",
              message: structuredClone(this.draftAssistantMessage),
              timelineItem,
            },
            { type: "lifecycle.set", lifecycle: "running" },
          ],
          { persist: false },
        );
        return;
      }
      case "tool_call_streaming": {
        const changes: SessionProtocolChange[] = [];
        if (event.replacesToolCallId) {
          const replaced = this.tools.get(event.replacesToolCallId);
          if (
            replaced?.status === "streaming" &&
            replaced.origin.messageId === event.historyEntryId &&
            replaced.origin.contentIndex === event.contentIndex
          ) {
            this.removeToolRun(replaced, changes);
          }
        }

        if (this.tools.has(event.toolCallId)) {
          throw new Error(`duplicate protocol tool run '${event.toolCallId}'`);
        }
        const facetId = `tool-ui-${event.toolCallId}`;
        const uiEvent: ToolUiEvent = {
          type: "tool_call_streaming",
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          headerTarget: event.toolName,
        };
        const facet: SessionProtocolFacet = {
          id: facetId,
          subject: { type: "tool", id: event.toolCallId },
          kind: "tau.tool-ui-events",
          version: 1,
          data: { events: [uiEvent] },
        };
        const tool: SessionProtocolToolRun = {
          id: event.toolCallId,
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          status: "streaming",
          origin: {
            messageId: event.historyEntryId,
            contentIndex: event.contentIndex,
          },
          facetIds: [facetId],
        };
        this.tools.set(tool.id, tool);
        this.facets.set(facet.id, facet);
        changes.push(
          { type: "tool.set", tool: structuredClone(tool) },
          { type: "facet.set", facet: structuredClone(facet) },
        );
        await this.emitPatch("tool-run", changes, { persist: false });
        return;
      }
      case "tool_call_discarded": {
        const tool = this.tools.get(event.toolCallId);
        if (
          tool?.status !== "streaming" ||
          tool.origin.messageId !== event.historyEntryId ||
          tool.origin.contentIndex !== event.contentIndex
        ) {
          return;
        }
        const changes: SessionProtocolChange[] = [];
        this.removeToolRun(tool, changes);
        await this.emitPatch("tool-run", changes, { persist: false });
        return;
      }
      case "assistant_partial": {
        const previousDraft = this.draftAssistantMessage;
        const message: SessionProtocolDraftAssistantMessage = {
          role: "assistant",
          content: [
            ...(event.snapshot.hasAnyThinking
              ? [
                  {
                    type: "thinking" as const,
                    thinking: event.snapshot.thinking,
                  },
                ]
              : []),
            ...(event.snapshot.hasTextStarted
              ? [{ type: "text" as const, text: event.snapshot.text }]
              : []),
            ...event.snapshot.toolCalls,
          ],
          timestamp: Date.now(),
        };
        const nextDraft: SessionProtocolMessage = {
          id: event.historyEntryId,
          state: "draft",
          modelVisible: false,
          message,
        };
        const changes = this.buildAssistantPartialChanges(previousDraft, nextDraft);
        const toolChanges = this.syncToolRunsFromAssistantMessage(event.historyEntryId, message);
        if (changes.length === 0 && toolChanges.length === 0) {
          return;
        }
        this.draftAssistantMessage = nextDraft;
        await this.emitPatch("assistant-stream", [...changes, ...toolChanges], {
          persist: false,
        });
        return;
      }
      case "user_message":
        await this.emitPatch(
          "user-message",
          [
            this.agentStateChange(),
            {
              type: "message.append",
              message: {
                id: event.historyEntryId,
                state: "committed",
                modelVisible: true,
                message: event.message,
              },
              timelineItem: timelineItemForMessage(event.historyEntryId),
            },
          ],
          { persist: true },
        );
        return;
      case "history_rewound":
        this.reconcileProjections({ removeMissingAgents: true });
        await this.emitSnapshotResetIfChanged("maintenance");
        return;
      case "assistant_final": {
        this.draftAssistantMessage = undefined;
        this.messageStates.delete(event.historyEntryId);
        const toolChanges = this.syncToolRunsFromAssistantMessage(
          event.historyEntryId,
          event.message,
        );
        const usage = getUsageTotals(event.message.usage);
        const cost = getUsageCostTotal(event.message.usage);
        this.costTotal += cost;
        this.recordUsage({
          timestamp: event.message.timestamp,
          sessionId: this.sessionId,
          personaId: event.personaId,
          provider: event.message.provider,
          model: event.message.model,
          api: event.message.api,
          reasoningEffort: event.reasoningEffort,
          usage,
          cost: { total: cost },
          agent: { type: "main" },
        });
        await this.emitPatch("assistant-message", [
          this.agentStateChange(),
          { type: "cost.set", costTotal: this.costTotal },
          {
            type: "message.replace",
            message: {
              id: event.historyEntryId,
              state: event.message.stopReason === "aborted" ? "interrupted" : "committed",
              modelVisible: true,
              message: event.message,
            },
          },
          ...toolChanges,
        ]);
        return;
      }
      case "tool_run_queued":
      case "tool_run_blocked":
      case "tool_run_started":
      case "tool_run_finished": {
        const existing = this.tools.get(event.toolCallId);
        if (!existing || existing.status === "streaming") {
          throw new Error(`missing completed protocol tool run for '${event.toolCallId}'`);
        }
        const nextTool: SessionProtocolToolRun = {
          ...existing,
          status:
            event.type === "tool_run_queued"
              ? "queued"
              : event.type === "tool_run_blocked"
                ? "blocked"
                : event.type === "tool_run_started"
                  ? "running"
                  : event.outcome,
          ...(event.type === "tool_run_started" || event.type === "tool_run_finished"
            ? { startedAt: existing.startedAt ?? event.timestamp }
            : {}),
          ...(event.type === "tool_run_blocked" || event.type === "tool_run_finished"
            ? { finishedAt: event.timestamp }
            : {}),
        };
        this.tools.set(nextTool.id, nextTool);
        await this.emitPatch("tool-run", [{ type: "tool.set", tool: structuredClone(nextTool) }]);
        return;
      }
      case "tool_result": {
        const existing = this.tools.get(event.message.toolCallId);
        if (existing?.status === "streaming") {
          throw new Error(`tool result arrived before '${event.message.toolCallId}' completed`);
        }
        if (existing) {
          if (existing.status === "queued" || existing.status === "running") {
            throw new Error(`tool result arrived before '${event.message.toolCallId}' finished`);
          }
          const nextTool: SessionProtocolToolRun = {
            ...existing,
            resultMessageId: event.historyEntryId,
          };
          this.tools.set(nextTool.id, nextTool);
          await this.emitPatch("tool-result", [
            this.agentStateChange(),
            {
              type: "message.append",
              message: {
                id: event.historyEntryId,
                state: "committed",
                modelVisible: true,
                message: event.message,
              },
              timelineItem: timelineItemForMessage(event.historyEntryId),
            },
            { type: "tool.set", tool: structuredClone(nextTool) },
          ]);
          return;
        }
        await this.emitPatch("tool-result", [
          this.agentStateChange(),
          {
            type: "message.append",
            message: {
              id: event.historyEntryId,
              state: "committed",
              modelVisible: true,
              message: event.message,
            },
            timelineItem: timelineItemForMessage(event.historyEntryId),
          },
        ]);
        return;
      }
      case "tool_recovery": {
        const changes: SessionProtocolChange[] = [
          this.agentStateChange(),
          {
            type: "message.append",
            message: {
              id: event.historyEntryId,
              state: "committed",
              modelVisible: true,
              message: event.message,
            },
          },
        ];
        for (const toolResult of event.toolResults) {
          const existing = this.tools.get(toolResult.toolCallId);
          if (!existing || existing.status === "streaming") {
            throw new Error(`missing completed protocol tool run for '${toolResult.toolCallId}'`);
          }
          if (existing.status === "queued" || existing.status === "running") {
            throw new Error(`tool recovery arrived before '${toolResult.toolCallId}' finished`);
          }
          const nextTool: SessionProtocolToolRun = {
            ...existing,
          };
          this.tools.set(nextTool.id, nextTool);
          changes.push({ type: "tool.set", tool: structuredClone(nextTool) });
        }
        await this.emitPatch("recovery", changes);
        return;
      }
      case "notice": {
        const item: SessionProtocolTimelineItem = {
          type: "notice",
          id: `notice-${Date.now()}-${this.timelineExtras.length}`,
          notice: {
            severity: event.severity,
            text: event.text,
            timestamp: Date.now(),
          },
        };
        this.timelineExtras.push(item);
        await this.emitPatch("notice", [{ type: "timeline.append", item: structuredClone(item) }]);
        return;
      }
      case "compaction_start": {
        const item: SessionProtocolTimelineItem = {
          type: "operation",
          id: `operation-auto-compaction-${Date.now()}`,
          operation: {
            kind: "auto-compaction",
            status: "running",
            startedAt: Date.now(),
          },
        };
        this.timelineExtras.push(item);
        await this.emitPatch("maintenance", [
          { type: "timeline.append", item: structuredClone(item) },
        ]);
        return;
      }
      case "compaction_end":
        this.clearRunningAutoCompactionOperations();
        this.reconcileProjections();
        await this.emitSnapshotReset("maintenance", await this.commitSnapshot());
        return;
      case "tool_activity":
        await this.recordToolUiEvent(event.activity);
        return;
      case "turn_started":
      case "turn_finished":
      case "tool_call_admitted":
      case "model_retry_scheduled":
      case "model_retry_started":
      case "usage_checkpoint":
        return;
    }
  }

  private async recordToolUiEvent(event: ToolUiEvent): Promise<void> {
    const toolCallId = event.toolCallId;
    const existingTool = this.tools.get(toolCallId);
    if (!existingTool) {
      return;
    }

    const facetId = `tool-ui-${toolCallId}`;
    const existing = this.facets.get(facetId);
    const events = Array.isArray(existing?.data.events) ? existing.data.events : [];
    const facet: SessionProtocolFacet = {
      id: facetId,
      subject: { type: "tool", id: toolCallId },
      kind: "tau.tool-ui-events",
      version: 1,
      data: { events: [...events, structuredClone(event)] },
    };
    this.facets.set(facet.id, facet);

    const tool: SessionProtocolToolRun = {
      ...existingTool,
      facetIds: existingTool.facetIds.includes(facetId)
        ? existingTool.facetIds
        : [...existingTool.facetIds, facetId],
    };
    this.tools.set(tool.id, tool);

    await this.emitPatch("tool-run", [
      { type: "tool.set", tool },
      { type: "facet.set", facet: structuredClone(facet) },
    ]);
  }

  private async recordSubagentUiEvent(event: SubagentUiEvent): Promise<void> {
    const existing = "id" in event ? this.agents.get(event.id) : this.agents.get(event.state.id);
    const agent = agentRunFromSubagentEvent(event, existing);
    if (!agent) {
      return;
    }
    const previousCost = this.agentCostTotals.get(agent.id) ?? 0;
    this.costTotal += Math.max(0, agent.costTotal - previousCost);
    this.agentCostTotals.set(agent.id, agent.costTotal);
    if (!this.session.hasSubagent(agent.id)) {
      return;
    }
    this.agents.set(agent.id, agent);
    await this.emitPatch("agent-run", [
      { type: "cost.set", costTotal: this.costTotal },
      { type: "agent.set", agent: structuredClone(agent) },
    ]);
  }

  private buildAssistantPartialChanges(
    previousDraft: SessionProtocolMessage | undefined,
    nextDraft: SessionProtocolMessage,
  ): SessionProtocolChange[] {
    if (!previousDraft) {
      return [
        {
          type: "message.append",
          message: structuredClone(nextDraft),
          timelineItem: timelineItemForMessage(nextDraft.id),
        },
      ];
    }

    const appendChange = buildAssistantContentAppendChange(previousDraft, nextDraft);
    if (appendChange) {
      return [appendChange];
    }

    if (assistantDraftContentEquals(previousDraft, nextDraft)) {
      return [];
    }

    return [{ type: "message.replace", message: structuredClone(nextDraft) }];
  }

  private async emitPatch(
    reason: SessionProtocolDeltaReason,
    changes: SessionProtocolChange[],
    options: { persist?: boolean } = {},
  ): Promise<void> {
    if (changes.length === 0) {
      return;
    }
    if (!this.committedSnapshot) {
      if (options.persist === false) {
        const snapshot = { ...this.buildSnapshotDraft(), revision: 1 };
        this.committedSnapshot = snapshot;
        this.snapshotGeneration += 1;
        this.emitSnapshotReset(reason, snapshot);
        return;
      }
      const snapshot = await this.commitSnapshot();
      this.emitSnapshotReset(reason, snapshot);
      return;
    }
    const fromRevision = this.committedSnapshot.revision;
    const toRevision = fromRevision + 1;
    const delta = createSessionProtocolDeltaMessage({
      sessionId: this.committedSnapshot.sessionId,
      fromRevision,
      toRevision,
      reason,
      delta: { type: "snapshot.patch", changes },
    });
    if (options.persist === false) {
      this.committedSnapshot = applySessionProtocolDelta(this.committedSnapshot, delta);
      this.snapshotGeneration += 1;
      this.emitDelta(delta);
      return;
    }

    const snapshot = await this.commitSnapshotWithRevision(toRevision);
    this.emitDelta(
      createSessionProtocolDeltaMessage({
        sessionId: delta.sessionId,
        fromRevision,
        toRevision: snapshot.revision,
        reason,
        delta: { type: "snapshot.patch", changes },
      }),
    );
  }

  private emitSnapshotReset(
    reason: SessionProtocolDeltaReason,
    snapshot: SessionProtocolSnapshot,
  ): void {
    this.emitDelta(
      createSessionProtocolDeltaMessage({
        sessionId: snapshot.sessionId,
        fromRevision: null,
        toRevision: snapshot.revision,
        reason,
        delta: { type: "snapshot.reset", snapshot },
      }),
    );
  }

  private async emitSnapshotResetIfChanged(reason: SessionProtocolDeltaReason): Promise<void> {
    const previousRevision = this.committedSnapshot?.revision;
    const snapshot = await this.commitSnapshot();
    if (snapshot.revision !== previousRevision) {
      this.emitSnapshotReset(reason, snapshot);
    }
  }

  private emitDelta(delta: SessionProtocolDeltaMessage): void {
    for (const listener of [...this.deltaListeners]) {
      try {
        listener(delta);
      } catch {
        // Delta observers must not be able to fail the hosted session turn.
      }
    }
  }

  private emitEphemeral(message: SessionProtocolEphemeralMessage): void {
    for (const listener of [...this.ephemeralListeners]) {
      try {
        listener(message);
      } catch {
        // Ephemeral observers must not be able to fail hosted session work.
      }
    }
  }

  private syncToolRunsFromAssistantMessage(
    messageId: string,
    message: Pick<AssistantMessage, "content">,
  ): SessionProtocolChange[] {
    const changes: SessionProtocolChange[] = [];
    const toolCalls = message.content
      .map((content, index) => ({ content, index }))
      .filter(
        (item): item is { content: ToolCall; index: number } => item.content.type === "toolCall",
      );
    for (const { content, index } of toolCalls) {
      const existing = this.tools.get(content.id);
      const call = { messageId, contentIndex: index };
      if (
        existing &&
        existing.status !== "streaming" &&
        existing.toolName === content.name &&
        existing.call.messageId === call.messageId &&
        existing.call.contentIndex === call.contentIndex
      ) {
        continue;
      }

      const nextTool: SessionProtocolToolRun =
        existing && existing.status !== "streaming"
          ? { ...existing, toolName: content.name, call }
          : {
              id: content.id,
              toolCallId: content.id,
              toolName: content.name,
              status: "queued",
              call,
              facetIds: existing?.facetIds ?? [],
            };
      this.tools.set(content.id, nextTool);
      changes.push({ type: "tool.set", tool: structuredClone(nextTool) });
    }

    return changes;
  }

  private async interruptDraftAssistantMessage(): Promise<void> {
    const draft = this.draftAssistantMessage;
    if (draft?.message.role !== "assistant") {
      return;
    }

    const interruptedMessage = createInterruptedAssistantMessage(draft, this.runtime.persona.model);
    await this.session.commitInterruptedAssistant(interruptedMessage, draft.id);
  }

  private async cleanupFailedTurn(): Promise<void> {
    if (this.draftAssistantMessage) {
      await this.interruptDraftAssistantMessage();
      return;
    }

    await this.emitSnapshotResetIfChanged("assistant-message");
  }
}

function turnOutcomeFromResult(
  result: AgentTurnResult,
  assistantMessage: AssistantMessage | undefined,
): SessionProtocolTurnOutcome {
  if (result.blocked) {
    return { status: "blocked", ...result.blocked };
  }
  if (result.aborted || assistantMessage?.stopReason === "aborted") {
    return { status: "aborted", stopReason: "aborted" };
  }
  if (!assistantMessage) {
    throw new Error("session turn completed without an assistant message");
  }
  if (assistantMessage.stopReason === "error") {
    return {
      status: "failed",
      stopReason: "error",
      ...(assistantMessage.errorMessage !== undefined
        ? { errorMessage: assistantMessage.errorMessage }
        : {}),
    };
  }
  if (assistantMessage.stopReason === "pending") {
    throw new Error("session turn completed with a pending assistant message");
  }
  return { status: "completed", stopReason: assistantMessage.stopReason };
}

function cloneSessionProtocolSnapshot(snapshot: SessionProtocolSnapshot): SessionProtocolSnapshot {
  return structuredClone(snapshot);
}

function buildAssistantContentAppendChange(
  previousDraft: SessionProtocolMessage,
  nextDraft: SessionProtocolMessage,
): SessionProtocolChange | undefined {
  if (
    previousDraft.id !== nextDraft.id ||
    previousDraft.message.role !== "assistant" ||
    nextDraft.message.role !== "assistant"
  ) {
    return undefined;
  }

  const previousContent = previousDraft.message.content;
  const nextContent = nextDraft.message.content;
  const previousStaticContent = previousContent.filter(
    (content) => content.type !== "text" && content.type !== "thinking",
  );
  const nextStaticContent = nextContent.filter(
    (content) => content.type !== "text" && content.type !== "thinking",
  );
  if (JSON.stringify(previousStaticContent) !== JSON.stringify(nextStaticContent)) {
    return undefined;
  }
  if (
    previousStaticContent.length > 0 &&
    (previousContent.length !== nextContent.length ||
      previousContent.some((content, index) => content.type !== nextContent[index]!.type))
  ) {
    return undefined;
  }

  const previousText = getAssistantDraftBlockText(previousDraft, "text");
  const nextText = getAssistantDraftBlockText(nextDraft, "text");
  const previousThinking = getAssistantDraftBlockText(previousDraft, "thinking");
  const nextThinking = getAssistantDraftBlockText(nextDraft, "thinking");
  if (!nextText.startsWith(previousText) || !nextThinking.startsWith(previousThinking)) {
    return undefined;
  }

  const text = nextText.slice(previousText.length);
  const thinking = nextThinking.slice(previousThinking.length);
  if (!text && !thinking) {
    return undefined;
  }

  return {
    type: "message.content.append",
    messageId: nextDraft.id,
    ...(text ? { text } : {}),
    ...(thinking ? { thinking } : {}),
    timestamp: nextDraft.message.timestamp,
  };
}

function assistantDraftContentEquals(
  previousDraft: SessionProtocolMessage,
  nextDraft: SessionProtocolMessage,
): boolean {
  return (
    previousDraft.id === nextDraft.id &&
    previousDraft.message.role === "assistant" &&
    nextDraft.message.role === "assistant" &&
    JSON.stringify(previousDraft.message.content) === JSON.stringify(nextDraft.message.content)
  );
}

function getAssistantDraftBlockText(
  message: SessionProtocolMessage,
  type: "text" | "thinking",
): string {
  if (message.message.role !== "assistant") {
    return "";
  }
  if (type === "text") {
    return message.message.content.find((item) => item.type === "text")?.text ?? "";
  }
  return message.message.content.find((item) => item.type === "thinking")?.thinking ?? "";
}

function normalizeRecoveredSnapshot(snapshot: SessionProtocolSnapshot): {
  snapshot: SessionProtocolSnapshot;
  changed: boolean;
} {
  const recovered = cloneSessionProtocolSnapshot(snapshot);
  let changed = recovered.lifecycle !== "idle";
  recovered.lifecycle = "idle";
  const streamingToolIds = new Set(
    Object.values(recovered.tools)
      .filter((tool) => tool.status === "streaming")
      .map((tool) => tool.id),
  );
  if (streamingToolIds.size > 0) {
    changed = true;
    recovered.tools = Object.fromEntries(
      Object.entries(recovered.tools).filter(([id]) => !streamingToolIds.has(id)),
    );
    recovered.facets = Object.fromEntries(
      Object.entries(recovered.facets).filter(
        ([, facet]) => facet.subject.type !== "tool" || !streamingToolIds.has(facet.subject.id),
      ),
    );
  }
  let recoveredAgentHistory = false;
  recovered.messages = recovered.messages.map((message) => {
    if (message.state !== "draft" || message.message.role !== "assistant") {
      return message;
    }
    changed = true;
    recoveredAgentHistory = true;
    return {
      id: message.id,
      state: "interrupted",
      modelVisible: true,
      message: createInterruptedAssistantMessageFromModelSnapshot(
        message,
        recovered.bootstrap.model,
      ),
    };
  });
  if (recoveredAgentHistory) {
    recovered.agentState = {
      revision: recovered.agentState.revision + 1,
      contextEpoch: recovered.agentState.contextEpoch,
      ...(recovered.agentState.usageCheckpoint
        ? { usageCheckpoint: { ...recovered.agentState.usageCheckpoint } }
        : {}),
    };
  }
  return { snapshot: recovered, changed };
}

function promptCompositionFromSnapshot(
  snapshot: SessionProtocolSnapshot,
): SessionPromptComposition {
  const systemMessage = snapshot.messages[0];
  if (systemMessage?.message.role !== "system") {
    throw new Error(`session snapshot '${snapshot.sessionId}' is missing its system message`);
  }
  return {
    baseSystemPrompt: systemMessage.message.content,
    environmentTag: snapshot.bootstrap.prompt.environmentTag,
    subagentPrompts: cloneSubagentPrompts(snapshot.bootstrap.prompt.subagentPrompts),
  };
}

function cloneSubagentPrompts(subagentPrompts: Record<string, string>): Record<string, string> {
  return { ...subagentPrompts };
}

function timelineItemForMessage(messageId: string): SessionProtocolTimelineItem {
  return {
    type: "message",
    id: `timeline-${messageId}`,
    messageId,
  };
}

function isCoreMessage(message: SessionProtocolMessage["message"]): message is Message {
  switch (message.role) {
    case "user":
      return typeof message.content === "string" || Array.isArray(message.content);
    case "assistant":
      return (
        Array.isArray(message.content) &&
        "api" in message &&
        typeof message.provider === "string" &&
        typeof message.model === "string" &&
        "usage" in message &&
        typeof message.stopReason === "string"
      );
    case "toolResult":
      return (
        typeof message.toolCallId === "string" &&
        typeof message.toolName === "string" &&
        typeof message.isError === "boolean" &&
        Array.isArray(message.content)
      );
    default:
      return false;
  }
}

function createInterruptedAssistantMessage(
  draft: SessionProtocolMessage,
  model: Model<Api>,
): AssistantMessage {
  if (draft.message.role !== "assistant") {
    throw new Error(`cannot interrupt non-assistant message '${draft.id}'`);
  }
  const timestamp = draft.message.timestamp;
  return {
    role: "assistant",
    content: structuredClone(draft.message.content),
    api: model.api,
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "aborted",
    timestamp,
  };
}

function createInterruptedAssistantMessageFromModelSnapshot(
  draft: SessionProtocolMessage,
  model: SessionProtocolModelSnapshot,
): AssistantMessage {
  if (draft.message.role !== "assistant") {
    throw new Error(`cannot interrupt non-assistant message '${draft.id}'`);
  }
  return {
    role: "assistant",
    content: structuredClone(draft.message.content),
    api: model.api as AssistantMessage["api"],
    provider: model.provider,
    model: model.id,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    stopReason: "aborted",
    timestamp: draft.message.timestamp,
  };
}

function agentRunFromSubagentEvent(
  event: SubagentUiEvent,
  existing?: SessionProtocolAgentRun,
): SessionProtocolAgentRun | undefined {
  const state =
    event.type === "subagent_spawned" || event.type === "subagent_finished"
      ? event.state
      : undefined;
  if (event.type === "subagent_progress" && existing) {
    return {
      ...existing,
      costTotal: event.costTotal,
      turns: event.turns,
      toolCalls: event.toolCalls,
      usage: { ...event.usage },
      progress: event.text,
    };
  }
  if (event.type === "subagent_abort_requested" && existing) {
    return { ...existing, abortRequested: true };
  }
  if (!state) {
    return undefined;
  }
  return {
    id: state.id,
    name: state.name,
    title: state.title,
    status:
      state.status === "success"
        ? "succeeded"
        : state.status === "error"
          ? "failed"
          : state.status === "aborted"
            ? "cancelled"
            : "running",
    ...(state.modelLabel !== undefined ? { modelLabel: state.modelLabel } : {}),
    costTotal: state.costTotal,
    turns: state.turns,
    toolCalls: state.toolCalls,
    usage: { ...state.usage },
    startedAt: state.startedAt,
    ...(state.finishedAt !== undefined ? { finishedAt: state.finishedAt } : {}),
    abortRequested: state.abortRequested,
    ...(state.finalText !== undefined ? { finalText: state.finalText } : {}),
    ...(state.error !== undefined ? { error: state.error } : {}),
  };
}

function cloneResolvedBootstrap(
  bootstrap: LocalSessionResolvedBootstrap,
): LocalSessionResolvedBootstrap {
  return {
    persona: clonePersona(bootstrap.persona),
    discoveredSkills: structuredClone(bootstrap.discoveredSkills),
    personas: bootstrap.personas.map(clonePersona),
    prompts: structuredClone(bootstrap.prompts),
    modelResolver: bootstrap.modelResolver,
    ...(bootstrap.config !== undefined ? { config: structuredClone(bootstrap.config) } : {}),
  };
}

function createContentCatalogSnapshot(
  bootstrap: LocalSessionResolvedBootstrap,
): SessionProtocolContentCatalogSnapshot {
  return {
    personas: bootstrap.personas.map(personaSnapshotFromPersona),
    prompts: bootstrap.prompts.map((prompt) => ({
      id: prompt.id,
      ...(prompt.label !== undefined ? { label: prompt.label } : {}),
      ...(prompt.description !== undefined ? { description: prompt.description } : {}),
    })),
    skills: bootstrap.discoveredSkills.map((skill) => ({
      name: skill.name,
      description: skill.description,
      path: skill.path,
    })),
  };
}

function clonePersona(persona: Persona): Persona {
  return structuredClone(persona);
}

function personaSnapshotFromPersona(persona: Persona): SessionProtocolPersonaSnapshot {
  return {
    id: persona.id,
    label: persona.label,
    ...(persona.description !== undefined ? { description: persona.description } : {}),
    ...(persona.allowedReasoningLevels
      ? { allowedReasoningLevels: [...persona.allowedReasoningLevels] }
      : {}),
    ...(persona.subagents ? { subagents: subagentSnapshotsFromConfig(persona.subagents) } : {}),
    ...(persona.tools ? { tools: [...persona.tools] } : {}),
    skills: Array.isArray(persona.skills) ? [...persona.skills] : persona.skills,
    source: persona.source,
  };
}

function modelSnapshotFromModel(model: Model<Api>): SessionProtocolModelSnapshot {
  const thinkingLevelMap = model.thinkingLevelMap
    ? Object.fromEntries(
        Object.entries(model.thinkingLevelMap).filter((entry) => entry[1] !== undefined),
      )
    : undefined;
  return {
    id: model.id,
    name: model.name,
    api: model.api,
    provider: model.provider,
    baseUrl: model.baseUrl,
    reasoning: model.reasoning,
    ...(thinkingLevelMap && Object.keys(thinkingLevelMap).length > 0 ? { thinkingLevelMap } : {}),
    input: [...model.input],
    cost: {
      ...model.cost,
      ...(model.cost.tiers ? { tiers: model.cost.tiers.map((tier) => ({ ...tier })) } : {}),
    },
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    ...(model.compat !== undefined ? { compat: structuredClone(model.compat) } : {}),
  };
}

function subagentSnapshotsFromConfig(
  subagents: NonNullable<Persona["subagents"]>,
): Record<string, SessionProtocolSubagentSnapshot> {
  const snapshots: Record<string, SessionProtocolSubagentSnapshot> = {};
  for (const [name, config] of Object.entries(subagents)) {
    snapshots[name] = {
      ...(config.description !== undefined ? { description: config.description } : {}),
      ...(config.tools ? { tools: [...config.tools] } : {}),
      ...(config.launchModels ? { launchModels: [...config.launchModels] } : {}),
    };
  }
  return snapshots;
}
