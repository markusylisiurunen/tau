import { randomUUID } from "node:crypto";
import { realpathSync, statSync } from "node:fs";
import { mkdtemp, readFile, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative, resolve, sep } from "node:path";
import type {
  AssistantMessage,
  KnownProvider,
  Message,
  ToolCall,
  ToolResultMessage,
} from "@mariozechner/pi-ai";
import { formatCodexAuthError } from "../core/auth/auth_messages.js";
import { getAuthPath } from "../core/auth/auth_paths.js";
import { AuthStorage } from "../core/auth/auth_storage.js";
import {
  type CredentialResolver,
  createCredentialResolver,
} from "../core/auth/credential_resolver.js";
import {
  type Command,
  type CommandDispatchContext,
  type CommandRegistry,
  createCommandRegistry,
  getRiskLevelDescription,
} from "../core/commands/index.js";
import {
  type BashCommand,
  type Config,
  createDefaultConfigDeps,
  getMistralApiKey,
  loadRuntimeConfig,
  type RuntimeConfigResult,
  type ThemeDefinition,
} from "../core/config/index.js";
import type { CoreEvent } from "../core/events/types.js";
import type { PromptTemplate } from "../core/prompts.js";
import { ChatRuntime } from "../core/runtime/chat_runtime.js";
import type { ConversationTurnResult } from "../core/runtime/conversation_turn_runtime.js";
import { type CoreDeps, createDefaultCoreDeps } from "../core/runtime/deps.js";
import { createCheckpoint } from "../core/session/checkpoint.js";
import type { CoreSession } from "../core/session/core_session.js";
import {
  buildBashUiText,
  formatBashUserMessageText,
  getBashOutputPolicy,
  prepareBashOutput,
} from "../core/tools/bash.js";
import { ToolCatalog } from "../core/tools/catalog.js";
import type { ToolExecutionBackend } from "../core/tools/execution_backend.js";
import { createLocalToolExecutionBackend } from "../core/tools/execution_backend.js";
import { TOOL_NAME_BASH, TOOL_NAME_EDIT } from "../core/tools/tool_names.js";
import {
  type Persona,
  REASONING_LEVELS,
  type ReasoningEffort,
  type RiskLevel,
  type Skill,
} from "../core/types.js";
import { resolveAgentCwd, resolveSandboxPath } from "../core/utils/agent_environment.js";
import { findAgentsFilesFromCwdToHome } from "../core/utils/agents_files.js";
import {
  buildProjectContextBlock,
  buildSkillsIndexBlock,
  findAgentsFilesInScopeDetailed,
  formatCwdChangeNotice,
  formatProjectContextChangeNotice,
  formatRiskLevelChangeNotice,
} from "../core/utils/context.js";
import { formatAdaptiveNumber, formatCwd, formatTokenWindow } from "../core/utils/format.js";
import { getGitRoot } from "../core/utils/git.js";
import { buildLineDiff, collapseLongUnchangedDiffRuns } from "../core/utils/line_diff.js";
import { extractAllFencedCodeBlocks, extractAssistantText } from "../core/utils/messages.js";
import { transcribeMistralAudio } from "../core/utils/mistral_transcription.js";
import { streamModel } from "../core/utils/model_stream.js";
import { listProjectFilesAsync } from "../core/utils/project_files.js";
import type { SpawnCaptureResult } from "../core/utils/spawn_capture.js";
import { bytesToTokens, formatTokenEstimate, tokensToBytes } from "../core/utils/token.js";
import { truncateToBytesFromStart } from "../core/utils/truncate.js";
import { APP_VERSION } from "../core/version.js";
import type { ChatInputMode, ChatView, ChatViewInputHandlers } from "./chat_view.js";
import { copyTextToClipboard } from "./clipboard.js";
import { DOUBLE_PRESS_WINDOW_MS } from "./constants.js";
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
  initialHistory?: Message[];
  noAgentContextFiles?: boolean;
  config?: Config;
  sandboxEnabled: boolean;
  caffeinated?: boolean;
  toolBackend?: ToolExecutionBackend;
  toolBackendDispose?: () => Promise<void> | void;
  deps?: CoreDeps;
  queuedUserMessages?: string[];
}

type AssistantState = {
  historyEntryId: string;
  inserted: boolean;
  model: AssistantMessageModel;
};

type ToolResultPruneCandidate = {
  index: number;
  toolResult: ToolResultMessage;
  bytes: number;
  tokens: number;
  order: number;
};

type EditPruneCallDiff = {
  oldText: string;
  newText: string;
};

type EditPruneSummary = {
  callsPruned: number;
  resultsPruned: number;
  bytesRemoved: number;
};

type ReloadScope = "new-session" | "reload-command";

type ReloadPlan = {
  personas: boolean;
  prompts: boolean;
  skills: boolean;
  themes: boolean;
  bashCommands: boolean;
  projectContext: boolean;
};

type ReloadMessage = { text: string; kind: SystemMessageKind };

type ReloadReport = {
  plan: ReloadPlan;
  warnings: string[];
  counts: {
    personas: number;
    prompts: number;
    skills: number;
    themes: number;
    bashCommands: number;
  };
  messages: ReloadMessage[];
};

type SpeakRecording = {
  audioPath: string;
  stopRequested: boolean;
  abortController: AbortController;
  completion: Promise<SpawnCaptureResult>;
  maxDurationTimeout?: ReturnType<typeof setTimeout>;
};

type TurnCaffeinateSession = {
  abortController: AbortController;
  completion: Promise<SpawnCaptureResult>;
};

type BusyTask = {
  requestInterrupt: () => boolean;
};

const RELOAD_PLANS: Record<ReloadScope, ReloadPlan> = {
  "new-session": {
    personas: true,
    prompts: true,
    skills: true,
    themes: true,
    bashCommands: true,
    projectContext: true,
  },
  "reload-command": {
    personas: false,
    prompts: true,
    skills: true,
    themes: true,
    bashCommands: true,
    projectContext: true,
  },
};

const ALLOWED_RISK_LEVELS: RiskLevel[] = ["read-only", "read-write"];
const DEFAULT_PRUNE_FRACTION = 0.25;
const PRUNED_TOOL_RESULT_PREFIX = "[tool result pruned]";
const PRUNED_EDIT_RESULT_PREFIX = "[tool result pruned] edit diff";
const PRUNED_EDIT_ARGUMENT_MARKER = "[content pruned]";
const PRUNE_EDIT_UNCHANGED_CONTEXT_LINES = 4;
const PRUNE_PREVIEW_MAX_TOKENS = 512;
const PRUNE_MAX_OVERAGE_RATIO = 0.1;
const SPEAK_TEMP_FILE_TEMPLATE = "/tmp/tau-speak.XXXXXX";
const SPEAK_RECORDING_MIN_BYTES = 1024;
const SPEAK_RECORDING_MAX_DURATION_MS = 5 * 60 * 1000;
const CAFFEINATE_COMMAND = "/usr/bin/caffeinate";

export class ChatController {
  private readonly view: ChatView;
  private personas: Persona[];
  private currentPersona: Persona;
  private prompts: PromptTemplate[];
  private skills: Skill[];
  private themes: ThemeDefinition[];
  private bashCommands: BashCommand[];
  private readonly initialUserMessage?: string;
  private config: Config;
  private activeThemeId?: string;
  private readonly credentialResolver: CredentialResolver;
  private readonly authPath: string;
  private readonly sandboxEnabled: boolean;
  private readonly caffeinated: boolean;
  private readonly sandboxRootReal?: string;
  private agentCwd: string;
  private readonly includeAgentContext: boolean;

  private readonly runtime: ChatRuntime;
  private readonly engine: CoreSession;
  private readonly commandRegistry: CommandRegistry<CommandDispatchContext>;
  private readonly commandHandlers: CommandDispatchContext;
  private readonly toolBackend: ToolExecutionBackend;
  private readonly toolBackendDispose?: () => Promise<void> | void;
  private readonly deps: CoreDeps;
  private subagentUnsubscribe?: () => void;
  private isStreaming = false;
  private queuedUserMessages: string[];
  private isDrainingQueuedUserMessages = false;
  private pendingIdleNotification = false;
  private isBashMode = false;
  private isBashIncognito = false;
  private isMemoryMode = false;
  private showThinking = false;
  private compactToolUi = true;
  private commandHint?: string;
  private activeBusyTask?: BusyTask;
  private riskLevel: RiskLevel = "read-only";
  private projectContextBlock?: string;
  private projectFiles: string[] = [];
  private projectFilesCwd?: string;
  private isRefreshingProjectFiles = false;
  private isInFileAutocomplete = false;
  private agentsFiles: string[];
  private agentsConfigErrors: string[];
  private pendingRiskLevelChange?: { from: RiskLevel; to: RiskLevel };
  private pendingCwdChange?: { from: string; to: string };
  private pendingProjectContextChange?: { from?: string; to?: string };
  private expandedFilesInCurrentPrompt: Set<string> = new Set();
  private expandedSkillsInCurrentPrompt: Set<string> = new Set();
  private assistantState?: AssistantState;
  private currentTurnStartedAt?: number;
  private lastTurnDurationMs = 0;
  private turnTimer?: ReturnType<typeof setInterval>;
  private lastEmptySubmitAt?: number;
  private speakRecording?: SpeakRecording;
  private isTranscribingSpeak = false;
  private speakTransition?: Promise<void>;
  private turnCaffeinate?: TurnCaffeinateSession;
  private disableCaffeinateForSession = false;

