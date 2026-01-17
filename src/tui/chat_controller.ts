import { randomUUID } from "node:crypto";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import type { AssistantMessage, KnownProvider, Message } from "@mariozechner/pi-ai";
import { formatCodexAuthError } from "../core/auth/auth_messages.js";
import { getAuthPath } from "../core/auth/auth_paths.js";
import { AuthStorage } from "../core/auth/auth_storage.js";
import {
  type CredentialResolver,
  createCredentialResolver,
} from "../core/auth/credential_resolver.js";
import {
  type CommandDispatchContext,
  type CommandRegistry,
  createCommandRegistry,
  getRiskLevelDescription,
} from "../core/commands/index.js";
import {
  type BashCommand,
  type Config,
  createDefaultConfigDeps,
  loadRuntimeConfig,
  type ThemeDefinition,
} from "../core/config/index.js";
import type { CoreEvent } from "../core/events/types.js";
import type { PromptTemplate } from "../core/prompts.js";
import { type CoreDeps, createDefaultCoreDeps } from "../core/runtime/deps.js";
import { CoreSession } from "../core/session/core_session.js";
import { formatSubagentsForPrompt } from "../core/subagents/registry.js";
import {
  BASH_USER_MAX_STDERR_LINES,
  BASH_USER_MAX_STDERR_TOKENS,
  BASH_USER_MAX_STDOUT_LINES,
  BASH_USER_MAX_STDOUT_TOKENS,
  buildBashUiText,
  formatBashUserMessageText,
  prepareBashOutput,
} from "../core/tools/bash.js";
import { ToolCatalog } from "../core/tools/catalog.js";
import type { ToolExecutionBackend } from "../core/tools/execution_backend.js";
import { createLocalToolExecutionBackend } from "../core/tools/execution_backend.js";
import {
  type Persona,
  REASONING_LEVELS,
  type ReasoningEffort,
  type RiskLevel,
  type Skill,
} from "../core/types.js";
import {
  buildBaseSystemPrompt,
  buildEnvironmentTag,
  buildProjectContextBlock,
  buildSkillsIndexBlock,
  findAgentsFilesInScopeDetailed,
  formatRiskLevelChangeNotice,
} from "../core/utils/context.js";
import { formatHistoryForCompression } from "../core/utils/fork.js";
import { formatAdaptiveNumber, formatCwd, formatTokenWindow } from "../core/utils/format.js";
import { getGitRoot } from "../core/utils/git.js";
import { extractAllFencedCodeBlocks, extractAssistantText } from "../core/utils/messages.js";
import { streamModel } from "../core/utils/model_stream.js";
import { listProjectFilesAsync } from "../core/utils/project_files.js";
import { APP_VERSION } from "../core/version.js";
import type { ChatInputMode, ChatView, ChatViewInputHandlers } from "./chat_view.js";
import { copyTextToClipboard } from "./clipboard.js";
import { buildExportEntriesFromHistory } from "./export/engine_history.js";
import { renderExport } from "./export/index.js";
import type { AssistantMessageModel } from "./ui/chat_message_model.js";
import { getFileAutocompleteToken } from "./ui/slash_autocomplete.js";
import type { SystemMessageKind } from "./ui/system_message.js";

export interface ChatControllerOptions {
  view: ChatView;
  personas: Persona[];
  prompts?: PromptTemplate[];
  skills?: Skill[];
  themes?: ThemeDefinition[];
  bashCommands?: BashCommand[];
  initialPersonaId?: string;
  initialUserMessage?: string;
  initialRiskLevel?: RiskLevel;
  withContext?: boolean;
  themePreview?: boolean;
  config?: Config;
  deps?: CoreDeps;
  queuedUserMessages?: string[];
}

type AssistantState = { id?: string; inserted: boolean; model: AssistantMessageModel };

const ALLOWED_RISK_LEVELS: RiskLevel[] = ["read-only", "read-write"];

export class ChatController {
  private readonly view: ChatView;
  private personas: Persona[];
  private currentPersona: Persona;
  private prompts: PromptTemplate[];
  private skills: Skill[];
  private themes: ThemeDefinition[];
  private bashCommands: BashCommand[];
  private readonly repoRoot: string;
  private readonly initialUserMessage?: string;
  private config: Config;
  private activeThemeId?: string;
  private readonly credentialResolver: CredentialResolver;
  private readonly authPath: string;

  private readonly engine: CoreSession;
  private readonly commandRegistry: CommandRegistry<CommandDispatchContext>;
  private readonly commandHandlers: CommandDispatchContext;
  private readonly toolBackend: ToolExecutionBackend;
  private readonly deps: CoreDeps;
  private isStreaming = false;
  private queuedUserMessages: string[];
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
  private assistantState?: AssistantState;
  private currentTurnStartedAt?: number;
  private lastTurnDurationMs = 0;
  private turnTimer?: ReturnType<typeof setInterval>;
  private themePreview: boolean;

