import type { AutocompleteProvider } from "@mariozechner/pi-tui";
import { Spacer, TUI } from "@mariozechner/pi-tui";
import type { ThemeDefinition } from "../core/config/index.js";
import type { SubagentUiEvent } from "../core/subagents/types.js";
import type { BashTruncationInfo } from "../core/tools/bash.js";
import type { ToolUiEvent, ToolUiText } from "../core/tools/registry.js";
import type { ReasoningEffort, RiskLevel } from "../core/types.js";
import { createAppTerminal } from "./terminal.js";
import { ToolUiRouter } from "./tool_ui_router.js";
import { ChatContainerComponent } from "./ui/chat_container.js";
import type { AssistantMessageModel, ChatMessageModel } from "./ui/chat_message_model.js";
import { CustomEditor } from "./ui/custom_editor.js";
import { FooterComponent } from "./ui/footer.js";
import { QueuedMessagesComponent } from "./ui/queued_messages.js";
import { SubagentEditorPaneComponent } from "./ui/subagent_editor_pane.js";
import { SubagentPanelComponent } from "./ui/subagent_panel.js";
import type { SystemMessageKind } from "./ui/system_message.js";
import { coercePaletteOverrides, createUiTheme, type Theme } from "./ui/theme/index.js";
import { createToolUiRegistry } from "./ui/tool_ui_registry.js";

export type ChatInputMode = "normal" | "bash" | "bash_incognito" | "memory";

export type ChatViewStatus = {
  footer: {
    contextUsage: string;
    sessionCost: string;
    duration: string;
    riskLevel: RiskLevel;
    sandboxed?: boolean;
  };
  editor: {
    mode: ChatInputMode;
    cwdLabel: string;
    personaName: string;
    reasoningLabel: string;
    reasoning?: ReasoningEffort;
  };
};

export type ChatViewInputHandlers = {
  onCtrlC?: () => void;
  onCtrlT?: () => void;
  onCtrlO?: () => void;
  onShiftTab?: () => void;
  onCtrlR?: () => void;
  onCtrlP?: () => void;
  onCtrlS?: () => void;
  onEscape?: () => void;
  onCtrlF?: () => void;
  onAltUp?: () => void;
  onAltDown?: () => void;
  onCtrlG?: () => void;
  beforeSubmit?: (text: string) => boolean;
  onChange?: (text: string) => void;
  onSubmit?: (text: string) => void;
};

export interface ChatView {
  start(): void;
  stop(): void;
  requestRender(): void;
  addMessage(model: ChatMessageModel, id?: string): string;
  updateAssistantMessage(id: string, model: AssistantMessageModel): void;
  addSystemMessage(
    text: string,
    kind: SystemMessageKind,
    options?: { toastDurationMs?: number; persist?: boolean },
  ): void;
  setThinkingVisibility(show: boolean): void;
  setCompactToolUi(compact: boolean): void;
  updateStatus(status: ChatViewStatus): void;
  startWorkingIcon(): void;
  stopWorkingIcon(): void;
  handleToolUiEvent(event: ToolUiEvent): void;
  handleSubagentEvent(event: SubagentUiEvent): void;
  resetToolUiSession(): void;
  finalizeToolUiPending(reason: "aborted" | "interrupted"): void;
  clearToolUiTransientState(): void;
  getToolUiCostTotal(): number;
  cycleSubagentSelection(direction: 1 | -1): string | undefined;
  getSelectedSubagentId(): string | undefined;
  sendTerminalNotification(title: string): void;
  getEditorText(): string;
  setEditorText(text: string): void;
  getEditorCursor(): { line: number; col: number };
  getEditorLines(): string[];
  bindInputHandlers(handlers: ChatViewInputHandlers): void;
  setAutocompleteProvider(provider: AutocompleteProvider): void;
  addBashExecutionMessage(args: {
    command: string;
    exitCode: number | null;
    truncationInfo: BashTruncationInfo;
    uiText: ToolUiText;
    durationMs?: number;
    labelOverride?: string;
  }): void;
  updateTheme(options: { themeId?: string; themes?: ThemeDefinition[] }): void;
}

function resolveThemeTokens(
  themeId: string | undefined,
  themes: ThemeDefinition[] | undefined,
): Record<string, string> | undefined {
  if (!themeId || !themes || themes.length === 0) {
    return undefined;
  }
  const match = themes.find((theme) => theme.id.toLowerCase() === themeId.toLowerCase());
  return match?.tokens;
}

export class TuiChatView implements ChatView {
  private ui: TUI;
  private chatContainer: ChatContainerComponent;
  private footer: FooterComponent;
  private queuedMessages: QueuedMessagesComponent;
  private subagentPanel: SubagentPanelComponent;
  private editor: CustomEditor;
  private editorPane: SubagentEditorPaneComponent;
  private uiTheme: Theme;
  private toolUiRegistry = createToolUiRegistry();
  private toolUiRouter: ToolUiRouter;
  private lastStatus?: ChatViewStatus;

