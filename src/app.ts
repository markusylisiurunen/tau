import { homedir } from "node:os";
import type { AssistantMessage, ReasoningEffort } from "@mariozechner/pi-ai";
import { Spacer, Text, TUI } from "@mariozechner/pi-tui";
import { copyTextToClipboard } from "./clipboard.js";
import { buildHelpText, getToolLevelDescription, parseCommand } from "./commands.js";
import { getPersonaById } from "./personas.js";
import type { PromptTemplate } from "./prompts.js";
import { SessionEngine } from "./session/session_engine.js";
import { createAppTerminal } from "./terminal.js";
import {
  createBashToolDefinition,
  executeBashTool,
  formatBashUserMessageText,
  prepareBashOutput,
} from "./tools/bash.js";
import { ToolRegistry } from "./tools/registry.js";
import { type Persona, REASONING_LEVELS_WITH_NONE, type ToolAccessLevel } from "./types.js";
import { AssistantMessageComponent } from "./ui/assistant_message.js";
import { BashBlockedComponent, BashExecutionComponent } from "./ui/bash_execution.js";
import { ChatContainerComponent } from "./ui/chat_container.js";
import { CustomEditor } from "./ui/custom_editor.js";
import { FooterComponent } from "./ui/footer.js";
import { SlashAutocompleteProvider } from "./ui/slash_autocomplete.js";
import { SystemMessageComponent } from "./ui/system_message.js";
import { editorBorderForReasoning, theme } from "./ui/theme.js";
import { UserMessageComponent } from "./ui/user_message.js";
import {
  buildBaseSystemPrompt,
  buildEnvironmentTag,
  buildProjectContextBlock,
  findAgentsFilesFromCwdToHome,
  formatToolAccessChangeNotice,
} from "./utils/context.js";
import { formatAdaptiveNumber, formatCwd, formatTokenWindow } from "./utils/format.js";
import { extractAssistantText } from "./utils/messages.js";
import { listProjectFiles } from "./utils/project_files.js";

const { palette } = theme;

export interface ChatAppOptions {
  personas: Persona[];
  prompts?: PromptTemplate[];
  initialPersonaId?: string;
  initialUserMessage?: string;
  initialToolAccessLevel?: ToolAccessLevel;
  noContext?: boolean;
}

export class ChatApp {
  private ui: TUI;
  private chatContainer: ChatContainerComponent;
  private footer: FooterComponent;
  private editor: CustomEditor;

  private personas: Persona[];
  private currentPersona: Persona;
  private prompts: PromptTemplate[];
  private initialUserMessage?: string;

  private assistantComponents: AssistantMessageComponent[] = [];
  private readonly engine: SessionEngine;

  private isStreaming = false;
  private isBashMode = false;
  private showThinking = false;
  private currentTurnAbort?: AbortController;
  private toolAccessLevel: ToolAccessLevel = "read";
  private readonly initialToolAccessLevel: ToolAccessLevel;
  private readonly environmentTag: string;
  private readonly projectContextBlock?: string;
  private readonly projectFiles: string[];
  private readonly agentsFiles: string[];
  private baseSystemPrompt: string;
  private pendingToolAccessChange?: { from: ToolAccessLevel; to: ToolAccessLevel };

  constructor(options: ChatAppOptions) {
    this.personas = options.personas;
    this.prompts = options.prompts ?? [];
    this.initialUserMessage = options.initialUserMessage;

    if (options.initialToolAccessLevel) {
      this.toolAccessLevel = options.initialToolAccessLevel;
    }
    this.initialToolAccessLevel = this.toolAccessLevel;

    this.environmentTag = buildEnvironmentTag({
      toolAccessLevel: this.initialToolAccessLevel,
      cwd: process.cwd(),
      datetime: new Date().toISOString(),
    });

    this.agentsFiles = options.noContext
      ? []
      : findAgentsFilesFromCwdToHome(process.cwd(), homedir());

    this.projectContextBlock = options.noContext
      ? undefined
      : buildProjectContextBlock({ cwd: process.cwd(), home: homedir() });

    this.projectFiles = listProjectFiles(process.cwd());

    this.currentPersona =
      (options.initialPersonaId && getPersonaById(options.initialPersonaId)) || this.personas[0]!;
    this.clampPersonaReasoning(this.currentPersona);

    this.baseSystemPrompt = buildBaseSystemPrompt({
      personaSystemPrompt: this.currentPersona.systemPrompt,
      projectContextBlock: this.projectContextBlock,
      environmentTag: this.environmentTag,
    });

    const toolRegistry = new ToolRegistry([createBashToolDefinition()]);
    this.engine = new SessionEngine({
      persona: this.currentPersona,
      baseSystemPrompt: this.baseSystemPrompt,
      toolAccessLevel: this.toolAccessLevel,
      toolRegistry,
    });

    this.ui = new TUI(createAppTerminal(Boolean(this.initialUserMessage)));
    this.chatContainer = new ChatContainerComponent();
    this.footer = new FooterComponent(this.ui);
    this.editor = new CustomEditor(theme.editorTheme);

    this.setupUI();
    this.setupEditor();
  }

