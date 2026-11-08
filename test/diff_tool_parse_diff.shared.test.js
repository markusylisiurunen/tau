import { describe, expect, it } from "vitest";
import { parseDiff } from "../src/diff_tool/app/src/features/diff/parse_diff.ts";

describe("diff tool parseDiff", () => {
  it("counts only changed lines and preserves cache-backed ids", () => {
    const patch = [
      "diff --git a/src/example.ts b/src/example.ts",
      "index 1111111..2222222 100644",
      "--- a/src/example.ts",
      "+++ b/src/example.ts",
      "@@ -1,5 +1,6 @@",
      ' import { a } from "./a";',
      "-const removed = true;",
      "+const updated = true;",
      "+const added = false;",
      " export function example() {",
      "   return updated;",
      " }",
    ].join("\n");

    const [file] = parseDiff(patch, undefined, "session-123");

    expect(file).toMatchObject({
      id: 'ck1:["patch-file","session-123","0","0"]',
      displayPath: "src/example.ts",
      newRepoPath: "src/example.ts",
      additions: 2,
      deletions: 1,
    });
  });

  it("keeps rename display paths and resolves canonical repo paths from snapshot metadata", () => {
    const patch = [
      "diff --git a/src/old.ts b/src/new.ts",
      "similarity index 100%",
      "rename from src/old.ts",
      "rename to src/new.ts",
    ].join("\n");

    const [file] = parseDiff(
      patch,
      [
        {
          path: "src/new.ts",
          status: "renamed",
          oldPath: "src/old.ts",
          newPath: "src/new.ts",
        },
      ],
      "session-rename",
    );

    expect(file).toMatchObject({
      id: 'ck1:["patch-file","session-rename","0","0"]',
      displayPath: "src/old.ts → src/new.ts",
      oldRepoPath: "src/old.ts",
      newRepoPath: "src/new.ts",
      additions: 0,
      deletions: 0,
    });
  });
});