  constructor(options: ChatControllerOptions) {
    this.view = options.view;
    this.deps = options.deps ?? createDefaultCoreDeps();
    const cwd = this.deps.env.cwd();
    const home = this.deps.env.home();

    this.personas = options.personas;
    this.prompts = options.prompts ?? [];
    this.skills = options.skills ?? [];
    this.themes = options.themes ?? [];
    this.bashCommands = options.bashCommands ?? [];
    this.repoRoot = getGitRoot(cwd) ?? cwd;
    this.initialUserMessage = options.initialUserMessage;
    this.config = options.config ?? {};
    this.activeThemeId = this.config.defaultTheme;
    this.authPath = getAuthPath(this.deps.env.home());
    const authStorage = new AuthStorage(this.authPath);
    this.credentialResolver = createCredentialResolver({
      authStorage,
      getConfig: () => this.config,
    });
    this.compactToolUi = true;
    this.themePreview = options.themePreview ?? false;
    this.showThinking = this.themePreview;
    this.queuedUserMessages = options.queuedUserMessages ?? [];

    if (this.themePreview) {
      this.queuedUserMessages.push(
        "Queue: adjust muted contrast and preview again",
        "Queue: verify tool error colors",
      );
    }

    if (options.withContext) {
      const res = findAgentsFilesInScopeDetailed(cwd, home);
      this.agentsFiles = res.files;
      this.agentsConfigErrors = res.errors;
    } else {
      this.agentsFiles = [];
      this.agentsConfigErrors = [];
    }

    this.projectContextBlock = options.withContext
      ? buildProjectContextBlock({
          cwd,
          home,
          agentsFiles: this.agentsFiles,
          readFile: this.deps.fs.readFile,
        })
      : undefined;

    this.projectFiles = [];
    this.refreshProjectFilesInBackground();

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
    const allowedRiskLevels = ALLOWED_RISK_LEVELS;
    if (!allowedRiskLevels.includes(this.riskLevel)) {
      this.riskLevel = allowedRiskLevels[0] ?? "read-only";
    }
    this.initialRiskLevel = this.riskLevel;

    this.environmentTag = buildEnvironmentTag({
      riskLevel: this.initialRiskLevel,
      cwd,
      datetime: new Date(this.deps.clock.now()).toISOString(),
      platform: this.deps.env.platform(),
      nodeVersion: this.deps.env.nodeVersion(),
    });

    this.baseSystemPrompt = buildBaseSystemPrompt({
      personaSystemPrompt: this.currentPersona.systemPrompt,
      skillsBlock: this.getSkillsIndexBlockForPersona(this.currentPersona).skillsBlock,
      projectContextBlock: this.projectContextBlock,
      environmentTag: this.environmentTag,
      subagentsBlock: formatSubagentsForPrompt(this.currentPersona),
    });

    this.toolBackend = createLocalToolExecutionBackend({
      spawn: this.deps.spawn,
      env: this.deps.env,
    });
    const toolRegistry = ToolCatalog.createRegistry(this.toolBackend);
    this.engine = new CoreSession({
      persona: this.currentPersona,
      systemPrompt: this.baseSystemPrompt,
      riskLevel: this.riskLevel,
      toolRegistry,
      config: this.config,
      deps: this.deps,
    });

    this.commandRegistry = createCommandRegistry();
    this.commandHandlers = {
      help: () => this.showHelp(),
      copy: () => this.copyLastAssistantMessage(),
      copyCode: () => this.copyLastAssistantCodeBlock(),
      export: () => this.exportSessionHtml(),
      newSession: () => this.clearSession(),
      compactOnlySummary: () => this.forkSessionOnlySummary(),
      compactSummaryAndLastTurn: () => this.forkSessionSummaryAndLastTurn(),
      reload: () => this.reloadContent(),
      risk: (level) => this.setRiskLevel(level),
      persona: (id) => this.switchPersona(id),
      prompt: (id) => this.insertPrompt(id),
      theme: (id) => this.switchTheme(id),
      bash: (id) => this.runSavedBashCommand(id),
      unknown: () => this.view.addSystemMessage("unknown command. type /help.", "error"),
    };

    this.view.setThinkingVisibility(this.showThinking);
    this.view.setCompactToolUi(this.compactToolUi);

    if (!this.themePreview) {
      this.view.addMessage({
        type: "app_intro",
        appName: "tau",
        version: APP_VERSION,
        helpText: this.commandRegistry.buildHelpText({
          agentsFiles: this.agentsFiles,
          skills: this.skills,
          riskLevels: ALLOWED_RISK_LEVELS,
          themes: this.themes.map((theme) => theme.id),
        }),
      });

      if (this.agentsConfigErrors.length > 0) {
        this.view.addSystemMessage(
          ["config warnings:", ...this.agentsConfigErrors.map((e) => `- ${e}`)].join("\n"),
          "warn",
        );
      }
    }

    this.refreshStatus();
  }

