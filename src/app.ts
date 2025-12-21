import { homedir } from "node:os";
import { join, resolve } from "node:path";
import type { AssistantMessage, KnownProvider, Message } from "@mariozechner/pi-ai";
import { streamSimple } from "@mariozechner/pi-ai";
import { Spacer, Text, TUI } from "@mariozechner/pi-tui";
import { type BashCommand, loadBashCommands } from "./bash_commands.js";
import { copyTextToClipboard } from "./clipboard.js";
import { buildHelpText, getRiskLevelDescription, parseCommand } from "./commands.js";
import type { Config } from "./config.js";
import { getApiKeyForProvider } from "./config.js";
import { loadAllContent } from "./content_loader.js";
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
import { AssistantMessageComponent } from "./ui/assistant_message.js";
import {
  renderBashAborted,
  renderBashBlocked,
  renderBashExecution,
  renderBashRunning,
} from "./ui/bash_execution.js";
import { ChatContainerComponent } from "./ui/chat_container.js";
import { CustomEditor } from "./ui/custom_editor.js";
import {
  renderEditBlocked,
  renderEditSuccess,
  renderWriteBlocked,
  renderWriteSuccess,
} from "./ui/file_execution.js";
import { FooterComponent } from "./ui/footer.js";
import { QueuedMessagesComponent } from "./ui/queued_messages.js";
import {
  renderGrepBlocked,
  renderGrepFinished,
  renderGrepRunning,
  renderListBlocked,
  renderListSuccess,
  renderReadBlocked,
  renderReadSuccess,
} from "./ui/restricted_execution.js";
import { SessionDividerComponent } from "./ui/session_divider.js";
import { SessionSummaryComponent } from "./ui/session_summary.js";
import { getFileAutocompleteToken, SlashAutocompleteProvider } from "./ui/slash_autocomplete.js";
import { SystemMessageComponent } from "./ui/system_message.js";
import { renderTaskBlocked, renderTaskFinished, renderTaskRunning } from "./ui/task_execution.js";
import { editorBorderForReasoning, theme } from "./ui/theme.js";
import { UserMessageComponent } from "./ui/user_message.js";
import {
  buildBaseSystemPrompt,
  buildEnvironmentTag,
  buildProjectContextBlock,
  buildSkillsIndexBlock,
  findAgentsFilesFromCwdToHome,
  formatRiskLevelChangeNotice,
} from "./utils/context.js";
import { formatHistoryForCompression } from "./utils/fork.js";
import { formatAdaptiveNumber, formatCwd, formatTokenWindow } from "./utils/format.js";
import { getGitRoot } from "./utils/git.js";
import { extractAllFencedCodeBlocks, extractAssistantText } from "./utils/messages.js";
import { listProjectFiles, listProjectFilesAsync } from "./utils/project_files.js";
import { APP_VERSION } from "./version.js";

const { palette } = theme;

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
  config?: Config;
}

export class ChatApp {
  private ui: TUI;
  private chatContainer: ChatContainerComponent;
  private footer: FooterComponent;
  private queuedMessages: QueuedMessagesComponent;
  private editor: CustomEditor;

  private personas: Persona[];
  private currentPersona: Persona;
  private prompts: PromptTemplate[];
  private skills: Skill[];
  private bashCommands: BashCommand[];
  private readonly repoRoot: string;
  private initialUserMessage?: string;
  private config: Config;

  private assistantComponents: AssistantMessageComponent[] = [];
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
  private baseSystemPrompt: string;
  private pendingRiskLevelChange?: { from: RiskLevel; to: RiskLevel };
  private previousSessionSummary?: string;
  private expandedFilesInCurrentPrompt: Set<string> = new Set();

