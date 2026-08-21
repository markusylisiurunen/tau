import { randomUUID } from "node:crypto";
import type {
  DiffToolBrief,
  DiffToolCommentThread,
  DiffToolCreateThreadPayload,
  DiffToolReviewState,
  DiffToolStatePatch,
  DiffToolThreadAnchor,
} from "./shared_types.js";
import { DEFAULT_DIFF_TOOL_CODE_THEME, DIFF_TOOL_CODE_THEMES } from "./shared_types.js";

const emptyBrief: DiffToolBrief = {
  content: "",
  loading: false,
};

const codeThemes = new Set<DiffToolReviewState["codeTheme"]>(DIFF_TOOL_CODE_THEMES);

function createInitialState(options: {
  codeTheme?: DiffToolReviewState["codeTheme"];
}): DiffToolReviewState {
  return {
    diffStyle: "split",
    overflowMode: "wrap",
    codeTheme: options.codeTheme ?? DEFAULT_DIFF_TOOL_CODE_THEME,
    sidebarOpen: false,
    collapsedFileIds: [],
    viewedFileIds: [],
    threads: [],
    brief: { ...emptyBrief },
  };
}

export class DiffToolReviewStateStore {
  private readonly state: DiffToolReviewState;

  constructor(options: { codeTheme?: DiffToolReviewState["codeTheme"] } = {}) {
    this.state = createInitialState(options);
  }

  getState(): DiffToolReviewState {
    return {
      diffStyle: this.state.diffStyle,
      overflowMode: this.state.overflowMode,
      codeTheme: this.state.codeTheme,
      sidebarOpen: this.state.sidebarOpen,
      collapsedFileIds: [...this.state.collapsedFileIds],
      viewedFileIds: [...this.state.viewedFileIds],
      threads: this.state.threads.map(cloneThread),
      brief: cloneBrief(this.state.brief),
    };
  }

  replaceState(state: DiffToolReviewState): void {
    this.state.diffStyle = state.diffStyle;
    this.state.overflowMode = state.overflowMode;
    this.state.codeTheme = state.codeTheme;
    this.state.sidebarOpen = state.sidebarOpen;
    this.state.collapsedFileIds = [...state.collapsedFileIds];
    this.state.viewedFileIds = [...state.viewedFileIds];
    this.state.threads = state.threads.map(cloneThread);
    this.state.brief = cloneBrief(state.brief);
  }

  updateState(patch: DiffToolStatePatch): void {
    if (patch.diffStyle === "split" || patch.diffStyle === "stacked") {
      this.state.diffStyle = patch.diffStyle;
    }

    if (patch.overflowMode === "wrap" || patch.overflowMode === "scroll") {
      this.state.overflowMode = patch.overflowMode;
    }

    if (patch.codeTheme && codeThemes.has(patch.codeTheme)) {
      this.state.codeTheme = patch.codeTheme;
    }

    if (typeof patch.sidebarOpen === "boolean") {
      this.state.sidebarOpen = patch.sidebarOpen;
    }

    if (Array.isArray(patch.collapsedFileIds)) {
      this.state.collapsedFileIds = patch.collapsedFileIds.filter(
        (value): value is string => typeof value === "string" && value.trim().length > 0,
      );
    }

    if (Array.isArray(patch.viewedFileIds)) {
      this.state.viewedFileIds = patch.viewedFileIds.filter(
        (value): value is string => typeof value === "string" && value.trim().length > 0,
      );
    }
  }

  findThread(id: string): DiffToolCommentThread | undefined {
    const thread = this.findThreadInternal(id);
    return thread ? cloneThread(thread) : undefined;
  }

  createThread(payload: DiffToolCreateThreadPayload): string {
    const id = randomUUID();
    this.state.threads.push({
      id,
      anchor: cloneAnchor(payload.anchor),
      messages: [{ role: "user", text: payload.body }],
      loading: false,
      resolved: false,
      collapsed: false,
    });
    return id;
  }

  addReply(id: string, text: string): boolean {
    const thread = this.findThreadInternal(id);
    if (!thread) {
      return false;
    }

    thread.messages.push({ role: "user", text });
    thread.resolved = false;
    thread.collapsed = false;
    return true;
  }

  deleteThread(id: string): boolean {
    const index = this.state.threads.findIndex((thread) => thread.id === id);
    if (index < 0) {
      return false;
    }

    this.state.threads.splice(index, 1);
    return true;
  }

  deleteThreadMessage(id: string, messageIndex: number): boolean {
    const threadIndex = this.state.threads.findIndex((thread) => thread.id === id);
    if (threadIndex < 0) {
      return false;
    }

    const thread = this.state.threads[threadIndex];
    if (!thread || messageIndex < 0 || messageIndex >= thread.messages.length) {
      return false;
    }

    if (messageIndex === 0) {
      this.state.threads.splice(threadIndex, 1);
      return true;
    }

    thread.messages.splice(messageIndex, 1);
    return true;
  }

  setThreadLoading(id: string, loading: boolean): boolean {
    const thread = this.findThreadInternal(id);
    if (!thread) {
      return false;
    }

    thread.loading = loading;
    return true;
  }

