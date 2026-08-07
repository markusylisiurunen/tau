import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import type { Api, AssistantMessage, Message, Model, ToolCall } from "@earendil-works/pi-ai";
import type { AgentStateRecovery, AgentSubturnResult } from "../core/agent/agent_runtime.js";
import type { AgentEvent, AgentTurnFailure } from "../core/agent/events.js";
import { type Config, resolvePromptTemplateWithBackend } from "../core/config/index.js";
import type { HistoryManager } from "../core/history/history_manager.js";
import {
  assistantHistoryEntries,
  toolHistoryEntry,
  userHistoryEntry,
} from "../core/history/transcript.js";
import type { HistoryRemoteTarget } from "../core/history/types.js";
import type { ModelResolver } from "../core/models/catalog.js";
import type { PromptTemplate } from "../core/prompts.js";
import { ChatRuntime, type ChatRuntimeEnvironment } from "../core/runtime/chat_runtime.js";
import type { CoreDeps } from "../core/runtime/deps.js";
import type { RuntimePromptBootstrap } from "../core/runtime/runtime_bootstrap.js";
import type { SessionPromptComposition } from "../core/runtime/session_prompt_composer.js";
import { formatSteeringUserMessage } from "../core/runtime/steering.js";
import { buildGoalContinuationText, prependGoalPolicy } from "../core/session/goal.js";
import { SUBAGENT_ACTIVITY_FACET_KIND, type SubagentUiEvent } from "../core/subagents/types.js";
import type { ToolActivity } from "../core/tools/activity.js";
import { buildToolRunPresentation, TOOL_UI_FACET_VERSION } from "../core/tools/presentation.js";
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
import { hasGoalTurnMetadata } from "../core/utils/user_metadata.js";
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
  SessionProtocolDeltaCause,
  SessionProtocolDeltaMessage,
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
  SessionProtocolGoal,
  SessionProtocolInterruptSubagentResult,
  SessionProtocolMessage,
  SessionProtocolModelSnapshot,
  SessionProtocolOperation,
  SessionProtocolPersonaSnapshot,
  SessionProtocolRecordParams,
  SessionProtocolRecordResult,
  SessionProtocolReloadResult,
  SessionProtocolResolvePromptParams,
  SessionProtocolResolvePromptResult,
  SessionProtocolResumeGoalResult,
  SessionProtocolRewindResult,
  SessionProtocolSampleParams,
  SessionProtocolSampleResult,
  SessionProtocolSessionSummary,
  SessionProtocolSettingsUpdateResult,
  SessionProtocolSnapshot,
  SessionProtocolStartGoalResult,
  SessionProtocolSubagentSnapshot,
  SessionProtocolTimelineItem,
  SessionProtocolTimelineNotice,
  SessionProtocolToolRun,
  SessionProtocolTurnOutcome,
  SessionProtocolTurnRecord,
  SessionProtocolUserMessageTurnResult,
} from "../protocol/session_protocol.js";
import {
  applySessionProtocolDelta,
  createSessionProtocolDeltaMessage,
  createSessionProtocolEphemeralMessage,
  projectSessionProtocolNoticePresentation,
} from "../protocol/session_protocol.js";
import { LEGACY_SESSION_MODEL_CONTEXT_KEY } from "../store/session_snapshot_migrations.js";
import type { SessionStore } from "../store/session_store.js";
import { ClientToolBroker } from "./client_tool_broker.js";
import { createExecutionEnvironmentSubagentPromptResolver } from "./execution_runtime.js";
import { HostedEphemeralAgentSession } from "./hosted_ephemeral_agent_session.js";
import {
  SessionExecBusyError,
  SessionRetryUnavailableError,
  type TauHostedSession,
  type TauSessionHost,
} from "./session_host.js";

