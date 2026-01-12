import { mkdtemp, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AssistantMessage, KnownProvider, Message } from "@mariozechner/pi-ai";
import { streamSimple } from "@mariozechner/pi-ai";
import { Spacer, TUI } from "@mariozechner/pi-tui";
import { type BashCommand, loadBashCommands } from "./bash_commands.js";
import { copyTextToClipboard } from "./clipboard.js";
import { buildHelpText, getRiskLevelDescription, parseCommand } from "./commands.js";
import type { Config } from "./config.js";
import { getApiKeyForProvider } from "./config.js";
import { loadAllContent } from "./content_loader.js";
import { buildExportEntriesFromHistory } from "./export/engine_history.js";
import { renderExport } from "./export/index.js";
import type { PromptTemplate } from "./prompts.js";
import { SessionEngine } from "./session/session_engine.js";
import { formatSubagentsForPrompt } from "./subagents/registry.js";
import { createAppTerminal } from "./terminal.js";
import {
  BASH_USER_MAX_STDERR_LINES,
  BASH_USER_MAX_STDERR_TOKENS,
  BASH_USER_MAX_STDOUT_LINES,
  BASH_USER_MAX_STDOUT_TOKENS,
  createBashToolDefinition,
  executeBashTool,
  formatBashUserMessageText,
  prepareBashOutput,
} from "./tools/bash.js";
import { createEditToolDefinition } from "./tools/edit.js";
import { createForkToolDefinition } from "./tools/fork.js";
import { createGrepToolDefinition } from "./tools/grep.js";
import { createListToolDefinition } from "./tools/list.js";
import { createReadToolDefinition } from "./tools/read.js";
import { ToolRegistry } from "./tools/registry.js";
import { createTaskToolDefinition } from "./tools/task.js";
import { createWriteToolDefinition } from "./tools/write.js";
import {
  type Persona,
  REASONING_LEVELS,
  type ReasoningEffort,
  type RiskLevel,
  type Skill,
} from "./types.js";
import {
  buildBashAbortedView,
  buildBashBlockedView,
  buildBashExecutionView,
  buildBashRunningView,
} from "./ui/bash_execution.js";
import { ChatContainerComponent } from "./ui/chat_container.js";
import type { AssistantMessageModel } from "./ui/chat_message_model.js";
import { CustomEditor } from "./ui/custom_editor.js";
import {
  buildEditBlockedView,
  buildEditSuccessView,
  buildWriteBlockedView,
  buildWriteSuccessView,
} from "./ui/file_execution.js";
import { FooterComponent } from "./ui/footer.js";
import { QueuedMessagesComponent } from "./ui/queued_messages.js";
import {
  buildGrepBlockedView,
  buildGrepFinishedView,
  buildGrepRunningView,
  buildListBlockedView,
  buildListSuccessView,
  buildReadBlockedView,
  buildReadSuccessView,
} from "./ui/restricted_execution.js";
import { getFileAutocompleteToken, SlashAutocompleteProvider } from "./ui/slash_autocomplete.js";
import type { SystemMessageKind } from "./ui/system_message.js";
import {
  buildTaskBlockedView,
  buildTaskFinishedView,
  buildTaskRunningView,
} from "./ui/task_execution.js";
import { createUiTheme, type Theme } from "./ui/theme.js";
import { buildThemePreviewMessages } from "./ui/theme_preview.js";
import {
  buildBaseSystemPrompt,
  buildEnvironmentTag,
  buildProjectContextBlock,
  buildSkillsIndexBlock,
  findAgentsFilesInScopeDetailed,
  formatRiskLevelChangeNotice,
} from "./utils/context.js";
import { formatHistoryForCompression } from "./utils/fork.js";
import { formatAdaptiveNumber, formatCwd, formatTokenWindow } from "./utils/format.js";
import { getGitRoot } from "./utils/git.js";
import { extractAllFencedCodeBlocks, extractAssistantText } from "./utils/messages.js";
import { listProjectFiles, listProjectFilesAsync } from "./utils/project_files.js";
import { APP_VERSION } from "./version.js";

type RunningBashComponent = {
  command: string;
};

type RunningTaskComponent = {
  kind: "task" | "fork";
  name?: string;
  title: string;
  costTotal: number;
  turns: number;
  toolCalls: number;
};

export interface ChatAppOptions {
  personas: Persona[];
  prompts?: PromptTemplate[];
  skills?: Skill[];
  bashCommands?: BashCommand[];
  initialPersonaId?: string;
  initialUserMessage?: string;
  initialRiskLevel?: RiskLevel;
  withContext?: boolean;
  themePreview?: boolean;
  config?: Config;
}

export class ChatApp {
  private ui: TUI;
  private chatContainer: ChatContainerComponent;
  private footer: FooterComponent;
  private queuedMessages: QueuedMessagesComponent;
  private editor: CustomEditor;
  private uiTheme: Theme;

  private personas: Persona[];
  private currentPersona: Persona;
  private prompts: PromptTemplate[];
  private skills: Skill[];
  private bashCommands: BashCommand[];
  private readonly repoRoot: string;
  private initialUserMessage?: string;
  private config: Config;

  private readonly engine: SessionEngine;
  private runningBashComponents: Map<string, RunningBashComponent> = new Map();
  private runningTaskComponents: Map<string, RunningTaskComponent> = new Map();
  private taskEvents: Map<string, string[]> = new Map(); // toolCallId -> accumulated events
  private subagentCostTotal = 0;

  private isStreaming = false;
  private queuedUserMessages: string[] = [];
  private isDrainingQueuedUserMessages = false;
  private pendingIdleNotification = false;
  private isBashMode = false;
  private isMemoryMode = false;
  private showThinking = false;
  private compactToolUi = true;
  private currentTurnAbort?: AbortController;
  private riskLevel: RiskLevel = "read-only";
  private readonly initialRiskLevel: RiskLevel;
  private environmentTag: string;
  private readonly projectContextBlock?: string;
  private projectFiles: string[] = [];
  private isRefreshingProjectFiles = false;
  private isInFileAutocomplete = false;
  private readonly agentsFiles: string[];
  private readonly agentsConfigErrors: string[];
  private baseSystemPrompt: string;
  private pendingRiskLevelChange?: { from: RiskLevel; to: RiskLevel };
  private previousSessionSummary?: string;
  private expandedFilesInCurrentPrompt: Set<string> = new Set();
  private expandedSkillsInCurrentPrompt: Set<string> = new Set();
  private currentTurnStartedAt?: number;
  private lastTurnDurationMs = 0;
  private turnTimer?: ReturnType<typeof setInterval>;
  private themePreview: boolean;

  constructor(options: ChatAppOptions) {
    this.personas = options.personas;
    this.prompts = options.prompts ?? [];
    this.skills = options.skills ?? [];
    this.bashCommands = options.bashCommands ?? [];
    this.repoRoot = getGitRoot(process.cwd()) ?? process.cwd();
    this.initialUserMessage = options.initialUserMessage;
    this.config = options.config ?? {};
    this.compactToolUi = this.config.toolDisplayMode !== "full";
    this.themePreview = options.themePreview ?? false;
    this.showThinking = this.themePreview;
    if (this.themePreview) {
      this.queuedUserMessages.push(
        "Queue: adjust muted contrast and preview again",
        "Queue: verify tool error colors",
      );
    }

    if (options.withContext) {
      const res = findAgentsFilesInScopeDetailed(process.cwd(), homedir(), this.repoRoot);
      this.agentsFiles = res.files;
      this.agentsConfigErrors = res.errors;
    } else {
      this.agentsFiles = [];
      this.agentsConfigErrors = [];
    }

    this.projectContextBlock = options.withContext
      ? buildProjectContextBlock({
          cwd: process.cwd(),
          home: homedir(),
          agentsFiles: this.agentsFiles,
        })
      : undefined;

    this.projectFiles = listProjectFiles(process.cwd());

    this.currentPersona =
      (options.initialPersonaId &&
        this.personas.find(
          (p) => p.id.toLowerCase() === options.initialPersonaId!.toLowerCase(),
        )) ||
      this.personas[0]!;
    this.clampPersonaReasoning(this.currentPersona);

    if (options.initialRiskLevel) {
      this.riskLevel = options.initialRiskLevel;
    }
    const allowedRiskLevels = this.getAllowedRiskLevelsForPersona(this.currentPersona);
    if (!allowedRiskLevels.includes(this.riskLevel)) {
      this.riskLevel = allowedRiskLevels[0] ?? "read-only";
    }
    this.initialRiskLevel = this.riskLevel;

    this.environmentTag = buildEnvironmentTag({
      riskLevel: this.initialRiskLevel,
      cwd: process.cwd(),
      datetime: new Date().toISOString(),
    });

    this.baseSystemPrompt = buildBaseSystemPrompt({
      personaSystemPrompt: this.currentPersona.systemPrompt,
      skillsBlock: this.getSkillsIndexBlockForPersona(this.currentPersona).skillsBlock,
      projectContextBlock: this.projectContextBlock,
      environmentTag: this.environmentTag,
      userPreferences: this.config.userPreferences,
      subagentsBlock: formatSubagentsForPrompt(this.currentPersona),
    });

    const toolRegistry = new ToolRegistry([
      createBashToolDefinition(),
      createWriteToolDefinition(),
      createEditToolDefinition(),
      createTaskToolDefinition(),
      createForkToolDefinition(),
      createReadToolDefinition(),
      createGrepToolDefinition(),
      createListToolDefinition(),
    ]);
    this.engine = new SessionEngine({
      persona: this.currentPersona,
      systemPrompt: this.baseSystemPrompt,
      riskLevel: this.riskLevel,
      toolRegistry,
      config: this.config,
    });

    this.uiTheme = createUiTheme("ansi");
    this.ui = new TUI(createAppTerminal());
    this.chatContainer = new ChatContainerComponent(this.uiTheme, this.showThinking);
    this.chatContainer.setCompactToolUi(this.compactToolUi);
    this.footer = new FooterComponent(this.uiTheme, this.ui);
    this.queuedMessages = new QueuedMessagesComponent(this.uiTheme, this.queuedUserMessages);
    this.editor = new CustomEditor(this.uiTheme);

    this.setupUI();
    this.setupEditor();
  }

