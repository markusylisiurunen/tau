import { Dialog } from "@base-ui/react/dialog";
import { Check, Copy, X } from "lucide-react";
import { Button } from "../../ui/button.js";
import { MarkdownContent } from "../../ui/markdown_content.js";
import { guideCommentTargetKey } from "../../types.js";
import type { useReviewSubmission } from "./use_review_submission.js";
import "./review_submission_dialog.css";

type ReviewSubmissionDialogProps = Pick<
  ReturnType<typeof useReviewSubmission>,
  | "previewOpen"
  | "preview"
  | "loadingPreview"
  | "excludingItem"
  | "copied"
  | "error"
  | "finished"
  | "closePreview"
  | "exclude"
  | "copy"
  | "submit"
>;

export function ReviewSubmissionDialog({
  previewOpen,
  preview,
  loadingPreview,
  excludingItem,
  copied,
  error,
  finished,
  closePreview,
  exclude,
  copy,
  submit,
}: ReviewSubmissionDialogProps) {
  const review =
    preview?.submission.outcome === "commented"
      ? preview.submission.review
      : null;
  const busy = finished || excludingItem !== null;

  return (
    <Dialog.Root
      open={previewOpen}
      onOpenChange={(open) => {
        if (!open) {
          closePreview();
        }
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="review-submission-backdrop" />
        <Dialog.Viewport className="review-submission-viewport">
          <Dialog.Popup className="review-submission-dialog">
            <header className="review-submission-header">
              <div>
                <Dialog.Title className="review-submission-title">
                  Submission preview
                </Dialog.Title>
                <Dialog.Description className="review-submission-description">
                  This is the exact Markdown that will be returned to Tau.
                </Dialog.Description>
              </div>
              <Button
                variant="ghost"
                iconOnly
                aria-label="Close submission preview"
                onClick={closePreview}
                disabled={finished}
              >
                <X size={16} />
              </Button>
            </header>

            <div className="review-submission-body">
              {loadingPreview ? (
                <p className="review-submission-empty">Loading preview…</p>
              ) : review !== null ? (
                <div className="review-submission-content">
                  <MarkdownContent content={review} />
                </div>
              ) : preview ? (
                <div className="review-submission-empty">
                  <strong>No comments to submit</strong>
                  <span>Submitting will approve the reviewed changes.</span>
                </div>
              ) : null}

              {preview && preview.items.length > 0 ? (
                <aside className="review-submission-items">
                  <h3>Included feedback</h3>
                  <div className="review-submission-item-list">
                    {preview.items.map((item) => (
                      <div
                        className="review-submission-item"
                        key={
                          item.kind === "thread"
                            ? `thread:${item.id}`
                            : `guide-comment:${guideCommentTargetKey(item.target)}`
                        }
                      >
                        <div>
                          <span className="review-submission-item-kind">
                            {item.kind === "thread"
                              ? "Review thread"
                              : "Guide comment"}
                          </span>
                          <span className="review-submission-item-label">
                            {item.label}
                          </span>
                        </div>
                        <Button
                          variant="ghost"
                          onClick={() => void exclude(item)}
                          disabled={busy}
                        >
                          {excludingItem === item ? "Excluding…" : "Exclude"}
                        </Button>
                      </div>
                    ))}
                  </div>
                </aside>
              ) : null}
            </div>

            {error ? (
              <p className="review-submission-error" role="alert">
                {error}
              </p>
            ) : null}

            <footer className="review-submission-footer">
              <Button onClick={closePreview} disabled={finished}>
                Back
              </Button>
              <div className="review-submission-footer-actions">
                <Button
                  onClick={() => void copy()}
                  disabled={review === null || busy}
                >
                  {copied ? <Check size={14} /> : <Copy size={14} />}
                  {copied ? "Copied" : "Copy"}
                </Button>
                <Button
                  variant="primary"
                  onClick={() => void submit()}
                  disabled={!preview || loadingPreview || busy}
                >
                  {review !== null ? "Submit" : "Approve"}
                </Button>
              </div>
            </footer>
          </Dialog.Popup>
        </Dialog.Viewport>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