  public getCommandRegistry(): CommandRegistry<CommandDispatchContext> {
    return this.commandRegistry;
  }

  public getAutocompleteSources(): {
    personas: () => Array<{ id: string; label?: string }>;
    prompts: () => Array<{ id: string; label?: string }>;
    themes: () => Array<{ id: string; label?: string }>;
    bashCommands: () => Array<{ id: string; description?: string }>;
    projectFiles: () => string[];
    skills: () => string[];
    riskLevels: () => RiskLevel[];
  } {
    return {
      personas: () => this.personas.map((p) => ({ id: p.id, label: p.label })),
      prompts: () => this.prompts.map((t) => ({ id: t.id, label: t.label })),
      themes: () => this.themes.map((theme) => ({ id: theme.id })),
      bashCommands: () =>
        this.bashCommands.map((b) => ({
          id: b.id,
          description: b.description,
        })),
      projectFiles: () => this.projectFiles,
      skills: () => this.skills.map((skill) => skill.name),
      riskLevels: () => ALLOWED_RISK_LEVELS,
    };
  }

  public getInputHandlers(): ChatViewInputHandlers {
    return {
      onCtrlT: () => this.toggleThinkingVisibility(),
      onCtrlO: () => this.toggleCompactToolUi(),
      onShiftTab: () => this.cycleReasoningLevel(),
      onCtrlR: () => this.cycleRiskLevel(),
      onCtrlP: () => this.cyclePersonality(),
      onCtrlS: () => void this.stashEditorToClipboard(),
      onEscape: () => this.onInterrupt(),
      onCtrlF: () => {
        this.expandFileMentions().catch((err) => {
          this.view.addSystemMessage(
            `mention expansion failed: ${(err as Error).message}`,
            "error",
          );
        });
      },
      onAltUp: () => this.popQueuedUserMessageIntoEditor(),
      beforeSubmit: (text: string) => this.beforeSubmit(text),
      onChange: (text: string) => this.handleEditorChange(text),
      onSubmit: (text: string) => void this.onUserInput(text),
    };
  }

  async start(): Promise<void> {
    if (this.themePreview) {
      return;
    }

    if (this.initialUserMessage) {
      await this.sendInitialUserMessage(this.initialUserMessage);
    }
  }

  // Mode Adapter ---------------------------------------------------------------------------------

  public async onUserInput(text: string): Promise<void> {
    await this.handleSubmit(text);
  }

  public onInterrupt(): void {
    this.interruptAssistantTurn();
  }