  constructor(options: ChatControllerOptions) {
    this.view = options.view;
    this.deps = options.deps ?? createDefaultCoreDeps();
    const cwd = this.deps.env.cwd();
    const home = this.deps.env.home();

    this.personas = options.personas;
    if (this.personas.length === 0) {
      throw new Error(
        "no personas available. add a custom persona in ~/.config/tau/personas or .tau/personas, or unset disableBuiltinPersonas.",
      );
    }
    this.prompts = options.prompts ?? [];
    this.skills = options.skills ?? [];
    this.themes = options.themes ?? [];
    this.bashCommands = options.bashCommands ?? [];
    this.initialUserMessage = options.initialUserMessage;
    this.config = options.config ?? {};
    this.sandboxEnabled = options.sandboxEnabled;
    this.caffeinated = options.caffeinated ?? false;
    this.sandboxRootReal = this.sandboxEnabled ? this.resolveSandboxRoot(cwd) : undefined;
    this.agentCwd = resolveAgentCwd({
      cwd,
      sandboxEnabled: this.sandboxEnabled,
      sandboxConfig: this.config.sandbox,
    });
    this.activeThemeId = this.config.defaultTheme;
    this.authPath = getAuthPath(this.deps.env.home());
    const authStorage = new AuthStorage(this.authPath);
    this.credentialResolver = createCredentialResolver({
      authStorage,
      getConfig: () => this.config,
    });
    this.compactToolUi = true;
    this.queuedUserMessages = options.queuedUserMessages ?? [];
    this.toolBackendDispose = options.toolBackendDispose;

    this.includeAgentContext = !options.noAgentContextFiles;
    if (this.includeAgentContext) {
      const res = findAgentsFilesInScopeDetailed(cwd, home);
      this.agentsFiles = res.files;
      this.agentsConfigErrors = res.errors;
    } else {
      this.agentsFiles = [];
      this.agentsConfigErrors = [];
    }

    this.projectContextBlock = this.includeAgentContext
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
    const skillsContext = this.getSkillsIndexBlockForPersona(this.currentPersona);

    this.toolBackend =
      options.toolBackend ??
      createLocalToolExecutionBackend({
        spawn: this.deps.spawn,
        env: this.deps.env,
      });
    if (this.sandboxEnabled && this.toolBackend.kind !== "sandbox") {
      throw new Error("sandbox enabled but tool backend is not sandboxed.");
    }
    const toolRegistry = ToolCatalog.createRegistry(this.toolBackend);
    this.runtime = ChatRuntime.create({
      persona: this.currentPersona,
      riskLevel: this.riskLevel,
      toolRegistry,
      promptContext: {
        cwd: this.agentCwd,
        hostCwd: cwd,
        home,
        includeAgentContext: this.includeAgentContext,
        projectContextBlock: this.projectContextBlock,
        sandboxEnabled: this.sandboxEnabled,
        sandboxEnvironmentInfo: this.config.sandbox?.environmentInfo,
        skillsBlock: skillsContext.skillsBlock,
      },
      environment: {
        now: () => this.deps.clock.now(),
        platform: () => this.deps.env.platform(),
        nodeVersion: () => this.deps.env.nodeVersion(),
      },
      config: this.config,
      deps: this.deps,
    });
    this.engine = this.runtime.session;
    this.subagentUnsubscribe = this.engine.onSubagentEvent((event) => this.onEvent(event));

    this.commandRegistry = createCommandRegistry();
    this.commandHandlers = {
      help: () => this.showHelp(),
      copyText: () => this.copyLastAssistantText(),
      copyCode: () => this.copyLastAssistantCode(),
      checkpoint: () => this.checkpointSession(),
      newSession: () => this.clearSession(),
      rewind: () => this.startRewindFlow(),
      cd: (path) => this.changeDirectory(path),
      compactSummaryOnly: (extra) => this.compactSessionSummaryOnly(extra),
      compactSummaryAndLast: (extra) => this.compactSessionSummaryAndLast(extra),
      pruneEarliest: (extra) => this.pruneToolResults("earliest", extra),
      pruneLargest: (extra) => this.pruneToolResults("largest", extra),
      pruneSmart: (extra) => this.pruneToolResultsSmart(extra),
      reload: () => this.reloadContent(),
      speak: () => this.toggleSpeakCapture(),
      risk: (level) => this.setRiskLevel(level),
      persona: (id) => this.switchPersona(id),
      prompt: (id) => this.insertPrompt(id),
      theme: (id) => this.switchTheme(id),
      bash: (id) => this.runSavedBashCommand(id),
      unknown: () => this.view.addSystemMessage("unknown command. type /help.", "error"),
    };

    this.view.setThinkingVisibility(this.showThinking);
    this.view.setCompactToolUi(this.compactToolUi);

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
        ["config warnings", ...this.agentsConfigErrors.map((e) => `- ${e}`)].join("\n"),
        "warn",
      );
    }

    this.hydrateCheckpoint(options.initialHistory);
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
    subagents: () => string[];
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
      subagents: () => this.getVisibleSubagentsForPersona(this.currentPersona),
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
      onCtrlY: () => void this.toggleSpeakCapture(),
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
      onAltDown: () => this.cycleSubagentSelection(),
      onCtrlG: () => this.terminateSelectedSubagent(),
      beforeSubmit: (text: string) => this.beforeSubmit(text),
      onChange: (text: string) => this.handleEditorChange(text),
      onSubmit: (text: string) => void this.onUserInput(text),
    };
  }

  async start(): Promise<void> {
    if (this.initialUserMessage) {
      await this.sendInitialUserMessage(this.initialUserMessage);
    }
  }

  async dispose(): Promise<void> {
    this.subagentUnsubscribe?.();
    if (this.speakTransition) {
      await this.speakTransition;
    }
    await this.cancelSpeakCapture();
    await this.stopTurnCaffeinate();
    if (!this.toolBackendDispose) return;
    await this.toolBackendDispose();
  }

  // Mode Adapter ---------------------------------------------------------------------------------

  public async onUserInput(text: string): Promise<void> {
    await this.handleSubmit(text);
  }

  public onInterrupt(): void {
    if (this.speakRecording) {
      void this.runSpeakTransition(() => this.stopSpeakCapture());
      return;
    }

    this.interruptAssistantTurn();
  }

  public onEvent(event: CoreEvent): void {
    switch (event.type) {
      case "assistant_start":
        this.assistantState = {
          historyEntryId: event.historyEntryId,
          inserted: false,
          model: { type: "assistant_partial", text: "", thinking: "" },
        };
        return;

      case "assistant_partial": {
        const state = this.ensureAssistantState(event.historyEntryId);
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

        if (state.inserted) {
          this.view.updateAssistantMessage(state.historyEntryId, model);
        }
        return;
      }

      case "assistant_final": {
        const state = this.ensureAssistantState(event.historyEntryId);
        const model: AssistantMessageModel = { type: "assistant", message: event.message };
        state.model = model;
        if (!state.inserted) {
          this.ensureAssistantInserted(state);
        }
        if (state.inserted) {
          this.view.updateAssistantMessage(state.historyEntryId, model);
        }
        this.refreshStatus();
        this.assistantState = undefined;
        return;
      }

      case "tool_ui":
        this.view.handleToolUiEvent(event.uiEvent);
        this.refreshStatus();
        return;

      case "subagent_ui":
        this.view.handleSubagentEvent(event.event);
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

  private ensureAssistantState(historyEntryId: string): AssistantState {
    if (this.assistantState?.historyEntryId === historyEntryId) {
      return this.assistantState;
    }

    const state: AssistantState = {
      historyEntryId,
      inserted: false,
      model: { type: "assistant_partial", text: "", thinking: "" },
    };
    this.assistantState = state;
    return state;
  }

  private ensureAssistantInserted(state: AssistantState): void {
    if (state.inserted) return;
    state.inserted = true;
    this.view.addMessage(state.model, state.historyEntryId);
  }

  private hydrateCheckpoint(history?: readonly Message[]): void {
    if (!history || history.length === 0) {
      return;
    }

    for (const message of history) {
      const historyEntryId = this.engine.addMessage(message);
      this.renderHistoryMessage(message, historyEntryId);
    }
  }

  private renderHistoryMessage(message: Message, historyEntryId: string): void {
    if (message.role === "user") {
      const text = this.extractUserText(message);
      if (text) {
        this.view.addMessage({ type: "user", text }, historyEntryId);
      }
      return;
    }

    if (message.role === "assistant") {
      this.view.addMessage(
        { type: "assistant", message: message as AssistantMessage },
        historyEntryId,
      );
      return;
    }

    if (message.role === "toolResult") {
      const toolResult = message as ToolResultMessage;
      this.view.addMessage(
        { type: "system", text: this.formatToolResultNotice(toolResult), kind: "muted" },
        historyEntryId,
      );
    }
  }

  private extractUserText(message: Message): string {
    if (typeof message.content === "string") {
      return message.content.trim();
    }
    const parts: string[] = [];
    for (const block of message.content) {
      if (typeof block === "string") {
        parts.push(block);
      } else if (block.type === "text") {
        parts.push(block.text ?? "");
      }
    }
    return parts.join("\n").trim();
  }

  private formatToolResultNotice(toolResult: ToolResultMessage): string {
    const status = toolResult.isError ? "error" : "ok";
    const icon = toolResult.isError ? "✗" : "✓";
    return `${icon} ${toolResult.toolName} (${status})`;
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
        sandboxed: this.sandboxEnabled,
        commandHint: this.commandHint,
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
    if (this.speakRecording) return "recording";
    if (this.isBashIncognito) return "bash_incognito";
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
    const stats = `↑${formatTokenWindow(input)} ↓${formatTokenWindow(output)} (r${formatTokenWindow(read)} w${formatTokenWindow(write)})`;

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

  private getVisibleSubagentsForPersona(persona: Persona): string[] {
    if (!persona.subagents) return [];
    return Object.entries(persona.subagents)
      .filter(([, config]) => config !== undefined)
      .map(([name]) => name);
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
    const message = this.compactToolUi ? "compact tool ui enabled" : "compact tool ui disabled";
    this.view.addSystemMessage(message, "success");
  }

  private changeDirectory(rawPath: string): void {
    const normalized = this.normalizeCdInput(rawPath);
    if (!normalized) {
      this.view.addSystemMessage("missing path for /cd", "warn");
      return;
    }

    const currentCwd = this.deps.env.cwd();
    const home = this.deps.env.home();
    const resolved = this.resolveCdPath(normalized, currentCwd, home);

    let stats: ReturnType<typeof statSync>;
    try {
      stats = statSync(resolved);
    } catch {
      this.view.addSystemMessage(`directory not found: ${normalized}`, "error");
      return;
    }

    if (!stats.isDirectory()) {
      this.view.addSystemMessage(`not a directory: ${normalized}`, "error");
      return;
    }

    if (this.sandboxEnabled && !this.isPathWithinSandboxRoot(resolved)) {
      this.view.addSystemMessage(`directory is outside the sandbox mount: ${normalized}`, "error");
      return;
    }

    try {
      process.chdir(resolved);
    } catch (err) {
      this.view.addSystemMessage(`failed to change directory: ${(err as Error).message}`, "error");
      return;
    }

    const nextCwd = this.deps.env.cwd();
    const previousAgentCwd = this.agentCwd;
    const previousProjectContextBlock = this.projectContextBlock;
    this.agentCwd =
      this.sandboxEnabled && this.sandboxRootReal
        ? resolveSandboxPath({
            hostPath: nextCwd,
            cwd: this.sandboxRootReal,
            sandboxConfig: this.config.sandbox,
          })
        : resolveAgentCwd({
            cwd: nextCwd,
            sandboxEnabled: this.sandboxEnabled,
            sandboxConfig: this.config.sandbox,
          });
    this.refreshProjectContext(nextCwd);
    this.updatePendingProjectContextChange(previousProjectContextBlock, this.projectContextBlock);
    this.projectFiles = [];
    this.refreshProjectFilesInBackground();
    this.expandedFilesInCurrentPrompt.clear();
    this.expandedSkillsInCurrentPrompt.clear();
    this.rebuildSubagentPrompts();
    this.refreshStatus();

    const from = this.pendingCwdChange?.from ?? previousAgentCwd;
    if (from === this.agentCwd) {
      this.pendingCwdChange = undefined;
    } else {
      this.pendingCwdChange = { from, to: this.agentCwd };
    }

    this.view.addSystemMessage(`working directory set to ${formatCwd(nextCwd)}`, "success");
  }

  private normalizeCdInput(rawPath: string): string {
    const trimmed = rawPath.trim();
    if (!trimmed) return "";
    const quote = trimmed[0];
    if ((quote === '"' || quote === "'") && trimmed.endsWith(quote) && trimmed.length > 1) {
      return trimmed.slice(1, -1);
    }
    return trimmed;
  }

  private resolveCdPath(input: string, cwd: string, home: string): string {
    if (input === "~") return home;
    if (input.startsWith("~/")) return join(home, input.slice(2));
    return resolve(cwd, input);
  }

  private resolveSandboxRoot(cwd: string): string | undefined {
    try {
      const root = getGitRoot(cwd) ?? cwd;
      return realpathSync(root);
    } catch {
      return undefined;
    }
  }

  private isPathWithinSandboxRoot(targetPath: string): boolean {
    if (!this.sandboxRootReal) return true;
    let resolved = targetPath;
    try {
      resolved = realpathSync(targetPath);
    } catch {
      // fall back to provided path
    }
    const rel = relative(this.sandboxRootReal, resolved);
    return !(rel === ".." || rel.startsWith(`..${sep}`));
  }

  private refreshProjectContext(cwd: string): void {
    if (!this.includeAgentContext) {
      this.agentsFiles = [];
      this.agentsConfigErrors = [];
      this.projectContextBlock = undefined;
      return;
    }

    const home = this.deps.env.home();
    const res = findAgentsFilesInScopeDetailed(cwd, home);
    this.agentsFiles = res.files;
    this.agentsConfigErrors = res.errors;
    this.projectContextBlock = buildProjectContextBlock({
      cwd,
      home,
      agentsFiles: this.agentsFiles,
      readFile: this.deps.fs.readFile,
    });
  }

  private updatePendingProjectContextChange(previous?: string, next?: string): void {
    if (previous === next) {
      return;
    }

    const from = this.pendingProjectContextChange?.from ?? previous;
    if (from === next) {
      this.pendingProjectContextChange = undefined;
      return;
    }

    this.pendingProjectContextChange = { from, to: next };
  }

  private createAbortBusyTask(): { busyTask: BusyTask; signal: AbortSignal } {
    const abortController = new AbortController();
    return {
      signal: abortController.signal,
      busyTask: {
        requestInterrupt: () => {
          if (abortController.signal.aborted) {
            return false;
          }
          abortController.abort();
          return true;
        },
      },
    };
  }

  private beginBusyTask(task: BusyTask): void {
    this.activeBusyTask = task;
  }

  private endBusyTask(task: BusyTask): void {
    if (this.activeBusyTask === task) {
      this.activeBusyTask = undefined;
    }
  }

  private interruptAssistantTurn(): void {
    if (!this.isStreaming) return;
    if (!this.activeBusyTask) return;
    if (!this.activeBusyTask.requestInterrupt()) return;
    this.view.addSystemMessage("interrupted", "error");
  }

  // Input Handling --------------------------------------------------------------------------------

  private beforeSubmit(text: string): boolean {
    if (this.speakRecording) return false;
    if (!this.isStreaming) return true;
    const trimmed = text.trimStart();
    if (trimmed.startsWith("!")) {
      return false;
    }
    if (trimmed.startsWith("/") && this.isSingleLineInput(text)) {
      const parsed = this.commandRegistry.parse(trimmed);
      if (parsed.type === "unknown") {
        return true;
      }
      return this.commandRegistry.allowsDuringStreaming(parsed);
    }
    return true;
  }

  private isSingleLineInput(text: string): boolean {
    return !/[\r\n]/.test(text);
  }

  private handleEditorChange(text: string): void {
    const wasBash = this.isBashMode;
    const wasBashIncognito = this.isBashIncognito;
    const wasMemory = this.isMemoryMode;
    const wasInFileAutocomplete = this.isInFileAutocomplete;
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

    const beforeCursor = this.getEditorTextBeforeCursor();
    this.isInFileAutocomplete = Boolean(getFileAutocompleteToken(beforeCursor));

    if (!wasInFileAutocomplete && this.isInFileAutocomplete) {
      this.refreshProjectFilesInBackground();
    }

    this.commandHint = this.getCommandHintForInput(text);
    const commandHintChanged = this.commandHint !== previousCommandHint;

    if (
      wasBash !== this.isBashMode ||
      wasBashIncognito !== this.isBashIncognito ||
      wasMemory !== this.isMemoryMode ||
      commandHintChanged
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
    return this.getCommandHint(parsed);
  }

  private getCommandHint(command: Command): string | undefined {
    switch (command.type) {
      case "help":
        return "show available commands";
      case "copyText":
        return "copy last assistant message";
      case "copyCode":
        return "copy last assistant code blocks";
      case "checkpoint":
        return "save a checkpoint file";
      case "new":
        return "clear the session and start fresh";
      case "rewind":
        return "rewind context to a selected prior user message";
      case "cd":
        return "change directory: /cd <path>";
      case "compactSummaryOnly":
        return "summarize session and start new, optional prompt";
      case "compactSummaryAndLast":
        return "summarize session and keep last turn, optional prompt";
      case "pruneEarliest":
        return "prune earliest tool results and compact edit calls, optional fraction 0-1";
      case "pruneLargest":
        return "prune largest tool results and compact edit calls, optional fraction 0-1";
      case "pruneSmart":
        return "prune smart-selected tool results and compact edit calls, optional fraction and guidance";
      case "reload":
        return "reload prompts, skills, themes, bash commands, and AGENTS.md";
      case "speak":
        return "toggle microphone recording and transcribe to editor (macOS only)";
      case "risk":
        return "set risk level: /risk:read-only or /risk:read-write";
      case "bash":
        return "run saved bash command: /bash:<id>";
      case "persona":
        return "switch persona: /persona:<id>";
      case "prompt":
        return "insert prompt template: /prompt:<id>";
      case "theme":
        return "switch theme: /theme:<id>";
      case "unknown":
        return undefined;
    }
  }

  private getEditorTextBeforeCursor(): string {
    const { line, col } = this.view.getEditorCursor();
    const lines = this.view.getEditorLines();
    const current = lines[line] ?? "";
    return current.slice(0, col);
  }

  private refreshProjectFilesInBackground(): void {
    const cwd = this.deps.env.cwd();
    if (this.isRefreshingProjectFiles && this.projectFilesCwd === cwd) return;

    this.isRefreshingProjectFiles = true;
    this.projectFilesCwd = cwd;

    void listProjectFilesAsync(cwd)
      .then((files) => {
        if (this.projectFilesCwd !== cwd) return;
        this.projectFiles = files;
        this.view.requestRender();
      })
      .catch(() => {
        // Ignore refresh errors; autocomplete will keep using the existing cache.
      })
      .finally(() => {
        if (this.projectFilesCwd === cwd) {
          this.isRefreshingProjectFiles = false;
        }
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

  private dequeueQueuedUserMessagesIntoEditor(): void {
    if (this.queuedUserMessages.length === 0) return;

    const editorText = this.view.getEditorText();
    const parts: string[] = [];

    if (editorText !== "") {
      parts.push(editorText);
    }

    parts.push(...this.queuedUserMessages);
    this.queuedUserMessages.length = 0;
    this.view.setEditorText(parts.join("\n\n---\n\n"));
  }

  private cycleSubagentSelection(): void {
    this.view.cycleSubagentSelection(1);
    this.view.requestRender();
  }

  private terminateSelectedSubagent(): void {
    const selectedId = this.view.getSelectedSubagentId();
    if (!selectedId) {
      this.view.addSystemMessage("no active subagent selected", "warn");
      return;
    }

    void this.engine
      .terminateSubagent(selectedId)
      .then((found) => {
        if (!found) {
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
    const trimmed = text.trim();
    const isSingleLine = this.isSingleLineInput(text);
    if (!trimmed) {
      if (this.isStreaming) return;

      const now = Date.now();
      if (
        this.lastEmptySubmitAt !== undefined &&
        now - this.lastEmptySubmitAt <= DOUBLE_PRESS_WINDOW_MS
      ) {
        this.lastEmptySubmitAt = undefined;
        await this.runAssistantTurn();
      } else {
        this.lastEmptySubmitAt = now;
      }
      return;
    }

    this.lastEmptySubmitAt = undefined;

    if (this.isStreaming) {
      if (trimmed.startsWith("/") && isSingleLine) {
        const parsed = this.commandRegistry.parse(trimmed);
        if (parsed.type !== "unknown") {
          if (this.commandRegistry.allowsDuringStreaming(parsed)) {
            await this.commandRegistry.dispatch(parsed, this.commandHandlers);
          }
          return;
        }
      }
      if (trimmed.startsWith("!")) {
        return;
      }
      this.queueUserMessage(trimmed);
      return;
    }

    if (trimmed.startsWith("/") && isSingleLine) {
      const parsed = this.commandRegistry.parse(trimmed);
      if (parsed.type !== "unknown") {
        await this.handleCommand(trimmed);
        return;
      }
    }

    if (trimmed.startsWith("!!")) {
      const command = trimmed.slice(2).trim();
      if (command) {
        await this.runBashCommand(command, { addToContext: false, labelOverride: "incognito" });
      }
      return;
    }

    if (trimmed.startsWith("!")) {
      const command = trimmed.slice(1).trim();
      if (command) await this.runBashCommand(command);
      return;
    }

    if (isSingleLine && trimmed.startsWith("#")) {
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
    this.expandedFilesInCurrentPrompt.clear();
    this.expandedSkillsInCurrentPrompt.clear();

    const notices: string[] = [];
    if (this.pendingRiskLevelChange) {
      notices.push(formatRiskLevelChangeNotice(this.pendingRiskLevelChange));
    }
    if (this.pendingCwdChange) {
      notices.push(formatCwdChangeNotice(this.pendingCwdChange));
    }
    if (this.pendingProjectContextChange) {
      notices.push(
        formatProjectContextChangeNotice({
          projectContextBlock: this.pendingProjectContextChange.to,
        }),
      );
    }
    this.pendingRiskLevelChange = undefined;
    this.pendingCwdChange = undefined;
    this.pendingProjectContextChange = undefined;

    const systemNotice = notices.length > 0 ? notices.join("\n") : undefined;
    const baseTextForModel = opts?.textForModel ?? text;
    const textForModel = systemNotice ? `${systemNotice}\n\n${baseTextForModel}` : baseTextForModel;
    const historyEntryId = this.engine.addUserText(textForModel);
    this.view.addMessage(
      {
        type: "user",
        text,
        isMemoryMode: opts?.isMemoryMode,
      },
      historyEntryId,
    );

    await this.runAssistantTurn();
  }

  private async sendInitialUserMessage(text: string): Promise<void> {
    const trimmed = text.trim();
    if (!trimmed || this.isStreaming) return;

    this.expandedFilesInCurrentPrompt.clear();
    this.expandedSkillsInCurrentPrompt.clear();
    const historyEntryId = this.engine.addUserText(trimmed);
    this.view.addMessage({ type: "user", text: trimmed }, historyEntryId);

    await this.runAssistantTurn();
  }

  private async toggleSpeakCapture(): Promise<void> {
    if (this.speakTransition) {
      this.view.addSystemMessage("speech recording state change already in progress", "warn");
      return;
    }

    if (this.speakRecording) {
      await this.runSpeakTransition(() => this.stopSpeakCapture());
      return;
    }

    if (this.isTranscribingSpeak) {
      this.view.addSystemMessage("speech transcription already in progress", "warn");
      return;
    }

    if (this.isStreaming) {
      this.view.addSystemMessage("wait for the assistant to finish before recording", "warn");
      return;
    }

    await this.runSpeakTransition(() => this.startSpeakCapture());
  }

  private async runSpeakTransition(task: () => Promise<void>): Promise<void> {
    if (this.speakTransition) {
      return;
    }

    const transition = task();
    this.speakTransition = transition;

    try {
      await transition;
    } finally {
      if (this.speakTransition === transition) {
        this.speakTransition = undefined;
      }
    }
  }

  private async startSpeakCapture(): Promise<void> {
    if (this.deps.env.platform() !== "darwin") {
      this.view.addSystemMessage("/speak is currently supported only on macOS.", "warn");
      return;
    }

    const apiKey = getMistralApiKey(this.config, this.deps.env.env());
    if (!apiKey) {
      this.view.addSystemMessage("set MISTRAL_API_KEY or apiKeys.mistral to use /speak", "error");
      return;
    }

    let audioPath: string | undefined;
    try {
      audioPath = await this.createSpeakTempFilePath();
      const abortController = new AbortController();
      const completion = this.deps.spawn(
        "ffmpeg",
        [
          "-hide_banner",
          "-loglevel",
          "error",
          "-nostdin",
          "-f",
          "avfoundation",
          "-i",
          ":0",
          "-ac",
          "1",
          "-ar",
          "16000",
          "-c:a",
          "pcm_s16le",
          "-f",
          "wav",
          "-y",
          audioPath,
        ],
        {
          detached: true,
          killProcessGroup: true,
          signal: abortController.signal,
          stdio: ["ignore", "ignore", "ignore"],
        },
      );

      const recording: SpeakRecording = {
        audioPath,
        stopRequested: false,
        abortController,
        completion,
      };
      recording.maxDurationTimeout = setTimeout(() => {
        if (this.speakRecording !== recording || this.speakTransition) return;
        void this.runSpeakTransition(() => this.stopSpeakCapture());
      }, SPEAK_RECORDING_MAX_DURATION_MS);
      this.speakRecording = recording;
      this.view.setEditorInputEnabled(false);
      this.refreshStatus();
      void this.watchSpeakRecording(recording);
    } catch (err) {
      if (audioPath) {
        await this.cleanupSpeakTempFile(audioPath);
      }
      this.view.addSystemMessage(`failed to start recording: ${(err as Error).message}`, "error");
    }
  }

  private async stopSpeakCapture(): Promise<void> {
    const recording = this.speakRecording;
    if (!recording) return;

    recording.stopRequested = true;
    this.clearSpeakRecordingMaxDurationTimeout(recording);
    this.speakRecording = undefined;
    this.view.setEditorInputEnabled(true);
    this.refreshStatus();

    recording.abortController.abort();

    try {
      await recording.completion;
    } catch (err) {
      this.view.addSystemMessage(`recording failed: ${(err as Error).message}`, "error");
      await this.cleanupSpeakTempFile(recording.audioPath);
      return;
    }

    this.isTranscribingSpeak = true;
    try {
      const audio = await readFile(recording.audioPath);
      if (audio.byteLength < SPEAK_RECORDING_MIN_BYTES) {
        this.view.addSystemMessage("recording too short, try again", "warn");
        return;
      }

      const transcript = await this.transcribeSpeakAudio(audio);
      const text = transcript.trim();
      if (!text) {
        return;
      }

      this.view.insertEditorTextAtCursor(text);
    } catch (err) {
      this.view.addSystemMessage(`speech transcription failed: ${(err as Error).message}`, "error");
    } finally {
      this.isTranscribingSpeak = false;
      await this.cleanupSpeakTempFile(recording.audioPath);
    }
  }

  private async cancelSpeakCapture(): Promise<void> {
    const recording = this.speakRecording;
    if (!recording) return;

    recording.stopRequested = true;
    this.clearSpeakRecordingMaxDurationTimeout(recording);
    this.speakRecording = undefined;
    this.view.setEditorInputEnabled(true);
    this.refreshStatus();

    recording.abortController.abort();
    try {
      await recording.completion;
    } catch {
      // ignore disposal errors
    }
    await this.cleanupSpeakTempFile(recording.audioPath);
  }

  private async watchSpeakRecording(recording: SpeakRecording): Promise<void> {
    try {
      const result = await recording.completion;
      this.clearSpeakRecordingMaxDurationTimeout(recording);
      if (this.speakRecording !== recording || recording.stopRequested) return;

      this.speakRecording = undefined;
      this.view.setEditorInputEnabled(true);
      this.refreshStatus();
      const detail =
        result.exitCode !== null
          ? `ffmpeg exited with code ${result.exitCode}`
          : result.closeSignal
            ? `ffmpeg terminated by signal ${result.closeSignal}`
            : "ffmpeg exited";
      this.view.addSystemMessage(`recording stopped unexpectedly (${detail})`, "error");
      await this.cleanupSpeakTempFile(recording.audioPath);
    } catch (err) {
      this.clearSpeakRecordingMaxDurationTimeout(recording);
      if (this.speakRecording !== recording || recording.stopRequested) return;

      this.speakRecording = undefined;
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
      await this.cleanupSpeakTempFile(recording.audioPath);
    }
  }

  private clearSpeakRecordingMaxDurationTimeout(recording: SpeakRecording): void {
    if (!recording.maxDurationTimeout) return;
    clearTimeout(recording.maxDurationTimeout);
    recording.maxDurationTimeout = undefined;
  }

  private async createSpeakTempFilePath(): Promise<string> {
    const result = await this.deps.spawn("mktemp", [SPEAK_TEMP_FILE_TEMPLATE]);
    if (result.exitCode !== 0) {
      const message = result.stderr.trim() || result.stdout.trim() || "mktemp failed";
      throw new Error(message);
    }

    const path = result.stdout.trim().split(/\r?\n/, 1)[0]?.trim();
    if (!path) {
      throw new Error("mktemp returned an empty path");
    }
    return path;
  }

  private async transcribeSpeakAudio(audio: Buffer): Promise<string> {
    const apiKey = getMistralApiKey(this.config, this.deps.env.env());
    if (!apiKey) {
      throw new Error("missing MISTRAL_API_KEY or apiKeys.mistral");
    }

    return await transcribeMistralAudio({
      apiKey,
      audio,
      mimeType: "audio/wav",
      fileName: "speech.wav",
      language: "en",
    });
  }

  private async cleanupSpeakTempFile(path: string): Promise<void> {
    try {
      await unlink(path);
    } catch {
      // best-effort cleanup
    }
  }

  private getMemoryModeFilePath(): string {
    const cwd = this.deps.env.cwd();
    const home = this.deps.env.home();
    const nearestAgentsFiles = findAgentsFilesFromCwdToHome(cwd, home);
    const hostPath =
      nearestAgentsFiles.length > 0 ? nearestAgentsFiles[0]! : resolve(join(cwd, "AGENTS.md"));
    if (this.sandboxEnabled) {
      return resolveSandboxPath({
        hostPath,
        cwd,
        sandboxConfig: this.config.sandbox,
      });
    }
    return hostPath;
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

  private async copyLastAssistantText(): Promise<void> {
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

  private async copyLastAssistantCode(): Promise<void> {
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

  private async checkpointSession(): Promise<void> {
    const history = this.engine.history;
    if (history.length === 0) {
      this.view.addSystemMessage("no conversation to checkpoint.", "warn", { persist: false });
      return;
    }

    try {
      const checkpoint = createCheckpoint({
        personaId: this.currentPersona.id,
        reasoning: this.currentPersona.settings.reasoning ?? "none",
        riskLevel: this.riskLevel,
        history: [...history],
      });
      const dir = await mkdtemp(join(tmpdir(), "tau-checkpoint-"));
      const filePath = join(dir, "checkpoint.json");
      await writeFile(filePath, JSON.stringify(checkpoint, null, 2), "utf8");
      this.view.addSystemMessage(`tau -l ${filePath}`, "muted");
    } catch (err) {
      this.view.addSystemMessage(`checkpoint failed: ${(err as Error).message}`, "error", {
        persist: false,
      });
    }
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

  private startRewindFlow(): void {
    const candidates = this.engine.listRewindCandidates().map((candidate) => ({
      id: candidate.historyEntryId,
      label: this.formatRewindCandidateLabel(candidate.text),
    }));

    if (candidates.length === 0) {
      this.view.addSystemMessage("no user messages available to rewind.", "warn");
      return;
    }

    this.view.showRewindPicker({
      items: candidates,
      onSelect: (id) => {
        const selected = candidates.find((candidate) => candidate.id === id);
        if (!selected) {
          this.view.hideRewindPicker();
          this.view.addSystemMessage("rewind selection failed.", "error");
          return;
        }
        this.applyRewindSelection(selected.id);
      },
      onCancel: () => {
        this.view.hideRewindPicker();
      },
    });
  }

  private applyRewindSelection(historyEntryId: string): void {
    this.view.hideRewindPicker();

    const rewound = this.engine.rewindToHistoryEntryId(historyEntryId);
    if (!rewound) {
      this.view.addSystemMessage("rewind failed.", "error");
      return;
    }

    this.view.removeMessagesFrom(rewound.historyEntryId);
    this.view.removeMessages(rewound.removedEntryIds);

    this.expandedFilesInCurrentPrompt.clear();
    this.expandedSkillsInCurrentPrompt.clear();
    this.view.setEditorText(rewound.text);
    this.refreshStatus();
  }

  private formatRewindCandidateLabel(text: string): string {
    const firstLine = text.split(/\r?\n/, 1)[0]?.trim() ?? "";
    if (!firstLine) {
      return "(empty user message)";
    }
    return firstLine;
  }

  private async clearSession(): Promise<void> {
    this.engine.reset();
    this.view.resetToolUiSession();
    this.expandedFilesInCurrentPrompt.clear();
    this.expandedSkillsInCurrentPrompt.clear();
    this.view.addMessage({ type: "session_divider", label: "new session" });
    this.isBashMode = false;
    this.isBashIncognito = false;
    this.isMemoryMode = false;
    this.pendingRiskLevelChange = undefined;
    this.pendingCwdChange = undefined;
    this.pendingProjectContextChange = undefined;

    try {
      const report = await this.refreshReloadableContent("new-session");
      this.applyReloadMessages(report.messages);
    } catch (err) {
      this.view.addSystemMessage(`reload failed: ${(err as Error).message}`, "error");
    }

    this.rebuildSystemPromptForCurrentPersona();
    this.refreshStatus();
  }

  private escapeXml(text: string): string {
    return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }

  private escapeXmlAttribute(text: string): string {
    return this.escapeXml(text).replace(/"/g, "&quot;").replace(/'/g, "&apos;");
  }

  private syncRuntimePromptContext(): void {
    this.runtime.updatePromptContext({
      cwd: this.agentCwd,
      hostCwd: this.deps.env.cwd(),
      home: this.deps.env.home(),
      includeAgentContext: this.includeAgentContext,
      projectContextBlock: this.projectContextBlock,
      sandboxEnabled: this.sandboxEnabled,
      sandboxEnvironmentInfo: this.config.sandbox?.environmentInfo,
    });
  }

  private rebuildSystemPrompt(skillsBlock?: string): void {
    const resolvedSkillsBlock =
      skillsBlock ?? this.getSkillsIndexBlockForPersona(this.currentPersona).skillsBlock;
    this.syncRuntimePromptContext();
    this.runtime.setPersona(this.currentPersona, { skillsBlock: resolvedSkillsBlock });
  }

  private rebuildSubagentPrompts(skillsBlock?: string): void {
    const resolvedSkillsBlock =
      skillsBlock ?? this.getSkillsIndexBlockForPersona(this.currentPersona).skillsBlock;
    this.syncRuntimePromptContext();
    this.runtime.rebuildSubagentPrompts({ skillsBlock: resolvedSkillsBlock });
  }

  private applyCompactedHistoryUi(compactionMessage: string): void {
    this.view.resetToolUiSession();
    this.expandedFilesInCurrentPrompt.clear();
    this.expandedSkillsInCurrentPrompt.clear();
    this.view.addMessage({ type: "session_divider", label: "new session" });
    const summaryEntryId = this.engine.historyEntries[0]?.id;
    this.view.addMessage({ type: "user", text: compactionMessage }, summaryEntryId);

    this.isBashMode = false;
    this.isBashIncognito = false;
    this.isMemoryMode = false;

    this.rebuildSystemPrompt();
    this.refreshStatus();
  }

  private handleCompactionError(err: unknown): void {
    const message = (err as Error).message || "compaction failed";
    if (message === "no conversation to compact.") {
      this.view.addSystemMessage(message, "warn");
      return;
    }
    this.view.addSystemMessage(`compact failed: ${message}`, "error");
  }

  private async compactSessionSummaryOnly(guidance?: string): Promise<void> {
    this.view.addSystemMessage("summarizing session...", "success");
    this.isStreaming = true;
    this.view.startWorkingIcon();
    const { busyTask, signal } = this.createAbortBusyTask();
    this.beginBusyTask(busyTask);

    try {
      const result = await this.engine.compact({
        mode: "only-summary",
        guidance,
        signal,
      });
      this.applyCompactedHistoryUi(result.compactionMessage);

      this.view.addSystemMessage(
        "session compacted. previous context has been summarized.",
        "success",
      );
    } catch (err) {
      if (!signal.aborted) {
        this.handleCompactionError(err);
      }
    } finally {
      this.endBusyTask(busyTask);
      this.view.stopWorkingIcon();
      this.isStreaming = false;
      this.view.requestRender();
      if (signal.aborted) {
        this.dequeueQueuedUserMessagesIntoEditor();
      } else {
        void this.drainQueuedUserMessages();
      }
    }
  }

  private async compactSessionSummaryAndLast(guidance?: string): Promise<void> {
    this.view.addSystemMessage("summarizing session...", "success");
    this.isStreaming = true;
    this.view.startWorkingIcon();
    const { busyTask, signal } = this.createAbortBusyTask();
    this.beginBusyTask(busyTask);

    try {
      const result = await this.engine.compact({
        mode: "with-last-assistant",
        guidance,
        signal,
      });
      this.applyCompactedHistoryUi(result.compactionMessage);

      const successText = result.includedLastAssistant
        ? "session compacted. previous context and last assistant message have been included."
        : "session compacted. previous context has been summarized.";
      this.view.addSystemMessage(successText, "success");
    } catch (err) {
      if (!signal.aborted) {
        this.handleCompactionError(err);
      }
    } finally {
      this.endBusyTask(busyTask);
      this.view.stopWorkingIcon();
      this.isStreaming = false;
      this.view.requestRender();
      if (signal.aborted) {
        this.dequeueQueuedUserMessagesIntoEditor();
      } else {
        void this.drainQueuedUserMessages();
      }
    }
  }

  private pruneToolResults(strategy: "earliest" | "largest", extra?: string): void {
    const fraction = this.parsePruneFraction(extra);
    if (fraction === null) {
      this.view.addSystemMessage("invalid prune fraction. use a number between 0 and 1.", "error");
      return;
    }

    if (fraction === 0) {
      this.view.addSystemMessage("prune fraction is 0, nothing to prune.", "warn");
      return;
    }

    const history = this.engine.history;
    if (history.length === 0) {
      this.view.addSystemMessage("no conversation to prune.", "warn");
      return;
    }

    const editSummary = this.pruneEditToolHistory(history);

    const candidates: ToolResultPruneCandidate[] = [];
    let totalTokens = 0;

    for (let index = 0; index < history.length; index++) {
      const message = history[index];
      if (message?.role !== "toolResult") continue;
      const toolResult = message as ToolResultMessage;
      if (toolResult.toolName !== TOOL_NAME_BASH) {
        continue;
      }
      const info = this.getToolResultContentInfo(toolResult);
      if (info.firstText?.startsWith(PRUNED_TOOL_RESULT_PREFIX)) {
        continue;
      }
      if (info.hasImage) {
        continue;
      }
      const tokens = bytesToTokens(info.bytes);
      candidates.push({
        index,
        toolResult,
        bytes: info.bytes,
        tokens,
        order: candidates.length,
      });
      totalTokens += tokens;
    }

    if (candidates.length === 0 || totalTokens === 0) {
      if (this.hasAnyPrunedEditChanges(editSummary)) {
        this.view.addSystemMessage(this.buildPruneSummaryMessage(editSummary), "success");
      } else {
        this.view.addSystemMessage("no bash tool results or edit tool calls to prune.", "warn");
      }
      return;
    }

    const targetTokens = Math.ceil(totalTokens * fraction);
    if (targetTokens <= 0) {
      if (this.hasAnyPrunedEditChanges(editSummary)) {
        this.view.addSystemMessage(this.buildPruneSummaryMessage(editSummary), "success");
      } else {
        this.view.addSystemMessage("prune fraction is too small to remove anything.", "warn");
      }
      return;
    }

    const ordered =
      strategy === "largest"
        ? [...candidates].sort(
            (a, b) => b.tokens - a.tokens || b.bytes - a.bytes || a.order - b.order,
          )
        : candidates;

    const toPrune: ToolResultPruneCandidate[] = [];
    let prunedTokens = 0;
    let prunedBytes = 0;

    for (const candidate of ordered) {
      if (prunedTokens >= targetTokens) break;
      toPrune.push(candidate);
      prunedTokens += candidate.tokens;
      prunedBytes += candidate.bytes;
    }

    if (toPrune.length === 0) {
      if (this.hasAnyPrunedEditChanges(editSummary)) {
        this.view.addSystemMessage(this.buildPruneSummaryMessage(editSummary), "success");
      } else {
        this.view.addSystemMessage("no bash tool results or edit tool calls to prune.", "warn");
      }
      return;
    }

    for (const candidate of toPrune) {
      const noticeText = this.buildPrunedToolResultNotice(candidate.toolResult, candidate.bytes);
      const prunedResult: ToolResultMessage = {
        ...candidate.toolResult,
        content: [{ type: "text", text: noticeText }],
      };
      this.engine.replaceMessage(candidate.index, prunedResult);
      this.emitToolResultPrunedUiEvent(prunedResult.toolCallId, noticeText);
    }

    this.view.addSystemMessage(
      this.buildPruneSummaryMessage(editSummary, toPrune.length, prunedBytes),
      "success",
    );
  }

  private async pruneToolResultsSmart(extra?: string): Promise<void> {
    const parsed = this.parsePruneFractionAndGuidance(extra);
    if (parsed.fraction === null) {
      this.view.addSystemMessage("invalid prune fraction. use a number between 0 and 1.", "error");
      return;
    }

    const fraction = parsed.fraction;
    if (fraction === 0) {
      this.view.addSystemMessage("prune fraction is 0, nothing to prune.", "warn");
      return;
    }

    const history = this.engine.history;
    if (history.length === 0) {
      this.view.addSystemMessage("no conversation to prune.", "warn");
      return;
    }

    let editSummary: EditPruneSummary | undefined;
    const getEditSummary = (): EditPruneSummary => {
      if (!editSummary) {
        editSummary = this.pruneEditToolHistory(history);
      }
      return editSummary;
    };

    const candidates: ToolResultPruneCandidate[] = [];
    let totalTokens = 0;

    for (let index = 0; index < history.length; index++) {
      const message = history[index];
      if (message?.role !== "toolResult") continue;
      const toolResult = message as ToolResultMessage;
      if (toolResult.toolName !== TOOL_NAME_BASH) {
        continue;
      }
      const details = this.getToolResultContentDetails(toolResult);
      if (details.firstText?.startsWith(PRUNED_TOOL_RESULT_PREFIX)) {
        continue;
      }
      if (details.hasImage) {
        continue;
      }
      const tokens = bytesToTokens(details.bytes);
      candidates.push({
        index,
        toolResult,
        bytes: details.bytes,
        tokens,
        order: candidates.length,
      });
      totalTokens += tokens;
    }

    if (candidates.length === 0 || totalTokens === 0) {
      const summary = getEditSummary();
      if (this.hasAnyPrunedEditChanges(summary)) {
        this.view.addSystemMessage(this.buildPruneSummaryMessage(summary), "success");
      } else {
        this.view.addSystemMessage("no bash tool results or edit tool calls to prune.", "warn");
      }
      return;
    }

    const targetTokens = Math.ceil(totalTokens * fraction);
    if (targetTokens <= 0) {
      const summary = getEditSummary();
      if (this.hasAnyPrunedEditChanges(summary)) {
        this.view.addSystemMessage(this.buildPruneSummaryMessage(summary), "success");
      } else {
        this.view.addSystemMessage("prune fraction is too small to remove anything.", "warn");
      }
      return;
    }

    this.view.addSystemMessage("sampling prune candidates...", "success");
    this.isStreaming = true;
    this.view.startWorkingIcon();
    const { busyTask, signal } = this.createAbortBusyTask();
    this.beginBusyTask(busyTask);

    try {
      const prompt = this.buildSmartPrunePrompt({
        history,
        targetTokens,
        guidance: parsed.guidance,
      });
      const selection = await this.requestSmartPruneSelection(prompt, signal);
      if (selection.length === 0) {
        const summary = getEditSummary();
        if (this.hasAnyPrunedEditChanges(summary)) {
          this.view.addSystemMessage(this.buildPruneSummaryMessage(summary), "success");
        } else {
          this.view.addSystemMessage("model returned no prune candidates.", "warn");
        }
        return;
      }

      const toPrune = this.selectSmartPruneCandidates(selection, candidates, targetTokens);

      if (toPrune.length === 0) {
        const summary = getEditSummary();
        if (this.hasAnyPrunedEditChanges(summary)) {
          this.view.addSystemMessage(this.buildPruneSummaryMessage(summary), "success");
        } else {
          this.view.addSystemMessage("no bash tool results or edit tool calls to prune.", "warn");
        }
        return;
      }

      const summary = getEditSummary();
      let prunedBytes = 0;
      for (const candidate of toPrune) {
        prunedBytes += candidate.bytes;
        const noticeText = this.buildPrunedToolResultNotice(candidate.toolResult, candidate.bytes);
        const prunedResult: ToolResultMessage = {
          ...candidate.toolResult,
          content: [{ type: "text", text: noticeText }],
        };
        this.engine.replaceMessage(candidate.index, prunedResult);
        this.emitToolResultPrunedUiEvent(prunedResult.toolCallId, noticeText);
      }

      this.view.addSystemMessage(
        this.buildPruneSummaryMessage(summary, toPrune.length, prunedBytes),
        "success",
      );
    } catch (err) {
      if (!signal.aborted) {
        this.view.addSystemMessage(`prune failed: ${(err as Error).message}`, "error");
      }
    } finally {
      this.endBusyTask(busyTask);
      this.view.stopWorkingIcon();
      this.isStreaming = false;
      this.view.requestRender();
      if (signal.aborted) {
        this.dequeueQueuedUserMessagesIntoEditor();
      } else {
        void this.drainQueuedUserMessages();
      }
    }
  }

  private parsePruneFraction(extra?: string): number | null {
    if (!extra) {
      return DEFAULT_PRUNE_FRACTION;
    }
    const parsed = Number(extra);
    if (!Number.isFinite(parsed)) {
      return null;
    }
    if (parsed < 0 || parsed > 1) {
      return null;
    }
    return parsed;
  }

  private parsePruneFractionAndGuidance(extra?: string): {
    fraction: number | null;
    guidance?: string;
  } {
    if (!extra) {
      return { fraction: DEFAULT_PRUNE_FRACTION };
    }

    const trimmed = extra.trim();
    if (!trimmed) {
      return { fraction: DEFAULT_PRUNE_FRACTION };
    }

    const [firstToken, ...rest] = trimmed.split(/\s+/);
    const parsed = Number(firstToken);
    if (Number.isFinite(parsed)) {
      if (parsed < 0 || parsed > 1) {
        return { fraction: null };
      }
      const guidance = rest.join(" ").trim();
      return guidance ? { fraction: parsed, guidance } : { fraction: parsed };
    }

    return { fraction: DEFAULT_PRUNE_FRACTION, guidance: trimmed };
  }

  private hasAnyPrunedEditChanges(summary: EditPruneSummary): boolean {
    return summary.callsPruned > 0 || summary.resultsPruned > 0;
  }

  private buildPruneSummaryMessage(
    editSummary: EditPruneSummary,
    bashResultsPruned: number = 0,
    bashBytesPruned: number = 0,
  ): string {
    const editSummaryText = this.formatPrunedEditSummary(editSummary);

    if (bashResultsPruned <= 0) {
      if (!editSummaryText) {
        return "no bash tool results or edit tool calls to prune.";
      }
      return `pruned ${editSummaryText}.`;
    }

    const bashLabel = formatTokenEstimate(bashBytesPruned);
    const bashNoun = bashResultsPruned === 1 ? "result" : "results";
    if (!editSummaryText) {
      return `pruned ${bashResultsPruned} bash tool ${bashNoun} (${bashLabel}).`;
    }

    return `pruned ${bashResultsPruned} bash tool ${bashNoun} (${bashLabel}) and ${editSummaryText}.`;
  }

  private formatPrunedEditSummary(summary: EditPruneSummary): string {
    if (!this.hasAnyPrunedEditChanges(summary)) {
      return "";
    }

    const parts: string[] = [];
    if (summary.callsPruned > 0) {
      const noun = summary.callsPruned === 1 ? "call" : "calls";
      parts.push(`${summary.callsPruned} edit tool ${noun}`);
    }
    if (summary.resultsPruned > 0) {
      const noun = summary.resultsPruned === 1 ? "result" : "results";
      parts.push(`${summary.resultsPruned} edit tool ${noun}`);
    }

    const tokenEstimate = formatTokenEstimate(summary.bytesRemoved);
    return `${parts.join(" and ")} (${tokenEstimate})`;
  }

  private pruneEditToolHistory(history: readonly Message[]): EditPruneSummary {
    const summary: EditPruneSummary = {
      callsPruned: 0,
      resultsPruned: 0,
      bytesRemoved: 0,
    };
    const editCallsById = new Map<string, EditPruneCallDiff>();

    for (let index = 0; index < history.length; index++) {
      const message = history[index];
      if (message?.role !== "assistant") {
        continue;
      }

      const assistant = message as AssistantMessage;
      let changed = false;
      const nextContent = assistant.content.map((block) => {
        if (typeof block === "string" || block.type !== "toolCall") {
          return block;
        }

        const toolCall = block as ToolCall;
        if (toolCall.name !== TOOL_NAME_EDIT) {
          return block;
        }

        const args = this.getToolCallArgumentsObject(toolCall.arguments);
        if (!args) {
          return block;
        }

        const oldText = typeof args.oldText === "string" ? args.oldText : undefined;
        const newText = typeof args.newText === "string" ? args.newText : undefined;
        if (oldText === undefined || newText === undefined) {
          return block;
        }

        if (oldText === PRUNED_EDIT_ARGUMENT_MARKER && newText === PRUNED_EDIT_ARGUMENT_MARKER) {
          return block;
        }

        changed = true;
        summary.callsPruned += 1;
        const oldBytes = Buffer.byteLength(oldText, "utf8");
        const newBytes = Buffer.byteLength(newText, "utf8");
        const markerBytes = Buffer.byteLength(PRUNED_EDIT_ARGUMENT_MARKER, "utf8") * 2;
        summary.bytesRemoved += Math.max(0, oldBytes + newBytes - markerBytes);
        editCallsById.set(toolCall.id, { oldText, newText });

        return {
          ...toolCall,
          arguments: {
            ...args,
            oldText: PRUNED_EDIT_ARGUMENT_MARKER,
            newText: PRUNED_EDIT_ARGUMENT_MARKER,
          },
        };
      });

      if (changed) {
        this.engine.replaceMessage(index, { ...assistant, content: nextContent });
      }
    }

    if (editCallsById.size === 0) {
      return summary;
    }

    for (let index = 0; index < history.length; index++) {
      const message = history[index];
      if (message?.role !== "toolResult") {
        continue;
      }

      const toolResult = message as ToolResultMessage;
      if (toolResult.toolName !== TOOL_NAME_EDIT) {
        continue;
      }
      if (toolResult.isError) {
        continue;
      }

      const callDiff = editCallsById.get(toolResult.toolCallId);
      if (!callDiff) {
        continue;
      }

      const info = this.getToolResultContentInfo(toolResult);
      if (info.firstText?.startsWith(PRUNED_EDIT_RESULT_PREFIX)) {
        continue;
      }

      const prunedText = this.buildPrunedEditToolResult(callDiff);
      const prunedResult: ToolResultMessage = {
        ...toolResult,
        content: [{ type: "text", text: prunedText }],
      };
      this.engine.replaceMessage(index, prunedResult);
      this.emitToolResultPrunedUiEvent(prunedResult.toolCallId, prunedText);
      summary.resultsPruned += 1;
    }

    return summary;
  }

  private getToolCallArgumentsObject(argumentsValue: unknown): Record<string, unknown> | undefined {
    if (argumentsValue && typeof argumentsValue === "object" && !Array.isArray(argumentsValue)) {
      return argumentsValue as Record<string, unknown>;
    }

    if (typeof argumentsValue !== "string") {
      return undefined;
    }

    try {
      const parsed = JSON.parse(argumentsValue);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        return undefined;
      }
      return parsed as Record<string, unknown>;
    } catch {
      return undefined;
    }
  }

  private buildPrunedEditToolResult(diff: EditPruneCallDiff): string {
    const diffText = this.buildPrunedEditDiff(diff.oldText, diff.newText);
    return `${PRUNED_EDIT_RESULT_PREFIX}\n${diffText}`;
  }

  private buildPrunedEditDiff(oldText: string, newText: string): string {
    const diff = buildLineDiff(oldText, newText);
    if (diff.added === 0 && diff.removed === 0) {
      return "(no textual changes)";
    }

    const collapsed = collapseLongUnchangedDiffRuns({
      diffLines: diff.lines,
      maxUnchangedLines: PRUNE_EDIT_UNCHANGED_CONTEXT_LINES,
    });

    return collapsed.length > 0 ? collapsed.join("\n") : "(no textual changes)";
  }

  private buildPrunedToolResultNotice(toolResult: ToolResultMessage, bytes: number): string {
    const tokenEstimate = formatTokenEstimate(bytes);
    return `${PRUNED_TOOL_RESULT_PREFIX} ${toolResult.toolName} output removed (${tokenEstimate}). re-run the command if needed.`;
  }

  private emitToolResultPrunedUiEvent(toolCallId: string, content: string): void {
    this.view.handleToolUiEvent({
      type: "tool_pruned",
      toolCallId,
      content,
    });
  }

  private getToolResultContentInfo(toolResult: ToolResultMessage): {
    bytes: number;
    hasImage: boolean;
    firstText?: string;
  } {
    if (typeof toolResult.content === "string") {
      const text = toolResult.content;
      return { bytes: Buffer.byteLength(text, "utf8"), hasImage: false, firstText: text };
    }

    let bytes = 0;
    let hasImage = false;
    let firstText: string | undefined;

    if (!Array.isArray(toolResult.content)) {
      return { bytes, hasImage, firstText };
    }

    for (const block of toolResult.content) {
      if (typeof block === "string") {
        if (firstText === undefined) {
          firstText = block;
        }
        bytes += Buffer.byteLength(block, "utf8");
        continue;
      }

      if (block.type === "text") {
        const text = block.text ?? "";
        if (firstText === undefined) {
          firstText = text;
        }
        bytes += Buffer.byteLength(text, "utf8");
        continue;
      }

      if (block.type === "image") {
        hasImage = true;
      }
    }

    return { bytes, hasImage, firstText };
  }

  private getToolResultContentDetails(toolResult: ToolResultMessage): {
    text: string;
    bytes: number;
    hasImage: boolean;
    firstText?: string;
  } {
    if (typeof toolResult.content === "string") {
      const text = (toolResult.content as string).trimEnd();
      return {
        text,
        bytes: Buffer.byteLength(text, "utf8"),
        hasImage: false,
        firstText: toolResult.content as string,
      };
    }

    const parts: string[] = [];
    let hasImage = false;
    let firstText: string | undefined;

    if (!Array.isArray(toolResult.content)) {
      return { text: "", bytes: 0, hasImage, firstText };
    }

    for (const block of toolResult.content) {
      if (typeof block === "string") {
        if (firstText === undefined) {
          firstText = block;
        }
        parts.push(block);
        continue;
      }

      if (block.type === "text") {
        const text = block.text ?? "";
        if (firstText === undefined) {
          firstText = text;
        }
        parts.push(text);
        continue;
      }

      if (block.type === "image") {
        hasImage = true;
      }
    }

    const text = parts.join("\n").trimEnd();
    return {
      text,
      bytes: Buffer.byteLength(text, "utf8"),
      hasImage,
      firstText,
    };
  }

  private buildSmartPrunePrompt(args: {
    history: readonly Message[];
    targetTokens: number;
    guidance?: string;
  }): string {
    const lines: string[] = [];
    lines.push(`Target pruning token budget: ${args.targetTokens}`);
    lines.push(
      [
        "The budget is the total tokens to prune.",
        "It is better to slightly exceed it than to be significantly below it.",
      ].join(" "),
    );
    lines.push(
      'Return only JSON: {"prune":[...]} with tool_call_id values from the conversation history.',
    );
    lines.push("Only include tool_call_id values for bash tool results.");
    if (args.guidance?.trim()) {
      lines.push(`Guidance (prioritize this): ${args.guidance.trim()}`);
    } else {
      lines.push("Guidance: (none provided, use your best judgment)");
    }
    lines.push("");
    lines.push("Conversation history:");
    lines.push("<conversation>");
    lines.push(...this.formatPruneConversationHistory(args.history));
    lines.push("</conversation>");
    return lines.join("\n");
  }

  private formatPruneConversationHistory(history: readonly Message[]): string[] {
    const lines: string[] = [];

    for (const message of history) {
      if (message.role === "user") {
        lines.push("<user>");
        this.appendPruneContentLines(lines, message.content);
        lines.push("</user>");
        lines.push("");
        continue;
      }

      if (message.role === "assistant") {
        lines.push("<assistant>");
        const assistant = message as AssistantMessage;
        for (const block of assistant.content) {
          if (typeof block === "string") {
            this.appendPruneText(lines, block);
            continue;
          }

          if (block.type === "text") {
            this.appendPruneText(lines, block.text ?? "");
            continue;
          }

          if (block.type === "toolCall") {
            const toolCall = block as ToolCall;
            lines.push(this.buildPruneToolCallTag(toolCall));
          }
        }
        lines.push("</assistant>");
        lines.push("");
        continue;
      }

      if (message.role === "toolResult") {
        const toolResult = message as ToolResultMessage;
        lines.push(...this.buildPruneToolResultLines(toolResult));
        lines.push("");
      }
    }

    if (lines[lines.length - 1] === "") {
      lines.pop();
    }

    return lines;
  }

  private appendPruneContentLines(lines: string[], content: Message["content"]): void {
    if (typeof content === "string") {
      this.appendPruneText(lines, content);
      return;
    }

    if (!Array.isArray(content)) {
      return;
    }

    for (const block of content) {
      if (typeof block === "string") {
        this.appendPruneText(lines, block);
      } else if (block.type === "text") {
        this.appendPruneText(lines, block.text ?? "");
      }
    }
  }

  private appendPruneText(lines: string[], text: string): void {
    const escaped = this.escapeXml(text);
    const parts = escaped.split(/\r?\n/);
    for (const part of parts) {
      lines.push(part);
    }
  }

  private buildPruneToolCallTag(toolCall: ToolCall): string {
    const name = this.escapeXmlAttribute(toolCall.name);
    const id = this.escapeXmlAttribute(toolCall.id);
    const argsValue =
      typeof toolCall.arguments === "string"
        ? toolCall.arguments
        : JSON.stringify(toolCall.arguments ?? {});
    const args = this.escapeXmlAttribute(argsValue);
    return `<tool-call name="${name}" id="${id}" args="${args}" />`;
  }

  private buildPruneToolResultLines(toolResult: ToolResultMessage): string[] {
    const lines: string[] = [];
    const name = this.escapeXmlAttribute(toolResult.toolName);
    const toolCallId = this.escapeXmlAttribute(toolResult.toolCallId);
    const details = this.getToolResultContentDetails(toolResult);

    if (details.hasImage) {
      lines.push(`<tool-result name="${name}" tool_call_id="${toolCallId}">`);
      lines.push("<preview>[image omitted]</preview>");
      lines.push("</tool-result>");
      return lines;
    }

    const preview = this.buildPruneToolResultPreview(details.text);
    lines.push(
      `<tool-result name="${name}" tool_call_id="${toolCallId}" total_tokens="${preview.totalTokens}">`,
    );
    lines.push(`<preview max_tokens="${PRUNE_PREVIEW_MAX_TOKENS}">`);
    lines.push(...preview.lines);
    lines.push("</preview>");
    lines.push("</tool-result>");
    return lines;
  }

  private buildPruneToolResultPreview(text: string): {
    lines: string[];
    totalTokens: number;
  } {
    const normalized = text.trimEnd();
    const totalBytes = Buffer.byteLength(normalized, "utf8");
    const totalTokens = bytesToTokens(totalBytes);

    if (totalTokens <= PRUNE_PREVIEW_MAX_TOKENS) {
      const escaped = this.escapeXml(normalized);
      const lines = escaped ? escaped.split(/\r?\n/) : [""];
      return { lines, totalTokens };
    }

    const head = truncateToBytesFromStart(normalized, tokensToBytes(PRUNE_PREVIEW_MAX_TOKENS));
    const remainingTokens = Math.max(0, totalTokens - PRUNE_PREVIEW_MAX_TOKENS);
    const suffix = `…${remainingTokens} more tokens…`;
    const previewText =
      head.endsWith("\n") || head === "" ? `${head}${suffix}` : `${head}\n${suffix}`;
    const escaped = this.escapeXml(previewText);
    const lines = escaped ? escaped.split(/\r?\n/) : [""];
    return { lines, totalTokens };
  }

  private selectSmartPruneCandidates(
    ids: string[],
    candidates: ToolResultPruneCandidate[],
    targetTokens: number,
  ): ToolResultPruneCandidate[] {
    const candidatesById = new Map<string, ToolResultPruneCandidate>();
    for (const candidate of candidates) {
      candidatesById.set(candidate.toolResult.toolCallId, candidate);
    }

    const selected: ToolResultPruneCandidate[] = [];
    const seen = new Set<string>();
    let tokens = 0;

    const maxTokens = Math.ceil(targetTokens * (1 + PRUNE_MAX_OVERAGE_RATIO));

    for (const id of ids) {
      if (seen.has(id)) continue;
      const candidate = candidatesById.get(id);
      if (!candidate) continue;
      if (tokens + candidate.tokens > maxTokens) continue;
      selected.push(candidate);
      seen.add(id);
      tokens += candidate.tokens;
      if (tokens >= targetTokens) {
        break;
      }
    }

    return selected;
  }

  private async requestSmartPruneSelection(
    prompt: string,
    signal?: AbortSignal,
  ): Promise<string[]> {
    let apiKey: string | undefined;
    try {
      apiKey = await this.credentialResolver.getApiKey(
        this.currentPersona.model.provider as KnownProvider,
        { sessionId: this.engine.sessionId },
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

    const reasoning = this.clampPruneReasoning(this.currentPersona.settings.reasoning);
    const stream = streamModel(
      this.currentPersona.model,
      {
        systemPrompt: [
          "You are a context pruning assistant.",
          "Your task is to select which bash tool outputs should be pruned from the conversation history.",
          "Analyze the conversation to understand what the user is working on and which tool outputs are most relevant.",
          "Prioritize keeping outputs that contain important information, errors, or results that may be referenced later.",
          "Prefer pruning outputs that are verbose, redundant, or contain routine information that can be regenerated if needed.",
          "Follow the user's guidance carefully when provided.",
        ].join(" "),
        messages: [
          {
            role: "user",
            content: [{ type: "text", text: prompt }],
            timestamp: Date.now(),
          },
        ],
      },
      {
        ...(reasoning ? { reasoning } : {}),
        sessionId: `tau-prune-${randomUUID()}`,
        ...(signal ? { signal } : {}),
        ...(apiKey && { apiKey }),
      },
    );

    const final = await stream.result();
    const raw = extractAssistantText(final).trim();
    const parsed = this.parseSmartPruneResponse(raw);
    if (!parsed) {
      throw new Error("model returned an invalid prune selection.");
    }

    return parsed;
  }

  private clampPruneReasoning(
    reasoning?: ReasoningEffort,
  ): Exclude<ReasoningEffort, "none"> | undefined {
    switch (reasoning) {
      case undefined:
      case "none":
        return undefined;
      case "minimal":
        return "low";
      case "low":
      case "medium":
        return reasoning;
      default:
        return "medium";
    }
  }

  private parseSmartPruneResponse(raw: string): string[] | null {
    const trimmed = raw.trim();
    if (!trimmed) {
      return [];
    }

    const fenced = extractAllFencedCodeBlocks(trimmed);
    const source = (fenced ?? trimmed).trim();
    const start = source.indexOf("{");
    const end = source.lastIndexOf("}");
    if (start === -1 || end === -1 || end < start) {
      return null;
    }

    const jsonText = source.slice(start, end + 1);
    let parsed: unknown;
    try {
      parsed = JSON.parse(jsonText);
    } catch {
      return null;
    }

    if (!parsed || typeof parsed !== "object") {
      return null;
    }

    const prune = (parsed as { prune?: unknown }).prune;
    if (!Array.isArray(prune)) {
      return null;
    }

    return prune
      .filter((value): value is string => typeof value === "string")
      .map((value) => value.trim())
      .filter((value) => value.length > 0);
  }

  private formatRiskLevelNotice(level: RiskLevel): string {
    const details = getRiskLevelDescription(level);
    return details ? `risk level set to ${level} (${details})` : `risk level set to ${level}`;
  }

  private setRiskLevel(level: RiskLevel, options?: { silent?: boolean }): void {
    const previous = this.riskLevel;
    this.riskLevel = level;
    this.syncRuntimePromptContext();
    this.runtime.setRiskLevel(level);
    this.refreshStatus();

    if (previous !== level) {
      const from = this.pendingRiskLevelChange?.from ?? previous;
      if (from === level) {
        this.pendingRiskLevelChange = undefined;
      } else {
        this.pendingRiskLevelChange = { from, to: level };
      }
    }

    if (options?.silent) {
      return;
    }

    this.view.addSystemMessage(this.formatRiskLevelNotice(level), "success");
  }

  private switchPersona(id: string): void {
    const persona = this.personas.find((p) => p.id.toLowerCase() === id.toLowerCase());

    if (!persona) {
      this.view.addSystemMessage(`unknown persona '${id}'.`, "error");
      return;
    }

    this.currentPersona = persona;
    this.clampPersonaReasoning(this.currentPersona);
    const skillsContext = this.getSkillsIndexBlockForPersona(this.currentPersona);
    this.rebuildSystemPrompt(skillsContext.skillsBlock);
    this.refreshStatus();

    if (skillsContext.unknown.length > 0) {
      this.view.addSystemMessage(
        `unknown skills enabled: ${skillsContext.unknown.join(", ")}`,
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

    const baseCwd = saved.cwd ?? this.deps.env.cwd();
    const cwd = resolveAgentCwd({
      cwd: baseCwd,
      sandboxEnabled: this.sandboxEnabled,
      sandboxConfig: this.config.sandbox,
    });
    await this.runBashCommand(saved.cmd, { cwd });
  }

  private async refreshReloadableContent(scope: ReloadScope): Promise<ReloadReport> {
    const plan = RELOAD_PLANS[scope];
    const configDeps = createDefaultConfigDeps();
    const runtime = await loadRuntimeConfig(this.deps.env.cwd(), configDeps);
    const report = this.applyReloadPlan(plan, runtime);

    if (plan.projectContext) {
      this.refreshProjectContext(this.deps.env.cwd());
    }

    return report;
  }

  private applyReloadPlan(plan: ReloadPlan, runtime: RuntimeConfigResult): ReloadReport {
    const previousThemeId = this.activeThemeId ?? this.config.defaultTheme;
    const messages: ReloadMessage[] = [];

    this.config = runtime.config;
    this.runtime.setConfig(this.config);

    if (plan.bashCommands) {
      this.bashCommands = runtime.bashCommands;
    }

    if (plan.personas) {
      const personaMessage = this.applyReloadedPersonas(runtime.personas);
      if (personaMessage) {
        messages.push(personaMessage);
      }
    }

    if (plan.prompts) {
      this.prompts = runtime.prompts;
    }

    if (plan.skills) {
      this.skills = runtime.skills;
    }

    if (plan.themes) {
      const resolvedThemeId =
        this.resolveThemeId(previousThemeId, runtime.themes) ??
        this.resolveThemeId(this.config.defaultTheme, runtime.themes);

      if (resolvedThemeId) {
        this.config.defaultTheme = resolvedThemeId;
      }

      this.themes = runtime.themes;
      this.activeThemeId = resolvedThemeId ?? previousThemeId;
      this.view.updateTheme({ themeId: resolvedThemeId, themes: runtime.themes });
    }

    return {
      plan,
      warnings: runtime.warnings,
      counts: {
        personas: runtime.personas.length,
        prompts: runtime.prompts.length,
        skills: runtime.skills.length,
        themes: runtime.themes.length,
        bashCommands: runtime.bashCommands.length,
      },
      messages,
    };
  }

  private applyReloadedPersonas(personas: Persona[]): ReloadMessage | null {
    if (personas.length === 0) {
      return {
        text: "reload failed: no personas available. keeping existing personas.",
        kind: "error",
      };
    }

    this.personas = personas;
    const currentPersonaId = this.currentPersona.id.toLowerCase();
    const updatedPersona = personas.find(
      (persona) => persona.id.toLowerCase() === currentPersonaId,
    );

    if (updatedPersona) {
      this.currentPersona = updatedPersona;
      this.clampPersonaReasoning(this.currentPersona);
      return null;
    }

    this.currentPersona = personas[0]!;
    this.clampPersonaReasoning(this.currentPersona);
    const personaLabel = this.currentPersona.label || this.currentPersona.id;
    return {
      text: `previous persona no longer available; switched to ${personaLabel}.`,
      kind: "warn",
    };
  }

  private applyReloadMessages(messages: ReloadMessage[]): void {
    for (const message of messages) {
      this.view.addSystemMessage(message.text, message.kind);
    }
  }

  private rebuildSystemPromptForCurrentPersona(options?: { showUnknownSkills?: boolean }): void {
    const skillsContext = this.getSkillsIndexBlockForPersona(this.currentPersona);
    this.rebuildSystemPrompt(skillsContext.skillsBlock);

    if (options?.showUnknownSkills && skillsContext.unknown.length > 0) {
      this.view.addSystemMessage(
        `unknown skills enabled: ${skillsContext.unknown.join(", ")}`,
        "warn",
      );
    }
  }

  private buildReloadSummary(report: ReloadReport): string {
    const parts: string[] = [];

    if (report.plan.personas) {
      parts.push(`${report.counts.personas} personas`);
    }
    if (report.plan.prompts) {
      parts.push(`${report.counts.prompts} prompts`);
    }
    if (report.plan.skills) {
      parts.push(`${report.counts.skills} skills`);
    }
    if (report.plan.themes) {
      parts.push(`${report.counts.themes} themes`);
    }
    if (report.plan.bashCommands) {
      parts.push(`${report.counts.bashCommands} bash commands`);
    }
    if (report.plan.projectContext && this.includeAgentContext) {
      parts.push(`${this.agentsFiles.length} AGENTS.md`);
    }

    const errorCount = report.warnings.length;
    return errorCount > 0
      ? `reloaded: ${parts.join(", ")} (${errorCount} errors).`
      : `reloaded: ${parts.join(", ")}.`;
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
      const report = await this.refreshReloadableContent("reload-command");
      this.applyReloadMessages(report.messages);

      this.rebuildSystemPromptForCurrentPersona({
        showUnknownSkills: true,
      });

      this.refreshStatus();

      const summary = this.buildReloadSummary(report);
      this.view.addSystemMessage(summary, "success");
      this.view.requestRender();
    } catch (err) {
      this.view.addSystemMessage(`reload failed: ${(err as Error).message}`, "error");
    }
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

    this.turnCaffeinate = {
      abortController,
      completion,
    };
  }

  private async stopTurnCaffeinate(): Promise<void> {
    const session = this.turnCaffeinate;
    if (!session) return;

    this.turnCaffeinate = undefined;
    if (!session.abortController.signal.aborted) {
      session.abortController.abort();
    }

    try {
      await session.completion;
    } catch (err) {
      if (this.disableCaffeinateForSession) {
        return;
      }
      this.disableCaffeinateForSession = true;
      const error = err as NodeJS.ErrnoException;
      const details = error.message || "unknown error";
      this.view.addSystemMessage(`failed to run caffeinate: ${details}`, "warn");
    }
  }

  // Assistant Turn --------------------------------------------------------------------------------

  private async runAssistantTurn(): Promise<void> {
    this.isStreaming = true;
    this.view.startWorkingIcon();
    this.startTurnTimer();
    this.assistantState = undefined;
    this.startTurnCaffeinate();

    let runResult: ConversationTurnResult = { aborted: false };
    let interruptRequested = false;
    const busyTask: BusyTask = {
      requestInterrupt: () => {
        if (interruptRequested) {
          return false;
        }
        const interrupted = this.runtime.interruptTurn();
        if (!interrupted) {
          return false;
        }
        interruptRequested = true;
        return true;
      },
    };
    this.beginBusyTask(busyTask);

    try {
      runResult = await this.runtime.runTurn((event) => this.onEvent(event));
    } catch (err) {
      const message = (err as Error).message || "request failed";
      this.view.addSystemMessage(message, "error");
    } finally {
      this.endBusyTask(busyTask);
      await this.stopTurnCaffeinate();
      const reason = runResult.aborted ? "aborted" : "interrupted";

      this.view.finalizeToolUiPending(reason);

      this.view.stopWorkingIcon();
      this.stopTurnTimer();
      this.isStreaming = false;
      this.view.clearToolUiTransientState();
      this.pendingIdleNotification = true;
      this.view.requestRender();
      if (runResult.aborted) {
        this.dequeueQueuedUserMessagesIntoEditor();
      } else {
        void this.drainQueuedUserMessages();
      }
    }
  }

  // Direct Bash Execution (user ! commands) -------------------------------------------------------

  private async runBashCommand(
    command: string,
    opts?: { cwd?: string; addToContext?: boolean; labelOverride?: string },
  ): Promise<boolean> {
    this.isStreaming = true;
    const { busyTask, signal } = this.createAbortBusyTask();
    this.beginBusyTask(busyTask);
    let wasAborted = false;
    this.startTurnTimer();
    const toolCallId = `bash-user-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    this.view.handleToolUiEvent({
      type: "bash_started",
      toolCallId,
      command,
    });
    this.refreshStatus();

    try {
      const effectiveWorkingDirectory = opts?.cwd
        ? resolve(this.agentCwd, opts.cwd)
        : this.agentCwd;
      const startedAt = Date.now();
      const {
        output,
        exitCode,
        truncated: captureTruncated,
      } = await this.toolBackend.runBash(command, {
        cwd: effectiveWorkingDirectory,
        signal,
      });
      const durationMs = Math.max(0, Date.now() - startedAt);
      const truncationInfo = await prepareBashOutput(
        output,
        captureTruncated,
        getBashOutputPolicy({ mode: "user" }),
        this.toolBackend,
      );

      const userMessageText = formatBashUserMessageText({ command, truncationInfo });
      const uiText = buildBashUiText({
        truncationInfo,
        exitCode,
        durationMs,
        previewLines: { head: 12, tail: 12 },
        fullText: userMessageText,
      });

      this.view.handleToolUiEvent({
        type: "bash_execution",
        toolCallId,
        command,
        exitCode,
        truncationInfo,
        uiText,
        durationMs,
        labelOverride: opts?.labelOverride ?? "you ran",
      });

      this.refreshStatus();

      if (opts?.addToContext !== false) {
        this.engine.addUserText(userMessageText, { historyEntryId: toolCallId });
      }

      this.view.requestRender();
    } catch (err) {
      const message = (err as Error).message || "bash failed";
      this.view.handleToolUiEvent({
        type: "bash_blocked",
        toolCallId,
        command,
        reason: message,
      });
      this.refreshStatus();
    } finally {
      wasAborted = signal.aborted;
      this.endBusyTask(busyTask);
      this.isStreaming = false;
      this.stopTurnTimer();
      this.view.requestRender();
      if (wasAborted) {
        this.dequeueQueuedUserMessagesIntoEditor();
      } else {
        void this.drainQueuedUserMessages();
      }
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

    // Extract @<file> and @@skill:<name> tokens
    const tokenRegex = /(?:@@skill:([^\s]+)|(?<!@)@([^@\s][^\s]*))/g;
    const tokens: Array<{ type: "file" | "skill"; value: string }> = [];
    let match: RegExpExecArray | null = null;
    // biome-ignore lint/suspicious/noAssignInExpressions: regex iteration pattern
    while ((match = tokenRegex.exec(editorText)) !== null) {
      const skillToken = match[1];
      if (skillToken) {
        tokens.push({ type: "skill", value: skillToken });
        continue;
      }

      const fileToken = match[2];
      if (fileToken) {
        tokens.push({ type: "file", value: fileToken });
      }
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
      const cleanToken = entry.value.replace(/[.,;:)}\]]+$/, "");
      if (entry.type === "file") {
        if (projectFilesSet.has(cleanToken) && !seenFiles.has(cleanToken)) {
          expansions.push({ type: "file", path: cleanToken });
          seenFiles.add(cleanToken);
        }
      } else {
        const key = cleanToken.toLowerCase();
        const skill = skillsByName.get(key);
        if (!skill) continue; // Only expand @@skill mentions that match a loaded skill.
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
