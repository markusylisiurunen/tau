import { describe, expect, it } from "vitest";
import { buildDiffReviewSystemPrompt } from "../src/core/diff_review/review_thread.ts";
import { DiffReviewSnapshot, formatDiffReviewScope } from "../src/core/diff_review/snapshot.ts";

describe("diff_review prompt", () => {
  it("wraps the main persona prompt and embeds review context in the system prompt", () => {
    const snapshot = new DiffReviewSnapshot({
      repoRoot: "/repo",
      cwd: "/repo",
      diffArgs: ["--staged"],
      patch: "diff --git a/src/a.ts b/src/a.ts",
      files: [
        { path: "src/a.ts", status: "modified", newPath: "src/a.ts" },
        { path: "src/old.ts", status: "renamed", oldPath: "src/old.ts", newPath: "src/new.ts" },
      ],
      patchByPath: new Map([["src/a.ts", "diff --git a/src/a.ts b/src/a.ts"]]),
      scopeLabel: formatDiffReviewScope(["--staged"]),
    });
    const prompt = buildDiffReviewSystemPrompt("Be careful and precise.", snapshot);

    expect(prompt).toContain("You are Tau's diff review assistant.");
    expect(prompt).toContain(
      "<inherited-instructions>\nBe careful and precise.\n</inherited-instructions>",
    );
    expect(prompt).toContain(
      "Treat the review context below as the user-selected review scope. It may be only part of the current repo changes.",
    );
    expect(prompt).toContain(
      "Keep the review centered on that scope by default. That scoped patch is the default review target, even when it is narrower than the repo's overall changes.",
    );
    expect(prompt).toContain(
      "The review context reflects the initial diff Tau captured when the review session started.",
    );
    expect(prompt).toContain(
      "Keep answers concise unless the user asks for more. Prefer dense, direct, prose-style responses",
    );
    expect(prompt).toContain("### Review context");
    expect(prompt).toContain("Repo root: /repo");
    expect(prompt).toContain("Initial review scope: git diff --staged");
    expect(prompt).toContain("Files in review scope:");
    expect(prompt).toContain(
      "This review context is the exact change selection captured when the review session started. It may be narrower than the full set of current repo changes.",
    );
    expect(prompt).toContain("Treat this scoped patch as the default review target.");
    expect(prompt).toContain(
      "If answering well requires code outside this scope, inspect it as needed, but use it as supporting context unless the user broadens the review target.",
    );
    expect(prompt).toContain("- src/old.ts -> src/new.ts (renamed)");
  });
});
