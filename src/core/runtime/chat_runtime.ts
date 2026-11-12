import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import type { SystemMessageMetadata } from "../../protocol/system_message.js";
import {
  type AgentRuntime,
  type AgentState,
  type AgentStateRecovery,
  type AgentTurnResult,
  type CancelledSteeringSubmission,
  createAgentSpec,
  type HistoryEntry,
  type RewindCandidate,
  type RewindResult,
  type SteeringSubmission,
} from "../agent/agent_runtime.js";
import type { AgentEventSink } from "../agent/events.js";
import { NotificationInbox } from "../agent/notification_inbox.js";
import type { SessionRuntimeSettings } from "../config/index.js";
import type { OpenSubagentHistory } from "../history/agent_history_recorder.js";
import type { HistoryQuery } from "../history/types.js";
import type { McpManager } from "../mcp/manager.js";
import type { ModelResolver } from "../models/catalog.js";
import { createAutoCompactionArchiver } from "../session/auto_compaction_archive.js";
import type { AutoCompactDefaults } from "../session/auto_compaction_threshold.js";
import { AgentSupervisor } from "../subagents/agent_supervisor.js";
import type { ResolveSubagentPrompt, SubagentEvent } from "../subagents/types.js";
import { AgentJobRegistry } from "../tools/agent_jobs.js";
import { ToolCatalog } from "../tools/catalog.js";
import type { ToolExecutionBackend } from "../tools/execution_backend.js";
import type { ToolRegistry } from "../tools/registry.js";
import type { Persona, ReasoningEffort } from "../types.js";
import type { UsageRecorder } from "../usage/logs.js";
import { type ResolvedAgentModel, resolveAgentModel } from "./agent_model.js";
import { type CoreDeps, createDefaultCoreDeps } from "./deps.js";
import { type ModelSampleInput, sampleModel } from "./model_sampler.js";
import { composeSessionPrompts, type SessionPromptComposition } from "./session_prompt_composer.js";

export type ChatRuntimePromptContext = {
  cwd: string;
  home: string;
  repoRoot?: string;
  repository?: string;
  platform: NodeJS.Platform;
  includeAgentContext: boolean;
  projectContextBlock?: string;
  skillsBlock?: string;
};

export type ChatRuntimeEnvironment = { now: () => number };

export type CreateChatRuntimeOptions = {
  sessionId: string;
  createdAt: number;
  persona: Persona;
  autoCompactDefaults?: AutoCompactDefaults;
  /** Whether the main agent gets notifications and starts turns on its own for them. */
  notifications: boolean;
  backend: ToolExecutionBackend;
  clientTools?: () => ReturnType<ToolRegistry["getEnabledTools"]>;
  modelResolver: ModelResolver;
  resolveSubagentPrompt?: ResolveSubagentPrompt;
  promptContext: ChatRuntimePromptContext;
  eventSink: AgentEventSink;
  subagentEventSink: (event: SubagentEvent) => void | Promise<void>;
  history: HistoryQuery;
  openSubagentHistory: OpenSubagentHistory;
  mcp?: McpManager;
  recordUsage?: UsageRecorder;
  initialPromptComposition?: SessionPromptComposition;
  config: SessionRuntimeSettings;
  deps?: CoreDeps;
};

export class ChatRuntime {
  readonly agent: AgentRuntime;
  readonly jobs = new AgentJobRegistry();
  readonly backgroundJobs = this.jobs.create();
  readonly supervisor: AgentSupervisor;
  /** Absent when the session has notifications turned off. */
  readonly notifications: NotificationInbox | undefined;
  private readonly userInterruptedSubagents = new Set<string>();
  private currentPersona: Persona;
  private readonly autoCompactDefaults: AutoCompactDefaults | undefined;
  private autoCompactOverride: number | null = null;
  private currentConfig: SessionRuntimeSettings;
  private readonly hostApiKeys: SessionRuntimeSettings["apiKeys"];
  private currentModelResolver: ModelResolver;
  private promptContext: ChatRuntimePromptContext;
  private readonly sessionIdValue: string;
  private readonly createdAt: number;
  private readonly backend: ToolExecutionBackend;
  private readonly deps: CoreDeps;
  private resolvedModel: ResolvedAgentModel;
  private readonly clientTools?: CreateChatRuntimeOptions["clientTools"];
  private readonly resolveSubagentPrompt?: ResolveSubagentPrompt;
  private readonly historyQuery: HistoryQuery;
  private readonly mcp?: McpManager;
  private latestPromptComposition: SessionPromptComposition;

  static create(options: CreateChatRuntimeOptions): ChatRuntime {
    const promptComposition =
      options.initialPromptComposition ??
      composeSessionPrompts({
        persona: options.persona,
        sessionId: options.sessionId,
        cwd: options.promptContext.cwd,
        repoRoot: options.promptContext.repoRoot,
        repository: options.promptContext.repository,
        sessionStartedAt: new Date(options.createdAt).toISOString(),
        platform: options.promptContext.platform,
        skillsBlock: options.promptContext.skillsBlock,
        projectContextBlock: options.promptContext.projectContextBlock,
      });
    return new ChatRuntime(options, promptComposition);
  }

