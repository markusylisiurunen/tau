import { useCallback, useMemo, useState } from "react";
import { getErrorMessage } from "../../lib/errors.js";
import { createThread } from "../../api.js";
import { buildThreadsByFileId, resolveDraftFilePath } from "./thread_state.js";
import type { ReviewSession } from "../review/use_review_session.js";
import type { DiffToolReviewState } from "../../types.js";
import type { CommentDraft, LineAnnotation } from "../diff/comments.js";
import type { DiffFile } from "../diff/parse_diff.js";
import type { ThreadActions } from "./use_thread_actions.js";

type InlineThreadOptions = Pick<
  ReviewSession,
  "applyReviewState" | "setStatus"
> & {
  files: DiffFile[];
  reviewState: DiffToolReviewState;
  requestThreadAgentReply: ThreadActions["requestThreadAgentReply"];
};

export function useInlineThreads({
  files,
  reviewState,
  requestThreadAgentReply,
  applyReviewState,
  setStatus,
}: InlineThreadOptions) {
  const [draft, setDraft] = useState<CommentDraft | null>(null);

  const threadsByFileId = useMemo(
    () => buildThreadsByFileId(reviewState.threads),
    [reviewState.threads],
  );

  const draftAnnotation = useMemo<LineAnnotation | null>(() => {
    if (!draft) {
      return null;
    }

    return {
      lineNumber: draft.lineNumber,
      side: draft.side,
      metadata: { type: "draft", draft },
    };
  }, [draft]);

  const activateLine = useCallback(
    (fileId: string, lineNumber: number, side: CommentDraft["side"]) => {
      setDraft((currentDraft) => {
        if (
          currentDraft?.fileId === fileId &&
          currentDraft.lineNumber === lineNumber &&
          currentDraft.side === side
        ) {
          return currentDraft;
        }

        return { fileId, lineNumber, side };
      });
    },
    [],
  );

  const saveDraft = useCallback(
    (body: string, shouldRequestAgent: boolean) => {
      if (!draft) {
        return;
      }

      const trimmedBody = body.trim();
      if (!trimmedBody) {
        setDraft(null);
        return;
      }

      const anchor = {
        kind: "line" as const,
        fileId: draft.fileId,
        filePath: resolveDraftFilePath(draft, files),
        lineNumber: draft.lineNumber,
        side: draft.side,
      };

      const save = async () => {
        try {
          const result = await createThread({ body: trimmedBody, anchor });
          applyReviewState(result.state);
          setDraft(null);

          if (shouldRequestAgent) {
            await requestThreadAgentReply(result.threadId);
          }
        } catch (error) {
          setStatus(getErrorMessage(error));
        }
      };

      void save();
    },
    [applyReviewState, draft, files, requestThreadAgentReply, setStatus],
  );

  const cancelDraft = useCallback(() => setDraft(null), []);

  return {
    draft,
    draftAnnotation,
    threadsByFileId,
    activateLine,
    saveDraft,
    cancelDraft,
  };
}