  private setupUI(): void {
    this.ui.addChild(this.chatContainer);
    this.ui.addChild(new Spacer(1));
    this.ui.addChild(this.queuedMessages);
    this.ui.addChild(this.editor);
    this.ui.addChild(this.footer);

    if (this.themePreview) {
      const messages = buildThemePreviewMessages(this.uiTheme);
      for (const message of messages) {
        this.chatContainer.addMessage(message);
      }
    } else {
      this.chatContainer.addMessage({
        type: "app_intro",
        appName: "tau",
        version: APP_VERSION,
        helpText: buildHelpText(
          this.agentsFiles,
          this.skills,
          this.getAllowedRiskLevelsForPersona(this.currentPersona),
        ),
      });

      if (this.agentsConfigErrors.length > 0) {
        this.addSystemMessage(
          ["agents config warnings:", ...this.agentsConfigErrors.map((e) => `- ${e}`)].join("\n"),
          "warn",
        );
      }
    }

    this.ui.setFocus(this.editor);

    this.updateFooter();
    this.updateEditorBorderColor();
  }

  private setupEditor(): void {
    this.editor.onCtrlC = () => {
      this.stop();
      process.exit(0);
    };
    this.editor.onCtrlT = () => this.toggleThinkingVisibility();
    this.editor.onCtrlO = () => this.toggleCompactToolUi();
    this.editor.onShiftTab = () => this.cycleReasoningLevel();
    this.editor.onCtrlR = () => this.cycleRiskLevel();
    this.editor.onCtrlP = () => this.cyclePersonality();
    this.editor.onCtrlS = () => void this.stashEditorToClipboard();
    this.editor.onEscape = () => this.interruptAssistantTurn();
    this.editor.onCtrlF = () => {
      this.expandFileMentions().catch((err) => {
        this.addSystemMessage(`mention expansion failed: ${(err as Error).message}`, "error");
      });
    };

    this.editor.onAltUp = () => this.popQueuedUserMessageIntoEditor();
    this.editor.beforeSubmit = (text: string) => {
      if (this.themePreview) {
        return false;
      }
      if (!this.isStreaming) return true;
      const trimmed = text.trimStart();
      return !trimmed.startsWith("/") && !trimmed.startsWith("!");
    };

    this.editor.onChange = (text: string) => {
      const wasBash = this.isBashMode;
      const wasMemory = this.isMemoryMode;
      const wasInFileAutocomplete = this.isInFileAutocomplete;

      const trimmed = text.trimStart();
      this.isBashMode = trimmed.startsWith("!");
      this.isMemoryMode = trimmed.startsWith("#");

      const beforeCursor = this.getEditorTextBeforeCursor();
      this.isInFileAutocomplete = Boolean(getFileAutocompleteToken(beforeCursor));

      if (!wasInFileAutocomplete && this.isInFileAutocomplete) {
        this.refreshProjectFilesInBackground();
      }

      if (wasBash !== this.isBashMode || wasMemory !== this.isMemoryMode) {
        this.updateEditorBorderColor();
      }
    };

    this.editor.setAutocompleteProvider(
      new SlashAutocompleteProvider(
        () => this.personas.map((p) => ({ id: p.id, label: p.label })),
        () => this.prompts.map((t) => ({ id: t.id, label: t.label })),
        () =>
          this.bashCommands.map((b) => ({
            id: b.id,
            description: b.description,
          })),
        () => this.projectFiles,
        () => this.skills.map((skill) => skill.name),
        () => this.getAllowedRiskLevelsForPersona(this.currentPersona),
      ),
    );

    this.editor.onSubmit = (text) => this.handleSubmit(text);
  }

  private getEditorTextBeforeCursor(): string {
    const { line, col } = this.editor.getCursor();
    const lines = this.editor.getLines();
    const current = lines[line] ?? "";
    return current.slice(0, col);
  }

  private refreshProjectFilesInBackground(): void {
    if (this.isRefreshingProjectFiles) return;

    this.isRefreshingProjectFiles = true;

    void listProjectFilesAsync(process.cwd())
      .then((files) => {
        this.projectFiles = files;
      })
      .catch(() => {
        // Ignore refresh errors; autocomplete will keep using the existing cache.
      })
      .finally(() => {
        this.isRefreshingProjectFiles = false;
      });
  }

  async start(): Promise<void> {
    this.ui.start();

    if (this.themePreview) {
      return;
    }

    if (this.initialUserMessage) {
      await this.sendInitialUserMessage(this.initialUserMessage);
    }
  }

  stop(): void {
    this.ui.stop();
  }

  // UI Updates ------------------------------------------------------------------------------------

  private updateFooter(): void {
    const reasoningLabel = this.currentPersona.settings.reasoning ?? "none";
    const contextUsage = this.getContextUsageString();
    const sessionCost = this.getSessionCostString();
    const cwd = formatCwd(process.cwd());
    const duration = this.getTurnDurationString();

    const personaName = this.currentPersona.label || this.currentPersona.id;
    this.footer.setStatus({
      contextUsage,
      sessionCost,
      duration,
      riskLevel: this.riskLevel,
    });
    this.updateEditorHeader(cwd, personaName, reasoningLabel);
    this.ui.requestRender();
  }

  private updateEditorBorderColor(): void {
    const { palette } = this.uiTheme;
    if (this.isBashMode) {
      this.editor.borderColor = (s: string) => palette.modeBash(s);
    } else if (this.isMemoryMode) {
      this.editor.borderColor = (s: string) => palette.modeMemory(s);
    } else {
      this.editor.borderColor = this.uiTheme.editorBorderForReasoning(
        this.currentPersona.settings.reasoning,
      );
    }
    this.updateEditorHeader();
    this.ui.requestRender();
  }

  private updateEditorHeader(
    cwd: string = formatCwd(process.cwd()),
    personaName: string = this.currentPersona.label || this.currentPersona.id,
    reasoningLabel: string = this.currentPersona.settings.reasoning ?? "none",
  ): void {
    if (this.themePreview) {
      const labelStyle = this.uiTheme.palette.textMuted;
      this.editor.setHeader("theme preview", "model disabled", {
        leftStyle: labelStyle,
        rightStyle: labelStyle,
      });
      return;
    }
    if (this.isBashMode) {
      this.editor.setHeader("bash", "", { leftStyle: this.editor.borderColor });
      return;
    }
    if (this.isMemoryMode) {
      this.editor.setHeader("memoize", "", { leftStyle: this.editor.borderColor });
      return;
    }
    this.editor.setHeader(cwd, `${personaName} (${reasoningLabel})`);
  }

  private addSystemMessage(text: string, kind: SystemMessageKind): void {
    const cleanedText = this.normalizeSystemMessageText(text, kind);
    const toastText = this.formatToastText(cleanedText);
    if (kind !== "muted" && toastText.length > 0) {
      this.footer.showToast(toastText, kind, 3000);
    }

    if (this.shouldPersistSystemMessage(cleanedText, kind)) {
      this.chatContainer.addMessage({ type: "system", text: cleanedText, kind });
      this.ui.requestRender();
    }
  }

  private normalizeSystemMessageText(text: string, kind: SystemMessageKind): string {
    const cleaned = kind !== "error" ? text : text.replace(/^\s*error:\s*/i, "");
    return this.stripTrailingPunctuation(cleaned);
  }

  private stripTrailingPunctuation(text: string): string {
    const trimmed = text.replace(/\s+$/, "");
    if (!trimmed) return trimmed;
    return trimmed.replace(/[.!?…,:;]+$/, "");
  }

  private formatToastText(text: string): string {
    const firstLine = text.split(/\r?\n/, 1)[0] ?? "";
    return firstLine.replace(/\s+/g, " ").trim();
  }