  private constructor(options: CreateChatRuntimeOptions, composition: SessionPromptComposition) {
    this.currentPersona = structuredClone(options.persona);
    this.notifications = options.notifications ? new NotificationInbox() : undefined;
    this.autoCompactDefaults = structuredClone(options.autoCompactDefaults);
    this.currentConfig = options.config;
    this.hostApiKeys = structuredClone(options.config.apiKeys);
    this.currentModelResolver = options.modelResolver;
    this.promptContext = { ...options.promptContext };
    this.sessionIdValue = options.sessionId;
    this.createdAt = options.createdAt;
    this.backend = options.backend;
    this.deps = options.deps ?? createDefaultCoreDeps();
    this.resolvedModel = resolveAgentModel(this.currentPersona, this.config, {
      includeModelNotice: true,
      deps: this.deps,
    });
    this.clientTools = options.clientTools;
    this.resolveSubagentPrompt = options.resolveSubagentPrompt;
    this.historyQuery = options.history;
    this.mcp = options.mcp;
    this.latestPromptComposition = composition;
    this.supervisor = new AgentSupervisor({
      mainAgentId: options.sessionId,
      onEvent: options.subagentEventSink,
      onCompletion: (state) => {
        const byUser = this.userInterruptedSubagents.delete(state.id);
        const status =
          byUser && state.run.status === "interrupted"
            ? "interrupted by the user"
            : state.run.status;
        this.notifications?.add(`subagent ${state.id} is idle (${status})`);
      },
      openHistory: options.openSubagentHistory,
      ...(options.recordUsage ? { recordUsage: options.recordUsage } : {}),
      deps: this.deps,
    });
    const tools = this.buildToolRegistry(composition);
    this.agent = this.supervisor.createMainRuntime({
      agentId: options.sessionId,
      notifications: this.notifications,
      spec: createAgentSpec({
        ...this.resolvedModel,
        autoCompactThresholdTokens: this.resolvedAutoCompactThresholdTokens,
        systemPrompt: composition.baseSystemPrompt,
        tools,
      }),
      eventSink: async (event) => {
        if (event.type === "history_rewound") {
          this.supervisor.retainOrigins(
            new Set(this.agent.rawHistoryEntriesSnapshot.map((entry) => entry.id)),
          );
        }
        await options.eventSink(event);
      },
      clock: this.deps.clock,
      archiveAutoCompaction: createAutoCompactionArchiver(this.backend),
      getCompactionContinuationSystemMessages: () => {
        const context = this.supervisor.getActiveCompactionContext(this.supervisor.mainAgentId);
        return context ? [context] : [];
      },
    });
  }

  get isTurnRunning(): boolean {
    return this.agent.status === "running";
  }

  get promptComposition(): SessionPromptComposition {
    return this.latestPromptComposition;
  }

  get config(): SessionRuntimeSettings {
    return structuredClone({ ...this.currentConfig, apiKeys: this.hostApiKeys });
  }

  get persona(): Persona {
    return this.currentPersona;
  }

  get sessionId(): string {
    return this.sessionIdValue;
  }

  get history(): readonly Message[] {
    return this.agent.history;
  }

  get rawHistory(): readonly Message[] {
    return this.agent.rawHistory;
  }

  get rawHistoryEntries(): readonly HistoryEntry[] {
    return this.agent.rawHistoryEntriesSnapshot;
  }

  get historyEntries(): readonly HistoryEntry[] {
    return this.agent.historyEntriesSnapshot;
  }

  async commitSystemMessage(content: string, metadata: SystemMessageMetadata): Promise<string> {
    return await this.agent.commitSystemMessage(content, metadata);
  }

  record(text: string, options?: { historyEntryId?: string }): Promise<string> {
    return this.agent.record(text, options);
  }

  async commitUserText(text: string, options?: { historyEntryId?: string }): Promise<string> {
    return await this.agent.commitUserText(text, options);
  }

  async commitInterruptedAssistant(
    message: AssistantMessage,
    historyEntryId: string,
  ): Promise<void> {
    await this.agent.commitInterruptedAssistant(message, historyEntryId);
  }

  runTurn(): Promise<AgentTurnResult> {
    this.refreshSpec();
    return this.agent.runTurn();
  }

  commitNotifications(historyEntryId?: string): Promise<boolean> {
    return this.agent.commitNotifications(historyEntryId);
  }

  steer(text: string): SteeringSubmission {
    return this.agent.steer(text);
  }

  cancelSteering(): CancelledSteeringSubmission[] {
    return this.agent.cancelSteering();
  }

  requestTurnBoundaryStop(): boolean {
    return this.agent.requestStopAtBoundary();
  }

  cancelTurnBoundaryStop(): boolean {
    return this.agent.cancelStopAtBoundary();
  }

  interruptTurn(): boolean {
    return this.agent.interrupt();
  }

  restoreState(state: AgentState): AgentStateRecovery {
    return this.agent.restoreState(state);
  }

  dispose(): void {
    this.supervisor.dispose();
  }