  constructor(options: ChatAppOptions) {
    this.personas = options.personas;
    this.prompts = options.prompts ?? [];
    this.skills = options.skills ?? [];
    this.bashCommands = options.bashCommands ?? [];
    this.repoRoot = getGitRoot(process.cwd()) ?? process.cwd();
    this.initialUserMessage = options.initialUserMessage;
    this.config = options.config ?? {};
    this.compactToolUi = this.config.toolDisplayMode !== "full";

    if (options.initialRiskLevel) {
      this.riskLevel = options.initialRiskLevel;
    }
    this.initialRiskLevel = this.riskLevel;

    this.environmentTag = buildEnvironmentTag({
      riskLevel: this.initialRiskLevel,
      cwd: process.cwd(),
      datetime: new Date().toISOString(),
    });

    this.agentsFiles = options.withContext
      ? findAgentsFilesFromCwdToHome(process.cwd(), homedir())
      : [];

    this.projectContextBlock = options.withContext
      ? buildProjectContextBlock({ cwd: process.cwd(), home: homedir() })
      : undefined;

    this.projectFiles = listProjectFiles(process.cwd());

    this.currentPersona =
      (options.initialPersonaId &&
        this.personas.find(
          (p) => p.id.toLowerCase() === options.initialPersonaId!.toLowerCase(),
        )) ||
      this.personas[0]!;
    this.clampPersonaReasoning(this.currentPersona);

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

    this.ui = new TUI(createAppTerminal());
    this.chatContainer = new ChatContainerComponent();
    this.chatContainer.setCompactToolUi(this.compactToolUi);
    this.footer = new FooterComponent(this.ui);
    this.queuedMessages = new QueuedMessagesComponent(() => this.queuedUserMessages);
    this.editor = new CustomEditor(theme.editorTheme);

    this.setupUI();
    this.setupEditor();
  }