  constructor(options: {
    queuedUserMessages: string[];
    compactToolUi: boolean;
    showThinking: boolean;
    themeId?: string;
    themes?: ThemeDefinition[];
  }) {
    const themeTokens = resolveThemeTokens(options.themeId, options.themes);
    const paletteOverrides = coercePaletteOverrides(themeTokens);
    this.uiTheme = createUiTheme("ansi", paletteOverrides);
    this.ui = new TUI(createAppTerminal());
    this.chatContainer = new ChatContainerComponent(
      this.uiTheme,
      this.toolUiRegistry,
      options.showThinking,
    );
    this.chatContainer.setCompactToolUi(options.compactToolUi);
    this.footer = new FooterComponent(this.uiTheme, this.ui);
    this.queuedMessages = new QueuedMessagesComponent(this.uiTheme, options.queuedUserMessages);
    this.subagentPanel = new SubagentPanelComponent(this.uiTheme);
    this.editor = new CustomEditor(this.uiTheme);
    this.editorPane = new SubagentEditorPaneComponent(
      this.uiTheme,
      this.subagentPanel,
      this.editor,
    );
    this.toolUiRouter = new ToolUiRouter({
      chatContainer: this.chatContainer,
      requestRender: () => this.ui.requestRender(),
    });

    this.setupUi();
  }

  start(): void {
    this.ui.start();
  }

  stop(): void {
    this.ui.stop();
    // Ensure cursor is visible after shutdown (some terminals keep it hidden).
    this.ui.terminal.showCursor();
  }

  requestRender(): void {
    this.ui.requestRender();
  }

  addMessage(model: ChatMessageModel, id?: string): string {
    const messageId = this.chatContainer.addMessage(model, id);
    this.ui.requestRender();
    return messageId;
  }

  updateAssistantMessage(id: string, model: AssistantMessageModel): void {
    this.chatContainer.updateMessage(id, model);
    this.ui.requestRender();
  }

  addSystemMessage(
    text: string,
    kind: SystemMessageKind,
    options?: { toastDurationMs?: number; persist?: boolean },
  ): void {
    const cleanedText = this.normalizeSystemMessageText(text, kind);
    const toastText = this.formatToastText(cleanedText);
    if (kind !== "muted" && toastText.length > 0) {
      this.footer.showToast(toastText, kind, options?.toastDurationMs);
    }

    const shouldPersist = options?.persist ?? this.shouldPersistSystemMessage(cleanedText, kind);
    if (shouldPersist) {
      this.chatContainer.addMessage({ type: "system", text: cleanedText, kind });
      this.ui.requestRender();
    }
  }

  setThinkingVisibility(show: boolean): void {
    this.chatContainer.setThinkingVisibility(show);
    this.ui.requestRender();
  }

  setCompactToolUi(compact: boolean): void {
    this.chatContainer.setCompactToolUi(compact);
    this.ui.requestRender();
  }

  updateStatus(status: ChatViewStatus): void {
    this.lastStatus = status;
    this.footer.setStatus({
      contextUsage: status.footer.contextUsage,
      sessionCost: status.footer.sessionCost,
      duration: status.footer.duration,
      riskLevel: status.footer.riskLevel,
      sandboxed: status.footer.sandboxed,
    });

    this.updateEditorVisualState(status.editor);
    this.ui.requestRender();
  }

  startWorkingIcon(): void {
    this.footer.startWorkingIcon();
  }

  stopWorkingIcon(): void {
    this.footer.stop();
  }

  handleToolUiEvent(event: ToolUiEvent): void {
    this.toolUiRouter.handle(event);
  }

  handleSubagentEvent(event: SubagentUiEvent): void {
    this.subagentPanel.handleEvent(event);
    this.ui.requestRender();
  }

  resetToolUiSession(): void {
    this.toolUiRouter.resetSession();
    this.subagentPanel.reset();
  }

  finalizeToolUiPending(reason: "aborted" | "interrupted"): void {
    this.toolUiRouter.finalizePending(reason);
  }

  clearToolUiTransientState(): void {
    this.toolUiRouter.clearTransientState();
  }

  getToolUiCostTotal(): number {
    return this.subagentPanel.getCostTotal();
  }

  cycleSubagentSelection(direction: 1 | -1): string | undefined {
    const selected = this.subagentPanel.cycleSelection(direction);
    this.ui.requestRender();
    return selected;
  }

  getSelectedSubagentId(): string | undefined {
    return this.subagentPanel.getSelectedId();
  }

