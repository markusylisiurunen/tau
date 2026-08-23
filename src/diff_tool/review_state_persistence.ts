import { createHash } from "node:crypto";
import { z } from "zod";
import type { DiffReviewFile, DiffReviewSessionContextResult } from "../core/diff_review/index.js";
import type { DiffToolReviewState } from "./shared_types.js";
import {
  DIFF_TOOL_CODE_THEMES,
  DIFF_TOOL_GUIDE_QUESTION_LIMIT,
  DIFF_TOOL_GUIDE_TOPIC_LIMIT,
  guideCommentTargetKey,
} from "./shared_types.js";

export type DiffToolReviewStateStorage = {
  load(): Promise<unknown | undefined>;
  save(document: unknown): Promise<void>;
};

const DIFF_TOOL_REVIEW_STATE_VERSION = 2;
const MAX_PERSISTED_REVIEW_STATE_BYTES = 2 * 1024 * 1024;
const MAX_THREADS = 1_000;
const MAX_MESSAGES_PER_THREAD = 1_000;
const MAX_TEXT_LENGTH = 512 * 1024;
const MAX_ID_LENGTH = 1_024;
const MAX_FILE_IDS = 10_000;
const MAX_GUIDE_COMMENTS = DIFF_TOOL_GUIDE_TOPIC_LIMIT + DIFF_TOOL_GUIDE_QUESTION_LIMIT + 1;

const idSchema = z.string().min(1).max(MAX_ID_LENGTH);
const textSchema = z.string().max(MAX_TEXT_LENGTH);
const nonEmptyTextSchema = z.string().min(1).max(MAX_TEXT_LENGTH);
const lineAnchorSchema = z
  .object({
    kind: z.literal("line"),
    fileId: idSchema,
    filePath: idSchema,
    lineNumber: z.number().int().nonnegative(),
    side: z.enum(["additions", "deletions"]),
  })
  .strict();
const detachedAnchorSchema = z.object({ kind: z.literal("detached") }).strict();
const persistedThreadSchema = z
  .object({
    id: idSchema,
    anchor: z.union([lineAnchorSchema, detachedAnchorSchema]),
    messages: z
      .array(
        z
          .object({
            role: z.enum(["user", "assistant"]),
            text: textSchema,
          })
          .strict(),
      )
      .min(1)
      .max(MAX_MESSAGES_PER_THREAD),
    resolved: z.boolean(),
    collapsed: z.boolean(),
  })
  .strict()
  .refine((thread) => thread.messages[0]?.role === "user", {
    message: "thread must start with a user message",
  });
const persistedThreadsSchema = z
  .array(persistedThreadSchema)
  .max(MAX_THREADS)
  .refine((threads) => new Set(threads.map((thread) => thread.id)).size === threads.length, {
    message: "thread ids must be unique",
  });
const persistedGuideCommentTargetSchema = z.union([
  z.object({ kind: z.literal("orientation") }).strict(),
  z.object({ kind: z.literal("topic"), topicId: idSchema }).strict(),
  z.object({ kind: z.literal("question"), questionId: idSchema }).strict(),
]);
const persistedGuideTopicSchema = z
  .object({
    id: idSchema,
    label: z.string().min(1).max(32),
    heading: nonEmptyTextSchema,
    body: nonEmptyTextSchema,
  })
  .strict();
const persistedGuideQuestionSchema = z
  .object({
    id: idSchema,
    question: nonEmptyTextSchema,
    answer: nonEmptyTextSchema,
    source: z.enum(["generated", "user"]),
  })
  .strict();
const persistedGuideCommentSchema = z
  .object({
    target: persistedGuideCommentTargetSchema,
    body: nonEmptyTextSchema,
  })
  .strict();
