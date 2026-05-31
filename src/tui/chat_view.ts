import type { AutocompleteProvider, Component } from "@earendil-works/pi-tui";
import { Spacer, TUI } from "@earendil-works/pi-tui";
import {
  resolveThemeTokensById,
  type ThemeAppearance,
  type ThemeDefinition,
} from "../core/config/index.js";
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
import { RewindPickerComponent, type RewindPickerItem } from "./ui/rewind_picker.js";
import { SubagentEditorPaneComponent } from "./ui/subagent_editor_pane.js";
import { SubagentPanelComponent } from "./ui/subagent_panel.js";
import type { SystemMessageKind } from "./ui/system_message.js";
import { coercePaletteOverrides, createUiTheme, type Theme } from "./ui/theme/index.js";
import { createToolUiRegistry } from "./ui/tool_ui_registry.js";

export type ChatInputMode = "normal" | "bash" | "bash_incognito" | "memory" | "recording";

export type ChatViewStatus = {
  footer: {
    contextUsage: string;
    sessionCost: string;
    duration: string;
    riskLevel: RiskLevel;
    commandHint?: string;
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
  onCtrlY?: () => void;
  onEscape?: () => void;
  onCtrlF?: () => void;
  onAltUp?: () => void;
  onAltDown?: () => void;
  onCtrlG?: () => void;
  beforeSubmit?: (text: string) => boolean;
  onChange?: (text: string) => void;
  onSubmit?: (text: string) => void;
};

export type RewindPickerOptions = {
  items: RewindPickerItem[];
  onSelect: (id: string) => void;
  onCancel: () => void;
};

export interface ChatView {
  start(): void;
  stop(): void;
  requestRender(): void;
  removeMessages(ids: readonly string[]): void;
  removeMessagesFrom(id: string): void;
  addMessage(model: ChatMessageModel, id?: string): string;
  replaceMessage(id: string, model: ChatMessageModel): void;
  updateMessage(id: string, model: ChatMessageModel): void;
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
  resetToolUiSessionPreservingSubagents(): void;
  finalizeToolUiPending(reason: "aborted" | "interrupted"): void;
  clearToolUiTransientState(): void;
  getToolUiCostTotal(): number;
  cycleSubagentSelection(direction: 1 | -1): string | undefined;
  getSelectedSubagentId(): string | undefined;
  sendTerminalNotification(title: string): void;
  getEditorText(): string;
  getExpandedEditorText(): string;
  setEditorText(text: string): void;
  insertEditorTextAtCursor(text: string): void;
  setEditorInputEnabled(enabled: boolean): void;
  showRewindPicker(options: RewindPickerOptions): void;
  hideRewindPicker(): void;
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

export class TuiChatView implements ChatView {
  private ui: TUI;
  private chatContainer: ChatContainerComponent;
  private footer: FooterComponent;
  private queuedMessages: QueuedMessagesComponent;
  private subagentPanel: SubagentPanelComponent;
  private editor: CustomEditor;
  private editorPane: SubagentEditorPaneComponent;
  private rewindPicker?: RewindPickerComponent;
  private activeInputPane: Component;
  private uiTheme: Theme;
  private terminalAppearance: ThemeAppearance;
  private toolUiRegistry = createToolUiRegistry();
  private toolUiRouter: ToolUiRouter;
  private lastStatus?: ChatViewStatus;
  private recordingIndicatorFrame = 0;
  private recordingStartedAt?: number;
  private recordingIndicatorTimer?: ReturnType<typeof setInterval>;

  constructor(options: {
    queuedUserMessages: string[];
    compactToolUi: boolean;
    showThinking: boolean;
    terminalAppearance?: ThemeAppearance;
    themeId?: string;
    themes?: ThemeDefinition[];
  }) {
    this.terminalAppearance = options.terminalAppearance ?? "dark";
    const themeTokens = resolveThemeTokensById(
      options.themeId,
      options.themes,
      this.terminalAppearance,
    );
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
    this.editor.onUiChange = () => this.ui.requestRender();
    this.editorPane = new SubagentEditorPaneComponent(
      this.uiTheme,
      this.subagentPanel,
      this.editor,
    );
    this.activeInputPane = this.editorPane;
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
    this.setRecordingIndicatorActive(false);
    this.ui.stop();
    // Ensure cursor is visible after shutdown (some terminals keep it hidden).
    this.ui.terminal.showCursor();
  }

  requestRender(): void {
    this.ui.requestRender();
  }

  removeMessages(ids: readonly string[]): void {
    this.chatContainer.removeMessages(ids);
    this.ui.requestRender();
  }

  removeMessagesFrom(id: string): void {
    this.chatContainer.removeMessagesFrom(id);
    this.ui.requestRender();
  }

  addMessage(model: ChatMessageModel, id?: string): string {
    const messageId = this.chatContainer.addMessage(model, id);
    this.ui.requestRender();
    return messageId;
  }

  replaceMessage(id: string, model: ChatMessageModel): void {
    this.chatContainer.replaceMessage(id, model);
    this.ui.requestRender();
  }

  updateMessage(id: string, model: ChatMessageModel): void {
    this.chatContainer.updateMessage(id, model);
    this.ui.requestRender();
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
    this.setRecordingIndicatorActive(status.editor.mode === "recording");
    this.footer.setStatus({
      contextUsage: status.footer.contextUsage,
      sessionCost: status.footer.sessionCost,
      duration: status.footer.duration,
      riskLevel: status.footer.riskLevel,
      commandHint: status.footer.commandHint,
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

  resetToolUiSessionPreservingSubagents(): void {
    this.toolUiRouter.resetSession();
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

  getExpandedEditorText(): string {
    return this.editor.getExpandedText();
  }

  setEditorText(text: string): void {
    this.editor.setText(text);
    this.ui.requestRender();
  }

  insertEditorTextAtCursor(text: string): void {
    this.editor.insertTextAtCursor(text);
    this.ui.requestRender();
  }

  setEditorInputEnabled(enabled: boolean): void {
    this.editor.setInputEnabled(enabled);
    this.ui.requestRender();
  }

  showRewindPicker(options: RewindPickerOptions): void {
    const picker = new RewindPickerComponent(this.uiTheme, options.items);
    picker.onSelect = options.onSelect;
    picker.onCancel = options.onCancel;

    this.rewindPicker = picker;
    this.activeInputPane = picker;
    this.renderLayout();
    this.ui.setFocus(picker);
    this.ui.requestRender();
  }

  hideRewindPicker(): void {
    if (!this.rewindPicker) return;

    this.rewindPicker = undefined;
    this.activeInputPane = this.editorPane;
    this.renderLayout();
    this.ui.setFocus(this.editor);
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
    this.editor.onCtrlY = handlers.onCtrlY;
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
    const headerTarget = args.command.split(/\r?\n/)[0] ?? args.command;
    const event: ToolUiEvent = {
      type: "bash_execution",
      toolCallId,
      command: args.command,
      headerTarget,
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
    const themeTokens = resolveThemeTokensById(
      options.themeId,
      options.themes,
      this.terminalAppearance,
    );
    const paletteOverrides = coercePaletteOverrides(themeTokens);
    this.uiTheme = createUiTheme("ansi", paletteOverrides);

    this.chatContainer.setTheme(this.uiTheme);
    this.footer.setTheme(this.uiTheme);
    this.queuedMessages.setTheme(this.uiTheme);
    this.subagentPanel.setTheme(this.uiTheme);
    this.editor.setUiTheme(this.uiTheme);
    this.editorPane.setTheme(this.uiTheme);
    this.rewindPicker?.setTheme(this.uiTheme);

    if (this.lastStatus) {
      this.updateEditorVisualState(this.lastStatus.editor);
    }

    this.ui.invalidate();
    this.ui.requestRender(true);
  }

  private setupUi(): void {
    this.renderLayout();
    this.ui.setFocus(this.editor);
  }

  private renderLayout(): void {
    this.ui.clear();
    this.ui.addChild(this.chatContainer);
    this.ui.addChild(new Spacer(1));
    this.ui.addChild(this.queuedMessages);
    this.ui.addChild(this.activeInputPane);
    this.ui.addChild(this.footer);
  }

  private updateEditorVisualState(state: ChatViewStatus["editor"]): void {
    const { palette } = this.uiTheme;
    if (state.mode === "bash" || state.mode === "bash_incognito") {
      this.editor.borderColor = (s: string) => palette.modeBash(s);
    } else if (state.mode === "memory") {
      this.editor.borderColor = (s: string) => palette.modeMemory(s);
    } else if (state.mode === "recording") {
      this.editor.borderColor = (s: string) => palette.editorBorderRecording(s);
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

    if (state.mode === "recording") {
      this.editor.setHeader(
        `${this.getRecordingIndicator()} recording (${this.getRecordingDurationLabel()})`,
        "",
        {
          leftStyle: this.editor.borderColor,
        },
      );
      return;
    }

    this.editor.setHeader(state.cwdLabel, `${state.personaName} (${state.reasoningLabel})`);
  }

  private setRecordingIndicatorActive(active: boolean): void {
    if (!active) {
      if (this.recordingIndicatorTimer) {
        clearInterval(this.recordingIndicatorTimer);
        this.recordingIndicatorTimer = undefined;
      }
      this.recordingIndicatorFrame = 0;
      this.recordingStartedAt = undefined;
      return;
    }

    if (this.recordingIndicatorTimer) {
      return;
    }

    this.recordingIndicatorFrame = 0;
    this.recordingStartedAt = Date.now();
    this.recordingIndicatorTimer = setInterval(() => {
      if (this.lastStatus?.editor.mode !== "recording") {
        return;
      }

      this.recordingIndicatorFrame = (this.recordingIndicatorFrame + 1) % 2;
      this.updateEditorVisualState(this.lastStatus.editor);
      this.ui.requestRender();
    }, 500);
  }

  private getRecordingIndicator(): string {
    return this.recordingIndicatorFrame === 0 ? "●" : "○";
  }

  private getRecordingDurationLabel(): string {
    if (!this.recordingStartedAt) {
      return "00:00";
    }

    const elapsedSeconds = Math.max(0, Math.floor((Date.now() - this.recordingStartedAt) / 1000));
    const minutes = Math.floor(elapsedSeconds / 60);
    const seconds = elapsedSeconds % 60;
    return `${String(minutes).padStart(2, "0")}:${String(seconds).padStart(2, "0")}`;
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
