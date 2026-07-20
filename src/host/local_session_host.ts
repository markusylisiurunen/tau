import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { Api, AssistantMessage, Message, Model, ToolCall } from "@earendil-works/pi-ai";
import { type Config, resolvePromptTemplateWithBackend } from "../core/config/index.js";
import type { CoreEvent } from "../core/events/types.js";
import type { ModelResolver } from "../core/models/catalog.js";
import type { PromptTemplate } from "../core/prompts.js";
import { ChatRuntime, type ChatRuntimeEnvironment } from "../core/runtime/chat_runtime.js";
import type { CoreDeps } from "../core/runtime/deps.js";
import type { RuntimePromptBootstrap } from "../core/runtime/runtime_bootstrap.js";
import type { SessionPromptComposition } from "../core/runtime/session_prompt_composer.js";
import type { CoreSession } from "../core/session/core_session.js";
import type { SubagentUiEvent } from "../core/subagents/types.js";
import type { ToolUiEvent } from "../core/tools/registry.js";
import type { Persona, ReasoningEffort, Skill } from "../core/types.js";
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
  SessionProtocolPruneParams,
  SessionProtocolPruneResult,
  SessionProtocolRecordParams,
  SessionProtocolRecordResult,
  SessionProtocolReloadResult,
  SessionProtocolResolvePromptParams,
  SessionProtocolResolvePromptResult,
  SessionProtocolRewindResult,
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
import type { TauHostedSession, TauSessionHost } from "./session_host.js";

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
  session: CoreSession;
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
      hostedSession.session.restoreState({
        sessionId: recovered.snapshot.sessionId,
        historyEntries: recovered.snapshot.messages.flatMap((entry) =>
          entry.modelVisible && isCoreMessage(entry.message)
            ? [{ id: entry.id, message: entry.message }]
            : [],
        ),
      });
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
    const runtime = ChatRuntime.create({
      persona: bootstrap.persona,
      toolRegistry: runtimeContext.toolRegistry,
      clientToolDefinitions: (sessionId) => this.clientToolBroker.getToolDefinitions(sessionId),
      modelResolver: bootstrap.modelResolver,
      resolveSubagentRuntime: createExecutionEnvironmentSubagentRuntimeResolver({
        executionEnvironment,
        includeAgentContext: this.sessionOptions.includeAgentContext,
        now: this.sessionOptions.environment.now,
      }),
      promptContext: runtimeContext.promptBootstrap.promptContext,
      environment: this.sessionOptions.environment,
      initialPromptComposition: committedSnapshot
        ? promptCompositionFromSnapshot(committedSnapshot)
        : undefined,
      config: bootstrap.config,
      deps: this.sessionOptions.deps,
    });

    const hostedSession = new LocalHostedSessionHandle(
      runtime,
      runtimeContext.promptBootstrap,
      catalog,
      bootstrap,
      this.sessionOptions.includeAgentContext,
      executionEnvironment,
      this.store,
      committedSnapshot,
      forceNextSnapshotRevision,
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
      session.interruptTurn();
      session.interruptMaintenance();
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
  readonly session: CoreSession;
  private committedSessionId: string;
  private committedSnapshot?: SessionProtocolSnapshot;
  private persistedSnapshot?: SessionProtocolSnapshot;
  private draftAssistantMessage?: SessionProtocolMessage;
  private readonly messageStates = new Map<string, SessionProtocolMessage["state"]>();
  private readonly turnOutcomes = new Map<string, SessionProtocolTurnOutcome>();
  private lastTurnAssistantMessage?: AssistantMessage;
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
  private readonly unsubscribeSubagentEvent: () => void;
  private runtimeEventQueue: Promise<void> = Promise.resolve();
  private snapshotQueue: Promise<unknown> = Promise.resolve();
  private snapshotGeneration = 0;
  private readonly maintenanceAbortControllers = new Set<AbortController>();
  private readonly maintenancePromises = new Set<Promise<unknown>>();
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
    committedSnapshot?: SessionProtocolSnapshot,
    forceNextSnapshotRevision = false,
    private readonly removeFromHost: (session: LocalHostedSessionHandle) => void = () => {},
  ) {
    this.session = runtime.session;
    this.committedSessionId = committedSnapshot?.sessionId ?? this.session.sessionId;
    this.committedSnapshot = committedSnapshot
      ? cloneSessionProtocolSnapshot(committedSnapshot)
      : undefined;
    this.persistedSnapshot = committedSnapshot
      ? cloneSessionProtocolSnapshot(committedSnapshot)
      : undefined;
    this.forceNextSnapshotRevision = forceNextSnapshotRevision;
    this.restoreProtocolState(committedSnapshot);
    this.unsubscribeSubagentEvent = this.session.onSubagentEvent((event) => {
      void this.enqueueRuntimeEvent(event).catch(() => undefined);
    });
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
    const userHistoryEntryId = this.session.addUserText(
      options.text,
      options.historyEntryId ? { historyEntryId: options.historyEntryId } : undefined,
    );
    const snapshot = await this.commitSnapshot();
    this.emitSnapshotReset("user-message", snapshot);
    return {
      snapshot,
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
    const userHistoryEntryId = this.currentTurnUserHistoryEntryId();
    this.lastTurnAssistantMessage = undefined;
    try {
      const result = await this.runtime.runTurn({
        onEvent: (event) => this.recordTurnRuntimeEvent(event),
      });
      if (result.aborted && this.draftAssistantMessage) {
        await this.interruptDraftAssistantMessage();
      }
      const outcome = turnOutcomeFromResult(result, this.lastTurnAssistantMessage);
      this.turnOutcomes.set(userHistoryEntryId, outcome);
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

  interruptMaintenance(): boolean {
    let interrupted = false;
    for (const abortController of this.maintenanceAbortControllers) {
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
      ...this.maintenancePromises,
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

  async exec(
    options: Omit<SessionProtocolExecParams, "sessionId"> & {
      signal?: AbortSignal;
    },
  ): Promise<SessionProtocolExecResult> {
    this.assertActive();
    const backend = this.executionEnvironment.getToolExecutionBackend();
    return await backend.runBash(options.command, {
      ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
      ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    });
  }

  async setReasoning(reasoning: ReasoningEffort): Promise<SessionProtocolSettingsUpdateResult> {
    this.assertActive();
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
          fromRevision: snapshot.revision - 1,
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

  async pruneToolResults(
    options: Omit<SessionProtocolPruneParams, "sessionId">,
  ): Promise<SessionProtocolPruneResult> {
    return await this.runMaintenance(async (signal) => {
      const result = await this.session.pruneToolResults({
        strategy: options.strategy,
        fraction: options.fraction,
        ...(options.guidance !== undefined ? { guidance: options.guidance } : {}),
        signal,
      });

      signal.throwIfAborted();
      this.reconcileProjections({ prunedToolResults: result.prunedToolResults });
      const snapshot = await this.commitSnapshot();
      this.emitSnapshotReset("maintenance", snapshot);
      return {
        snapshot,
        message: result.message,
        noop: result.noop,
        bashResultsPruned: result.bashResultsPruned,
        editCallsPruned: result.editCallsPruned,
        editResultsPruned: result.editResultsPruned,
        bytesPruned: result.bytesPruned,
      };
    });
  }

  private async runMaintenance<T>(operation: (signal: AbortSignal) => Promise<T>): Promise<T> {
    this.assertActive();
    const abortController = new AbortController();
    this.maintenanceAbortControllers.add(abortController);
    const promise = operation(abortController.signal);
    this.maintenancePromises.add(promise);
    try {
      return await promise;
    } finally {
      this.maintenanceAbortControllers.delete(abortController);
      this.maintenancePromises.delete(promise);
    }
  }

  async rewindToHistoryEntryId(historyEntryId: string): Promise<SessionProtocolRewindResult> {
    this.assertActive();
    const result = this.session.rewindToHistoryEntryId(historyEntryId);
    if (!result) {
      throw new Error("rewind failed");
    }

    await this.runtimeEventQueue;
    this.reconcileProjections({ removeMissingAgents: true });
    const snapshot = await this.commitSnapshot();
    this.emitSnapshotReset("maintenance", snapshot);
    return {
      snapshot,
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
      modelResolver: this.bootstrap.modelResolver,
      discoveredSkills: this.bootstrap.discoveredSkills,
      includeAgentContext: this.includeAgentContext,
      executionEnvironment: this.executionEnvironment,
      instructions: options.instructions,
      tools: options.tools,
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
    this.runtime.interruptTurn();
    this.interruptMaintenance();
    try {
      await this.waitForActiveWork();
    } catch (error) {
      errors.push(error);
    }

    this.disposed = true;
    try {
      this.unsubscribeSubagentEvent();
    } catch (error) {
      errors.push(error);
    }
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

  private reconcileProjections(
    options: {
      prunedToolResults?: readonly { toolCallId: string; content: string }[];
      removeMissingAgents?: boolean;
    } = {},
  ): void {
    const messageIds = new Set(this.session.rawHistoryEntries.map((entry) => entry.id));
    messageIds.add("system");

    for (const [id, tool] of this.tools) {
      if (
        !messageIds.has(tool.call.messageId) ||
        (tool.resultMessageId !== undefined && !messageIds.has(tool.resultMessageId))
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
    const prunedByToolId = new Map(
      (options.prunedToolResults ?? []).map((result) => [result.toolCallId, result.content]),
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
        continue;
      }

      if (facet.subject.type === "tool") {
        const toolCallId = facet.subject.id;
        const content = prunedByToolId.get(toolCallId);
        if (content !== undefined && facet.kind === "tau.tool-ui-events") {
          this.facets.set(id, {
            ...facet,
            data: {
              events: [{ type: "tool_pruned", toolCallId, content }],
            },
          });
        }
      }
    }
  }

  private buildSnapshotDraft(): Omit<SessionProtocolSnapshot, "revision"> {
    const messages = this.buildProtocolMessages();
    return {
      sessionId: this.session.sessionId,
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

  private currentTurnUserHistoryEntryId(): string {
    const entry = this.session.rawHistoryEntries.findLast(
      (candidate) => candidate.message.role === "user",
    );
    if (!entry) {
      throw new Error("cannot run a turn without a user message");
    }
    return entry.id;
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

  private enqueueRuntimeEvent(event: CoreEvent): Promise<void> {
    const write = this.runtimeEventQueue
      .catch(() => undefined)
      .then(() => this.recordRuntimeEvent(event));
    this.runtimeEventQueue = write.catch(() => undefined);
    return write;
  }

  private async recordRuntimeEvent(event: CoreEvent): Promise<void> {
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
      case "assistant_final": {
        this.draftAssistantMessage = undefined;
        this.messageStates.delete(event.historyEntryId);
        const toolChanges = this.syncToolRunsFromAssistantMessage(
          event.historyEntryId,
          event.message,
        );
        this.costTotal += event.message.usage?.cost?.total ?? 0;
        await this.emitPatch("assistant-message", [
          { type: "cost.set", costTotal: this.costTotal },
          {
            type: "message.replace",
            message: {
              id: event.historyEntryId,
              state: "committed",
              modelVisible: true,
              message: event.message,
            },
          },
          ...toolChanges,
        ]);
        return;
      }
      case "tool_result": {
        const existing = this.tools.get(event.message.toolCallId);
        if (existing) {
          const nextTool: SessionProtocolToolRun = {
            ...existing,
            status: event.message.isError ? "failed" : "succeeded",
            finishedAt: event.message.timestamp,
            resultMessageId: event.historyEntryId,
          };
          this.tools.set(nextTool.id, nextTool);
          await this.emitPatch("tool-result", [
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
          if (!existing) {
            throw new Error(`missing protocol tool run for '${toolResult.toolCallId}'`);
          }
          const nextTool: SessionProtocolToolRun = {
            ...existing,
            status: toolResult.isError ? "failed" : "succeeded",
            finishedAt: toolResult.timestamp,
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
      case "tool_ui":
        await this.recordToolUiEvent(event.uiEvent);
        return;
      case "subagent_ui":
        await this.recordSubagentUiEvent(event.event);
        return;
    }
  }

  private async recordTurnRuntimeEvent(event: CoreEvent): Promise<void> {
    if (event.type === "assistant_final") {
      this.lastTurnAssistantMessage = event.message;
    }
    await this.enqueueRuntimeEvent(event);
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

    const tool = this.updateToolRunFromUiEvent(existingTool, event);
    this.tools.set(tool.id, tool);

    await this.emitPatch("tool-run", [
      { type: "tool.set", tool },
      { type: "facet.set", facet: structuredClone(facet) },
    ]);
  }

  private updateToolRunFromUiEvent(
    tool: SessionProtocolToolRun,
    event: ToolUiEvent,
  ): SessionProtocolToolRun {
    const next: SessionProtocolToolRun = {
      ...tool,
      facetIds: tool.facetIds.includes(`tool-ui-${tool.toolCallId}`)
        ? tool.facetIds
        : [...tool.facetIds, `tool-ui-${tool.toolCallId}`],
    };
    if (event.type.endsWith("_started") || event.type === "tool_call_queued") {
      next.status = event.type === "tool_call_queued" ? "queued" : "running";
      next.startedAt ??= Date.now();
    } else if (event.type.endsWith("_blocked")) {
      next.status = "blocked";
      next.finishedAt = Date.now();
    } else if (event.type.endsWith("_finished")) {
      next.status = "status" in event && event.status === "error" ? "failed" : "succeeded";
      next.finishedAt = Date.now();
    } else if (event.type === "bash_aborted") {
      next.status = "cancelled";
      next.finishedAt = Date.now();
    }
    return next;
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
      const nextTool: SessionProtocolToolRun = {
        ...(existing ?? {
          id: content.id,
          toolCallId: content.id,
          status: "queued" as const,
          facetIds: [],
        }),
        toolName: content.name,
        call: {
          messageId,
          contentIndex: index,
        },
      };
      if (
        existing?.toolName === nextTool.toolName &&
        existing.call.messageId === nextTool.call.messageId &&
        existing.call.contentIndex === nextTool.call.contentIndex
      ) {
        continue;
      }
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
    this.session.addMessage(interruptedMessage, { historyEntryId: draft.id });
    this.messageStates.set(draft.id, "interrupted");
    this.draftAssistantMessage = undefined;
    await this.emitPatch("assistant-stream", [
      {
        type: "message.replace",
        message: {
          id: draft.id,
          state: "interrupted",
          modelVisible: true,
          message: interruptedMessage,
        },
      },
      { type: "lifecycle.set", lifecycle: "idle" },
    ]);
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
  result: {
    aborted: boolean;
    blocked?: { reason: "auto-compaction-failed"; message: string };
  },
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
  recovered.messages = recovered.messages.map((message) => {
    if (message.state !== "draft" || message.message.role !== "assistant") {
      return message;
    }
    changed = true;
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
  if (event.type === "subagent_emit_output" && existing) {
    return { ...existing, progress: event.text };
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
