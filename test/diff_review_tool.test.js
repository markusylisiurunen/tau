import { describe, expect, it } from "vitest";
import { parseDiffReviewToolArgs } from "../src/core/diff_review/tool.ts";

describe("diff_review tool args", () => {
  it("accepts schema-valid extra fields that are irrelevant for the selected source", () => {
    expect(
      parseDiffReviewToolArgs({
        source: "git_diff",
        diffArgs: ["--staged"],
        patchFiles: ["/tmp/ignored.patch"],
        label: "ignored label",
      }),
    ).toEqual({
      ok: true,
      data: {
        source: { kind: "git_diff", diffArgs: ["--staged"] },
        command: "git diff --staged",
      },
    });

    expect(
      parseDiffReviewToolArgs({
        source: "patch_files",
        diffArgs: ["--staged"],
        patchFiles: ["/tmp/review.patch"],
        label: "selected hunks",
      }),
    ).toEqual({
      ok: true,
      data: {
        source: {
          kind: "patch_files",
          patchFiles: ["/tmp/review.patch"],
          scopeLabel: "selected hunks",
        },
        command: "selected hunks",
      },
    });
  });
});