  private shouldPersistSystemMessage(text: string, kind: SystemMessageKind): boolean {
    if (kind === "muted" || kind === "error") return true;
    if (text.includes("\n")) return true;
    return text.length > 140;
  }

  private formatRiskLevelNotice(level: RiskLevel): string {
    const details = getRiskLevelDescription(level);
    return details ? `risk level ${level} (${details})` : `risk level ${level}`;
  }

  private addUserMessage(text: string, opts?: { isMemoryMode?: boolean }): void {
    this.chatContainer.addMessage({
      type: "user",
      text,
      isMemoryMode: opts?.isMemoryMode,
    });
    this.ui.requestRender();
  }

  // Context & Cost Tracking -----------------------------------------------------------------------

  private getContextUsageString(): string {
    const last = this.getLastAssistantMessage();
    const windowTokens = last
      ? this.getContextWindowForLastTurn(last)
      : this.currentPersona.model.contextWindow;

    const { input, read, write, output } = this.getSessionTotals();
    const stats = `↑${formatTokenWindow(input)} ↓${formatTokenWindow(output)} (cache r${formatTokenWindow(read)} w${formatTokenWindow(write)})`;

    const promptTokensSent = last
      ? (last.usage?.input ?? 0) + (last.usage?.cacheRead ?? 0) + (last.usage?.cacheWrite ?? 0)
      : 0;
    const percent = windowTokens > 0 ? (promptTokensSent / windowTokens) * 100 : 0;
    const percentStr = `${formatAdaptiveNumber(percent, 1, 3)}%`;

    return `${stats} · ${percentStr}/${formatTokenWindow(windowTokens)}`;
  }

  private getSessionCostString(): string {
    let total = 0;
    for (const m of this.engine.history) {
      if (m.role === "assistant") {
        total += (m as AssistantMessage).usage?.cost?.total ?? 0;
      }
    }
    return `$${formatAdaptiveNumber(total + this.subagentCostTotal, 2, 5)}`;
  }

  private getTurnDurationString(): string {
    const now = Date.now();
    const elapsed =
      this.currentTurnStartedAt !== undefined
        ? Math.max(0, now - this.currentTurnStartedAt)
        : Math.max(0, this.lastTurnDurationMs);
    return this.formatDurationMs(elapsed);
  }

  private formatDurationMs(ms: number): string {
    const totalSeconds = Math.max(0, Math.floor(ms / 1000));
    const seconds = totalSeconds % 60;
    const minutesTotal = Math.floor(totalSeconds / 60);
    const minutes = minutesTotal % 60;
    const hours = Math.floor(minutesTotal / 60);

    if (hours > 0) {
      return `${hours}h ${minutes}m ${seconds}s`;
    }
    if (minutes > 0) {
      return `${minutes}m ${seconds}s`;
    }
    return `${seconds}s`;
  }

  private startTurnTimer(): void {
    this.currentTurnStartedAt = Date.now();
    this.lastTurnDurationMs = 0;
    if (this.turnTimer) {
      clearInterval(this.turnTimer);
    }
    this.turnTimer = setInterval(() => this.updateFooter(), 1000);
  }

  private stopTurnTimer(): void {
    if (this.currentTurnStartedAt !== undefined) {
      this.lastTurnDurationMs = Math.max(0, Date.now() - this.currentTurnStartedAt);
    }
    this.currentTurnStartedAt = undefined;
    if (this.turnTimer) {
      clearInterval(this.turnTimer);
      this.turnTimer = undefined;
    }
    this.updateFooter();
  }

  private getSessionTotals(): { input: number; read: number; write: number; output: number } {
    let input = 0;
    let read = 0;
    let write = 0;
    let output = 0;
    for (const m of this.engine.history) {
      if (m.role === "assistant") {
        const usage = (m as AssistantMessage).usage;
        input += usage?.input ?? 0;
        read += usage?.cacheRead ?? 0;
        write += usage?.cacheWrite ?? 0;
        output += usage?.output ?? 0;
      }
    }
    return { input, read, write, output };
  }

  private getLastAssistantMessage(): AssistantMessage | undefined {
    const history = this.engine.history;
    for (let i = history.length - 1; i >= 0; i--) {
      const m = history[i];
      if (m?.role === "assistant") return m as AssistantMessage;
    }
    return undefined;
  }

  private getContextWindowForLastTurn(last: AssistantMessage): number {
    const exactPersona = this.personas.find(
      (p) => p.model.provider === last.provider && p.model.id === last.model,
    );
    return exactPersona?.model.contextWindow ?? this.currentPersona.model.contextWindow;
  }

  // Reasoning Level Management --------------------------------------------------------------------

  private cycleReasoningLevel(): void {
    const allowed = this.getAllowedReasoningLevels(this.currentPersona);
    const current = (this.currentPersona.settings.reasoning ?? allowed[0]!) as ReasoningEffort;
    const index = allowed.indexOf(current);
    const next = allowed[(index + 1) % allowed.length];
    this.currentPersona.settings.reasoning = next;
    this.updateFooter();
    this.updateEditorBorderColor();
  }

  private isReasoningEffort(value: unknown): value is ReasoningEffort {
    return typeof value === "string" && REASONING_LEVELS.includes(value as ReasoningEffort);
  }

  private getAllowedReasoningLevels(persona: Persona): ReasoningEffort[] {
    if (!persona.model.reasoning) {
      return ["none"];
    }

    const raw = persona.allowedReasoningLevels;
    if (!raw || raw.length === 0) {
      return REASONING_LEVELS;
    }

    const normalized = raw.filter((level) => this.isReasoningEffort(level));
    const unique = [...new Set(normalized)];
    return unique.length ? unique : REASONING_LEVELS;
  }

  private clampPersonaReasoning(persona: Persona): void {
    const allowed = this.getAllowedReasoningLevels(persona);
    if (!allowed.includes(persona.settings.reasoning as ReasoningEffort)) {
      persona.settings.reasoning = allowed[0];
    }
  }

  private isCustomPersona(persona: Persona): boolean {
    return persona.source !== "builtin";
  }

  private getAllowedRiskLevelsForPersona(persona: Persona): RiskLevel[] {
    return this.isCustomPersona(persona)
      ? ["read-only", "read-write"]
      : ["restricted", "read-only", "read-write"];
  }

  // Risk Level Management ---------------------------------------------------------------

  private cycleRiskLevel(): void {
    const levels = this.getAllowedRiskLevelsForPersona(this.currentPersona);
    const previous = this.riskLevel;
    const index = levels.indexOf(this.riskLevel);
    const next = levels[(index + 1) % levels.length] ?? levels[0]!;
    this.riskLevel = next;
    this.engine.setRiskLevel(next);
    this.updateFooter();

    if (previous !== next) {
      const from = this.pendingRiskLevelChange?.from ?? previous;
      if (from === next) {
        this.pendingRiskLevelChange = undefined;
      } else {
        this.pendingRiskLevelChange = { from, to: next };
      }
    }

    this.addSystemMessage(this.formatRiskLevelNotice(next), "success");
    this.ui.requestRender();
  }

  // Personality Management ---------------------------------------------------------------

  private cyclePersonality(): void {
    const index = this.personas.findIndex((p) => p.id === this.currentPersona.id);
    const next = this.personas[(index + 1) % this.personas.length]!;

    this.currentPersona = next;
    this.clampPersonaReasoning(this.currentPersona);
    const allowedRiskLevels = this.getAllowedRiskLevelsForPersona(this.currentPersona);
    if (!allowedRiskLevels.includes(this.riskLevel)) {
      this.setRiskLevel(this.riskLevel, {
        force: true,
        reason: "restricted risk level is not available for custom personas.",
      });
    }
    const skillsContext = this.getSkillsIndexBlockForPersona(this.currentPersona);
    this.baseSystemPrompt = buildBaseSystemPrompt({
      personaSystemPrompt: this.currentPersona.systemPrompt,
      skillsBlock: skillsContext.skillsBlock,
      projectContextBlock: this.projectContextBlock,
      environmentTag: this.environmentTag,
      previousSessionSummary: this.previousSessionSummary,
      userPreferences: this.config.userPreferences,
      subagentsBlock: formatSubagentsForPrompt(this.currentPersona),
    });
    this.engine.setPersona(this.currentPersona, this.baseSystemPrompt);
    this.updateFooter();
    this.updateEditorBorderColor();

    if (skillsContext.unknown.length > 0) {
      this.addSystemMessage(
        `warning: unknown skills enabled: ${skillsContext.unknown.join(", ")}`,
        "warn",
      );
    }

    const label = this.currentPersona.label || this.currentPersona.id;
    this.addSystemMessage(`switched to ${label}`, "success");
    this.ui.requestRender();
  }

