import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { Config } from "../config/index.js";
import type { CoreEvent } from "../events/types.js";
import { ConversationTurnRuntime } from "../runtime/conversation_turn_runtime.js";
import type { CoreDeps } from "../runtime/deps.js";
import { createDefaultCoreDeps } from "../runtime/deps.js";
import { resolveRuntimePromptBootstrap } from "../runtime/runtime_bootstrap.js";
import {
  composeSessionPrompts,
  type SessionPromptComposition,
} from "../runtime/session_prompt_composer.js";
import { CoreSession, type HistoryEntry } from "../session/core_session.js";
import { renderDiffReviewWrapperPrompt } from "../static/index.js";
import { ToolCatalog } from "../tools/catalog.js";
import {
  createLocalToolExecutionBackend,
  type ToolExecutionBackend,
} from "../tools/execution_backend.js";
import { TOOL_NAME_BASH, TOOL_NAME_VIEW_IMAGE } from "../tools/tool_names.js";
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
  threadId?: string;
  historyEntries: readonly HistoryEntry[];
  usageBaseline: DiffReviewAgentUsageSnapshot;
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
  promptComposition?: SessionPromptComposition;
  onUpdate?: (update: DiffReviewThreadUpdate) => void;
  forkFrom?: DiffReviewThreadForkSource;
};

export class DiffReviewThread {
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
    const promptBootstrap = options.promptComposition
      ? undefined
      : resolveRuntimePromptBootstrap({
          persona,
          discoveredSkills: options.discoveredSkills ?? [],
          cwd: options.snapshot.cwd,
          home: deps.env.home(),
          includeAgentContext: options.includeAgentContext ?? true,
          readFile: deps.fs.readFile,
        });
    const promptComposition =
      options.promptComposition ??
      composeSessionPrompts({
        persona,
        riskLevel: "read-only",
        cwd: promptBootstrap!.promptContext.cwd,
        datetime: new Date(deps.clock.now()).toISOString(),
        platform: deps.env.platform(),
        nodeVersion: deps.env.nodeVersion(),
        skillsBlock: promptBootstrap!.promptContext.skillsBlock,
        projectContextBlock: promptBootstrap!.promptContext.projectContextBlock,
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
      cwd: promptBootstrap?.promptContext.cwd ?? options.snapshot.cwd,
      home: promptBootstrap?.promptContext.home ?? deps.env.home(),
      includeAgentContext:
        promptBootstrap?.promptContext.includeAgentContext ?? options.includeAgentContext ?? true,
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
    if (result.blocked) {
      throw new Error(result.blocked.message);
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

  dispose(): void {
    this.session.dispose();
  }

  createForkSource(): DiffReviewThreadForkSource {
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

export function buildDiffReviewSystemPrompt(
  mainPersonaSystemPrompt: string,
  snapshot: DiffReviewSnapshot,
): string {
  return renderDiffReviewWrapperPrompt({
    inheritedInstructions: mainPersonaSystemPrompt,
    reviewContext: buildReviewContextBlock(snapshot),
  });
}

export function buildDiffReviewInstructions(snapshot: DiffReviewSnapshot): string {
  return [
    "You are Tau's diff review assistant.",
    "",
    "### Rules",
    "",
    "Keep the following in mind as you work:",
    "",
    "- The user is working in Tau's diff review workflow. Treat the review context below as the user-selected review scope. It may be only part of the current repo changes.",
    "- Keep the review centered on that scope by default. That scoped patch is the default review target, even when it is narrower than the repo's overall changes.",
    "- The review context reflects the initial diff Tau captured when the review session started. The live repo state is authoritative when you inspect code or answer follow-up questions.",
    "- Support the full review workflow within that scope: explain what changed, answer follow-up questions, assess correctness and regression risk, discuss tradeoffs, and point out missing validation when it matters.",
    "- If answering well requires nearby or out-of-scope repo context, inspect it as needed, but use it to support the in-scope review unless the user asks to broaden the review target.",
    "- Never mutate files, install packages, or act like a general coding agent. You are here to help review and explain code, not to implement changes.",
    "- Keep answers concise unless the user asks for more. Prefer dense, direct, prose-style responses with minimal preamble and only use bullets when they genuinely help.",
    "- Be concrete and technically specific. Reference files or code paths when useful. Distinguish confirmed facts from inference, and say when something cannot be verified from the available context.",
    "",
    "### Review context",
    "",
    buildReviewContextBlock(snapshot),
  ].join("\n");
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
    tools: [TOOL_NAME_BASH, TOOL_NAME_VIEW_IMAGE],
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
    `Initial review scope: ${snapshot.toDiffCommand()}`,
    "",
    "Files in review scope:",
    changedFiles,
    "",
    "This review context is the exact change selection captured when the review session started. It may be narrower than the full set of current repo changes.",
    "Treat this scoped patch as the default review target.",
    "If answering well requires code outside this scope, inspect it as needed, but use it as supporting context unless the user broadens the review target.",
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