const PATH_AUTOCOMPLETE_CACHE_TTL_MS = 5_000;
const HISTORY_UNAVAILABLE_NOTICE_ID = "notice-history-unavailable";

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
  history: HistoryManager;
  historyRemote?: HistoryRemoteTarget;
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
  private readonly history: HistoryManager;
  private readonly historyRemote?: HistoryRemoteTarget;
  private readonly clientToolBroker = new ClientToolBroker();
  private readonly sessionOptions: LocalSessionHostSessionOptions;
  private shutdownPromise?: Promise<void>;
  private shuttingDown = false;

  constructor(options: LocalSessionHostOptions) {
    const { store, history, historyRemote, ...sessionOptions } = options;
    this.store = store;
    this.history = history;
    this.historyRemote = historyRemote;
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
        modelContextKey: recovered.snapshot.agentState.modelContextKey,
        historyEntries: recovered.snapshot.messages.flatMap((entry) =>
          entry.modelVisible && isCoreMessage(entry.message)
            ? [{ id: entry.id, message: entry.message }]
            : [],
        ),
        ...(recovered.snapshot.agentState.usageCheckpoint
          ? { usageCheckpoint: { ...recovered.snapshot.agentState.usageCheckpoint } }
          : {}),
      });
      if (recovered.changed || agentRecovery.recoveredToolResults.length > 0) {
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
      createParams,
      forceNextSnapshotRevision,
    );
  }

  private async createLocalSessionHandleFromRuntimeContext(
    executionEnvironment: ExecutionEnvironment,
    runtimeContext: Awaited<ReturnType<ExecutionEnvironment["resolveRuntimeContext"]>>,
    bootstrap: LocalSessionResolvedBootstrap,
    catalog: SessionProtocolContentCatalogSnapshot,
    committedSnapshot?: SessionProtocolSnapshot,
    createParams?: SessionProtocolCreateParams,
    forceNextSnapshotRevision = false,
  ): Promise<LocalHostedSessionHandle> {
    let hostedSession: LocalHostedSessionHandle;
    const runtime = ChatRuntime.create({
      persona: bootstrap.persona,
      backend: executionEnvironment.getToolExecutionBackend(),
      clientTools: (sessionId) => this.clientToolBroker.getToolDefinitions(sessionId),
      modelResolver: bootstrap.modelResolver,
      resolveSubagentPrompts: createExecutionEnvironmentSubagentPromptResolver({
        executionEnvironment,
        includeAgentContext: this.sessionOptions.includeAgentContext,
        now: this.sessionOptions.environment.now,
      }),
      promptContext: runtimeContext.promptBootstrap.promptContext,
      environment: this.sessionOptions.environment,
      eventSink: async (event) => await hostedSession.enqueueRuntimeEvent(event),
      subagentEventSink: async (event) => await hostedSession.recordSubagentEvent(event),
      goalManager: {
        getGoal: () => hostedSession.getGoal(),
        createGoal: async (objective) => await hostedSession.createGoal(objective),
        updateGoal: async (update) => await hostedSession.updateGoal(update),
      },
      history: this.history.query(this.historyRemote),
      initialPromptComposition: committedSnapshot
        ? promptCompositionFromSnapshot(committedSnapshot)
        : undefined,
      config: bootstrap.config ?? {},
      recordUsage: this.sessionOptions.recordUsage,
      deps: this.sessionOptions.deps,
    });

    const attributes = committedSnapshot?.attributes ?? createParams?.attributes;
    if (!attributes) {
      throw new Error("session attributes are required");
    }
    const createdAt = committedSnapshot?.createdAt ?? this.sessionOptions.environment.now();
    hostedSession = new LocalHostedSessionHandle(
      runtime,
      runtimeContext.promptBootstrap,
      catalog,
      bootstrap,
      this.sessionOptions.includeAgentContext,
      executionEnvironment,
      this.store,
      this.history,
      this.historyRemote,
      attributes,
      createdAt,
      committedSnapshot,
      forceNextSnapshotRevision,
      this.sessionOptions.recordUsage ?? appendUsageLogEntry,
      (session) => this.sessions.delete(session),
    );
    const historyFailure = this.history.registerSession(
      {
        sessionId: committedSnapshot?.sessionId ?? hostedSession.sessionId,
        attributes,
        createdAt,
      },
      this.historyRemote,
    );
    await hostedSession.recordHistoryFailure(historyFailure);
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

    await this.history.flush();
    try {
      this.history.close();
    } catch (error) {
      errors.push(error);
    }

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

type HostedSteeringAssociation = { userHistoryEntryId: string };
type HostedSteeringResult = HostedSteeringAssociation & {
  turn: SessionProtocolTurnOutcome;
};

type BufferedLogicalSteering = {
  id: string;
  text: string;
  applied: Promise<HostedSteeringAssociation>;
  result: Promise<HostedSteeringResult>;
  resolveApplied: (association: HostedSteeringAssociation) => void;
  resolveResult: (result: HostedSteeringResult) => void;
  rejectApplied: (error: Error) => void;
  rejectResult: (error: Error) => void;
};

type CommittedLogicalSteering = {
  historyEntryId: string;
  submissions: BufferedLogicalSteering[];
};

type ActiveLogicalTurn = {
  cancellationRequested: boolean;
  pendingSteering: BufferedLogicalSteering[];
};

type SessionProtocolSimpleDeltaCause = Exclude<
  SessionProtocolDeltaCause,
  { type: "compaction" | "rewind" | "resync" }
>["type"];

type LocalDeltaCause = SessionProtocolSimpleDeltaCause | SessionProtocolDeltaCause;
type TurnFailureNotice = AgentTurnFailure | { reason: "runtime-error"; message: string };

function normalizeDeltaCause(cause: LocalDeltaCause): SessionProtocolDeltaCause {
  return typeof cause === "string" ? { type: cause } : cause;
}

class LocalHostedSessionHandle implements LocalHostedSession {
  readonly session: ChatRuntime;
  private committedSessionId: string;
  private committedSnapshot?: SessionProtocolSnapshot;
  private persistedSnapshot?: SessionProtocolSnapshot;
  private draftAssistantMessage?: SessionProtocolMessage;
  private readonly messageStates = new Map<string, SessionProtocolMessage["state"]>();
  private timeline: SessionProtocolSnapshot["timeline"] = { epoch: 1, sequence: 0, items: [] };
  private readonly turns = new Map<string, SessionProtocolTurnRecord>();
  private readonly pendingAcceptedTurnHistoryEntryIds = new Set<string>();
  private readonly tools = new Map<string, SessionProtocolToolRun>();
  private readonly operations = new Map<string, SessionProtocolOperation>();
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
  private mutationQueue: Promise<void> = Promise.resolve();
  private readonly activeWorkAbortControllers = new Set<AbortController>();
  private readonly activeWorkPromises = new Set<Promise<unknown>>();
  private readonly activeExecAbortControllers = new Map<string, AbortController>();
  private activeTurnPromise?: Promise<unknown>;
  private activeLogicalTurn?: ActiveLogicalTurn;
  private disposePromise?: Promise<void>;
  private disposing = false;
  private costTotal = 0;
  private goal: SessionProtocolGoal | null;
  private pendingGoalCommit?: SessionProtocolGoal;
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
    private readonly history: HistoryManager,
    private readonly historyRemote: HistoryRemoteTarget | undefined,
    private readonly attributes: Record<string, string>,
    private readonly createdAt: number,
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
    this.goal = structuredClone(committedSnapshot?.goal ?? null);
    this.forceNextSnapshotRevision = forceNextSnapshotRevision;
    this.restoreProtocolState(committedSnapshot);
  }

  get isTurnRunning(): boolean {
    return this.runtime.isTurnRunning;
  }

  get canAcceptSteering(): boolean {
    return (
      this.runtime.isTurnRunning ||
      Boolean(this.activeLogicalTurn && this.goal?.status === "active")
    );
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

  getGoal(): SessionProtocolGoal | null {
    return structuredClone(this.goal);
  }

  async createGoal(objective: string): Promise<SessionProtocolGoal> {
    const goal = this.buildNewGoal(objective);
    await this.setGoal(goal);
    return structuredClone(goal);
  }

  async updateGoal(update: {
    objective?: string;
    status?: "complete" | "blocked";
  }): Promise<SessionProtocolGoal | null> {
    this.assertActive();
    const current = this.goal;
    if (!current) {
      throw new Error("no goal exists");
    }
    if (update.objective !== undefined && update.status === "complete") {
      throw new Error("goal objective cannot be updated while completing the goal");
    }
    if (update.status === "complete") {
      await this.setGoal(null);
      return null;
    }
    const objective = update.objective?.trim() ?? current.objective;
    if (!objective) {
      throw new Error("goal objective must not be empty");
    }
    const goal: SessionProtocolGoal = {
      objective,
      status: update.status ?? current.status,
    };
    await this.setGoal(goal);
    return structuredClone(goal);
  }

  async startGoal(objective: string): Promise<SessionProtocolStartGoalResult> {
    const goal = this.buildNewGoal(objective);
    return await this.runLogicalTurn(async (logicalTurn) => {
      await this.enqueueMutation(() => {
        this.goal = goal;
        this.pendingGoalCommit = goal;
      });
      try {
        const { userHistoryEntryId } = await this.acceptTurn({
          text: prependGoalPolicy(goal.objective, goal),
        });
        const turn = logicalTurn.cancellationRequested
          ? await this.cancelLogicalTurn()
          : await this.runTurnNow(logicalTurn, userHistoryEntryId);
        await this.settleTurn(userHistoryEntryId, turn);
        return { userHistoryEntryId, turn };
      } catch (error) {
        if (this.pendingGoalCommit === goal) {
          await this.enqueueMutation(() => {
            this.goal = null;
            this.pendingGoalCommit = undefined;
          });
        } else {
          await this.blockActiveGoal().catch(() => undefined);
        }
        throw error;
      }
    });
  }

  async resumeGoal(): Promise<SessionProtocolResumeGoalResult> {
    this.assertActive();
    if (this.goal?.status !== "blocked") {
      throw new Error(this.goal ? "goal is already active" : "no goal exists");
    }
    const goal: SessionProtocolGoal = { ...this.goal, status: "active" };
    return await this.runLogicalTurn(async (logicalTurn) => {
      await this.setGoal(goal);
      try {
        if (logicalTurn.cancellationRequested) {
          await this.blockActiveGoal();
          return { turn: abortedTurnOutcome() };
        }
        const { userHistoryEntryId } = await this.acceptTurn({
          text: buildGoalContinuationText(goal),
        });
        const turn = logicalTurn.cancellationRequested
          ? await this.cancelLogicalTurn()
          : await this.runTurnNow(logicalTurn, userHistoryEntryId);
        await this.settleTurn(userHistoryEntryId, turn);
        return { turn };
      } catch (error) {
        await this.blockActiveGoal().catch(() => undefined);
        throw error;
      }
    });
  }

  async clearGoal(): Promise<SessionProtocolSnapshot> {
    this.assertActive();
    if (!this.goal) {
      throw new Error("no goal exists");
    }
    await this.setGoal(null);
    return await this.snapshot();
  }

  async record(
    options: Omit<SessionProtocolRecordParams, "sessionId">,
  ): Promise<SessionProtocolRecordResult> {
    this.assertActive();
    const historyEntryId =
      options.historyEntryId === undefined
        ? undefined
        : normalizeExplicitHistoryEntryId(options.historyEntryId);
    if (
      historyEntryId !== undefined &&
      (this.turns.has(historyEntryId) ||
        this.pendingAcceptedTurnHistoryEntryIds.has(historyEntryId))
    ) {
      throw new Error(`history entry id '${historyEntryId}' belongs to an accepted turn`);
    }
    const userHistoryEntryId = await this.session.commitUserText(
      options.text,
      historyEntryId === undefined ? undefined : { historyEntryId },
    );
    return {
      snapshot: await this.snapshot(),
      userHistoryEntryId,
    };
  }

  async acceptTurn(
    options: Omit<SessionProtocolRecordParams, "sessionId">,
  ): Promise<SessionProtocolRecordResult> {
    this.assertActive();
    const userHistoryEntryId = this.createTurnHistoryEntryId(options.historyEntryId);
    this.pendingAcceptedTurnHistoryEntryIds.add(userHistoryEntryId);
    try {
      await this.session.commitUserText(options.text, { historyEntryId: userHistoryEntryId });
      return { snapshot: await this.snapshot(), userHistoryEntryId };
    } finally {
      this.pendingAcceptedTurnHistoryEntryIds.delete(userHistoryEntryId);
    }
  }

  private createTurnHistoryEntryId(preferredId?: string): string {
    if (preferredId !== undefined) {
      const normalizedId = normalizeExplicitHistoryEntryId(preferredId);
      if (
        this.turns.has(normalizedId) ||
        this.pendingAcceptedTurnHistoryEntryIds.has(normalizedId)
      ) {
        throw new Error(`turn '${normalizedId}' was already accepted`);
      }
      return normalizedId;
    }

    let id = `history-${randomUUID()}`;
    const historyEntryIds = new Set(this.session.rawHistoryEntries.map((entry) => entry.id));
    while (
      this.turns.has(id) ||
      this.pendingAcceptedTurnHistoryEntryIds.has(id) ||
      historyEntryIds.has(id)
    ) {
      id = `history-${randomUUID()}`;
    }
    return id;
  }

  async runAcceptedTurn(userHistoryEntryId: string): Promise<SessionProtocolUserMessageTurnResult> {
    const acceptedTurn = this.turns.get(userHistoryEntryId);
    if (!acceptedTurn) throw new Error(`turn '${userHistoryEntryId}' was not accepted`);
    if (acceptedTurn.state === "settled") {
      throw new Error(`turn '${userHistoryEntryId}' was already settled`);
    }
    const turn = await this.runLogicalTurn((logicalTurn) =>
      this.runTurnNow(logicalTurn, userHistoryEntryId),
    );
    await this.settleTurn(userHistoryEntryId, turn);
    return { userHistoryEntryId, turn };
  }

  async runTurn(): Promise<SessionProtocolTurnOutcome> {
    return await this.runLogicalTurn((logicalTurn) => this.runTurnNow(logicalTurn));
  }

  private async settleTurn(
    userHistoryEntryId: string,
    outcome: SessionProtocolTurnOutcome,
  ): Promise<void> {
    await this.enqueueMutation(async () => {
      const existing = this.turns.get(userHistoryEntryId);
      if (!existing) {
        throw new Error(`turn '${userHistoryEntryId}' was not accepted`);
      }
      if (existing.state === "settled") {
        if (isDeepStrictEqual(existing.outcome, outcome)) return;
        throw new Error(`turn '${userHistoryEntryId}' was already settled`);
      }
      const turn: SessionProtocolTurnRecord = { userHistoryEntryId, state: "settled", outcome };
      this.turns.set(userHistoryEntryId, turn);
      const delta = await this.commitSnapshotPatch("assistant-message", [
        { type: "turn.set", turn },
      ]);
      this.emitDelta(delta);
    });
  }

  async retryTurn(): Promise<SessionProtocolTurnOutcome> {
    const userMessage = this.session.rawHistoryEntries.findLast(
      (entry) => entry.message.role === "user",
    );
    if (userMessage && hasGoalTurnMetadata(userMessage.message)) {
      throw new SessionRetryUnavailableError(
        "goal-controlled turns cannot be retried; resume a blocked goal or start a new goal",
      );
    }
    if (!userMessage) {
      throw new SessionRetryUnavailableError("no user turn is available to retry");
    }
    return await this.runTurn();
  }

  private async runLogicalTurn<T>(
    execute: (logicalTurn: ActiveLogicalTurn) => Promise<T>,
  ): Promise<T> {
    this.assertActive();
    if (this.activeLogicalTurn) {
      throw new Error("session turn is already active");
    }
    const logicalTurn: ActiveLogicalTurn = {
      cancellationRequested: false,
      pendingSteering: [],
    };
    this.activeLogicalTurn = logicalTurn;
    const run = execute(logicalTurn);
    this.activeTurnPromise = run;
    try {
      return await run;
    } finally {
      if (this.activeTurnPromise === run) {
        this.rejectBufferedLogicalSteering(
          logicalTurn,
          new Error("steering was not applied before the logical turn ended"),
        );
        this.activeTurnPromise = undefined;
        this.activeLogicalTurn = undefined;
        await this.enqueueSnapshotResetIfChanged("assistant-message");
      }
    }
  }

  private async runTurnNow(
    logicalTurn: ActiveLogicalTurn,
    rootHistoryEntryId?: string,
  ): Promise<SessionProtocolTurnOutcome> {
    const rootUserMessage = rootHistoryEntryId
      ? this.session.rawHistoryEntries.find(
          (entry) => entry.id === rootHistoryEntryId && entry.message.role === "user",
        )
      : this.session.rawHistoryEntries.findLast((entry) => entry.message.role === "user");
    if (!rootUserMessage) {
      throw new Error("cannot run a turn without a user message");
    }
    let goalRootHistoryEntryId = this.goal?.status === "active" ? rootUserMessage.id : undefined;

    while (true) {
      if (logicalTurn.cancellationRequested) {
        return await this.cancelLogicalTurn();
      }

      const committedSteering: CommittedLogicalSteering[] = [];
      try {
        while (logicalTurn.pendingSteering.length > 0) {
          committedSteering.push(await this.commitBufferedLogicalSteering(logicalTurn));
        }
        if (logicalTurn.cancellationRequested) {
          return await this.cancelLogicalTurn(committedSteering);
        }

        const result = await this.runtime.runTurn();
        const terminalResult = result.terminalResult;
        if (terminalResult.aborted && this.draftAssistantMessage) {
          await this.interruptDraftAssistantMessage();
        }
        const initialOutcome = turnOutcomeFromResult(result, result.finalMessage);
        const terminalOutcome = turnOutcomeFromResult(terminalResult, terminalResult.finalMessage);
        await this.enqueueMutation(async () => {
          if (this.goal?.status === "active") {
            goalRootHistoryEntryId ??= rootUserMessage.id;
          }
          if (terminalOutcome.status !== "completed" && this.goal?.status === "active") {
            this.goal = { ...this.goal, status: "blocked" };
          }
          await this.emitSnapshotResetIfChanged("assistant-message");
        });
        await this.resolveCommittedLogicalSteering(committedSteering, initialOutcome);
        if (logicalTurn.cancellationRequested) {
          return await this.cancelLogicalTurn();
        }
        if (terminalOutcome.status !== "completed" || this.goal?.status !== "active") {
          return goalRootHistoryEntryId ? terminalOutcome : initialOutcome;
        }
        if (logicalTurn.pendingSteering.length > 0) {
          continue;
        }
        await this.session.commitUserText(buildGoalContinuationText(this.goal));
      } catch (error) {
        try {
          const outcome = await this.cleanupFailedTurn(rootUserMessage.id, error);
          await this.resolveCommittedLogicalSteering(committedSteering, outcome);
          return outcome;
        } catch {
          this.rejectCommittedLogicalSteering(committedSteering, error);
          throw error;
        }
      }
    }
  }

  interruptTurn(): boolean {
    this.assertActive();
    const logicalTurn = this.activeLogicalTurn;
    if (logicalTurn) {
      logicalTurn.cancellationRequested = true;
    }
    return this.runtime.interruptTurn() || Boolean(logicalTurn);
  }

  interruptActiveWork(): boolean {
    const logicalTurn = this.activeLogicalTurn;
    if (logicalTurn) {
      logicalTurn.cancellationRequested = true;
    }
    let interrupted = this.runtime.interruptTurn() || Boolean(logicalTurn);
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
    await this.mutationQueue;
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
    applied: Promise<HostedSteeringAssociation>;
    result: Promise<HostedSteeringResult>;
  } {
    this.assertActive();
    if (this.runtime.isTurnRunning) {
      const submission = this.runtime.steer(text);
      return {
        id: submission.id,
        applied: submission.applied.then((association) => ({
          userHistoryEntryId: association.historyEntryId,
        })),
        result: submission.result.then(async (association) => {
          const turn = turnOutcomeFromResult(association.result, association.result.finalMessage);
          await this.settleTurn(association.historyEntryId, turn);
          return { userHistoryEntryId: association.historyEntryId, turn };
        }),
      };
    }

    const logicalTurn = this.activeLogicalTurn;
    if (!logicalTurn || this.goal?.status !== "active") {
      throw new Error("cannot steer without an active turn");
    }
    return this.bufferLogicalSteering(logicalTurn, text);
  }

  cancelSteering(): ReturnType<ChatRuntime["cancelSteering"]> {
    this.assertActive();
    const cancelled = this.runtime.cancelSteering();
    const logicalTurn = this.activeLogicalTurn;
    if (!logicalTurn) {
      return cancelled;
    }
    const buffered = logicalTurn.pendingSteering.splice(0);
    const error = new Error("steering submission was cancelled");
    for (const submission of buffered) {
      submission.rejectApplied(error);
      submission.rejectResult(error);
    }
    return [...cancelled, ...buffered.map(({ id, text }) => ({ id, text }))];
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
    return await this.enqueueMutation(async () => {
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
            cause: { type: "configuration" },
            delta: {
              type: "snapshot.patch",
              changes: [{ type: "settings.set", settings: snapshot.settings }],
            },
          }),
        );
      }
      return { revision: snapshot.revision, settings: snapshot.settings };
    });
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
    return await this.enqueueMutation(async () => {
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
    });
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

    return await this.enqueueMutation(async () => {
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
    });
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
      return {
        snapshot: await this.snapshot(),
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
    if (
      !this.timeline.items.some(
        (item) => item.type === "message" && item.messageId === historyEntryId,
      )
    ) {
      throw new Error("rewind failed");
    }
    const result = await this.session.rewindToHistoryEntryId(historyEntryId);
    if (!result) {
      throw new Error("rewind failed");
    }

    return {
      snapshot: await this.snapshot(),
      ...result,
    };
  }

  async interruptSubagent(subagentId: string): Promise<SessionProtocolInterruptSubagentResult> {
    this.assertActive();
    return { found: await this.session.interruptSubagent(subagentId) };
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
    return await this.enqueueMutation(async () =>
      this.runtime.isTurnRunning && this.committedSnapshot
        ? await this.commitProjectedSnapshot()
        : await this.commitSnapshot(),
    );
  }

  async persistRecoveredAgentState(recovery: AgentStateRecovery): Promise<void> {
    this.assertActive();
    await this.enqueueMutation(async () => {
      const recoveredTools: Array<{
        tool: Exclude<SessionProtocolToolRun, { status: "streaming" }>;
        result: AgentStateRecovery["recoveredToolResults"][number];
      }> = [];
      for (const recovered of recovery.recoveredToolResults) {
        const tool = this.tools.get(recovered.message.toolCallId);
        if (!tool || tool.status === "streaming") {
          continue;
        }
        const nextTool: Exclude<SessionProtocolToolRun, { status: "streaming" }> =
          tool.status === "queued" || tool.status === "running"
            ? {
                ...tool,
                status: "cancelled",
                finishedAt: recovered.message.timestamp,
                resultMessageId: recovered.historyEntryId,
                error: "Tool completion status is unknown after session recovery.",
              }
            : { ...tool, resultMessageId: recovered.historyEntryId };
        this.tools.set(tool.id, nextTool);
        recoveredTools.push({ tool: nextTool, result: recovered });
      }
      await this.commitSnapshot();
      for (const { tool, result } of recoveredTools) {
        await this.appendToolHistory(tool, result.historyEntryId, result.message);
      }
    });
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

  private buildNewGoal(objective: string): SessionProtocolGoal {
    this.assertActive();
    if (this.goal) {
      throw new Error("a goal already exists; clear it before creating another");
    }
    const normalized = objective.trim();
    if (!normalized) {
      throw new Error("goal objective must not be empty");
    }
    return { objective: normalized, status: "active" };
  }

  private async setGoal(goal: SessionProtocolGoal | null): Promise<void> {
    await this.enqueueMutation(async () => {
      await this.emitPatch("goal", [{ type: "goal.set", goal: structuredClone(goal) }]);
      this.goal = structuredClone(goal);
    });
  }

  private async blockActiveGoal(): Promise<void> {
    if (this.goal?.status === "active") {
      await this.setGoal({ ...this.goal, status: "blocked" });
    }
  }

  private bufferLogicalSteering(
    logicalTurn: ActiveLogicalTurn,
    text: string,
  ): {
    id: string;
    applied: Promise<HostedSteeringAssociation>;
    result: Promise<HostedSteeringResult>;
  } {
    const normalized = text.trim();
    if (!normalized) {
      throw new Error("steering input must not be empty");
    }
    let resolveApplied!: (association: HostedSteeringAssociation) => void;
    let rejectApplied!: (error: Error) => void;
    const applied = new Promise<HostedSteeringAssociation>((resolve, reject) => {
      resolveApplied = resolve;
      rejectApplied = reject;
    });
    let resolveResult!: (result: HostedSteeringResult) => void;
    let rejectResult!: (error: Error) => void;
    const result = new Promise<HostedSteeringResult>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    const submission: BufferedLogicalSteering = {
      id: `logical-steering-${randomUUID()}`,
      text: normalized,
      applied,
      result,
      resolveApplied,
      resolveResult,
      rejectApplied,
      rejectResult,
    };
    logicalTurn.pendingSteering.push(submission);
    return { id: submission.id, applied, result };
  }

  private async commitBufferedLogicalSteering(
    logicalTurn: ActiveLogicalTurn,
  ): Promise<CommittedLogicalSteering> {
    const submissions = logicalTurn.pendingSteering.splice(0);
    if (submissions.length === 0) {
      throw new Error("cannot commit empty logical steering");
    }
    try {
      const goal = this.goal;
      if (goal?.status !== "active") {
        throw new Error("cannot commit logical steering without an active goal");
      }
      const historyEntryId = this.createTurnHistoryEntryId();
      this.pendingAcceptedTurnHistoryEntryIds.add(historyEntryId);
      try {
        await this.session.commitUserText(
          prependGoalPolicy(
            formatSteeringUserMessage(submissions.map((submission) => submission.text)),
            goal,
          ),
          { historyEntryId },
        );
      } finally {
        this.pendingAcceptedTurnHistoryEntryIds.delete(historyEntryId);
      }
      for (const submission of submissions) {
        submission.resolveApplied({ userHistoryEntryId: historyEntryId });
      }
      return { historyEntryId, submissions };
    } catch (error) {
      const steeringError = error instanceof Error ? error : new Error(String(error));
      for (const submission of submissions) {
        submission.rejectApplied(steeringError);
        submission.rejectResult(steeringError);
      }
      throw error;
    }
  }

  private async resolveCommittedLogicalSteering(
    committed: CommittedLogicalSteering[],
    turn: SessionProtocolTurnOutcome,
  ): Promise<void> {
    for (const { historyEntryId, submissions } of committed) {
      await this.settleTurn(historyEntryId, turn);
      for (const submission of submissions) {
        submission.resolveResult({ userHistoryEntryId: historyEntryId, turn });
      }
    }
  }

  private rejectCommittedLogicalSteering(
    committed: CommittedLogicalSteering[],
    error: unknown,
  ): void {
    const steeringError = error instanceof Error ? error : new Error(String(error));
    for (const { submissions } of committed) {
      for (const submission of submissions) {
        submission.rejectResult(steeringError);
      }
    }
  }

  private rejectBufferedLogicalSteering(logicalTurn: ActiveLogicalTurn, error: Error): void {
    for (const submission of logicalTurn.pendingSteering.splice(0)) {
      submission.rejectApplied(error);
      submission.rejectResult(error);
    }
  }

  private async cancelLogicalTurn(
    committedSteering: CommittedLogicalSteering[] = [],
  ): Promise<SessionProtocolTurnOutcome> {
    const outcome = abortedTurnOutcome();
    await this.enqueueMutation(async () => {
      if (this.goal?.status === "active") {
        this.goal = { ...this.goal, status: "blocked" };
      }
      await this.emitSnapshotResetIfChanged("assistant-message");
    });
    await this.resolveCommittedLogicalSteering(committedSteering, outcome);
    return outcome;
  }

  private async commitSnapshot(): Promise<SessionProtocolSnapshot> {
    this.assertNotDisposed();
    this.reconcileProjections();
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
    this.committedSnapshot = cloneSessionProtocolSnapshot(snapshot);
    return cloneSessionProtocolSnapshot(snapshot);
  }

  private async commitProjectedSnapshot(): Promise<SessionProtocolSnapshot> {
    this.assertNotDisposed();
    const current = this.committedSnapshot;
    if (!current) {
      return await this.commitSnapshot();
    }
    const snapshot = cloneSessionProtocolSnapshot(current);
    if (this.persistedSnapshot && isDeepStrictEqual(this.persistedSnapshot, snapshot)) {
      return snapshot;
    }

    await this.store.commitSessionSnapshot(snapshot, {
      expectedRevision: this.persistedSnapshot?.revision ?? 0,
    });
    this.persistedSnapshot = cloneSessionProtocolSnapshot(snapshot);
    return snapshot;
  }

  private async commitSnapshotPatch(
    cause: LocalDeltaCause,
    changes: SessionProtocolChange[],
  ): Promise<SessionProtocolDeltaMessage> {
    this.assertNotDisposed();
    const current = this.committedSnapshot;
    if (!current) {
      throw new Error("cannot persist a session patch without a committed snapshot");
    }

    const delta = createSessionProtocolDeltaMessage({
      sessionId: current.sessionId,
      fromRevision: current.revision,
      toRevision: current.revision + 1,
      cause: normalizeDeltaCause(cause),
      delta: { type: "snapshot.patch", changes },
    });
    const snapshot = applySessionProtocolDelta(current, delta);
    await this.store.commitSessionSnapshot(snapshot, {
      expectedRevision: this.persistedSnapshot?.revision ?? 0,
    });
    this.persistedSnapshot = cloneSessionProtocolSnapshot(snapshot);
    this.committedSnapshot = cloneSessionProtocolSnapshot(snapshot);
    return delta;
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

  private reconcileProjections(options: { removeMissingAgents?: boolean } = {}): void {
    const messageIds = new Set(this.session.rawHistoryEntries.map((entry) => entry.id));
    messageIds.add("system");
    if (this.draftAssistantMessage) {
      messageIds.add(this.draftAssistantMessage.id);
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

    for (const id of this.operations.keys()) {
      const hasTimelineItem = this.timeline.items.some(
        (item) => item.type === "operation" && item.operationId === id,
      );
      if (!hasTimelineItem) {
        this.operations.delete(id);
      }
    }

    this.timeline.items = this.timeline.items.filter((item) => {
      switch (item.type) {
        case "message":
          return messageIds.has(item.messageId);
        case "tool":
          return this.tools.has(item.toolId);
        case "notice":
          return (
            item.notice.subject.type === "session" ||
            (item.notice.subject.type === "message" && messageIds.has(item.notice.subject.id)) ||
            (item.notice.subject.type === "tool" && this.tools.has(item.notice.subject.id)) ||
            (item.notice.subject.type === "agent" && this.agents.has(item.notice.subject.id)) ||
            (item.notice.subject.type === "operation" &&
              this.operations.has(item.notice.subject.id))
          );
        case "operation":
          return this.operations.has(item.operationId);
      }
      return false;
    });

    for (const [id, facet] of this.facets) {
      const subjectExists =
        facet.subject.type === "session" ||
        (facet.subject.type === "message" && messageIds.has(facet.subject.id)) ||
        (facet.subject.type === "tool" && this.tools.has(facet.subject.id)) ||
        (facet.subject.type === "agent" && this.agents.has(facet.subject.id)) ||
        (facet.subject.type === "operation" && this.operations.has(facet.subject.id));
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
      attributes: structuredClone(this.attributes),
      createdAt: this.createdAt,
      agentState: {
        revision: agentState.revision,
        modelContextKey: agentState.modelContextKey,
        ...(agentState.usageCheckpoint
          ? { usageCheckpoint: { ...agentState.usageCheckpoint } }
          : {}),
      },
      lifecycle: this.activeTurnPromise || this.runtime.isTurnRunning ? "running" : "idle",
      goal: structuredClone(this.goal),
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
      turns: Object.fromEntries(this.turns),
      timeline: structuredClone(this.timeline),
      tools: Object.fromEntries(this.tools),
      operations: Object.fromEntries(this.operations),
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
    const historyMessages = this.session.rawHistoryEntries.map(
      (entry): SessionProtocolMessage => ({
        id: entry.id,
        state: this.messageStates.get(entry.id) ?? "committed",
        modelVisible: true,
        message: entry.message,
      }),
    );
    return [
      systemMessage,
      ...historyMessages,
      ...(this.draftAssistantMessage ? [structuredClone(this.draftAssistantMessage)] : []),
    ];
  }

  private nextTimelineItemBase(
    id: string,
    createdAt: number,
  ): {
    id: string;
    sequence: number;
    createdAt: number;
  } {
    this.timeline.sequence += 1;
    return { id, sequence: this.timeline.sequence, createdAt };
  }

  private appendMessageTimelineItem(
    messageId: string,
    createdAt: number,
  ): SessionProtocolTimelineItem {
    const item: SessionProtocolTimelineItem = {
      ...this.nextTimelineItemBase(`timeline-message-${messageId}`, createdAt),
      type: "message",
      messageId,
    };
    this.timeline.items.push(item);
    return item;
  }

  private appendToolTimelineItem(toolId: string, createdAt: number): SessionProtocolTimelineItem {
    const item: SessionProtocolTimelineItem = {
      ...this.nextTimelineItemBase(`timeline-tool-${toolId}`, createdAt),
      type: "tool",
      toolId,
    };
    this.timeline.items.push(item);
    return item;
  }

  private appendNoticeTimelineItem(
    id: string,
    createdAt: number,
    notice: SessionProtocolTimelineNotice,
  ): SessionProtocolTimelineItem {
    const item: SessionProtocolTimelineItem = {
      ...this.nextTimelineItemBase(id, createdAt),
      type: "notice",
      notice,
    };
    this.timeline.items.push(item);
    return item;
  }

  private appendTurnFailureTimelineItem(
    historyEntryId: string,
    failure: TurnFailureNotice,
  ): SessionProtocolTimelineItem {
    const blocked = failure.reason === "auto-compaction-failed";
    return this.appendNoticeTimelineItem(
      `turn-${blocked ? "blocked" : "failed"}-${randomUUID()}`,
      Date.now(),
      {
        kind: blocked ? "tau.turn.blocked" : "tau.turn.failed",
        version: 1,
        severity: "error",
        subject: { type: "message", id: historyEntryId },
        presentation: projectSessionProtocolNoticePresentation(
          blocked ? "turn blocked" : "turn failed",
          [failure.message],
        ),
        data: { reason: failure.reason },
      },
    );
  }

  private appendOperationTimelineItem(
    operation: SessionProtocolOperation,
  ): SessionProtocolTimelineItem {
    const item: SessionProtocolTimelineItem = {
      ...this.nextTimelineItemBase(`timeline-operation-${operation.id}`, operation.startedAt),
      type: "operation",
      operationId: operation.id,
    };
    this.operations.set(operation.id, operation);
    this.timeline.items.push(item);
    return item;
  }

  private removeTimelineItem(id: string): void {
    this.timeline.items = this.timeline.items.filter((item) => item.id !== id);
  }

  private restoreProtocolState(snapshot: SessionProtocolSnapshot | undefined): void {
    if (!snapshot) {
      return;
    }
    this.timeline = structuredClone(snapshot.timeline);
    this.turns.clear();
    for (const [id, turn] of Object.entries(snapshot.turns)) {
      this.turns.set(id, structuredClone(turn));
    }
    this.tools.clear();
    for (const [id, tool] of Object.entries(snapshot.tools)) {
      this.tools.set(id, structuredClone(tool));
    }
    this.operations.clear();
    for (const [id, operation] of Object.entries(snapshot.operations)) {
      this.operations.set(id, structuredClone(operation));
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
    const historyEntryIds = new Set(this.session.rawHistoryEntries.map((entry) => entry.id));
    this.draftAssistantMessage = snapshot.messages.find(
      (message) => message.state === "draft" && !historyEntryIds.has(message.id),
    );
    this.messageStates.clear();
    for (const message of snapshot.messages) {
      if (message.state !== "committed" && message.state !== "draft") {
        this.messageStates.set(message.id, message.state);
      }
    }
  }

  private enqueueMutation<T>(mutation: () => Promise<T> | T): Promise<T> {
    const result = this.mutationQueue
      .catch(() => undefined)
      .then(async () => {
        try {
          return await mutation();
        } catch (error) {
          if (this.committedSnapshot) {
            this.goal = structuredClone(this.committedSnapshot.goal);
            this.restoreProtocolState(this.committedSnapshot);
          }
          throw error;
        }
      });
    this.mutationQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
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
    await this.enqueueMutation(() => this.recordSubagentUiEvent(event));
  }

  async enqueueRuntimeEvent(event: AgentEvent): Promise<void> {
    await this.enqueueMutation(() => this.recordRuntimeEvent(event));
  }

  private removeToolRun(tool: SessionProtocolToolRun, changes: SessionProtocolChange[]): void {
    this.tools.delete(tool.id);
    const timelineItemId = `timeline-tool-${tool.id}`;
    this.removeTimelineItem(timelineItemId);
    for (const facetId of tool.facetIds) {
      this.facets.delete(facetId);
      changes.push({ type: "facet.remove", id: facetId });
    }
    changes.push(
      { type: "tool.remove", id: tool.id },
      { type: "timeline.remove", id: timelineItemId },
    );
  }

  async recordHistoryFailure(reason: string | undefined): Promise<void> {
    if (!reason || this.timeline.items.some((item) => item.id === HISTORY_UNAVAILABLE_NOTICE_ID)) {
      return;
    }
    const item = this.appendNoticeTimelineItem(HISTORY_UNAVAILABLE_NOTICE_ID, Date.now(), {
      kind: "tau.history.unavailable",
      version: 1,
      severity: "warn",
      subject: { type: "session" },
      presentation: projectSessionProtocolNoticePresentation("session history is unavailable", [
        reason,
        "this session will continue without durable history recording or recall",
      ]),
      data: {},
    });
    await this.emitPatch({ type: "notice" }, [
      { type: "timeline.append", item: structuredClone(item) },
    ]);
  }

  private async appendToolHistory(
    tool: Exclude<SessionProtocolToolRun, { status: "streaming" }>,
    resultHistoryEntryId: string,
    result: Extract<AgentEvent, { type: "tool_result" }>["message"],
  ): Promise<void> {
    const callMessage = this.committedSnapshot?.messages.find(
      (message) => message.id === tool.call.messageId,
    );
    const call =
      callMessage?.message.role === "assistant"
        ? callMessage.message.content[tool.call.contentIndex]
        : undefined;
    if (call?.type !== "toolCall" || call.id !== tool.toolCallId) {
      throw new Error(`missing transcript tool call '${tool.toolCallId}'`);
    }
    if (tool.status === "queued" || tool.status === "running") {
      throw new Error(`transcript tool call '${tool.toolCallId}' is not terminal`);
    }
    await this.recordHistoryFailure(
      this.history.append(
        this.sessionId,
        [
          toolHistoryEntry({
            callHistoryEntryId: tool.call.messageId,
            resultHistoryEntryId,
            call,
            result,
            outcome: tool.status,
          }),
        ],
        this.historyRemote,
      ),
    );
  }

  private agentStateChange(): SessionProtocolChange {
    const state = this.session.snapshot();
    return {
      type: "agent-state.set",
      agentState: {
        revision: state.revision,
        modelContextKey: state.modelContextKey,
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
        const timelineItem = this.appendMessageTimelineItem(
          this.draftAssistantMessage.id,
          this.draftAssistantMessage.message.timestamp,
        );
        await this.emitPatch(
          "assistant-stream",
          [
            {
              type: "message.append",
              message: structuredClone(this.draftAssistantMessage),
            },
            { type: "timeline.append", item: structuredClone(timelineItem) },
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
        const uiEvent: ToolActivity = {
          type: "tool_call_streaming",
          toolCallId: event.toolCallId,
          toolName: event.toolName,
          presentation: buildToolRunPresentation({
            toolName: event.toolName,
            subject: event.toolName,
          }),
        };
        const facet: SessionProtocolFacet = {
          id: facetId,
          subject: { type: "tool", id: event.toolCallId },
          kind: "tau.tool-ui-events",
          version: TOOL_UI_FACET_VERSION,
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
        const timelineItem = this.appendToolTimelineItem(tool.id, Date.now());
        changes.push(
          { type: "tool.set", tool: structuredClone(tool) },
          { type: "facet.set", facet: structuredClone(facet) },
          { type: "timeline.append", item: structuredClone(timelineItem) },
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
      case "user_message": {
        const pendingGoal = this.pendingGoalCommit;
        const acceptsTurn =
          this.pendingAcceptedTurnHistoryEntryIds.has(event.historyEntryId) ||
          event.origin === "steering";
        const turn: SessionProtocolTurnRecord | undefined = acceptsTurn
          ? { userHistoryEntryId: event.historyEntryId, state: "running" }
          : undefined;
        if (turn) {
          if (this.turns.has(event.historyEntryId)) {
            throw new Error(`turn '${event.historyEntryId}' was already accepted`);
          }
          this.turns.set(event.historyEntryId, turn);
        }
        const timelineItem = this.appendMessageTimelineItem(
          event.historyEntryId,
          event.message.timestamp,
        );
        await this.emitPatch(
          "user-message",
          [
            this.agentStateChange(),
            ...(pendingGoal
              ? [{ type: "goal.set" as const, goal: structuredClone(pendingGoal) }]
              : []),
            ...(turn ? [{ type: "turn.set" as const, turn }] : []),
            {
              type: "message.append",
              message: {
                id: event.historyEntryId,
                state: "committed",
                modelVisible: true,
                message: event.message,
              },
            },
            { type: "timeline.append", item: structuredClone(timelineItem) },
          ],
          { persist: true },
        );
        if (turn) {
          this.pendingAcceptedTurnHistoryEntryIds.delete(event.historyEntryId);
        }
        await this.recordHistoryFailure(
          this.history.append(
            this.sessionId,
            [userHistoryEntry(event.historyEntryId, event.message)],
            this.historyRemote,
          ),
        );
        if (pendingGoal && this.pendingGoalCommit === pendingGoal) {
          this.pendingGoalCommit = undefined;
        }
        return;
      }
      case "history_rewound": {
        const rewindItem = this.timeline.items.find(
          (item) => item.type === "message" && item.messageId === event.historyEntryId,
        );
        if (!rewindItem) {
          throw new Error(`missing timeline item for rewind message '${event.historyEntryId}'`);
        }
        const cutoffSequence = rewindItem.sequence - 1;
        this.timeline.items = this.timeline.items.filter((item) => item.sequence <= cutoffSequence);
        this.reconcileProjections({ removeMissingAgents: true });
        const snapshot = await this.commitSnapshot();
        this.emitSnapshotReset(
          { type: "rewind", epoch: this.timeline.epoch, cutoffSequence },
          snapshot,
        );
        await this.recordHistoryFailure(
          this.history.truncateFromSources(
            this.sessionId,
            event.removedEntryIds,
            this.historyRemote,
          ),
        );
        return;
      }
      case "assistant_final": {
        this.draftAssistantMessage = undefined;
        const messageState = event.message.stopReason === "aborted" ? "interrupted" : "committed";
        if (messageState === "committed") {
          this.messageStates.delete(event.historyEntryId);
        } else {
          this.messageStates.set(event.historyEntryId, messageState);
        }
        const lifecycle: SessionProtocolSnapshot["lifecycle"] = this.runtime.isTurnRunning
          ? "running"
          : "idle";
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
              state: messageState,
              modelVisible: true,
              message: event.message,
            },
          },
          ...(this.committedSnapshot?.lifecycle !== lifecycle
            ? [{ type: "lifecycle.set" as const, lifecycle }]
            : []),
          ...toolChanges,
        ]);
        await this.recordHistoryFailure(
          this.history.append(
            this.sessionId,
            assistantHistoryEntries(event.historyEntryId, event.message),
            this.historyRemote,
          ),
        );
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
            },
            { type: "tool.set", tool: structuredClone(nextTool) },
          ]);
          await this.appendToolHistory(existing, event.historyEntryId, event.message);
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
        const historyTools: Array<{
          tool: Exclude<SessionProtocolToolRun, { status: "streaming" }>;
          result: (typeof event.toolResults)[number];
        }> = [];
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
          historyTools.push({ tool: existing, result: toolResult });
        }
        await this.emitPatch({ type: "resync" }, changes);
        for (const { tool, result } of historyTools) {
          await this.appendToolHistory(tool, event.historyEntryId, result);
        }
        return;
      }
      case "feedback": {
        if (event.presentation === "footer") {
          this.emitEphemeral(
            createSessionProtocolEphemeralMessage({
              sessionId: this.sessionId,
              event: {
                type: "feedback.notice",
                title: projectSessionProtocolNoticePresentation(event.title).title,
                tone: event.tone,
                presentation: "footer",
                durationMs: event.durationMs,
              },
            }),
          );
          return;
        }

        const createdAt = Date.now();
        const item: SessionProtocolTimelineItem = {
          ...this.nextTimelineItemBase(`ephemeral-notice-${randomUUID()}`, createdAt),
          type: "notice",
          notice: {
            kind: "tau.runtime.feedback",
            version: 1,
            severity: event.tone === "error" ? "error" : "info",
            subject: { type: "session" },
            presentation: projectSessionProtocolNoticePresentation(event.title, event.content),
            data: {},
          },
        };
        await this.emitPatch("notice", [
          {
            type: "timeline.advance",
            epoch: this.timeline.epoch,
            sequence: item.sequence,
          },
        ]);
        this.emitEphemeral(
          createSessionProtocolEphemeralMessage({
            sessionId: this.sessionId,
            event: { type: "timeline.item", epoch: this.timeline.epoch, item },
          }),
        );
        return;
      }
      case "compaction_start": {
        const kind = event.reason === "manual" ? "manual-compaction" : "auto-compaction";
        const operation: SessionProtocolOperation = {
          id: `${kind}-${randomUUID()}`,
          kind,
          status: "running",
          startedAt: Date.now(),
        };
        const item = this.appendOperationTimelineItem(operation);
        await this.emitPatch("maintenance", [
          { type: "operation.set", operation: structuredClone(operation) },
          { type: "timeline.append", item: structuredClone(item) },
        ]);
        return;
      }
      case "compaction_end": {
        const operation = [...this.operations.values()].findLast(
          (candidate) =>
            (candidate.kind === "auto-compaction" || candidate.kind === "manual-compaction") &&
            candidate.status === "running",
        );
        if (operation) {
          const finishedAt = Date.now();
          const finishedOperation: SessionProtocolOperation =
            event.outcome === "compacted"
              ? { ...operation, status: "succeeded", finishedAt }
              : event.outcome === "failed"
                ? {
                    ...operation,
                    status: "failed",
                    finishedAt,
                    error: event.errorMessage,
                  }
                : event.outcome === "skipped"
                  ? {
                      ...operation,
                      status: "skipped",
                      finishedAt,
                      reason: "no-eligible-history",
                    }
                  : {
                      ...operation,
                      status: "cancelled",
                      finishedAt,
                      reason: "interrupted",
                    };
          this.operations.set(operation.id, finishedOperation);
          await this.emitPatch("maintenance", [
            { type: "operation.set", operation: structuredClone(finishedOperation) },
          ]);
        }

        if (event.outcome !== "compacted") {
          return;
        }

        const previousEpoch = this.timeline.epoch;
        this.timeline = { epoch: previousEpoch + 1, sequence: 0, items: [] };
        this.tools.clear();
        this.operations.clear();
        this.facets.clear();
        this.draftAssistantMessage = undefined;
        this.reconcileProjections({ removeMissingAgents: true });
        const summary = this.session.rawHistoryEntries.find(
          (entry) => entry.id === event.result.summaryHistoryEntryId,
        );
        if (!summary) {
          throw new Error(
            `missing compaction summary '${event.result.summaryHistoryEntryId}' in runtime history`,
          );
        }
        this.appendMessageTimelineItem(summary.id, summary.message.timestamp);
        const snapshot = await this.commitSnapshot();
        this.emitSnapshotReset(
          {
            type: "compaction",
            previousEpoch,
            epoch: this.timeline.epoch,
            kind: event.reason === "manual" ? "manual" : "auto",
            cutType: event.result.cutType,
            retainedMessageCount: event.result.retainedMessageCount,
          },
          snapshot,
        );
        return;
      }
      case "tool_activity":
        await this.recordToolUiEvent(event.activity);
        return;
      case "turn_finished": {
        if (!event.failure) {
          return;
        }
        const item = this.appendTurnFailureTimelineItem(event.historyEntryId, event.failure);
        await this.emitPatch("notice", [{ type: "timeline.append", item: structuredClone(item) }]);
        return;
      }
      case "turn_started":
      case "tool_call_admitted":
      case "model_retry_scheduled":
      case "model_retry_started":
      case "usage_checkpoint":
        return;
    }
  }

  private async recordToolUiEvent(event: ToolActivity): Promise<void> {
    const toolCallId = event.toolCallId;
    const existingTool = this.tools.get(toolCallId);
    if (!existingTool) {
      return;
    }

    const facetId = `tool-ui-${toolCallId}`;
    const existing = this.facets.get(facetId);
    const events =
      existing?.version === TOOL_UI_FACET_VERSION && Array.isArray(existing.data.events)
        ? existing.data.events
        : [];
    const facet: SessionProtocolFacet = {
      id: facetId,
      subject: { type: "tool", id: toolCallId },
      kind: "tau.tool-ui-events",
      version: TOOL_UI_FACET_VERSION,
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

    await this.emitPatch(
      "tool-run",
      [
        { type: "tool.set", tool },
        { type: "facet.set", facet: structuredClone(facet) },
      ],
      { persist: false },
    );
  }

  private async recordSubagentUiEvent(event: SubagentUiEvent): Promise<void> {
    const agent = agentRunFromSubagentEvent(event);
    const previousCost = this.agentCostTotals.get(agent.id) ?? 0;
    this.costTotal += Math.max(0, agent.costTotal - previousCost);
    this.agentCostTotals.set(agent.id, agent.costTotal);
    if (!this.session.hasSubagent(agent.id)) {
      return;
    }

    this.agents.set(agent.id, agent);
    const changes: SessionProtocolChange[] = [
      { type: "cost.set", costTotal: this.costTotal },
      { type: "agent.set", agent: structuredClone(agent) },
    ];
    const facetId = `subagent-activity-${agent.id}`;
    if (event.type === "subagent_activity") {
      const facet: SessionProtocolFacet = {
        id: facetId,
        subject: { type: "agent", id: agent.id },
        kind: SUBAGENT_ACTIVITY_FACET_KIND,
        version: 1,
        data: { text: event.text },
      };
      this.facets.set(facet.id, facet);
      changes.push({ type: "facet.set", facet: structuredClone(facet) });
    } else if (
      (event.type === "subagent_run_started" || event.type === "subagent_finished") &&
      this.facets.delete(facetId)
    ) {
      changes.push({ type: "facet.remove", id: facetId });
    }

    await this.emitPatch(
      "agent-run",
      changes,
      event.type === "subagent_activity" ? { persist: false } : {},
    );
  }

  private buildAssistantPartialChanges(
    previousDraft: SessionProtocolMessage | undefined,
    nextDraft: SessionProtocolMessage,
  ): SessionProtocolChange[] {
    if (!previousDraft) {
      const timelineItem = this.appendMessageTimelineItem(
        nextDraft.id,
        nextDraft.message.timestamp,
      );
      return [
        {
          type: "message.append",
          message: structuredClone(nextDraft),
        },
        { type: "timeline.append", item: structuredClone(timelineItem) },
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
    cause: LocalDeltaCause,
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
        this.emitSnapshotReset(cause, snapshot);
        return;
      }
      const snapshot = await this.commitSnapshot();
      this.emitSnapshotReset(cause, snapshot);
      return;
    }
    if (options.persist !== false) {
      this.emitDelta(await this.commitSnapshotPatch(cause, changes));
      return;
    }

    const delta = createSessionProtocolDeltaMessage({
      sessionId: this.committedSnapshot.sessionId,
      fromRevision: this.committedSnapshot.revision,
      toRevision: this.committedSnapshot.revision + 1,
      cause: normalizeDeltaCause(cause),
      delta: { type: "snapshot.patch", changes },
    });
    this.committedSnapshot = applySessionProtocolDelta(this.committedSnapshot, delta);
    this.emitDelta(delta);
  }

  private emitSnapshotReset(cause: LocalDeltaCause, snapshot: SessionProtocolSnapshot): void {
    this.emitDelta(
      createSessionProtocolDeltaMessage({
        sessionId: snapshot.sessionId,
        fromRevision: null,
        toRevision: snapshot.revision,
        cause: normalizeDeltaCause(cause),
        delta: { type: "snapshot.reset", snapshot },
      }),
    );
  }

  private async enqueueSnapshotResetIfChanged(cause: LocalDeltaCause): Promise<void> {
    await this.enqueueMutation(() => this.emitSnapshotResetIfChanged(cause));
  }

  private async emitSnapshotResetIfChanged(cause: LocalDeltaCause): Promise<void> {
    const previousRevision = this.committedSnapshot?.revision;
    const snapshot = await this.commitSnapshot();
    if (snapshot.revision !== previousRevision) {
      this.emitSnapshotReset(cause, snapshot);
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
      if (!existing) {
        const timelineItem = this.appendToolTimelineItem(content.id, Date.now());
        changes.push({ type: "timeline.append", item: structuredClone(timelineItem) });
      }
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

  private async cleanupFailedTurn(
    rootHistoryEntryId: string,
    error: unknown,
  ): Promise<SessionProtocolTurnOutcome> {
    if (this.draftAssistantMessage) {
      await this.interruptDraftAssistantMessage().catch(() => undefined);
    }

    const diagnostic = formatErrorDiagnostic(error);
    await this.enqueueMutation(async () => {
      this.appendTurnFailureTimelineItem(rootHistoryEntryId, {
        reason: "runtime-error",
        message: diagnostic,
      });
      if (this.goal?.status === "active") {
        this.goal = { ...this.goal, status: "blocked" };
      }
      const timestamp = Date.now();
      for (const [id, tool] of this.tools) {
        if (tool.status !== "queued" && tool.status !== "running") {
          continue;
        }
        this.tools.set(id, {
          ...tool,
          status: "cancelled",
          finishedAt: timestamp,
          error: `Turn failed before tool completion: ${diagnostic}`,
        });
      }
      await this.emitSnapshotResetIfChanged("assistant-message");
    });
    return { status: "failed", stopReason: "error", errorMessage: diagnostic };
  }
}

function normalizeExplicitHistoryEntryId(historyEntryId: string): string {
  const normalizedId = historyEntryId.trim();
  if (!normalizedId) {
    throw new Error("history entry id must not be empty");
  }
  return normalizedId;
}

function formatErrorDiagnostic(error: unknown): string {
  const messages: string[] = [];
  const seen = new Set<unknown>();
  let current = error;
  while (current !== undefined && !seen.has(current)) {
    seen.add(current);
    messages.push(current instanceof Error ? current.message : String(current));
    current = current instanceof Error ? current.cause : undefined;
  }
  return messages.filter((message, index) => message && message !== messages[index - 1]).join(": ");
}

function abortedTurnOutcome(): SessionProtocolTurnOutcome {
  return { status: "aborted", stopReason: "aborted" };
}

function turnOutcomeFromResult(
  result: AgentSubturnResult,
  assistantMessage: AssistantMessage | undefined,
): SessionProtocolTurnOutcome {
  if (result.blocked) {
    return { status: "blocked", ...result.blocked };
  }
  if (result.limitReached) {
    return { status: "failed", stopReason: "error", errorMessage: result.limitReached.message };
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
  if (assistantMessage.stopReason === "deferred") {
    throw new Error("session turn completed with a deferred assistant message");
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
  legacyAgentState: boolean;
} {
  const recovered = cloneSessionProtocolSnapshot(snapshot);
  const legacyAgentState =
    recovered.agentState.modelContextKey === LEGACY_SESSION_MODEL_CONTEXT_KEY;
  let changed = recovered.lifecycle !== "idle" || legacyAgentState;
  recovered.lifecycle = "idle";
  for (const [id, turn] of Object.entries(recovered.turns)) {
    if (turn.state === "running") {
      changed = true;
      recovered.turns[id] = {
        userHistoryEntryId: id,
        state: "settled",
        outcome: abortedTurnOutcome(),
      };
    }
  }
  if (recovered.goal?.status === "active") {
    changed = true;
    recovered.goal.status = "blocked";
  }
  if (Object.keys(recovered.agents).length > 0) {
    changed = true;
    recovered.agents = {};
    recovered.facets = Object.fromEntries(
      Object.entries(recovered.facets).filter(([, facet]) => facet.subject.type !== "agent"),
    );
  }
  const recoveredAt = Date.now();
  for (const [id, operation] of Object.entries(recovered.operations)) {
    if (operation.status !== "running") {
      continue;
    }
    changed = true;
    recovered.operations[id] = {
      ...operation,
      status: "cancelled",
      finishedAt: recoveredAt,
      reason: "session-recovered",
    };
  }
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
    recovered.timeline.items = recovered.timeline.items.filter(
      (item) =>
        !(item.type === "tool" && streamingToolIds.has(item.toolId)) &&
        !(
          item.type === "notice" &&
          item.notice.subject.type === "tool" &&
          streamingToolIds.has(item.notice.subject.id)
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
      modelContextKey: recovered.agentState.modelContextKey,
      ...(recovered.agentState.usageCheckpoint
        ? { usageCheckpoint: { ...recovered.agentState.usageCheckpoint } }
        : {}),
    };
  }
  return { snapshot: recovered, changed, legacyAgentState };
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

function agentRunFromSubagentEvent(event: SubagentUiEvent): SessionProtocolAgentRun {
  return structuredClone(event.state);
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
