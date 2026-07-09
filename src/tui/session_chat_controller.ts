import { randomUUID } from "node:crypto";
import { dirname } from "node:path/posix";
import type { AssistantMessage, Message, ToolResultMessage } from "@earendil-works/pi-ai";
import {
  type CommandDispatchContext,
  type CommandRegistry,
  createCommandRegistry,
  getRiskLevelDescription,
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
import { buildDiffReviewInstructions } from "../core/diff_review/review_thread.js";
import { type CoreDeps, createDefaultCoreDeps } from "../core/runtime/deps.js";
import { runDirectBashCommand } from "../core/session/direct_bash.js";
import {
  parseSessionPruneFraction,
  parseSessionPruneFractionAndGuidance,
} from "../core/session/pruning.js";
import type { SubagentStatus, SubagentUiEvent } from "../core/subagents/types.js";
import type { ToolUiEvent } from "../core/tools/registry.js";
import { REASONING_LEVELS, type ReasoningEffort, type RiskLevel } from "../core/types.js";
import { formatAdaptiveNumber, formatTokenWindow } from "../core/utils/format.js";
import { extractAssistantText } from "../core/utils/messages.js";
import {
  getAutoCompactionMetadataFromMessage,
  hasAutoCompactionContinuationMetadata,
} from "../core/utils/user_metadata.js";
import { APP_VERSION } from "../core/version.js";
import { shellQuote } from "../execution/sandbox_tool_helpers.js";
import type {
  SessionProtocolCreateParams,
  SessionProtocolDeltaMessage,
  SessionProtocolMessage,
  SessionProtocolSnapshot,
} from "../protocol/session_protocol.js";
import { applySessionProtocolDelta } from "../protocol/session_protocol.js";
import type {
  TauSdkSession,
  TauSdkSessionRetryResult,
  TauSdkSessionSubmitResult,
} from "../sdk/types.js";
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
import { QueuedUserMessages } from "./chat_controller/queued_user_messages.js";
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
import { formatDefaultMemoryModeFilePath, formatMemoryModeUserMessage } from "./memory_mode.js";
import { createSdkToolExecutionBackend } from "./session_tool_execution_backend.js";
import { runSpeechPlaybackTask } from "./speech_playback.js";
import type { ChatMessageModel } from "./ui/chat_message_model.js";

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
  config?: Config;
  defaultDiffTool?: DiffToolConfig;
  diffToolLauncher?: DiffReviewToolLauncher;
  deps?: CoreDeps;
  queuedUserMessages?: string[];
  caffeinated?: boolean;
  themeIds?: string[];
};

export class SessionChatController {
  private readonly view: ChatView;
  private session: TauSdkSession;
  private readonly createSession?: (input: SessionProtocolCreateParams) => Promise<TauSdkSession>;
  private readonly targetLabel: string;
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
  private snapshotRecovery?: Promise<void>;
  private readonly snapshotRecoveryDeltas: SessionProtocolDeltaMessage[] = [];
  private isStreaming = false;
  private submittedTurnInProgress = false;
  private manualCompactionInProgress = false;
  private isBashMode = false;
  private isBashIncognito = false;
  private isMemoryMode = false;
  private showThinking = false;
  private compactToolUi = true;
  private commandHint?: string;
  private currentTurnStartedAt?: number;
  private lastTurnDurationMs = 0;
  private turnTimer?: ReturnType<typeof setInterval>;
  private lastEmptySubmitAt?: number;
  private readonly queuedMessageBuffer: QueuedUserMessages;
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
    this.config = options.config ?? {};
    this.defaultDiffTool = options.defaultDiffTool;
    this.diffToolLauncher = options.diffToolLauncher;
    this.deps = options.deps ?? createDefaultCoreDeps();
    this.themeIds = options.themeIds ?? [];
    this.caffeinated = options.caffeinated ?? false;
    this.observedSessionRevision = options.snapshot.revision;
    this.queuedMessageBuffer = new QueuedUserMessages(options.queuedUserMessages ?? []);
    this.commandRegistry = createCommandRegistry();
    this.commandHandlers = {
      help: () => this.showHelp(),
      copyText: () => this.copyLastAssistantText(),
      copyCode: () => this.copyLastAssistantCode(),
      newSession: () => this.createNewSession(),
      rewind: () => this.startRewindFlow(),
      diff: (argsText) => this.startDiffReview(argsText),
      compactSummaryOnly: (extra) => this.compactSession("summary-only", extra),
      compactSummaryAndLast: (extra) => this.compactSession("summary-and-last", extra),
      pruneEarliest: (extra) => this.pruneSession("earliest", extra),
      pruneLargest: (extra) => this.pruneSession("largest", extra),
      pruneSmart: (extra) => this.pruneSession("smart", extra),
      reload: () => this.reloadContent(),
      listen: () => this.startListenCaptureFromCommand(),
      speak: () => this.speakLastAssistantMessage(),
      risk: (level) => this.setRiskLevel(level),
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
      startSession: (args) => this.startDiffReviewBridge(args),
      onReviewReturned: (review) => void this.handleReturnedDiffReview(review),
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
    this.refreshStatus();
  }

