import { useCallback, useState } from "react";
import { cancelReview, returnReview } from "../../api.js";

export function useReviewSubmission() {
  const [finished, setFinished] = useState(false);

  const submit = useCallback(async () => {
    setFinished(true);
    try {
      await returnReview();
    } catch {
      setFinished(false);
    }
  }, []);

  const cancel = useCallback(async () => {
    setFinished(true);
    try {
      await cancelReview();
    } catch {
      setFinished(false);
    }
  }, []);

  return {
    finished,
    submit,
    cancel,
  };
}