const persistedGuideSchema = z
  .object({
    orientation: textSchema,
    topics: z.array(persistedGuideTopicSchema).max(DIFF_TOOL_GUIDE_TOPIC_LIMIT),
    questions: z.array(persistedGuideQuestionSchema).max(DIFF_TOOL_GUIDE_QUESTION_LIMIT),
    comments: z.array(persistedGuideCommentSchema).max(MAX_GUIDE_COMMENTS),
  })
  .strict()
  .superRefine((guide, context) => {
    const topicIds = new Set(guide.topics.map((topic) => topic.id));
    const questionIds = new Set(guide.questions.map((question) => question.id));
    const commentTargets = new Set(
      guide.comments.map((comment) => guideCommentTargetKey(comment.target)),
    );

    if (topicIds.size !== guide.topics.length) {
      context.addIssue({ code: "custom", path: ["topics"], message: "topic ids must be unique" });
    }
    if (questionIds.size !== guide.questions.length) {
      context.addIssue({
        code: "custom",
        path: ["questions"],
        message: "question ids must be unique",
      });
    }
    if (commentTargets.size !== guide.comments.length) {
      context.addIssue({
        code: "custom",
        path: ["comments"],
        message: "guide targets may have at most one review comment",
      });
    }
    if (
      !guide.orientation.trim() &&
      (guide.topics.length > 0 || guide.questions.length > 0 || guide.comments.length > 0)
    ) {
      context.addIssue({
        code: "custom",
        path: ["orientation"],
        message: "guide content requires an orientation",
      });
    }

    for (const [index, comment] of guide.comments.entries()) {
      const targetExists =
        comment.target.kind === "orientation"
          ? Boolean(guide.orientation)
          : comment.target.kind === "topic"
            ? topicIds.has(comment.target.topicId)
            : questionIds.has(comment.target.questionId);
      if (!targetExists) {
        context.addIssue({
          code: "custom",
          path: ["comments", index, "target"],
          message: "guide comment target must exist",
        });
      }
    }
  });
const persistedStateSchema = z
  .object({
    diffStyle: z.enum(["stacked", "split"]),
    overflowMode: z.enum(["wrap", "scroll"]),
    codeTheme: z.enum(DIFF_TOOL_CODE_THEMES),
    collapsedFileIds: z.array(idSchema).max(MAX_FILE_IDS),
    viewedFileIds: z.array(idSchema).max(MAX_FILE_IDS),
    threads: persistedThreadsSchema,
    guide: persistedGuideSchema,
  })
  .strict();
const persistedDocumentSchema = z
  .object({
    version: z.literal(DIFF_TOOL_REVIEW_STATE_VERSION),
    scopeFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
    state: persistedStateSchema,
  })
  .strict();
const legacyDocumentSchema = z
  .object({
    version: z.literal(1),
    scopeFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
    state: z
      .object({
        diffStyle: z.enum(["stacked", "split"]),
        overflowMode: z.enum(["wrap", "scroll"]),
        codeTheme: z.enum(DIFF_TOOL_CODE_THEMES),
        sidebarOpen: z.boolean(),
        collapsedFileIds: z.array(idSchema).max(MAX_FILE_IDS),
        viewedFileIds: z.array(idSchema).max(MAX_FILE_IDS),
        threads: persistedThreadsSchema,
        brief: z.object({ content: textSchema }).strict(),
      })
      .strict(),
  })
  .strict();

type PersistedDocument = z.infer<typeof persistedDocumentSchema>;
type PersistedState = PersistedDocument["state"];

export function createDiffReviewScopeFingerprint(
  context: DiffReviewSessionContextResult,
  files: readonly DiffReviewFile[],
  patch: string,
): string {
  return createHash("sha256")
    .update(
      JSON.stringify({
        repoRoot: context.repoRoot,
        cwd: context.cwd,
        diffArgs: context.diffArgs,
        diffCommand: context.diffCommand,
        files,
        patch,
      }),
    )
    .digest("hex");
}