  private setupUI(): void {
    this.ui.addChild(this.chatContainer);
    this.ui.addChild(new Spacer(1));
    this.ui.addChild(this.queuedMessages);
    this.ui.addChild(this.editor);
    this.ui.addChild(this.footer);

    const headerText =
      `\n${palette.accent("tau")} ${palette.muted(`– terminal chat (v${APP_VERSION})`)}\n\n` +
      palette.muted(buildHelpText(this.agentsFiles, this.skills));
    this.chatContainer.addMessage(new Text(headerText, 1, 0));

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
    this.editor.onEscape = () => this.interruptAssistantTurn();
    this.editor.onCtrlF = () => {
      this.expandFileMentions().catch((err) => {
        this.addSystemMessage(
          `file expansion failed: ${(err as Error).message}`,
          palette.noticeError,
        );
      });
    };

    this.editor.onAltUp = () => this.popQueuedUserMessageIntoEditor();
    this.editor.beforeSubmit = (text: string) => {
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

    if (this.initialUserMessage) {
      await this.sendInitialUserMessage(this.initialUserMessage);
    }
  }

  stop(): void {
    this.ui.stop();
  }

  // UI Updates ------------------------------------------------------------------------------------

  private updateFooter(): void {
    const reasoningLabel = this.currentPersona.settings.reasoning || "default";
    const toolLabel = this.formatRiskLevelLabel();
    const contextUsage = this.getContextUsageString();
    const sessionCost = this.getSessionCostString();
    const cwd = formatCwd(process.cwd());

    const left = palette.dim(`${cwd} · ${contextUsage} · ${sessionCost}`);
    const personaName = this.currentPersona.label || this.currentPersona.id;
    const statusPart = palette.dim(`${personaName} · ${reasoningLabel} · `);
    const right = `${statusPart}${toolLabel}`;

    this.footer.setLeftRight(left, right);
    this.ui.requestRender();
  }

  private formatRiskLevelLabel(): string {
    switch (this.riskLevel) {
      case "restricted":
        return palette.riskRestricted("restricted");
      case "read-only":
        return palette.riskReadOnly("read-only");
      case "read-write":
        return palette.riskReadWrite("read-write");
    }
  }

  private updateEditorBorderColor(): void {
    if (this.isBashMode) {
      this.editor.borderColor = (s: string) => palette.bashRan(s);
    } else if (this.isMemoryMode) {
      this.editor.borderColor = (s: string) => palette.memoryMode(s);
    } else {
      this.editor.borderColor = editorBorderForReasoning(this.currentPersona.settings.reasoning);
    }
    this.ui.requestRender();
  }

  private addSystemMessage(text: string, styleFn: (t: string) => string): void {
    this.chatContainer.addMessage(new SystemMessageComponent(text, styleFn));
    this.ui.requestRender();
  }

  private addUserMessage(text: string, opts?: { isMemoryMode?: boolean }): void {
    this.chatContainer.addMessage(new UserMessageComponent(text, opts));
    this.ui.requestRender();
  }

  private addAssistantComponent(component: AssistantMessageComponent): void {
    this.chatContainer.addMessage(component);
    this.assistantComponents.push(component);
    this.ui.requestRender();
  }

  // Context & Cost Tracking -----------------------------------------------------------------------

  private getContextUsageString(): string {
    const last = this.getLastAssistantMessage();
    const windowTokens = last
      ? this.getContextWindowForLastTurn(last)
      : this.currentPersona.model.contextWindow;

    const { read, write } = this.getCacheTotals();
    let stats = `r${formatTokenWindow(read)} w${formatTokenWindow(write)}`;

    if (!last) {
      return `${stats} 0%/${formatTokenWindow(windowTokens)}`;
    }

    // Sum output tokens from assistant messages in the current turn (after last user message)
    let totalOutputTokens = 0;
    for (let i = this.engine.history.length - 1; i >= 0; i--) {
      const m = this.engine.history[i]!;
      if (m.role === "user") {
        break;
      }
      if (m.role === "assistant") {
        totalOutputTokens += (m as AssistantMessage).usage?.output ?? 0;
      }
    }
    stats += ` o${formatTokenWindow(totalOutputTokens)}`;

    const promptTokensSent =
      (last.usage?.input ?? 0) + (last.usage?.cacheRead ?? 0) + (last.usage?.cacheWrite ?? 0);
    const percent = windowTokens > 0 ? (promptTokensSent / windowTokens) * 100 : 0;
    const percentStr = `${formatAdaptiveNumber(percent, 1, 3)}%`;

    return `${stats} ${percentStr}/${formatTokenWindow(windowTokens)}`;
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

  private getCacheTotals(): { read: number; write: number } {
    let read = 0;
    let write = 0;
    for (const m of this.engine.history) {
      if (m.role === "assistant") {
        const usage = (m as AssistantMessage).usage;
        read += usage?.cacheRead ?? 0;
        write += usage?.cacheWrite ?? 0;
      }
    }
    return { read, write };
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

  private getSkillsIndexBlockForPersona(persona: Persona): {
    skillsBlock?: string;
    unknown: string[];
  } {
    const enabled = persona.skills;
    if (!enabled) {
      return { unknown: [] };
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

    return { skillsBlock: buildSkillsIndexBlock(selected), unknown };
  }

  // User Actions ----------------------------------------------------------------------------------

  private toggleThinkingVisibility(): void {
    this.showThinking = !this.showThinking;
    this.assistantComponents.forEach((c) => {
      c.setThinkingVisibility(this.showThinking);
    });
    this.chatContainer.setThinkingVisibility(this.showThinking);
    const message = this.showThinking
      ? "thoughts visible (ctrl+t to hide)"
      : "thoughts hidden (ctrl+t to show)";
    this.addSystemMessage(message, palette.noticeSuccess);
    this.ui.requestRender();
  }

  private toggleCompactToolUi(): void {
    this.compactToolUi = !this.compactToolUi;
    this.chatContainer.setCompactToolUi(this.compactToolUi);
    const message = this.compactToolUi
      ? "compact tool UI enabled (ctrl+o to disable)"
      : "compact tool UI disabled (ctrl+o to enable)";
    this.addSystemMessage(message, palette.noticeSuccess);
    this.ui.requestRender();
  }

  private interruptAssistantTurn(): void {
    if (!this.isStreaming || this.currentTurnAbort?.signal.aborted) return;
    this.currentTurnAbort?.abort();
    this.addSystemMessage("interrupted.", palette.noticeError);
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
        this.addSystemMessage("memory mode request was empty.", palette.noticeWarn);
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

      case "new":
        this.clearSession();
        break;

      case "forkOnlySummary":
        await this.forkSessionOnlySummary();
        break;

      case "forkSummaryAndLastTurn":
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
        this.addSystemMessage("unknown command. type /help.", palette.noticeError);
        break;
    }
  }

  private showHelp(): void {
    this.addSystemMessage(
      buildHelpText(this.agentsFiles, this.skills),
      palette.muted, // Intentionally not a notice style
    );
  }

  private async copyLastAssistantMessage(): Promise<void> {
    const lastAssistant = this.getLastAssistantMessage();
    if (!lastAssistant) {
      this.addSystemMessage("no assistant message to copy yet.", palette.noticeWarn);
      return;
    }

    const text = extractAssistantText(lastAssistant);
    if (!text.trim()) {
      this.addSystemMessage("last assistant message was empty.", palette.noticeWarn);
      return;
    }

    try {
      await copyTextToClipboard(text);
      this.addSystemMessage("copied last assistant message to clipboard.", palette.noticeSuccess);
    } catch (err) {
      this.addSystemMessage(
        `clipboard copy failed: ${(err as Error).message}`,
        palette.noticeError,
      );
    }
  }

  private async copyLastAssistantCodeBlock(): Promise<void> {
    const lastAssistant = this.getLastAssistantMessage();
    if (!lastAssistant) {
      this.addSystemMessage("no assistant message to copy yet.", palette.noticeWarn);
      return;
    }

    const text = extractAssistantText(lastAssistant);
    const code = extractAllFencedCodeBlocks(text);
    if (!code) {
      this.addSystemMessage("no code block to copy yet.", palette.noticeWarn);
      return;
    }

    try {
      await copyTextToClipboard(code);
      this.addSystemMessage("copied all code blocks to clipboard.", palette.noticeSuccess);
    } catch (err) {
      this.addSystemMessage(
        `clipboard copy failed: ${(err as Error).message}`,
        palette.noticeError,
      );
    }
  }

  private clearSession(): void {
    this.engine.reset();
    this.assistantComponents = [];
    this.runningBashComponents.clear();
    this.runningTaskComponents.clear();
    this.taskEvents.clear();
    this.subagentCostTotal = 0;
    this.expandedFilesInCurrentPrompt.clear();
    this.chatContainer.addMessage(new SessionDividerComponent("new session"));
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
    this.assistantComponents = [];
    this.runningBashComponents.clear();
    this.runningTaskComponents.clear();
    this.taskEvents.clear();
    this.subagentCostTotal = 0;
    this.expandedFilesInCurrentPrompt.clear();
    this.chatContainer.addMessage(new SessionDividerComponent("new session"));
    this.chatContainer.addMessage(new SessionSummaryComponent(this.previousSessionSummary));
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
      this.addSystemMessage("no conversation to fork.", palette.noticeWarn);
      return;
    }

    this.addSystemMessage("summarizing session...", palette.noticeSuccess);
    this.isStreaming = true;
    this.footer.startWorkingIcon();

    try {
      const summary = await this.generateSummary(history);
      this.applySessionContext(summary);

      this.addSystemMessage(
        "session forked. previous context has been summarized.",
        palette.noticeSuccess,
      );
    } catch (err) {
      this.addSystemMessage(`fork failed: ${(err as Error).message}`, palette.noticeError);
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
      this.addSystemMessage("no conversation to fork.", palette.noticeWarn);
      return;
    }

    this.addSystemMessage("summarizing session...", palette.noticeSuccess);
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
        palette.noticeSuccess,
      );
    } catch (err) {
      this.addSystemMessage(`fork failed: ${(err as Error).message}`, palette.noticeError);
    } finally {
      this.footer.stop();
      this.isStreaming = false;
      this.ui.requestRender();
      void this.drainQueuedUserMessages();
    }
  }

