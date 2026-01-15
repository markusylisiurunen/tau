import type { AutocompleteProvider } from "@mariozechner/pi-tui";
import { Spacer, TUI } from "@mariozechner/pi-tui";
import type { ToolUiEvent } from "../core/tools/registry.js";
import type { ReasoningEffort, RiskLevel } from "../core/types.js";
import { createAppTerminal } from "./terminal.js";
import { ToolUiRouter } from "./tool_ui_router.js";
import { buildBashExecutionView } from "./ui/bash_execution.js";
import { ChatContainerComponent } from "./ui/chat_container.js";
import type { AssistantMessageModel, ChatMessageModel } from "./ui/chat_message_model.js";
import { CustomEditor } from "./ui/custom_editor.js";
import { FooterComponent } from "./ui/footer.js";
import { QueuedMessagesComponent } from "./ui/queued_messages.js";
import type { SystemMessageKind } from "./ui/system_message.js";
import { createUiTheme, type Theme } from "./ui/theme/index.js";
import { buildThemePreviewMessages } from "./ui/theme/index.js";
import type { BashTruncationInfo } from "../core/tools/bash.js";

export type ChatInputMode = "normal" | "bash" | "memory";

export type ChatViewStatus = {
  footer: {
    contextUsage: string;
    sessionCost: string;
    duration: string;
    riskLevel: RiskLevel;
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
  addSystemMessage(text: string, kind: SystemMessageKind): void;
  setThinkingVisibility(show: boolean): void;
  setCompactToolUi(compact: boolean): void;
  updateStatus(status: ChatViewStatus): void;
  startWorkingIcon(): void;
  stopWorkingIcon(): void;
  handleToolUiEvent(event: ToolUiEvent): void;
  resetToolUiSession(): void;
  finalizeToolUiPending(reason: "aborted" | "interrupted"): void;
  clearToolUiTransientState(): void;
  getToolUiCostTotal(): number;
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
    durationMs?: number;
    labelOverride?: string;
    compactHeadLines?: number;
    compactTailLines?: number;
  }): void;
}

export class TuiChatView implements ChatView {
  private ui: TUI;
  private chatContainer: ChatContainerComponent;
  private footer: FooterComponent;
  private queuedMessages: QueuedMessagesComponent;
  private editor: CustomEditor;
  private uiTheme: Theme;
  private toolUiRouter: ToolUiRouter;
  private themePreview: boolean;

  constructor(options: {
    queuedUserMessages: string[];
    compactToolUi: boolean;
    showThinking: boolean;
    themePreview: boolean;
  }) {
    this.themePreview = options.themePreview;
    this.uiTheme = createUiTheme("ansi");
    this.ui = new TUI(createAppTerminal());
    this.chatContainer = new ChatContainerComponent(this.uiTheme, options.showThinking);
    this.chatContainer.setCompactToolUi(options.compactToolUi);
    this.footer = new FooterComponent(this.uiTheme, this.ui);
    this.queuedMessages = new QueuedMessagesComponent(this.uiTheme, options.queuedUserMessages);
    this.editor = new CustomEditor(this.uiTheme);
    this.toolUiRouter = new ToolUiRouter({
      theme: this.uiTheme,
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

  addSystemMessage(text: string, kind: SystemMessageKind): void {
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

  setThinkingVisibility(show: boolean): void {
    this.chatContainer.setThinkingVisibility(show);
    this.ui.requestRender();
  }

  setCompactToolUi(compact: boolean): void {
    this.chatContainer.setCompactToolUi(compact);
    this.ui.requestRender();
  }

  updateStatus(status: ChatViewStatus): void {
    this.footer.setStatus({
      contextUsage: status.footer.contextUsage,
      sessionCost: status.footer.sessionCost,
      duration: status.footer.duration,
      riskLevel: status.footer.riskLevel,
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

  resetToolUiSession(): void {
    this.toolUiRouter.resetSession();
  }

  finalizeToolUiPending(reason: "aborted" | "interrupted"): void {
    this.toolUiRouter.finalizePending(reason);
  }

  clearToolUiTransientState(): void {
    this.toolUiRouter.clearTransientState();
  }

  getToolUiCostTotal(): number {
    return this.toolUiRouter.getSubagentCostTotal();
  }

  sendTerminalNotification(title: string): void {
    if (!process.stdout.isTTY) return;
    this.ui.terminal.write(`\x1b]9;${title}\x1b\\`);
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
    durationMs?: number;
    labelOverride?: string;
    compactHeadLines?: number;
    compactTailLines?: number;
  }): void {
    this.chatContainer.addMessage({
      type: "tool",
      view: buildBashExecutionView(
        this.uiTheme,
        args.command,
        args.exitCode,
        args.truncationInfo,
        args.durationMs,
        args.labelOverride,
        args.compactHeadLines,
        args.compactTailLines,
      ),
    });
    this.ui.requestRender();
  }

  private setupUi(): void {
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
    }

    this.ui.setFocus(this.editor);
  }

  private updateEditorVisualState(state: ChatViewStatus["editor"]): void {
    const { palette } = this.uiTheme;
    if (state.mode === "bash") {
      this.editor.borderColor = (s: string) => palette.modeBash(s);
    } else if (state.mode === "memory") {
      this.editor.borderColor = (s: string) => palette.modeMemory(s);
    } else {
      this.editor.borderColor = this.uiTheme.editorBorderForReasoning(state.reasoning);
    }

    if (this.themePreview) {
      const labelStyle = this.uiTheme.palette.textMuted;
      this.editor.setHeader("theme preview", "model disabled", {
        leftStyle: labelStyle,
        rightStyle: labelStyle,
      });
      return;
    }

    if (state.mode === "bash") {
      this.editor.setHeader("bash", "", { leftStyle: this.editor.borderColor });
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
