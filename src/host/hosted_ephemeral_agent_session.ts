import { randomUUID } from "node:crypto";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import {
  AgentRuntime,
  type AgentSpec,
  type AgentState,
  createAgentSpec,
} from "../core/agent/agent_runtime.js";
import type { AgentEvent } from "../core/agent/events.js";
import type { Config } from "../core/config/index.js";
import type { ModelResolver } from "../core/models/catalog.js";
import { resolveAgentModel } from "../core/runtime/agent_model.js";
import { createDefaultCoreDeps } from "../core/runtime/deps.js";
import { composeSessionPrompts } from "../core/runtime/session_prompt_composer.js";
import type { SubagentToolName } from "../core/subagents/types.js";
import { ToolCatalog } from "../core/tools/catalog.js";
import type { ToolUiEvent } from "../core/tools/registry.js";
import type { Persona, Skill } from "../core/types.js";
import {
  appendUsageLogEntry,
  getUsageCostTotal,
  getUsageTotals,
  type UsageRecorder,
} from "../core/usage/logs.js";
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
import { EphemeralThreadBusyError } from "./session_host.js";

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
  spec: AgentSpec;
  state: AgentState;
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
  recordUsage?: UsageRecorder;
};

export class HostedEphemeralAgentSession {
  private readonly threads = new Map<string, EphemeralAgentThread>();
  private readonly activeThreadIds = new Set<string>();
  private disposed = false;

  constructor(private readonly options: HostedEphemeralAgentSessionOptions) {}

  async submitThreadMessage(
    options: Omit<SessionProtocolEphemeralSubmitParams, "sessionId">,
  ): Promise<SessionProtocolEphemeralSubmitResult> {
    this.assertActive();
    if (options.contextId !== this.options.contextId) {
      throw new Error(
        `ephemeral context '${this.options.contextId}' cannot submit to '${options.contextId}'`,
      );
    }
    if (this.activeThreadIds.has(options.threadId)) {
      throw new EphemeralThreadBusyError(
        `thread '${options.threadId}' already has an active request`,
      );
    }
    if (options.forkFromThreadId && this.activeThreadIds.has(options.forkFromThreadId)) {
      throw new EphemeralThreadBusyError(
        `thread '${options.forkFromThreadId}' already has an active request and cannot be used as a fork source`,
      );
    }

    this.activeThreadIds.add(options.threadId);
    try {
      const thread = await this.getOrCreateThread(options.threadId, options.forkFromThreadId);
      return { threadId: options.threadId, response: await thread.submitMessage(options.message) };
    } finally {
      this.activeThreadIds.delete(options.threadId);
    }
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const thread of this.threads.values()) thread.dispose();
    this.threads.clear();
    this.activeThreadIds.clear();
  }

  private async getOrCreateThread(
    threadId: string,
    forkFromThreadId?: string,
  ): Promise<EphemeralAgentThread> {
    const existing = this.threads.get(threadId);
    if (existing) return existing;
    const source = forkFromThreadId ? this.threads.get(forkFromThreadId) : undefined;
    if (forkFromThreadId && !source)
      throw new Error(`unknown fork source thread '${forkFromThreadId}'`);
    const thread = await this.createThread(threadId, source?.createForkSource());
    this.threads.set(threadId, thread);
    return thread;
  }

  private async createThread(
    threadId: string,
    forkFrom?: EphemeralAgentThreadForkSource,
  ): Promise<EphemeralAgentThread> {
    const cwd = this.options.executionEnvironment.snapshot().cwd;
    const runtimeContext = await this.options.executionEnvironment.resolveRuntimeContext({
      cwd,
      persona: this.options.persona,
      discoveredSkills: this.options.discoveredSkills,
      includeAgentContext: this.options.includeAgentContext,
      agentContextFiles: this.options.config.agentContextFiles ?? [],
    });
    const deps = createDefaultCoreDeps();
    const promptContext = runtimeContext.promptBootstrap.promptContext;
    const composition = composeSessionPrompts({
      persona: this.options.persona,
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
      persona: this.options.persona,
      systemPrompt: [composition.baseSystemPrompt, this.options.instructions].join("\n\n"),
      config: this.options.config,
      deps,
      backend: this.options.executionEnvironment.getToolExecutionBackend(),
      tools: this.options.tools,
      cwd: promptContext.cwd,
      ...(forkFrom ? { forkFrom } : {}),
      onUpdate: (update) => this.options.emitUpdate(threadId, update),
      ...(this.options.recordUsage ? { recordUsage: this.options.recordUsage } : {}),
    });
  }

  private assertActive(): void {
    if (this.disposed) throw new Error(`ephemeral context '${this.options.contextId}' is closed`);
  }
}

