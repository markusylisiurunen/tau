import { dirname } from "node:path/posix";
import type { AssistantMessage, Message, ToolResultMessage } from "@earendil-works/pi-ai";
import {
  type CommandDispatchContext,
  type CommandRegistry,
  createCommandRegistry,
} from "../core/commands/index.js";
import { type Config, type DiffToolConfig, getGoogleApiKey } from "../core/config/index.js";
import type {
  DiffReviewSnapshotSource,
  StartedDiffReviewBridge,
} from "../core/diff_review/index.js";
import {
  captureDiffReviewSnapshot,
  DiffReviewBridge,
  type DiffReviewToolLauncher,
} from "../core/diff_review/index.js";
import { buildDiffReviewInstructions } from "../core/diff_review/review_instructions.js";
import { type CoreDeps, createDefaultCoreDeps } from "../core/runtime/deps.js";
import { runDirectBashCommand } from "../core/session/direct_bash.js";
import type { SubagentEvent } from "../core/subagents/types.js";
import {
  buildToolRunPresentation,
  parseToolRunPresentation,
  TOOL_UI_FACET_VERSION,
} from "../core/tools/presentation.js";
import { TOOL_NAME_BASH } from "../core/tools/tool_names.js";
import { REASONING_LEVELS, type ReasoningEffort } from "../core/types.js";
import { formatAdaptiveNumber, formatCwd, formatTokenWindow } from "../core/utils/format.js";
import { extractAssistantText } from "../core/utils/messages.js";
import {
  getSpeechToTextStreamingSampleRate,
  type SpeechToTextDependencies,
} from "../core/utils/speech_to_text.js";
import { collectSpeechToTextContext } from "../core/utils/speech_to_text_context.js";
import { hasAutoCompactionContinuationMetadata } from "../core/utils/user_metadata.js";
import { APP_VERSION } from "../core/version.js";
import type {
  SessionProtocolCreateParams,
  SessionProtocolDeltaMessage,
  SessionProtocolEphemeralMessage,
  SessionProtocolMessage,
  SessionProtocolPendingUserMessagesMessage,
  SessionProtocolSnapshot,
  SessionProtocolSubagentActivitiesMessage,
  SessionProtocolSubagentActivitiesState,
  SessionProtocolTimelineItem,
  SessionProtocolToolRun,
} from "../protocol/session_protocol.js";
import {
  applySessionProtocolDelta,
  applySessionProtocolSubagentActivitiesMessage,
} from "../protocol/session_protocol.js";
import type {
  TauSdkClientToolContext,
  TauSdkClientToolExecutionEnvironment,
  TauSdkSession,
  TauSdkSessionRetryResult,
  TauSdkSessionSubmitResult,
} from "../sdk/types.js";
import { TauSessionProtocolResponseError } from "../transport/errors.js";
import {
  copyAssistantCodeToClipboard,
  copyAssistantTextToClipboard,
} from "./chat_controller/assistant_clipboard.js";
import {
  type DiffReviewReturnedReview,
  DiffReviewService,
} from "./chat_controller/diff_review_service.js";
import { formatDiffReviewUserMessage } from "./chat_controller/diff_review_user_message.js";
import {
  formatRewindCandidateAge,
  formatRewindCandidateLabel,
} from "./chat_controller/history_labels.js";
import {
  buildHistoryMessageModel,
  extractHistoryUserText,
} from "./chat_controller/history_message_model.js";
import { InterruptLifecycle } from "./chat_controller/interrupt_lifecycle.js";
import {
  formatDurationMs,
  formatFooterTokenCount,
  formatSessionCost,
} from "./chat_controller/status_format.js";
import type { ChatInputMode, ChatView, ChatViewInputHandlers } from "./chat_view.js";
import { copyTextToClipboard } from "./clipboard.js";
import { DOUBLE_PRESS_WINDOW_MS } from "./constants.js";
import {
  cleanupListenTempFile,
  createListenTempFilePath,
  createListenTranscription,
  deleteListenTempFile,
  getSpeechToTextApiKey,
  getSpeechToTextApiKeyErrorMessage,
  getSpeechToTextProvider,
  LISTEN_CAPTURE_START_TIMEOUT_MS,
  LISTEN_RECORDING_MAX_DURATION_MS,
  LISTEN_RECORDING_MIN_BYTES,
  type ListenRecording,
  readListenAudio,
  startListenAudioCapture,
} from "./listen_capture.js";
import {
  createSdkDiffSnapshotDeps,
  createSdkToolExecutionBackend,
} from "./session_tool_execution_backend.js";
import { runSpeechPlaybackTask } from "./speech_playback.js";
import type { ChatMessageModel } from "./ui/chat_message_model.js";
import type { ToolUiModel } from "./ui/tool_ui_model.js";

export type SessionChatControllerOptions = {
  view: ChatView;
  session: TauSdkSession;
  snapshot: SessionProtocolSnapshot;
  createSession?: (input: SessionProtocolCreateParams) => Promise<TauSdkSession>;
  targetLabel: string;
  configuredClientToolNames?: string[];
  config?: Config;
  defaultDiffTool?: DiffToolConfig;
  diffToolLauncher?: DiffReviewToolLauncher;
  deps?: CoreDeps;
  speechToTextDeps?: SpeechToTextDependencies;
  themeIds?: string[];
  onExit?: () => void;
};

const LISTEN_CAPTURE_START_CANCELLED = Symbol("listen capture start cancelled");

export class SessionChatController {
  private readonly view: ChatView;
  private session: TauSdkSession;
  private readonly createSession?: (input: SessionProtocolCreateParams) => Promise<TauSdkSession>;
  private readonly targetLabel: string;
  private readonly configuredClientToolNames: string[];
  private readonly config: Config;
  private readonly defaultDiffTool?: DiffToolConfig;
  private readonly diffToolLauncher?: DiffReviewToolLauncher;
  private readonly deps: CoreDeps;
  private readonly speechToTextDeps?: SpeechToTextDependencies;
  private readonly themeIds: string[];
  private readonly commandRegistry: CommandRegistry<CommandDispatchContext>;
  private readonly commandHandlers: CommandDispatchContext;
  private readonly interruptLifecycle = new InterruptLifecycle();
  private readonly diffReviewService: DiffReviewService;
  private snapshot: SessionProtocolSnapshot;
  private readonly renderedMessageIds: string[] = [];
  private readonly viewMessageIds = new Map<string, string>();
  private readonly usedViewMessageIds = new Set<string>();
  private readonly hiddenHistoryEntryIds = new Set<string>();
  private readonly ephemeralTimelineItems = new Map<string, SessionProtocolTimelineItem>();
  private renderSegment = 0;
  private observedSessionRevision: number;
  private eventUnsubscribe?: () => void;
  private ephemeralUnsubscribe?: () => void;
  private pendingUserMessagesUnsubscribe?: () => void;
  private subagentActivitiesUnsubscribe?: () => void;
  private subagentActivities: SessionProtocolSubagentActivitiesState;
  private snapshotRecovery?: Promise<void>;
  private readonly snapshotRecoveryDeltas: SessionProtocolDeltaMessage[] = [];
  private hasPendingUserMessages = false;
  private pendingIdleNotification = false;
  private isStreaming = false;
  private assistantInterruptRequested = false;
  private submittedTurnInProgress = false;
  private manualCompactionInProgress = false;
  private localDiffReviewInProgress = false;
  private sessionReplacementInProgress = false;
  private isBashMode = false;
  private isBashIncognito = false;
  private showThinking = false;
  private currentTurnStartedAt?: number;
  private lastTurnDurationMs = 0;
  private turnTimer?: ReturnType<typeof setInterval>;
  private lastEmptySubmitAt?: number;
  private listenRecording?: ListenRecording;
  private retainedListenAudioPath?: string;
  private listenTransition?: Promise<void>;
  private listenStartupAbortController?: AbortController;
  private activeListenTranscription?: ListenRecording["transcription"];
  private listenActivityLabel?: string;
  private speechActivityLabel?: string;
  private speakTask?: {
    abortController: AbortController;
    completion: Promise<void>;
  };

  constructor(options: SessionChatControllerOptions) {
    this.view = options.view;
    this.session = options.session;
    this.createSession = options.createSession;
    this.snapshot = options.snapshot;
    this.subagentActivities = options.session.subagentActivities();
    this.targetLabel = options.targetLabel;
    this.configuredClientToolNames = options.configuredClientToolNames ?? [];
    this.config = options.config ?? {};
    this.defaultDiffTool = options.defaultDiffTool;
    this.diffToolLauncher = options.diffToolLauncher;
    this.deps = options.deps ?? createDefaultCoreDeps();
    this.speechToTextDeps = options.speechToTextDeps;
    this.themeIds = options.themeIds ?? [];
    this.observedSessionRevision = options.snapshot.revision;
    this.commandRegistry = createCommandRegistry();
    this.commandHandlers = {
      help: () => this.showHelp(),
      copyText: () => this.copyLastAssistantText(),
      copyCode: () => this.copyLastAssistantCode(),
      exit: () => options.onExit?.(),
      newSession: () => this.createNewSession(),
      rewind: () => this.startRewindFlow(),
      diff: (argsText) => this.startDiffReview(argsText),
      goal: (action) => this.handleGoalAction(action),
      compactSummaryOnly: (extra) => this.compactSession("summary-only", extra),
      compactSummaryAndLast: (extra) => this.compactSession("summary-and-last", extra),
      reload: () => this.reloadContent(),
      listen: (action) => this.handleListenCommand(action),
      speak: () => this.speakLastAssistantMessage(),
      persona: (id) => this.setPersona(id),
      prompt: (id) => this.insertPrompt(id),
      theme: (id) => this.switchTheme(id),
      unknown: () =>
        this.view.addTranscriptNotice("unknown command", "error", ["type /help for commands"]),
    };
    this.diffReviewService = new DiffReviewService({
      view: this.view,
      interruptLifecycle: this.interruptLifecycle,
      refreshStatus: () => this.refreshStatus(),
      startTurnTimer: () => this.startTurnTimer(),
      stopTurnTimer: () => this.stopTurnTimer(),
      getDiffToolConfig: () => this.resolveDiffToolConfig(),
      startSession: (args) => this.startDiffReviewBridge(args, this.session, this.snapshot),
      onReviewReturned: (review) => this.handleReturnedDiffReview(review, this.session),
    });
  }

  start(): void {
    this.view.setThinkingVisibility(this.showThinking);
    this.view.addMessage({
      type: "app_intro",
      title: this.buildStartupIntroTitle(),
      body: this.buildStartupIntroBody().join("\n"),
    });
    this.renderSnapshot(this.snapshot);
    this.hydrateRunningSnapshotState();
    this.eventUnsubscribe = this.session.onDelta((delta) => this.onSdkDelta(delta));
    this.ephemeralUnsubscribe = this.session.onEphemeral((message) => this.onSdkEphemeral(message));
    this.pendingUserMessagesUnsubscribe = this.session.onPendingUserMessages((message) =>
      this.onSdkPendingUserMessages(message),
    );
    this.subagentActivitiesUnsubscribe = this.session.onSubagentActivities((message) =>
      this.onSdkSubagentActivities(message),
    );
    this.refreshStatus();
  }

  async dispose(): Promise<void> {
    this.eventUnsubscribe?.();
    this.ephemeralUnsubscribe?.();
    this.pendingUserMessagesUnsubscribe?.();
    this.subagentActivitiesUnsubscribe?.();
    this.listenStartupAbortController?.abort(LISTEN_CAPTURE_START_CANCELLED);
    this.activeListenTranscription?.abort();
    if (this.listenTransition) {
      await this.listenTransition;
    }
    if (this.listenRecording) {
      await this.cancelListenCapture();
    }
    await this.diffReviewService.cancel();
    if (this.speakTask) {
      this.speakTask.abortController.abort();
      await this.speakTask.completion;
    }
    this.stopTurnTimer();
    try {
      await this.session.unobserve();
    } catch {
      // The transport may already be closing; detach is best-effort during UI disposal.
    }
  }

