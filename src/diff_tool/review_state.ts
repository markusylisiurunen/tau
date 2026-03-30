import { randomUUID } from "node:crypto";
import type {
  DiffToolCommentThread,
  DiffToolCreateThreadPayload,
  DiffToolReviewState,
  DiffToolStatePatch,
} from "./shared_types.js";

export class DiffToolReviewStateStore {
  private readonly state: DiffToolReviewState = {
    diffStyle: "split",
    sidebarOpen: false,
    collapsedFileIds: [],
    viewedFileIds: [],
    threads: [],
  };

  getState(): DiffToolReviewState {
    return {
      diffStyle: this.state.diffStyle,
      sidebarOpen: this.state.sidebarOpen,
      collapsedFileIds: [...this.state.collapsedFileIds],
      viewedFileIds: [...this.state.viewedFileIds],
      threads: this.state.threads.map(cloneThread),
    };
  }

  updateState(patch: DiffToolStatePatch): void {
    if (patch.diffStyle === "split" || patch.diffStyle === "unified") {
      this.state.diffStyle = patch.diffStyle;
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

  createThread(payload: DiffToolCreateThreadPayload): void {
    this.state.threads.push({
      id: randomUUID(),
      fileId: payload.fileId,
      filePath: payload.filePath,
      lineNumber: payload.lineNumber,
      side: payload.side,
      messages: [{ role: "user", text: payload.body }],
      loading: false,
    });
  }

  addReply(id: string, text: string): boolean {
    const thread = this.findThreadInternal(id);
    if (!thread) {
      return false;
    }

    thread.messages.push({ role: "user", text });
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

  setThreadLoading(id: string, loading: boolean): boolean {
    const thread = this.findThreadInternal(id);
    if (!thread) {
      return false;
    }

    thread.loading = loading;
    return true;
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

    const locationPrefix = thread.threadId
      ? ""
      : `[${thread.filePath}:${thread.lineNumber} (${thread.side === "additions" ? "new" : "old"})]\n\n`;
    return `${locationPrefix}${userText}`;
  }

  buildReviewText(): string {
    if (this.state.threads.length === 0) {
      return "(no comments)";
    }

    return this.state.threads
      .map((thread, index) => {
        const location = `${thread.filePath}:${thread.lineNumber} (${thread.side === "additions" ? "new" : "old"})`;
        const body = thread.messages
          .map(
            (message) =>
              `**${message.role === "assistant" ? "agent" : "user"}**\n\n${message.text}`,
          )
          .join("\n\n");
        return `## thread ${index + 1}\n\n\`${location}\`\n\n${body}`;
      })
      .join("\n\n---\n\n");
  }

  private findThreadInternal(id: string): DiffToolCommentThread | undefined {
    return this.state.threads.find((thread) => thread.id === id);
  }
}

function cloneThread(thread: DiffToolCommentThread): DiffToolCommentThread {
  return {
    id: thread.id,
    ...(thread.threadId ? { threadId: thread.threadId } : {}),
    fileId: thread.fileId,
    filePath: thread.filePath,
    lineNumber: thread.lineNumber,
    side: thread.side,
    messages: thread.messages.map((message) => ({ ...message })),
    loading: thread.loading,
  };
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
