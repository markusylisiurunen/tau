import { z } from "zod";
import type { DiffToolReviewState } from "./shared_types.js";
import { DIFF_TOOL_CODE_THEMES } from "./shared_types.js";

export type DiffToolReviewStateStorage = {
  load(): Promise<unknown | undefined>;
  save(document: unknown): Promise<void>;
};

const DIFF_TOOL_REVIEW_STATE_VERSION = 1;
const MAX_PERSISTED_REVIEW_STATE_BYTES = 2 * 1024 * 1024;
const MAX_THREADS = 1_000;
const MAX_MESSAGES_PER_THREAD = 1_000;
const MAX_TEXT_LENGTH = 512 * 1024;
const MAX_ID_LENGTH = 1_024;
const MAX_FILE_IDS = 10_000;

const idSchema = z.string().min(1).max(MAX_ID_LENGTH);
const textSchema = z.string().max(MAX_TEXT_LENGTH);
const lineAnchorSchema = z
  .object({
    kind: z.literal("line"),
    fileId: idSchema,
    filePath: idSchema,
    lineNumber: z.number().int().nonnegative(),
    side: z.enum(["additions", "deletions"]),
  })
  .strip();
const detachedAnchorSchema = z.object({ kind: z.literal("detached") }).strip();
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
          .strip(),
      )
      .max(MAX_MESSAGES_PER_THREAD),
    resolved: z.boolean(),
    collapsed: z.boolean(),
  })
  .strip();
const persistedStateSchema = z
  .object({
    diffStyle: z.enum(["stacked", "split"]),
    overflowMode: z.enum(["wrap", "scroll"]),
    codeTheme: z.enum(DIFF_TOOL_CODE_THEMES),
    sidebarOpen: z.boolean(),
    collapsedFileIds: z.array(idSchema).max(MAX_FILE_IDS),
    viewedFileIds: z.array(idSchema).max(MAX_FILE_IDS),
    threads: z.array(persistedThreadSchema).max(MAX_THREADS),
    brief: z.object({ content: textSchema }).strip(),
  })
  .strip();
const persistedDocumentSchema = z
  .object({
    version: z.literal(DIFF_TOOL_REVIEW_STATE_VERSION),
    scopeFingerprint: z.string().regex(/^[0-9a-f]{64}$/),
    state: persistedStateSchema,
  })
  .strip();

type PersistedDocument = z.infer<typeof persistedDocumentSchema>;

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
      sidebarOpen: state.sidebarOpen,
      collapsedFileIds: [...state.collapsedFileIds],
      viewedFileIds: [...state.viewedFileIds],
      threads: state.threads.map((thread) => ({
        id: thread.id,
        anchor: thread.anchor.kind === "line" ? { ...thread.anchor } : { kind: "detached" },
        messages: thread.messages.map((message) => ({ ...message })),
        resolved: thread.resolved,
        collapsed: thread.collapsed,
      })),
      brief: { content: state.brief.content },
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
  const parsed = persistedDocumentSchema.safeParse(document);
  if (!parsed.success) {
    throw new Error(`stored diff review state is invalid: ${z.prettifyError(parsed.error)}`);
  }
  if (parsed.data.scopeFingerprint !== scopeFingerprint) {
    throw new Error("stored diff review state belongs to a different diff snapshot");
  }

  return {
    diffStyle: parsed.data.state.diffStyle,
    overflowMode: parsed.data.state.overflowMode,
    codeTheme: parsed.data.state.codeTheme,
    sidebarOpen: parsed.data.state.sidebarOpen,
    collapsedFileIds: [...parsed.data.state.collapsedFileIds],
    viewedFileIds: [...parsed.data.state.viewedFileIds],
    threads: parsed.data.state.threads.map((thread) => ({
      id: thread.id,
      anchor: thread.anchor.kind === "line" ? { ...thread.anchor } : { kind: "detached" },
      messages: thread.messages.map((message) => ({ ...message })),
      loading: false,
      resolved: thread.resolved,
      collapsed: thread.collapsed,
    })),
    brief: {
      content: parsed.data.state.brief.content,
      loading: false,
    },
  };
}

function assertDocumentSize(document: unknown): void {
  let serialized: string;
  try {
    serialized = JSON.stringify(document);
  } catch (error) {
    throw new Error(
      `stored diff review state is not JSON serializable: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (Buffer.byteLength(serialized, "utf8") > MAX_PERSISTED_REVIEW_STATE_BYTES) {
    throw new Error(`stored diff review state exceeds ${MAX_PERSISTED_REVIEW_STATE_BYTES} bytes`);
  }
}
