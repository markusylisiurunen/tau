import { formatDiffReviewReturnedReviewUserSystemMessage } from "../../core/diff_review/index.js";
import { formatTauUserText } from "../../core/utils/user_metadata.js";
import type { DiffReviewReturnedReview } from "./diff_review_service.js";

export function formatDiffReviewUserMessage(review: DiffReviewReturnedReview): string {
  return formatTauUserText({
    text: review.outcome === "approved" ? "Approved with no comments." : review.review,
    metadata: [{ type: "diff-review", version: 1 }],
    hiddenSystemMessages: [
      formatDiffReviewReturnedReviewUserSystemMessage({
        command: review.diffCommand,
        reviewedFiles: review.reviewedFiles,
        ...(review.outcome === "approved"
          ? { outcome: "approved" }
          : { outcome: "commented", review: review.review }),
      }),
    ],
  });
}
