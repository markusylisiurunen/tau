import type { DiffToolConfig } from "../../core/config/index.js";
import type {
  DiffReviewBridge,
  DiffReviewBridgeUiState,
  DiffReviewResult,
  StartedDiffReviewBridge,
} from "../../core/diff_review/index.js";
import {
  formatDiffReviewReturnedReviewToolResult,
  parseDiffReviewToolArgs,
} from "../../core/diff_review/index.js";
import {
  type DiffReviewSnapshotSource,
  formatDiffReviewScope,
} from "../../core/diff_review/snapshot.js";
import type { ChatView } from "../chat_view.js";
import type { DiffReviewMessageModel } from "../ui/diff_review_message.js";
import type { BusyTask, InterruptLifecycle } from "./interrupt_lifecycle.js";

export type DiffReviewReturnedReview = {
  diffCommand: string;
  reviewedFiles: string[];
  review: string;
  historyEntryId: string;
};

export type DiffReviewServiceOptions = {
  view: ChatView;
  interruptLifecycle: InterruptLifecycle;
  refreshStatus: () => void;
  startTurnTimer: () => void;
  stopTurnTimer: () => void;
  getDiffToolConfig: () => DiffToolConfig | undefined;
  startSession: (args: {
    source: DiffReviewSnapshotSource;
    diffTool: DiffToolConfig;
    signal: AbortSignal;
  }) => Promise<StartedDiffReviewBridge>;
  onReviewReturned: (review: DiffReviewReturnedReview) => void;
};

type DiffReviewState = {
  phase: "preparing" | "active";
  messageId: string;
  diffCommand: string;
  reviewedFiles: string[];
  abortController?: AbortController;
  bridge?: DiffReviewBridge;
  cancelRequested: boolean;
  diffToolUiText?: string;
  reviewAgents: DiffReviewBridgeUiState["reviewAgents"];
  removeUiStateListener?: () => void;
  messageFinalized: boolean;
};

export class DiffReviewService {
  private readonly view: ChatView;
  private readonly interruptLifecycle: InterruptLifecycle;
  private readonly refreshStatus: () => void;
  private readonly startTurnTimer: () => void;
  private readonly stopTurnTimer: () => void;
  private readonly getDiffToolConfig: () => DiffToolConfig | undefined;
  private readonly startSession: (args: {
    source: DiffReviewSnapshotSource;
    diffTool: DiffToolConfig;
    signal: AbortSignal;
  }) => Promise<StartedDiffReviewBridge>;
  private readonly onReviewReturned: (review: DiffReviewReturnedReview) => void;
  private state?: DiffReviewState;

  constructor(options: DiffReviewServiceOptions) {
    this.view = options.view;
    this.interruptLifecycle = options.interruptLifecycle;
    this.refreshStatus = options.refreshStatus;
    this.startTurnTimer = options.startTurnTimer;
    this.stopTurnTimer = options.stopTurnTimer;
    this.getDiffToolConfig = options.getDiffToolConfig;
    this.startSession = options.startSession;
    this.onReviewReturned = options.onReviewReturned;
  }

  isActive(): boolean {
    return this.state !== undefined;
  }

  getCommandHint(defaultHint?: string): string | undefined {
    if (!this.state) {
      return defaultHint;
    }

    return this.state.phase === "preparing"
      ? "starting diff review, esc to cancel"
      : "diff review active, finish in the tool or press esc to cancel";
  }

