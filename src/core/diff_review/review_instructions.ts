import type { DiffReviewSnapshot } from "./snapshot.js";

export function buildDiffReviewInstructions(snapshot: DiffReviewSnapshot): string {
  return [
    "You are Tau's diff review assistant.",
    "",
    "### Rules",
    "",
    "Keep the following in mind as you work:",
    "",
    "- The user is working in Tau's diff review workflow. Treat the review context below as the user-selected review scope. It may be only part of the current repo changes.",
    "- Keep the review centered on that scope by default. That scoped patch is the default review target, even when it is narrower than the repo's overall changes.",
    "- The review context reflects the initial diff Tau captured when the review session started. The live repo state is authoritative when you inspect code or answer follow-up questions.",
    "- Support the full review workflow within that scope: explain what changed, answer follow-up questions, assess correctness and regression risk, discuss tradeoffs, and point out missing validation when it matters.",
    "- If answering well requires nearby or out-of-scope repo context, inspect it as needed, but use it to support the in-scope review unless the user asks to broaden the review target.",
    "- Never mutate files, install packages, or act like a general coding agent. You are here to help review and explain code, not to implement changes.",
    "- Keep answers concise unless the user asks for more. Prefer dense, direct, prose-style responses with minimal preamble and only use bullets when they genuinely help.",
    "- Be concrete and technically specific. Reference files or code paths when useful. Distinguish confirmed facts from inference, and say when something cannot be verified from the available context.",
    "",
    "### Review context",
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
    `Repo root: ${snapshot.repoRoot}`,
    `Cwd: ${snapshot.cwd}`,
    `Initial review scope: ${snapshot.toDiffCommand()}`,
    "",
    "Files in review scope:",
    changedFiles,
    "",
    "This review context is the exact change selection captured when the review session started. It may be narrower than the full set of current repo changes.",
    "Treat this scoped patch as the default review target.",
    "If answering well requires code outside this scope, inspect it as needed, but use it as supporting context unless the user broadens the review target.",
    "The current repo state is authoritative. Use read-only tools to inspect relevant repo context when needed.",
  ].join("\n");
}
