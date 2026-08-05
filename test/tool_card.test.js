import { describe, expect, it } from "vitest";
import {
  buildToolRunPresentation,
  parseToolRunPresentation,
  TOOL_CARD_MAX_LINE_CHARS,
} from "../dist/core/tools/presentation.js";
import { ToolCardComponent } from "../dist/tui/ui/tool_card.js";
import { createTagTheme, renderText } from "./ui_helpers.js";

describe("tool cards", () => {
  const theme = createTagTheme();

  it("renders multiline subjects, details, and metadata with one grammar", () => {
    const subject = [
      "node <<'NODE'",
      "console.log('line one');",
      "console.log('line two');",
      "NODE",
    ].join("\n");
    const model = {
      toolCallId: "bash-multiline",
      status: "succeeded",
      presentation: buildToolRunPresentation({
        toolName: "bash",
        subject,
        details: [{ text: "line one" }, { text: "line two" }],
        metadata: ["exit 0", "184ms", "~1 token", "2 lines"],
      }),
    };

    expect(renderText(new ToolCardComponent({ model, theme }), 120).split("\n")).toEqual([
      " <actionSuccess>✓</actionSuccess> <textMuted>ran</textMuted> <brandAccent>node <<'NODE'</brandAccent>",
      " <brandAccent>console.log('line one');</brandAccent>",
      " <brandAccent>console.log('line two');</brandAccent>",
      " <brandAccent>NODE</brandAccent>",
      " <textDim>line one</textDim>",
      " <textDim>line two</textDim>",
      " <textMuted>(exit 0 · 184ms · ~1 token · 2 lines)</textMuted>",
    ]);
  });

  it("bounds subjects and details at the producer boundary", () => {
    const presentation = buildToolRunPresentation({
      toolName: "bash",
      subject: Array.from({ length: 12 }, (_, index) => `subject ${index + 1}`).join("\n"),
      details: Array.from({ length: 12 }, (_, index) => ({ text: `detail ${index + 1}` })),
    });

    expect(presentation.subject.split("\n")).toEqual([
      "subject 1",
      "subject 2",
      "subject 3",
      "subject 4",
      "…5 more lines…",
      "subject 10",
      "subject 11",
      "subject 12",
    ]);
    expect(presentation.details.map((line) => line.text)).toEqual([
      "detail 1",
      "detail 2",
      "detail 3",
      "detail 4",
      "…5 more lines…",
      "detail 10",
      "detail 11",
      "detail 12",
    ]);

    const longLine = "x".repeat(TOOL_CARD_MAX_LINE_CHARS + 10);
    const lineBounded = buildToolRunPresentation({
      toolName: "bash",
      subject: longLine,
      details: [{ text: `first\n${longLine}` }],
    });
    expect(Array.from(lineBounded.subject)).toHaveLength(TOOL_CARD_MAX_LINE_CHARS);
    expect(lineBounded.details).toHaveLength(2);
    expect(Array.from(lineBounded.details[1].text)).toHaveLength(TOOL_CARD_MAX_LINE_CHARS);
  });

  it("rejects transported presentations outside the canonical bounds", () => {
    const presentation = buildToolRunPresentation({ toolName: "bash", subject: "echo ok" });

    expect(() =>
      parseToolRunPresentation({
        ...presentation,
        subject: Array.from({ length: 9 }, () => "line").join("\n"),
      }),
    ).toThrow();
    expect(() =>
      parseToolRunPresentation({
        ...presentation,
        details: [{ text: "two\nlines" }],
      }),
    ).toThrow();
  });
});
