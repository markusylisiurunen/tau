import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getErrorMessage } from "../../lib/errors.js";
import { createThread, replyToThread } from "../../api.js";
import { isDetachedThread } from "./thread_state.js";
import type { ReviewSession } from "../review/use_review_session.js";
import type { DiffToolReviewState } from "../../types.js";
import type { ThreadActions } from "./use_thread_actions.js";

type DetachedThreadDialogState =
  { mode: "new" } | { mode: "thread"; threadId: string };

type DetachedThreadOptions = Pick<
  ReviewSession,
  "applyReviewState" | "setStatus"
> & {
  reviewState: DiffToolReviewState;
  requestThreadAgentReply: ThreadActions["requestThreadAgentReply"];
};

export function useDetachedThreads({
  reviewState,
  requestThreadAgentReply,
  applyReviewState,
  setStatus,
}: DetachedThreadOptions) {
  const [body, setBody] = useState("");
  const [skipAgentResponse, setSkipAgentResponse] = useState(false);
  const [dialog, setDialog] = useState<DetachedThreadDialogState | null>(null);
  const dialogVersionRef = useRef(0);

  const selectedThread = useMemo(() => {
    if (dialog?.mode !== "thread") {
      return null;
    }

    return (
      reviewState.threads.find(
        (thread) => thread.id === dialog.threadId && isDetachedThread(thread),
      ) ?? null
    );
  }, [dialog, reviewState.threads]);

  const openDraft = useCallback(() => {
    dialogVersionRef.current += 1;
    setBody("");
    setSkipAgentResponse(false);
    setDialog({ mode: "new" });
  }, []);

  const openThread = useCallback((threadId: string) => {
    dialogVersionRef.current += 1;
    setBody("");
    setSkipAgentResponse(false);
    setDialog({ mode: "thread", threadId });
  }, []);

  const close = useCallback(() => {
    dialogVersionRef.current += 1;
    setBody("");
    setSkipAgentResponse(false);
    setDialog(null);
  }, []);

  useEffect(() => {
    if (dialog?.mode === "thread" && !selectedThread) {
      close();
    }
  }, [close, dialog, selectedThread]);

  const resetDraftIfCurrent = useCallback((dialogVersion: number) => {
    if (dialogVersionRef.current !== dialogVersion) {
      return false;
    }

    setBody("");
    setSkipAgentResponse(false);
    return true;
  }, []);

  const submit = useCallback(async () => {
    const trimmedBody = body.trim();
    if (!trimmedBody) {
      return;
    }

    const shouldRequestAgent = !skipAgentResponse;
    const dialogVersion = dialogVersionRef.current;
    setStatus("");

    try {
      if (dialog?.mode === "thread") {
        const result = await replyToThread({
          id: dialog.threadId,
          text: trimmedBody,
        });
        applyReviewState(result.state);
        if (!resetDraftIfCurrent(dialogVersion)) {
          return;
        }

        if (shouldRequestAgent) {
          await requestThreadAgentReply(dialog.threadId);
        }
        return;
      }

      const result = await createThread({
        body: trimmedBody,
        anchor: { kind: "detached" },
      });
      applyReviewState(result.state);

      if (!resetDraftIfCurrent(dialogVersion)) {
        return;
      }
      setDialog({ mode: "thread", threadId: result.threadId });

      if (shouldRequestAgent) {
        await requestThreadAgentReply(result.threadId);
      }
    } catch (error) {
      setStatus(getErrorMessage(error));
    }
  }, [
    applyReviewState,
    body,
    dialog,
    requestThreadAgentReply,
    resetDraftIfCurrent,
    setStatus,
    skipAgentResponse,
  ]);

  return {
    body,
    setBody,
    skipAgentResponse,
    setSkipAgentResponse,
    selectedThread,
    selectedThreadId: dialog?.mode === "thread" ? dialog.threadId : null,
    open: dialog !== null,
    openDraft,
    openThread,
    close,
    submit,
  };
}
