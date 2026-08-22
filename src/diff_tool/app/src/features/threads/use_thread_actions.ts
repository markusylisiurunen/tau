import { useCallback } from "react";
import { getErrorMessage } from "../../lib/errors.js";
import {
  collapseThread,
  deleteThreadMessage,
  replyToThread,
  requestThreadMessage,
  resolveThread,
} from "../../api.js";
import type { ReviewSession } from "../review/use_review_session.js";

type ThreadActionOptions = Pick<
  ReviewSession,
  "applyReviewState" | "syncReviewState" | "setThreadLoading" | "setStatus"
>;

export function useThreadActions({
  applyReviewState,
  syncReviewState,
  setThreadLoading,
  setStatus,
}: ThreadActionOptions) {
  const requestThreadAgentReply = useCallback(
    async (threadId: string) => {
      setThreadLoading(threadId, true);
      try {
        const result = await requestThreadMessage(threadId);
        applyReviewState(result.state);
      } catch (error) {
        setThreadLoading(threadId, false);
        setStatus(getErrorMessage(error));
      }
    },
    [applyReviewState, setStatus, setThreadLoading],
  );

  const addReply = useCallback(
    (threadId: string, text: string, shouldRequestAgent: boolean) => {
      if (!shouldRequestAgent) {
        void syncReviewState(replyToThread({ id: threadId, text }));
        return;
      }

      const reply = async () => {
        try {
          const result = await replyToThread({ id: threadId, text });
          applyReviewState(result.state);
          await requestThreadAgentReply(threadId);
        } catch (error) {
          setStatus(getErrorMessage(error));
        }
      };

      void reply();
    },
    [applyReviewState, requestThreadAgentReply, setStatus, syncReviewState],
  );

  const requestAgent = useCallback(
    (threadId: string) => {
      setStatus("");
      void requestThreadAgentReply(threadId);
    },
    [requestThreadAgentReply, setStatus],
  );

  const toggleResolved = useCallback(
    (threadId: string, resolved: boolean) => {
      void syncReviewState(resolveThread({ id: threadId, resolved }));
    },
    [syncReviewState],
  );

  const toggleThreadCollapsed = useCallback(
    (threadId: string, collapsed: boolean) => {
      void syncReviewState(collapseThread({ id: threadId, collapsed }));
    },
    [syncReviewState],
  );

  const removeThreadMessage = useCallback(
    (threadId: string, messageIndex: number) => {
      void syncReviewState(deleteThreadMessage({ id: threadId, messageIndex }));
    },
    [syncReviewState],
  );

  return {
    requestThreadAgentReply,
    addReply,
    requestAgent,
    toggleResolved,
    toggleThreadCollapsed,
    removeThreadMessage,
  };
}

export type ThreadActions = ReturnType<typeof useThreadActions>;
