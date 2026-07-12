import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { Config } from "../core/config/index.js";
import type { CoreEvent } from "../core/events/types.js";
import type { ModelResolver } from "../core/models/catalog.js";
import { ConversationTurnRuntime } from "../core/runtime/conversation_turn_runtime.js";
import { createDefaultCoreDeps } from "../core/runtime/deps.js";
import { composeSessionPrompts } from "../core/runtime/session_prompt_composer.js";
import { CoreSession, type HistoryEntry } from "../core/session/core_session.js";
import type { SubagentToolName } from "../core/subagents/types.js";
import { ToolCatalog } from "../core/tools/catalog.js";
import type { ToolExecutionBackend } from "../core/tools/execution_backend.js";
import type { ResolveSubagentRuntime } from "../core/tools/registry.js";
import type { Persona, Skill } from "../core/types.js";
import { appendUsageLogEntry, getUsageCostTotal, getUsageTotals } from "../core/usage/logs.js";
import { extractAssistantText } from "../core/utils/messages.js";
import {
  extractAssistantTextForProgress,
  formatToolUiEventForProgress,
  getToolResultFirstLine,
} from "../core/utils/subagent_utils.js";
import type { ExecutionEnvironment } from "../execution/execution_environment.js";
import type {
  SessionProtocolEphemeralMessage,
  SessionProtocolEphemeralSubmitParams,
  SessionProtocolEphemeralSubmitResult,
} from "../protocol/session_protocol.js";
import { createExecutionEnvironmentSubagentRuntimeResolver } from "./execution_runtime.js";

export type EphemeralAgentUsageSnapshot = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  contextWindowUsageTokens: number;
  contextWindow: number;
};

type EphemeralAgentThreadUpdate = {
  costTotal: number;
  usage: EphemeralAgentUsageSnapshot;
  lastActivityText?: string;
};

type EphemeralAgentThreadForkSource = {
  historyEntries: readonly HistoryEntry[];
  usageBaseline: EphemeralAgentUsageSnapshot;
};

export type HostedEphemeralAgentSessionOptions = {
  contextId: string;
  persona: Persona;
  config: Config;
  modelResolver: ModelResolver;
  discoveredSkills: Skill[];
  includeAgentContext: boolean;
  executionEnvironment: ExecutionEnvironment;
  instructions: string;
  tools: SubagentToolName[];
  emitUpdate: (
    threadId: string,
    update: SessionProtocolEphemeralMessage["event"]["update"],
  ) => void;
};

type HostedEphemeralAgentThreadRecord = {
  thread: EphemeralAgentThread;
  activeRequestCount: number;
};

export class HostedEphemeralAgentSession {
  private readonly contextId: string;
  private readonly persona: Persona;
  private readonly config: Config;
  private readonly modelResolver: ModelResolver;
  private readonly discoveredSkills: Skill[];
  private readonly includeAgentContext: boolean;
  private readonly executionEnvironment: ExecutionEnvironment;
  private readonly instructions: string;
  private readonly tools: SubagentToolName[];
  private readonly emitUpdate: HostedEphemeralAgentSessionOptions["emitUpdate"];
  private readonly threads = new Map<string, HostedEphemeralAgentThreadRecord>();
  private disposed = false;

  constructor(options: HostedEphemeralAgentSessionOptions) {
    this.contextId = options.contextId;
    this.persona = structuredClone(options.persona);
    this.config = options.config;
    this.modelResolver = options.modelResolver;
    this.discoveredSkills = structuredClone(options.discoveredSkills);
    this.includeAgentContext = options.includeAgentContext;
    this.executionEnvironment = options.executionEnvironment;
    this.instructions = options.instructions;
    this.tools = [...options.tools];
    this.emitUpdate = options.emitUpdate;
  }

  async submitThreadMessage(
    options: Omit<SessionProtocolEphemeralSubmitParams, "sessionId">,
  ): Promise<SessionProtocolEphemeralSubmitResult> {
    this.assertActive();
    if (options.contextId !== this.contextId) {
      throw new Error(
        `ephemeral context '${this.contextId}' cannot submit to '${options.contextId}'`,
      );
    }

    const record = await this.getOrCreateThread(options.threadId, options.forkFromThreadId);
    record.activeRequestCount += 1;
    try {
      const response = await record.thread.submitMessage(options.message);
      return { threadId: options.threadId, response };
    } finally {
      record.activeRequestCount -= 1;
    }
  }

  dispose(): void {
    if (this.disposed) {
      return;
    }
    this.disposed = true;
    for (const record of this.threads.values()) {
      record.thread.interrupt();
      record.thread.dispose();
    }
    this.threads.clear();
  }