  async start(argsText: string): Promise<void> {
    if (this.state) {
      this.view.addSystemMessage("diff review is already active.", "warn");
      return;
    }

    const diffTool = this.getDiffToolConfig();
    if (!diffTool) {
      this.view.addSystemMessage("configure diffTool in config.json before using /diff.", "error");
      return;
    }

    let diffArgs: string[];
    try {
      diffArgs = parseDiffArgsText(argsText);
    } catch (error) {
      this.view.addSystemMessage(`invalid /diff arguments: ${(error as Error).message}`, "error");
      return;
    }

    const abortController = new AbortController();
    const state: DiffReviewState = {
      phase: "preparing",
      messageId: "",
      diffCommand: formatDiffReviewCommand(diffArgs),
      reviewedFiles: [],
      abortController,
      cancelRequested: false,
      reviewAgents: [],
      messageFinalized: false,
    };
    state.messageId = this.view.addMessage(buildDiffReviewMessage(state));
    this.state = state;
    this.view.startWorkingIcon();
    this.startTurnTimer();
    this.refreshStatus();

    const busyTask: BusyTask = {
      requestInterrupt: () => {
        if (this.state !== state) {
          return false;
        }

        if (state.phase === "preparing") {
          if (abortController.signal.aborted) {
            return false;
          }
          abortController.abort();
          return true;
        }

        if (!state.bridge || state.cancelRequested) {
          return false;
        }

        state.cancelRequested = true;
        void state.bridge.cancel("controller_cancelled");
        return true;
      },
    };
    this.interruptLifecycle.beginBusyTask(busyTask);

    try {
      const started = await this.startSession({
        source: { kind: "git_diff", diffArgs },
        diffTool,
        signal: abortController.signal,
      });
      if (abortController.signal.aborted) {
        await started.bridge.cancel("controller_cancelled");
        finalizeDiffReviewMessage(state, this.view, "cancelled");
        return;
      }

      this.attachStartedSession(state, started);

      const result = await started.result;
      this.handleResult(state, result);
    } catch (error) {
      if (abortController.signal.aborted) {
        finalizeDiffReviewMessage(state, this.view, "cancelled");
      } else {
        const message = (error as Error).message;
        finalizeDiffReviewMessage(state, this.view, "failed", message);
        this.view.addSystemMessage(`diff review failed: ${message}`, "error");
      }
    } finally {
      if (!state.messageFinalized && abortController.signal.aborted) {
        finalizeDiffReviewMessage(state, this.view, "cancelled");
      }
      state.removeUiStateListener?.();
      state.removeUiStateListener = undefined;
      if (this.state === state) {
        this.state = undefined;
      }
      this.interruptLifecycle.endBusyTask(busyTask);
      this.view.stopWorkingIcon();
      this.stopTurnTimer();
      this.refreshStatus();
    }
  }

  async runModelTool(rawArgs: unknown, signal: AbortSignal): Promise<string> {
    if (this.state) {
      throw new Error("diff review is already active");
    }

    const diffTool = this.getDiffToolConfig();
    if (!diffTool) {
      throw new Error("configure diffTool in config.json before using diff_review");
    }

    const parsedArgs = parseDiffReviewToolArgs(rawArgs);
    if (!parsedArgs.ok) {
      throw new Error(`Invalid arguments: ${parsedArgs.error}`);
    }

    const state: DiffReviewState = {
      phase: "preparing",
      messageId: "",
      diffCommand: parsedArgs.data.command,
      reviewedFiles: [],
      cancelRequested: false,
      reviewAgents: [],
      messageFinalized: false,
    };
    state.messageId = this.view.addMessage(buildDiffReviewMessage(state));
    this.state = state;
    this.refreshStatus();

    const cancelOnAbort = () => {
      if (!state.bridge || state.cancelRequested) {
        return;
      }
      state.cancelRequested = true;
      void state.bridge.cancel("controller_cancelled");
    };
    signal.addEventListener("abort", cancelOnAbort, { once: true });

    try {
      const started = await this.startSession({
        source: parsedArgs.data.source,
        diffTool,
        signal,
      });
      if (signal.aborted) {
        await started.bridge.cancel("controller_cancelled").catch(() => undefined);
        finalizeDiffReviewMessage(state, this.view, "cancelled");
        throw new Error("diff review aborted");
      }

      this.attachStartedSession(state, started);

      const result = await started.result;
      if (result.status === "returned") {
        finalizeDiffReviewMessage(state, this.view, "returned");
        return formatDiffReviewReturnedReviewToolResult({
          command: state.diffCommand,
          reviewedFiles: state.reviewedFiles,
          review: result.review,
        });
      }

      finalizeDiffReviewMessage(state, this.view, "cancelled");
      throw new Error(formatCancelledDiffReviewResult(result));
    } catch (error) {
      if (!state.messageFinalized) {
        if (signal.aborted) {
          finalizeDiffReviewMessage(state, this.view, "cancelled");
        } else {
          finalizeDiffReviewMessage(state, this.view, "failed", (error as Error).message);
        }
      }
      if (signal.aborted) {
        throw new Error("diff review aborted");
      }
      throw error;
    } finally {
      signal.removeEventListener("abort", cancelOnAbort);
      state.removeUiStateListener?.();
      state.removeUiStateListener = undefined;
      if (this.state === state) {
        this.state = undefined;
      }
      this.refreshStatus();
    }
  }

  async cancel(): Promise<void> {
    const state = this.state;
    if (!state) {
      return;
    }

    if (state.abortController && !state.abortController.signal.aborted) {
      state.abortController.abort();
    }

    if (state.bridge) {
      await state.bridge.cancel("controller_cancelled");
    }
  }