  showHistoryReplicationDelayed(): void {
    this.view.showFooterNotice("history replication delayed", "default");
  }

  getInputHandlers(): ChatViewInputHandlers {
    return {
      onCtrlT: () => this.toggleThinkingVisibility(),
      onShiftTab: () => void this.cycleReasoningLevel(),
      onCtrlP: () => void this.cyclePersonality(),
      onCtrlS: () => void this.stashEditorToClipboard(),
      onCtrlY: () => void this.toggleListenCapture(),
      onCtrlG: () => this.interruptSelectedSubagent(),
      onEscape: () => void this.interrupt(),
      beforeSubmit: (text) => this.beforeSubmit(text),
      onChange: (text) => this.handleEditorChange(text),
      onSubmit: (text) => void this.handleSubmit(text),
      onSteerSubmit: (text) => void this.submitSteeringMessage(text),
      onAltUp: () => void this.cancelPendingMessagesIntoEditor(),
      onAltDown: () => this.cycleSubagentSelection(),
    };
  }

  private beforeSubmit(text: string): boolean {
    if (!this.isSessionOperationActive()) {
      return true;
    }

    if (this.isBlockingSessionOperationActive()) {
      return false;
    }

    const trimmed = text.trimStart();
    if (trimmed.startsWith("!")) {
      return false;
    }
    if (trimmed.startsWith("/") && this.isSingleLineInput(text)) {
      const parsed = this.commandRegistry.parse(trimmed);
      if (parsed.type === "unknown") {
        return true;
      }
      if (!this.isStreaming) {
        return false;
      }
      return this.commandRegistry.allowsDuringStreaming(parsed);
    }
    return true;
  }