  private sanitizeOscText(text: string): string {
    return Array.from(text)
      .filter((ch) => {
        const code = ch.codePointAt(0);
        return code !== undefined && code > 0x1f && code !== 0x7f;
      })
      .join("");
  }

  sendTerminalNotification(title: string): void {
    if (!process.stdout.isTTY) return;
    const safeTitle = this.sanitizeOscText(title);
    this.ui.terminal.write(`\x1b]9;${safeTitle}\x1b\\`);
  }

  getEditorText(): string {
    return this.editor.getText();
  }

  setEditorText(text: string): void {
    this.editor.setText(text);
    this.ui.requestRender();
  }

  getEditorCursor(): { line: number; col: number } {
    return this.editor.getCursor();
  }

  getEditorLines(): string[] {
    return this.editor.getLines();
  }

  bindInputHandlers(handlers: ChatViewInputHandlers): void {
    this.editor.onCtrlC = handlers.onCtrlC;
    this.editor.onCtrlT = handlers.onCtrlT;
    this.editor.onCtrlO = handlers.onCtrlO;
    this.editor.onShiftTab = handlers.onShiftTab;
    this.editor.onCtrlR = handlers.onCtrlR;
    this.editor.onCtrlP = handlers.onCtrlP;
    this.editor.onCtrlS = handlers.onCtrlS;
    this.editor.onEscape = handlers.onEscape;
    this.editor.onCtrlF = handlers.onCtrlF;
    this.editor.onAltUp = handlers.onAltUp;
    this.editor.onAltDown = handlers.onAltDown;
    this.editor.onCtrlG = handlers.onCtrlG;
    this.editor.beforeSubmit = handlers.beforeSubmit;
    this.editor.onChange = handlers.onChange;
    this.editor.onSubmit = handlers.onSubmit;
  }

  setAutocompleteProvider(provider: AutocompleteProvider): void {
    this.editor.setAutocompleteProvider(provider);
  }

  addBashExecutionMessage(args: {
    command: string;
    exitCode: number | null;
    truncationInfo: BashTruncationInfo;
    uiText: ToolUiText;
    durationMs?: number;
    labelOverride?: string;
  }): void {
    const toolCallId = `bash-user-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const event: ToolUiEvent = {
      type: "bash_execution",
      toolCallId,
      command: args.command,
      exitCode: args.exitCode,
      truncationInfo: args.truncationInfo,
      uiText: args.uiText,
      durationMs: args.durationMs,
      labelOverride: args.labelOverride,
    };
    this.chatContainer.addMessage({ type: "tool", event });
    this.ui.requestRender();
  }

  updateTheme(options: { themeId?: string; themes?: ThemeDefinition[] }): void {
    const themeTokens = resolveThemeTokens(options.themeId, options.themes);
    const paletteOverrides = coercePaletteOverrides(themeTokens);
    this.uiTheme = createUiTheme("ansi", paletteOverrides);

    this.chatContainer.setTheme(this.uiTheme);
    this.footer.setTheme(this.uiTheme);
    this.queuedMessages.setTheme(this.uiTheme);
    this.subagentPanel.setTheme(this.uiTheme);
    this.editor.setUiTheme(this.uiTheme);
    this.editorPane.setTheme(this.uiTheme);

    if (this.lastStatus) {
      this.updateEditorVisualState(this.lastStatus.editor);
    }

    this.ui.invalidate();
    this.ui.requestRender(true);
  }

  private setupUi(): void {
    this.ui.addChild(this.chatContainer);
    this.ui.addChild(new Spacer(1));
    this.ui.addChild(this.queuedMessages);
    this.ui.addChild(this.editorPane);
    this.ui.addChild(this.footer);

    this.ui.setFocus(this.editor);
  }

  private updateEditorVisualState(state: ChatViewStatus["editor"]): void {
    const { palette } = this.uiTheme;
    if (state.mode === "bash" || state.mode === "bash_incognito") {
      this.editor.borderColor = (s: string) => palette.modeBash(s);
    } else if (state.mode === "memory") {
      this.editor.borderColor = (s: string) => palette.modeMemory(s);
    } else {
      this.editor.borderColor = this.uiTheme.editorBorderForReasoning(state.reasoning);
    }

    if (state.mode === "bash" || state.mode === "bash_incognito") {
      const label = state.mode === "bash_incognito" ? "bash incognito" : "bash";
      this.editor.setHeader(label, "", { leftStyle: this.editor.borderColor });
      return;
    }

    if (state.mode === "memory") {
      this.editor.setHeader("memoize", "", { leftStyle: this.editor.borderColor });
      return;
    }

    this.editor.setHeader(state.cwdLabel, `${state.personaName} (${state.reasoningLabel})`);
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
}
