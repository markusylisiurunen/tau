import { afterEach, expect, it } from "vitest";
import {
  DiffHunksRenderer,
  disposeHighlighter,
  getHighlighterType,
  preloadHighlighter,
} from "../src/diff_tool/app/node_modules/@pierre/diffs/dist/index.js";
import { parseDiff } from "../src/diff_tool/app/src/features/diff/parse_diff.ts";
import {
  DIFF_CODE_THEME,
  DIFF_HIGHLIGHTER,
} from "../src/diff_tool/app/src/features/diff/use_diff_renderer_ready.ts";

afterEach(async () => {
  await disposeHighlighter();
});

function parseExample(name = "example.ts") {
  return parseDiff(
    [
      `diff --git a/${name} b/${name}`,
      `--- a/${name}`,
      `+++ b/${name}`,
      "@@ -1 +1 @@",
      "-const before = true;",
      "+const after = false;",
      "",
    ].join("\n"),
  )[0].file;
}

function descendants(nodes) {
  return nodes.flatMap((node) => [node, ...descendants(node.children ?? [])]);
}

it.each([
  ["unified", "wrap"],
  ["unified", "scroll"],
  ["split", "wrap"],
  ["split", "scroll"],
])(
  "renders highlighted %s diffs with %s overflow and comment slots",
  async (diffStyle, overflow) => {
    await preloadHighlighter({
      preferredHighlighter: DIFF_HIGHLIGHTER,
      themes: [DIFF_CODE_THEME],
      langs: ["typescript"],
    });
    expect(getHighlighterType()).toBe("highlights");
    const renderer = new DiffHunksRenderer(
      {
        preferredHighlighter: DIFF_HIGHLIGHTER,
        theme: DIFF_CODE_THEME,
        diffStyle,
        overflow,
        disableFileHeader: true,
      },
      (annotation) => annotation.side,
    );
    renderer.setLineAnnotations([
      { side: "deletions", lineNumber: 1 },
      { side: "additions", lineNumber: 1 },
    ]);
    const result = await renderer.asyncRender(parseExample());

    expect(result.preNode.properties["data-overflow"]).toBe(overflow);
    expect(result.preNode.properties["data-diff-type"]).toBe(
      diffStyle === "unified" ? "single" : "split",
    );
    for (const [side, text] of [
      ["deletions", "const before = true;"],
      ["additions", "const after = false;"],
    ]) {
      const content =
        diffStyle === "unified" ? result.unifiedContentAST : result[`${side}ContentAST`];
      const nodes = descendants(content);
      expect(
        nodes
          .filter((node) => node.type === "text")
          .map((node) => node.value)
          .join(""),
      ).toContain(text);
      const colors = new Set(
        nodes.map((node) => node.properties?.style).filter((style) => style?.startsWith("color:")),
      );
      expect(colors.size).toBeGreaterThan(1);
      expect(nodes.some((node) => node.tagName === "slot" && node.properties.name === side)).toBe(
        true,
      );
    }
    renderer.cleanUp();
  },
);

it("renders unsupported languages as text with Highlights on cold initialization", async () => {
  const renderer = new DiffHunksRenderer({
    preferredHighlighter: DIFF_HIGHLIGHTER,
    theme: DIFF_CODE_THEME,
    diffStyle: "unified",
  });
  const file = parseExample("example.unknown");
  file.lang = "abap";
  const result = await renderer.asyncRender(file);

  expect(getHighlighterType()).toBe("highlights");
  expect(
    descendants(result.unifiedContentAST)
      .filter((node) => node.type === "text")
      .map((node) => node.value)
      .join(""),
  ).toContain("const after = false;");
  renderer.cleanUp();
});
