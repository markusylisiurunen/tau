import { randomUUID } from "node:crypto";
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
import { SUBAGENT_ACTIVITY_FACET_KIND, type SubagentUiEvent } from "../core/subagents/types.js";
import type { ToolActivity } from "../core/tools/activity.js";
import { REASONING_LEVELS, type ReasoningEffort } from "../core/types.js";
import { formatAdaptiveNumber, formatTokenWindow } from "../core/utils/format.js";
import { extractAssistantText } from "../core/utils/messages.js";
import { collectSpeechToTextContext } from "../core/utils/speech_to_text_context.js";
import {
  getAutoCompactionMetadataFromMessage,
  hasAutoCompactionContinuationMetadata,
} from "../core/utils/user_metadata.js";
import { APP_VERSION } from "../core/version.js";
import type {
  SessionProtocolCreateParams,
  SessionProtocolDeltaMessage,
  SessionProtocolMessage,
  SessionProtocolPendingUserMessagesMessage,
  SessionProtocolSnapshot,
} from "../protocol/session_protocol.js";
import { applySessionProtocolDelta } from "../protocol/session_protocol.js";
import type {
  TauSdkSession,
  TauSdkSessionRetryResult,
  TauSdkSessionSubmitResult,
} from "../sdk/types.js";
import { TauSessionProtocolResponseError } from "../transport/errors.js";
import {
  copyAssistantCodeToClipboard,
  copyAssistantTextToClipboard,
} from "./chat_controller/assistant_clipboard.js";
import { getCommandHint } from "./chat_controller/command_hints.js";
import {
  type DiffReviewReturnedReview,
  DiffReviewService,
} from "./chat_controller/diff_review_service.js";
import { formatDiffReviewUserMessage } from "./chat_controller/diff_review_user_message.js";
import { formatRewindCandidateLabel } from "./chat_controller/history_labels.js";
import {
  buildHistoryMessageModel,
  extractHistoryUserText,
} from "./chat_controller/history_message_model.js";
import { InterruptLifecycle } from "./chat_controller/interrupt_lifecycle.js";
import { formatDurationMs, formatSessionCost } from "./chat_controller/status_format.js";
import type { ChatInputMode, ChatView, ChatViewInputHandlers } from "./chat_view.js";
import { copyTextToClipboard } from "./clipboard.js";
import { DOUBLE_PRESS_WINDOW_MS } from "./constants.js";
import {
  cleanupListenTempFile,
  createListenTempFilePath,
  getSpeechToTextApiKey,
  getSpeechToTextApiKeyErrorMessage,
  LISTEN_RECORDING_MAX_DURATION_MS,
  LISTEN_RECORDING_MIN_BYTES,
  type ListenRecording,
  readListenAudio,
  startListenAudioCapture,
  transcribeListenAudio,
} from "./listen_capture.js";
import {
  createSdkDiffSnapshotDeps,
  createSdkToolExecutionBackend,
} from "./session_tool_execution_backend.js";
import { runSpeechPlaybackTask } from "./speech_playback.js";
import type { ChatMessageModel } from "./ui/chat_message_model.js";
import type { ToolUiModel } from "./ui/tool_ui_model.js";

type TurnCaffeinateSession = {
  abortController: AbortController;
  completion: Promise<unknown>;
};

