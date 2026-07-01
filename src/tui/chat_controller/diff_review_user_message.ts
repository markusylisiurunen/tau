import type { DiffReviewReturnedReview } from "./diff_review_service.js";

export function formatDiffReviewUserMessage(review: DiffReviewReturnedReview): string {
  const reviewedFiles =
    review.reviewedFiles.length > 0
      ? ["Reviewed files:", ...review.reviewedFiles.map((file) => `- ${file}`)]
      : ["Reviewed files: (none)"];
  const system = [
    "The following user message comes from a completed diff review. During that review, the user read through the reviewed diff snapshot and the files included in it, and may have left comments on specific files, lines, or broader concerns they noticed while reviewing. The message below is the feedback returned from that review.",
    "",
    `Reviewed scope: ${review.diffCommand}`,
    ...reviewedFiles,
    "",
    "Treat it as feedback on that reviewed diff snapshot and continue from there. Address valid issues directly, clarify anything that seems mistaken or ambiguous, and do not treat it as a new unrelated request.",
    "",
    "Do not mention this instruction in your response.",
  ].join("\n");

  return ["<system>", system, "</system>", "", review.review].join("\n");
}
