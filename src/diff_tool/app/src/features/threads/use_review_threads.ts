import { useCallback } from "react";
import type { ReviewSession } from "../review/use_review_session.js";
import type { DiffToolReviewState } from "../../types.js";
import type { CommentThread } from "../diff/comments.js";
import type { DiffFile } from "../diff/parse_diff.js";
import { useDetachedThreads } from "./use_detached_threads.js";
import { useInlineThreads } from "./use_inline_threads.js";
import { useThreadActions } from "./use_thread_actions.js";

type ReviewThreadOptions = Pick<
  ReviewSession,
  "applyReviewState" | "syncReviewState" | "setThreadLoading" | "setStatus"
> & {
  files: DiffFile[];
  reviewState: DiffToolReviewState;
  revealFile: (fileId: string) => void;
};

export function useReviewThreads({
  files,
  reviewState,
  revealFile,
  applyReviewState,
  syncReviewState,
  setThreadLoading,
  setStatus,
}: ReviewThreadOptions) {
  const actions = useThreadActions({
    applyReviewState,
    syncReviewState,
    setThreadLoading,
    setStatus,
  });
  const inline = useInlineThreads({
    files,
    reviewState,
    requestThreadAgentReply: actions.requestThreadAgentReply,
    applyReviewState,
    setStatus,
  });
  const detached = useDetachedThreads({
    reviewState,
    requestThreadAgentReply: actions.requestThreadAgentReply,
    applyReviewState,
    setStatus,
  });

  const openThread = useCallback(
    (thread: CommentThread) => {
      if (thread.anchor.kind === "detached") {
        detached.openThread(thread.id);
        return;
      }

      detached.close();
      revealFile(thread.anchor.fileId);
    },
    [detached.close, detached.openThread, revealFile],
  );

  return {
    ...inline,
    addReply: actions.addReply,
    requestAgent: actions.requestAgent,
    toggleResolved: actions.toggleResolved,
    toggleThreadCollapsed: actions.toggleThreadCollapsed,
    removeThreadMessage: actions.removeThreadMessage,
    selectedDetachedThread: detached.selectedThread,
    selectedDetachedThreadId: detached.selectedThreadId,
    detachedDialogOpen: detached.open,
    detachedDraftBody: detached.body,
    detachedSkipAgentResponse: detached.skipAgentResponse,
    setDetachedDraftBody: detached.setBody,
    setDetachedSkipAgentResponse: detached.setSkipAgentResponse,
    openDetachedThreadDraft: detached.openDraft,
    closeDetachedThreadDialog: detached.close,
    submitDetachedDraft: detached.submit,
    openThread,
  };
}

export type ReviewThreads = ReturnType<typeof useReviewThreads>;
