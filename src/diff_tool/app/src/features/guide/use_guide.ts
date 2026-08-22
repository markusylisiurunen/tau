import { useCallback, useEffect, useRef } from "react";
import { generateGuide, operateGuide, saveGuideComment } from "../../api.js";
import type { ReviewSession } from "../review/use_review_session.js";
import type {
  DiffToolGuideCommentTarget,
  DiffToolGuideOperation,
} from "../../types.js";

type GuideControllerOptions = Pick<
  ReviewSession,
  | "bootstrap"
  | "reviewState"
  | "setStatus"
  | "setGuideLoading"
  | "syncReviewState"
>;

export function useGuide({
  bootstrap,
  reviewState,
  setStatus,
  setGuideLoading,
  syncReviewState,
}: GuideControllerOptions) {
  const guideRequestedRef = useRef(false);

  const requestGuide = useCallback(() => {
    setStatus("");
    setGuideLoading(true);
    void syncReviewState(generateGuide(), {
      onError: () => {
        guideRequestedRef.current = false;
        setGuideLoading(false);
      },
    });
  }, [setGuideLoading, setStatus, syncReviewState]);

  const runGuideOperation = useCallback(
    (operation: DiffToolGuideOperation) => {
      setStatus("");
      setGuideLoading(true);
      void syncReviewState(operateGuide(operation), {
        onError: () => {
          setGuideLoading(false);
        },
      });
    },
    [setGuideLoading, setStatus, syncReviewState],
  );

  const saveComment = useCallback(
    (target: DiffToolGuideCommentTarget, body: string) => {
      setStatus("");
      void syncReviewState(saveGuideComment({ target, body }));
    },
    [setStatus, syncReviewState],
  );

  useEffect(() => {
    if (
      !bootstrap ||
      reviewState.guide.orientation ||
      guideRequestedRef.current
    ) {
      return;
    }

    guideRequestedRef.current = true;
    requestGuide();
  }, [bootstrap, requestGuide, reviewState.guide.orientation]);

  return {
    requestGuide,
    runGuideOperation,
    saveComment,
  };
}
