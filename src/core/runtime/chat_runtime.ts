import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import {
  AgentRuntime,
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
import type { Config } from "../config/index.js";
import type { ModelResolver } from "../models/catalog.js";
import { createAutoCompactionArchiver } from "../session/auto_compaction_archive.js";
import { AgentSupervisor } from "../subagents/agent_supervisor.js";
import type { SubagentUiEvent } from "../subagents/types.js";
import { ToolCatalog } from "../tools/catalog.js";
import type { ToolExecutionBackend } from "../tools/execution_backend.js";
import { ToolRegistry } from "../tools/registry.js";
import type { ResolveSubagentRuntime } from "../tools/spawn_agent.js";
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
  platform: NodeJS.Platform;
  nodeVersion: string;
  includeAgentContext: boolean;
  projectContextBlock?: string;
  skillsBlock?: string;
};

export type ChatRuntimeEnvironment = { now: () => number };

export type CreateChatRuntimeOptions = {
  persona: Persona;
  backend: ToolExecutionBackend;
  clientTools?: (agentId: string) => ReturnType<ToolRegistry["getEnabledTools"]>;
  modelResolver: ModelResolver;
  resolveSubagentRuntime?: ResolveSubagentRuntime;
  promptContext: ChatRuntimePromptContext;
  environment: ChatRuntimeEnvironment;
  eventSink: AgentEventSink;
  subagentEventSink: (event: SubagentUiEvent) => void | Promise<void>;
  recordUsage?: UsageRecorder;
  initialPromptComposition?: SessionPromptComposition;
  config: Config;
  deps?: CoreDeps;
};

export class ChatRuntime {
  readonly agent: AgentRuntime;
  readonly supervisor: AgentSupervisor;
  private currentPersona: Persona;
  private currentConfig: Config;
  private currentModelResolver: ModelResolver;
  private promptContext: ChatRuntimePromptContext;
  private readonly environment: ChatRuntimeEnvironment;
  private readonly backend: ToolExecutionBackend;
  private readonly deps: CoreDeps;
  private resolvedModel: ResolvedAgentModel;
  private readonly clientTools?: CreateChatRuntimeOptions["clientTools"];
  private readonly resolveSubagentRuntime?: ResolveSubagentRuntime;
  private latestPromptComposition: SessionPromptComposition;

  static create(options: CreateChatRuntimeOptions): ChatRuntime {
    const promptComposition =
      options.initialPromptComposition ??
      composeSessionPrompts({
        persona: options.persona,
        cwd: options.promptContext.cwd,
        repoRoot: options.promptContext.repoRoot,
        datetime: new Date(options.environment.now()).toISOString(),
        platform: options.promptContext.platform,
        nodeVersion: options.promptContext.nodeVersion,
        skillsBlock: options.promptContext.skillsBlock,
        projectContextBlock: options.promptContext.projectContextBlock,
      });
    return new ChatRuntime(options, promptComposition);
  }