  private setupUI(): void {
    this.ui.addChild(this.chatContainer);
    this.ui.addChild(new Spacer(1));
    this.ui.addChild(this.editor);
    this.ui.addChild(this.footer);

    const headerText =
      `\n${palette.accent("tau")} ${palette.muted("– terminal chat")}\n\n` +
      palette.muted(buildHelpText(this.agentsFiles));
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
    this.editor.onShiftTab = () => this.cycleReasoningLevel();
    this.editor.onEscape = () => this.interruptAssistantTurn();

    this.editor.onChange = (text: string) => {
      const wasBash = this.isBashMode;
      this.isBashMode = text.trimStart().startsWith("!");
      if (wasBash !== this.isBashMode) {
        this.updateEditorBorderColor();
      }
    };

    this.editor.setAutocompleteProvider(
      new SlashAutocompleteProvider(
        () => this.personas.map((p) => ({ id: p.id, label: p.label })),
        () => this.prompts.map((t) => ({ id: t.id, label: t.label })),
        () => this.projectFiles,
      ),
    );

    this.editor.onSubmit = (text) => this.handleSubmit(text);
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
    const toolLabel = this.formatToolAccessLabel();
    const contextUsage = this.getContextUsageString();
    const sessionCost = this.getSessionCostString();
    const cwd = formatCwd(process.cwd());

    const left = `${cwd} · ${contextUsage} · ${sessionCost}`;
    const personaName = this.currentPersona.label || this.currentPersona.id;
    const right = `${personaName} · ${this.currentPersona.model.id} (${reasoningLabel}) · ${toolLabel}`;

    this.footer.setLeftRight(left, right);
    this.ui.requestRender();
  }

  private formatToolAccessLabel(): string {
    switch (this.toolAccessLevel) {
      case "none":
        return "none";
      case "read":
        return palette.accessRead("read");
      case "all":
        return palette.accessAll("all");
    }
  }

  private updateEditorBorderColor(): void {
    if (this.isBashMode) {
      this.editor.borderColor = (s: string) => palette.bash(s);
    } else {
      this.editor.borderColor = editorBorderForReasoning(this.currentPersona.settings.reasoning);
    }
    this.ui.requestRender();
  }

  private addSystemMessage(text: string, styleFn?: (t: string) => string): void {
    this.chatContainer.addMessage(new SystemMessageComponent(text, styleFn));
    this.ui.requestRender();
  }

  private addUserMessage(text: string): void {
    this.chatContainer.addMessage(new UserMessageComponent(text));
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
    const cacheStats = `R${formatTokenWindow(read)} W${formatTokenWindow(write)}`;

    if (!last) {
      return `${cacheStats} 0%/${formatTokenWindow(windowTokens)}`;
    }

    const promptTokensSent =
      (last.usage?.input ?? 0) + (last.usage?.cacheRead ?? 0) + (last.usage?.cacheWrite ?? 0);
    const percent = windowTokens > 0 ? (promptTokensSent / windowTokens) * 100 : 0;
    const percentStr = `${formatAdaptiveNumber(percent, 1, 3)}%`;

    return `${cacheStats} ${percentStr}/${formatTokenWindow(windowTokens)}`;
  }