  async dispose(): Promise<void> {
    this.eventUnsubscribe?.();
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
      onCtrlR: () => void this.cycleRiskLevel(),
      onCtrlP: () => void this.cyclePersonality(),
      onCtrlS: () => void this.stashEditorToClipboard(),
      onCtrlY: () => void this.toggleListenCapture(),
      onCtrlG: () => this.terminateSelectedSubagent(),
      onEscape: () => void this.interrupt(),
      beforeSubmit: (text) => this.beforeSubmit(text),
      onChange: (text) => this.handleEditorChange(text),
      onSubmit: (text) => void this.handleSubmit(text),
      onSteerSubmit: (text) => void this.submitSteeringMessage(text),
      onFlushQueueAsSteer: () => void this.flushQueuedMessagesAsSteering(),
      onAltUp: () => this.popQueuedMessageIntoEditor(),
      onAltDown: () => this.cycleSubagentSelection(),
      onAltC: () => this.collapseQueuedMessages(),
    };
  }

  private beforeSubmit(text: string): boolean {
    if (!this.isSessionOperationActive()) {
      return true;
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
      this.queuedMessageBuffer.enqueue(trimmed, () => this.view.requestRender());
      this.view.addSystemMessage("message queued", "success", {
        persist: false,
      });
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

    if (this.isSingleLineInput(text) && trimmed.startsWith("#")) {
      const request = trimmed.slice(1).trim();
      if (!request) {
        this.view.addSystemMessage("memory mode request was empty.", "warn");
        return;
      }

      const agentsFilePath = formatDefaultMemoryModeFilePath(
        this.snapshot.executionEnvironment.cwd,
      );
      await this.submitUserText(request, {
        textForModel: formatMemoryModeUserMessage(agentsFilePath, request),
        kind: "memory",
      });
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
        riskLevels: ["read-only", "read-write"],
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
    const wasMemory = this.isMemoryMode;
    const previousCommandHint = this.commandHint;

    if (text.trim().length > 0) {
      this.lastEmptySubmitAt = undefined;
    }

    const trimmed = text.trimStart();
    const isSingleLine = this.isSingleLineInput(text);
    const isIncognito = trimmed.startsWith("!!");
    this.isBashIncognito = isIncognito;
    this.isBashMode = trimmed.startsWith("!") && !isIncognito;
    this.isMemoryMode = isSingleLine && trimmed.startsWith("#");
    this.commandHint = this.getCommandHintForInput(text);

    if (
      wasBash !== this.isBashMode ||
      wasBashIncognito !== this.isBashIncognito ||
      wasMemory !== this.isMemoryMode ||
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
    riskLevels: () => Array<"read-only" | "read-write">;
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
      riskLevels: () => ["read-only", "read-write"],
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
    return parts.join(" · ");
  }

  private buildStartupIntroBody(): string[] {
    const lines = [
      "type `/help` for commands and keybindings",
      "mention files with `@`, agents and skills with `@@`",
      "run bash commands with `!` or `!!`",
      "use `#` to update AGENTS.md",
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

    lines.push("", this.formatSessionIdentityText());

    return lines;
  }

  private async submitUserText(
    text: string,
    options: { textForModel?: string; kind?: "memory" | "review" } = {},
  ): Promise<void> {
    const historyEntryId = `session-user-${randomUUID()}`;
    const model: ChatMessageModel = {
      type: "user",
      text,
      ...(options.kind ? { kind: options.kind } : {}),
    };
    this.clientRenderedUserMessages.set(historyEntryId, model);
    this.view.addMessage(model, historyEntryId);
    this.renderedMessageIds.push(historyEntryId);
    await this.runSessionTurn(() =>
      this.session.submit(options.textForModel ?? text, { historyEntryId }),
    );
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
    this.view.handleToolUiEvent({
      type: "bash_started",
      toolCallId,
      command,
      headerTarget,
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
      this.view.handleToolUiEvent({
        type: "bash_execution",
        toolCallId,
        command: result.command,
        headerTarget,
        exitCode: result.exitCode,
        truncationInfo: result.truncationInfo,
        uiText: result.uiText,
        durationMs: result.durationMs,
        labelOverride: options.labelOverride,
      });
      await this.syncFromSessionSnapshot();
    } catch (error) {
      this.view.handleToolUiEvent({
        type: "bash_blocked",
        toolCallId,
        command,
        headerTarget,
        reason: (error as Error).message || "bash failed",
      });
      await this.syncFromSessionSnapshot();
    } finally {
      this.isStreaming = false;
      this.view.stopWorkingIcon();
      this.stopTurnTimer();
      this.refreshStatus();
      this.view.requestRender();
      await this.drainQueuedMessages();
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

    this.submitSteeringText(trimmed);
  }

  private async flushQueuedMessagesAsSteering(): Promise<void> {
    if (this.queuedMessageBuffer.length === 0) {
      this.view.addSystemMessage("no queued messages to steer", "warn");
      return;
    }

    const messages = this.queuedMessageBuffer.flush();
    const text = messages.join("\n\n");
    this.view.requestRender();
    this.submitSteeringText(text, {
      onFailure: () => {
        this.queuedMessageBuffer.requeueFront(messages, () => this.view.requestRender());
      },
    });
  }

  private submitSteeringText(text: string, options: { onFailure?: () => void } = {}): void {
    void this.session
      .steer(text, { historyEntryId: `session-steer-${randomUUID()}` })
      .catch((error) => {
        options.onFailure?.();
        this.view.addSystemMessage(`steering failed: ${(error as Error).message}`, "error");
      });
  }

  private popQueuedMessageIntoEditor(): void {
    this.queuedMessageBuffer.popIntoEditor({
      getEditorText: () => this.view.getEditorText(),
      setEditorText: (text) => this.view.setEditorText(text),
    });
    this.view.requestRender();
  }

  private dequeueQueuedMessagesIntoEditor(): void {
    this.queuedMessageBuffer.dequeueIntoEditor({
      getEditorText: () => this.view.getEditorText(),
      setEditorText: (text) => this.view.setEditorText(text),
    });
    this.view.requestRender();
  }

  private collapseQueuedMessages(): void {
    if (this.queuedMessageBuffer.collapse()) {
      this.view.addSystemMessage("queued messages collapsed", "success", {
        persist: false,
      });
      this.view.requestRender();
    }
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
      if (result.turn.blocked) {
        this.view.addSystemMessage(`turn blocked: ${result.turn.blocked.message}`, "error");
      }
      await this.syncFromSessionSnapshot();
    } catch (error) {
      this.view.addSystemMessage(`session turn failed: ${(error as Error).message}`, "error");
      this.stopVisibleSessionTurn();
      void this.stopTurnCaffeinate();
      await this.syncFromSessionSnapshot();
    } finally {
      this.submittedTurnInProgress = false;
      this.stopVisibleSessionTurn();
      await this.stopTurnCaffeinate();
      this.refreshStatus();
      await this.drainQueuedMessages();
    }
  }

  private async drainQueuedMessages(): Promise<void> {
    await this.queuedMessageBuffer.drain({
      isStreaming: () => this.isStreaming,
      onUserInput: (text) => this.submitUserText(text),
      requestRender: () => this.view.requestRender(),
      sendTerminalNotification: (title) => this.view.sendTerminalNotification(title),
      buildIdleNotificationTitle: () => "tau is idle",
    });
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
      this.view.addSystemMessage("cannot create a new session while a turn is running", "warn");
      return;
    }

    if (!this.createSession) {
      this.view.addSystemMessage("new session creation is unavailable", "error");
      return;
    }

    try {
      const previousUnsubscribe = this.eventUnsubscribe;
      const previousSession = this.session;
      const nextSession = await this.createSession({
        executionEnvironment: this.createExecutionEnvironmentInputFromSnapshot(),
        personaId: this.snapshot.settings.personaId,
        riskLevel: this.snapshot.settings.riskLevel,
        ...(this.snapshot.settings.reasoning !== undefined
          ? { reasoning: this.snapshot.settings.reasoning }
          : {}),
      });
      this.eventUnsubscribe = undefined;
      previousUnsubscribe?.();
      try {
        await previousSession.unobserve();
      } catch (detachError) {
        this.view.addSystemMessage(
          `old session unobserve failed: ${(detachError as Error).message}`,
          "warn",
        );
      }
      this.session = nextSession;
      this.snapshot = await this.session.snapshot();
      this.observedSessionRevision = this.snapshot.revision;
      this.eventUnsubscribe = this.session.onDelta((delta) => this.onSdkDelta(delta));
      this.view.resetToolUiSession();
      this.assistantMessages = [];
      this.startLocalUiSession();
      this.addSessionIdentityMessage();
      this.renderSnapshot(this.snapshot);
      this.refreshStatus();
    } catch (error) {
      this.view.addSystemMessage(`new session failed: ${(error as Error).message}`, "error");
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
      if (this.tryApplyFastToolFacetDelta(delta)) {
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
    if (delta.delta.type !== "snapshot.patch" || delta.delta.changes.length !== 1) {
      return false;
    }

    const change = delta.delta.changes[0]!;
    if (change.type !== "agent.set") {
      return false;
    }

    const previousAgent = this.snapshot.agents[change.agent.id];
    this.snapshot = applySessionProtocolDelta(this.snapshot, delta);
    this.observedSessionRevision = Math.max(this.observedSessionRevision, this.snapshot.revision);

    for (const event of subagentUiEventsForAgentDelta(previousAgent, change.agent)) {
      this.view.handleSubagentEvent(event);
    }
    this.refreshStatus();
    return true;
  }

  private tryApplyFastToolFacetDelta(delta: SessionProtocolDeltaMessage): boolean {
    if (delta.delta.type !== "snapshot.patch") {
      return false;
    }

    const facetChanges = delta.delta.changes.filter((change) => change.type === "facet.set");
    if (
      facetChanges.length !== 1 ||
      delta.delta.changes.some(
        (change) => change.type !== "tool.set" && change.type !== "facet.set",
      )
    ) {
      return false;
    }

    const facetChange = facetChanges[0]!;
    const nextFacet = facetChange.facet;
    if (nextFacet.kind !== "tau.tool-ui-events" || nextFacet.subject.type !== "tool") {
      return false;
    }

    const previousEvents = toolUiEventsFromFacet(this.snapshot.facets[nextFacet.id]);
    const nextEvents = toolUiEventsFromFacet(nextFacet);
    if (!canAppendToolUiEvents(nextEvents, previousEvents)) {
      return false;
    }

    this.snapshot = applySessionProtocolDelta(this.snapshot, delta);
    this.observedSessionRevision = Math.max(this.observedSessionRevision, this.snapshot.revision);

    for (const event of nextEvents.slice(previousEvents.length)) {
      this.view.handleToolUiEvent(event);
    }
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
      hasToolUiFacetForToolCall(this.snapshot, (message.message as ToolResultMessage).toolCallId)
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
    this.view.resetToolUiSession();
    for (const event of getToolUiEventsInModelOrder(snapshot)) {
      this.view.handleToolUiEvent(event);
    }

    for (const agent of Object.values(snapshot.agents)) {
      for (const event of subagentUiEventsFromAgentRun(agent)) {
        this.view.handleSubagentEvent(event);
      }
    }
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
    if (this.submittedTurnInProgress) {
      return;
    }
    void this.drainQueuedMessages();
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
    return this.isStreaming || this.submittedTurnInProgress || this.manualCompactionInProgress;
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

  private async cycleRiskLevel(): Promise<void> {
    const next = this.snapshot.settings.riskLevel === "read-only" ? "read-write" : "read-only";
    await this.setRiskLevel(next);
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

  private async setRiskLevel(rawLevel: string): Promise<void> {
    const riskLevel = rawLevel.trim();
    if (riskLevel !== "read-only" && riskLevel !== "read-write") {
      this.view.addSystemMessage(
        `invalid risk level '${rawLevel}'. allowed: read-only, read-write`,
        "error",
      );
      return;
    }

    if (this.isSessionOperationActive()) {
      this.view.addSystemMessage("cannot change risk while a session turn is running", "warn");
      return;
    }

    try {
      this.snapshot = await this.session.setRiskLevel(riskLevel);
      this.syncRenderedHistory(this.snapshot);
      this.refreshStatus();
      this.view.addSystemMessage(this.formatRiskLevelNotice(riskLevel), "success");
    } catch (error) {
      this.view.addSystemMessage(`risk change failed: ${(error as Error).message}`, "error");
    }
  }

  private formatRiskLevelNotice(level: RiskLevel): string {
    const details = getRiskLevelDescription(level);
    return details ? `risk level set to ${level} (${details})` : `risk level set to ${level}`;
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

  private async pruneSession(
    strategy: "earliest" | "largest" | "smart",
    extraText?: string,
  ): Promise<void> {
    if (this.isSessionOperationActive()) {
      this.view.addSystemMessage("cannot prune while a session turn is running", "warn");
      return;
    }

    const extra = extraText?.trim() ?? "";
    const parsed =
      strategy === "smart"
        ? parseSessionPruneFractionAndGuidance(extra)
        : { fraction: parseSessionPruneFraction(extra) };
    if (parsed.fraction === null) {
      this.view.addSystemMessage("invalid prune fraction. use a number between 0 and 1.", "error");
      return;
    }

    if (strategy === "smart" && parsed.fraction !== 0) {
      this.view.addSystemMessage("sampling prune candidates...", "success");
    }

    try {
      const result = await this.session.pruneToolResults(strategy, {
        fraction: parsed.fraction,
        ...("guidance" in parsed && parsed.guidance !== undefined
          ? { guidance: parsed.guidance }
          : {}),
      });
      this.syncRenderedHistory(result.snapshot);
      this.refreshStatus();
      this.view.addSystemMessage(result.message, result.noop ? "warn" : "success");
    } catch (error) {
      this.view.addSystemMessage(`prune failed: ${(error as Error).message}`, "error");
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

    this.isStreaming = true;
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
      const wasAborted = abortController.signal.aborted;
      if (this.speakTask === task) {
        this.speakTask = undefined;
      }
      this.speechStatusHint = undefined;
      this.view.stopWorkingIcon();
      this.isStreaming = false;
      this.refreshStatus();
      this.view.requestRender();
      if (wasAborted) {
        this.dequeueQueuedMessagesIntoEditor();
      } else {
        void this.drainQueuedMessages();
      }
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
        riskLevel: this.snapshot.settings.riskLevel,
        commandHint: this.diffReviewService.getCommandHint(
          this.getSessionOperationStatusHint() ?? this.speechStatusHint ?? this.commandHint,
        ),
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
    if (this.isMemoryMode) return "memory";
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
    let total = 0;
    for (const entry of this.snapshot.messages) {
      if (isAssistantMessage(entry.message)) {
        total += entry.message.usage?.cost?.total ?? 0;
      }
    }
    return formatSessionCost(total + this.view.getToolUiCostTotal());
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

  private async startDiffReview(argsText: string): Promise<void> {
    if (this.diffReviewService.isActive()) {
      this.view.addSystemMessage("diff review is already active.", "warn");
      return;
    }

    if (!this.isDiffReviewIdle()) {
      this.view.addSystemMessage("wait for tau to become idle before starting /diff.", "warn");
      return;
    }

    await this.diffReviewService.start(argsText);
  }

  private isDiffReviewIdle(): boolean {
    return (
      !this.isStreaming &&
      !this.submittedTurnInProgress &&
      !this.listenRecording &&
      !this.listenTransition &&
      !this.isTranscribingListen &&
      !this.speakTask &&
      !this.diffReviewService.isActive()
    );
  }

  private resolveDiffToolConfig(): DiffToolConfig | undefined {
    return this.config.diffTool ?? this.defaultDiffTool;
  }

  private async startDiffReviewBridge(args: {
    source: DiffReviewSnapshotSource;
    diffTool: DiffToolConfig;
    signal: AbortSignal;
  }): Promise<StartedDiffReviewBridge> {
    const snapshot = await captureDiffReviewSnapshot({
      cwd: this.snapshot.executionEnvironment.cwd,
      source: args.source,
      signal: args.signal,
      deps: createSessionDiffReviewSnapshotDeps(this.session),
    });
    const ephemeral = await this.session.createEphemeralContext({
      instructions: buildDiffReviewInstructions(snapshot),
      tools: ["bash", "view_image"],
      riskLevel: "read-only",
    });
    const bridge = new DiffReviewBridge({
      snapshot,
      contextWindow: this.snapshot.bootstrap.model.contextWindow,
      submitThreadMessage: (options) =>
        this.session.submitEphemeralThread({
          contextId: ephemeral.contextId,
          threadId: options.threadId,
          ...(options.forkFromThreadId ? { forkFromThreadId: options.forkFromThreadId } : {}),
          message: options.message,
        }),
      toolLaunchCwd: this.snapshot.executionEnvironment.cwd,
      deps: this.deps,
      ...(this.diffToolLauncher ? { toolLauncher: this.diffToolLauncher } : {}),
    });
    const unsubscribeEphemeral = this.session.onEphemeral((message) => {
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
      await this.session.closeEphemeralContext(ephemeral.contextId).catch(() => undefined);
      await bridge.cancel("launch_failed").catch(() => undefined);
      await bridge.close().catch(() => undefined);
      throw error;
    }

    const result = bridge.result.finally(async () => {
      unsubscribeEphemeral();
      await this.session.closeEphemeralContext(ephemeral.contextId).catch(() => undefined);
    });

    return { bridge, result };
  }

  private async handleReturnedDiffReview(review: DiffReviewReturnedReview): Promise<void> {
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
      const result = await this.session.record(formatDiffReviewUserMessage(review), {
        historyEntryId: review.historyEntryId,
      });
      this.syncRenderedHistory(result.snapshot);
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

  private terminateSelectedSubagent(): void {
    const selectedId = this.view.getSelectedSubagentId();
    if (!selectedId) {
      this.view.addSystemMessage("no active subagent selected", "warn");
      return;
    }

    void this.session
      .terminateSubagent(selectedId)
      .then((result) => {
        if (!result.found) {
          this.view.addSystemMessage(`unknown subagent id: ${selectedId}`, "warn");
        }
      })
      .catch((err) => {
        this.view.addSystemMessage(
          `failed to terminate subagent: ${(err as Error).message}`,
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

function createSessionDiffReviewSnapshotDeps(session: TauSdkSession) {
  return {
    spawn: async (
      cmd: string,
      args: string[],
      options: {
        cwd?: string;
        env?: NodeJS.ProcessEnv;
        signal?: AbortSignal;
        timeoutMs?: number;
        maxCaptureBytes?: number;
      } = {},
    ) => {
      void options.env;
      void options.maxCaptureBytes;
      if (options.signal?.aborted) {
        return {
          stdout: "",
          stderr: "",
          output: "",
          exitCode: null,
          captureLimitExceeded: false,
          timedOut: false,
          aborted: true,
          closeSignal: null,
        };
      }
      const command = [cmd, ...args].map(shellQuote).join(" ");
      const result = await session.exec(command, {
        ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
        ...(options.timeoutMs !== undefined ? { timeoutMs: options.timeoutMs } : {}),
      });
      return {
        stdout: result.stdout,
        stderr: result.stderr,
        output: result.output,
        exitCode: result.exitCode,
        captureLimitExceeded: result.truncated,
        timedOut: false,
        aborted: options.signal?.aborted ?? false,
        closeSignal: null,
      };
    },
    env: createDefaultCoreDeps().env,
    fs: {
      readFile: async (path: string) => {
        const script = "process.stdout.write(require('node:fs').readFileSync(process.argv[1]))";
        const result = await session.exec(`node -e ${shellQuote(script)} ${shellQuote(path)}`);
        if (result.exitCode !== 0) {
          throw new Error(result.stderr || result.output || `failed to read ${path}`);
        }
        return result.stdout;
      },
    },
  };
}

function isMessageInTimeline(snapshot: SessionProtocolSnapshot, messageId: string): boolean {
  return snapshot.timeline.some((item) => item.type === "message" && item.messageId === messageId);
}

function hasToolUiFacetForToolCall(snapshot: SessionProtocolSnapshot, toolCallId: string): boolean {
  return Object.values(snapshot.facets).some(
    (facet) =>
      facet.kind === "tau.tool-ui-events" &&
      facet.subject.type === "tool" &&
      facet.subject.id === toolCallId,
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

function isToolUiEvent(value: unknown): value is ToolUiEvent {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    typeof value.type === "string" &&
    "toolCallId" in value &&
    typeof value.toolCallId === "string"
  );
}

function getToolUiEventsInModelOrder(snapshot: SessionProtocolSnapshot): ToolUiEvent[] {
  const facetsByToolId = new Map<string, SessionProtocolSnapshot["facets"][string]>();
  for (const facet of Object.values(snapshot.facets)) {
    if (facet.kind === "tau.tool-ui-events" && facet.subject.type === "tool") {
      facetsByToolId.set(facet.subject.id, facet);
    }
  }

  const events: ToolUiEvent[] = [];
  const emittedFacetIds = new Set<string>();
  for (const toolId of getToolIdsInModelOrder(snapshot)) {
    const facet = facetsByToolId.get(toolId);
    if (!facet) {
      continue;
    }
    emittedFacetIds.add(facet.id);
    events.push(...toolUiEventsFromFacet(facet));
  }

  for (const facet of Object.values(snapshot.facets)) {
    if (emittedFacetIds.has(facet.id)) {
      continue;
    }
    events.push(...toolUiEventsFromFacet(facet));
  }
  return events;
}

function getToolIdsInModelOrder(snapshot: SessionProtocolSnapshot): string[] {
  const messageOrder = new Map(snapshot.messages.map((message, index) => [message.id, index]));
  return Object.values(snapshot.tools)
    .sort((left, right) => {
      const leftMessageIndex = messageOrder.get(left.call.messageId) ?? Number.MAX_SAFE_INTEGER;
      const rightMessageIndex = messageOrder.get(right.call.messageId) ?? Number.MAX_SAFE_INTEGER;
      return (
        leftMessageIndex - rightMessageIndex || left.call.contentIndex - right.call.contentIndex
      );
    })
    .map((tool) => tool.id);
}

function toolUiEventsFromFacet(
  facet: SessionProtocolSnapshot["facets"][string] | undefined,
): ToolUiEvent[] {
  if (facet?.kind !== "tau.tool-ui-events" || !Array.isArray(facet.data.events)) {
    return [];
  }
  return facet.data.events.filter(isToolUiEvent);
}

function canAppendToolUiEvents(
  events: readonly ToolUiEvent[],
  previousEvents: readonly ToolUiEvent[],
): boolean {
  if (previousEvents.length > events.length) {
    return false;
  }
  if (previousEvents.length === 0) {
    return true;
  }

  return previousEvents.every(
    (event, index) => JSON.stringify(event) === JSON.stringify(events[index]),
  );
}

function subagentUiEventsFromAgentRun(
  agent: SessionProtocolSnapshot["agents"][string],
): SubagentUiEvent[] {
  const state = subagentStateFromAgentRun(agent);
  const events: SubagentUiEvent[] = [{ type: "subagent_spawned", state }];
  if (agent.progress !== undefined) {
    events.push(subagentProgressEventFromAgentRun(agent));
  }
  if (agent.abortRequested) {
    events.push({ type: "subagent_abort_requested", id: agent.id });
  }
  if (agent.status !== "running") {
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

  const events: SubagentUiEvent[] = [];
  if (!previous.abortRequested && next.abortRequested) {
    events.push({ type: "subagent_abort_requested", id: next.id });
  }
  if (next.status !== "running") {
    events.push({
      type: "subagent_finished",
      state: subagentStateFromAgentRun(next),
    });
    return events;
  }
  if (agentProgressChanged(previous, next)) {
    events.push(subagentProgressEventFromAgentRun(next));
  }
  return events;
}

function subagentStateFromAgentRun(
  agent: SessionProtocolSnapshot["agents"][string],
): Extract<SubagentUiEvent, { type: "subagent_spawned" }>["state"] {
  const status: SubagentStatus =
    agent.status === "succeeded"
      ? "success"
      : agent.status === "failed"
        ? "error"
        : agent.status === "cancelled"
          ? "aborted"
          : "running";
  const state = {
    id: agent.id,
    name: agent.name,
    title: agent.title,
    status,
    ...(agent.modelLabel !== undefined ? { modelLabel: agent.modelLabel } : {}),
    costTotal: agent.costTotal,
    turns: agent.turns,
    toolCalls: agent.toolCalls,
    usage: { ...agent.usage },
    startedAt: agent.startedAt,
    ...(agent.finishedAt !== undefined ? { finishedAt: agent.finishedAt } : {}),
    abortRequested: agent.abortRequested,
    ...(agent.error !== undefined ? { error: agent.error } : {}),
    ...(agent.finalText !== undefined ? { finalText: agent.finalText } : {}),
  };
  return state;
}

function subagentProgressEventFromAgentRun(
  agent: SessionProtocolSnapshot["agents"][string],
): Extract<SubagentUiEvent, { type: "subagent_progress" }> {
  return {
    type: "subagent_progress",
    id: agent.id,
    text: agent.progress ?? "",
    costTotal: agent.costTotal,
    turns: agent.turns,
    toolCalls: agent.toolCalls,
    usage: { ...agent.usage },
  };
}

function agentProgressChanged(
  previous: SessionProtocolSnapshot["agents"][string],
  next: SessionProtocolSnapshot["agents"][string],
): boolean {
  return (
    previous.progress !== next.progress ||
    previous.costTotal !== next.costTotal ||
    previous.turns !== next.turns ||
    previous.toolCalls !== next.toolCalls ||
    previous.usage.input !== next.usage.input ||
    previous.usage.output !== next.usage.output ||
    previous.usage.cacheRead !== next.usage.cacheRead ||
    previous.usage.cacheWrite !== next.usage.cacheWrite ||
    previous.usage.contextWindowUsageTokens !== next.usage.contextWindowUsageTokens ||
    previous.usage.contextWindow !== next.usage.contextWindow
  );
}