  public onEvent(event: CoreEvent): void {
    switch (event.type) {
      case "assistant_start":
        this.assistantState = {
          inserted: false,
          model: { type: "assistant_partial", text: "", thinking: "" },
        };
        return;

      case "assistant_partial": {
        const state = this.ensureAssistantState();
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
          this.ensureAssistantInserted(state);
        }

        if (state.inserted && state.id) {
          this.view.updateAssistantMessage(state.id, model);
        }
        return;
      }

      case "assistant_final": {
        const state = this.ensureAssistantState();
        const model: AssistantMessageModel = { type: "assistant", message: event.message };
        state.model = model;
        if (!state.inserted) {
          this.ensureAssistantInserted(state);
        }
        if (state.id) {
          this.view.updateAssistantMessage(state.id, model);
        }
        this.refreshStatus();
        this.assistantState = undefined;
        return;
      }

      case "tool_ui":
        this.view.handleToolUiEvent(event.uiEvent);
        this.refreshStatus();
        return;

      case "notice": {
        const kind: SystemMessageKind =
          event.severity === "error" ? "error" : event.severity === "warn" ? "warn" : "success";
        this.view.addSystemMessage(event.text, kind);
        return;
      }

      case "tool_result":
        return;
    }
  }

  private ensureAssistantState(): AssistantState {
    if (this.assistantState) return this.assistantState;
    const state: AssistantState = {
      inserted: false,
      model: { type: "assistant_partial", text: "", thinking: "" },
    };
    this.assistantState = state;
    return state;
  }

  private ensureAssistantInserted(state: AssistantState): void {
    if (state.inserted) return;
    state.inserted = true;
    state.id = this.view.addMessage(state.model);
  }

  // UI Updates ------------------------------------------------------------------------------------

  private refreshStatus(): void {
    const reasoningLabel = this.currentPersona.settings.reasoning ?? "none";
    const contextUsage = this.getContextUsageString();
    const sessionCost = this.getSessionCostString();
    const cwd = formatCwd(this.deps.env.cwd());
    const duration = this.getTurnDurationString();

    const personaName = this.currentPersona.label || this.currentPersona.id;
    this.view.updateStatus({
      footer: {
        contextUsage,
        sessionCost,
        duration,
        riskLevel: this.riskLevel,
      },
      editor: {
        mode: this.getInputMode(),
        cwdLabel: cwd,
        personaName,
        reasoningLabel,
        reasoning: this.currentPersona.settings.reasoning,
      },
    });
  }

  private getInputMode(): ChatInputMode {
    if (this.isBashMode) return "bash";
    if (this.isMemoryMode) return "memory";
    return "normal";
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
    return `$${formatAdaptiveNumber(total + this.view.getToolUiCostTotal(), 2, 5)}`;
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
    this.turnTimer = setInterval(() => this.refreshStatus(), 1000);
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
    this.refreshStatus();
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
    this.refreshStatus();
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
    const desired = persona.settings.reasoning;
    if (!desired || !allowed.includes(desired)) {
      persona.settings.reasoning = allowed[0]!;
    }
  }

  // Risk Level Management -------------------------------------------------------------------------

  private cycleRiskLevel(): void {
    const allowed = ALLOWED_RISK_LEVELS;
    const index = allowed.indexOf(this.riskLevel);
    const next = allowed[(index + 1) % allowed.length] ?? "read-only";
    this.setRiskLevel(next);
  }

  private cyclePersonality(): void {
    const index = this.personas.indexOf(this.currentPersona);
    const next = this.personas[(index + 1) % this.personas.length]!;
    this.switchPersona(next.id);
  }

  private getEnabledSkillsForPersona(persona: Persona): { skills: Skill[]; unknown: string[] } {
    const personaSkills = persona.skills;
    if (personaSkills === "*") {
      return { skills: this.skills, unknown: [] };
    }

    if (!personaSkills || personaSkills.length === 0) {
      return { skills: [], unknown: [] };
    }

    const skillsByName = new Map<string, Skill>();
    for (const skill of this.skills) {
      skillsByName.set(skill.name.toLowerCase(), skill);
    }

    const enabled: Skill[] = [];
    const unknown: string[] = [];

    for (const name of personaSkills) {
      const trimmed = name.trim();
      if (!trimmed) continue;
      const skill = skillsByName.get(trimmed.toLowerCase());
      if (skill) {
        enabled.push(skill);
      } else {
        unknown.push(trimmed);
      }
    }

    return { skills: enabled, unknown };
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
    this.view.setThinkingVisibility(this.showThinking);
    const message = this.showThinking ? "thoughts visible" : "thoughts hidden";
    this.view.addSystemMessage(message, "success");
  }

  private toggleCompactToolUi(): void {
    this.compactToolUi = !this.compactToolUi;
    this.view.setCompactToolUi(this.compactToolUi);
    const message = this.compactToolUi ? "compact tool UI enabled" : "compact tool UI disabled";
    this.view.addSystemMessage(message, "success");
  }

  private interruptAssistantTurn(): void {
    if (!this.isStreaming || this.currentTurnAbort?.signal.aborted) return;
    this.currentTurnAbort?.abort();
    this.view.addSystemMessage("interrupted.", "error");
  }

  // Input Handling --------------------------------------------------------------------------------

  private beforeSubmit(text: string): boolean {
    if (this.themePreview) {
      return false;
    }
    if (!this.isStreaming) return true;
    const trimmed = text.trimStart();
    if (trimmed.startsWith("!")) {
      return false;
    }
    if (trimmed.startsWith("/")) {
      const parsed = this.commandRegistry.parse(trimmed);
      return this.commandRegistry.allowsDuringStreaming(parsed);
    }
    return true;
  }

  private handleEditorChange(text: string): void {
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
      this.refreshStatus();
    }
  }

  private getEditorTextBeforeCursor(): string {
    const { line, col } = this.view.getEditorCursor();
    const lines = this.view.getEditorLines();
    const current = lines[line] ?? "";
    return current.slice(0, col);
  }

  private refreshProjectFilesInBackground(): void {
    if (this.isRefreshingProjectFiles) return;

    this.isRefreshingProjectFiles = true;

    void listProjectFilesAsync(this.deps.env.cwd())
      .then((files) => {
        this.projectFiles = files;
        this.view.requestRender();
      })
      .catch(() => {
        // Ignore refresh errors; autocomplete will keep using the existing cache.
      })
      .finally(() => {
        this.isRefreshingProjectFiles = false;
      });
  }

  private queueUserMessage(text: string): void {
    this.queuedUserMessages.push(text);
    this.view.requestRender();
  }

  private popQueuedUserMessageIntoEditor(): void {
    if (this.view.getEditorText() !== "") return;

    const last = this.queuedUserMessages.pop();
    if (!last) return;

    this.view.setEditorText(last);
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

        this.view.requestRender();
        await this.onUserInput(next);
      }
    } finally {
      this.isDrainingQueuedUserMessages = false;

      if (
        this.pendingIdleNotification &&
        !this.isStreaming &&
        this.queuedUserMessages.length === 0
      ) {
        this.pendingIdleNotification = false;
        this.view.sendTerminalNotification(this.buildIdleNotificationTitle());
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
      if (trimmed.startsWith("/")) {
        const parsed = this.commandRegistry.parse(trimmed);
        if (this.commandRegistry.allowsDuringStreaming(parsed)) {
          await this.commandRegistry.dispatch(parsed, this.commandHandlers);
        }
        return;
      }
      if (trimmed.startsWith("!")) {
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
        this.view.addSystemMessage("memory mode request was empty.", "warn");
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
    this.view.addMessage({
      type: "user",
      text,
      isMemoryMode: opts?.isMemoryMode,
    });
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

    this.view.addMessage({ type: "user", text: trimmed });
    this.expandedFilesInCurrentPrompt.clear();
    this.expandedSkillsInCurrentPrompt.clear();
    this.engine.addUserText(trimmed);

    await this.runAssistantTurn();
  }

  private getMemoryModeFilePath(): string {
    const cwd = this.deps.env.cwd();
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
    const cmd = this.commandRegistry.parse(raw);
    await this.commandRegistry.dispatch(cmd, this.commandHandlers);
  }

  private showHelp(): void {
    this.view.addSystemMessage(
      this.commandRegistry.buildHelpText({
        agentsFiles: this.agentsFiles,
        skills: this.skills,
        riskLevels: ALLOWED_RISK_LEVELS,
        themes: this.themes.map((theme) => theme.id),
      }),
      "muted",
    );
  }

  private async copyLastAssistantMessage(): Promise<void> {
    const lastAssistant = this.getLastAssistantMessage();
    if (!lastAssistant) {
      this.view.addSystemMessage("no assistant message to copy yet.", "warn");
      return;
    }

    const text = extractAssistantText(lastAssistant);
    if (!text.trim()) {
      this.view.addSystemMessage("last assistant message was empty.", "warn");
      return;
    }

    try {
      await copyTextToClipboard(text);
      this.view.addSystemMessage("copied last assistant message to clipboard.", "success");
    } catch (err) {
      this.view.addSystemMessage(`clipboard copy failed: ${(err as Error).message}`, "error");
    }
  }

  private async copyLastAssistantCodeBlock(): Promise<void> {
    const lastAssistant = this.getLastAssistantMessage();
    if (!lastAssistant) {
      this.view.addSystemMessage("no assistant message to copy yet.", "warn");
      return;
    }

    const text = extractAssistantText(lastAssistant);
    const code = extractAllFencedCodeBlocks(text);
    if (!code) {
      this.view.addSystemMessage("no code block to copy yet.", "warn");
      return;
    }

    try {
      await copyTextToClipboard(code);
      this.view.addSystemMessage("copied all code blocks to clipboard.", "success");
    } catch (err) {
      this.view.addSystemMessage(`clipboard copy failed: ${(err as Error).message}`, "error");
    }
  }

  private async exportSessionHtml(): Promise<void> {
    const history = this.engine.history;
    if (history.length === 0) {
      this.view.addSystemMessage("no conversation to export.", "warn");
      return;
    }

    try {
      const entries = buildExportEntriesFromHistory(history);
      if (entries.length === 0) {
        this.view.addSystemMessage("no conversation to export.", "warn");
        return;
      }

      const html = renderExport("html", entries, {
        title: "tau chat export",
        generatedAt: Date.now(),
      });
      const dir = await mkdtemp(join(tmpdir(), "tau-export-"));
      const filePath = join(dir, "index.html");
      await writeFile(filePath, html, "utf8");
      this.view.addSystemMessage(filePath, "muted");
    } catch (err) {
      this.view.addSystemMessage(`export failed: ${(err as Error).message}`, "error");
    }
  }

  private async stashEditorToClipboard(): Promise<void> {
    const text = this.view.getEditorText();
    if (!text.trim()) {
      this.view.addSystemMessage("no input to stash yet", "warn");
      return;
    }

    try {
      await copyTextToClipboard(text);
      this.view.setEditorText("");
      this.view.addSystemMessage("stashed input to clipboard", "success");
    } catch (err) {
      this.view.addSystemMessage(`clipboard copy failed: ${(err as Error).message}`, "error");
    }
  }

  private clearSession(): void {
    this.engine.reset();
    this.view.resetToolUiSession();
    this.expandedFilesInCurrentPrompt.clear();
    this.expandedSkillsInCurrentPrompt.clear();
    this.view.addMessage({ type: "session_divider", label: "new session" });
    this.isBashMode = false;
    this.isMemoryMode = false;
    this.previousSessionSummary = undefined;
    this.rebuildSystemPrompt();
    this.refreshStatus();
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
      cwd: this.deps.env.cwd(),
      datetime: new Date(this.deps.clock.now()).toISOString(),
      platform: this.deps.env.platform(),
      nodeVersion: this.deps.env.nodeVersion(),
    });
    this.baseSystemPrompt = buildBaseSystemPrompt({
      personaSystemPrompt: this.currentPersona.systemPrompt,
      skillsBlock: this.getSkillsIndexBlockForPersona(this.currentPersona).skillsBlock,
      projectContextBlock: this.projectContextBlock,
      environmentTag: this.environmentTag,
      previousSessionSummary,
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

    let apiKey: string | undefined;
    try {
      apiKey = await this.credentialResolver.getApiKey(
        this.currentPersona.model.provider as KnownProvider,
      );
    } catch (error) {
      if (this.currentPersona.model.provider === "openai-codex") {
        throw new Error(formatCodexAuthError(this.authPath, (error as Error)?.message));
      }
      throw error;
    }

    if (!apiKey && this.currentPersona.model.provider === "openai-codex") {
      throw new Error(formatCodexAuthError(this.authPath));
    }
    const stream = streamModel(
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
      { reasoning: "medium", sessionId: `tau-summary-${randomUUID()}`, ...(apiKey && { apiKey }) },
    );

    const final = await stream.result();
    return extractAssistantText(final).trim();
  }

  private applySessionContext(previousSessionContext: string): void {
    this.previousSessionSummary = previousSessionContext;

    // Reset the session state but preserve history with divider and summary
    this.engine.reset();
    this.view.resetToolUiSession();
    this.expandedFilesInCurrentPrompt.clear();
    this.expandedSkillsInCurrentPrompt.clear();
    this.view.addMessage({ type: "session_divider", label: "new session" });
    this.view.addMessage({
      type: "session_summary",
      summary: this.previousSessionSummary,
    });
    this.isBashMode = false;
    this.isMemoryMode = false;

    // Rebuild environment tag and system prompt with the new summary and current risk level
    this.rebuildSystemPrompt(this.previousSessionSummary);

    this.refreshStatus();
  }

  private async forkSessionOnlySummary(): Promise<void> {
    const history = this.engine.history;
    if (history.length === 0) {
      this.view.addSystemMessage("no conversation to fork.", "warn");
      return;
    }

    this.view.addSystemMessage("summarizing session...", "success");
    this.isStreaming = true;
    this.view.startWorkingIcon();

    try {
      const summary = await this.generateSummary(history);
      this.applySessionContext(summary);

      this.view.addSystemMessage(
        "session forked. previous context has been summarized.",
        "success",
      );
    } catch (err) {
      this.view.addSystemMessage(`fork failed: ${(err as Error).message}`, "error");
    } finally {
      this.view.stopWorkingIcon();
      this.isStreaming = false;
      this.view.requestRender();
      void this.drainQueuedUserMessages();
    }
  }

  private async forkSessionSummaryAndLastTurn(): Promise<void> {
    const history = this.engine.history;
    if (history.length === 0) {
      this.view.addSystemMessage("no conversation to fork.", "warn");
      return;
    }

    this.view.addSystemMessage("summarizing session...", "success");
    this.isStreaming = true;
    this.view.startWorkingIcon();

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

      this.view.addSystemMessage(
        "session forked. previous context and last turn have been included.",
        "success",
      );
    } catch (err) {
      this.view.addSystemMessage(`fork failed: ${(err as Error).message}`, "error");
    } finally {
      this.view.stopWorkingIcon();
      this.isStreaming = false;
      this.view.requestRender();
      void this.drainQueuedUserMessages();
    }
  }

  private formatRiskLevelNotice(level: RiskLevel): string {
    const details = getRiskLevelDescription(level);
    return details ? `risk level ${level} (${details})` : `risk level ${level}`;
  }

  private setRiskLevel(
    level: RiskLevel,
    options?: { force?: boolean; silent?: boolean; reason?: string },
  ): void {
    const allowed = ALLOWED_RISK_LEVELS;
    let target = level;
    let forced = false;

    if (!allowed.includes(level)) {
      if (!options?.force) {
        if (!options?.silent) {
          this.view.addSystemMessage(
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
    this.refreshStatus();

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
      this.view.addSystemMessage(msg, "warn");
      return;
    }

    this.view.addSystemMessage(this.formatRiskLevelNotice(target), "success");
  }

  private switchPersona(id: string): void {
    const persona = this.personas.find((p) => p.id.toLowerCase() === id.toLowerCase());

    if (!persona) {
      this.view.addSystemMessage(`unknown persona '${id}'.`, "error");
      return;
    }

    this.currentPersona = persona;
    this.clampPersonaReasoning(this.currentPersona);
    const allowedRiskLevels = ALLOWED_RISK_LEVELS;
    if (!allowedRiskLevels.includes(this.riskLevel)) {
      this.setRiskLevel(this.riskLevel, {
        force: true,
        reason: "risk level is not available for the current persona.",
      });
    }
    const skillsContext = this.getSkillsIndexBlockForPersona(this.currentPersona);
    this.baseSystemPrompt = buildBaseSystemPrompt({
      personaSystemPrompt: this.currentPersona.systemPrompt,
      skillsBlock: skillsContext.skillsBlock,
      projectContextBlock: this.projectContextBlock,
      environmentTag: this.environmentTag,
      previousSessionSummary: this.previousSessionSummary,
      subagentsBlock: formatSubagentsForPrompt(this.currentPersona),
    });
    this.engine.setPersona(this.currentPersona, this.baseSystemPrompt);
    this.refreshStatus();

    if (skillsContext.unknown.length > 0) {
      this.view.addSystemMessage(
        `warning: unknown skills enabled: ${skillsContext.unknown.join(", ")}`,
        "warn",
      );
    }

    this.view.addSystemMessage(`switched to ${persona.label} (${persona.model.id})`, "success");
  }

  private insertPrompt(id: string): void {
    const prompt = this.prompts.find((p) => p.id.toLowerCase() === id.toLowerCase());
    if (!prompt) {
      this.view.addSystemMessage(`unknown prompt '${id}'.`, "error");
      return;
    }
    this.view.setEditorText(prompt.template);
  }

  private switchTheme(id: string): void {
    if (this.themes.length === 0) {
      this.view.addSystemMessage("no themes loaded. add .tau/themes/<id>.json first.", "warn");
      return;
    }

    const theme = this.themes.find((candidate) => candidate.id.toLowerCase() === id.toLowerCase());
    if (!theme) {
      this.view.addSystemMessage(`unknown theme '${id}'.`, "error");
      return;
    }

    this.activeThemeId = theme.id;
    this.config.defaultTheme = theme.id;
    this.view.updateTheme({ themeId: theme.id, themes: this.themes });
    this.view.addSystemMessage(`switched to theme ${theme.id}.`, "success");
  }

  private resolveThemeId(
    themeId: string | undefined,
    themes: ThemeDefinition[],
  ): string | undefined {
    if (!themeId) return undefined;
    const match = themes.find((theme) => theme.id.toLowerCase() === themeId.toLowerCase());
    return match?.id;
  }

  private async runSavedBashCommand(id: string): Promise<void> {
    const saved = this.bashCommands.find((b) => b.id.toLowerCase() === id.toLowerCase());
    if (!saved) {
      this.view.addSystemMessage(`unknown bash command '${id}'.`, "error");
      return;
    }

    await this.runBashCommand(saved.cmd, { cwd: this.repoRoot });
  }

  private async reloadContent(): Promise<void> {
    if (this.isStreaming) {
      this.view.addSystemMessage(
        "cannot reload while streaming. try again after the response.",
        "warn",
      );
      return;
    }

    try {
      const configDeps = createDefaultConfigDeps();
      const runtime = await loadRuntimeConfig(this.deps.env.cwd(), configDeps);
      const { config, personas, prompts, skills, themes, bashCommands, warnings } = runtime;
      const previousThemeId = this.activeThemeId ?? this.config.defaultTheme;
      const resolvedThemeId =
        this.resolveThemeId(previousThemeId, themes) ??
        this.resolveThemeId(config.defaultTheme, themes);

      if (resolvedThemeId) {
        config.defaultTheme = resolvedThemeId;
      }

      this.config = config;
      this.engine.setConfig(this.config);
      this.bashCommands = bashCommands;

      // Update the personas and prompts lists
      this.personas = personas;
      this.prompts = prompts;
      this.skills = skills;
      this.themes = themes;
      this.activeThemeId = resolvedThemeId ?? previousThemeId;
      this.view.updateTheme({ themeId: resolvedThemeId, themes });

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
        this.view.addSystemMessage(
          `previous persona no longer available; switched to ${this.currentPersona.label || this.currentPersona.id}.`,
          "warn",
        );
      }
      const allowedRiskLevels = ALLOWED_RISK_LEVELS;
      if (!allowedRiskLevels.includes(this.riskLevel)) {
        this.setRiskLevel(this.riskLevel, {
          force: true,
          reason: "risk level is not available for the current persona.",
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
        subagentsBlock: formatSubagentsForPrompt(this.currentPersona),
      });
      this.engine.setPersona(this.currentPersona, this.baseSystemPrompt);

      if (skillsContext.unknown.length > 0) {
        this.view.addSystemMessage(
          `warning: unknown skills enabled: ${skillsContext.unknown.join(", ")}`,
          "warn",
        );
      }

      // Update UI
      this.refreshStatus();

      // Display summary
      const personaCount = personas.length;
      const promptCount = prompts.length;
      const skillCount = skills.length;
      const themeCount = themes.length;
      const bashCount = bashCommands.length;
      const errorCount = warnings.length;
      const summary =
        errorCount > 0
          ? `reloaded: ${personaCount} personas, ${promptCount} prompts, ${skillCount} skills, ${themeCount} themes, ${bashCount} bash commands (${errorCount} errors).`
          : `reloaded: ${personaCount} personas, ${promptCount} prompts, ${skillCount} skills, ${themeCount} themes, ${bashCount} bash commands.`;

      this.view.addSystemMessage(summary, "success");
      this.view.requestRender();
    } catch (err) {
      this.view.addSystemMessage(`reload failed: ${(err as Error).message}`, "error");
    }
  }

  // Assistant Turn --------------------------------------------------------------------------------

  private async runAssistantTurn(): Promise<void> {
    this.isStreaming = true;
    this.currentTurnAbort = new AbortController();
    this.view.startWorkingIcon();
    this.startTurnTimer();
    this.assistantState = undefined;

    try {
      for await (const event of this.engine.events(this.currentTurnAbort.signal)) {
        if (this.currentTurnAbort.signal.aborted) break;
        this.onEvent(event);
      }
    } catch (err) {
      const message = (err as Error).message || "request failed.";
      this.view.addSystemMessage(message, "error");
    } finally {
      const wasAborted = this.currentTurnAbort?.signal.aborted ?? false;
      const reason = wasAborted ? "aborted" : "interrupted";

      this.view.finalizeToolUiPending(reason);

      this.view.stopWorkingIcon();
      this.stopTurnTimer();
      this.isStreaming = false;
      this.currentTurnAbort = undefined;
      this.view.clearToolUiTransientState();
      this.pendingIdleNotification = true;
      this.view.requestRender();
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
      } = await this.toolBackend.runBash(command, {
        cwd: opts?.cwd,
        signal: abortController.signal,
      });
      const durationMs = Math.max(0, Date.now() - startedAt);
      const truncationInfo = prepareBashOutput(stdout, stderr, captureTruncated, {
        stdout: { maxLines: BASH_USER_MAX_STDOUT_LINES, maxTokens: BASH_USER_MAX_STDOUT_TOKENS },
        stderr: { maxLines: BASH_USER_MAX_STDERR_LINES, maxTokens: BASH_USER_MAX_STDERR_TOKENS },
      });

      const uiText = buildBashUiText({
        truncationInfo,
        exitCode,
        durationMs,
        previewLines: { head: 12, tail: 12 },
      });

      this.view.addBashExecutionMessage({
        command,
        exitCode,
        uiText,
        labelOverride: "you ran",
      });

      this.engine.addUserText(formatBashUserMessageText({ command, truncationInfo }));

      this.view.requestRender();
    } catch (err) {
      const message = (err as Error).message || "bash failed.";
      this.view.addSystemMessage(`bash failed: ${message}`, "error");
    } finally {
      wasAborted = abortController.signal.aborted;
      this.isStreaming = false;
      if (this.currentTurnAbort === abortController) {
        this.currentTurnAbort = undefined;
      }
      this.stopTurnTimer();
      this.view.requestRender();
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
      this.view.addSystemMessage(
        "cannot expand mentions while streaming. try again after the response.",
        "warn",
      );
      return;
    }

    const editorText = this.view.getEditorText();

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
      // Strip trailing punctuation to handle cases like "@src/tui/app.ts," or "(see @README.md)"
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
