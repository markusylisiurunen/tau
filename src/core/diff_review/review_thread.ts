import type { AssistantMessage } from "@mariozechner/pi-ai";
import type { Config } from "../config/index.js";
import type { CoreEvent } from "../events/types.js";
import { ConversationTurnRuntime } from "../runtime/conversation_turn_runtime.js";
import type { CoreDeps } from "../runtime/deps.js";
import { createDefaultCoreDeps } from "../runtime/deps.js";
import { resolveRuntimePromptBootstrap } from "../runtime/runtime_bootstrap.js";
import { composeSessionPrompts } from "../runtime/session_prompt_composer.js";
import { CoreSession, type HistoryEntry } from "../session/core_session.js";
import { renderDiffReviewWrapperPrompt } from "../static/index.js";
import { BASH_TOOL } from "../tools/bash.js";
import { ToolCatalog } from "../tools/catalog.js";
import {
  createLocalToolExecutionBackend,
  type ToolExecutionBackend,
} from "../tools/execution_backend.js";
import { TOOL_NAME_BASH, TOOL_NAME_VIEW_IMAGE } from "../tools/tool_names.js";
import { VIEW_IMAGE_TOOL } from "../tools/view_image.js";
import type { Persona, Skill } from "../types.js";
import { appendUsageLogEntry, getUsageCostTotal, getUsageTotals } from "../usage/logs.js";
import { extractAssistantText } from "../utils/messages.js";
import {
  extractAssistantTextForProgress,
  formatToolUiEventForProgress,
  getToolResultFirstLine,
} from "../utils/subagent_utils.js";
import type { DiffReviewSnapshot } from "./snapshot.js";

export type DiffReviewAgentUsageSnapshot = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  contextWindowUsageTokens: number;
  contextWindow: number;
};

export type DiffReviewThreadUpdate = {
  costTotal: number;
  usage: DiffReviewAgentUsageSnapshot;
  lastActivityText?: string;
};

export type DiffReviewThreadForkSource = {
  historyEntries: readonly HistoryEntry[];
  usageBaseline: DiffReviewAgentUsageSnapshot;
};

export type DiffReviewThreadSession = {
  submitMessage(message: string): Promise<string>;
  interrupt(): boolean;
  createForkSource(): DiffReviewThreadForkSource;
};

export type CreateDiffReviewThreadOptions = {
  threadId: string;
  snapshot: DiffReviewSnapshot;
  persona: Persona;
  config: Config;
  discoveredSkills?: Skill[];
  includeAgentContext?: boolean;
  deps?: CoreDeps;
  toolExecutionBackend?: ToolExecutionBackend;
  onUpdate?: (update: DiffReviewThreadUpdate) => void;
  forkFrom?: DiffReviewThreadForkSource;
};

export class DiffReviewThread implements DiffReviewThreadSession {
  private readonly session: CoreSession;
  private readonly runtime: ConversationTurnRuntime;
  private readonly personaId: string;
  private readonly reasoningEffort: string;
  private readonly onUpdate?: (update: DiffReviewThreadUpdate) => void;
  private costTotal = 0;
  private usage: DiffReviewAgentUsageSnapshot;
  private lastActivityText?: string;