const CAFFEINATE_COMMAND = "/usr/bin/caffeinate";

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
  caffeinated?: boolean;
  themeIds?: string[];
  onExit?: () => void;
};

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
  private readonly themeIds: string[];
  private readonly commandRegistry: CommandRegistry<CommandDispatchContext>;
  private readonly commandHandlers: CommandDispatchContext;
  private readonly interruptLifecycle = new InterruptLifecycle();
  private readonly diffReviewService: DiffReviewService;
  private snapshot: SessionProtocolSnapshot;
  private readonly renderedMessageIds: string[] = [];
  private readonly hiddenHistoryEntryIds = new Set<string>();
  private readonly clientRenderedUserMessages = new Map<string, ChatMessageModel>();
  private observedSessionRevision: number;
  private eventUnsubscribe?: () => void;
  private pendingUserMessagesUnsubscribe?: () => void;
  private snapshotRecovery?: Promise<void>;
  private readonly snapshotRecoveryDeltas: SessionProtocolDeltaMessage[] = [];
  private hasPendingUserMessages = false;
  private pendingIdleNotification = false;
  private isStreaming = false;
  private submittedTurnInProgress = false;
  private manualCompactionInProgress = false;
  private localDiffReviewInProgress = false;
  private sessionReplacementInProgress = false;
  private isBashMode = false;
  private isBashIncognito = false;
  private showThinking = false;
  private compactToolUi = true;
  private commandHint?: string;
  private currentTurnStartedAt?: number;
  private lastTurnDurationMs = 0;
  private turnTimer?: ReturnType<typeof setInterval>;
  private lastEmptySubmitAt?: number;
  private assistantMessages: AssistantMessage[] = [];
  private listenRecording?: ListenRecording;
  private listenTransition?: Promise<void>;
  private isTranscribingListen = false;
  private speechStatusHint?: string;
  private readonly caffeinated: boolean;
  private turnCaffeinate?: TurnCaffeinateSession;
  private disableCaffeinateForSession = false;
  private speakTask?: {
    abortController: AbortController;
    completion: Promise<void>;
  };

  constructor(options: SessionChatControllerOptions) {
    this.view = options.view;
    this.session = options.session;
    this.createSession = options.createSession;
    this.snapshot = options.snapshot;
    this.targetLabel = options.targetLabel;
    this.configuredClientToolNames = options.configuredClientToolNames ?? [];
    this.config = options.config ?? {};
    this.defaultDiffTool = options.defaultDiffTool;
    this.diffToolLauncher = options.diffToolLauncher;
    this.deps = options.deps ?? createDefaultCoreDeps();
    this.themeIds = options.themeIds ?? [];
    this.caffeinated = options.caffeinated ?? false;
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
      listen: () => this.startListenCaptureFromCommand(),
      speak: () => this.speakLastAssistantMessage(),
      persona: (id) => this.setPersona(id),
      prompt: (id) => this.insertPrompt(id),
      theme: (id) => this.switchTheme(id),
      unknown: () => this.view.addSystemMessage("unknown command. type /help.", "error"),
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
    this.view.setCompactToolUi(this.compactToolUi);
    this.view.addMessage({
      type: "app_intro",
      title: this.buildStartupIntroTitle(),
      body: this.buildStartupIntroBody().join("\n"),
    });
    this.renderSnapshot(this.snapshot);
    this.hydrateRunningSnapshotState();
    this.eventUnsubscribe = this.session.onDelta((delta) => this.onSdkDelta(delta));
    this.pendingUserMessagesUnsubscribe = this.session.onPendingUserMessages((message) =>
      this.onSdkPendingUserMessages(message),
    );
    this.refreshStatus();
  }

  async dispose(): Promise<void> {
    this.eventUnsubscribe?.();
    this.pendingUserMessagesUnsubscribe?.();
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
    await this.stopTurnCaffeinate();
    this.stopTurnTimer();
    try {
      await this.session.unobserve();
    } catch {
      // The transport may already be closing; detach is best-effort during UI disposal.
    }
  }

  getInputHandlers(): ChatViewInputHandlers {
    return {
      onCtrlT: () => this.toggleThinkingVisibility(),
      onCtrlO: () => this.toggleCompactToolUi(),
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
        this.view.addSystemMessage("wait for tau to become idle before submitting input", "warn");
        return;
      }
      if (trimmed.startsWith("/") && this.isSingleLineInput(text)) {
        const parsed = this.commandRegistry.parse(trimmed);
        if (parsed.type !== "unknown") {
          if (this.isStreaming && this.commandRegistry.allowsDuringStreaming(parsed)) {
            await this.commandRegistry.dispatch(parsed, this.commandHandlers);
          } else {
            this.view.addSystemMessage(
              "wait for tau to become idle before running commands",
              "warn",
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

    await this.submitUserText(trimmed);
  }

  public async onUserInput(text: string): Promise<void> {
    await this.handleSubmit(text);
  }

  private showHelp(): void {
    this.view.addSystemMessage(
      this.commandRegistry.buildHelpText({
        agentsFiles: this.getAgentsFilePaths(),
        skills: this.snapshot.catalog.skills,
        themes: this.themeIds,
        formatPath: (path) =>
          formatPathForSessionDisplay(path, this.snapshot.executionEnvironment.home),
      }),
      "muted",
    );
  }

  private switchTheme(themeId: string): void {
    this.view.updateTheme({ themeId });
    this.view.addSystemMessage(`theme set to ${themeId}`, "success");
  }

  private handleEditorChange(text: string): void {
    const wasBash = this.isBashMode;
    const wasBashIncognito = this.isBashIncognito;
    const previousCommandHint = this.commandHint;

    if (text.trim().length > 0) {
      this.lastEmptySubmitAt = undefined;
    }

    const trimmed = text.trimStart();
    const isIncognito = trimmed.startsWith("!!");
    this.isBashIncognito = isIncognito;
    this.isBashMode = trimmed.startsWith("!") && !isIncognito;
    this.commandHint = this.getCommandHintForInput(text);

    if (
      wasBash !== this.isBashMode ||
      wasBashIncognito !== this.isBashIncognito ||
      previousCommandHint !== this.commandHint
    ) {
      this.refreshStatus();
    }
  }

  private getCommandHintForInput(text: string): string | undefined {
    const trimmed = text.trimStart();
    if (!trimmed.startsWith("/") || !this.isSingleLineInput(text)) {
      return undefined;
    }
    const parsed = this.commandRegistry.parse(trimmed);
    if (parsed.type === "unknown") {
      return undefined;
    }
    return getCommandHint(parsed);
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
    const agentsFiles = this.getAgentsFilePaths();
    if (agentsFiles.length > 0) {
      parts.push(`${agentsFiles.length} AGENTS.md`);
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

    const agentsFiles = this.getAgentsFilePaths().map((path) =>
      formatPathForSessionDisplay(path, this.snapshot.executionEnvironment.home),
    );
    if (agentsFiles.length > 0) {
      lines.push("", "context:");
      for (const agentsFile of agentsFiles) {
        lines.push(`  ${agentsFile}`);
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

  private async submitUserText(text: string): Promise<void> {
    const historyEntryId = `session-user-${randomUUID()}`;
    const model: ChatMessageModel = { type: "user", text };
    this.clientRenderedUserMessages.set(historyEntryId, model);
    this.view.addMessage(model, historyEntryId);
    this.renderedMessageIds.push(historyEntryId);
    await this.runSessionTurn(() => this.session.submit(text, { historyEntryId }));
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
    const headerTarget = command.split(/\r?\n/, 1)[0] ?? command;

    this.isStreaming = true;
    this.startTurnTimer();
    this.view.startWorkingIcon();
    this.view.updateLocalToolUi({
      toolCallId,
      toolName: "bash",
      status: "running",
      headerTarget,
      activity: {
        type: "bash_started",
        toolCallId,
        command,
        headerTarget,
      },
    });
    this.refreshStatus();

    try {
      const backend = createSdkToolExecutionBackend({
        session: this.session,
        cwd: this.snapshot.executionEnvironment.cwd,
      });
      const result = await runDirectBashCommand({
        command,
        backend,
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
        this.renderedMessageIds.push(result.userHistoryEntryId);
      }
      this.view.updateLocalToolUi({
        toolCallId,
        toolName: "bash",
        status: result.exitCode === 0 ? "succeeded" : "failed",
        headerTarget,
        activity: {
          type: "bash_execution",
          toolCallId,
          command: result.command,
          headerTarget,
          exitCode: result.exitCode,
          truncationInfo: result.truncationInfo,
          uiText: result.uiText,
          durationMs: result.durationMs,
          labelOverride: options.labelOverride,
        },
        resultText: result.uiText.fullLines.map((line) => line.text).join("\n"),
      });
      await this.syncFromSessionSnapshot();
    } catch (error) {
      const reason = (error as Error).message || "bash failed";
      this.view.updateLocalToolUi({
        toolCallId,
        toolName: "bash",
        status: "blocked",
        headerTarget,
        activity: {
          type: "bash_blocked",
          toolCallId,
          command,
          headerTarget,
          reason,
        },
        resultText: reason,
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
      await this.submitUserText(trimmed);
      return;
    }

    if (this.isBlockingSessionOperationActive()) {
      this.view.addSystemMessage("wait for tau to become idle before submitting input", "warn");
      return;
    }

    this.submitSteeringText(trimmed);
  }

  private submitQueuedText(text: string): void {
    void this.session
      .queue(text, { historyEntryId: `session-queue-${randomUUID()}` })
      .catch((error) => {
        if (!this.isPendingMessageCancellation(error)) {
          this.view.addSystemMessage(`queueing failed: ${formatSessionError(error)}`, "error");
        }
      });
  }

  private submitSteeringText(text: string): void {
    void this.session.steer(text).catch((error) => {
      if (!this.isPendingMessageCancellation(error)) {
        this.view.addSystemMessage(`steering failed: ${formatSessionError(error)}`, "error");
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
      this.view.addSystemMessage(
        `pending message cancellation failed: ${(error as Error).message}`,
        "error",
      );
    }
  }

  private isPendingMessageCancellation(error: unknown): boolean {
    return error instanceof TauSessionProtocolResponseError && error.code === "cancelled";
  }

  private cycleSubagentSelection(): void {
    this.view.cycleSubagentSelection(1);
    this.view.requestRender();
  }

  private startTurnCaffeinate(): void {
    if (!this.caffeinated || this.disableCaffeinateForSession || this.turnCaffeinate) {
      return;
    }

    if (this.deps.env.platform() !== "darwin") {
      this.disableCaffeinateForSession = true;
      return;
    }

    const abortController = new AbortController();
    const completion = this.deps.spawn(CAFFEINATE_COMMAND, ["-i"], {
      detached: true,
      killProcessGroup: true,
      signal: abortController.signal,
      stdio: ["ignore", "ignore", "ignore"],
    });
    completion.catch(() => {});
    this.turnCaffeinate = { abortController, completion };
  }

  private async stopTurnCaffeinate(): Promise<void> {
    const session = this.turnCaffeinate;
    if (!session) {
      return;
    }

    this.turnCaffeinate = undefined;
    if (!session.abortController.signal.aborted) {
      session.abortController.abort();
    }

    try {
      await session.completion;
    } catch (error) {
      if (this.disableCaffeinateForSession) {
        return;
      }
      this.disableCaffeinateForSession = true;
      this.view.addSystemMessage(`failed to run caffeinate: ${(error as Error).message}`, "warn");
    }
  }

  private async runSessionTurn(
    task: () => Promise<TauSdkSessionSubmitResult | TauSdkSessionRetryResult>,
  ): Promise<void> {
    if (this.isSessionOperationActive()) {
      return;
    }

    this.isStreaming = true;
    this.submittedTurnInProgress = true;
    this.startTurnTimer();
    this.startTurnCaffeinate();
    this.view.startWorkingIcon();
    this.refreshStatus();

    try {
      const result = await task();
      if (result.turn.status === "blocked") {
        this.view.addSystemMessage(`turn blocked: ${result.turn.message}`, "error");
      } else if (result.turn.status === "failed") {
        this.view.addSystemMessage(
          `turn failed: ${result.turn.errorMessage ?? "model provider returned an error"}`,
          "error",
        );
      }
      await this.syncFromSessionSnapshot();
    } catch (error) {
      this.view.addSystemMessage(`session turn failed: ${formatSessionError(error)}`, "error");
      this.stopVisibleSessionTurn();
      void this.stopTurnCaffeinate();
      await this.syncFromSessionSnapshot();
    } finally {
      this.submittedTurnInProgress = false;
      this.stopVisibleSessionTurn();
      await this.stopTurnCaffeinate();
      this.refreshStatus();
    }
  }

  private async interrupt(): Promise<void> {
    if (this.interruptLifecycle.interruptActiveTask()) {
      this.view.addSystemMessage("interrupted", "error");
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
      this.view.addSystemMessage("interrupted", "error");
      return;
    }

    if (!this.isStreaming) {
      return;
    }

    try {
      const result = await this.session.interrupt();
      this.view.addSystemMessage(
        result.interrupted ? "interrupted" : "interrupt requested",
        "error",
      );
    } catch (error) {
      this.view.addSystemMessage(`interrupt failed: ${(error as Error).message}`, "error");
    }
  }

  private async toggleListenCapture(): Promise<void> {
    if (this.listenTransition) {
      this.view.addSystemMessage("speech recording state change already in progress", "warn");
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
      this.view.addSystemMessage("speech recording state change already in progress", "warn");
      return;
    }

    if (this.listenRecording) {
      this.view.addSystemMessage("speech recording already in progress", "warn");
      return;
    }

    if (this.isTranscribingListen) {
      this.view.addSystemMessage("speech transcription already in progress", "warn");
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
      this.view.addSystemMessage("/listen is currently supported only on macOS.", "warn");
      return;
    }

    const apiKey = getSpeechToTextApiKey(this.config, this.deps);
    if (!apiKey) {
      this.view.addSystemMessage(
        getSpeechToTextApiKeyErrorMessage(this.config, "use /listen"),
        "error",
      );
      return;
    }

    let audioPath: string | undefined;
    try {
      audioPath = await createListenTempFilePath(this.deps);
      const abortController = new AbortController();
      const completion = startListenAudioCapture({
        deps: this.deps,
        audioPath,
        signal: abortController.signal,
      });

      const recording: ListenRecording = {
        audioPath,
        stopRequested: false,
        abortController,
        completion,
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
      if (audioPath) {
        await cleanupListenTempFile(audioPath);
      }
      this.view.addSystemMessage(`failed to start recording: ${(err as Error).message}`, "error");
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
      this.view.addSystemMessage(`recording failed: ${(err as Error).message}`, "error");
      await cleanupListenTempFile(recording.audioPath);
      return;
    }

    this.isTranscribingListen = true;
    try {
      const audio = await readListenAudio(recording.audioPath);
      if (audio.byteLength < LISTEN_RECORDING_MIN_BYTES) {
        this.view.addSystemMessage("recording too short, try again", "warn");
        return;
      }

      const transcript = await transcribeListenAudio({
        config: this.config,
        deps: this.deps,
        audio,
        context: collectSpeechToTextContext(this.snapshot),
      });
      const text = transcript.trim();
      if (!text) {
        return;
      }

      this.view.insertEditorTextAtCursor(text);
    } catch (err) {
      this.view.addSystemMessage(`speech transcription failed: ${(err as Error).message}`, "error");
    } finally {
      this.isTranscribingListen = false;
      await cleanupListenTempFile(recording.audioPath);
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
      this.view.setEditorInputEnabled(true);
      this.refreshStatus();
      const detail =
        result.exitCode !== null
          ? `ffmpeg exited with code ${result.exitCode}`
          : result.closeSignal
            ? `ffmpeg terminated by signal ${result.closeSignal}`
            : "ffmpeg exited";
      this.view.addSystemMessage(`recording stopped unexpectedly (${detail})`, "error");
      await cleanupListenTempFile(recording.audioPath);
    } catch (err) {
      this.clearListenRecordingMaxDurationTimeout(recording);
      if (this.listenRecording !== recording || recording.stopRequested) return;

      this.listenRecording = undefined;
      this.view.setEditorInputEnabled(true);
      this.refreshStatus();
      const error = err as NodeJS.ErrnoException;
      if (error.code === "ENOENT") {
        this.view.addSystemMessage(
          "ffmpeg not found. install it with: brew install ffmpeg",
          "error",
        );
      } else {
        this.view.addSystemMessage(`recording failed: ${error.message}`, "error");
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
      this.view.addSystemMessage(
        "cannot create a new session while another session operation is running",
        "warn",
      );
      return;
    }

    if (!this.createSession) {
      this.view.addSystemMessage("new session creation is unavailable", "error");
      return;
    }

    const createInput: SessionProtocolCreateParams = {
      executionEnvironment: this.createExecutionEnvironmentInputFromSnapshot(),
      personaId: this.snapshot.settings.personaId,
      ...(this.snapshot.settings.reasoning !== undefined
        ? { reasoning: this.snapshot.settings.reasoning }
        : {}),
    };
    this.sessionReplacementInProgress = true;
    this.refreshStatus();

    let nextSession: TauSdkSession | undefined;
    let nextEventUnsubscribe: (() => void) | undefined;
    let nextPendingUserMessagesUnsubscribe: (() => void) | undefined;
    let installed = false;
    try {
      nextSession = await this.createSession(createInput);
      const nextSnapshot = await nextSession.snapshot();
      const pendingDeltas: SessionProtocolDeltaMessage[] = [];
      const pendingUserMessages: SessionProtocolPendingUserMessagesMessage[] = [];
      let forwardEvents = false;
      nextEventUnsubscribe = nextSession.onDelta((delta) => {
        if (forwardEvents) {
          this.onSdkDelta(delta);
        } else {
          pendingDeltas.push(delta);
        }
      });
      nextPendingUserMessagesUnsubscribe = nextSession.onPendingUserMessages((message) => {
        if (forwardEvents) {
          this.onSdkPendingUserMessages(message);
        } else {
          pendingUserMessages.push(message);
        }
      });

      const previousSession = this.session;
      this.eventUnsubscribe?.();
      this.pendingUserMessagesUnsubscribe?.();
      this.session = nextSession;
      this.snapshot = nextSnapshot;
      this.observedSessionRevision = nextSnapshot.revision;
      this.eventUnsubscribe = nextEventUnsubscribe;
      this.pendingUserMessagesUnsubscribe = nextPendingUserMessagesUnsubscribe;
      installed = true;

      this.view.resetToolUiSession();
      this.assistantMessages = [];
      this.startLocalUiSession();
      this.addSessionIdentityMessage();
      this.renderSnapshot(this.snapshot);
      for (const delta of pendingDeltas) {
        this.onSdkDelta(delta);
      }
      for (const message of pendingUserMessages) {
        this.onSdkPendingUserMessages(message);
      }
      forwardEvents = true;

      try {
        await previousSession.unobserve();
      } catch (detachError) {
        this.view.addSystemMessage(
          `old session unobserve failed: ${(detachError as Error).message}`,
          "warn",
        );
      }
    } catch (error) {
      if (!installed && nextSession) {
        nextEventUnsubscribe?.();
        nextPendingUserMessagesUnsubscribe?.();
        await nextSession.unobserve().catch(() => undefined);
      }
      this.view.addSystemMessage(`new session failed: ${(error as Error).message}`, "error");
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
    if (delta.delta.type === "snapshot.reset" && delta.toRevision < this.snapshot.revision) {
      return true;
    }

    if (delta.delta.type === "snapshot.patch" && delta.toRevision <= this.snapshot.revision) {
      return true;
    }

    if (delta.delta.type === "snapshot.patch" && delta.fromRevision !== this.snapshot.revision) {
      return false;
    }

    try {
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
      if (this.shouldRenderAutoCompactedReset(delta)) {
        this.renderAutoCompactedReset(nextSnapshot);
      } else {
        this.syncRenderedHistory(nextSnapshot);
      }
      this.refreshStatus();
    } catch (error) {
      this.view.addSystemMessage(`session delta failed: ${(error as Error).message}`, "warn");
      return false;
    }
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
      !isMessageInTimeline(nextSnapshot, message.id)
    ) {
      return true;
    }

    const model = this.buildProtocolMessageModel(message);
    if (!model) {
      return true;
    }

    if (this.renderedMessageIds.includes(message.id)) {
      if (model.type === "assistant" || model.type === "assistant_partial") {
        this.view.updateAssistantMessage(message.id, model);
      } else {
        this.view.updateMessage(message.id, model);
      }
    } else {
      this.renderedMessageIds.push(this.view.addMessage(model, message.id));
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

    this.snapshot = applySessionProtocolDelta(this.snapshot, delta);
    this.observedSessionRevision = Math.max(this.observedSessionRevision, this.snapshot.revision);
    this.view.reconcileToolUiSession(getToolUiModelsInModelOrder(this.snapshot));
    this.refreshStatus();
    return true;
  }

  private renderSnapshot(snapshot: SessionProtocolSnapshot): void {
    this.snapshot = snapshot;
    this.observedSessionRevision = Math.max(this.observedSessionRevision, snapshot.revision);
    this.assistantMessages = [];
    const messages = getTimelineMessages(snapshot);
    for (const entry of messages) {
      this.renderProtocolMessage(entry);
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

  private renderProtocolMessage(message: SessionProtocolMessage): void {
    const model = this.buildProtocolMessageModel(message);
    if (!model) {
      return;
    }

    if (isAssistantMessage(message.message)) {
      this.assistantMessages.push(message.message);
    }
    this.renderedMessageIds.push(this.view.addMessage(model, message.id));
  }

  private syncRenderedHistory(snapshot: SessionProtocolSnapshot): void {
    this.snapshot = snapshot;
    this.observedSessionRevision = Math.max(this.observedSessionRevision, snapshot.revision);

    const messages = getTimelineMessages(snapshot);
    const snapshotIds = new Set(messages.map((entry) => entry.id));
    const staleIds = this.renderedMessageIds.filter((id) => !snapshotIds.has(id));
    if (staleIds.length > 0) {
      this.view.removeMessages(staleIds);
      for (const id of staleIds) {
        this.clientRenderedUserMessages.delete(id);
      }
    }

    const renderedIds = new Set(this.renderedMessageIds);
    this.renderedMessageIds.splice(
      0,
      this.renderedMessageIds.length,
      ...this.renderedMessageIds.filter((id) => snapshotIds.has(id)),
    );

    for (const entry of messages) {
      if (this.hiddenHistoryEntryIds.has(entry.id)) {
        if (!renderedIds.has(entry.id)) {
          this.renderedMessageIds.push(entry.id);
        }
        continue;
      }

      const model =
        this.clientRenderedUserMessages.get(entry.id) ?? this.buildProtocolMessageModel(entry);
      if (!model) {
        continue;
      }

      if (renderedIds.has(entry.id)) {
        if (model.type === "assistant") {
          this.view.updateAssistantMessage(entry.id, model);
        } else {
          this.view.updateMessage(entry.id, model);
        }
      } else {
        this.renderedMessageIds.push(this.view.addMessage(model, entry.id));
      }
    }

    this.assistantMessages = this.collectAssistantMessages(snapshot);
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

  private syncSnapshotToolAndAgentUi(snapshot: SessionProtocolSnapshot): void {
    this.view.reconcileToolUiSession(getToolUiModelsInModelOrder(snapshot));
    this.view.reconcileSubagentUiSession(
      Object.values(snapshot.agents).map((agent) => ({
        state: structuredClone(agent),
        activity: getSubagentActivity(snapshot, agent.id),
      })),
    );
  }

  private collectAssistantMessages(snapshot: SessionProtocolSnapshot): AssistantMessage[] {
    const messages: AssistantMessage[] = [];
    for (const entry of snapshot.messages) {
      if (isAssistantMessage(entry.message)) {
        messages.push(entry.message);
      }
    }
    return messages;
  }

  private async syncFromSessionSnapshot(): Promise<boolean> {
    try {
      this.syncRenderedHistory(await this.session.snapshot());
      this.refreshStatus();
      return true;
    } catch (error) {
      this.view.addSystemMessage(`snapshot refresh failed: ${(error as Error).message}`, "warn");
      return false;
    }
  }

  private finishObservedSessionTurn(): void {
    if (!this.stopVisibleSessionTurn()) {
      return;
    }

    void this.stopTurnCaffeinate();
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
    this.startTurnTimer();
    this.startTurnCaffeinate();
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

    this.snapshotRecovery = this.syncFromSessionSnapshot()
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

  private async replaySnapshotRecoveryDeltas(): Promise<void> {
    while (this.snapshotRecoveryDeltas.length > 0) {
      const deltas = this.snapshotRecoveryDeltas.splice(0);
      for (let index = 0; index < deltas.length; index++) {
        const delta = deltas[index]!;
        if (this.tryApplySdkDelta(delta)) {
          continue;
        }
        if (!(await this.syncFromSessionSnapshot())) {
          this.snapshotRecoveryDeltas.unshift(delta, ...deltas.slice(index + 1));
          return;
        }
      }
    }
  }

  private startLocalUiSession(): void {
    this.hiddenHistoryEntryIds.clear();
    this.clientRenderedUserMessages.clear();
    this.renderedMessageIds.splice(0);
    this.view.addMessage({ type: "session_divider", label: "new session" });
  }

  private addSessionIdentityMessage(): void {
    this.view.addSystemMessage(this.formatSessionIdentityText(), "muted");
  }

  private renderCompactedSnapshot(snapshot: SessionProtocolSnapshot): void {
    this.startLocalUiSession();
    this.renderSnapshot(snapshot);
  }

  private shouldRenderAutoCompactedReset(delta: SessionProtocolDeltaMessage): boolean {
    return (
      delta.reason === "maintenance" &&
      delta.delta.type === "snapshot.reset" &&
      this.hasRunningAutoCompactionOperation(this.snapshot)
    );
  }

  private renderAutoCompactedReset(snapshot: SessionProtocolSnapshot): void {
    this.view.resetToolUiSessionPreservingSubagents();
    this.startLocalUiSession();
    this.renderSnapshot(snapshot);

    const metadata = this.getAutoCompactionMetadata(snapshot);
    if (metadata) {
      this.view.addMessage({
        type: "system",
        text: formatAutoCompactionRetainedText(metadata),
        kind: "muted",
      });
    }
  }

  private toggleThinkingVisibility(): void {
    this.showThinking = !this.showThinking;
    this.view.setThinkingVisibility(this.showThinking);
    this.view.addSystemMessage(
      this.showThinking ? "thoughts visible" : "thoughts hidden",
      "success",
    );
  }

  private toggleCompactToolUi(): void {
    this.compactToolUi = !this.compactToolUi;
    this.view.setCompactToolUi(this.compactToolUi);
    this.view.addSystemMessage(
      this.compactToolUi ? "compact tool ui enabled" : "compact tool ui disabled",
      "success",
    );
  }

  private async cyclePersonality(): Promise<void> {
    const personas = this.snapshot.catalog.personas;
    if (personas.length === 0) {
      this.view.addSystemMessage("no personas available.", "warn");
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
      this.view.addSystemMessage(`reasoning change failed: ${(error as Error).message}`, "error");
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
      this.view.addSystemMessage("missing persona id", "error");
      return;
    }

    const persona = this.snapshot.catalog.personas.find(
      (candidate) => candidate.id.toLowerCase() === id.toLowerCase(),
    );
    if (!persona) {
      this.view.addSystemMessage(`unknown persona '${id}'.`, "error");
      return;
    }

    if (this.isSessionOperationActive()) {
      this.view.addSystemMessage("cannot switch persona while a session turn is running", "warn");
      return;
    }

    try {
      this.snapshot = await this.session.setPersona(persona.id);
      this.syncRenderedHistory(this.snapshot);
      this.refreshStatus();
      this.view.addSystemMessage(
        `switched to ${persona.label} (${this.snapshot.bootstrap.model.id})`,
        "success",
      );
    } catch (error) {
      this.view.addSystemMessage(`persona switch failed: ${(error as Error).message}`, "error");
    }
  }

  private async insertPrompt(rawId: string): Promise<void> {
    const id = rawId.trim();
    if (!id) {
      this.view.addSystemMessage("missing prompt id", "error");
      return;
    }

    const prompt = this.snapshot.catalog.prompts.find(
      (candidate) => candidate.id.toLowerCase() === id.toLowerCase(),
    );
    if (!prompt) {
      this.view.addSystemMessage(`unknown prompt '${id}'.`, "error");
      return;
    }

    try {
      const resolved = await this.session.resolvePrompt(prompt.id);
      this.view.setEditorText(resolved.text);
    } catch (error) {
      this.view.addSystemMessage(`prompt load failed: ${(error as Error).message}`, "error");
    }
  }

  private async reloadContent(): Promise<void> {
    if (this.isSessionOperationActive()) {
      this.view.addSystemMessage("cannot reload while a session turn is running", "warn");
      return;
    }

    try {
      const result = await this.session.reload();
      this.snapshot = result.snapshot;
      this.syncRenderedHistory(this.snapshot);
      this.refreshStatus();

      for (const warning of result.warnings) {
        this.view.addSystemMessage(warning, "warn");
      }

      const summary = [
        `${result.counts.personas} personas`,
        `${result.counts.prompts} prompts`,
        `${result.counts.skills} skills`,
        ...formatAgentsMdReloadSummary(this.getAgentsFilePaths().length),
      ].join(", ");
      this.view.addSystemMessage(`reloaded: ${summary}.`, "success");
    } catch (error) {
      this.view.addSystemMessage(`reload failed: ${(error as Error).message}`, "error");
    }
  }

  private async compactSession(
    mode: "summary-only" | "summary-and-last",
    guidanceText?: string,
  ): Promise<void> {
    if (this.isSessionOperationActive()) {
      this.view.addSystemMessage("cannot compact while a session turn is running", "warn");
      return;
    }

    const guidance = guidanceText?.trim() ?? "";
    this.manualCompactionInProgress = true;
    this.refreshStatus();
    this.view.addSystemMessage("summarizing session...", "success");

    try {
      const result = await this.session.compact(mode, {
        ...(guidance ? { guidance } : {}),
      });
      this.renderCompactedSnapshot(result.snapshot);
      const message =
        mode === "summary-and-last" && result.includedLastAssistant
          ? "session compacted. previous context and last assistant message have been included."
          : "session compacted. previous context has been summarized.";
      this.view.addSystemMessage(message, "success");
    } catch (error) {
      const message = (error as Error).message || "compaction failed";
      const kind = message === "no conversation to compact." ? "warn" : "error";
      this.view.addSystemMessage(kind === "warn" ? message : `compact failed: ${message}`, kind);
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
      this.view.addSystemMessage(
        goal ? `goal ${goal.status}: ${goal.objective}` : "no session goal",
        goal ? "success" : "muted",
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
      this.view.addSystemMessage("session goal cleared", "success");
    } catch (error) {
      this.view.addSystemMessage(`goal clear failed: ${(error as Error).message}`, "error");
    }
  }

  private async speakLastAssistantMessage(): Promise<void> {
    if (this.speakTask) {
      this.view.addSystemMessage("speech playback already in progress", "warn");
      return;
    }

    if (this.isSessionOperationActive()) {
      this.view.addSystemMessage("wait for the assistant to finish before speaking", "warn");
      return;
    }

    if (this.deps.env.platform() !== "darwin") {
      this.view.addSystemMessage("/speak is currently supported only on macOS.", "warn");
      return;
    }

    const lastAssistant = this.getLastAssistantMessage();
    if (!lastAssistant) {
      this.view.addSystemMessage("no assistant message to speak yet.", "warn");
      return;
    }

    const sourceText = extractAssistantText(lastAssistant).trim();
    if (!sourceText) {
      this.view.addSystemMessage("last assistant message was empty.", "warn");
      return;
    }

    const apiKey = getGoogleApiKey(this.config, this.deps.env.env());
    if (!apiKey) {
      this.view.addSystemMessage("set GEMINI_API_KEY or apiKeys.google to use /speak", "error");
      return;
    }

    this.speechStatusHint = "rewriting for speech...";
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
      this.view.addSystemMessage(`speech synthesis failed: ${(err as Error).message}`, "error");
    } finally {
      if (this.speakTask === task) {
        this.speakTask = undefined;
      }
      this.speechStatusHint = undefined;
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
      onStatusHint: (hint) => {
        this.speechStatusHint = hint;
        this.refreshStatus();
      },
    });
  }

  private refreshStatus(): void {
    this.view.updateStatus({
      footer: {
        contextUsage: this.getContextUsageString(),
        sessionCost: this.getSessionCostString(),
        duration: this.getTurnDurationString(),
        commandHint: this.diffReviewService.getCommandHint(
          this.getSessionOperationStatusHint() ?? this.speechStatusHint ?? this.commandHint,
        ),
        pursuingGoal: this.snapshot.goal?.status === "active",
      },
      editor: {
        mode: this.getInputMode(),
        cwdLabel: this.getFooterCwdLabel(),
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

  private getSessionOperationStatusHint(): string | undefined {
    if (this.manualCompactionInProgress) {
      return "compacting context...";
    }
    const hasRunningAutoCompaction = this.hasRunningAutoCompactionOperation(this.snapshot);
    return hasRunningAutoCompaction ? "compacting context..." : undefined;
  }

  private hasRunningAutoCompactionOperation(snapshot: SessionProtocolSnapshot): boolean {
    return snapshot.timeline.some(
      (item) =>
        item.type === "operation" &&
        item.operation.kind === "auto-compaction" &&
        item.operation.status === "running",
    );
  }

  private getContextUsageString(): string {
    const last = this.getLastAssistantMessage();
    const windowTokens = last
      ? this.getContextWindowForLastTurn(last)
      : this.getBootstrapContextWindow();
    const { input, read, write, output } = this.getSessionUsageTotals();
    const stats = `↑${formatTokenWindow(input)} ↓${formatTokenWindow(output)} (r${formatTokenWindow(read)} w${formatTokenWindow(write)})`;
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
    if (this.assistantMessages.length > 0) {
      return this.assistantMessages[this.assistantMessages.length - 1];
    }

    for (let i = this.snapshot.messages.length - 1; i >= 0; i -= 1) {
      const message = this.snapshot.messages[i]?.message;
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

  private getAgentsFilePaths(): string[] {
    const systemPrompt = this.snapshot.messages.find((entry) => entry.message.role === "system")
      ?.message.content;
    if (typeof systemPrompt !== "string") {
      return [];
    }

    const files = new Set<string>();
    const regex = /<file path="([^"]*AGENTS\.md)">/g;
    for (const match of systemPrompt.matchAll(regex)) {
      const path = unescapeXmlAttribute(match[1] ?? "");
      if (path) {
        files.add(path);
      }
    }
    return [...files];
  }

  private getAutoCompactionMetadata(snapshot: SessionProtocolSnapshot):
    | {
        cutType: "turn-boundary" | "split-turn";
        retainedMessageCount: number;
      }
    | undefined {
    for (const entry of snapshot.messages) {
      if (!isCoreMessage(entry.message)) {
        continue;
      }
      const metadata = getAutoCompactionMetadataFromMessage(entry.message);
      if (metadata) {
        return metadata;
      }
    }
    return undefined;
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

  async runClientDiffReview(rawArgs: unknown, signal: AbortSignal): Promise<string> {
    return await this.diffReviewService.runModelTool(rawArgs, signal);
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
      this.view.addSystemMessage("diff review is already active.", "warn");
      return;
    }

    if (!this.isDiffReviewIdle()) {
      this.view.addSystemMessage("wait for tau to become idle before starting /diff.", "warn");
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
      !this.isTranscribingListen &&
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
  ): Promise<StartedDiffReviewBridge> {
    const cwd = sessionSnapshot.executionEnvironment.cwd;
    const backend = createSdkToolExecutionBackend({ session, cwd });
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
    const model: ChatMessageModel = {
      type: "user",
      text: review.review,
      kind: "review",
    };
    this.clientRenderedUserMessages.set(review.historyEntryId, model);
    if (!this.renderedMessageIds.includes(review.historyEntryId)) {
      this.renderedMessageIds.push(review.historyEntryId);
    }

    try {
      const result = await session.record(formatDiffReviewUserMessage(review), {
        historyEntryId: review.historyEntryId,
      });
      if (this.session === session) {
        this.syncRenderedHistory(result.snapshot);
      }
    } catch (error) {
      this.view.addSystemMessage(
        `failed to add diff review to session: ${(error as Error).message}`,
        "error",
      );
    }
  }

  private startRewindFlow(): void {
    if (this.isSessionOperationActive()) {
      return;
    }

    const candidates = this.snapshot.messages.flatMap((entry) => {
      if (
        !entry.modelVisible ||
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
        },
      ];
    });

    if (candidates.length === 0) {
      this.view.addSystemMessage("no user messages available to rewind.", "warn");
      return;
    }

    this.view.showRewindPicker({
      items: candidates.map(({ id, label }) => ({ id, label })),
      onSelect: (id) => {
        const selected = candidates.find((candidate) => candidate.id === id);
        if (!selected) {
          this.view.hideRewindPicker();
          this.view.addSystemMessage("rewind selection failed.", "error");
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
      this.view.addSystemMessage("rewind failed.", "error");
    }
  }

  private interruptSelectedSubagent(): void {
    const selectedId = this.view.getSelectedSubagentId();
    if (!selectedId) {
      this.view.addSystemMessage("no active subagent selected", "warn");
      return;
    }

    void this.session
      .interruptSubagent(selectedId)
      .then((result) => {
        if (!result.found) {
          this.view.addSystemMessage(`unknown subagent id: ${selectedId}`, "warn");
        }
      })
      .catch((err) => {
        this.view.addSystemMessage(
          `failed to interrupt subagent: ${(err as Error).message}`,
          "error",
        );
      });
  }

  private async stashEditorToClipboard(): Promise<void> {
    const text = this.view.getExpandedEditorText();
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

function getTimelineMessages(snapshot: SessionProtocolSnapshot): SessionProtocolMessage[] {
  const messagesById = new Map(snapshot.messages.map((message) => [message.id, message]));
  return snapshot.timeline.flatMap((item) => {
    if (item.type !== "message") {
      return [];
    }
    const message = messagesById.get(item.messageId);
    return message ? [message] : [];
  });
}

function isMessageInTimeline(snapshot: SessionProtocolSnapshot, messageId: string): boolean {
  return snapshot.timeline.some((item) => item.type === "message" && item.messageId === messageId);
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

function formatAgentsMdReloadSummary(count: number): string[] {
  if (count <= 0) {
    return [];
  }
  return [`${count} AGENTS.md`];
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

function isToolUiEvent(value: unknown): value is ToolActivity {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    typeof value.type === "string" &&
    "toolCallId" in value &&
    typeof value.toolCallId === "string"
  );
}

function getToolUiModelsInModelOrder(snapshot: SessionProtocolSnapshot): ToolUiModel[] {
  const facetsByToolId = new Map<string, SessionProtocolSnapshot["facets"][string]>();
  for (const facet of Object.values(snapshot.facets)) {
    if (facet.kind === "tau.tool-ui-events" && facet.subject.type === "tool") {
      facetsByToolId.set(facet.subject.id, facet);
    }
  }
  const messagesById = new Map(snapshot.messages.map((message) => [message.id, message]));

  return getToolIdsInModelOrder(snapshot).map((toolId) => {
    const tool = snapshot.tools[toolId]!;
    const activities = toolUiEventsFromFacet(facetsByToolId.get(toolId));
    const activity = activities.at(-1);
    const resultMessage =
      tool.status === "streaming" ? undefined : messagesById.get(tool.resultMessageId ?? "");
    const resultMessageText =
      resultMessage?.message.role === "toolResult"
        ? resultMessage.message.content
            .flatMap((content) => (content.type === "text" ? [content.text] : []))
            .join("\n")
        : undefined;
    const resultText =
      resultMessageText || (tool.status === "streaming" ? undefined : (tool.error ?? tool.summary));
    const activityCode = activity && "code" in activity ? activity.code : undefined;
    const code = activityCode ?? getToolCallCode(tool, messagesById);
    return {
      toolCallId: tool.toolCallId,
      toolName: tool.toolName,
      status: tool.status,
      headerTarget: activity?.headerTarget ?? tool.toolName,
      ...(code !== undefined ? { code } : {}),
      ...(activity ? { activity } : {}),
      ...(resultText ? { resultText } : {}),
    };
  });
}

function getToolCallCode(
  tool: SessionProtocolSnapshot["tools"][string],
  messagesById: ReadonlyMap<string, SessionProtocolMessage>,
): string | undefined {
  if (tool.status === "streaming") return undefined;
  const message = messagesById.get(tool.call.messageId);
  if (message?.message.role !== "assistant") return undefined;
  const content = message.message.content[tool.call.contentIndex];
  if (
    content?.type !== "toolCall" ||
    content.id !== tool.toolCallId ||
    typeof content.arguments !== "object" ||
    content.arguments === null ||
    !("code" in content.arguments) ||
    typeof content.arguments.code !== "string"
  ) {
    return undefined;
  }
  return content.arguments.code;
}

function getToolIdsInModelOrder(snapshot: SessionProtocolSnapshot): string[] {
  const messageOrder = new Map(snapshot.messages.map((message, index) => [message.id, index]));
  return Object.values(snapshot.tools)
    .sort((left, right) => {
      const leftPosition = left.status === "streaming" ? left.origin : left.call;
      const rightPosition = right.status === "streaming" ? right.origin : right.call;
      const leftMessageIndex = messageOrder.get(leftPosition.messageId) ?? Number.MAX_SAFE_INTEGER;
      const rightMessageIndex =
        messageOrder.get(rightPosition.messageId) ?? Number.MAX_SAFE_INTEGER;
      return (
        leftMessageIndex - rightMessageIndex ||
        leftPosition.contentIndex - rightPosition.contentIndex
      );
    })
    .map((tool) => tool.id);
}

function toolUiEventsFromFacet(
  facet: SessionProtocolSnapshot["facets"][string] | undefined,
): ToolActivity[] {
  if (facet?.kind !== "tau.tool-ui-events" || !Array.isArray(facet.data.events)) {
    return [];
  }
  return facet.data.events.filter(isToolUiEvent);
}

function getSubagentActivity(
  snapshot: SessionProtocolSnapshot,
  agentId: string,
): string | undefined {
  const facet = Object.values(snapshot.facets).find(
    (candidate) =>
      candidate.kind === SUBAGENT_ACTIVITY_FACET_KIND &&
      candidate.subject.type === "agent" &&
      candidate.subject.id === agentId,
  );
  return typeof facet?.data.text === "string" ? facet.data.text : undefined;
}

function subagentUiEventsFromAgentRun(
  agent: SessionProtocolSnapshot["agents"][string],
  startedType: "subagent_spawned" | "subagent_run_started" = "subagent_spawned",
): SubagentUiEvent[] {
  const state = structuredClone(agent);
  const events: SubagentUiEvent[] = [{ type: startedType, state }];
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
): SubagentUiEvent[] {
  if (!previous) {
    return subagentUiEventsFromAgentRun(next);
  }
  if (previous.run.revision !== next.run.revision) {
    return subagentUiEventsFromAgentRun(next, "subagent_run_started");
  }

  const state = structuredClone(next);
  const events: SubagentUiEvent[] = [];
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
