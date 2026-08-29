import { useCallback, useState } from "react";
import {
  cancelReview,
  fetchReviewPreview,
  resolveThread,
  returnReview,
  saveGuideComment,
} from "../../api.js";
import { getErrorMessage } from "../../lib/errors.js";
import type {
  DiffToolReviewPreview,
  DiffToolReviewPreviewItem,
} from "../../types.js";
import type { ReviewSession } from "./use_review_session.js";

type ReviewSubmissionOptions = Pick<ReviewSession, "applyReviewState">;

export function useReviewSubmission({
  applyReviewState,
}: ReviewSubmissionOptions) {
  const [finished, setFinished] = useState(false);
  const [previewOpen, setPreviewOpen] = useState(false);
  const [preview, setPreview] = useState<DiffToolReviewPreview | null>(null);
  const [loadingPreview, setLoadingPreview] = useState(false);
  const [excludingItem, setExcludingItem] =
    useState<DiffToolReviewPreviewItem | null>(null);
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const loadPreview = useCallback(async () => {
    setLoadingPreview(true);
    setError(null);
    try {
      setPreview(await fetchReviewPreview());
    } catch (loadError) {
      setError(getErrorMessage(loadError));
    } finally {
      setLoadingPreview(false);
    }
  }, []);

  const openPreview = useCallback(() => {
    setPreviewOpen(true);
    setPreview(null);
    setCopied(false);
    void loadPreview();
  }, [loadPreview]);

  const closePreview = useCallback(() => {
    if (!finished) {
      setPreviewOpen(false);
    }
  }, [finished]);

  const exclude = useCallback(
    async (item: DiffToolReviewPreviewItem) => {
      setExcludingItem(item);
      setCopied(false);
      setError(null);
      try {
        const result =
          item.kind === "thread"
            ? await resolveThread({ id: item.id, resolved: true })
            : await saveGuideComment({ target: item.target, body: "" });
        applyReviewState(result.state);
        setPreview(await fetchReviewPreview());
      } catch (excludeError) {
        setError(getErrorMessage(excludeError));
      } finally {
        setExcludingItem(null);
      }
    },
    [applyReviewState],
  );

  const copy = useCallback(async () => {
    if (preview?.submission.outcome !== "commented") {
      return;
    }

    setError(null);
    try {
      await navigator.clipboard.writeText(preview.submission.review);
      setCopied(true);
    } catch (copyError) {
      setError(getErrorMessage(copyError));
    }
  }, [preview]);

  const submit = useCallback(async () => {
    setFinished(true);
    setError(null);
    try {
      await returnReview();
    } catch (submitError) {
      setFinished(false);
      setError(getErrorMessage(submitError));
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
    previewOpen,
    preview,
    loadingPreview,
    excludingItem,
    copied,
    error,
    openPreview,
    closePreview,
    exclude,
    copy,
    submit,
    cancel,
  };
}
