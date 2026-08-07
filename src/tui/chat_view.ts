import type { AutocompleteProvider, Component } from "@earendil-works/pi-tui";
import { Spacer, TuiMainScreen } from "@earendil-works/pi-tui";
import { resolveThemeTokensForAppearance, type ThemeDefinition } from "../core/config/index.js";
import type { SubagentUiEvent } from "../core/subagents/types.js";
import type { ReasoningEffort } from "../core/types.js";
import type {
  SessionProtocolFeedbackTone,
  SessionProtocolPendingUserMessage,
} from "../protocol/session_protocol.js";
import { createAppTerminal } from "./terminal.js";
import { FALLBACK_TERMINAL_COLORS, type TerminalColors } from "./terminal_appearance.js";
import { ToolUiRouter } from "./tool_ui_router.js";
import { ChatContainerComponent } from "./ui/chat_container.js";
import type { AssistantMessageModel, ChatMessageModel } from "./ui/chat_message_model.js";
import { CustomEditor } from "./ui/custom_editor.js";
import {
  DEFAULT_FOOTER_NOTICE_DURATION_MS,
  FooterComponent,
  type FooterStatus,
} from "./ui/footer.js";
import { PendingMessagesComponent } from "./ui/pending_messages.js";
import { RewindPickerComponent, type RewindPickerItem } from "./ui/rewind_picker.js";
import { SubagentEditorPaneComponent } from "./ui/subagent_editor_pane.js";
import { SubagentPanelComponent, type SubagentPanelSnapshot } from "./ui/subagent_panel.js";
import {
  coercePaletteOverrides,
  createUiTheme,
  deriveBuiltinPaletteOverrides,
  type PaletteOverrides,
  type Theme,
} from "./ui/theme/index.js";
import type { ToolUiModel } from "./ui/tool_ui_model.js";

export type ChatInputMode = "normal" | "bash" | "bash_incognito" | "recording";

export type ChatViewStatus = {
  footer: FooterStatus;
  editor: {
    mode: ChatInputMode;
    personaName: string;
    reasoningLabel: string;
    reasoning?: ReasoningEffort;
  };
};

export type ChatViewInputHandlers = {
  onCtrlC?: () => void;
  onCtrlT?: () => void;
  onShiftTab?: () => void;
  onCtrlP?: () => void;
  onCtrlS?: () => void;
  onCtrlY?: () => void;
  onEscape?: () => void;
  onAltUp?: () => void;
  onAltDown?: () => void;
  onCtrlG?: () => void;
  beforeSubmit?: (text: string) => boolean;
  onChange?: (text: string) => void;
  onSubmit?: (text: string) => void;
  onSteerSubmit?: (text: string) => void;
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
  updateMessage(id: string, model: ChatMessageModel): void;
  updateAssistantMessage(id: string, model: AssistantMessageModel): void;
  showFooterNotice(text: string, tone: SessionProtocolFeedbackTone, durationMs?: number): void;
  addTranscriptNotice(title: string, tone: SessionProtocolFeedbackTone, content?: string[]): void;
  setThinkingVisibility(show: boolean): void;
  updateStatus(status: ChatViewStatus): void;
  startWorkingIcon(): void;
  stopWorkingIcon(): void;
  updateLocalToolUi(model: ToolUiModel): void;
  handleSubagentEvent(event: SubagentUiEvent): void;
  resetToolUiSession(): void;
  reconcileToolUiSession(models: readonly ToolUiModel[]): void;
  reconcileSubagentUiSession(snapshots: readonly SubagentPanelSnapshot[]): void;
  resetToolUiSessionPreservingSubagents(): void;
  cycleSubagentSelection(direction: 1 | -1): string | undefined;
  getSelectedSubagentId(): string | undefined;
  sendTerminalNotification(title: string): void;
  setPendingUserMessages(messages: SessionProtocolPendingUserMessage[]): void;
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
  updateTheme(themeId: string): void;
}