export function createDiffToolPersistedReviewStateDocument(
  scopeFingerprint: string,
  state: DiffToolReviewState,
): unknown {
  const document: PersistedDocument = {
    version: DIFF_TOOL_REVIEW_STATE_VERSION,
    scopeFingerprint,
    state: {
      diffStyle: state.diffStyle,
      overflowMode: state.overflowMode,
      codeTheme: state.codeTheme,
      collapsedFileIds: [...state.collapsedFileIds],
      viewedFileIds: [...state.viewedFileIds],
      threads: state.threads.map((thread) => ({
        id: thread.id,
        anchor: thread.anchor.kind === "line" ? { ...thread.anchor } : { kind: "detached" },
        messages: thread.messages.map((message) => ({ ...message })),
        resolved: thread.resolved,
        collapsed: thread.collapsed,
      })),
      guide: {
        orientation: state.guide.orientation,
        topics: state.guide.topics.map((topic) => ({ ...topic })),
        questions: state.guide.questions.map((question) => ({ ...question })),
        comments: state.guide.comments.map((comment) => ({
          ...comment,
          target: { ...comment.target },
        })),
      },
    },
  };
  assertDocumentSize(document);
  const parsed = persistedDocumentSchema.safeParse(document);
  if (!parsed.success) {
    throw new Error(`diff review state cannot be persisted: ${z.prettifyError(parsed.error)}`);
  }
  return parsed.data;
}

export function parseDiffToolPersistedReviewStateDocument(
  document: unknown,
  scopeFingerprint: string,
): DiffToolReviewState {
  assertDocumentSize(document);
  const current = persistedDocumentSchema.safeParse(document);
  if (current.success) {
    assertScopeFingerprint(current.data.scopeFingerprint, scopeFingerprint);
    return toReviewState(current.data.state);
  }

  const legacy = legacyDocumentSchema.safeParse(document);
  if (!legacy.success) {
    throw new Error(`stored diff review state is invalid: ${z.prettifyError(current.error)}`);
  }
  assertScopeFingerprint(legacy.data.scopeFingerprint, scopeFingerprint);
  return toReviewState({
    diffStyle: legacy.data.state.diffStyle,
    overflowMode: legacy.data.state.overflowMode,
    codeTheme: legacy.data.state.codeTheme,
    collapsedFileIds: legacy.data.state.collapsedFileIds,
    viewedFileIds: legacy.data.state.viewedFileIds,
    threads: legacy.data.state.threads,
    guide: { orientation: "", topics: [], questions: [], comments: [] },
  });
}

function toReviewState(state: PersistedState): DiffToolReviewState {
  return {
    diffStyle: state.diffStyle,
    overflowMode: state.overflowMode,
    codeTheme: state.codeTheme,
    collapsedFileIds: [...state.collapsedFileIds],
    viewedFileIds: [...state.viewedFileIds],
    threads: state.threads.map((thread) => ({
      id: thread.id,
      anchor: thread.anchor.kind === "line" ? { ...thread.anchor } : { kind: "detached" },
      messages: thread.messages.map((message) => ({ ...message })),
      loading: false,
      resolved: thread.resolved,
      collapsed: thread.collapsed,
    })),
    guide: {
      orientation: state.guide.orientation,
      topics: state.guide.topics.map((topic) => ({ ...topic })),
      questions: state.guide.questions.map((question) => ({ ...question })),
      comments: state.guide.comments.map((comment) => ({
        ...comment,
        target: { ...comment.target },
      })),
      loading: false,
    },
  };
}

function assertScopeFingerprint(actual: string, expected: string): void {
  if (actual !== expected) {
    throw new Error("stored diff review state belongs to a different diff snapshot");
  }
}

function assertDocumentSize(document: unknown): void {
  let serialized: string | undefined;
  try {
    serialized = JSON.stringify(document);
  } catch (error) {
    throw new Error(
      `diff review state document is not JSON serializable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (serialized === undefined) {
    throw new Error("diff review state document is not JSON serializable");
  }
  if (Buffer.byteLength(serialized, "utf8") > MAX_PERSISTED_REVIEW_STATE_BYTES) {
    throw new Error(`diff review state document exceeds ${MAX_PERSISTED_REVIEW_STATE_BYTES} bytes`);
  }
}
