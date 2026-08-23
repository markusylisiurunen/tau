import { useCallback, useEffect, useRef } from "react";
import { generateGuide, operateGuide, saveGuideComment } from "../../api.js";
import type {
  DiffToolGuideCommentTarget,
  DiffToolGuideOperation,
} from "../../types.js";
import type { ReviewSession } from "../review/use_review_session.js";

type GuideControllerOptions = Pick<
  ReviewSession,
  "bootstrap" | "reviewState" | "setGuideLoading" | "syncReviewState"
>;

export function useGuide({
  bootstrap,
  reviewState,
  setGuideLoading,
  syncReviewState,
}: GuideControllerOptions) {
  const guideRequestedRef = useRef(false);

  const requestGuide = useCallback(() => {
    setGuideLoading(true);
    void syncReviewState(generateGuide(), {
      onError: () => {
        guideRequestedRef.current = false;
        setGuideLoading(false);
      },
    });
  }, [setGuideLoading, syncReviewState]);

  const runGuideOperation = useCallback(
    (operation: DiffToolGuideOperation) => {
      setGuideLoading(true);
      void syncReviewState(operateGuide(operation), {
        onError: () => {
          setGuideLoading(false);
        },
      });
    },
    [setGuideLoading, syncReviewState],
  );

  const saveComment = useCallback(
    (target: DiffToolGuideCommentTarget, body: string) => {
      void syncReviewState(saveGuideComment({ target, body }));
    },
    [syncReviewState],
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