  private attachStartedSession(state: DiffReviewState, started: StartedDiffReviewBridge): void {
    state.phase = "active";
    state.bridge = started.bridge;
    state.reviewedFiles = started.bridge.snapshot?.files.map((file) => file.path) ?? [];
    updateDiffReviewUiState(state, started.bridge.getUiState(), this.view);
    state.removeUiStateListener = started.bridge.onUiStateChange((uiState) => {
      if (this.state !== state) {
        return;
      }
      updateDiffReviewUiState(state, uiState, this.view);
    });
    this.refreshStatus();
  }

  private handleResult(state: DiffReviewState, result: DiffReviewResult): void {
    if (result.status === "returned") {
      state.messageFinalized = true;
      this.view.replaceMessage(state.messageId, {
        type: "user",
        text: result.review,
        kind: "review",
      });
      this.onReviewReturned({
        diffCommand: state.diffCommand,
        reviewedFiles: state.reviewedFiles,
        review: result.review,
        historyEntryId: state.messageId,
      });
      this.view.addSystemMessage(
        "diff review added to the conversation. tau did not run yet.",
        "success",
      );
      return;
    }

    if (result.reason === "tool_disconnected") {
      finalizeDiffReviewMessage(state, this.view, "cancelled");
      this.view.addSystemMessage(
        "diff review tool disconnected or never connected before returning a review.",
        "warn",
      );
      return;
    }

    if (result.reason === "tool_cancelled") {
      finalizeDiffReviewMessage(state, this.view, "cancelled");
      this.view.addSystemMessage("diff review cancelled.", "warn");
      return;
    }

    finalizeDiffReviewMessage(state, this.view, "cancelled");
  }
}

function formatDiffReviewCommand(diffArgs: string[]): string {
  return formatDiffReviewScope(diffArgs);
}

function formatCancelledDiffReviewResult(
  result: Extract<DiffReviewResult, { status: "cancelled" }>,
): string {
  switch (result.reason) {
    case "tool_cancelled":
      return "diff review cancelled by the diff review tool";
    case "tool_disconnected":
      return "diff review tool disconnected before returning a review";
    case "controller_cancelled":
      return "diff review cancelled";
    case "launch_failed":
      return "diff review failed to launch";
  }
}

function buildDiffReviewMessage(
  state: DiffReviewState,
  args?: {
    status?: DiffReviewMessageModel["status"];
    detail?: string;
  },
): DiffReviewMessageModel & { type: "diff_review" } {
  const status = args?.status ?? state.phase;
  return {
    type: "diff_review",
    status,
    command: state.diffCommand,
    ...(status === "active" && state.diffToolUiText ? { uiText: state.diffToolUiText } : {}),
    ...(status === "active" ? { reviewAgents: state.reviewAgents } : {}),
    ...(args?.detail ? { detail: args.detail } : {}),
  };
}

function updateDiffReviewMessage(
  state: DiffReviewState,
  view: ChatView,
  args?: {
    status?: DiffReviewMessageModel["status"];
    detail?: string;
  },
): void {
  view.updateMessage(state.messageId, buildDiffReviewMessage(state, args));
}

function finalizeDiffReviewMessage(
  state: DiffReviewState,
  view: ChatView,
  status: Exclude<DiffReviewMessageModel["status"], "preparing" | "active">,
  detail?: string,
): void {
  if (state.messageFinalized) {
    return;
  }

  state.messageFinalized = true;
  updateDiffReviewMessage(state, view, { status, ...(detail ? { detail } : {}) });
}

function updateDiffReviewUiState(
  state: DiffReviewState,
  uiState: DiffReviewBridgeUiState,
  view: ChatView,
): void {
  state.diffToolUiText = uiState.diffToolUiText;
  state.reviewAgents = uiState.reviewAgents;
  if (!state.messageFinalized) {
    updateDiffReviewMessage(state, view);
  }
}

function parseDiffArgsText(argsText: string): string[] {
  const input = argsText.trim();
  if (!input) {
    return [];
  }

  const args: string[] = [];
  let current = "";
  let quote: '"' | "'" | undefined;
  let escaping = false;

  for (let index = 0; index < input.length; index += 1) {
    const char = input[index]!;

    if (escaping) {
      current += char;
      escaping = false;
      continue;
    }

    if (char === "\\") {
      if (quote === "'") {
        current += char;
      } else {
        escaping = true;
      }
      continue;
    }

    if (quote) {
      if (char === quote) {
        quote = undefined;
      } else {
        current += char;
      }
      continue;
    }

    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      if (current.length > 0) {
        args.push(current);
        current = "";
      }
      continue;
    }

    current += char;
  }

  if (escaping) {
    throw new Error("unterminated escape sequence");
  }

  if (quote) {
    throw new Error("unterminated quoted string");
  }

  if (current.length > 0) {
    args.push(current);
  }

  return args;
}
