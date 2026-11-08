import { describe, expect, it } from "vitest";
import { parseDiffReviewToolArgs } from "../src/core/diff_review/tool.ts";

describe("diff_review tool args", () => {
  it.each(["git_diff", "patch_files"])("preserves the directory for %s", (source) => {
    const result = parseDiffReviewToolArgs({
      source,
      workingDirectory: "../other repo",
      ...(source === "patch_files" ? { patchFiles: ["review.patch"] } : {}),
    });
    expect(result).toMatchObject({
      ok: true,
      data: { workingDirectory: "../other repo" },
    });
  });

  it.each(["repo\nother"])("rejects invalid directories: %j", (workingDirectory) => {
    expect(parseDiffReviewToolArgs({ source: "git_diff", workingDirectory }).ok).toBe(false);
  });
});