  hasSubagent(id: string): boolean {
    return this.supervisor.getSnapshot(id) !== undefined;
  }

  /** Interrupts a subagent for the user, so its completion notification can say so. */
  async interruptSubagent(id: string): Promise<boolean> {
    const state = this.supervisor.getSnapshot(id);
    if (!state) return false;
    if (state.availability === "running") this.userInterruptedSubagents.add(id);
    await this.supervisor.interrupt(id);
    return true;
  }

  listRewindCandidates(): RewindCandidate[] {
    return this.agent.listRewindCandidates();
  }

  async rewindToHistoryEntryId(historyEntryId: string): Promise<RewindResult | undefined> {
    if (this.supervisor.getActiveCount() > 0) {
      throw new Error("cannot rewind while subagents are running");
    }
    return await this.agent.rewindToHistoryEntryId(historyEntryId);
  }

  async sample(input: ModelSampleInput): Promise<AssistantMessage> {
    return await sampleModel(
      {
        model: this.resolvedModel.model,
        streamOptions: this.resolvedModel.streamOptions,
      },
      input,
    );
  }

  compact(options: Parameters<AgentRuntime["compact"]>[0]) {
    return this.agent.compact(options);
  }

  snapshot(): AgentState {
    return this.agent.snapshot();
  }

  setRuntimeConfig(config: SessionRuntimeSettings, modelResolver: ModelResolver): void {
    this.currentConfig = config;
    this.currentModelResolver = modelResolver;
    this.resolvedModel = resolveAgentModel(this.currentPersona, this.config, {
      includeModelNotice: true,
      deps: this.deps,
    });
    this.refreshSpec();
  }

  get autoCompactOverrideTokens(): number | null {
    return this.autoCompactOverride;
  }

  private get resolvedAutoCompactThresholdTokens(): number | null {
    return (
      this.autoCompactOverride ??
      this.autoCompactDefaults?.thresholdTokens ??
      this.currentPersona.autoCompactThresholdTokens ??
      null
    );
  }

  setAutoCompactThreshold(thresholdTokens: number | null): void {
    this.autoCompactOverride = thresholdTokens;
    this.refreshSpec();
  }

  setReasoning(reasoning: ReasoningEffort): void {
    this.currentPersona = {
      ...this.currentPersona,
      settings: { ...this.currentPersona.settings, reasoning },
    };
    this.resolvedModel = resolveAgentModel(this.currentPersona, this.config, {
      includeModelNotice: true,
      deps: this.deps,
    });
    this.refreshSpec();
  }

  setPersona(persona: Persona): void {
    if (persona.id.toLowerCase() !== this.currentPersona.id.toLowerCase()) {
      this.autoCompactOverride = null;
    }
    this.currentPersona = structuredClone(persona);
    this.resolvedModel = resolveAgentModel(this.currentPersona, this.config, {
      includeModelNotice: true,
      deps: this.deps,
    });
    this.rebuildSystemPrompts();
  }

  updatePromptContext(context: Partial<ChatRuntimePromptContext>): void {
    this.promptContext = { ...this.promptContext, ...context };
    this.rebuildSystemPrompts();
  }

  private rebuildSystemPrompts(): void {
    this.latestPromptComposition = this.composePromptSet();
    this.refreshSpec();
  }

  private refreshSpec(): void {
    this.agent.updateSpec(
      createAgentSpec({
        ...this.resolvedModel,
        autoCompactThresholdTokens: this.resolvedAutoCompactThresholdTokens,
        systemPrompt: this.latestPromptComposition.baseSystemPrompt,
        tools: this.buildToolRegistry(this.latestPromptComposition),
      }),
    );
  }

  private buildToolRegistry(composition: SessionPromptComposition): ToolRegistry {
    return ToolCatalog.createSessionRegistry({
      backend: this.backend,
      cwd: this.promptContext.cwd,
      config: this.config,
      persona: this.currentPersona,
      autoCompactThresholdTokens: this.resolvedAutoCompactThresholdTokens,
      subagentSystemPrompt: composition.subagentSystemPrompt,
      modelResolver: this.currentModelResolver,
      supervisor: this.supervisor,
      ...(this.notifications ? { notifications: this.notifications } : {}),
      jobs: this.jobs,
      ...this.backgroundJobs,
      history: this.historyQuery,
      clientTools: this.clientTools,
      mcp: this.mcp,
      ...(this.resolveSubagentPrompt ? { resolveSubagentPrompt: this.resolveSubagentPrompt } : {}),
    });
  }

  private composePromptSet(): SessionPromptComposition {
    return composeSessionPrompts({
      persona: this.currentPersona,
      sessionId: this.sessionIdValue,
      cwd: this.promptContext.cwd,
      repoRoot: this.promptContext.repoRoot,
      repository: this.promptContext.repository,
      sessionStartedAt: new Date(this.createdAt).toISOString(),
      platform: this.promptContext.platform,
      skillsBlock: this.promptContext.skillsBlock,
      projectContextBlock: this.promptContext.projectContextBlock,
    });
  }
}
