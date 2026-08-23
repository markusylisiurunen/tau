import type { ReviewSession } from "../review/use_review_session.js";
import type { DiffToolReviewState } from "../../types.js";
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
};

export function useReviewThreads({
  files,
  reviewState,
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

  return {
    ...inline,
    addReply: actions.addReply,
    requestAgent: actions.requestAgent,
    toggleResolved: actions.toggleResolved,
    toggleThreadCollapsed: actions.toggleThreadCollapsed,
    removeThreadMessage: actions.removeThreadMessage,
    guideConversations: {
      items: detached.threads,
      selected: detached.selectedThread,
      view: detached.view,
      body: detached.body,
      submitting: detached.submitting,
      setBody: detached.setBody,
      openNew: detached.openDraft,
      open: detached.openThread,
      showHistory: detached.showHistory,
      submit: detached.submit,
      exclude: (threadId: string) => actions.toggleResolved(threadId, true),
    },
  };
}

export type ReviewThreads = ReturnType<typeof useReviewThreads>;
