import { randomUUID } from "node:crypto";
import type {
  DiffToolCommentThread,
  DiffToolCreateThreadPayload,
  DiffToolGuide,
  DiffToolGuideCommentTarget,
  DiffToolGuideOperation,
  DiffToolGuideOperationResult,
  DiffToolReviewState,
  DiffToolStatePatch,
  DiffToolThreadAnchor,
} from "./shared_types.js";
import {
  DEFAULT_DIFF_TOOL_CODE_THEME,
  DIFF_TOOL_GUIDE_QUESTION_LIMIT,
  DIFF_TOOL_GUIDE_TOPIC_LIMIT,
  guideCommentTargetKey,
} from "./shared_types.js";

const emptyGuide: DiffToolGuide = {
  orientation: "",
  topics: [],
  questions: [],
  comments: [],
  loading: false,
};

type GuideTopicInput = Omit<DiffToolGuide["topics"][number], "id">;
type GuideQuestionInput = Omit<DiffToolGuide["questions"][number], "id" | "source">;
type GuideInput = {
  orientation: string;
  topics: GuideTopicInput[];
  questions: GuideQuestionInput[];
};

function createInitialState(options: {
  codeTheme?: DiffToolReviewState["codeTheme"];
}): DiffToolReviewState {
  return {
    diffStyle: "stacked",
    overflowMode: "wrap",
    codeTheme: options.codeTheme ?? DEFAULT_DIFF_TOOL_CODE_THEME,
    collapsedFileIds: [],
    viewedFileIds: [],
    threads: [],
    guide: cloneGuide(emptyGuide),
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
      collapsedFileIds: [...this.state.collapsedFileIds],
      viewedFileIds: [...this.state.viewedFileIds],
      threads: this.state.threads.map(cloneThread),
      guide: cloneGuide(this.state.guide),
    };
  }

  clone(): DiffToolReviewStateStore {
    const clone = new DiffToolReviewStateStore();
    clone.replaceState(this.state);
    return clone;
  }

  replaceState(state: DiffToolReviewState): void {
    this.state.diffStyle = state.diffStyle;
    this.state.overflowMode = state.overflowMode;
    this.state.codeTheme = state.codeTheme;
    this.state.collapsedFileIds = [...state.collapsedFileIds];
    this.state.viewedFileIds = [...state.viewedFileIds];
    this.state.threads = state.threads.map(cloneThread);
    this.state.guide = cloneGuide(state.guide);
  }

  replaceStatePreservingConcurrentLoading(
    state: DiffToolReviewState,
    previousState: DiffToolReviewState,
  ): void {
    const currentThreadLoading = new Map(
      this.state.threads.map((thread) => [thread.id, thread.loading]),
    );
    const previousThreadLoading = new Map(
      previousState.threads.map((thread) => [thread.id, thread.loading]),
    );
    const currentGuideLoading = this.state.guide.loading;
    this.replaceState(state);
    for (const thread of this.state.threads) {
      if (thread.loading === previousThreadLoading.get(thread.id)) {
        thread.loading = currentThreadLoading.get(thread.id) ?? thread.loading;
      }
    }
    if (this.state.guide.loading === previousState.guide.loading) {
      this.state.guide.loading = currentGuideLoading;
    }
  }

  updateState(patch: DiffToolStatePatch): void {
    if (patch.diffStyle) {
      this.state.diffStyle = patch.diffStyle;
    }
    if (patch.overflowMode) {
      this.state.overflowMode = patch.overflowMode;
    }
    if (patch.codeTheme) {
      this.state.codeTheme = patch.codeTheme;
    }
    if (patch.collapsedFileIds) {
      this.state.collapsedFileIds = [...patch.collapsedFileIds];
    }
    if (patch.viewedFileIds) {
      this.state.viewedFileIds = [...patch.viewedFileIds];
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

  setGuideLoading(loading: boolean): void {
    this.state.guide.loading = loading;
  }

  applyGuideResult(result: { threadId: string }, content: GuideInput): void {
    this.state.guide = {
      threadId: result.threadId,
      orientation: content.orientation,
      topics: content.topics.map((topic) => ({ id: randomUUID(), ...topic })),
      questions: content.questions.map((question) => ({
        id: randomUUID(),
        ...question,
        source: "generated",
      })),
      comments: this.state.guide.comments,
      loading: false,
    };
  }

  applyGuideOperationResults(
    result: { threadId: string },
    operations: DiffToolGuideOperation[],
    contents: DiffToolGuideOperationResult[],
  ): boolean {
    if (operations.length !== contents.length) {
      return false;
    }

    const topicCount =
      this.state.guide.topics.length +
      operations.filter((operation) => operation.kind === "topic.add").length;
    const questionCount =
      this.state.guide.questions.length +
      operations.filter((operation) => operation.kind === "question.ask").length;
    if (
      topicCount > DIFF_TOOL_GUIDE_TOPIC_LIMIT ||
      questionCount > DIFF_TOOL_GUIDE_QUESTION_LIMIT
    ) {
      return false;
    }

    for (const [index, operation] of operations.entries()) {
      const content = contents[index];
      if (!content || operation.kind !== content.kind) {
        return false;
      }
      if (
        operation.kind === "topic.revise" &&
        !this.state.guide.topics.some((topic) => topic.id === operation.topicId)
      ) {
        return false;
      }
    }

    for (const [index, operation] of operations.entries()) {
      const content = contents[index];
      if (!content) {
        return false;
      }
      switch (content.kind) {
        case "topic.add":
          this.state.guide.topics.push({ id: randomUUID(), ...content.topic });
          break;
        case "topic.revise": {
          const topic = this.state.guide.topics.find(
            (entry) => operation.kind === "topic.revise" && entry.id === operation.topicId,
          );
          if (!topic) {
            return false;
          }
          Object.assign(topic, content.topic);
          break;
        }
        case "question.ask":
          this.state.guide.questions.push({
            id: randomUUID(),
            ...content.question,
            source: "user",
          });
          break;
      }
    }

    this.state.guide.threadId = result.threadId;
    this.state.guide.loading = false;
    return true;
  }

  saveGuideComment(target: DiffToolGuideCommentTarget, body: string): void {
    const targetKey = guideCommentTargetKey(target);
    const existing = this.state.guide.comments.find(
      (comment) => guideCommentTargetKey(comment.target) === targetKey,
    );
    if (existing) {
      existing.body = body;
      return;
    }

    this.state.guide.comments.push({
      target: { ...target },
      body,
    });
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

  buildReviewText(): string {
    const unresolvedThreads = this.state.threads.filter((thread) => !thread.resolved);
    const guideComments = this.state.guide.comments;
    if (unresolvedThreads.length === 0 && guideComments.length === 0) {
      return "(no comments)";
    }

    const sections: string[] = [];
    if (guideComments.length > 0) {
      sections.push(
        guideComments
          .map((comment, index) => {
            const context = formatGuideCommentContext(this.state.guide, comment.target);
            return [
              `## guide comment ${index + 1}`,
              `\`${context.location}\``,
              `### ${context.heading}`,
              context.content,
              "**review comment**",
              comment.body,
            ].join("\n\n");
          })
          .join("\n\n---\n\n"),
      );
    }
    if (unresolvedThreads.length > 0) {
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
      sections.push(`${guidance}\n\n---\n\n${threads}`);
    }

    return sections.join("\n\n---\n\n");
  }

  private findThreadInternal(id: string): DiffToolCommentThread | undefined {
    return this.state.threads.find((thread) => thread.id === id);
  }
}

function formatGuideCommentContext(
  guide: DiffToolGuide,
  target: DiffToolGuideCommentTarget,
): { location: string; heading: string; content: string } {
  switch (target.kind) {
    case "orientation":
      return {
        location: "guide · orientation",
        heading: "Orientation",
        content: guide.orientation,
      };
    case "topic": {
      const topic = guide.topics.find((entry) => entry.id === target.topicId)!;
      return {
        location: `guide topic · ${topic.heading}`,
        heading: topic.heading,
        content: topic.body,
      };
    }
    case "question": {
      const question = guide.questions.find((entry) => entry.id === target.questionId)!;
      return {
        location: `guide question · ${question.question}`,
        heading: question.question,
        content: question.answer,
      };
    }
  }
}

function cloneGuide(guide: DiffToolGuide): DiffToolGuide {
  return {
    ...(guide.threadId ? { threadId: guide.threadId } : {}),
    orientation: guide.orientation,
    topics: guide.topics.map((topic) => ({ ...topic })),
    questions: guide.questions.map((question) => ({ ...question })),
    comments: guide.comments.map((comment) => ({
      ...comment,
      target: { ...comment.target },
    })),
    loading: guide.loading,
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
