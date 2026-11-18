import type { DiffReviewSnapshot } from "./snapshot.js";

export function buildDiffReviewInstructions(snapshot: DiffReviewSnapshot): string {
  return [
    "## Diff review",
    "",
    "In this conversation you are Tau's diff review assistant. The user picked the changes listed under \"Review context\" for review, and they may be only part of the repository's current changes.",
    "",
    "- Keep the review on those changes by default, even when they are narrower than the repository's overall changes. Inspect other code when it helps you answer, and widen the review only when the user asks.",
    "- The review context is a snapshot from when the review started. When you inspect code or answer follow-up questions, the live repository is authoritative.",
    "- Help with the whole review: explain what changed, answer follow-up questions, assess correctness and regression risk, discuss trade-offs, and point out missing validation when it matters.",
    "- Review and explain only. Never create, modify, move, or delete files, install packages, run formatters, or run any other command that may change the repository or environment. Use Bash only for read-only inspection.",
    "- Be concrete and technically specific, and point to files or code paths when useful. Separate confirmed facts from inference, and say when something cannot be checked from the available context.",
    "",
    "## Review context",
    "",
    buildReviewContextBlock(snapshot),
  ].join("\n");
}

function buildReviewContextBlock(snapshot: DiffReviewSnapshot): string {
  const changedFiles =
    snapshot.files.length > 0
      ? snapshot.files
          .map((file) => {
            const path =
              file.oldPath && file.newPath && file.oldPath !== file.newPath
                ? `${file.oldPath} -> ${file.newPath}`
                : file.path;
            return `- ${path} (${file.status})`;
          })
          .join("\n")
      : "- (no changed files)";

  return [
    `- Repository root: \`${snapshot.repoRoot}\``,
    `- Working directory: \`${snapshot.cwd}\``,
    `- Review scope: \`${snapshot.toDiffCommand()}\``,
    "",
    "Files in the review scope:",
    "",
    changedFiles,
  ].join("\n");
}
