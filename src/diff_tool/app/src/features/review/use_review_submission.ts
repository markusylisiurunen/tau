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

async function copyText(text: string): Promise<void> {
  if (window.isSecureContext && navigator.clipboard) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      if (copyTextWithExecCommand(text)) {
        return;
      }
      throw new Error("copy is unavailable in this browser");
    }
  }

  if (!copyTextWithExecCommand(text)) {
    throw new Error("copy is unavailable in this browser");
  }
}

function copyTextWithExecCommand(text: string): boolean {
  const textarea = document.createElement("textarea");
  const focusedElement = document.activeElement;
  textarea.value = text;
  textarea.readOnly = true;
  textarea.style.opacity = "0";
  textarea.style.position = "fixed";
  document.body.append(textarea);
  try {
    textarea.select();
    return document.execCommand("copy");
  } finally {
    textarea.remove();
    if (focusedElement instanceof HTMLElement) {
      focusedElement.focus();
    }
  }
}

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

  const approve = useCallback(async () => {
    setFinished(true);
    setPreview(null);
    setCopied(false);
    setError(null);
    try {
      const approvalPreview = await fetchReviewPreview();
      setPreview(approvalPreview);
      if (approvalPreview.submission.outcome === "commented") {
        setFinished(false);
        setPreviewOpen(true);
        return;
      }
      await returnReview({ previewId: approvalPreview.previewId });
    } catch (approveError) {
      setFinished(false);
      setPreviewOpen(true);
      setError(getErrorMessage(approveError));
    }
  }, []);

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
      await copyText(preview.submission.review);
      setCopied(true);
    } catch (copyError) {
      setError(getErrorMessage(copyError));
    }
  }, [preview]);

  const submit = useCallback(async () => {
    if (!preview) {
      return;
    }

    setFinished(true);
    setError(null);
    try {
      await returnReview({ previewId: preview.previewId });
    } catch (submitError) {
      setFinished(false);
      setError(getErrorMessage(submitError));
    }
  }, [preview]);

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
    approve,
    exclude,
    copy,
    submit,
    cancel,
  };
}
