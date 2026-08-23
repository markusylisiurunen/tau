import type { DiffToolReviewState } from "../../types.js";
import type {
  CommentDraft,
  CommentThread,
  LineAnnotation,
} from "../diff/comments.js";
import type { DiffFile } from "../diff/parse_diff.js";

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