  private setRiskLevel(level: RiskLevel): void {
    const previous = this.riskLevel;
    this.riskLevel = level;
    this.engine.setRiskLevel(level);
    this.updateFooter();

    if (previous !== level) {
      this.pendingRiskLevelChange = { from: previous, to: level };
    }

    const details = getRiskLevelDescription(level);
    this.addSystemMessage(`risk level set to '${level}': ${details}`, palette.noticeSuccess);
  }

  private switchPersona(id: string): void {
    const persona = this.personas.find((p) => p.id.toLowerCase() === id.toLowerCase());

    if (!persona) {
      this.addSystemMessage(`unknown persona '${id}'.`, palette.noticeError);
      return;
    }

    this.currentPersona = persona;
    this.clampPersonaReasoning(this.currentPersona);
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
        palette.noticeWarn,
      );
    }

    this.addSystemMessage(
      `switched to ${persona.label} (${persona.model.id})`,
      palette.noticeSuccess,
    );
  }

  private insertPrompt(id: string): void {
    const prompt = this.prompts.find((p) => p.id.toLowerCase() === id.toLowerCase());
    if (!prompt) {
      this.addSystemMessage(`unknown prompt '${id}'.`, palette.noticeError);
      return;
    }
    this.editor.setText(prompt.template);
    this.ui.requestRender();
  }

  private async runSavedBashCommand(id: string): Promise<void> {
    const saved = this.bashCommands.find((b) => b.id.toLowerCase() === id.toLowerCase());
    if (!saved) {
      this.addSystemMessage(`unknown bash command '${id}'.`, palette.noticeError);
      return;
    }

    await this.runBashCommand(saved.cmd, { cwd: this.repoRoot });
  }

  private async reloadContent(): Promise<void> {
    if (this.isStreaming) {
      this.addSystemMessage(
        "cannot reload while streaming. try again after the response.",
        palette.noticeWarn,
      );
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
          palette.noticeWarn,
        );
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
          palette.noticeWarn,
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

      this.addSystemMessage(summary, palette.noticeSuccess);
      this.ui.requestRender();
    } catch (err) {
      this.addSystemMessage(`reload failed: ${(err as Error).message}`, palette.noticeError);
    }
  }

  // Assistant Turn --------------------------------------------------------------------------------

  private async runAssistantTurn(): Promise<void> {
    this.isStreaming = true;
    this.currentTurnAbort = new AbortController();
    this.footer.startWorkingIcon();

    try {
      let currentAssistant: { component: AssistantMessageComponent; inserted: boolean } | undefined;

      const ensureCurrentAssistant = (): {
        component: AssistantMessageComponent;
        inserted: boolean;
      } => {
        if (currentAssistant) return currentAssistant;
        currentAssistant = {
          component: new AssistantMessageComponent(undefined, this.showThinking),
          inserted: false,
        };
        return currentAssistant;
      };

      const ensureAssistantInserted = () => {
        const state = ensureCurrentAssistant();
        if (state.inserted) return;
        state.inserted = true;
        this.addAssistantComponent(state.component);
        state.component.setThinkingVisibility(this.showThinking);
      };

      for await (const event of this.engine.processTurn(this.currentTurnAbort.signal)) {
        if (this.currentTurnAbort.signal.aborted) break;

        switch (event.type) {
          case "assistant_start":
            currentAssistant = {
              component: new AssistantMessageComponent(undefined, this.showThinking),
              inserted: false,
            };
            break;

          case "assistant_partial": {
            const state = ensureCurrentAssistant();
            const { snapshot } = event;

            const shouldInsert =
              snapshot.hasTextStarted || (this.showThinking && snapshot.hasAnyThinking);
            if (shouldInsert && !state.inserted) {
              ensureAssistantInserted();
            }

            if (state.inserted) {
              // Capture visibility state before update
              const wasVisible = state.component.hasVisibleText;

              state.component.updatePartial(
                snapshot.hasTextStarted ? snapshot.text : "",
                snapshot.thinking,
              );

              // If component became visible (e.g. text started after thoughts were hidden),
              // rebuild the container to show it
              if (!wasVisible && state.component.hasVisibleText) {
                this.chatContainer.rebuild();
              }

              this.ui.requestRender();
            }
            break;
          }

          case "assistant_final": {
            ensureAssistantInserted();
            ensureCurrentAssistant().component.updateFromMessage(event.message);
            this.chatContainer.rebuild();
            this.updateFooter();
            this.ui.requestRender();
            currentAssistant = undefined;
            break;
          }

          case "tool_ui": {
            const uiEvent = event.uiEvent;
            if (uiEvent.type === "bash_started") {
              this.chatContainer.addToolMessage(
                (compact) => renderBashRunning(uiEvent.command, compact),
                uiEvent.toolCallId,
              );
              this.runningBashComponents.set(uiEvent.toolCallId, {
                command: uiEvent.command,
              });
              this.ui.requestRender();
            } else if (uiEvent.type === "bash_execution") {
              const running = this.runningBashComponents.get(uiEvent.toolCallId);
              this.chatContainer.replaceToolMessage(uiEvent.toolCallId, (compact) =>
                renderBashExecution(
                  uiEvent.command,
                  uiEvent.exitCode,
                  uiEvent.truncationInfo,
                  compact,
                ),
              );
              if (running) {
                this.runningBashComponents.delete(uiEvent.toolCallId);
              }
              this.ui.requestRender();
            } else if (uiEvent.type === "bash_blocked") {
              if (uiEvent.toolCallId) {
                const running = this.runningBashComponents.get(uiEvent.toolCallId);
                this.chatContainer.replaceToolMessage(uiEvent.toolCallId, (compact) =>
                  renderBashBlocked(uiEvent.command, uiEvent.reason, compact),
                );
                if (running) {
                  this.runningBashComponents.delete(uiEvent.toolCallId);
                }
              } else {
                this.chatContainer.addToolMessage((compact) =>
                  renderBashBlocked(uiEvent.command, uiEvent.reason, compact),
                );
              }
              this.ui.requestRender();
            } else if (uiEvent.type === "task_started") {
              if (!this.taskEvents.has(uiEvent.toolCallId)) {
                this.taskEvents.set(uiEvent.toolCallId, []);
              }
              const kind = uiEvent.kind ?? "task";
              const subagentName = uiEvent.name.trim() || undefined;

              this.chatContainer.addToolMessage(
                (compact) =>
                  renderTaskRunning(uiEvent.title, [], 0, 0, 0, compact, { kind, subagentName }),
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

              this.chatContainer.replaceToolMessage(uiEvent.toolCallId, (compact) =>
                renderTaskRunning(
                  uiEvent.title,
                  events!,
                  uiEvent.costTotal,
                  uiEvent.turns,
                  uiEvent.toolCalls,
                  compact,
                  { kind, subagentName },
                ),
              );
              this.ui.requestRender();
            } else if (uiEvent.type === "task_finished") {
              const running = this.runningTaskComponents.get(uiEvent.toolCallId);
              const kind = uiEvent.kind ?? running?.kind ?? "task";
              const subagentName = uiEvent.name.trim() || undefined;

              this.chatContainer.replaceToolMessage(uiEvent.toolCallId, (compact) =>
                renderTaskFinished(
                  uiEvent.title,
                  uiEvent.costTotal,
                  uiEvent.turns,
                  uiEvent.toolCalls,
                  uiEvent.status,
                  uiEvent.finalOutput,
                  compact,
                  { kind, subagentName },
                ),
              );

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
                this.chatContainer.replaceToolMessage(uiEvent.toolCallId, (compact) =>
                  renderTaskBlocked(uiEvent.title, uiEvent.reason, compact, { kind, subagentName }),
                );
              } else {
                this.chatContainer.addToolMessage(
                  (compact) =>
                    renderTaskBlocked(uiEvent.title, uiEvent.reason, compact, {
                      kind,
                      subagentName,
                    }),
                  uiEvent.toolCallId,
                );
              }

              this.runningTaskComponents.delete(uiEvent.toolCallId);
              this.taskEvents.delete(uiEvent.toolCallId);
              this.ui.requestRender();
            } else if (uiEvent.type === "write_success") {
              this.chatContainer.addToolMessage((compact) =>
                renderWriteSuccess(
                  uiEvent.path,
                  uiEvent.bytes,
                  uiEvent.lines,
                  uiEvent.preview,
                  uiEvent.previewTruncation,
                  compact,
                ),
              );
              this.ui.requestRender();
            } else if (uiEvent.type === "write_blocked") {
              this.chatContainer.addToolMessage((compact) =>
                renderWriteBlocked(uiEvent.path, uiEvent.reason, compact),
              );
              this.ui.requestRender();
            } else if (uiEvent.type === "edit_success") {
              this.chatContainer.addToolMessage((compact) =>
                renderEditSuccess(
                  uiEvent.path,
                  uiEvent.oldLength,
                  uiEvent.newLength,
                  uiEvent.diff,
                  uiEvent.diffTruncation,
                  compact,
                ),
              );
              this.ui.requestRender();
            } else if (uiEvent.type === "edit_blocked") {
              this.chatContainer.addToolMessage((compact) =>
                renderEditBlocked(uiEvent.path, uiEvent.reason, compact),
              );
              this.ui.requestRender();
            } else if (uiEvent.type === "read_success") {
              this.chatContainer.addToolMessage((compact) =>
                renderReadSuccess(
                  uiEvent.path,
                  uiEvent.startLine,
                  uiEvent.endLine,
                  uiEvent.preview,
                  uiEvent.previewTruncation,
                  uiEvent.modelTruncation,
                  compact,
                ),
              );
              this.ui.requestRender();
            } else if (uiEvent.type === "read_blocked") {
              this.chatContainer.addToolMessage((compact) =>
                renderReadBlocked(uiEvent.path, uiEvent.reason, compact),
              );
              this.ui.requestRender();
            } else if (uiEvent.type === "list_success") {
              this.chatContainer.addToolMessage((compact) =>
                renderListSuccess(
                  uiEvent.path,
                  uiEvent.offset,
                  uiEvent.limit,
                  uiEvent.total,
                  uiEvent.returned,
                  uiEvent.entries,
                  compact,
                ),
              );
              this.ui.requestRender();
            } else if (uiEvent.type === "list_blocked") {
              this.chatContainer.addToolMessage((compact) =>
                renderListBlocked(uiEvent.path, uiEvent.reason, compact),
              );
              this.ui.requestRender();
            } else if (uiEvent.type === "grep_started") {
              this.chatContainer.addToolMessage(
                (compact) => renderGrepRunning(uiEvent.pattern, compact),
                uiEvent.toolCallId,
              );
              this.ui.requestRender();
            } else if (uiEvent.type === "grep_finished") {
              this.chatContainer.replaceToolMessage(uiEvent.toolCallId, (compact) =>
                renderGrepFinished(
                  uiEvent.pattern,
                  uiEvent.status,
                  uiEvent.exitCode,
                  uiEvent.stdoutPreview,
                  uiEvent.stdoutPreviewTruncation,
                  uiEvent.stderrPreview,
                  uiEvent.stderrPreviewTruncation,
                  uiEvent.captureTruncated,
                  compact,
                ),
              );
              this.ui.requestRender();
            } else if (uiEvent.type === "grep_blocked") {
              this.chatContainer.addToolMessage(
                (compact) => renderGrepBlocked(uiEvent.pattern, uiEvent.reason, compact),
                uiEvent.toolCallId,
              );
              this.ui.requestRender();
            }
            break;
          }

          case "notice": {
            const style =
              event.severity === "error"
                ? palette.noticeError
                : event.severity === "warn"
                  ? palette.noticeWarn
                  : palette.noticeSuccess;
            this.addSystemMessage(event.text, style);
            break;
          }

          case "tool_result":
            break;
        }
      }
    } catch (err) {
      this.addSystemMessage(`error: ${(err as Error).message}`, palette.noticeError);
    } finally {
      const wasAborted = this.currentTurnAbort?.signal.aborted ?? false;
      const reason = wasAborted ? "aborted" : "interrupted";

      for (const [id, running] of this.runningBashComponents.entries()) {
        this.chatContainer.replaceToolMessage(id, (compact) =>
          renderBashAborted(running.command, reason, compact),
        );
      }

      const taskStatus = wasAborted ? "aborted" : "error";
      for (const [id, running] of this.runningTaskComponents.entries()) {
        this.chatContainer.replaceToolMessage(id, (compact) =>
          renderTaskFinished(
            running.title,
            running.costTotal,
            running.turns,
            running.toolCalls,
            taskStatus,
            reason,
            compact,
            { kind: running.kind, subagentName: running.name },
          ),
        );
      }

      this.footer.stop();
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

  private async runBashCommand(command: string, opts?: { cwd?: string }): Promise<void> {
    this.isStreaming = true;

    try {
      const {
        stdout,
        stderr,
        exitCode,
        truncated: captureTruncated,
      } = await executeBashTool(command, { cwd: opts?.cwd });
      const truncationInfo = prepareBashOutput(stdout, stderr, captureTruncated, {
        stdout: { maxLines: BASH_USER_MAX_STDOUT_LINES, maxTokens: BASH_USER_MAX_STDOUT_TOKENS },
        stderr: { maxLines: BASH_USER_MAX_STDERR_LINES, maxTokens: BASH_USER_MAX_STDERR_TOKENS },
      });

      this.chatContainer.addMessage(renderBashExecution(command, exitCode, truncationInfo, false));

      this.engine.addUserText(formatBashUserMessageText({ command, truncationInfo }));

      this.ui.requestRender();
    } catch (err) {
      this.addSystemMessage(`bash error: ${(err as Error).message}`, palette.noticeError);
    } finally {
      this.isStreaming = false;
      this.ui.requestRender();
      void this.drainQueuedUserMessages();
    }
  }

  // File Expansion (ctrl+f) -----------------------------------------------------------------------

  private shellQuote(path: string): string {
    // Wrap in single quotes and escape any single quotes within the path
    return `'${path.replace(/'/g, "'\\''")}'`;
  }

  private async expandFileMentions(): Promise<void> {
    if (this.isStreaming) {
      this.addSystemMessage(
        "cannot expand files while streaming. try again after the response.",
        palette.noticeWarn,
      );
      return;
    }

    const editorText = this.editor.getText();

    // Extract @path tokens
    const tokenRegex = /@([^\s]+)/g;
    const tokens: string[] = [];
    let match: RegExpExecArray | null = null;
    // biome-ignore lint/suspicious/noAssignInExpressions: regex iteration pattern
    while ((match = tokenRegex.exec(editorText)) !== null) {
      tokens.push(match[1]!);
    }

    if (tokens.length === 0) {
      return;
    }

    // Filter to only valid project files and de-duplicate
    const projectFilesSet = new Set(this.projectFiles);
    const filesToExpand: string[] = [];

    for (const token of tokens) {
      // Strip trailing punctuation to handle cases like "@src/app.ts," or "(see @README.md)"
      const cleanToken = token.replace(/[.,;:)}\]]+$/, "");
      if (projectFilesSet.has(cleanToken) && !this.expandedFilesInCurrentPrompt.has(cleanToken)) {
        filesToExpand.push(cleanToken);
      }
    }

    if (filesToExpand.length === 0) {
      return;
    }

    // Run bash commands sequentially for each file
    for (const filePath of filesToExpand) {
      const quotedPath = this.shellQuote(filePath);
      // Format: blank line before header, header, content, blank line after
      // Ensure trailing newline so multiple files don't run together
      // Use -- to prevent cat from interpreting filenames starting with - as options
      const command = `printf '\\n===== %s =====\\n' ${quotedPath}; cat -- ${quotedPath}; printf '\\n'`;
      await this.runBashCommand(command);
      // Track this file as expanded in the current prompt
      this.expandedFilesInCurrentPrompt.add(filePath);
    }
  }
}
