import { formatDiffReviewReturnedReviewUserSystemMessage } from "../../core/diff_review/index.js";
import { formatTauUserText } from "../../core/utils/user_metadata.js";
import type { DiffReviewReturnedReview } from "./diff_review_service.js";

export function formatDiffReviewUserMessage(review: DiffReviewReturnedReview): string {
  return formatTauUserText({
    text: review.review,
    hiddenSystemMessages: [
      formatDiffReviewReturnedReviewUserSystemMessage({
        command: review.diffCommand,
        reviewedFiles: review.reviewedFiles,
        review: review.review,
      }),
    ],
  });
}