  private getSessionCostString(): string {
    let total = 0;
    for (const m of this.engine.history) {
      if (m.role === "assistant") {
        total += (m as AssistantMessage).usage?.cost?.total ?? 0;
      }
    }
    return `$${formatAdaptiveNumber(total, 2, 5)}`;
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
    const current = this.currentPersona.settings.reasoning;
    const index = allowed.indexOf(current);
    const next = allowed[(index + 1) % allowed.length];
    this.currentPersona.settings.reasoning = next;
    this.updateFooter();
    this.updateEditorBorderColor();
  }

  private getAllowedReasoningLevels(persona: Persona): Array<ReasoningEffort | undefined> {
    if (!persona.model.reasoning) {
      return [undefined];
    }

    const raw = persona.allowedReasoningLevels;
    if (!raw || raw.length === 0) {
      return REASONING_LEVELS_WITH_NONE;
    }

    const normalized: Array<ReasoningEffort | undefined> = [];
    for (const level of raw) {
      if (level === "none") {
        normalized.push(undefined);
      } else if (REASONING_LEVELS_WITH_NONE.includes(level as ReasoningEffort)) {
        normalized.push(level as ReasoningEffort);
      }
    }

    const unique = [...new Set(normalized)];
    return unique.length ? unique : REASONING_LEVELS_WITH_NONE;
  }

  private clampPersonaReasoning(persona: Persona): void {
    const allowed = this.getAllowedReasoningLevels(persona);
    if (!allowed.includes(persona.settings.reasoning)) {
      persona.settings.reasoning = allowed[0];
    }
  }

  // User Actions ----------------------------------------------------------------------------------

  private toggleThinkingVisibility(): void {
    this.showThinking = !this.showThinking;
    this.assistantComponents.forEach((c) => {
      c.setThinkingVisibility(this.showThinking);
    });
    const message = this.showThinking
      ? "thoughts visible (ctrl+t to hide)"
      : "thoughts hidden (ctrl+t to show)";
    this.addSystemMessage(message, palette.muted);
    this.ui.requestRender();
  }

  private interruptAssistantTurn(): void {
    if (!this.isStreaming || this.currentTurnAbort?.signal.aborted) return;
    this.currentTurnAbort?.abort();
    this.addSystemMessage("interrupted.", palette.muted);
    this.ui.requestRender();
  }

  // Input Handling --------------------------------------------------------------------------------