  private async handleSubmit(text: string): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed) {
      if (this.isStreaming || this.submittedTurnInProgress) {
        return;
      }

      const now = Date.now();
      if (
        this.lastEmptySubmitAt !== undefined &&
        now - this.lastEmptySubmitAt <= DOUBLE_PRESS_WINDOW_MS
      ) {
        this.lastEmptySubmitAt = undefined;
        await this.retryTurn();
      } else {
        this.lastEmptySubmitAt = now;
      }
      return;
    }

    this.lastEmptySubmitAt = undefined;

    if (this.isSessionOperationActive()) {
      if (this.isBlockingSessionOperationActive()) {
        this.view.showFooterNotice(
          "wait for tau to become idle before submitting input",
          "default",
        );
        return;
      }
      if (trimmed.startsWith("/") && this.isSingleLineInput(text)) {
        const parsed = this.commandRegistry.parse(trimmed);
        if (parsed.type !== "unknown") {
          if (this.isStreaming && this.commandRegistry.allowsDuringStreaming(parsed)) {
            await this.commandRegistry.dispatch(parsed, this.commandHandlers);
          } else {
            this.view.showFooterNotice(
              "wait for tau to become idle before running commands",
              "default",
            );
          }
          return;
        }
      }
      if (trimmed.startsWith("!")) {
        return;
      }
      this.submitQueuedText(trimmed);
      return;
    }

    if (trimmed.startsWith("/") && this.isSingleLineInput(text)) {
      const parsed = this.commandRegistry.parse(trimmed);
      if (parsed.type !== "unknown") {
        await this.commandRegistry.dispatch(parsed, this.commandHandlers);
        return;
      }
    }

    if (trimmed.startsWith("!")) {
      if (trimmed.startsWith("!!")) {
        const command = trimmed.slice(2).trim();
        if (command) {
          await this.runSessionBashCommand(command, {
            addToContext: false,
            labelOverride: "incognito",
          });
        }
        return;
      }

      const command = trimmed.slice(1).trim();
      if (command) {
        await this.runSessionBashCommand(command, {
          addToContext: true,
          labelOverride: "you ran",
        });
      }
      return;
    }

    await this.runSessionTurn(() => this.session.submit(trimmed));
  }

  public async onUserInput(text: string): Promise<void> {
    await this.handleSubmit(text);
  }

  private showHelp(): void {
    this.view.addMessage({
      type: "transcript_text",
      text: this.commandRegistry.buildHelpText({
        contextFiles: this.getContextFilePaths(),
        skills: this.snapshot.catalog.skills,
        themes: this.themeIds,
        formatPath: (path) =>
          formatPathForSessionDisplay(path, this.snapshot.executionEnvironment.home),
      }),
    });
  }

  private switchTheme(themeId: string): void {
    this.view.updateTheme(themeId);
    this.view.showFooterNotice(`theme set to ${themeId}`, "default");
  }

  private handleEditorChange(text: string): void {
    const wasBash = this.isBashMode;
    const wasBashIncognito = this.isBashIncognito;

    if (text.trim().length > 0) {
      this.lastEmptySubmitAt = undefined;
    }

    const trimmed = text.trimStart();
    const isIncognito = trimmed.startsWith("!!");
    this.isBashIncognito = isIncognito;
    this.isBashMode = trimmed.startsWith("!") && !isIncognito;

    if (wasBash !== this.isBashMode || wasBashIncognito !== this.isBashIncognito) {
      this.refreshStatus();
    }
  }

  getAutocompleteSources(): {
    personas: () => Array<{ id: string; label?: string }>;
    prompts: () => Array<{ id: string; label?: string }>;
    themes: () => Array<{ id: string }>;
    autocompletePaths: (query: string, limit: number) => Promise<string[]>;
    skills: () => string[];
    subagents: () => string[];
  } {
    return {
      personas: () =>
        this.snapshot.catalog.personas.map((persona) => ({
          id: persona.id,
          label: persona.label,
        })),
      prompts: () =>
        this.snapshot.catalog.prompts.map((prompt) => ({
          id: prompt.id,
          label: prompt.label,
        })),
      themes: () => this.themeIds.map((id) => ({ id })),
      autocompletePaths: async (query, limit) =>
        (await this.session.autocompletePaths({ query, limit })).paths,
      skills: () => this.snapshot.catalog.skills.map((skill) => skill.name),
      subagents: () => Object.keys(this.getCurrentPersonaSnapshot()?.subagents ?? {}),
    };
  }

  private buildStartupIntroTitle(): string {
    const parts = [`tau v${APP_VERSION}`];
    const contextFiles = this.getContextFilePaths();
    if (contextFiles.length > 0) {
      parts.push(`${contextFiles.length} context file${contextFiles.length === 1 ? "" : "s"}`);
    }
    if (this.snapshot.catalog.skills.length > 0) {
      parts.push(`${this.snapshot.catalog.skills.length} skills`);
    }
    if (this.configuredClientToolNames.length > 0) {
      const count = this.configuredClientToolNames.length;
      parts.push(`${count} client tool${count === 1 ? "" : "s"}`);
    }
    return parts.join(" · ");
  }

  private buildStartupIntroBody(): string[] {
    const lines = [
      "type `/help` for commands and keybindings",
      "mention files with `@`, agents and skills with `@@`",
      "run bash commands with `!` or `!!`",
    ];

    if (this.snapshot.catalog.skills.length > 0) {
      lines.push("", "skills:");
      for (const skill of this.snapshot.catalog.skills) {
        const skillsRoot = formatPathForSessionDisplay(
          dirname(dirname(skill.path)),
          this.snapshot.executionEnvironment.home,
        );
        lines.push(`  ${skill.name} (${skillsRoot})`);
      }
    }

    const contextFiles = this.getContextFilePaths().map((path) =>
      formatPathForSessionDisplay(path, this.snapshot.executionEnvironment.home),
    );
    if (contextFiles.length > 0) {
      lines.push("", "context:");
      for (const contextFile of contextFiles) {
        lines.push(`  ${contextFile}`);
      }
    }

    if (this.configuredClientToolNames.length > 0) {
      lines.push("", "client tools:");
      for (const clientToolName of this.configuredClientToolNames) {
        lines.push(`  ${clientToolName}`);
      }
    }

    lines.push("", this.formatSessionIdentityText());

    return lines;
  }

  private async retryTurn(): Promise<void> {
    await this.runSessionTurn(() => this.session.retry());
  }

  private async runSessionBashCommand(
    command: string,
    options: { addToContext: boolean; labelOverride: string },
  ): Promise<void> {
    if (this.isSessionOperationActive()) {
      return;
    }

    const toolCallId = `bash-user-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const workingDirectory = this.snapshot.executionEnvironment.cwd;

    this.isStreaming = true;
    this.startTurnTimer();
    this.view.startWorkingIcon();
    this.view.updateLocalToolUi({
      toolCallId,
      status: "running",
      presentation: buildToolRunPresentation({
        toolName: TOOL_NAME_BASH,
        subject: command,
        metadata: [formatCwd(workingDirectory)],
      }),
    });
    this.refreshStatus();

    try {
      const backend = createSdkToolExecutionBackend({
        executionEnvironment: this.session,
        cwd: this.snapshot.executionEnvironment.cwd,
      });
      const result = await runDirectBashCommand({
        command,
        backend,
        workingDirectory,
        actionLabel: options.labelOverride,
        addToContext: options.addToContext,
        addUserText: async (text) => {
          const recorded = await this.session.record(text, {
            historyEntryId: toolCallId,
          });
          return recorded.userHistoryEntryId;
        },
      });
      if (result.userHistoryEntryId) {
        this.hiddenHistoryEntryIds.add(result.userHistoryEntryId);
        this.renderedMessageIds.push(this.getViewMessageId(result.userHistoryEntryId));
      }
      this.view.updateLocalToolUi({
        toolCallId,
        status: result.exitCode === 0 ? "succeeded" : "failed",
        presentation: result.presentation,
      });
      await this.syncFromSessionSnapshot();
    } catch (error) {
      const reason = (error as Error).message || "bash failed";
      this.view.updateLocalToolUi({
        toolCallId,
        status: "blocked",
        presentation: buildToolRunPresentation({
          toolName: TOOL_NAME_BASH,
          subject: command,
          details: [{ text: reason }],
          metadata: [formatCwd(workingDirectory)],
        }),
      });
      await this.syncFromSessionSnapshot();
    } finally {
      this.isStreaming = false;
      this.view.stopWorkingIcon();
      this.stopTurnTimer();
      this.refreshStatus();
      this.view.requestRender();
    }
  }

  private async submitSteeringMessage(text: string): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed) {
      return;
    }

    if (!this.isSessionOperationActive()) {
      await this.runSessionTurn(() => this.session.submit(trimmed));
      return;
    }

    if (this.isBlockingSessionOperationActive()) {
      this.view.showFooterNotice("wait for tau to become idle before submitting input", "default");
      return;
    }

    this.submitSteeringText(trimmed);
  }

  private submitQueuedText(text: string): void {
    void this.session.queue(text).catch((error) => {
      if (!this.isPendingMessageCancellation(error)) {
        this.view.addTranscriptNotice("failed to queue message", "error", [
          formatSessionError(error),
        ]);
      }
    });
  }

  private submitSteeringText(text: string): void {
    void this.session.steer(text).catch((error) => {
      if (!this.isPendingMessageCancellation(error)) {
        this.view.addTranscriptNotice("failed to steer assistant", "error", [
          formatSessionError(error),
        ]);
      }
    });
  }

  private async cancelPendingMessagesIntoEditor(): Promise<void> {
    try {
      const { cancelled } = await this.session.cancelPendingMessages();
      if (cancelled.length === 0) {
        return;
      }

      const editorText = this.view.getEditorText();
      this.view.setEditorText(
        [...(editorText ? [editorText] : []), ...cancelled.map((message) => message.text)].join(
          "\n\n---\n\n",
        ),
      );
      this.view.requestRender();
    } catch (error) {
      this.view.addTranscriptNotice("failed to cancel pending messages", "error", [
        (error as Error).message,
      ]);
    }
  }

  private isPendingMessageCancellation(error: unknown): boolean {
    return error instanceof TauSessionProtocolResponseError && error.code === "cancelled";
  }

  private cycleSubagentSelection(): void {
    this.view.cycleSubagentSelection(1);
    this.view.requestRender();
  }

  private async runSessionTurn(
    task: () => Promise<TauSdkSessionSubmitResult | TauSdkSessionRetryResult>,
  ): Promise<void> {
    if (this.isSessionOperationActive()) {
      return;
    }

    this.isStreaming = true;
    this.assistantInterruptRequested = false;
    this.submittedTurnInProgress = true;
    this.startTurnTimer();
    this.view.startWorkingIcon();
    this.refreshStatus();

    try {
      await task();
      await this.syncFromSessionSnapshot();
    } catch (error) {
      this.view.addTranscriptNotice("failed to run assistant turn", "error", [
        formatSessionError(error),
      ]);
      this.stopVisibleSessionTurn();
      await this.syncFromSessionSnapshot();
    } finally {
      this.submittedTurnInProgress = false;
      this.stopVisibleSessionTurn();
      this.refreshStatus();
    }
  }

  private async interrupt(): Promise<void> {
    if (this.interruptLifecycle.interruptActiveTask()) {
      this.view.showFooterNotice("interrupted", "default");
      return;
    }

    if (this.listenStartupAbortController) {
      this.listenStartupAbortController.abort(LISTEN_CAPTURE_START_CANCELLED);
      this.view.showFooterNotice("interrupted", "default");
      return;
    }

    if (this.listenRecording) {
      void this.runListenTransition(() => this.stopListenCapture());
      return;
    }

    if (this.speakTask) {
      if (!this.speakTask.abortController.signal.aborted) {
        this.speakTask.abortController.abort();
      }
      this.view.showFooterNotice("interrupted", "default");
      return;
    }

    if (!this.isStreaming || this.assistantInterruptRequested) {
      return;
    }

    this.assistantInterruptRequested = true;
    try {
      const result = await this.session.interrupt();
      if (!result.interrupted) {
        this.assistantInterruptRequested = false;
      }
    } catch (error) {
      this.assistantInterruptRequested = false;
      this.view.addTranscriptNotice("failed to interrupt assistant", "error", [
        (error as Error).message,
      ]);
    }
  }

  private async handleListenCommand(action: "record" | "retry" | "discard"): Promise<void> {
    switch (action) {
      case "record":
        await this.startListenCaptureFromCommand();
        return;
      case "retry":
        await this.retryRetainedListenAudio();
        return;
      case "discard":
        await this.discardRetainedListenAudio();
        return;
    }
  }

  private async toggleListenCapture(): Promise<void> {
    if (this.listenTransition) {
      if (this.listenStartupAbortController) {
        this.listenStartupAbortController.abort(LISTEN_CAPTURE_START_CANCELLED);
        this.view.showFooterNotice("cancelled speech recording startup", "default");
      } else {
        this.view.showFooterNotice("speech recording state change already in progress", "default");
      }
      return;
    }

    if (this.listenRecording) {
      await this.runListenTransition(() => this.stopListenCapture());
      return;
    }

    await this.startListenCaptureFromCommand();
  }

  private async startListenCaptureFromCommand(): Promise<void> {
    if (this.listenTransition) {
      this.view.showFooterNotice("speech recording state change already in progress", "default");
      return;
    }

    if (this.listenRecording) {
      this.view.showFooterNotice("speech recording already in progress", "default");
      return;
    }

    if (this.listenActivityLabel) {
      this.view.showFooterNotice("speech transcription already in progress", "default");
      return;
    }

    await this.runListenTransition(() => this.startListenCapture());
  }

  private async runListenTransition(task: () => Promise<void>): Promise<void> {
    if (this.listenTransition) {
      return;
    }

    const transition = task();
    this.listenTransition = transition;

    try {
      await transition;
    } finally {
      if (this.listenTransition === transition) {
        this.listenTransition = undefined;
      }
    }
  }

  private async startListenCapture(): Promise<void> {
    if (this.deps.env.platform() !== "darwin") {
      this.view.showFooterNotice("/listen is currently supported only on macOS.", "default");
      return;
    }

    const apiKey = getSpeechToTextApiKey(this.config, this.deps);
    if (!apiKey) {
      this.view.addTranscriptNotice("speech-to-text is not configured", "error", [
        getSpeechToTextApiKeyErrorMessage(this.config, "use /listen"),
      ]);
      return;
    }

    const retainedAudioPath = this.retainedListenAudioPath;
    let audioPath: string | undefined;
    let transcription: ListenRecording["transcription"] | undefined;
    let abortController: AbortController | undefined;
    let completion: ListenRecording["completion"] | undefined;
    try {
      audioPath = await createListenTempFilePath(this.deps);
      transcription = this.createSpeechTranscription("streaming");
      abortController = new AbortController();
      this.listenStartupAbortController = abortController;
      const capture = startListenAudioCapture({
        deps: this.deps,
        audioPath,
        signal: abortController.signal,
        streamingSampleRate: getSpeechToTextStreamingSampleRate(
          getSpeechToTextProvider(this.config),
        ),
        onAudioChunk: (audio) => transcription?.appendAudio(audio),
      });
      completion = capture.completion;
      await this.waitForListenCaptureStart(capture.started, abortController);
      if (abortController.signal.aborted) {
        throw abortController.signal.reason;
      }
      if (this.listenStartupAbortController === abortController) {
        this.listenStartupAbortController = undefined;
      }

      if (retainedAudioPath) {
        try {
          await deleteListenTempFile(retainedAudioPath);
          if (this.retainedListenAudioPath === retainedAudioPath) {
            this.retainedListenAudioPath = undefined;
          }
        } catch (error) {
          abortController.abort();
          transcription.abort();
          await completion.catch(() => undefined);
          await cleanupListenTempFile(audioPath);
          this.view.addTranscriptNotice("failed to replace retained recording", "error", [
            (error as Error).message,
            `recording retained at ${retainedAudioPath}`,
          ]);
          return;
        }
      }

      const recording: ListenRecording = {
        audioPath,
        stopRequested: false,
        abortController,
        completion,
        transcription,
      };
      recording.maxDurationTimeout = setTimeout(() => {
        if (this.listenRecording !== recording || this.listenTransition) return;
        void this.runListenTransition(() => this.stopListenCapture());
      }, LISTEN_RECORDING_MAX_DURATION_MS);
      this.listenRecording = recording;
      this.view.setEditorInputEnabled(false);
      this.refreshStatus();
      void this.watchListenRecording(recording);
    } catch (err) {
      const cancelled = abortController?.signal.reason === LISTEN_CAPTURE_START_CANCELLED;
      abortController?.abort();
      transcription?.abort();
      await completion?.catch(() => undefined);
      if (audioPath) {
        await cleanupListenTempFile(audioPath);
      }
      if (!cancelled) {
        this.view.addTranscriptNotice("failed to start recording", "error", [
          (err as Error).message,
        ]);
      }
    } finally {
      if (this.listenStartupAbortController === abortController) {
        this.listenStartupAbortController = undefined;
      }
    }
  }

  private async waitForListenCaptureStart(
    started: Promise<void>,
    abortController: AbortController,
  ): Promise<void> {
    let timeout: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        started,
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => {
            const error = new Error("timed out waiting for microphone audio");
            abortController.abort(error);
            reject(error);
          }, LISTEN_CAPTURE_START_TIMEOUT_MS);
          timeout.unref?.();
        }),
      ]);
    } finally {
      if (timeout) clearTimeout(timeout);
    }
  }

  private async stopListenCapture(): Promise<void> {
    const recording = this.listenRecording;
    if (!recording) return;

    recording.stopRequested = true;
    this.clearListenRecordingMaxDurationTimeout(recording);
    this.listenRecording = undefined;
    this.view.setEditorInputEnabled(true);
    this.refreshStatus();

    recording.abortController.abort();

    try {
      await recording.completion;
    } catch (err) {
      recording.transcription.abort();
      this.view.addTranscriptNotice("failed to record audio", "error", [(err as Error).message]);
      await cleanupListenTempFile(recording.audioPath);
      return;
    }

    await this.transcribeListenAudioFile(recording.audioPath, recording.transcription);
  }

  private async retryRetainedListenAudio(): Promise<void> {
    if (this.listenRecording || this.listenTransition || this.listenActivityLabel) {
      this.view.showFooterNotice("speech recording state change already in progress", "default");
      return;
    }

    const audioPath = this.retainedListenAudioPath;
    if (!audioPath) {
      this.view.showFooterNotice("no failed speech recording to retry", "default");
      return;
    }

    await this.runListenTransition(() => this.transcribeListenAudioFile(audioPath));
  }

  private async discardRetainedListenAudio(): Promise<void> {
    if (this.listenRecording || this.listenTransition || this.listenActivityLabel) {
      this.view.showFooterNotice("speech recording state change already in progress", "default");
      return;
    }

    const audioPath = this.retainedListenAudioPath;
    if (!audioPath) {
      this.view.showFooterNotice("no failed speech recording to discard", "default");
      return;
    }

    try {
      await deleteListenTempFile(audioPath);
      this.retainedListenAudioPath = undefined;
      this.view.showFooterNotice("discarded retained speech recording", "default");
    } catch (error) {
      this.view.addTranscriptNotice("failed to discard speech recording", "error", [
        (error as Error).message,
        `recording retained at ${audioPath}`,
      ]);
    }
  }

  private createSpeechTranscription(mode: "streaming" | "file"): ListenRecording["transcription"] {
    return createListenTranscription({
      config: this.config,
      deps: this.deps,
      mode,
      context: collectSpeechToTextContext(this.snapshot),
      speechToTextDeps: this.speechToTextDeps,
    });
  }

  private async transcribeListenAudioFile(
    audioPath: string,
    transcription?: ListenRecording["transcription"],
  ): Promise<void> {
    let audio: Buffer;
    try {
      audio = await readListenAudio(audioPath);
    } catch (error) {
      transcription?.abort();
      this.view.addTranscriptNotice("failed to read speech recording", "error", [
        (error as Error).message,
      ]);
      if (this.retainedListenAudioPath === audioPath) {
        this.retainedListenAudioPath = undefined;
      }
      await cleanupListenTempFile(audioPath);
      return;
    }

    if (audio.byteLength < LISTEN_RECORDING_MIN_BYTES) {
      transcription?.abort();
      this.view.showFooterNotice("recording too short, try again", "default");
      if (this.retainedListenAudioPath === audioPath) {
        this.retainedListenAudioPath = undefined;
      }
      await cleanupListenTempFile(audioPath);
      return;
    }

    let activeTranscription = transcription;
    this.listenActivityLabel = "transcribing voice input";
    this.refreshStatus();
    try {
      activeTranscription ??= this.createSpeechTranscription("file");
      this.activeListenTranscription = activeTranscription;
      const text = await activeTranscription.finish({
        audio,
        mimeType: "audio/wav",
      });
      this.view.insertEditorTextAtCursor(text);
      this.retainedListenAudioPath = undefined;
      try {
        await deleteListenTempFile(audioPath);
      } catch (error) {
        this.view.addTranscriptNotice("failed to delete speech recording", "error", [
          (error as Error).message,
          `recording remains at ${audioPath}; delete it manually`,
        ]);
      }
    } catch (error) {
      this.retainedListenAudioPath = audioPath;
      this.view.addTranscriptNotice("failed to transcribe speech", "error", [
        (error as Error).message,
        `recording retained at ${audioPath}`,
        "run /listen retry to try again, or /listen discard to delete it",
      ]);
    } finally {
      activeTranscription?.abort();
      if (this.activeListenTranscription === activeTranscription) {
        this.activeListenTranscription = undefined;
      }
      this.listenActivityLabel = undefined;
      this.refreshStatus();
    }
  }

  private async cancelListenCapture(): Promise<void> {
    const recording = this.listenRecording;
    if (!recording) return;

    recording.stopRequested = true;
    this.clearListenRecordingMaxDurationTimeout(recording);
    this.listenRecording = undefined;
    this.view.setEditorInputEnabled(true);
    this.refreshStatus();

    recording.abortController.abort();
    recording.transcription.abort();
    try {
      await recording.completion;
    } catch {
      // ignore disposal errors
    }
    await cleanupListenTempFile(recording.audioPath);
  }

  private async watchListenRecording(recording: ListenRecording): Promise<void> {
    try {
      const result = await recording.completion;
      this.clearListenRecordingMaxDurationTimeout(recording);
      if (this.listenRecording !== recording || recording.stopRequested) return;

      this.listenRecording = undefined;
      recording.transcription.abort();
      this.view.setEditorInputEnabled(true);
      this.refreshStatus();
      const detail =
        result.exitCode !== null
          ? `ffmpeg exited with code ${result.exitCode}`
          : result.closeSignal
            ? `ffmpeg terminated by signal ${result.closeSignal}`
            : "ffmpeg exited";
      this.view.addTranscriptNotice("recording stopped unexpectedly", "error", [detail]);
      await cleanupListenTempFile(recording.audioPath);
    } catch (err) {
      this.clearListenRecordingMaxDurationTimeout(recording);
      if (this.listenRecording !== recording || recording.stopRequested) return;

      this.listenRecording = undefined;
      recording.transcription.abort();
      this.view.setEditorInputEnabled(true);
      this.refreshStatus();
      const error = err as NodeJS.ErrnoException;
      if (error.code === "ENOENT") {
        this.view.addTranscriptNotice("ffmpeg not found", "error", [
          "install it with: brew install ffmpeg",
        ]);
      } else {
        this.view.addTranscriptNotice("failed to record audio", "error", [error.message]);
      }
      await cleanupListenTempFile(recording.audioPath);
    }
  }

  private clearListenRecordingMaxDurationTimeout(recording: ListenRecording): void {
    if (!recording.maxDurationTimeout) return;
    clearTimeout(recording.maxDurationTimeout);
    recording.maxDurationTimeout = undefined;
  }

  private async createNewSession(): Promise<void> {
    if (this.isSessionOperationActive()) {
      this.view.showFooterNotice(
        "cannot create a new session while another session operation is running",
        "default",
      );
      return;
    }

    if (!this.createSession) {
      this.view.addTranscriptNotice("cannot create a new session", "error");
      return;
    }

    const createInput: SessionProtocolCreateParams = {
      executionEnvironment: this.createExecutionEnvironmentInputFromSnapshot(),
      attributes: {
        source: "tui",
        ...(this.snapshot.attributes.repository
          ? { repository: this.snapshot.attributes.repository }
          : {}),
      },
      personaId: this.snapshot.settings.personaId,
      ...(this.snapshot.settings.reasoning !== undefined
        ? { reasoning: this.snapshot.settings.reasoning }
        : {}),
    };
    this.sessionReplacementInProgress = true;
    this.refreshStatus();

    let nextSession: TauSdkSession | undefined;
    let nextEventUnsubscribe: (() => void) | undefined;
    let nextEphemeralUnsubscribe: (() => void) | undefined;
    let nextPendingUserMessagesUnsubscribe: (() => void) | undefined;
    let nextSubagentActivitiesUnsubscribe: (() => void) | undefined;
    let installed = false;
    try {
      nextSession = await this.createSession(createInput);
      const nextSnapshot = await nextSession.snapshot();
      const pendingDeltas: SessionProtocolDeltaMessage[] = [];
      const pendingEphemeralMessages: SessionProtocolEphemeralMessage[] = [];
      const pendingUserMessages: SessionProtocolPendingUserMessagesMessage[] = [];
      const subagentActivities: SessionProtocolSubagentActivitiesMessage[] = [];
      let forwardEvents = false;
      nextEventUnsubscribe = nextSession.onDelta((delta) => {
        if (forwardEvents) {
          this.onSdkDelta(delta);
        } else {
          pendingDeltas.push(delta);
        }
      });
      nextEphemeralUnsubscribe = nextSession.onEphemeral((message) => {
        if (forwardEvents) {
          this.onSdkEphemeral(message);
        } else {
          pendingEphemeralMessages.push(message);
        }
      });
      nextPendingUserMessagesUnsubscribe = nextSession.onPendingUserMessages((message) => {
        if (forwardEvents) {
          this.onSdkPendingUserMessages(message);
        } else {
          pendingUserMessages.push(message);
        }
      });
      nextSubagentActivitiesUnsubscribe = nextSession.onSubagentActivities((message) => {
        if (forwardEvents) {
          this.onSdkSubagentActivities(message);
        } else {
          subagentActivities.push(message);
        }
      });

      const previousSession = this.session;
      this.eventUnsubscribe?.();
      this.ephemeralUnsubscribe?.();
      this.pendingUserMessagesUnsubscribe?.();
      this.subagentActivitiesUnsubscribe?.();
      this.session = nextSession;
      this.snapshot = nextSnapshot;
      this.subagentActivities = nextSession.subagentActivities();
      this.observedSessionRevision = nextSnapshot.revision;
      this.eventUnsubscribe = nextEventUnsubscribe;
      this.ephemeralUnsubscribe = nextEphemeralUnsubscribe;
      this.pendingUserMessagesUnsubscribe = nextPendingUserMessagesUnsubscribe;
      this.subagentActivitiesUnsubscribe = nextSubagentActivitiesUnsubscribe;
      installed = true;

      this.view.resetToolUiSession();
      this.startLocalUiSession();
      this.addSessionIdentityMessage();
      this.renderSnapshot(this.snapshot);
      for (const delta of pendingDeltas) {
        this.onSdkDelta(delta);
      }
      for (const message of pendingEphemeralMessages) {
        this.onSdkEphemeral(message);
      }
      for (const message of pendingUserMessages) {
        this.onSdkPendingUserMessages(message);
      }
      for (const message of subagentActivities) {
        this.onSdkSubagentActivities(message);
      }
      this.syncSnapshotToolAndAgentUi(this.snapshot);
      forwardEvents = true;

      try {
        await previousSession.unobserve();
      } catch (detachError) {
        this.view.addTranscriptNotice("failed to detach previous session", "error", [
          (detachError as Error).message,
        ]);
      }
    } catch (error) {
      if (!installed && nextSession) {
        nextEventUnsubscribe?.();
        nextEphemeralUnsubscribe?.();
        nextPendingUserMessagesUnsubscribe?.();
        nextSubagentActivitiesUnsubscribe?.();
        await nextSession.unobserve().catch(() => undefined);
      }
      this.view.addTranscriptNotice("failed to create session", "error", [
        (error as Error).message,
      ]);
    } finally {
      this.sessionReplacementInProgress = false;
      this.refreshStatus();
    }
  }

  private createExecutionEnvironmentInputFromSnapshot(): SessionProtocolCreateParams["executionEnvironment"] {
    const snapshot = this.snapshot.executionEnvironment;
    switch (snapshot.kind) {
      case "local":
        return { kind: "local", cwd: snapshot.cwd };
      case "cloudflare-sandbox":
        return {
          kind: "cloudflare-sandbox",
          bridgeId: snapshot.bridgeId,
          sandboxId: snapshot.sandboxId,
          cwd: snapshot.cwd,
        };
      case "fly-sprite":
        return {
          kind: "fly-sprite",
          apiId: snapshot.apiId,
          spriteName: snapshot.spriteName,
          cwd: snapshot.cwd,
        };
    }
  }

  private onSdkPendingUserMessages(message: SessionProtocolPendingUserMessagesMessage): void {
    this.hasPendingUserMessages = message.state.messages.length > 0;
    this.view.setPendingUserMessages(message.state.messages);
    this.sendPendingIdleNotification();
  }

  private onSdkSubagentActivities(message: SessionProtocolSubagentActivitiesMessage): void {
    if (message.revision <= this.subagentActivities.revision) {
      return;
    }
    this.subagentActivities = applySessionProtocolSubagentActivitiesMessage(
      this.subagentActivities,
      message,
    );
    this.syncSnapshotToolAndAgentUi(this.snapshot);
  }

  private onSdkEphemeral(message: SessionProtocolEphemeralMessage): void {
    const event = message.event;
    switch (event.type) {
      case "feedback.notice":
        this.view.showFooterNotice(event.title, event.tone, event.durationMs);
        return;
      case "timeline.item":
        if (event.epoch !== this.snapshot.timeline.epoch) {
          return;
        }
        this.ephemeralTimelineItems.set(event.item.id, event.item);
        this.syncRenderedHistory(this.snapshot);
        return;
      case "ephemeral-agent.thread-update":
        return;
    }
  }

  private onSdkDelta(delta: SessionProtocolDeltaMessage): void {
    if (this.snapshotRecovery) {
      this.snapshotRecoveryDeltas.push(delta);
      return;
    }

    if (this.tryApplySdkDelta(delta)) {
      return;
    }

    this.snapshotRecoveryDeltas.push(delta);
    void this.recoverFromRevisionGap();
  }

  private tryApplySdkDelta(delta: SessionProtocolDeltaMessage): boolean {
    if (delta.toRevision <= this.snapshot.revision) {
      return true;
    }

    if (delta.delta.type === "snapshot.patch" && delta.fromRevision !== this.snapshot.revision) {
      return false;
    }

    try {
      if (this.tryApplyFastSnapshotStateDelta(delta)) {
        return true;
      }
      if (this.tryApplyFastContentAppendDelta(delta)) {
        return true;
      }
      if (this.tryApplyFastToolUiDelta(delta)) {
        return true;
      }
      if (this.tryApplyFastAgentDelta(delta)) {
        return true;
      }

      const nextSnapshot = applySessionProtocolDelta(this.snapshot, delta);
      if (delta.cause.type === "compaction" && delta.delta.type === "snapshot.reset") {
        this.renderCompactedReset(nextSnapshot, delta.cause);
      } else {
        if (delta.cause.type === "rewind") {
          for (const [id, item] of this.ephemeralTimelineItems) {
            if (item.sequence > delta.cause.cutoffSequence) {
              this.ephemeralTimelineItems.delete(id);
            }
          }
        } else if (nextSnapshot.timeline.epoch !== this.snapshot.timeline.epoch) {
          this.ephemeralTimelineItems.clear();
        }
        this.syncRenderedHistory(nextSnapshot);
      }
      this.refreshStatus();
    } catch (error) {
      this.view.addTranscriptNotice("failed to update session", "error", [
        (error as Error).message,
      ]);
      return false;
    }
    return true;
  }

  private tryApplyFastSnapshotStateDelta(delta: SessionProtocolDeltaMessage): boolean {
    if (
      delta.delta.type !== "snapshot.patch" ||
      delta.delta.changes.length === 0 ||
      delta.delta.changes.some((change) => {
        switch (change.type) {
          case "agent-state.set":
          case "lifecycle.set":
          case "goal.set":
          case "cost.set":
          case "settings.set":
          case "turn.set":
          case "operation.set":
          case "operation.remove":
            return false;
          default:
            return true;
        }
      })
    ) {
      return false;
    }

    this.snapshot = applySessionProtocolDelta(this.snapshot, delta);
    this.observedSessionRevision = Math.max(this.observedSessionRevision, this.snapshot.revision);
    this.updateStreamingStateFromSnapshot(this.snapshot);
    this.refreshStatus();
    return true;
  }

  private tryApplyFastContentAppendDelta(delta: SessionProtocolDeltaMessage): boolean {
    if (delta.delta.type !== "snapshot.patch" || delta.delta.changes.length !== 1) {
      return false;
    }

    const change = delta.delta.changes[0]!;
    if (change.type !== "message.content.append") {
      return false;
    }

    const nextSnapshot = applySessionProtocolDelta(this.snapshot, delta);
    this.snapshot = nextSnapshot;
    this.observedSessionRevision = Math.max(this.observedSessionRevision, nextSnapshot.revision);

    const message = nextSnapshot.messages.find((entry) => entry.id === change.messageId);
    if (
      !message ||
      this.hiddenHistoryEntryIds.has(message.id) ||
      !this.isMessageProjected(message.id) ||
      !isMessageInTimeline(nextSnapshot, message.id)
    ) {
      return true;
    }

    const model = this.buildProtocolMessageModel(message);
    if (!model) {
      return true;
    }

    const viewMessageId = this.getViewMessageId(message.id);
    if (this.renderedMessageIds.includes(viewMessageId)) {
      if (model.type === "assistant" || model.type === "assistant_partial") {
        this.view.updateAssistantMessage(viewMessageId, model);
      } else {
        this.view.updateMessage(viewMessageId, model);
      }
    } else {
      this.renderedMessageIds.push(this.view.addMessage(model, viewMessageId));
    }
    return true;
  }

  private tryApplyFastAgentDelta(delta: SessionProtocolDeltaMessage): boolean {
    if (delta.delta.type !== "snapshot.patch") {
      return false;
    }

    const agentChanges = delta.delta.changes.filter((change) => change.type === "agent.set");
    if (
      agentChanges.length !== 1 ||
      delta.delta.changes.some(
        (change) => change.type !== "agent.set" && change.type !== "cost.set",
      )
    ) {
      return false;
    }

    const change = agentChanges[0]!;
    const previousAgent = this.snapshot.agents[change.agent.id];
    this.snapshot = applySessionProtocolDelta(this.snapshot, delta);
    this.observedSessionRevision = Math.max(this.observedSessionRevision, this.snapshot.revision);

    for (const event of subagentUiEventsForAgentDelta(previousAgent, change.agent)) {
      this.view.handleSubagentEvent(event);
    }
    this.refreshStatus();
    return true;
  }

  private tryApplyFastToolUiDelta(delta: SessionProtocolDeltaMessage): boolean {
    if (
      delta.delta.type !== "snapshot.patch" ||
      delta.delta.changes.length === 0 ||
      delta.delta.changes.some(
        (change) => change.type !== "tool.set" && change.type !== "facet.set",
      )
    ) {
      return false;
    }

    const facetChanges = delta.delta.changes.filter((change) => change.type === "facet.set");
    if (
      facetChanges.some(
        ({ facet }) => facet.kind !== "tau.tool-ui-events" || facet.subject.type !== "tool",
      )
    ) {
      return false;
    }

    const nextSnapshot = applySessionProtocolDelta(this.snapshot, delta);
    this.snapshot = nextSnapshot;
    this.observedSessionRevision = Math.max(this.observedSessionRevision, nextSnapshot.revision);

    const toolIds = new Set<string>();
    for (const change of delta.delta.changes) {
      if (change.type === "tool.set") {
        toolIds.add(change.tool.id);
      } else if (change.type === "facet.set" && change.facet.subject.type === "tool") {
        toolIds.add(change.facet.subject.id);
      }
    }

    for (const item of [...nextSnapshot.timeline.items, ...this.ephemeralTimelineItems.values()]) {
      if (item.type !== "tool" || !toolIds.has(item.toolId)) {
        continue;
      }
      const tool = nextSnapshot.tools[item.toolId];
      if (!tool) {
        continue;
      }
      const model = { type: "tool" as const, tool: buildToolUiModel(nextSnapshot, tool) };
      const viewMessageId = this.getViewMessageId(item.id);
      if (this.renderedMessageIds.includes(viewMessageId)) {
        this.view.updateMessage(viewMessageId, model);
      } else {
        this.renderedMessageIds.push(this.view.addMessage(model, viewMessageId));
      }
    }

    this.refreshStatus();
    return true;
  }

  private getViewMessageId(protocolId: string): string {
    const existingId = this.viewMessageIds.get(protocolId);
    if (existingId) return existingId;

    let viewId = protocolId;
    if (this.usedViewMessageIds.has(viewId)) {
      const baseId = `timeline-segment:${this.renderSegment}:${protocolId}`;
      viewId = baseId;
      for (let suffix = 2; this.usedViewMessageIds.has(viewId); suffix += 1) {
        viewId = `${baseId}:${suffix}`;
      }
    }
    this.viewMessageIds.set(protocolId, viewId);
    this.usedViewMessageIds.add(viewId);
    return viewId;
  }

  private renderSnapshot(snapshot: SessionProtocolSnapshot): void {
    this.snapshot = snapshot;
    this.observedSessionRevision = Math.max(this.observedSessionRevision, snapshot.revision);
    for (const item of getRenderableTimelineItems(snapshot, this.ephemeralTimelineItems.values())) {
      const viewMessageId = this.getViewMessageId(item.id);
      if (item.type === "notice") {
        this.renderedMessageIds.push(
          this.view.addMessage(
            {
              type: "transcript_notice",
              title: item.title,
              ...(item.content ? { content: item.content } : {}),
              tone: item.severity === "error" ? "error" : "default",
            },
            viewMessageId,
          ),
        );
      } else if (item.type === "tool") {
        this.renderedMessageIds.push(
          this.view.addMessage({ type: "tool", tool: item.model }, viewMessageId),
        );
      } else {
        this.renderProtocolMessage(item.message, viewMessageId);
      }
    }
    this.syncSnapshotToolAndAgentUi(snapshot);
  }

  private hydrateRunningSnapshotState(): void {
    if (this.snapshot.lifecycle !== "running") {
      return;
    }

    this.isStreaming = true;
    this.startTurnTimer();
    this.view.startWorkingIcon();
  }

  private renderProtocolMessage(message: SessionProtocolMessage, viewMessageId: string): void {
    const model = this.buildProtocolMessageModel(message);
    if (!model) {
      return;
    }

    this.renderedMessageIds.push(this.view.addMessage(model, viewMessageId));
  }

  private syncRenderedHistory(snapshot: SessionProtocolSnapshot): void {
    this.snapshot = snapshot;
    this.observedSessionRevision = Math.max(this.observedSessionRevision, snapshot.revision);

    const items = getRenderableTimelineItems(snapshot, this.ephemeralTimelineItems.values());
    const snapshotIds = new Set(items.map((item) => this.getViewMessageId(item.id)));
    const staleIds = this.renderedMessageIds.filter((id) => !snapshotIds.has(id));
    if (staleIds.length > 0) {
      this.view.removeMessages(staleIds);
    }

    const renderedIds = new Set(this.renderedMessageIds);
    this.renderedMessageIds.splice(
      0,
      this.renderedMessageIds.length,
      ...this.renderedMessageIds.filter((id) => snapshotIds.has(id)),
    );

    for (const item of items) {
      const viewMessageId = this.getViewMessageId(item.id);
      if (item.type === "message" && this.hiddenHistoryEntryIds.has(item.id)) {
        if (!renderedIds.has(viewMessageId)) {
          this.renderedMessageIds.push(viewMessageId);
        }
        continue;
      }

      const model =
        item.type === "notice"
          ? {
              type: "transcript_notice" as const,
              title: item.title,
              ...(item.content ? { content: item.content } : {}),
              tone: item.severity === "error" ? ("error" as const) : ("default" as const),
            }
          : item.type === "tool"
            ? ({ type: "tool" as const, tool: item.model } as const)
            : this.buildProtocolMessageModel(item.message);
      if (!model) {
        continue;
      }

      if (renderedIds.has(viewMessageId)) {
        if (model.type === "assistant") {
          this.view.updateAssistantMessage(viewMessageId, model);
        } else {
          this.view.updateMessage(viewMessageId, model);
        }
      } else {
        this.renderedMessageIds.push(this.view.addMessage(model, viewMessageId));
      }
    }

    this.updateStreamingStateFromSnapshot(snapshot);
    this.syncSnapshotToolAndAgentUi(snapshot);
  }

  private buildProtocolMessageModel(message: SessionProtocolMessage): ChatMessageModel | undefined {
    if (message.message.role === "system") {
      return undefined;
    }

    if (message.message.role === "assistant" && !isAssistantMessage(message.message)) {
      const partial = assistantPartialFromProtocolMessage(message);
      if (!partial.text && !partial.thinking) {
        return undefined;
      }
      return {
        type: "assistant_partial",
        text: partial.text,
        thinking: partial.thinking,
      };
    }

    if (
      message.message.role === "toolResult" &&
      this.snapshot.tools[(message.message as ToolResultMessage).toolCallId]
    ) {
      return undefined;
    }

    if (isCoreMessage(message.message)) {
      return buildHistoryMessageModel(message.message);
    }

    return undefined;
  }

  private updateStreamingStateFromSnapshot(snapshot: SessionProtocolSnapshot): void {
    if (snapshot.lifecycle === "running") {
      this.startObservedSessionTurn();
      return;
    }
    this.finishObservedSessionTurn();
  }

  private isMessageProjected(messageId: string): boolean {
    return isMessageInTimeline(this.snapshot, messageId);
  }

  private syncSnapshotToolAndAgentUi(snapshot: SessionProtocolSnapshot): void {
    this.view.reconcileSubagentUiSession(
      Object.values(snapshot.agents).map((agent) => {
        const activityState = this.subagentActivities.agents[agent.id];
        return {
          state: structuredClone(agent),
          activities:
            activityState?.runRevision === agent.run.revision
              ? structuredClone(activityState.activities)
              : [],
        };
      }),
    );
  }

  private async syncFromSessionSnapshot(
    ephemeralTimelineItemIdsToDiscard?: ReadonlySet<string>,
  ): Promise<boolean> {
    try {
      const snapshot = await this.session.snapshot();
      for (const id of ephemeralTimelineItemIdsToDiscard ?? []) {
        this.ephemeralTimelineItems.delete(id);
      }
      if (snapshot.timeline.epoch > this.snapshot.timeline.epoch) {
        this.renderCompactedSnapshot(snapshot);
      } else {
        this.syncRenderedHistory(snapshot);
      }
      this.refreshStatus();
      return true;
    } catch (error) {
      this.view.addTranscriptNotice("failed to refresh session", "error", [
        (error as Error).message,
      ]);
      return false;
    }
  }

  private finishObservedSessionTurn(): void {
    if (!this.stopVisibleSessionTurn()) {
      return;
    }

    this.pendingIdleNotification = true;
    this.sendPendingIdleNotification();
  }

  private sendPendingIdleNotification(): void {
    if (!this.pendingIdleNotification || this.isStreaming || this.hasPendingUserMessages) {
      return;
    }

    this.pendingIdleNotification = false;
    this.view.sendTerminalNotification("tau is waiting for your input");
  }

  private stopVisibleSessionTurn(): boolean {
    if (!this.isStreaming) {
      return false;
    }
    this.isStreaming = false;
    this.assistantInterruptRequested = false;
    this.view.stopWorkingIcon();
    this.stopTurnTimer();
    this.refreshStatus();
    return true;
  }

  private startObservedSessionTurn(): void {
    if (this.isStreaming) {
      return;
    }

    this.isStreaming = true;
    this.assistantInterruptRequested = false;
    this.startTurnTimer();
    this.view.startWorkingIcon();
    this.refreshStatus();
  }

  private isSessionOperationActive(): boolean {
    return (
      this.isStreaming || this.submittedTurnInProgress || this.isBlockingSessionOperationActive()
    );
  }

  private isBlockingSessionOperationActive(): boolean {
    return (
      this.manualCompactionInProgress ||
      this.localDiffReviewInProgress ||
      this.sessionReplacementInProgress
    );
  }

  private async recoverFromRevisionGap(): Promise<void> {
    if (this.snapshotRecovery) {
      return;
    }

    this.snapshotRecovery = this.syncFromSessionSnapshotAfterRevisionGap()
      .then((synced) => {
        if (synced) {
          return this.replaySnapshotRecoveryDeltas();
        }
      })
      .finally(() => {
        this.snapshotRecovery = undefined;
      });
    await this.snapshotRecovery;
  }

  private syncFromSessionSnapshotAfterRevisionGap(): Promise<boolean> {
    return this.syncFromSessionSnapshot(new Set(this.ephemeralTimelineItems.keys()));
  }

  private async replaySnapshotRecoveryDeltas(): Promise<void> {
    while (this.snapshotRecoveryDeltas.length > 0) {
      const deltas = this.snapshotRecoveryDeltas.splice(0);
      for (let index = 0; index < deltas.length; index++) {
        const delta = deltas[index]!;
        if (this.tryApplySdkDelta(delta)) {
          continue;
        }
        if (!(await this.syncFromSessionSnapshotAfterRevisionGap())) {
          this.snapshotRecoveryDeltas.unshift(delta, ...deltas.slice(index + 1));
          return;
        }
      }
    }
  }

  private startLocalUiSession(): void {
    this.renderSegment += 1;
    this.viewMessageIds.clear();
    this.ephemeralTimelineItems.clear();
    this.hiddenHistoryEntryIds.clear();
    this.renderedMessageIds.splice(0);
    this.view.addMessage({ type: "session_divider", label: "new session" });
  }

  private startCompactedUiSession(): void {
    this.renderSegment += 1;
    this.viewMessageIds.clear();
    this.ephemeralTimelineItems.clear();
    this.hiddenHistoryEntryIds.clear();
    this.renderedMessageIds.splice(0);
    this.view.addMessage({ type: "session_divider", label: "compacted context" });
  }

  private addSessionIdentityMessage(): void {
    this.view.addTranscriptNotice("session id", "default", [this.snapshot.sessionId]);
  }

  private renderCompactedSnapshot(snapshot: SessionProtocolSnapshot): void {
    this.view.resetToolUiSessionPreservingSubagents();
    this.startCompactedUiSession();
    this.renderSnapshot(snapshot);
  }

  private renderCompactedReset(
    snapshot: SessionProtocolSnapshot,
    cause: Extract<SessionProtocolDeltaMessage["cause"], { type: "compaction" }>,
  ): void {
    this.view.resetToolUiSessionPreservingSubagents();
    this.startCompactedUiSession();
    this.renderSnapshot(snapshot);

    if (cause.kind === "auto") {
      this.view.addTranscriptNotice(formatAutoCompactionRetainedText(cause), "default");
    }
  }

  private toggleThinkingVisibility(): void {
    this.showThinking = !this.showThinking;
    this.view.setThinkingVisibility(this.showThinking);
    this.view.showFooterNotice(
      this.showThinking ? "thoughts visible" : "thoughts hidden",
      "default",
    );
  }

  private async cyclePersonality(): Promise<void> {
    const personas = this.snapshot.catalog.personas;
    if (personas.length === 0) {
      this.view.showFooterNotice("no personas available.", "default");
      return;
    }

    const currentIndex = personas.findIndex(
      (persona) => persona.id.toLowerCase() === this.snapshot.settings.personaId.toLowerCase(),
    );
    const next = personas[(currentIndex + 1 + personas.length) % personas.length]!;
    await this.setPersona(next.id);
  }

  private async cycleReasoningLevel(): Promise<void> {
    const allowed = this.getAllowedReasoningLevels(this.getCurrentPersonaSnapshot());
    const current = (this.snapshot.settings.reasoning ?? allowed[0]!) as ReasoningEffort;
    const index = allowed.indexOf(current);
    const next = allowed[(index + 1) % allowed.length] ?? allowed[0]!;

    try {
      const result = await this.session.setReasoning(next);
      this.snapshot = {
        ...this.snapshot,
        revision: result.revision,
        settings: result.settings,
      };
      this.refreshStatus();
    } catch (error) {
      this.view.addTranscriptNotice("failed to change reasoning", "error", [
        (error as Error).message,
      ]);
    }
  }

  private getAllowedReasoningLevels(
    persona: SessionProtocolSnapshot["catalog"]["personas"][number] | undefined,
  ): ReasoningEffort[] {
    if (!this.snapshot.bootstrap.model.reasoning) {
      return ["none"];
    }

    const raw = persona?.allowedReasoningLevels;
    if (!raw || raw.length === 0) {
      return REASONING_LEVELS;
    }

    const normalized = raw.filter((level): level is ReasoningEffort =>
      REASONING_LEVELS.includes(level as ReasoningEffort),
    );
    const unique = [...new Set(normalized)];
    return unique.length ? unique : REASONING_LEVELS;
  }

  private async setPersona(rawId: string): Promise<void> {
    const id = rawId.trim();
    if (!id) {
      this.view.addTranscriptNotice("missing persona id", "error");
      return;
    }

    const persona = this.snapshot.catalog.personas.find(
      (candidate) => candidate.id.toLowerCase() === id.toLowerCase(),
    );
    if (!persona) {
      this.view.addTranscriptNotice("unknown persona", "error", [id]);
      return;
    }

    if (this.isSessionOperationActive()) {
      this.view.showFooterNotice(
        "cannot switch persona while a session turn is running",
        "default",
      );
      return;
    }

    try {
      this.snapshot = await this.session.setPersona(persona.id);
      this.syncRenderedHistory(this.snapshot);
      this.refreshStatus();
      this.view.showFooterNotice(
        `switched to ${persona.label} (${this.snapshot.bootstrap.model.id})`,
        "default",
      );
    } catch (error) {
      this.view.addTranscriptNotice("failed to switch persona", "error", [
        (error as Error).message,
      ]);
    }
  }

  private async insertPrompt(rawId: string): Promise<void> {
    const id = rawId.trim();
    if (!id) {
      this.view.addTranscriptNotice("missing prompt id", "error");
      return;
    }

    const prompt = this.snapshot.catalog.prompts.find(
      (candidate) => candidate.id.toLowerCase() === id.toLowerCase(),
    );
    if (!prompt) {
      this.view.addTranscriptNotice("unknown prompt", "error", [id]);
      return;
    }

    try {
      const resolved = await this.session.resolvePrompt(prompt.id);
      this.view.setEditorText(resolved.text);
    } catch (error) {
      this.view.addTranscriptNotice("failed to load prompt", "error", [(error as Error).message]);
    }
  }

  private async reloadContent(): Promise<void> {
    if (this.isSessionOperationActive()) {
      this.view.showFooterNotice("cannot reload while a session turn is running", "default");
      return;
    }

    try {
      const result = await this.session.reload();
      this.snapshot = result.snapshot;
      this.syncRenderedHistory(this.snapshot);
      this.refreshStatus();

      for (const warning of result.warnings) {
        this.view.addTranscriptNotice("configuration warning", "default", [warning]);
      }

      const summary = [
        `${result.counts.personas} personas`,
        `${result.counts.prompts} prompts`,
        `${result.counts.skills} skills`,
        ...formatContextFileReloadSummary(this.getContextFilePaths().length),
      ].join(", ");
      this.view.showFooterNotice(`reloaded: ${summary}.`, "default");
    } catch (error) {
      this.view.addTranscriptNotice("failed to reload session content", "error", [
        (error as Error).message,
      ]);
    }
  }

  private async compactSession(
    mode: "summary-only" | "summary-and-last",
    guidanceText?: string,
  ): Promise<void> {
    if (this.isSessionOperationActive()) {
      this.view.showFooterNotice("cannot compact while a session turn is running", "default");
      return;
    }

    const guidance = guidanceText?.trim() ?? "";
    this.manualCompactionInProgress = true;
    this.refreshStatus();

    try {
      const result = await this.session.compact(mode, {
        ...(guidance ? { guidance } : {}),
      });
      if (result.snapshot.revision > this.snapshot.revision) {
        this.renderCompactedSnapshot(result.snapshot);
      }
    } catch (error) {
      const message = (error as Error).message || "compaction failed";
      this.view.addTranscriptNotice("failed to compact session", "error", [message]);
    } finally {
      this.manualCompactionInProgress = false;
      this.refreshStatus();
    }
  }

  private async handleGoalAction(
    action: { type: "show" | "resume" | "clear" } | { type: "start"; objective: string },
  ): Promise<void> {
    if (action.type === "show") {
      const goal = this.snapshot.goal;
      this.view.addTranscriptNotice(
        goal ? `goal ${goal.status}` : "no session goal",
        "default",
        goal ? [goal.objective] : undefined,
      );
      return;
    }

    if (action.type === "start") {
      await this.runSessionTurn(() => this.session.startGoal(action.objective));
      return;
    }
    if (action.type === "resume") {
      await this.runSessionTurn(() => this.session.resumeGoal());
      return;
    }

    try {
      this.snapshot = await this.session.clearGoal();
      this.refreshStatus();
      this.view.showFooterNotice("session goal cleared", "default");
    } catch (error) {
      this.view.addTranscriptNotice("failed to clear goal", "error", [(error as Error).message]);
    }
  }

  private async speakLastAssistantMessage(): Promise<void> {
    if (this.speakTask) {
      this.view.showFooterNotice("speech playback already in progress", "default");
      return;
    }

    if (this.isSessionOperationActive()) {
      this.view.showFooterNotice("wait for the assistant to finish before speaking", "default");
      return;
    }

    if (this.deps.env.platform() !== "darwin") {
      this.view.showFooterNotice("/speak is currently supported only on macOS.", "default");
      return;
    }

    const lastAssistant = this.getLastAssistantMessage();
    if (!lastAssistant) {
      this.view.showFooterNotice("no assistant message to speak yet.", "default");
      return;
    }

    const sourceText = extractAssistantText(lastAssistant).trim();
    if (!sourceText) {
      this.view.showFooterNotice("last assistant message was empty.", "default");
      return;
    }

    const apiKey = getGoogleApiKey(this.config, this.deps.env.env());
    if (!apiKey) {
      this.view.addTranscriptNotice("speech synthesis is not configured", "error", [
        "set GEMINI_API_KEY or apiKeys.google to use /speak",
      ]);
      return;
    }

    this.speechActivityLabel = "rewriting for speech";
    this.refreshStatus();
    this.view.startWorkingIcon();

    const abortController = new AbortController();
    const completion = this.runSpeakTask({
      apiKey,
      sourceText,
      signal: abortController.signal,
    });
    const task = { abortController, completion };
    this.speakTask = task;

    try {
      await completion;
    } catch (err) {
      if (abortController.signal.aborted) {
        return;
      }
      this.view.addTranscriptNotice("failed to synthesize speech", "error", [
        (err as Error).message,
      ]);
    } finally {
      if (this.speakTask === task) {
        this.speakTask = undefined;
      }
      this.speechActivityLabel = undefined;
      this.view.stopWorkingIcon();
      this.refreshStatus();
      this.view.requestRender();
    }
  }

  private async runSpeakTask(args: {
    apiKey: string;
    sourceText: string;
    signal: AbortSignal;
  }): Promise<void> {
    await runSpeechPlaybackTask({
      deps: this.deps,
      apiKey: args.apiKey,
      sourceText: args.sourceText,
      signal: args.signal,
      onActivityLabel: (hint) => {
        this.speechActivityLabel = hint;
        this.refreshStatus();
      },
    });
  }

  private refreshStatus(): void {
    const activityLabel = this.getActivityLabel();
    this.view.updateStatus({
      footer: activityLabel
        ? { type: "activity", label: activityLabel }
        : {
            type: "regular",
            cwdLabel: this.getFooterCwdLabel(),
            contextUsage: this.getContextUsageString(),
            sessionCost: this.getSessionCostString(),
            duration: this.getTurnDurationString(),
            pursuingGoal: this.snapshot.goal?.status === "active",
          },
      editor: {
        mode: this.getInputMode(),
        personaName: this.getCurrentPersonaSnapshot()?.label ?? this.snapshot.settings.personaId,
        reasoningLabel: this.snapshot.settings.reasoning ?? "none",
        reasoning:
          this.snapshot.settings.reasoning === undefined ||
          this.snapshot.settings.reasoning === "none"
            ? undefined
            : this.snapshot.settings.reasoning,
      },
    });
  }

  private getInputMode(): ChatInputMode {
    if (this.listenRecording) return "recording";
    if (this.isBashIncognito) return "bash_incognito";
    if (this.isBashMode) return "bash";
    return "normal";
  }

  private getActivityLabel(): string | undefined {
    if (this.manualCompactionInProgress || this.hasRunningCompactionOperation(this.snapshot)) {
      return "compacting context";
    }
    if (this.listenActivityLabel) {
      return this.listenActivityLabel;
    }
    return this.diffReviewService.getActivityLabel(this.speechActivityLabel);
  }

  private hasRunningCompactionOperation(snapshot: SessionProtocolSnapshot): boolean {
    return snapshot.timeline.items.some((item) => {
      if (item.type !== "operation") {
        return false;
      }
      const operation = snapshot.operations[item.operationId];
      return (
        operation?.status === "running" &&
        (operation.kind === "auto-compaction" || operation.kind === "manual-compaction")
      );
    });
  }

  private getContextUsageString(): string {
    const last = this.getLastAssistantMessage();
    const windowTokens = last
      ? this.getContextWindowForLastTurn(last)
      : this.getBootstrapContextWindow();
    const { input, read, write, output } = this.getSessionUsageTotals();
    const stats = `↑${formatFooterTokenCount(input)} ↓${formatFooterTokenCount(output)} r${formatFooterTokenCount(read)} w${formatFooterTokenCount(write)}`;
    const contextWindowUsageTokens = getAssistantContextWindowUsage(last);
    const percent = windowTokens > 0 ? (contextWindowUsageTokens / windowTokens) * 100 : 0;
    const percentStr = `${formatAdaptiveNumber(percent, 1, 3)}%`;
    return `${stats} · ${percentStr}/${formatTokenWindow(windowTokens)}`;
  }

  private getSessionCostString(): string {
    return formatSessionCost(this.snapshot.costTotal);
  }

  private getTurnDurationString(): string {
    const now = Date.now();
    const elapsed =
      this.currentTurnStartedAt !== undefined
        ? Math.max(0, now - this.currentTurnStartedAt)
        : Math.max(0, this.lastTurnDurationMs);
    return formatDurationMs(elapsed);
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
  }

  private getLastAssistantMessage(): AssistantMessage | undefined {
    for (let index = this.snapshot.messages.length - 1; index >= 0; index -= 1) {
      const message = this.snapshot.messages[index]?.message;
      if (isAssistantMessage(message)) {
        return message;
      }
    }
    return undefined;
  }

  private getSessionUsageTotals(): {
    input: number;
    read: number;
    write: number;
    output: number;
  } {
    let input = 0;
    let read = 0;
    let write = 0;
    let output = 0;
    for (const entry of this.snapshot.messages) {
      if (!isAssistantMessage(entry.message)) {
        continue;
      }
      input += entry.message.usage?.input ?? 0;
      read += entry.message.usage?.cacheRead ?? 0;
      write += entry.message.usage?.cacheWrite ?? 0;
      output += entry.message.usage?.output ?? 0;
    }
    return { input, read, write, output };
  }

  private getContextWindowForLastTurn(message: AssistantMessage): number {
    const usage = message.usage as AssistantMessage["usage"] & {
      contextWindow?: unknown;
    };
    return typeof usage.contextWindow === "number" && Number.isFinite(usage.contextWindow)
      ? usage.contextWindow
      : this.getBootstrapContextWindow();
  }

  private getBootstrapContextWindow(): number {
    return this.snapshot.bootstrap.model.contextWindow ?? 0;
  }

  private getFooterCwdLabel(): string {
    const cwd = formatPathForSessionDisplay(
      this.snapshot.executionEnvironment.cwd,
      this.snapshot.executionEnvironment.home,
    );
    return this.isRemoteSessionTarget() ? `remote · ${cwd}` : cwd;
  }

  private formatSessionIdentityText(): string {
    return `session id: ${this.snapshot.sessionId}`;
  }

  private isRemoteSessionTarget(): boolean {
    return this.targetLabel !== "in-process" || this.snapshot.executionEnvironment.kind !== "local";
  }

  private getContextFilePaths(): string[] {
    const systemPrompt = this.snapshot.messages.find((entry) => entry.message.role === "system")
      ?.message.content;
    if (typeof systemPrompt !== "string") {
      return [];
    }

    const files = new Set<string>();
    const regex = /^<file path="([^"]+)">$/gm;
    for (const match of systemPrompt.matchAll(regex)) {
      const path = unescapeXmlAttribute(match[1] ?? "");
      if (path) {
        files.add(path);
      }
    }
    return [...files];
  }

  private async copyLastAssistantText(): Promise<void> {
    await copyAssistantTextToClipboard({
      view: this.view,
      message: this.getLastAssistantMessage(),
    });
  }

  private async copyLastAssistantCode(): Promise<void> {
    await copyAssistantCodeToClipboard({
      view: this.view,
      message: this.getLastAssistantMessage(),
    });
  }

  async runClientDiffReview(rawArgs: unknown, context: TauSdkClientToolContext): Promise<string> {
    const session = this.session;
    const snapshot = this.snapshot;
    return await this.diffReviewService.runModelTool(rawArgs, context.signal, {
      startSession: (args) =>
        this.startDiffReviewBridge(args, session, snapshot, context.executionEnvironment),
    });
  }

  prefillInput(text: string): string {
    if (this.view.getEditorText().length > 0) {
      throw new Error("Cannot prefill input because the editor already contains text.");
    }

    this.view.setEditorText(text);
    return "Prefilled the input editor. The user can review, edit, and submit it.";
  }

  private async startDiffReview(argsText: string): Promise<void> {
    if (this.diffReviewService.isActive()) {
      this.view.showFooterNotice("diff review is already active.", "default");
      return;
    }

    if (!this.isDiffReviewIdle()) {
      this.view.showFooterNotice("wait for tau to become idle before starting /diff.", "default");
      return;
    }

    const session = this.session;
    const snapshot = this.snapshot;
    this.localDiffReviewInProgress = true;
    this.refreshStatus();
    try {
      await this.diffReviewService.start(argsText, {
        startSession: (args) => this.startDiffReviewBridge(args, session, snapshot),
        onReviewReturned: (review) => this.handleReturnedDiffReview(review, session),
      });
    } finally {
      this.localDiffReviewInProgress = false;
      this.refreshStatus();
    }
  }

  private isDiffReviewIdle(): boolean {
    return (
      !this.isSessionOperationActive() &&
      !this.listenRecording &&
      !this.listenTransition &&
      !this.listenActivityLabel &&
      !this.speakTask
    );
  }

  private resolveDiffToolConfig(): DiffToolConfig | undefined {
    return this.config.diffTool ?? this.defaultDiffTool;
  }

  private async startDiffReviewBridge(
    args: {
      source: DiffReviewSnapshotSource;
      diffTool: DiffToolConfig;
      signal: AbortSignal;
    },
    session: TauSdkSession,
    sessionSnapshot: SessionProtocolSnapshot,
    executionEnvironment: TauSdkClientToolExecutionEnvironment = session,
  ): Promise<StartedDiffReviewBridge> {
    const cwd = sessionSnapshot.executionEnvironment.cwd;
    const backend = createSdkToolExecutionBackend({ executionEnvironment, cwd });
    const snapshot = await captureDiffReviewSnapshot({
      cwd,
      source: args.source,
      signal: args.signal,
      deps: createSdkDiffSnapshotDeps({ backend, cwd }),
    });
    const ephemeral = await session.createEphemeralContext({
      instructions: buildDiffReviewInstructions(snapshot),
      tools: ["bash", "view_image"],
    });
    const bridge = new DiffReviewBridge({
      snapshot,
      contextWindow: sessionSnapshot.bootstrap.model.contextWindow,
      submitThreadMessage: (options) =>
        session.submitEphemeralThread({
          contextId: ephemeral.contextId,
          threadId: options.threadId,
          ...(options.forkFromThreadId ? { forkFromThreadId: options.forkFromThreadId } : {}),
          message: options.message,
          ...(options.reasoning !== undefined ? { reasoning: options.reasoning } : {}),
        }),
      deps: this.deps,
      ...(this.diffToolLauncher ? { toolLauncher: this.diffToolLauncher } : {}),
    });
    const unsubscribeEphemeral = session.onEphemeral((message) => {
      const event = message.event;
      if (
        event.type !== "ephemeral-agent.thread-update" ||
        event.contextId !== ephemeral.contextId
      ) {
        return;
      }
      bridge.applyThreadUpdate(event.threadId, {
        costTotal: event.update.costTotal,
        usage: { ...event.update.usage },
        ...(event.update.lastActivityText
          ? { lastActivityText: event.update.lastActivityText }
          : {}),
      });
    });
    try {
      await bridge.start();
      if (args.signal.aborted) {
        throw new Error("diff review start aborted");
      }
      await bridge.launchTool(args.diffTool);
    } catch (error) {
      unsubscribeEphemeral();
      await session.closeEphemeralContext(ephemeral.contextId).catch(() => undefined);
      await bridge.cancel("launch_failed").catch(() => undefined);
      await bridge.close().catch(() => undefined);
      throw error;
    }

    const result = bridge.result.finally(async () => {
      unsubscribeEphemeral();
      await session.closeEphemeralContext(ephemeral.contextId).catch(() => undefined);
    });

    return { bridge, result };
  }

  private async handleReturnedDiffReview(
    review: DiffReviewReturnedReview,
    session: TauSdkSession,
  ): Promise<void> {
    try {
      const result = await session.record(formatDiffReviewUserMessage(review), {
        historyEntryId: review.historyEntryId,
      });
      if (this.session === session) {
        this.syncRenderedHistory(result.snapshot);
      }
    } catch (error) {
      const reviewWasCommitted =
        this.session === session &&
        this.snapshot.messages.some(
          (entry) =>
            entry.id === review.historyEntryId &&
            entry.state === "committed" &&
            entry.message.role === "user",
        );
      if (!reviewWasCommitted) {
        throw error;
      }
    }
  }

  private startRewindFlow(): void {
    if (this.isSessionOperationActive()) {
      return;
    }

    const now = Date.now();
    const candidates = this.snapshot.messages.flatMap((entry) => {
      if (
        !entry.modelVisible ||
        !this.isMessageProjected(entry.id) ||
        entry.message.role !== "user" ||
        hasAutoCompactionContinuationMetadata(entry.message)
      ) {
        return [];
      }
      const text = extractHistoryUserText(entry.message);
      if (!text.trim()) {
        return [];
      }
      return [
        {
          id: entry.id,
          text,
          label: formatRewindCandidateLabel(text),
          description: formatRewindCandidateAge(entry.message.timestamp, now),
        },
      ];
    });

    if (candidates.length === 0) {
      this.view.showFooterNotice("no user messages available to rewind.", "default");
      return;
    }

    this.view.showRewindPicker({
      items: candidates.map(({ id, label, description }) => ({ id, label, description })),
      onSelect: (id) => {
        const selected = candidates.find((candidate) => candidate.id === id);
        if (!selected) {
          this.view.hideRewindPicker();
          this.view.addTranscriptNotice("failed to select rewind point", "error");
          return;
        }
        void this.applyRewindSelection(selected.id);
      },
      onCancel: () => {
        this.view.hideRewindPicker();
      },
    });
  }

  private async applyRewindSelection(historyEntryId: string): Promise<void> {
    this.view.hideRewindPicker();

    try {
      const rewound = await this.session.rewindToHistoryEntryId(historyEntryId);
      this.syncRenderedHistory(rewound.snapshot);
      this.view.removeMessagesFrom(rewound.historyEntryId);
      this.view.removeMessages(rewound.removedEntryIds);
      this.view.setEditorText(rewound.text);
      this.refreshStatus();
    } catch {
      this.view.addTranscriptNotice("failed to rewind session", "error");
    }
  }

  private interruptSelectedSubagent(): void {
    const selectedId = this.view.getSelectedSubagentId();
    if (!selectedId) {
      this.view.showFooterNotice("no active subagent selected", "default");
      return;
    }

    void this.session
      .interruptSubagent(selectedId)
      .then((result) => {
        if (!result.found) {
          this.view.showFooterNotice(`unknown subagent id: ${selectedId}`, "default");
        }
      })
      .catch((err) => {
        this.view.addTranscriptNotice("failed to interrupt subagent", "error", [
          (err as Error).message,
        ]);
      });
  }

  private async stashEditorToClipboard(): Promise<void> {
    const text = this.view.getExpandedEditorText();
    if (!text.trim()) {
      this.view.showFooterNotice("no input to stash yet", "default");
      return;
    }

    try {
      await copyTextToClipboard(text);
      this.view.setEditorText("");
      this.view.showFooterNotice("stashed input to clipboard", "default");
    } catch (err) {
      this.view.addTranscriptNotice("failed to copy to clipboard", "error", [
        (err as Error).message,
      ]);
    }
  }

  private isSingleLineInput(text: string): boolean {
    return !/[\r\n]/.test(text);
  }

  private getCurrentPersonaSnapshot():
    | SessionProtocolSnapshot["catalog"]["personas"][number]
    | undefined {
    return this.snapshot.catalog.personas.find(
      (persona) => persona.id.toLowerCase() === this.snapshot.settings.personaId.toLowerCase(),
    );
  }
}

function formatSessionError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const data =
    typeof error === "object" && error !== null ? (error as { data?: unknown }).data : undefined;
  const cause =
    typeof data === "object" &&
    data !== null &&
    "cause" in data &&
    typeof data.cause === "string" &&
    data.cause.trim()
      ? data.cause.trim()
      : undefined;
  return cause && cause !== message ? `${message}: ${cause}` : message;
}

type RenderableTimelineItem =
  | { type: "message"; id: string; message: SessionProtocolMessage }
  | { type: "tool"; id: string; model: ToolUiModel }
  | {
      type: "notice";
      id: string;
      severity: "info" | "warn" | "error";
      title: string;
      content?: string[];
    };

function getRenderableTimelineItems(
  snapshot: SessionProtocolSnapshot,
  ephemeralItems: Iterable<SessionProtocolTimelineItem>,
): RenderableTimelineItem[] {
  const messagesById = new Map(snapshot.messages.map((message) => [message.id, message]));
  const items = [...snapshot.timeline.items, ...ephemeralItems].sort(
    (left, right) => left.sequence - right.sequence,
  );

  return items.flatMap((item): RenderableTimelineItem[] => {
    if (item.type === "notice") {
      return [
        {
          type: "notice",
          id: item.id,
          severity: item.notice.severity,
          title: item.notice.presentation.title,
          ...(item.notice.presentation.content
            ? { content: item.notice.presentation.content }
            : {}),
        },
      ];
    }
    if (item.type === "message") {
      const message = messagesById.get(item.messageId);
      if (!message) {
        return [];
      }
      const outcomeNotice = getMessageOutcomeNotice(message);
      return [
        { type: "message", id: message.id, message },
        ...(outcomeNotice ? [outcomeNotice] : []),
      ];
    }
    if (item.type === "tool") {
      const tool = snapshot.tools[item.toolId];
      return tool ? [{ type: "tool", id: item.id, model: buildToolUiModel(snapshot, tool) }] : [];
    }
    return [];
  });
}

function getMessageOutcomeNotice(
  message: SessionProtocolMessage,
): Extract<RenderableTimelineItem, { type: "notice" }> | undefined {
  if (!isAssistantMessage(message.message)) {
    return undefined;
  }
  if (message.message.stopReason === "error") {
    const afterToolExecution = message.message.content.some(
      (content) => content.type === "toolCall",
    );
    return {
      type: "notice",
      id: `presentation:failure:${message.id}`,
      severity: "error",
      title: afterToolExecution
        ? "model request failed after tool execution"
        : "model request failed",
      content: [message.message.errorMessage ?? "the model provider returned an unknown error"],
    };
  }
  if (message.state === "interrupted") {
    return {
      type: "notice",
      id: `presentation:interruption:${message.id}`,
      severity: "info",
      title: "assistant turn interrupted",
    };
  }
  return undefined;
}

function isMessageInTimeline(snapshot: SessionProtocolSnapshot, messageId: string): boolean {
  return snapshot.timeline.items.some(
    (item) => item.type === "message" && item.messageId === messageId,
  );
}

function assistantPartialFromProtocolMessage(message: SessionProtocolMessage): {
  text: string;
  thinking: string;
} {
  if (message.message.role !== "assistant") {
    return { text: "", thinking: "" };
  }

  let text = "";
  const thinking: string[] = [];
  for (const content of message.message.content) {
    if (content.type === "text") {
      text += content.text;
    }
    if (content.type === "thinking") {
      thinking.push(content.thinking);
    }
  }
  return { text, thinking: thinking.join("\n\n") };
}

function isAssistantMessage(
  message: SessionProtocolMessage["message"] | undefined,
): message is AssistantMessage {
  return (
    message?.role === "assistant" &&
    "usage" in message &&
    "api" in message &&
    typeof message.stopReason === "string"
  );
}

function getAssistantContextWindowUsage(message: AssistantMessage | undefined): number {
  if (!message?.usage) {
    return 0;
  }
  const usage = message.usage as AssistantMessage["usage"] & {
    contextWindowUsageTokens?: unknown;
  };
  if (
    typeof usage.contextWindowUsageTokens === "number" &&
    Number.isFinite(usage.contextWindowUsageTokens)
  ) {
    return usage.contextWindowUsageTokens;
  }

  return (
    (message.usage.input ?? 0) +
    (message.usage.cacheRead ?? 0) +
    (message.usage.cacheWrite ?? 0) +
    (message.usage.output ?? 0)
  );
}

function formatPathForSessionDisplay(path: string, home: string): string {
  if (!home) {
    return path;
  }
  if (path === home) {
    return "~";
  }
  if (path.startsWith(`${home}/`)) {
    return `~${path.slice(home.length)}`;
  }
  return path;
}

function formatContextFileReloadSummary(count: number): string[] {
  if (count <= 0) {
    return [];
  }
  return [`${count} context file${count === 1 ? "" : "s"}`];
}

function formatAutoCompactionRetainedText(result: {
  cutType: "turn-boundary" | "split-turn";
  retainedMessageCount: number;
}): string {
  const count = result.retainedMessageCount;
  const messageLabel = count === 1 ? "message" : "messages";
  if (result.cutType === "split-turn") {
    return `retained current turn suffix, ${count} ${messageLabel}`;
  }
  return `retained ${count} recent ${messageLabel}`;
}

function unescapeXmlAttribute(value: string): string {
  return value
    .replaceAll("&quot;", '"')
    .replaceAll("&apos;", "'")
    .replaceAll("&lt;", "<")
    .replaceAll("&gt;", ">")
    .replaceAll("&amp;", "&");
}

function isCoreMessage(message: SessionProtocolMessage["message"]): message is Message {
  switch (message.role) {
    case "user":
      return typeof message.content === "string" || Array.isArray(message.content);
    case "assistant":
      return isAssistantMessage(message);
    case "toolResult":
      return true;
    default:
      return false;
  }
}

const RECOVERED_TOOL_ACTION_LABELS = {
  preparing: "preparing",
  queued: "queued",
  running: "running",
  succeeded: "completed",
  failed: "failed",
  blocked: "blocked",
  cancelled: "cancelled",
};

function buildToolUiModel(
  snapshot: SessionProtocolSnapshot,
  tool: SessionProtocolToolRun,
): ToolUiModel {
  const facet = Object.values(snapshot.facets).find(
    (candidate) =>
      candidate.kind === "tau.tool-ui-events" &&
      candidate.subject.type === "tool" &&
      candidate.subject.id === tool.id,
  );
  return {
    toolCallId: tool.toolCallId,
    status: tool.status,
    presentation: getToolPresentation(snapshot, tool, facet),
  };
}

function getToolPresentation(
  snapshot: SessionProtocolSnapshot,
  tool: SessionProtocolToolRun,
  facet: SessionProtocolSnapshot["facets"][string] | undefined,
) {
  if (facet?.kind !== "tau.tool-ui-events" || facet.version !== TOOL_UI_FACET_VERSION) {
    return buildRecoveredToolPresentation(snapshot, tool);
  }
  if (!Array.isArray(facet.data.events)) {
    throw new Error(`missing tool presentation for '${tool.toolCallId}'`);
  }
  const event = facet.data.events.at(-1);
  if (
    typeof event !== "object" ||
    event === null ||
    !("toolCallId" in event) ||
    event.toolCallId !== tool.toolCallId ||
    !("presentation" in event)
  ) {
    throw new Error(`missing tool presentation for '${tool.toolCallId}'`);
  }
  return parseToolRunPresentation(event.presentation);
}

function buildRecoveredToolPresentation(
  snapshot: SessionProtocolSnapshot,
  tool: SessionProtocolToolRun,
) {
  const result = getRecoveredToolResult(snapshot, tool);
  return buildToolRunPresentation({
    toolName: tool.toolName,
    subject: tool.toolName,
    details: result ? [{ text: result, wrap: "character" }] : [],
    actionOverrides: RECOVERED_TOOL_ACTION_LABELS,
  });
}

function getRecoveredToolResult(
  snapshot: SessionProtocolSnapshot,
  tool: SessionProtocolToolRun,
): string | undefined {
  if (tool.status === "streaming") {
    return undefined;
  }

  const resultEntry = tool.resultMessageId
    ? snapshot.messages.find((entry) => entry.id === tool.resultMessageId)
    : snapshot.messages.find(
        (entry) =>
          entry.message.role === "toolResult" && entry.message.toolCallId === tool.toolCallId,
      );
  const resultMessage = resultEntry?.message;
  if (resultMessage?.role === "toolResult" && resultMessage.toolCallId === tool.toolCallId) {
    const text = resultMessage.content
      .filter((block): block is { type: "text"; text: string } => block.type === "text")
      .map((block) => block.text)
      .join("\n")
      .trimEnd();
    if (text) {
      return text;
    }
  }

  return tool.error?.trim() || tool.summary?.trim() || undefined;
}

function subagentUiEventsFromAgentRun(
  agent: SessionProtocolSnapshot["agents"][string],
  startedType: "subagent_spawned" | "subagent_run_started" = "subagent_spawned",
): SubagentEvent[] {
  const state = structuredClone(agent);
  const events: SubagentEvent[] = [{ type: startedType, state }];
  if (agent.run.interruptRequested) {
    events.push({ type: "subagent_interrupt_requested", state });
  }
  if (agent.run.status !== "running") {
    events.push({ type: "subagent_finished", state });
  }
  return events;
}

function subagentUiEventsForAgentDelta(
  previous: SessionProtocolSnapshot["agents"][string] | undefined,
  next: SessionProtocolSnapshot["agents"][string],
): SubagentEvent[] {
  if (!previous) {
    return subagentUiEventsFromAgentRun(next);
  }
  if (previous.run.revision !== next.run.revision) {
    return subagentUiEventsFromAgentRun(next, "subagent_run_started");
  }

  const state = structuredClone(next);
  const events: SubagentEvent[] = [];
  if (!previous.run.interruptRequested && next.run.interruptRequested) {
    events.push({ type: "subagent_interrupt_requested", state });
  }
  if (previous.run.status === "running" && next.run.status !== "running") {
    events.push({ type: "subagent_finished", state });
    return events;
  }
  if (agentStateChanged(previous, next)) {
    events.push({ type: "subagent_updated", state });
  }
  return events;
}

function agentStateChanged(
  previous: SessionProtocolSnapshot["agents"][string],
  next: SessionProtocolSnapshot["agents"][string],
): boolean {
  return (
    previous.costTotal !== next.costTotal ||
    previous.usage.input !== next.usage.input ||
    previous.usage.output !== next.usage.output ||
    previous.usage.cacheRead !== next.usage.cacheRead ||
    previous.usage.cacheWrite !== next.usage.cacheWrite ||
    previous.usage.contextWindowUsageTokens !== next.usage.contextWindowUsageTokens ||
    previous.usage.contextWindow !== next.usage.contextWindow
  );
}
