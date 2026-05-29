import type {
  CommentDraft,
  CommentThread,
  LineAnnotation,
} from "./comments.js";
import type { DiffFile } from "./parse_diff.js";
import {
  DEFAULT_DIFF_TOOL_CODE_THEME,
  DIFF_TOOL_CODE_THEMES,
  type DiffToolReviewState,
} from "./types.js";

export const emptyReviewState: DiffToolReviewState = {
  diffStyle: "split",
  overflowMode: "wrap",
  codeTheme: DEFAULT_DIFF_TOOL_CODE_THEME,
  sidebarOpen: false,
  collapsedFileIds: [],
  viewedFileIds: [],
  threads: [],
  brief: {
    content: "",
    loading: false,
  },
};

const codeThemes = new Set<DiffToolReviewState["codeTheme"]>(
  DIFF_TOOL_CODE_THEMES,
);

export function normalizeReviewState(
  state: DiffToolReviewState,
): DiffToolReviewState {
  return {
    ...state,
    diffStyle: state.diffStyle === "split" ? "split" : "stacked",
    overflowMode: state.overflowMode === "scroll" ? "scroll" : "wrap",
    codeTheme: normalizeCodeTheme(state.codeTheme),
    threads: state.threads.map((thread) => ({
      ...thread,
      anchor:
        thread.anchor.kind === "line"
          ? { ...thread.anchor }
          : { kind: "detached" as const },
      resolved: Boolean(thread.resolved),
      collapsed: Boolean(thread.collapsed),
    })),
    brief: {
      ...(state.brief.threadId ? { threadId: state.brief.threadId } : {}),
      content: state.brief.content,
      loading: Boolean(state.brief.loading),
    },
  };
}

export function isLineThread(thread: CommentThread): thread is CommentThread & {
  anchor: Extract<CommentThread["anchor"], { kind: "line" }>;
} {
  return thread.anchor.kind === "line";
}

export function isDetachedThread(
  thread: CommentThread,
): thread is CommentThread & {
  anchor: Extract<CommentThread["anchor"], { kind: "detached" }>;
} {
  return thread.anchor.kind === "detached";
}

export function toLookup(ids: string[]): Record<string, boolean> {
  return Object.fromEntries(ids.map((id) => [id, true]));
}

export function toggleId(ids: string[], id: string): string[] {
  return ids.includes(id) ? ids.filter((value) => value !== id) : [...ids, id];
}

export function uniqueIds(ids: string[]): string[] {
  return [...new Set(ids)];
}

export function sumFileChanges(
  totals: { additions: number; deletions: number },
  file: DiffFile,
): { additions: number; deletions: number } {
  return {
    additions: totals.additions + file.additions,
    deletions: totals.deletions + file.deletions,
  };
}

function normalizeCodeTheme(
  codeTheme: DiffToolReviewState["codeTheme"],
): DiffToolReviewState["codeTheme"] {
  return codeThemes.has(codeTheme) ? codeTheme : DEFAULT_DIFF_TOOL_CODE_THEME;
}

export function buildThreadsByFileId(
  threads: DiffToolReviewState["threads"],
): Map<string, LineAnnotation[]> {
  const annotationsByFileId = new Map<string, LineAnnotation[]>();

  for (const thread of threads) {
    if (!isLineThread(thread)) {
      continue;
    }

    const annotation: LineAnnotation = {
      lineNumber: thread.anchor.lineNumber,
      side: thread.anchor.side,
      metadata: { type: "thread", thread },
    };
    const fileAnnotations = annotationsByFileId.get(thread.anchor.fileId);
    if (fileAnnotations) {
      fileAnnotations.push(annotation);
    } else {
      annotationsByFileId.set(thread.anchor.fileId, [annotation]);
    }
  }

  return annotationsByFileId;
}

export function countThreadsByFileId(
  threads: DiffToolReviewState["threads"],
): Map<string, number> {
  const countsByFileId = new Map<string, number>();

  for (const thread of threads) {
    if (!isLineThread(thread)) {
      continue;
    }

    countsByFileId.set(
      thread.anchor.fileId,
      (countsByFileId.get(thread.anchor.fileId) ?? 0) + 1,
    );
  }

  return countsByFileId;
}

export function withDraftAnnotation(
  annotations: LineAnnotation[],
  fileId: string,
  draft: CommentDraft | null,
  draftAnnotation: LineAnnotation | null,
): LineAnnotation[] {
  if (!draftAnnotation || draft?.fileId !== fileId) {
    return annotations;
  }

  return [...annotations, draftAnnotation];
}

export function withThreadLoading(
  state: DiffToolReviewState,
  threadId: string,
  loading: boolean,
): DiffToolReviewState {
  return {
    ...state,
    threads: state.threads.map((thread) =>
      thread.id === threadId ? { ...thread, loading } : thread,
    ),
  };
}

export function withBriefLoading(
  state: DiffToolReviewState,
  loading: boolean,
): DiffToolReviewState {
  return {
    ...state,
    brief: {
      ...state.brief,
      loading,
    },
  };
}

export function resolveDraftFilePath(
  draft: CommentDraft,
  files: DiffFile[],
): string {
  const file = files.find((entry) => entry.id === draft.fileId);
  if (draft.side === "deletions") {
    return file?.oldRepoPath ?? file?.newRepoPath ?? draft.fileId;
  }
  return file?.newRepoPath ?? file?.oldRepoPath ?? draft.fileId;
}
