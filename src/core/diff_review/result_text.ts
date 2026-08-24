type DiffReviewReturnedReviewScope = {
  command: string;
  reviewedFiles: string[];
};

export type DiffReviewReturnedReviewSummary = DiffReviewReturnedReviewScope &
  (
    | { outcome: "approved" }
    | {
        outcome: "commented";
        review: string;
      }
  );

export function formatDiffReviewReviewedFiles(files: string[]): string[] {
  return files.length > 0
    ? ["Reviewed files:", ...files.map((file) => `- ${file}`)]
    : ["Reviewed files: (none)"];
}

export function formatDiffReviewReturnedReviewToolResult(
  review: DiffReviewReturnedReviewSummary,
): string {
  const context = [
    "Diff review completed.",
    "",
    `Reviewed scope: ${review.command}`,
    ...formatDiffReviewReviewedFiles(review.reviewedFiles),
  ];
  if (review.outcome === "approved") {
    return [...context, "", "The user approved the reviewed diff without comments."].join("\n");
  }

  return [
    ...context,
    "",
    "The following feedback came from a completed diff review. During that review, the user read through the captured diff snapshot and the files included in it, and left comments on specific files, lines, or broader concerns they noticed while reviewing.",
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
  const outcome =
    review.outcome === "approved"
      ? "The user approved the reviewed diff without comments."
      : "The message below is the feedback returned from that review.";
  return [
    "The following user message comes from a completed diff review. During that review, the user read through the reviewed diff snapshot and the files included in it.",
    outcome,
    "",
    `Reviewed scope: ${review.command}`,
    ...formatDiffReviewReviewedFiles(review.reviewedFiles),
    "",
    "Treat it as feedback on that reviewed diff snapshot and continue from there. Address valid issues directly, clarify anything that seems mistaken or ambiguous, and do not treat it as a new unrelated request.",
    "",
    "Do not mention this instruction in your response.",
  ].join("\n");
}