  private getEnabledSkillsForPersona(persona: Persona): { skills: Skill[]; unknown: string[] } {
    const enabled = persona.skills;
    if (!enabled) {
      return { skills: [], unknown: [] };
    }

    const skillsByName = new Map<string, Skill>();
    for (const skill of this.skills) {
      skillsByName.set(skill.name.toLowerCase(), skill);
    }

    const selected: Skill[] = [];
    const unknown: string[] = [];
    const seen = new Set<string>();

    const enabledArray = enabled === "*" ? Array.from(skillsByName.keys()) : enabled;

    for (const name of enabledArray) {
      const key = name.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);

      const skill = skillsByName.get(key);
      if (skill) {
        selected.push(skill);
      } else if (enabled !== "*") {
        unknown.push(name);
      }
    }

    return { skills: selected, unknown };
  }

  private getSkillsIndexBlockForPersona(persona: Persona): {
    skillsBlock?: string;
    unknown: string[];
  } {
    const { skills, unknown } = this.getEnabledSkillsForPersona(persona);
    return { skillsBlock: buildSkillsIndexBlock(skills), unknown };
  }

  // User Actions ----------------------------------------------------------------------------------

  private toggleThinkingVisibility(): void {
    this.showThinking = !this.showThinking;
    this.chatContainer.setThinkingVisibility(this.showThinking);
    const message = this.showThinking ? "thoughts visible" : "thoughts hidden";
    this.addSystemMessage(message, "success");
    this.ui.requestRender();
  }

  private toggleCompactToolUi(): void {
    this.compactToolUi = !this.compactToolUi;
    this.chatContainer.setCompactToolUi(this.compactToolUi);
    const message = this.compactToolUi ? "compact tool UI enabled" : "compact tool UI disabled";
    this.addSystemMessage(message, "success");
    this.ui.requestRender();
  }

  private interruptAssistantTurn(): void {
    if (!this.isStreaming || this.currentTurnAbort?.signal.aborted) return;
    this.currentTurnAbort?.abort();
    this.addSystemMessage("interrupted.", "error");
    this.ui.requestRender();
  }

  // Input Handling --------------------------------------------------------------------------------

  private queueUserMessage(text: string): void {
    this.queuedUserMessages.push(text);
    this.ui.requestRender();
  }

  private popQueuedUserMessageIntoEditor(): void {
    if (this.editor.getText() !== "") return;

    const last = this.queuedUserMessages.pop();
    if (!last) return;

    this.editor.setText(last);
    this.ui.requestRender();
  }

  private sendTerminalNotification(title: string): void {
    if (!process.stdout.isTTY) return;
    this.ui.terminal.write(`\x1b]9;${title}\x1b\\`);
  }

  private buildIdleNotificationTitle(): string {
    const baseTitle = "tau is waiting for your input";

    const lastAssistant = this.getLastAssistantMessage();
    if (!lastAssistant) return baseTitle;

    const rawText = extractAssistantText(lastAssistant).trimStart();
    if (!rawText) return baseTitle;

    const firstLine = rawText.split(/\r?\n/, 1)[0]?.trimEnd() ?? "";
    const headingMatch = firstLine.match(/^#{1,6}\s+(.+)$/);
    if (headingMatch) {
      const heading = headingMatch[1]!.trim();
      if (!heading) return baseTitle;
      const summary = heading.length > 60 ? `${heading.slice(0, 57)}...` : heading;
      return summary;
    }

    if (/^[A-Za-z0-9]/.test(rawText)) {
      const plainText = rawText.replace(/\s+/g, " ").trim();
      if (!plainText) return baseTitle;
      const summary = plainText.length > 60 ? `${plainText.slice(0, 57)}...` : plainText;
      return summary;
    }

    return baseTitle;
  }

  private async drainQueuedUserMessages(): Promise<void> {
    if (this.isDrainingQueuedUserMessages) return;
    this.isDrainingQueuedUserMessages = true;

    try {
      while (!this.isStreaming && this.queuedUserMessages.length > 0) {
        const next = this.queuedUserMessages.shift();
        if (!next) return;

        this.ui.requestRender();
        await this.handleSubmit(next);
      }
    } finally {
      this.isDrainingQueuedUserMessages = false;

      if (
        this.pendingIdleNotification &&
        !this.isStreaming &&
        this.queuedUserMessages.length === 0
      ) {
        this.pendingIdleNotification = false;
        this.sendTerminalNotification(this.buildIdleNotificationTitle());
      }
    }
  }

  private async handleSubmit(text: string): Promise<void> {
    if (this.themePreview) {
      return;
    }
    const trimmed = text.trim();
    if (!trimmed) return;

    if (this.isStreaming) {
      if (trimmed.startsWith("/") || trimmed.startsWith("!")) {
        return;
      }
      this.queueUserMessage(trimmed);
      return;
    }

    if (trimmed.startsWith("/")) {
      await this.handleCommand(trimmed);
      return;
    }

    if (trimmed.startsWith("!")) {
      const command = trimmed.slice(1).trim();
      if (command) await this.runBashCommand(command);
      return;
    }

    if (trimmed.startsWith("#")) {
      const request = trimmed.slice(1).trim();
      if (!request) {
        this.addSystemMessage("memory mode request was empty.", "warn");
        return;
      }

      const agentsFilePath = this.getMemoryModeFilePath();
      const textForModel = this.formatMemoryModeUserMessage(agentsFilePath, request);
      await this.sendUserMessage(request, { textForModel, isMemoryMode: true });
      return;
    }

    await this.sendUserMessage(trimmed);
  }

  private async sendUserMessage(
    text: string,
    opts?: { textForModel?: string; isMemoryMode?: boolean },
  ): Promise<void> {
    this.addUserMessage(text, { isMemoryMode: opts?.isMemoryMode });
    this.expandedFilesInCurrentPrompt.clear();
    this.expandedSkillsInCurrentPrompt.clear();

    const systemNotice = this.pendingRiskLevelChange
      ? formatRiskLevelChangeNotice(this.pendingRiskLevelChange)
      : undefined;
    this.pendingRiskLevelChange = undefined;

    const baseTextForModel = opts?.textForModel ?? text;
    const textForModel = systemNotice ? `${systemNotice}\n\n${baseTextForModel}` : baseTextForModel;
    this.engine.addUserText(textForModel);

    await this.runAssistantTurn();
  }

  private async sendInitialUserMessage(text: string): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed || this.isStreaming) return;

    this.addUserMessage(trimmed);
    this.expandedFilesInCurrentPrompt.clear();
    this.expandedSkillsInCurrentPrompt.clear();
    this.engine.addUserText(trimmed);

    await this.runAssistantTurn();
  }

  private getMemoryModeFilePath(): string {
    const cwd = process.cwd();
    const gitRoot = getGitRoot(cwd);

    if (gitRoot) {
      return resolve(join(gitRoot, "AGENTS.md"));
    }

    return resolve(join(cwd, "AGENTS.md"));
  }

  private formatMemoryModeUserMessage(agentsFilePath: string, request: string): string {
    const system = [
      "Memory mode: update the project guidelines file at:",
      agentsFilePath,
      "",
      "If the file exists, use the edit tool to update it. If it does not exist, use the write tool to create it.",
      "Preserve all unrelated content and match the existing formatting style.",
      "Integrate the user's request thoughtfully. Don't just append it verbatim.",
      "Place new content in the most appropriate existing section, or create a new section if needed.",
      "Always prefer an existing section over creating a new one. Sometimes changes are required in more than one place.",
      "",
      "Do not mention this surrounding instruction in your response.",
    ].join("\n");

    return ["<system>", system, "</system>", "", request].join("\n");
  }

  // Command Handling ------------------------------------------------------------------------------

  private async handleCommand(raw: string): Promise<void> {
    const cmd = parseCommand(raw);

    switch (cmd.type) {
      case "help":
        this.showHelp();
        break;

      case "copy":
        await this.copyLastAssistantMessage();
        break;

      case "copyCode":
        await this.copyLastAssistantCodeBlock();
        break;

      case "export":
        await this.exportSessionHtml();
        break;

      case "new":
        this.clearSession();
        break;

      case "compactOnlySummary":
        await this.forkSessionOnlySummary();
        break;

      case "compactSummaryAndLastTurn":
        await this.forkSessionSummaryAndLastTurn();
        break;

      case "risk":
        this.setRiskLevel(cmd.level);
        break;

      case "persona":
        this.switchPersona(cmd.id);
        break;

      case "prompt":
        this.insertPrompt(cmd.id);
        break;

      case "bash":
        await this.runSavedBashCommand(cmd.id);
        break;

      case "reload":
        await this.reloadContent();
        break;

      case "unknown":
        this.addSystemMessage("unknown command. type /help.", "error");
        break;
    }
  }

  private showHelp(): void {
    this.addSystemMessage(
      buildHelpText(
        this.agentsFiles,
        this.skills,
        this.getAllowedRiskLevelsForPersona(this.currentPersona),
      ),
      "muted",
    );
  }

  private async copyLastAssistantMessage(): Promise<void> {
    const lastAssistant = this.getLastAssistantMessage();
    if (!lastAssistant) {
      this.addSystemMessage("no assistant message to copy yet.", "warn");
      return;
    }

    const text = extractAssistantText(lastAssistant);
    if (!text.trim()) {
      this.addSystemMessage("last assistant message was empty.", "warn");
      return;
    }

    try {
      await copyTextToClipboard(text);
      this.addSystemMessage("copied last assistant message to clipboard.", "success");
    } catch (err) {
      this.addSystemMessage(`clipboard copy failed: ${(err as Error).message}`, "error");
    }
  }

  private async copyLastAssistantCodeBlock(): Promise<void> {
    const lastAssistant = this.getLastAssistantMessage();
    if (!lastAssistant) {
      this.addSystemMessage("no assistant message to copy yet.", "warn");
      return;
    }

    const text = extractAssistantText(lastAssistant);
    const code = extractAllFencedCodeBlocks(text);
    if (!code) {
      this.addSystemMessage("no code block to copy yet.", "warn");
      return;
    }

    try {
      await copyTextToClipboard(code);
      this.addSystemMessage("copied all code blocks to clipboard.", "success");
    } catch (err) {
      this.addSystemMessage(`clipboard copy failed: ${(err as Error).message}`, "error");
    }
  }

  private async exportSessionHtml(): Promise<void> {
    const history = this.engine.history;
    if (history.length === 0) {
      this.addSystemMessage("no conversation to export.", "warn");
      return;
    }

    try {
      const entries = buildExportEntriesFromHistory(history);
      if (entries.length === 0) {
        this.addSystemMessage("no conversation to export.", "warn");
        return;
      }

      const html = renderExport("html", entries, {
        title: "tau chat export",
        generatedAt: Date.now(),
      });
      const dir = await mkdtemp(join(tmpdir(), "tau-export-"));
      const filePath = join(dir, "index.html");
      await writeFile(filePath, html, "utf8");
      this.addSystemMessage(filePath, "muted");
    } catch (err) {
      this.addSystemMessage(`export failed: ${(err as Error).message}`, "error");
    }
  }

  private async stashEditorToClipboard(): Promise<void> {
    const text = this.editor.getText();
    if (!text.trim()) {
      this.addSystemMessage("no input to stash yet", "warn");
      return;
    }

    try {
      await copyTextToClipboard(text);
      this.editor.setText("");
      this.addSystemMessage("stashed input to clipboard", "success");
    } catch (err) {
      this.addSystemMessage(`clipboard copy failed: ${(err as Error).message}`, "error");
    }
  }

  private clearSession(): void {
    this.engine.reset();
    this.runningBashComponents.clear();
    this.runningTaskComponents.clear();
    this.taskEvents.clear();
    this.subagentCostTotal = 0;
    this.expandedFilesInCurrentPrompt.clear();
    this.expandedSkillsInCurrentPrompt.clear();
    this.chatContainer.addMessage({ type: "session_divider", label: "new session" });
    this.isBashMode = false;
    this.isMemoryMode = false;
    this.previousSessionSummary = undefined;
    this.rebuildSystemPrompt();
    this.updateEditorBorderColor();
    this.updateFooter();
    this.ui.requestRender();
  }

  private escapeXml(text: string): string {
    return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  private extractLastTurn(history: readonly Message[]): {
    lastUserText?: string;
    lastAssistantText?: string;
  } {
    if (history.length === 0) {
      return {};
    }

    let lastUserIndex = -1;
    let lastUserText: string | undefined;

    // Find the last user message and extract its text
    for (let i = history.length - 1; i >= 0; i--) {
      if (history[i]!.role === "user") {
        lastUserIndex = i;
        const userMessage = history[i]!;
        const textParts: string[] = [];
        for (const block of userMessage.content) {
          if (typeof block === "string") {
            textParts.push(block);
          } else if (block.type === "text") {
            textParts.push(block.text);
          }
        }
        const combined = textParts.join("\n").trim();
        if (combined) {
          lastUserText = combined;
        }
        break;
      }
    }

    let lastAssistantText: string | undefined;

    if (lastUserIndex >= 0) {
      // Find the last assistant message after the last user message
      for (let i = history.length - 1; i > lastUserIndex; i--) {
        if (history[i]!.role === "assistant") {
          const text = extractAssistantText(history[i]! as AssistantMessage).trim();
          if (text) {
            lastAssistantText = text;
          }
          break;
        }
      }
    } else {
      // No user message found; look for the last assistant message overall
      for (let i = history.length - 1; i >= 0; i--) {
        if (history[i]!.role === "assistant") {
          const text = extractAssistantText(history[i]! as AssistantMessage).trim();
          if (text) {
            lastAssistantText = text;
          }
          break;
        }
      }
    }

    return { lastUserText, lastAssistantText };
  }

  private rebuildSystemPrompt(previousSessionSummary?: string): void {
    this.environmentTag = buildEnvironmentTag({
      riskLevel: this.riskLevel,
      cwd: process.cwd(),
      datetime: new Date().toISOString(),
    });
    this.baseSystemPrompt = buildBaseSystemPrompt({
      personaSystemPrompt: this.currentPersona.systemPrompt,
      skillsBlock: this.getSkillsIndexBlockForPersona(this.currentPersona).skillsBlock,
      projectContextBlock: this.projectContextBlock,
      environmentTag: this.environmentTag,
      previousSessionSummary,
      userPreferences: this.config.userPreferences,
      subagentsBlock: formatSubagentsForPrompt(this.currentPersona),
    });
    this.engine.setPersona(this.currentPersona, this.baseSystemPrompt);
  }

  private async generateSummary(history: readonly Message[]): Promise<string> {
    const formattedHistory = formatHistoryForCompression(history);
    const summaryPrompt = `
Summarize this conversation so another assistant can continue without losing context. Be specific and factual. Aim for extreme compression; at least 90% reduction from the original conversation length, preferably more. Every word should earn its place.

<conversation>
${formattedHistory.trim()}
</conversation>

The conversation format uses \`--- USER ---\` and \`--- ASSISTANT ---\` markers. Tool calls appear as \`[Tool call: name(arguments)]\` and outputs as \`[Tool output: name (truncated)]\`. Outputs are truncated, so when tools were used, describe what was attempted rather than assuming outcomes.

Capture only what matters for continuity:

- The goal or topic. What did the user want to accomplish or discuss? Note how this evolved if it changed during the conversation.
- Key substance. For discussions: important facts, explanations, or ideas that were shared. For coding tasks: files created or modified, commands run, with concrete paths and names. Distinguish between "attempted" and "confirmed working" when tools were involved.
- Decisions and preferences. Conclusions reached, options chosen, or constraints the user specified. These should carry forward.
- Open threads. What's unresolved? For discussions: unanswered questions, topics to revisit. For tasks: what's incomplete, broken, or in progress when the conversation ended.
- Skip the back-and-forth. Collapse tangents and false starts into what ultimately mattered. The reader has no context beyond what you provide, so name things concretely and include enough detail to resume without guessing.

Ruthlessly compress: collapse tangents, skip back-and-forth, omit pleasantries. Name things concretely (paths, functions, errors) but use minimal words.

Write plain prose, no formatting. Be thorough enough that the reader can resume without guessing, but don't narrate every exchange. When relevant, name things concretely: file paths, function names, error messages. The reader has no context beyond what you provide as the summary.
    `.trim();

    const apiKey = getApiKeyForProvider(
      this.config,
      this.currentPersona.model.provider as KnownProvider,
    );
    const stream = streamSimple(
      this.currentPersona.model,
      {
        systemPrompt: [
          "You are a precise and thorough conversation summarizer.",
          "Your task is to distill conversations into clear, actionable summaries that preserve all context needed for seamless continuation.",
          "Focus on facts, decisions, and concrete details rather than narrative flow.",
          "Be specific about file paths, function names, and technical details when present.",
          "Distinguish between what was attempted versus what was confirmed to work.",
        ].join(" "),
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: summaryPrompt }],
            timestamp: Date.now(),
          },
        ],
      },
      { reasoning: "medium", ...(apiKey && { apiKey }) },
    );

    const final = await stream.result();
    return extractAssistantText(final).trim();
  }

  private applySessionContext(previousSessionContext: string): void {
    this.previousSessionSummary = previousSessionContext;

    // Reset the session state but preserve history with divider and summary
    this.engine.reset();
    this.runningBashComponents.clear();
    this.runningTaskComponents.clear();
    this.taskEvents.clear();
    this.subagentCostTotal = 0;
    this.expandedFilesInCurrentPrompt.clear();
    this.expandedSkillsInCurrentPrompt.clear();
    this.chatContainer.addMessage({ type: "session_divider", label: "new session" });
    this.chatContainer.addMessage({
      type: "session_summary",
      summary: this.previousSessionSummary,
    });
    this.isBashMode = false;
    this.isMemoryMode = false;

    // Rebuild environment tag and system prompt with the new summary and current risk level
    this.rebuildSystemPrompt(this.previousSessionSummary);

    this.updateEditorBorderColor();
    this.updateFooter();
  }

  private async forkSessionOnlySummary(): Promise<void> {
    const history = this.engine.history;
    if (history.length === 0) {
      this.addSystemMessage("no conversation to fork.", "warn");
      return;
    }

    this.addSystemMessage("summarizing session...", "success");
    this.isStreaming = true;
    this.footer.startWorkingIcon();

    try {
      const summary = await this.generateSummary(history);
      this.applySessionContext(summary);

      this.addSystemMessage("session forked. previous context has been summarized.", "success");
    } catch (err) {
      this.addSystemMessage(`fork failed: ${(err as Error).message}`, "error");
    } finally {
      this.footer.stop();
      this.isStreaming = false;
      this.ui.requestRender();
      void this.drainQueuedUserMessages();
    }
  }

  private async forkSessionSummaryAndLastTurn(): Promise<void> {
    const history = this.engine.history;
    if (history.length === 0) {
      this.addSystemMessage("no conversation to fork.", "warn");
      return;
    }

    this.addSystemMessage("summarizing session...", "success");
    this.isStreaming = true;
    this.footer.startWorkingIcon();

    try {
      const summary = await this.generateSummary(history);

      // Extract the last turn from history
      const lastTurn = this.extractLastTurn(history);

      // Build the combined context with summary and last turn
      let sessionContext = summary;

      if (lastTurn.lastUserText || lastTurn.lastAssistantText) {
        sessionContext += "\n\nLast turn from previous session (verbatim):\n";
        sessionContext += "<last_turn>";
        if (lastTurn.lastUserText) {
          sessionContext += `\n<last_user_message>${this.escapeXml(lastTurn.lastUserText)}</last_user_message>`;
        }
        if (lastTurn.lastAssistantText) {
          sessionContext += `\n<last_assistant_message>${this.escapeXml(lastTurn.lastAssistantText)}</last_assistant_message>`;
        }
        sessionContext += "\n</last_turn>";
      }

      this.applySessionContext(sessionContext);

      this.addSystemMessage(
        "session forked. previous context and last turn have been included.",
        "success",
      );
    } catch (err) {
      this.addSystemMessage(`fork failed: ${(err as Error).message}`, "error");
    } finally {
      this.footer.stop();
      this.isStreaming = false;
      this.ui.requestRender();
      void this.drainQueuedUserMessages();
    }
  }

  private setRiskLevel(
    level: RiskLevel,
    options?: { force?: boolean; silent?: boolean; reason?: string },
  ): void {
    const allowed = this.getAllowedRiskLevelsForPersona(this.currentPersona);
    let target = level;
    let forced = false;

    if (!allowed.includes(level)) {
      if (!options?.force) {
        if (!options?.silent) {
          this.addSystemMessage(
            `risk level '${level}' is not available for the current persona. allowed: ${allowed.join(", ")}.`,
            "error",
          );
        }
        return;
      }
      target = allowed[0] ?? "read-only";
      forced = true;
    }

    const previous = this.riskLevel;
    this.riskLevel = target;
    this.engine.setRiskLevel(target);
    this.updateFooter();

    if (previous !== target) {
      const from = this.pendingRiskLevelChange?.from ?? previous;
      if (from === target) {
        this.pendingRiskLevelChange = undefined;
      } else {
        this.pendingRiskLevelChange = { from, to: target };
      }
    }

    if (options?.silent) {
      return;
    }

    if (forced) {
      const reason =
        options?.reason ?? `risk level '${level}' is not available for the current persona.`;
      const msg =
        previous === target
          ? `${reason} staying at ${target}.`
          : `${reason} switched to ${target}.`;
      this.addSystemMessage(msg, "warn");
      return;
    }

    this.addSystemMessage(this.formatRiskLevelNotice(target), "success");
  }

  private switchPersona(id: string): void {
    const persona = this.personas.find((p) => p.id.toLowerCase() === id.toLowerCase());

    if (!persona) {
      this.addSystemMessage(`unknown persona '${id}'.`, "error");
      return;
    }

    this.currentPersona = persona;
    this.clampPersonaReasoning(this.currentPersona);
    const allowedRiskLevels = this.getAllowedRiskLevelsForPersona(this.currentPersona);
    if (!allowedRiskLevels.includes(this.riskLevel)) {
      this.setRiskLevel(this.riskLevel, {
        force: true,
        reason: "restricted risk level is not available for custom personas.",
      });
    }
    const skillsContext = this.getSkillsIndexBlockForPersona(this.currentPersona);
    this.baseSystemPrompt = buildBaseSystemPrompt({
      personaSystemPrompt: this.currentPersona.systemPrompt,
      skillsBlock: skillsContext.skillsBlock,
      projectContextBlock: this.projectContextBlock,
      environmentTag: this.environmentTag,
      previousSessionSummary: this.previousSessionSummary,
      userPreferences: this.config.userPreferences,
      subagentsBlock: formatSubagentsForPrompt(this.currentPersona),
    });
    this.engine.setPersona(this.currentPersona, this.baseSystemPrompt);
    this.updateFooter();
    this.updateEditorBorderColor();

    if (skillsContext.unknown.length > 0) {
      this.addSystemMessage(
        `warning: unknown skills enabled: ${skillsContext.unknown.join(", ")}`,
        "warn",
      );
    }

    this.addSystemMessage(`switched to ${persona.label} (${persona.model.id})`, "success");
  }

  private insertPrompt(id: string): void {
    const prompt = this.prompts.find((p) => p.id.toLowerCase() === id.toLowerCase());
    if (!prompt) {
      this.addSystemMessage(`unknown prompt '${id}'.`, "error");
      return;
    }
    this.editor.setText(prompt.template);
    this.ui.requestRender();
  }

  private async runSavedBashCommand(id: string): Promise<void> {
    const saved = this.bashCommands.find((b) => b.id.toLowerCase() === id.toLowerCase());
    if (!saved) {
      this.addSystemMessage(`unknown bash command '${id}'.`, "error");
      return;
    }

    await this.runBashCommand(saved.cmd, { cwd: this.repoRoot });
  }

  private async reloadContent(): Promise<void> {
    if (this.isStreaming) {
      this.addSystemMessage("cannot reload while streaming. try again after the response.", "warn");
      return;
    }

    try {
      const result = await loadAllContent();
      const { personas, prompts, skills, errors } = result;

      const bashResult = loadBashCommands(process.cwd());
      this.bashCommands = bashResult.commands;

      // Update the personas and prompts lists
      this.personas = personas;
      this.prompts = prompts;
      this.skills = skills;

      // Try to preserve the current persona; fall back to first if not found
      const currentPersonaId = this.currentPersona.id.toLowerCase();
      const updatedPersona = personas.find((p) => p.id.toLowerCase() === currentPersonaId);

      if (updatedPersona) {
        this.currentPersona = updatedPersona;
        this.clampPersonaReasoning(this.currentPersona);
      } else {
        // Persona no longer exists; switch to the first one
        this.currentPersona = personas[0]!;
        this.clampPersonaReasoning(this.currentPersona);
        this.addSystemMessage(
          `previous persona no longer available; switched to ${this.currentPersona.label || this.currentPersona.id}.`,
          "warn",
        );
      }
      const allowedRiskLevels = this.getAllowedRiskLevelsForPersona(this.currentPersona);
      if (!allowedRiskLevels.includes(this.riskLevel)) {
        this.setRiskLevel(this.riskLevel, {
          force: true,
          reason: "restricted risk level is not available for custom personas.",
        });
      }

      // Rebuild system prompt and update the engine
      const skillsContext = this.getSkillsIndexBlockForPersona(this.currentPersona);
      this.baseSystemPrompt = buildBaseSystemPrompt({
        personaSystemPrompt: this.currentPersona.systemPrompt,
        skillsBlock: skillsContext.skillsBlock,
        projectContextBlock: this.projectContextBlock,
        environmentTag: this.environmentTag,
        previousSessionSummary: this.previousSessionSummary,
        userPreferences: this.config.userPreferences,
        subagentsBlock: formatSubagentsForPrompt(this.currentPersona),
      });
      this.engine.setPersona(this.currentPersona, this.baseSystemPrompt);

      if (skillsContext.unknown.length > 0) {
        this.addSystemMessage(
          `warning: unknown skills enabled: ${skillsContext.unknown.join(", ")}`,
          "warn",
        );
      }

      // Update UI
      this.updateFooter();
      this.updateEditorBorderColor();

      // Display summary
      const personaCount = personas.length;
      const promptCount = prompts.length;
      const skillCount = skills.length;
      const bashCount = bashResult.commands.length;
      const errorCount = errors.length + bashResult.errors.length;
      const summary =
        errorCount > 0
          ? `reloaded: ${personaCount} personas, ${promptCount} prompts, ${skillCount} skills, ${bashCount} bash commands (${errorCount} errors).`
          : `reloaded: ${personaCount} personas, ${promptCount} prompts, ${skillCount} skills, ${bashCount} bash commands.`;

      this.addSystemMessage(summary, "success");
      this.ui.requestRender();
    } catch (err) {
      this.addSystemMessage(`reload failed: ${(err as Error).message}`, "error");
    }
  }

  // Assistant Turn --------------------------------------------------------------------------------

  private async runAssistantTurn(): Promise<void> {
    this.isStreaming = true;
    this.currentTurnAbort = new AbortController();
    this.footer.startWorkingIcon();
    this.startTurnTimer();

    try {
      type AssistantState = { id?: string; inserted: boolean; model: AssistantMessageModel };
      let currentAssistant: AssistantState | undefined;

      const ensureCurrentAssistant = (): AssistantState => {
        if (currentAssistant) return currentAssistant;
        currentAssistant = {
          inserted: false,
          model: { type: "assistant_partial", text: "", thinking: "" },
        };
        return currentAssistant;
      };

      const ensureAssistantInserted = (state: AssistantState) => {
        if (state.inserted) return;
        state.inserted = true;
        state.id = this.chatContainer.addMessage(state.model);
      };

      for await (const event of this.engine.processTurn(this.currentTurnAbort.signal)) {
        if (this.currentTurnAbort.signal.aborted) break;

        switch (event.type) {
          case "assistant_start":
            currentAssistant = {
              inserted: false,
              model: { type: "assistant_partial", text: "", thinking: "" },
            };
            break;

          case "assistant_partial": {
            const state = ensureCurrentAssistant();
            const { snapshot } = event;
            const model: AssistantMessageModel = {
              type: "assistant_partial",
              text: snapshot.hasTextStarted ? snapshot.text : "",
              thinking: snapshot.thinking,
            };
            state.model = model;

            const shouldInsert =
              snapshot.hasTextStarted || (this.showThinking && snapshot.hasAnyThinking);
            if (shouldInsert && !state.inserted) {
              ensureAssistantInserted(state);
            }

            if (state.inserted && state.id) {
              this.chatContainer.updateMessage(state.id, model);
              this.ui.requestRender();
            }
            break;
          }

          case "assistant_final": {
            const state = ensureCurrentAssistant();
            const model: AssistantMessageModel = { type: "assistant", message: event.message };
            state.model = model;
            if (!state.inserted) {
              ensureAssistantInserted(state);
            }
            if (state.id) {
              this.chatContainer.updateMessage(state.id, model);
            }
            this.updateFooter();
            this.ui.requestRender();
            currentAssistant = undefined;
            break;
          }

          case "tool_ui": {
            const uiEvent = event.uiEvent;
            if (uiEvent.type === "bash_started") {
              this.chatContainer.addMessage(
                {
                  type: "tool",
                  view: buildBashRunningView(this.uiTheme, uiEvent.command),
                },
                uiEvent.toolCallId,
              );
              this.runningBashComponents.set(uiEvent.toolCallId, {
                command: uiEvent.command,
              });
              this.ui.requestRender();
            } else if (uiEvent.type === "bash_execution") {
              const running = this.runningBashComponents.get(uiEvent.toolCallId);
              this.chatContainer.replaceMessage(uiEvent.toolCallId, {
                type: "tool",
                view: buildBashExecutionView(
                  this.uiTheme,
                  uiEvent.command,
                  uiEvent.exitCode,
                  uiEvent.truncationInfo,
                  uiEvent.durationMs,
                ),
              });
              if (running) {
                this.runningBashComponents.delete(uiEvent.toolCallId);
              }
              this.ui.requestRender();
            } else if (uiEvent.type === "bash_blocked") {
              if (uiEvent.toolCallId) {
                const running = this.runningBashComponents.get(uiEvent.toolCallId);
                this.chatContainer.replaceMessage(uiEvent.toolCallId, {
                  type: "tool",
                  view: buildBashBlockedView(this.uiTheme, uiEvent.command, uiEvent.reason),
                });
                if (running) {
                  this.runningBashComponents.delete(uiEvent.toolCallId);
                }
              } else {
                this.chatContainer.addMessage({
                  type: "tool",
                  view: buildBashBlockedView(this.uiTheme, uiEvent.command, uiEvent.reason),
                });
              }
              this.ui.requestRender();
            } else if (uiEvent.type === "task_started") {
              if (!this.taskEvents.has(uiEvent.toolCallId)) {
                this.taskEvents.set(uiEvent.toolCallId, []);
              }
              const kind = uiEvent.kind ?? "task";
              const subagentName = uiEvent.name.trim() || undefined;

              this.chatContainer.addMessage(
                {
                  type: "tool",
                  view: buildTaskRunningView(this.uiTheme, uiEvent.title, [], 0, 0, 0, {
                    kind,
                    subagentName,
                  }),
                },
                uiEvent.toolCallId,
              );
              this.runningTaskComponents.set(uiEvent.toolCallId, {
                kind,
                name: subagentName,
                title: uiEvent.title,
                costTotal: 0,
                turns: 0,
                toolCalls: 0,
              });
              this.ui.requestRender();
            } else if (uiEvent.type === "task_progress") {
              let events = this.taskEvents.get(uiEvent.toolCallId);
              if (!events) {
                events = [];
                this.taskEvents.set(uiEvent.toolCallId, events);
              }
              events.push(uiEvent.event);

              const running = this.runningTaskComponents.get(uiEvent.toolCallId);
              const kind = uiEvent.kind ?? running?.kind ?? "task";
              const subagentName = uiEvent.name.trim() || undefined;

              if (running) {
                running.kind = kind;
                running.name = subagentName;
                running.title = uiEvent.title;
                running.costTotal = uiEvent.costTotal;
                running.turns = uiEvent.turns;
                running.toolCalls = uiEvent.toolCalls;
              }

              this.chatContainer.replaceMessage(uiEvent.toolCallId, {
                type: "tool",
                view: buildTaskRunningView(
                  this.uiTheme,
                  uiEvent.title,
                  events!,
                  uiEvent.costTotal,
                  uiEvent.turns,
                  uiEvent.toolCalls,
                  { kind, subagentName },
                ),
              });
              this.ui.requestRender();
            } else if (uiEvent.type === "task_finished") {
              const running = this.runningTaskComponents.get(uiEvent.toolCallId);
              const kind = uiEvent.kind ?? running?.kind ?? "task";
              const subagentName = uiEvent.name.trim() || undefined;

              this.chatContainer.replaceMessage(uiEvent.toolCallId, {
                type: "tool",
                view: buildTaskFinishedView(
                  this.uiTheme,
                  uiEvent.title,
                  uiEvent.costTotal,
                  uiEvent.turns,
                  uiEvent.toolCalls,
                  uiEvent.status,
                  uiEvent.finalOutput,
                  { kind, subagentName },
                ),
              });

              this.runningTaskComponents.delete(uiEvent.toolCallId);
              this.taskEvents.delete(uiEvent.toolCallId);
              this.subagentCostTotal += uiEvent.costTotal;
              this.updateFooter();
              this.ui.requestRender();
            } else if (uiEvent.type === "task_blocked") {
              const running = this.runningTaskComponents.get(uiEvent.toolCallId);
              const kind = uiEvent.kind ?? running?.kind ?? "task";
              const subagentName = uiEvent.name?.trim() || undefined;

              if (running) {
                this.chatContainer.replaceMessage(uiEvent.toolCallId, {
                  type: "tool",
                  view: buildTaskBlockedView(this.uiTheme, uiEvent.title, uiEvent.reason, {
                    kind,
                    subagentName,
                  }),
                });
              } else {
                this.chatContainer.addMessage(
                  {
                    type: "tool",
                    view: buildTaskBlockedView(this.uiTheme, uiEvent.title, uiEvent.reason, {
                      kind,
                      subagentName,
                    }),
                  },
                  uiEvent.toolCallId,
                );
              }

              this.runningTaskComponents.delete(uiEvent.toolCallId);
              this.taskEvents.delete(uiEvent.toolCallId);
              this.ui.requestRender();
            } else if (uiEvent.type === "write_success") {
              this.chatContainer.addMessage({
                type: "tool",
                view: buildWriteSuccessView(
                  this.uiTheme,
                  uiEvent.path,
                  uiEvent.bytes,
                  uiEvent.lines,
                  uiEvent.content,
                ),
              });
              this.ui.requestRender();
            } else if (uiEvent.type === "write_blocked") {
              this.chatContainer.addMessage({
                type: "tool",
                view: buildWriteBlockedView(this.uiTheme, uiEvent.path, uiEvent.reason),
              });
              this.ui.requestRender();
            } else if (uiEvent.type === "edit_success") {
              this.chatContainer.addMessage({
                type: "tool",
                view: buildEditSuccessView(
                  this.uiTheme,
                  uiEvent.path,
                  uiEvent.oldLength,
                  uiEvent.newLength,
                  uiEvent.oldText,
                  uiEvent.newText,
                ),
              });
              this.ui.requestRender();
            } else if (uiEvent.type === "edit_blocked") {
              this.chatContainer.addMessage({
                type: "tool",
                view: buildEditBlockedView(this.uiTheme, uiEvent.path, uiEvent.reason),
              });
              this.ui.requestRender();
            } else if (uiEvent.type === "read_success") {
              this.chatContainer.addMessage({
                type: "tool",
                view: buildReadSuccessView(
                  this.uiTheme,
                  uiEvent.path,
                  uiEvent.startLine,
                  uiEvent.endLine,
                  uiEvent.content,
                  uiEvent.modelTruncation,
                ),
              });
              this.ui.requestRender();
            } else if (uiEvent.type === "read_blocked") {
              this.chatContainer.addMessage({
                type: "tool",
                view: buildReadBlockedView(this.uiTheme, uiEvent.path, uiEvent.reason),
              });
              this.ui.requestRender();
            } else if (uiEvent.type === "list_success") {
              this.chatContainer.addMessage({
                type: "tool",
                view: buildListSuccessView(
                  this.uiTheme,
                  uiEvent.path,
                  uiEvent.offset,
                  uiEvent.limit,
                  uiEvent.total,
                  uiEvent.returned,
                  uiEvent.entries,
                ),
              });
              this.ui.requestRender();
            } else if (uiEvent.type === "list_blocked") {
              this.chatContainer.addMessage({
                type: "tool",
                view: buildListBlockedView(this.uiTheme, uiEvent.path, uiEvent.reason),
              });
              this.ui.requestRender();
            } else if (uiEvent.type === "grep_started") {
              this.chatContainer.addMessage(
                {
                  type: "tool",
                  view: buildGrepRunningView(this.uiTheme, uiEvent.pattern),
                },
                uiEvent.toolCallId,
              );
              this.ui.requestRender();
            } else if (uiEvent.type === "grep_finished") {
              this.chatContainer.replaceMessage(uiEvent.toolCallId, {
                type: "tool",
                view: buildGrepFinishedView(
                  this.uiTheme,
                  uiEvent.pattern,
                  uiEvent.status,
                  uiEvent.exitCode,
                  uiEvent.stdout,
                  uiEvent.stderr,
                  uiEvent.captureTruncated,
                ),
              });
              this.ui.requestRender();
            } else if (uiEvent.type === "grep_blocked") {
              this.chatContainer.addMessage(
                {
                  type: "tool",
                  view: buildGrepBlockedView(this.uiTheme, uiEvent.pattern, uiEvent.reason),
                },
                uiEvent.toolCallId,
              );
              this.ui.requestRender();
            }
            break;
          }

          case "notice": {
            const kind: SystemMessageKind =
              event.severity === "error" ? "error" : event.severity === "warn" ? "warn" : "success";
            this.addSystemMessage(event.text, kind);
            break;
          }

          case "tool_result":
            break;
        }
      }
    } catch (err) {
      const message = (err as Error).message || "request failed.";
      this.addSystemMessage(message, "error");
    } finally {
      const wasAborted = this.currentTurnAbort?.signal.aborted ?? false;
      const reason = wasAborted ? "aborted" : "interrupted";

      for (const [id, running] of this.runningBashComponents.entries()) {
        this.chatContainer.replaceMessage(id, {
          type: "tool",
          view: buildBashAbortedView(this.uiTheme, running.command, reason),
        });
      }

      const taskStatus = wasAborted ? "aborted" : "error";
      for (const [id, running] of this.runningTaskComponents.entries()) {
        this.chatContainer.replaceMessage(id, {
          type: "tool",
          view: buildTaskFinishedView(
            this.uiTheme,
            running.title,
            running.costTotal,
            running.turns,
            running.toolCalls,
            taskStatus,
            reason,
            { kind: running.kind, subagentName: running.name },
          ),
        });
      }

      this.footer.stop();
      this.stopTurnTimer();
      this.isStreaming = false;
      this.currentTurnAbort = undefined;
      this.runningBashComponents.clear();
      this.runningTaskComponents.clear();
      this.taskEvents.clear();
      this.pendingIdleNotification = true;
      this.ui.requestRender();
      void this.drainQueuedUserMessages();
    }
  }

  // Direct Bash Execution (user ! commands) -------------------------------------------------------

  private async runBashCommand(command: string, opts?: { cwd?: string }): Promise<boolean> {
    this.isStreaming = true;
    const abortController = new AbortController();
    this.currentTurnAbort = abortController;
    let wasAborted = false;
    this.startTurnTimer();

    try {
      const startedAt = Date.now();
      const {
        stdout,
        stderr,
        exitCode,
        truncated: captureTruncated,
      } = await executeBashTool(command, { cwd: opts?.cwd, signal: abortController.signal });
      const durationMs = Math.max(0, Date.now() - startedAt);
      const truncationInfo = prepareBashOutput(stdout, stderr, captureTruncated, {
        stdout: { maxLines: BASH_USER_MAX_STDOUT_LINES, maxTokens: BASH_USER_MAX_STDOUT_TOKENS },
        stderr: { maxLines: BASH_USER_MAX_STDERR_LINES, maxTokens: BASH_USER_MAX_STDERR_TOKENS },
      });

      this.chatContainer.addMessage({
        type: "tool",
        view: buildBashExecutionView(
          this.uiTheme,
          command,
          exitCode,
          truncationInfo,
          durationMs,
          "you ran",
          12,
          12,
        ),
      });

      this.engine.addUserText(formatBashUserMessageText({ command, truncationInfo }));

      this.ui.requestRender();
    } catch (err) {
      const message = (err as Error).message || "bash failed.";
      this.addSystemMessage(`bash failed: ${message}`, "error");
    } finally {
      wasAborted = abortController.signal.aborted;
      this.isStreaming = false;
      if (this.currentTurnAbort === abortController) {
        this.currentTurnAbort = undefined;
      }
      this.stopTurnTimer();
      this.ui.requestRender();
      void this.drainQueuedUserMessages();
    }
    return wasAborted;
  }

  // Mention Expansion (ctrl+f) --------------------------------------------------------------------

  private shellQuote(path: string): string {
    // Wrap in single quotes and escape any single quotes within the path
    return `'${path.replace(/'/g, "'\\''")}'`;
  }

  private async expandFileMentions(): Promise<void> {
    if (this.isStreaming) {
      this.addSystemMessage(
        "cannot expand mentions while streaming. try again after the response.",
        "warn",
      );
      return;
    }

    const editorText = this.editor.getText();

    // Extract @path and $skill tokens
    const tokenRegex = /([@$])([^\s]+)/g;
    const tokens: Array<{ type: "file" | "skill"; token: string }> = [];
    let match: RegExpExecArray | null = null;
    // biome-ignore lint/suspicious/noAssignInExpressions: regex iteration pattern
    while ((match = tokenRegex.exec(editorText)) !== null) {
      tokens.push({
        type: match[1] === "@" ? "file" : "skill",
        token: match[2]!,
      });
    }

    if (tokens.length === 0) {
      return;
    }

    // Filter to only valid project files / skills and de-duplicate
    const projectFilesSet = new Set(this.projectFiles);
    const skillsByName = new Map<string, Skill>();
    for (const skill of this.skills) {
      skillsByName.set(skill.name.toLowerCase(), skill);
    }

    const expansions: Array<{ type: "file"; path: string } | { type: "skill"; skill: Skill }> = [];
    const seenFiles = new Set(this.expandedFilesInCurrentPrompt);
    const seenSkills = new Set(this.expandedSkillsInCurrentPrompt);

    for (const entry of tokens) {
      // Strip trailing punctuation to handle cases like "@src/app.ts," or "(see @README.md)"
      const cleanToken = entry.token.replace(/[.,;:)}\]]+$/, "");
      if (entry.type === "file") {
        if (projectFilesSet.has(cleanToken) && !seenFiles.has(cleanToken)) {
          expansions.push({ type: "file", path: cleanToken });
          seenFiles.add(cleanToken);
        }
      } else {
        const key = cleanToken.toLowerCase();
        const skill = skillsByName.get(key);
        if (!skill) continue; // Only expand $mentions that match a loaded skill.
        if (seenSkills.has(key)) continue;
        expansions.push({ type: "skill", skill });
        seenSkills.add(key);
      }
    }

    if (expansions.length === 0) {
      return;
    }

    // Run bash commands sequentially for each expansion
    for (const expansion of expansions) {
      if (expansion.type === "file") {
        const quotedPath = this.shellQuote(expansion.path);
        // Format: blank line before header, header, content, blank line after
        // Ensure trailing newline so multiple files don't run together
        // Use -- to prevent cat from interpreting filenames starting with - as options
        const command = `printf '\\n===== %s =====\\n' ${quotedPath}; cat -- ${quotedPath}; printf '\\n'`;
        const aborted = await this.runBashCommand(command);
        if (aborted) {
          break;
        }
        // Track this file as expanded in the current prompt
        this.expandedFilesInCurrentPrompt.add(expansion.path);
      } else {
        const label = this.shellQuote(`skill: ${expansion.skill.name}`);
        const quotedPath = this.shellQuote(expansion.skill.path);
        const command = `printf '\\n===== %s =====\\n' ${label}; cat -- ${quotedPath}; printf '\\n'`;
        const aborted = await this.runBashCommand(command);
        if (aborted) {
          break;
        }
        this.expandedSkillsInCurrentPrompt.add(expansion.skill.name.toLowerCase());
      }
    }
  }
}
