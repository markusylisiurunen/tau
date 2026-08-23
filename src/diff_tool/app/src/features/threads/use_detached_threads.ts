import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createThread, replyToThread } from "../../api.js";
import { getErrorMessage } from "../../lib/errors.js";
import type { DiffToolReviewState } from "../../types.js";
import type { ReviewSession } from "../review/use_review_session.js";
import { isDetachedThread } from "./thread_state.js";
import type { ThreadActions } from "./use_thread_actions.js";

type DetachedThreadView =
  { mode: "history" } | { mode: "new" } | { mode: "thread"; threadId: string };

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
  const [submitting, setSubmitting] = useState(false);
  const [view, setView] = useState<DetachedThreadView>({ mode: "new" });
  const selectionVersionRef = useRef(0);
  const submittingRef = useRef(false);

  const threads = useMemo(
    () => reviewState.threads.filter(isDetachedThread).reverse(),
    [reviewState.threads],
  );
  const selectedThread = useMemo(() => {
    if (view.mode !== "thread") {
      return null;
    }

    return threads.find((thread) => thread.id === view.threadId) ?? null;
  }, [threads, view]);

  const openDraft = useCallback(() => {
    selectionVersionRef.current += 1;
    setBody("");
    setView({ mode: "new" });
  }, []);

  const openThread = useCallback((threadId: string) => {
    selectionVersionRef.current += 1;
    setBody("");
    setView({ mode: "thread", threadId });
  }, []);

  const showHistory = useCallback(() => {
    selectionVersionRef.current += 1;
    setBody("");
    setView({ mode: "history" });
  }, []);

  useEffect(() => {
    if (view.mode === "thread" && !selectedThread) {
      showHistory();
    }
  }, [selectedThread, showHistory, view]);

  const resetDraftIfCurrent = useCallback((selectionVersion: number) => {
    if (selectionVersionRef.current !== selectionVersion) {
      return false;
    }

    setBody("");
    return true;
  }, []);

  const submit = useCallback(async () => {
    const trimmedBody = body.trim();
    if (
      !trimmedBody ||
      submittingRef.current ||
      view.mode === "history" ||
      (view.mode === "thread" &&
        (!selectedThread || selectedThread.loading || selectedThread.resolved))
    ) {
      return;
    }

    const selectionVersion = selectionVersionRef.current;
    let threadId: string;
    submittingRef.current = true;
    setSubmitting(true);
    setStatus("");

    try {
      if (view.mode === "thread") {
        threadId = view.threadId;
        const result = await replyToThread({ id: threadId, text: trimmedBody });
        applyReviewState(result.state);
        resetDraftIfCurrent(selectionVersion);
      } else {
        const result = await createThread({
          body: trimmedBody,
          anchor: { kind: "detached" },
        });
        threadId = result.threadId;
        applyReviewState(result.state);

        if (resetDraftIfCurrent(selectionVersion)) {
          setView({ mode: "thread", threadId });
        }
      }
    } catch (error) {
      setStatus(getErrorMessage(error));
      return;
    } finally {
      submittingRef.current = false;
      setSubmitting(false);
    }

    await requestThreadAgentReply(threadId);
  }, [
    applyReviewState,
    body,
    requestThreadAgentReply,
    resetDraftIfCurrent,
    selectedThread,
    setStatus,
    view,
  ]);

  return {
    body,
    setBody,
    submitting,
    threads,
    selectedThread,
    view: view.mode,
    openDraft,
    openThread,
    showHistory,
    submit,
  };
}
