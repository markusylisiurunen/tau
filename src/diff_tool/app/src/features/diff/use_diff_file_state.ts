import { useCallback, useLayoutEffect, useMemo, useRef } from "react";
import { sumFileChanges, toLookup, toggleId, uniqueIds } from "./diff_state.js";
import { countThreadsByFileId, isLineThread } from "../threads/thread_state.js";
import type { DiffToolReviewState, ReviewStatePatch } from "../../types.js";
import type { DiffFile } from "./parse_diff.js";

type DiffFileStateOptions = {
  files: DiffFile[];
  reviewState: DiffToolReviewState;
  applyStatePatch: (
    patch: ReviewStatePatch,
    options?: { onError?: () => void },
  ) => void;
  scrollToFile: (fileId: string, behavior?: ScrollBehavior) => void;
};

export function useDiffFileState({
  files,
  reviewState,
  applyStatePatch,
  scrollToFile,
}: DiffFileStateOptions) {
  const pendingScrollTargetRef = useRef<string | null>(null);

  const collapsed = useMemo(
    () => toLookup(reviewState.collapsedFileIds),
    [reviewState.collapsedFileIds],
  );
  const viewed = useMemo(
    () => toLookup(reviewState.viewedFileIds),
    [reviewState.viewedFileIds],
  );
  const unresolvedThreads = useMemo(
    () => reviewState.threads.filter((thread) => !thread.resolved),
    [reviewState.threads],
  );
  const filesWithUnresolvedThreads = useMemo(
    () =>
      uniqueIds(
        unresolvedThreads
          .filter(isLineThread)
          .map((thread) => thread.anchor.fileId),
      ),
    [unresolvedThreads],
  );
  const unresolvedThreadCountsByFileId = useMemo(
    () => countThreadsByFileId(unresolvedThreads),
    [unresolvedThreads],
  );
  const totals = useMemo(
    () => files.reduce(sumFileChanges, { additions: 0, deletions: 0 }),
    [files],
  );

  const toggleCollapsed = useCallback(
    (fileId: string) => {
      applyStatePatch({
        collapsedFileIds: toggleId(reviewState.collapsedFileIds, fileId),
      });
    },
    [applyStatePatch, reviewState.collapsedFileIds],
  );

  const toggleViewed = useCallback(
    (fileId: string) => {
      const nextViewed = toggleId(reviewState.viewedFileIds, fileId);
      const isViewed = nextViewed.includes(fileId);
      const nextCollapsed = isViewed
        ? uniqueIds([...reviewState.collapsedFileIds, fileId])
        : reviewState.collapsedFileIds;

      pendingScrollTargetRef.current =
        isViewed && !reviewState.collapsedFileIds.includes(fileId)
          ? fileId
          : null;

      applyStatePatch(
        {
          viewedFileIds: nextViewed,
          collapsedFileIds: nextCollapsed,
        },
        {
          onError: () => {
            pendingScrollTargetRef.current = null;
          },
        },
      );
    },
    [applyStatePatch, reviewState.collapsedFileIds, reviewState.viewedFileIds],
  );

  const expandAll = useCallback(() => {
    applyStatePatch({ collapsedFileIds: [] });
  }, [applyStatePatch]);

  const collapseAll = useCallback(() => {
    applyStatePatch({ collapsedFileIds: files.map((file) => file.id) });
  }, [applyStatePatch, files]);

  const expandUnresolved = useCallback(() => {
    if (filesWithUnresolvedThreads.length === 0) {
      return;
    }

    const unresolvedFileIds = new Set(filesWithUnresolvedThreads);
    applyStatePatch({
      collapsedFileIds: reviewState.collapsedFileIds.filter(
        (fileId) => !unresolvedFileIds.has(fileId),
      ),
    });
  }, [
    applyStatePatch,
    filesWithUnresolvedThreads,
    reviewState.collapsedFileIds,
  ]);

  const collapseViewed = useCallback(() => {
    applyStatePatch({
      collapsedFileIds: uniqueIds([
        ...reviewState.collapsedFileIds,
        ...reviewState.viewedFileIds,
      ]),
    });
  }, [
    applyStatePatch,
    reviewState.collapsedFileIds,
    reviewState.viewedFileIds,
  ]);

  useLayoutEffect(() => {
    const targetFileId = pendingScrollTargetRef.current;
    if (!targetFileId) {
      return;
    }

    pendingScrollTargetRef.current = null;
    scrollToFile(targetFileId, "auto");
  }, [reviewState.collapsedFileIds, scrollToFile]);

  return {
    collapsed,
    viewed,
    unresolvedThreadCount: unresolvedThreads.length,
    filesWithUnresolvedThreads,
    unresolvedThreadCountsByFileId,
    totals,
    toggleCollapsed,
    toggleViewed,
    expandAll,
    collapseAll,
    expandUnresolved,
    collapseViewed,
  };
}

export type DiffFileState = ReturnType<typeof useDiffFileState>;