type EphemeralAgentThreadOptions = {
  threadId: string;
  persona: Persona;
  systemPrompt: string;
  config: Config;
  deps: ReturnType<typeof createDefaultCoreDeps>;
  backend: ReturnType<ExecutionEnvironment["getToolExecutionBackend"]>;
  tools: SubagentToolName[];
  cwd: string;
  forkFrom?: EphemeralAgentThreadForkSource;
  onUpdate?: (update: EphemeralAgentThreadUpdate) => void;
  recordUsage?: UsageRecorder;
};

class EphemeralAgentThread {
  private readonly runtime: AgentRuntime;
  private readonly onUpdate?: (update: EphemeralAgentThreadUpdate) => void;
  private readonly recordUsage: UsageRecorder;
  private costTotal = 0;
  private usage: EphemeralAgentUsageSnapshot;
  private lastActivityText?: string;

  constructor(options: EphemeralAgentThreadOptions) {
    const spec =
      options.forkFrom?.spec ??
      createAgentSpec({
        ...resolveAgentModel(
          createEphemeralPersona(options.persona, options.systemPrompt, options.tools),
          options.config,
          { includeModelNotice: false, deps: options.deps },
        ),
        systemPrompt: options.systemPrompt,
        tools: ToolCatalog.createSubagentRegistry(
          options.tools,
          options.backend,
          options.cwd,
          options.config,
        ),
      });
    this.onUpdate = options.onUpdate;
    this.recordUsage = options.recordUsage ?? appendUsageLogEntry;
    this.usage = options.forkFrom?.usageBaseline ?? {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      contextWindowUsageTokens: 0,
      contextWindow: spec.model.model.contextWindow,
    };
    const state = options.forkFrom
      ? {
          ...options.forkFrom.state,
          agentId: `ephemeral-${options.threadId}-${randomUUID()}`,
        }
      : undefined;
    this.runtime = new AgentRuntime({
      spec,
      eventSink: async (event) => this.handleEvent(event),
      ...(state ? { state } : {}),
      deps: options.deps,
    });
  }

  async submitMessage(message: string): Promise<string> {
    const result = await this.runtime.submit(message);
    if (result.aborted) throw new Error("ephemeral agent thread was interrupted");
    if (result.blocked) throw new Error(result.blocked.message);
    const assistant = [...this.runtime.rawHistory]
      .reverse()
      .find((entry): entry is AssistantMessage => entry.role === "assistant");
    if (!assistant) throw new Error("ephemeral agent thread produced no assistant response");
    const response = extractAssistantText(assistant).trim();
    if (!response) throw new Error("ephemeral agent thread produced an empty assistant response");
    return response;
  }

  dispose(): void {
    this.runtime.dispose();
  }

  createForkSource(): EphemeralAgentThreadForkSource {
    return {
      spec: this.runtime.spec as AgentSpec,
      state: this.runtime.snapshot(),
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

  private async handleEvent(event: AgentEvent): Promise<void> {
    switch (event.type) {
      case "tool_activity":
        this.lastActivityText =
          formatToolUiEventForProgress(event.activity as ToolUiEvent) ?? this.lastActivityText;
        break;
      case "tool_result":
        if (event.message.isError) {
          const firstLine = getToolResultFirstLine(event.message);
          this.lastActivityText = firstLine
            ? `${event.message.toolName}: ${firstLine}`
            : `${event.message.toolName}: tool returned an error`;
        }
        break;
      case "assistant_final": {
        const usage = getUsageTotals(event.message.usage);
        const cost = getUsageCostTotal(event.message.usage);
        this.costTotal += cost;
        this.usage = {
          ...this.usage,
          input: this.usage.input + usage.input,
          output: this.usage.output + usage.output,
          cacheRead: this.usage.cacheRead + usage.cacheRead,
          cacheWrite: this.usage.cacheWrite + usage.cacheWrite,
          contextWindowUsageTokens: usage.input + usage.output + usage.cacheRead + usage.cacheWrite,
        };
        this.lastActivityText =
          extractAssistantTextForProgress(event.message) ?? this.lastActivityText;
        this.recordUsage({
          timestamp: event.message.timestamp,
          sessionId: this.runtime.agentIdValue,
          personaId: event.personaId,
          provider: event.message.provider,
          model: event.message.model,
          api: event.message.api,
          reasoningEffort: event.reasoningEffort,
          usage,
          cost: { total: cost },
          agent: { type: "ephemeral" },
        });
        break;
      }
      default:
        return;
    }
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
  return {
    ...structuredClone(persona),
    id: `${persona.id}-ephemeral`,
    label: `${persona.label} ephemeral`,
    description: "Ephemeral assistant",
    systemPrompt,
    subagents: undefined,
    tools,
  };
}