  private async handleSubmit(text: string): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed || this.isStreaming) return;

    if (trimmed.startsWith("/")) {
      await this.handleCommand(trimmed);
      return;
    }

    if (trimmed.startsWith("!")) {
      const command = trimmed.slice(1).trim();
      if (command) await this.runBashCommand(command);
      return;
    }

    await this.sendUserMessage(trimmed);
  }

  private async sendUserMessage(text: string): Promise<void> {
    this.addUserMessage(text);

    const systemNotice = this.pendingToolAccessChange
      ? formatToolAccessChangeNotice(this.pendingToolAccessChange)
      : undefined;
    this.pendingToolAccessChange = undefined;

    const textForModel = systemNotice ? `${systemNotice}\n\n${text}` : text;
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

      case "new":
        this.clearSession();
        break;

      case "tool":
        this.setToolAccessLevel(cmd.level);
        break;

      case "persona":
        this.switchPersona(cmd.id);
        break;

      case "prompt":
        this.insertPrompt(cmd.id);
        break;

      case "unknown":
        this.addSystemMessage("unknown command. type /help.");
        break;
    }
  }

  private showHelp(): void {
    this.addSystemMessage(buildHelpText(this.agentsFiles));
  }

  private async copyLastAssistantMessage(): Promise<void> {
    const lastAssistant = this.getLastAssistantMessage();
    if (!lastAssistant) {
      this.addSystemMessage("no assistant message to copy yet.");
      return;
    }

    const text = extractAssistantText(lastAssistant);
    if (!text.trim()) {
      this.addSystemMessage("last assistant message was empty.");
      return;
    }

    try {
      await copyTextToClipboard(text);
      this.addSystemMessage("copied last assistant message to clipboard.", palette.success);
    } catch (err) {
      this.addSystemMessage(`clipboard copy failed: ${(err as Error).message}`, palette.error);
    }
  }

  private clearSession(): void {
    this.engine.reset();
    this.assistantComponents = [];
    this.chatContainer.clear();
    this.isBashMode = false;
    this.updateEditorBorderColor();
    this.updateFooter();
    this.ui.requestRender();
  }

  private setToolAccessLevel(level: ToolAccessLevel): void {
    const previous = this.toolAccessLevel;
    this.toolAccessLevel = level;
    this.engine.setToolAccessLevel(level);
    this.updateFooter();

    if (previous !== level) {
      this.pendingToolAccessChange = { from: previous, to: level };
    }

    const details = getToolLevelDescription(level);
    this.addSystemMessage(`tool access set to '${level}': ${details}`, palette.systemLabel);
  }

  private switchPersona(id: string): void {
    const persona =
      getPersonaById(id) ?? this.personas.find((p) => p.id.toLowerCase() === id.toLowerCase());

    if (!persona) {
      this.addSystemMessage(`unknown persona '${id}'.`);
      return;
    }

    this.currentPersona = persona;
    this.clampPersonaReasoning(this.currentPersona);
    this.baseSystemPrompt = buildBaseSystemPrompt({
      personaSystemPrompt: this.currentPersona.systemPrompt,
      projectContextBlock: this.projectContextBlock,
      environmentTag: this.environmentTag,
    });
    this.engine.setPersona(this.currentPersona, this.baseSystemPrompt);
    this.updateFooter();
    this.updateEditorBorderColor();
    this.addSystemMessage(
      `switched to ${theme.formatPersonaLabel(persona.label, persona.model.id)}`,
    );
  }

  private insertPrompt(id: string): void {
    const prompt = this.prompts.find((p) => p.id.toLowerCase() === id.toLowerCase());
    if (!prompt) {
      this.addSystemMessage(`unknown prompt '${id}'.`);
      return;
    }
    this.editor.setText(prompt.template);
    this.ui.requestRender();
  }

  // Assistant Turn --------------------------------------------------------------------------------

  private async runAssistantTurn(): Promise<void> {
    this.isStreaming = true;
    this.editor.disableSubmit = true;
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
              state.component.updatePartial(
                snapshot.hasTextStarted ? snapshot.text : "",
                snapshot.thinking,
              );
              this.ui.requestRender();
            }
            break;
          }

          case "assistant_final": {
            ensureAssistantInserted();
            ensureCurrentAssistant().component.updateFromMessage(event.message);
            this.updateFooter();
            this.ui.requestRender();
            currentAssistant = undefined;
            break;
          }

          case "tool_ui": {
            const uiEvent = event.uiEvent;
            if (uiEvent.type === "bash_execution") {
              this.chatContainer.addMessage(
                new BashExecutionComponent(
                  uiEvent.command,
                  uiEvent.exitCode,
                  uiEvent.truncationInfo,
                ),
              );
              this.ui.requestRender();
            } else if (uiEvent.type === "bash_blocked") {
              this.chatContainer.addMessage(
                new BashBlockedComponent(uiEvent.command, uiEvent.reason),
              );
              this.ui.requestRender();
            }
            break;
          }

          case "notice": {
            const style =
              event.severity === "error"
                ? palette.error
                : event.severity === "warn"
                  ? palette.warn
                  : palette.muted;
            this.addSystemMessage(event.text, style);
            break;
          }

          case "tool_result":
            break;
        }
      }
    } catch (err) {
      this.addSystemMessage(`error: ${(err as Error).message}`, palette.error);
    } finally {
      this.footer.stop();
      this.isStreaming = false;
      this.editor.disableSubmit = false;
      this.currentTurnAbort = undefined;
      this.ui.requestRender();
    }
  }

  // Direct Bash Execution (user ! commands) -------------------------------------------------------

  private async runBashCommand(command: string): Promise<void> {
    this.isStreaming = true;
    this.editor.disableSubmit = true;

    try {
      const {
        stdout,
        stderr,
        exitCode,
        truncated: captureTruncated,
      } = await executeBashTool(command);
      const truncationInfo = prepareBashOutput(stdout, stderr, captureTruncated);

      this.chatContainer.addMessage(new BashExecutionComponent(command, exitCode, truncationInfo));

      this.engine.addUserText(formatBashUserMessageText({ command, truncationInfo }));

      this.ui.requestRender();
    } catch (err) {
      this.addSystemMessage(`bash error: ${(err as Error).message}`, palette.error);
    } finally {
      this.isStreaming = false;
      this.editor.disableSubmit = false;
      this.ui.requestRender();
    }
  }
}
