import type { CommentDraft, LineAnnotation } from "./comments.js";
import type { DiffFile } from "./parse_diff.js";
import type { DiffToolReviewState } from "./types.js";

export const emptyReviewState: DiffToolReviewState = {
  diffStyle: "split",
  overflowMode: "wrap",
  sidebarOpen: false,
  collapsedFileIds: [],
  viewedFileIds: [],
  threads: [],
  brief: {
    content: "",
    loading: false,
  },
};

export function normalizeReviewState(
  state: DiffToolReviewState,
): DiffToolReviewState {
  return {
    ...state,
    diffStyle: state.diffStyle === "split" ? "split" : "stacked",
    overflowMode: state.overflowMode === "scroll" ? "scroll" : "wrap",
    threads: state.threads.map((thread) => ({
      ...thread,
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

export function toLookup(ids: string[]): Record<string, boolean> {
  return Object.fromEntries(ids.map((id) => [id, true]));
}

export function toggleId(ids: string[], id: string): string[] {
  return ids.includes(id) ? ids.filter((value) => value !== id) : [...ids, id];
}

export function uniqueIds(ids: string[]): string[] {
  return [...new Set(ids)];
}

export function getAdjacentFileId(
  files: DiffFile[],
  fileId: string,
): string | null {
  const index = files.findIndex((file) => file.id === fileId);
  if (index === -1) {
    return null;
  }

  return files[index + 1]?.id ?? files[index - 1]?.id ?? null;
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

export function buildThreadsByFileId(
  threads: DiffToolReviewState["threads"],
): Map<string, LineAnnotation[]> {
  const annotationsByFileId = new Map<string, LineAnnotation[]>();

  for (const thread of threads) {
    const annotation: LineAnnotation = {
      lineNumber: thread.lineNumber,
      side: thread.side,
      metadata: { type: "thread", thread },
    };
    const fileAnnotations = annotationsByFileId.get(thread.fileId);
    if (fileAnnotations) {
      fileAnnotations.push(annotation);
    } else {
      annotationsByFileId.set(thread.fileId, [annotation]);
    }
  }

  return annotationsByFileId;
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