  setThreadResolved(id: string, resolved: boolean): boolean {
    const thread = this.findThreadInternal(id);
    if (!thread) {
      return false;
    }

    thread.resolved = resolved;
    thread.collapsed = resolved;
    return true;
  }

  setThreadCollapsed(id: string, collapsed: boolean): boolean {
    const thread = this.findThreadInternal(id);
    if (!thread) {
      return false;
    }

    thread.collapsed = collapsed;
    return true;
  }

  startBriefGeneration(): void {
    this.state.brief = {
      content: this.state.brief.content,
      loading: true,
    };
  }

  applyBriefResult(result: { threadId: string; response: string }): void {
    this.state.brief = {
      threadId: result.threadId,
      content: result.response,
      loading: false,
    };
  }

  setBriefLoading(loading: boolean): void {
    this.state.brief = {
      ...(this.state.brief.threadId ? { threadId: this.state.brief.threadId } : {}),
      content: this.state.brief.content,
      loading,
    };
  }

  applyThreadResponse(id: string, result: { threadId: string; response: string }): boolean {
    const thread = this.findThreadInternal(id);
    if (!thread) {
      return false;
    }

    thread.threadId = result.threadId;
    thread.messages.push({ role: "assistant", text: result.response });
    thread.loading = false;
    return true;
  }

  buildThreadAgentMessage(id: string): string | undefined {
    const thread = this.findThreadInternal(id);
    if (!thread) {
      return undefined;
    }

    const userText = pendingUserText(thread);
    if (!userText) {
      return "";
    }

    if (thread.threadId) {
      return userText;
    }

    const locationPrefix =
      thread.anchor.kind === "line"
        ? `[${thread.anchor.filePath}:${thread.anchor.lineNumber} (${thread.anchor.side === "additions" ? "new" : "old"})]\n\n`
        : "";
    const hasAssistantMessage = thread.messages.some((message) => message.role === "assistant");
    if (!hasAssistantMessage) {
      return `${locationPrefix}${userText}`;
    }

    const transcript = thread.messages
      .map((message) => `**${message.role === "assistant" ? "agent" : "user"}**\n\n${message.text}`)
      .join("\n\n");
    return `${locationPrefix}Continue this restored review conversation. Its previous transcript is included below.\n\n${transcript}`;
  }

  buildReviewText(submissionMessage?: string): string {
    const trimmedSubmissionMessage = submissionMessage?.trim();
    const unresolvedThreads = this.state.threads.filter((thread) => !thread.resolved);
    if (unresolvedThreads.length === 0) {
      return trimmedSubmissionMessage || "(no comments)";
    }

    const guidance = [
      "The notes below include thread transcripts from the review. In those transcripts:",
      "",
      "- **user** is a comment written by the reviewer",
      "- **agent** is a generated reply within that review thread",
      "",
      "Treat thread dialogue as supporting review context, not automatically as a final conclusion.",
    ].join("\n");

    const threads = unresolvedThreads
      .map((thread, index) => {
        const location =
          thread.anchor.kind === "line"
            ? `${thread.anchor.filePath}:${thread.anchor.lineNumber} (${thread.anchor.side === "additions" ? "new" : "old"})`
            : "general discussion";
        const body = thread.messages
          .map(
            (message) =>
              `**${message.role === "assistant" ? "agent" : "user"}**\n\n${message.text}`,
          )
          .join("\n\n");
        return `## thread ${index + 1}\n\n\`${location}\`\n\n${body}`;
      })
      .join("\n\n---\n\n");

    const message = trimmedSubmissionMessage
      ? `## submission message\n\n${trimmedSubmissionMessage}\n\n---\n\n`
      : "";

    return `${guidance}\n\n---\n\n${message}${threads}`;
  }

  private findThreadInternal(id: string): DiffToolCommentThread | undefined {
    return this.state.threads.find((thread) => thread.id === id);
  }
}

function cloneBrief(brief: DiffToolBrief): DiffToolBrief {
  return {
    ...(brief.threadId ? { threadId: brief.threadId } : {}),
    content: brief.content,
    loading: brief.loading,
  };
}

function cloneThread(thread: DiffToolCommentThread): DiffToolCommentThread {
  return {
    id: thread.id,
    ...(thread.threadId ? { threadId: thread.threadId } : {}),
    anchor: cloneAnchor(thread.anchor),
    messages: thread.messages.map((message) => ({ ...message })),
    loading: thread.loading,
    resolved: thread.resolved,
    collapsed: thread.collapsed,
  };
}

function cloneAnchor(anchor: DiffToolThreadAnchor): DiffToolThreadAnchor {
  return anchor.kind === "line" ? { ...anchor } : { kind: "detached" };
}

function pendingUserText(thread: DiffToolCommentThread): string {
  const pending: string[] = [];
  for (let index = thread.messages.length - 1; index >= 0; index -= 1) {
    const message = thread.messages[index];
    if (!message) {
      continue;
    }
    if (message.role === "assistant") {
      break;
    }
    pending.unshift(message.text);
  }
  return pending.join("\n\n");
}