  private async getOrCreateThread(
    threadId: string,
    forkFromThreadId?: string,
  ): Promise<HostedEphemeralAgentThreadRecord> {
    const existing = this.threads.get(threadId);
    if (existing) {
      return existing;
    }

    const forkFrom = forkFromThreadId ? this.threads.get(forkFromThreadId) : undefined;
    if (forkFromThreadId && !forkFrom) {
      throw new Error(`unknown fork source thread '${forkFromThreadId}'`);
    }
    if (forkFrom && forkFrom.activeRequestCount > 0) {
      throw new Error(
        `thread '${forkFromThreadId}' already has an active request and cannot be used as a fork source`,
      );
    }

    const thread = await this.createThread(threadId, forkFrom?.thread.createForkSource());
    const record: HostedEphemeralAgentThreadRecord = { thread, activeRequestCount: 0 };
    this.threads.set(threadId, record);
    return record;
  }

  private async createThread(
    threadId: string,
    forkFrom?: EphemeralAgentThreadForkSource,
  ): Promise<EphemeralAgentThread> {
    const cwd = this.executionEnvironment.snapshot().cwd;
    const runtimeContext = await this.executionEnvironment.resolveRuntimeContext({
      cwd,
      persona: this.persona,
      discoveredSkills: this.discoveredSkills,
      includeAgentContext: this.includeAgentContext,
      agentContextFiles: this.config.agentContextFiles ?? [],
    });
    const deps = createDefaultCoreDeps();
    const promptContext = runtimeContext.promptBootstrap.promptContext;
    const promptComposition = composeSessionPrompts({
      persona: this.persona,
      cwd: promptContext.cwd,
      repoRoot: promptContext.repoRoot,
      datetime: new Date(deps.clock.now()).toISOString(),
      platform: promptContext.platform,
      nodeVersion: promptContext.nodeVersion,
      skillsBlock: promptContext.skillsBlock,
      projectContextBlock: promptContext.projectContextBlock,
    });

    return new EphemeralAgentThread({
      threadId,
      persona: this.persona,
      systemPrompt: [promptComposition.baseSystemPrompt, this.instructions].join("\n\n"),
      subagentPrompts: promptComposition.subagentPrompts,
      config: this.config,
      modelResolver: this.modelResolver,
      resolveSubagentRuntime: createExecutionEnvironmentSubagentRuntimeResolver({
        executionEnvironment: this.executionEnvironment,
        includeAgentContext: this.includeAgentContext,
        now: deps.clock.now,
      }),
      deps,
      backend: this.executionEnvironment.getToolExecutionBackend(),
      tools: this.tools,
      cwd: promptContext.cwd,
      home: promptContext.home ?? deps.env.home(),
      includeAgentContext: promptContext.includeAgentContext ?? this.includeAgentContext,
      ...(forkFrom ? { forkFrom } : {}),
      onUpdate: (update) => this.emitUpdate(threadId, update),
    });
  }

  private assertActive(): void {
    if (this.disposed) {
      throw new Error(`ephemeral context '${this.contextId}' is closed`);
    }
  }
}

type EphemeralAgentThreadOptions = {
  threadId: string;
  persona: Persona;
  systemPrompt: string;
  subagentPrompts: Record<string, string>;
  config: Config;
  modelResolver: ModelResolver;
  resolveSubagentRuntime: ResolveSubagentRuntime;
  deps: ReturnType<typeof createDefaultCoreDeps>;
  backend: ToolExecutionBackend;
  tools: SubagentToolName[];
  cwd: string;
  home: string;
  includeAgentContext: boolean;
  forkFrom?: EphemeralAgentThreadForkSource;
  onUpdate?: (update: EphemeralAgentThreadUpdate) => void;
};

class EphemeralAgentThread {
  private readonly session: CoreSession;
  private readonly runtime: ConversationTurnRuntime;
  private readonly personaId: string;
  private readonly reasoningEffort: string;
  private readonly onUpdate?: (update: EphemeralAgentThreadUpdate) => void;
  private costTotal = 0;
  private usage: EphemeralAgentUsageSnapshot;
  private lastActivityText?: string;

  constructor(options: EphemeralAgentThreadOptions) {
    const persona = createEphemeralPersona(options.persona, options.systemPrompt, options.tools);
    this.personaId = persona.id;
    this.reasoningEffort = persona.settings.reasoning ?? "none";
    this.onUpdate = options.onUpdate;
    this.usage = {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      contextWindowUsageTokens: 0,
      contextWindow: persona.model.contextWindow,
    };

    this.session = new CoreSession({
      persona,
      systemPrompt: options.systemPrompt,
      subagentPrompts: options.subagentPrompts,
      toolRegistry: ToolCatalog.createSubagentRegistry(
        options.tools,
        options.config,
        options.backend,
      ),
      modelResolver: options.modelResolver,
      resolveSubagentRuntime: options.resolveSubagentRuntime,
      config: options.config,
      deps: options.deps,
      cwd: options.cwd,
      home: options.home,
      includeAgentContext: options.includeAgentContext,
    });
    if (options.forkFrom) {
      this.usage = { ...options.forkFrom.usageBaseline };
      for (const entry of options.forkFrom.historyEntries) {
        this.session.addMessage(entry.message, { historyEntryId: entry.id });
      }
      this.emitUpdate();
    }

    this.runtime = new ConversationTurnRuntime(this.session);
  }