  constructor(options: CreateDiffReviewThreadOptions) {
    const deps = options.deps ?? createDefaultCoreDeps();
    const backend =
      options.toolExecutionBackend ??
      createLocalToolExecutionBackend({
        spawn: deps.spawn,
        env: deps.env,
      });
    this.personaId = options.persona.id;
    this.reasoningEffort = options.persona.settings.reasoning ?? "none";
    this.onUpdate = options.onUpdate;
    this.usage = {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      contextWindowUsageTokens: 0,
      contextWindow: options.persona.model.contextWindow,
    };
    const persona = createDiffReviewPersona(options.persona, options.snapshot);
    const promptBootstrap = resolveRuntimePromptBootstrap({
      persona,
      discoveredSkills: options.discoveredSkills ?? [],
      cwd: options.snapshot.cwd,
      home: deps.env.home(),
      includeAgentContext: options.includeAgentContext ?? true,
      sandboxEnabled: false,
      readFile: deps.fs.readFile,
    });
    const promptComposition = composeSessionPrompts({
      persona,
      riskLevel: "read-only",
      cwd: promptBootstrap.promptContext.cwd,
      hostCwd: promptBootstrap.promptContext.hostCwd,
      datetime: new Date(deps.clock.now()).toISOString(),
      platform: deps.env.platform(),
      nodeVersion: deps.env.nodeVersion(),
      skillsBlock: promptBootstrap.promptContext.skillsBlock,
      projectContextBlock: promptBootstrap.promptContext.projectContextBlock,
      sandboxEnabled: false,
    });
    const toolRegistry = ToolCatalog.createSubagentRegistry(
      [TOOL_NAME_BASH, TOOL_NAME_VIEW_IMAGE],
      options.config,
      backend,
    );

    this.session = new CoreSession({
      persona,
      systemPrompt: promptComposition.baseSystemPrompt,
      subagentPrompts: promptComposition.subagentPrompts,
      riskLevel: "read-only",
      toolRegistry,
      config: options.config,
      deps,
      cwd: promptBootstrap.promptContext.cwd,
      hostCwd: promptBootstrap.promptContext.hostCwd,
      home: promptBootstrap.promptContext.home,
      includeAgentContext: promptBootstrap.promptContext.includeAgentContext,
      sandboxEnabled: false,
    });
    if (options.forkFrom) {
      this.usage = { ...options.forkFrom.usageBaseline };
      for (const entry of options.forkFrom.historyEntries) {
        this.session.addMessage(entry.message, {
          historyEntryId: entry.id,
        });
      }
      this.emitUpdate();
    }

    this.runtime = new ConversationTurnRuntime(this.session);
  }

  async submitMessage(message: string): Promise<string> {
    this.session.addUserText(message);
    const result = await this.runtime.run({
      onEvent: (event) => this.handleEvent(event),
    });
    if (result.aborted) {
      throw new Error("diff review thread was interrupted");
    }

    const assistantMessage = findLastAssistantMessage(this.session);
    if (!assistantMessage) {
      throw new Error("diff review thread produced no assistant response");
    }

    const response = extractAssistantText(assistantMessage).trim();
    if (!response) {
      throw new Error("diff review thread produced an empty assistant response");
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
      agent: { type: "review" },
    });

    return response;
  }

  interrupt(): boolean {
    return this.runtime.interrupt();
  }

  createForkSource(): DiffReviewThreadForkSource {
    return {
      historyEntries: this.session.historyEntries.map((entry) => ({
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

export function buildDiffReviewSystemPrompt(
  mainPersonaSystemPrompt: string,
  snapshot: DiffReviewSnapshot,
): string {
  return renderDiffReviewWrapperPrompt({
    inheritedInstructions: mainPersonaSystemPrompt,
    reviewContext: buildReviewContextBlock(snapshot),
  });
}

function createDiffReviewPersona(persona: Persona, snapshot: DiffReviewSnapshot): Persona {
  return {
    ...persona,
    id: `${persona.id}-diff-review`,
    label: `${persona.label} diff review`,
    description: "Diff review assistant",
    systemPrompt: buildDiffReviewSystemPrompt(persona.systemPrompt, snapshot),
    subagents: undefined,
    skills: persona.skills,
    tools: [BASH_TOOL, VIEW_IMAGE_TOOL],
  };
}

function buildReviewContextBlock(snapshot: DiffReviewSnapshot): string {
  const changedFiles =
    snapshot.files.length > 0
      ? snapshot.files
          .map((file) => {
            const path =
              file.oldPath && file.newPath && file.oldPath !== file.newPath
                ? `${file.oldPath} -> ${file.newPath}`
                : file.path;
            return `- ${path} (${file.status})`;
          })
          .join("\n")
      : "- (no changed files)";

  return [
    `Repo root: ${snapshot.repoRoot}`,
    `Cwd: ${snapshot.cwd}`,
    `Initial diff command: ${snapshot.toDiffCommand()}`,
    "",
    "Initial changed files:",
    changedFiles,
    "",
    "This review context is the starting point captured when /diff opened.",
    "The current repo state is authoritative. Use read-only tools to inspect relevant repo context when needed.",
  ].join("\n");
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
