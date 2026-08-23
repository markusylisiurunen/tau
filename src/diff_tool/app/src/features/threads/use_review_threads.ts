import type { DiffToolReviewState } from "../../types.js";
import type { DiffFile } from "../diff/parse_diff.js";
import type { ReviewSession } from "../review/use_review_session.js";
import { useDetachedThreads } from "./use_detached_threads.js";
import { useInlineThreads } from "./use_inline_threads.js";
import { useThreadActions } from "./use_thread_actions.js";

type ReviewThreadOptions = Pick<
  ReviewSession,
  "applyReviewState" | "syncReviewState" | "setThreadLoading"
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
}: ReviewThreadOptions) {
  const actions = useThreadActions({
    applyReviewState,
    syncReviewState,
    setThreadLoading,
  });
  const inline = useInlineThreads({
    files,
    reviewState,
    requestThreadAgentReply: actions.requestThreadAgentReply,
    applyReviewState,
  });
  const detached = useDetachedThreads({
    reviewState,
    requestThreadAgentReply: actions.requestThreadAgentReply,
    applyReviewState,
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
      draftKind: detached.draftKind,
      body: detached.body,
      submitting: detached.submitting,
      setBody: detached.setBody,
      openComment: () => detached.openDraft("comment"),
      openConversation: () => detached.openDraft("conversation"),
      open: detached.openThread,
      showHistory: detached.showHistory,
      submit: detached.submit,
      exclude: (threadId: string) => actions.toggleResolved(threadId, true),
      include: (threadId: string) => actions.toggleResolved(threadId, false),
    },
  };
}

export type ReviewThreads = ReturnType<typeof useReviewThreads>;
