import { useCallback, useState } from "react";
import { getErrorMessage } from "../../lib/errors.js";
import { cancelReview, returnReview } from "../../api.js";
import type { ReviewSession } from "./use_review_session.js";

type ReviewSubmissionOptions = Pick<ReviewSession, "setStatus">;

export function useReviewSubmission({ setStatus }: ReviewSubmissionOptions) {
  const [finished, setFinished] = useState(false);

  const submit = useCallback(async () => {
    setFinished(true);
    setStatus("Returning review…");
    try {
      await returnReview();
      setStatus("Review returned. You can close this tab.");
    } catch (error) {
      setFinished(false);
      setStatus(getErrorMessage(error));
    }
  }, [setStatus]);

  const cancel = useCallback(async () => {
    setFinished(true);
    setStatus("Cancelling…");
    try {
      await cancelReview();
      setStatus("Cancelled. You can close this tab.");
    } catch (error) {
      setFinished(false);
      setStatus(getErrorMessage(error));
    }
  }, [setStatus]);

  return {
    finished,
    submit,
    cancel,
  };
}