export class TuiChatView implements ChatView {
  private ui: TuiMainScreen;
  private chatContainer: ChatContainerComponent;
  private footer: FooterComponent;
  private pendingMessages: PendingMessagesComponent;
  private subagentPanel: SubagentPanelComponent;
  private editor: CustomEditor;
  private editorPane: SubagentEditorPaneComponent;
  private rewindPicker?: RewindPickerComponent;
  private activeInputPane: Component;
  private uiTheme: Theme;
  private readonly terminalColors: TerminalColors;
  private readonly themes: ThemeDefinition[];
  private toolUiRouter: ToolUiRouter;
  private lastStatus?: ChatViewStatus;
  private recordingIndicatorFrame = 0;
  private recordingStartedAt?: number;
  private recordingIndicatorTimer?: ReturnType<typeof setInterval>;

  constructor(options: {
    showThinking: boolean;
    terminalColors?: TerminalColors;
    themeId?: string;
    themes: ThemeDefinition[];
  }) {
    this.terminalColors = options.terminalColors ?? FALLBACK_TERMINAL_COLORS;
    this.themes = options.themes;
    this.uiTheme = createUiTheme("ansi", this.resolvePaletteOverrides(options.themeId));
    this.ui = new TuiMainScreen(createAppTerminal());
    this.chatContainer = new ChatContainerComponent(this.uiTheme, options.showThinking);
    this.footer = new FooterComponent(this.uiTheme, this.ui);
    this.pendingMessages = new PendingMessagesComponent(this.uiTheme);
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
    this.footer.dispose();

    const renderState = this.ui.captureRenderState();
    if (renderState.previousLines.length > 0) {
      const targetRow = renderState.previousLines.length - 1;
      const lineDiff = targetRow - renderState.hardwareCursorRow;
      let cursorMovement = "\r";
      if (lineDiff > 0) cursorMovement += `\x1b[${lineDiff}B`;
      else if (lineDiff < 0) cursorMovement += `\x1b[${-lineDiff}A`;
      this.ui.terminal.write(`${cursorMovement}\r\n`);
    }

    this.ui.stop({ preserveScreen: true });
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

  updateMessage(id: string, model: ChatMessageModel): void {
    this.chatContainer.updateMessage(id, model);
    this.ui.requestRender();
  }

  updateAssistantMessage(id: string, model: AssistantMessageModel): void {
    this.chatContainer.updateMessage(id, model);
    this.ui.requestRender();
  }

  showFooterNotice(
    text: string,
    tone: SessionProtocolFeedbackTone,
    durationMs: number = DEFAULT_FOOTER_NOTICE_DURATION_MS,
  ): void {
    const cleanedText = this.normalizeFeedbackText(text, tone);
    const firstLine = cleanedText.split(/\r?\n/, 1)[0] ?? "";
    const noticeText = firstLine.replace(/\s+/g, " ").trim();
    if (noticeText) {
      this.footer.showNotice(noticeText, tone, durationMs);
    }
  }

  addTranscriptNotice(title: string, tone: SessionProtocolFeedbackTone, content?: string[]): void {
    const [cleanedTitle = "", ...titleContent] = this.normalizeFeedbackText(title, tone)
      .replace(/\r\n?/g, "\n")
      .split("\n");
    const noticeContent = [...titleContent, ...(content ?? [])];
    this.chatContainer.addMessage({
      type: "transcript_notice",
      title: cleanedTitle,
      ...(noticeContent.length > 0 ? { content: noticeContent } : {}),
      tone,
    });
    this.ui.requestRender();
  }

  setThinkingVisibility(show: boolean): void {
    this.chatContainer.setThinkingVisibility(show);
    this.ui.requestRender();
  }

  updateStatus(status: ChatViewStatus): void {
    this.lastStatus = status;
    this.setRecordingIndicatorActive(status.editor.mode === "recording");
    this.footer.setStatus(status.footer);

    this.updateEditorVisualState(status.editor);
    this.ui.requestRender();
  }

  startWorkingIcon(): void {
    this.footer.startWorkingIcon();
  }

  stopWorkingIcon(): void {
    this.footer.stop();
  }

  updateLocalToolUi(model: ToolUiModel): void {
    this.toolUiRouter.updateLocal(model);
  }

  handleSubagentEvent(event: SubagentUiEvent): void {
    this.subagentPanel.handleEvent(event);
    this.ui.requestRender();
  }

  resetToolUiSession(): void {
    this.toolUiRouter.resetSession();
    this.subagentPanel.reset();
  }

  reconcileToolUiSession(models: readonly ToolUiModel[]): void {
    this.toolUiRouter.reconcileSession(models);
  }

  reconcileSubagentUiSession(snapshots: readonly SubagentPanelSnapshot[]): void {
    this.subagentPanel.reconcile(snapshots);
    this.ui.requestRender();
  }

  resetToolUiSessionPreservingSubagents(): void {
    this.toolUiRouter.resetSession();
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

  setPendingUserMessages(messages: SessionProtocolPendingUserMessage[]): void {
    this.pendingMessages.setMessages(messages);
    this.ui.requestRender();
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
    this.editor.onShiftTab = handlers.onShiftTab;
    this.editor.onCtrlP = handlers.onCtrlP;
    this.editor.onCtrlS = handlers.onCtrlS;
    this.editor.onCtrlY = handlers.onCtrlY;
    this.editor.onEscape = handlers.onEscape;
    this.editor.onAltUp = handlers.onAltUp;
    this.editor.onAltDown = handlers.onAltDown;
    this.editor.onCtrlG = handlers.onCtrlG;
    this.editor.beforeSubmit = handlers.beforeSubmit;
    this.editor.onChange = handlers.onChange;
    this.editor.onSubmit = handlers.onSubmit;
    this.editor.onSteerSubmit = handlers.onSteerSubmit;
  }

  setAutocompleteProvider(provider: AutocompleteProvider): void {
    this.editor.setAutocompleteProvider(provider);
  }

  private resolvePaletteOverrides(themeId: string | undefined): PaletteOverrides | undefined {
    const theme = this.themes.find((candidate) => candidate.id === themeId);
    const tokens = resolveThemeTokensForAppearance(theme, this.terminalColors.appearance);
    const seeds = coercePaletteOverrides(tokens);
    return theme?.scope === "builtin"
      ? deriveBuiltinPaletteOverrides(seeds, this.terminalColors)
      : seeds;
  }

  updateTheme(themeId: string): void {
    this.uiTheme = createUiTheme("ansi", this.resolvePaletteOverrides(themeId));

    this.chatContainer.setTheme(this.uiTheme);
    this.footer.setTheme(this.uiTheme);
    this.pendingMessages.setTheme(this.uiTheme);
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
    this.ui.addChild(this.pendingMessages);
    this.ui.addChild(this.activeInputPane);
    this.ui.addChild(this.footer);
  }

  private updateEditorVisualState(state: ChatViewStatus["editor"]): void {
    const { palette } = this.uiTheme;
    this.editor.setPlaceholderVisible(state.mode === "normal");
    if (state.mode === "bash" || state.mode === "bash_incognito") {
      this.editor.borderColor = (s: string) => palette.editorBorderBash(s);
    } else if (state.mode === "recording") {
      this.editor.borderColor = (s: string) => palette.editorBorderRecording(s);
    } else {
      this.editor.borderColor = palette.editorBorder;
    }

    if (state.mode === "bash" || state.mode === "bash_incognito") {
      const label = state.mode === "bash_incognito" ? "$ bash incognito" : "$ bash";
      this.editor.setHeader(label, "", { leftStyle: this.editor.borderColor });
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

    this.editor.setHeader("", `${state.personaName} (${state.reasoningLabel})`);
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

  private normalizeFeedbackText(text: string, tone: SessionProtocolFeedbackTone): string {
    const cleaned = tone !== "error" ? text : text.replace(/^\s*error:\s*/i, "");
    return this.stripTrailingPunctuation(cleaned);
  }

  private stripTrailingPunctuation(text: string): string {
    const trimmed = text.replace(/\s+$/, "");
    if (!trimmed) return trimmed;
    return trimmed.replace(/[.!?…,:;]+$/, "");
  }
}