  private constructor(options: CreateChatRuntimeOptions, composition: SessionPromptComposition) {
    this.currentPersona = structuredClone(options.persona);
    this.currentConfig = options.config;
    this.currentModelResolver = options.modelResolver;
    this.promptContext = { ...options.promptContext };
    this.environment = options.environment;
    this.backend = options.backend;
    this.deps = options.deps ?? createDefaultCoreDeps();
    this.resolvedModel = resolveAgentModel(this.currentPersona, this.currentConfig, {
      includeModelNotice: true,
      deps: this.deps,
    });
    this.clientTools = options.clientTools;
    this.resolveSubagentRuntime = options.resolveSubagentRuntime;
    this.latestPromptComposition = composition;
    this.supervisor = new AgentSupervisor({
      onEvent: options.subagentEventSink,
      ...(options.recordUsage ? { recordUsage: options.recordUsage } : {}),
      deps: this.deps,
    });
    const tools = this.buildToolRegistry(composition);
    this.agent = new AgentRuntime({
      spec: createAgentSpec({
        ...this.resolvedModel,
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
        const context = this.supervisor.getActiveCompactionContext();
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

  get persona(): Persona {
    return this.currentPersona;
  }

  get sessionId(): string {
    return this.agent.agentIdValue;
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

  reset(): void {
    this.supervisor.reset();
    this.agent.reset();
  }

  dispose(): void {
    this.supervisor.reset();
    this.agent.dispose();
  }

  hasSubagent(id: string): boolean {
    return this.supervisor.getSnapshot(id) !== undefined;
  }

  async interruptSubagent(id: string): Promise<boolean> {
    return Boolean(await this.supervisor.interrupt(id));
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

  setRuntimeConfig(config: Config, modelResolver: ModelResolver): void {
    this.currentConfig = config;
    this.currentModelResolver = modelResolver;
    this.resolvedModel = resolveAgentModel(this.currentPersona, this.currentConfig, {
      includeModelNotice: true,
      deps: this.deps,
    });
    this.refreshSpec();
  }

  setReasoning(reasoning: ReasoningEffort): void {
    this.currentPersona = {
      ...this.currentPersona,
      settings: { ...this.currentPersona.settings, reasoning },
    };
    this.resolvedModel = resolveAgentModel(this.currentPersona, this.currentConfig, {
      includeModelNotice: true,
      deps: this.deps,
    });
    this.refreshSpec();
  }

  setPersona(persona: Persona, options?: { skillsBlock?: string }): void {
    this.currentPersona = structuredClone(persona);
    this.resolvedModel = resolveAgentModel(this.currentPersona, this.currentConfig, {
      includeModelNotice: true,
      deps: this.deps,
    });
    this.rebuildSystemPrompts(options);
  }

  updatePromptContext(context: Partial<ChatRuntimePromptContext>): void {
    this.promptContext = { ...this.promptContext, ...context };
    this.rebuildSystemPrompts();
  }

  rebuildSystemPrompts(options?: { skillsBlock?: string }): void {
    if (options?.skillsBlock !== undefined) this.promptContext.skillsBlock = options.skillsBlock;
    this.latestPromptComposition = this.composePromptSet(options?.skillsBlock);
    this.refreshSpec();
  }

  private refreshSpec(): void {
    this.agent.updateSpec(
      createAgentSpec({
        ...this.resolvedModel,
        systemPrompt: this.latestPromptComposition.baseSystemPrompt,
        tools: this.buildToolRegistry(this.latestPromptComposition),
      }),
    );
  }

  private buildToolRegistry(composition: SessionPromptComposition): ToolRegistry {
    const registry = ToolCatalog.createSessionRegistry({
      backend: this.backend,
      cwd: this.promptContext.cwd,
      config: this.currentConfig,
      persona: this.currentPersona,
      subagentPrompts: composition.subagentPrompts,
      modelResolver: this.currentModelResolver,
      supervisor: this.supervisor,
      ...(this.resolveSubagentRuntime
        ? { resolveSubagentRuntime: this.resolveSubagentRuntime }
        : {}),
    });
    const clientTools = this.clientTools?.(this.agent?.agentIdValue ?? "pending") ?? [];
    return clientTools.length === 0
      ? registry
      : new ToolRegistry([...registry.getEnabledTools(), ...clientTools]);
  }

  private composePromptSet(skillsBlock?: string): SessionPromptComposition {
    return composeSessionPrompts({
      persona: this.currentPersona,
      cwd: this.promptContext.cwd,
      repoRoot: this.promptContext.repoRoot,
      datetime: new Date(this.environment.now()).toISOString(),
      platform: this.promptContext.platform,
      nodeVersion: this.promptContext.nodeVersion,
      skillsBlock: skillsBlock ?? this.promptContext.skillsBlock,
      projectContextBlock: this.promptContext.projectContextBlock,
    });
  }
}