  async submitMessage(message: string): Promise<string> {
    this.session.addUserText(message);
    const result = await this.runtime.run({ onEvent: (event) => this.handleEvent(event) });
    if (result.aborted) {
      throw new Error("ephemeral agent thread was interrupted");
    }
    if (result.blocked) {
      throw new Error(result.blocked.message);
    }

    const assistantMessage = findLastAssistantMessage(this.session);
    if (!assistantMessage) {
      throw new Error("ephemeral agent thread produced no assistant response");
    }

    const response = extractAssistantText(assistantMessage).trim();
    if (!response) {
      throw new Error("ephemeral agent thread produced an empty assistant response");
    }

    appendUsageLogEntry({
      timestamp: assistantMessage.timestamp,
      sessionId: this.session.sessionId,
      personaId: this.personaId,
      provider: assistantMessage.provider,
      model: assistantMessage.model,
      api: assistantMessage.api,
      reasoningEffort: this.reasoningEffort,
      usage: getUsageTotals(assistantMessage.usage),
      cost: { total: getUsageCostTotal(assistantMessage.usage) },
      agent: { type: "ephemeral" },
    });

    return response;
  }

  interrupt(): boolean {
    return this.runtime.interrupt();
  }

  dispose(): void {
    this.session.dispose();
  }

  createForkSource(): EphemeralAgentThreadForkSource {
    return {
      historyEntries: this.session.rawHistoryEntries.map((entry) => ({
        id: entry.id,
        message: structuredClone(entry.message),
      })),
      usageBaseline: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        contextWindowUsageTokens: this.usage.contextWindowUsageTokens,
        contextWindow: this.usage.contextWindow,
      },
    };
  }

  private handleEvent(event: CoreEvent): void {
    switch (event.type) {
      case "tool_ui": {
        const progressText = formatToolUiEventForProgress(event.uiEvent);
        if (progressText) {
          this.lastActivityText = progressText;
          this.emitUpdate();
        }
        return;
      }
      case "tool_result": {
        if (!event.message.isError) {
          return;
        }
        const firstLine = getToolResultFirstLine(event.message);
        this.lastActivityText = firstLine
          ? `${event.message.toolName}: ${firstLine}`
          : `${event.message.toolName}: tool returned an error`;
        this.emitUpdate();
        return;
      }
      case "assistant_final": {
        const usageTotals = getUsageTotals(event.message.usage);
        this.costTotal += getUsageCostTotal(event.message.usage);
        this.usage = {
          ...this.usage,
          input: this.usage.input + usageTotals.input,
          output: this.usage.output + usageTotals.output,
          cacheRead: this.usage.cacheRead + usageTotals.cacheRead,
          cacheWrite: this.usage.cacheWrite + usageTotals.cacheWrite,
          contextWindowUsageTokens:
            usageTotals.input + usageTotals.output + usageTotals.cacheRead + usageTotals.cacheWrite,
        };
        this.lastActivityText =
          extractAssistantTextForProgress(event.message) ?? this.lastActivityText;
        this.emitUpdate();
        return;
      }
      default:
        return;
    }
  }

  private emitUpdate(): void {
    this.onUpdate?.({
      costTotal: this.costTotal,
      usage: { ...this.usage },
      ...(this.lastActivityText ? { lastActivityText: this.lastActivityText } : {}),
    });
  }
}

function createEphemeralPersona(
  persona: Persona,
  systemPrompt: string,
  tools: SubagentToolName[],
): Persona {
  const clone = structuredClone(persona);
  return {
    ...clone,
    id: `${clone.id}-ephemeral`,
    label: `${clone.label} ephemeral`,
    description: "Ephemeral assistant",
    systemPrompt,
    subagents: undefined,
    skills: clone.skills,
    tools,
  };
}

function findLastAssistantMessage(session: CoreSession): AssistantMessage | undefined {
  for (let index = session.historyEntries.length - 1; index >= 0; index -= 1) {
    const entry = session.historyEntries[index];
    if (entry?.message.role === "assistant") {
      return entry.message as AssistantMessage;
    }
  }
  return undefined;
}
