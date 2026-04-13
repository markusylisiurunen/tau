import type { DiffToolConfig } from "../../core/config/index.js";
import type {
  DiffReviewResult,
  DiffReviewSession,
  DiffReviewSessionUiState,
  StartedDiffReviewSession,
} from "../../core/diff_review/index.js";
import { formatDiffReviewScope } from "../../core/diff_review/snapshot.js";
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
    diffArgs: string[];
    diffTool: DiffToolConfig;
    signal: AbortSignal;
  }) => Promise<StartedDiffReviewSession>;
  onReviewReturned: (review: DiffReviewReturnedReview) => void;
};

type DiffReviewState = {
  phase: "preparing" | "active";
  messageId: string;
  diffCommand: string;
  reviewedFiles: string[];
  abortController: AbortController;
  session?: DiffReviewSession;
  cancelRequested: boolean;
  diffToolUiText?: string;
  reviewAgents: DiffReviewSessionUiState["reviewAgents"];
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
    diffArgs: string[];
    diffTool: DiffToolConfig;
    signal: AbortSignal;
  }) => Promise<StartedDiffReviewSession>;
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

    const state: DiffReviewState = {
      phase: "preparing",
      messageId: "",
      diffCommand: formatDiffReviewCommand(diffArgs),
      reviewedFiles: [],
      abortController: new AbortController(),
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
          if (state.abortController.signal.aborted) {
            return false;
          }
          state.abortController.abort();
          return true;
        }

        if (!state.session || state.cancelRequested) {
          return false;
        }

        state.cancelRequested = true;
        void state.session.cancel("controller_cancelled");
        return true;
      },
    };
    this.interruptLifecycle.beginBusyTask(busyTask);

    try {
      const started = await this.startSession({
        diffArgs,
        diffTool,
        signal: state.abortController.signal,
      });
      if (state.abortController.signal.aborted) {
        await started.session.cancel("controller_cancelled");
        finalizeDiffReviewMessage(state, this.view, "cancelled");
        return;
      }

      state.phase = "active";
      state.session = started.session;
      state.reviewedFiles = started.session.snapshot?.files.map((file) => file.path) ?? [];
      updateDiffReviewUiState(state, started.session.getUiState(), this.view);
      state.removeUiStateListener = started.session.onUiStateChange((uiState) => {
        if (this.state !== state) {
          return;
        }
        updateDiffReviewUiState(state, uiState, this.view);
      });
      this.refreshStatus();

      const result = await started.result;
      this.handleResult(state, result);
    } catch (error) {
      if (state.abortController.signal.aborted) {
        finalizeDiffReviewMessage(state, this.view, "cancelled");
      } else {
        const message = (error as Error).message;
        finalizeDiffReviewMessage(state, this.view, "failed", message);
        this.view.addSystemMessage(`diff review failed: ${message}`, "error");
      }
    } finally {
      if (!state.messageFinalized && state.abortController.signal.aborted) {
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

  async cancel(): Promise<void> {
    const state = this.state;
    if (!state) {
      return;
    }

    if (!state.abortController.signal.aborted) {
      state.abortController.abort();
    }

    if (state.session) {
      await state.session.cancel("controller_cancelled");
    }
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
  uiState: DiffReviewSessionUiState,
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
