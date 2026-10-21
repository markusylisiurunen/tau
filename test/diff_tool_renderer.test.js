import { afterAll, expect, it } from "vitest";
import {
  DiffHunksRenderer,
  disposeHighlighter,
  preloadHighlighter,
} from "../src/diff_tool/app/node_modules/@pierre/diffs/dist/index.js";
import { parseDiff } from "../src/diff_tool/app/src/features/diff/parse_diff.ts";
import { DIFF_CODE_THEME } from "../src/diff_tool/app/src/features/diff/use_diff_renderer_ready.ts";

afterAll(async () => {
  await disposeHighlighter();
});

it("renders patch lines with the diff tool's code theme", async () => {
  const [file] = parseDiff(
    [
      "diff --git a/example.ts b/example.ts",
      "--- a/example.ts",
      "+++ b/example.ts",
      "@@ -1 +1 @@",
      "-const before = true;",
      "+const after = false;",
      "",
    ].join("\n"),
  );
  await preloadHighlighter({ themes: [DIFF_CODE_THEME], langs: ["typescript"] });
  const renderer = new DiffHunksRenderer({
    theme: DIFF_CODE_THEME,
    diffStyle: "unified",
    disableFileHeader: true,
  });
  const result = await renderer.asyncRender(file.file);

  expect(result.unifiedContentAST.length).toBeGreaterThan(0);
});
