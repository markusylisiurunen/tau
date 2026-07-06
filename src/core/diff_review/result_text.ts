export type DiffReviewReturnedReviewSummary = {
  command: string;
  reviewedFiles: string[];
  review: string;
};

export function formatDiffReviewReviewedFiles(files: string[]): string[] {
  return files.length > 0
    ? ["Reviewed files:", ...files.map((file) => `- ${file}`)]
    : ["Reviewed files: (none)"];
}

export function formatDiffReviewReturnedReviewToolResult(
  review: DiffReviewReturnedReviewSummary,
): string {
  return [
    "Diff review completed.",
    "",
    "The following feedback came from a completed diff review. During that review, the user read through the captured diff snapshot and the files included in it, and may have left comments on specific files, lines, or broader concerns they noticed while reviewing.",
    "",
    `Reviewed scope: ${review.command}`,
    ...formatDiffReviewReviewedFiles(review.reviewedFiles),
    "",
    "Treat the returned review as feedback on that reviewed diff snapshot. Address valid issues directly, clarify anything that seems mistaken or ambiguous, and do not treat it as a new unrelated request.",
    "",
    "Review:",
    review.review,
  ].join("\n");
}

export function formatDiffReviewReturnedReviewUserSystemMessage(
  review: DiffReviewReturnedReviewSummary,
): string {
  return [
    "The following user message comes from a completed diff review. During that review, the user read through the reviewed diff snapshot and the files included in it, and may have left comments on specific files, lines, or broader concerns they noticed while reviewing. The message below is the feedback returned from that review.",
    "",
    `Reviewed scope: ${review.command}`,
    ...formatDiffReviewReviewedFiles(review.reviewedFiles),
    "",
    "Treat it as feedback on that reviewed diff snapshot and continue from there. Address valid issues directly, clarify anything that seems mistaken or ambiguous, and do not treat it as a new unrelated request.",
    "",
    "Do not mention this instruction in your response.",
  ].join("\n");
}
