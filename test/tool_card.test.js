import { describe, expect, it } from "vitest";
import {
  buildToolRunPresentation,
  parseToolRunPresentation,
  TOOL_CARD_MAX_LINE_CHARS,
} from "../dist/core/tools/presentation.js";
import { createWriteToolDefinition } from "../dist/core/tools/write.js";
import { createUiTheme } from "../dist/tui/ui/theme/index.js";
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
      " <bold><actionSuccess>✓</actionSuccess></bold> <textMuted>ran</textMuted> <brandAccent>node <<'NODE'</brandAccent>",
      " <brandAccent>console.log('line one');</brandAccent>",
      " <brandAccent>console.log('line two');</brandAccent>",
      " <brandAccent>NODE</brandAccent>",
      " <textDim>line one</textDim>",
      " <textDim>line two</textDim>",
      " <textMuted>(exit 0 · 184ms · ~1 token · 2 lines)</textMuted>",
    ]);
  });

  it("wraps bash and code-mode subjects at character boundaries", () => {
    const bashPresentation = buildToolRunPresentation({
      toolName: "bash",
      subject: "echo alpha beta",
    });
    const webPresentation = buildToolRunPresentation({
      toolName: "web",
      operation: "web",
      subject: "console.log('alpha beta')",
    });
    const writePresentation = buildToolRunPresentation({
      toolName: "write",
      subject: "alpha beta gamma",
    });
    const spawnPresentation = buildToolRunPresentation({
      toolName: "spawn_agent",
      subject: "alpha beta gamma",
    });

    expect(bashPresentation.subjectWrap).toBe("character");
    expect(webPresentation.subjectWrap).toBe("character");
    expect(writePresentation.subjectWrap).toBe("character");
    expect(spawnPresentation.subjectWrap).toBe("word");
    expect(
      renderText(
        new ToolCardComponent({
          model: { toolCallId: "bash-wrap", status: "succeeded", presentation: bashPresentation },
          theme: createUiTheme("plain"),
        }),
        16,
      ).split("\n"),
    ).toEqual([" ✓ ran echo alph", " a beta"]);

    expect(
      renderText(
        new ToolCardComponent({
          model: { toolCallId: "web-wrap", status: "running", presentation: webPresentation },
          theme: createUiTheme("plain"),
        }),
        22,
      ).split("\n"),
    ).toEqual([" » running web console", " .log('alpha beta')"]);
  });

  it("uses the prefix width only on the first word-wrapped subject line", () => {
    const presentation = buildToolRunPresentation({
      toolName: "spawn_agent",
      subject: "alpha beta gamma delta",
    });

    expect(
      renderText(
        new ToolCardComponent({
          model: { toolCallId: "word-wrap", status: "succeeded", presentation },
          theme: createUiTheme("plain"),
        }),
        20,
      ).split("\n"),
    ).toEqual([" ✓ spawned alpha", " beta gamma delta"]);
  });

  it("wraps character-mode details without seeking word boundaries", () => {
    const presentation = buildToolRunPresentation({
      toolName: "custom",
      subject: "x",
      details: [{ text: "alpha beta gamma", wrap: "character" }],
    });
    const rendered = renderText(
      new ToolCardComponent({
        model: { toolCallId: "detail-wrap", status: "succeeded", presentation },
        theme: createUiTheme("plain"),
      }),
      8,
    ).split("\n");

    expect(rendered).toEqual(expect.arrayContaining([" alpha b", " eta gam", " ma"]));
  });

  it("renders an explicit operation between the lifecycle action and subject", () => {
    const model = {
      toolCallId: "web",
      status: "running",
      presentation: buildToolRunPresentation({
        toolName: "web",
        operation: "web",
        subject: "console.log('ok')",
      }),
    };

    expect(renderText(new ToolCardComponent({ model, theme }), 160)).toContain(
      "<textMuted>running web</textMuted> <brandAccent>console.log('ok')</brandAccent>",
    );
  });

  it("uses static active markers with status-specific colors", () => {
    const presentation = buildToolRunPresentation({ toolName: "bash", subject: "pwd" });
    const cases = [
      { status: "streaming", marker: "◌", color: "textMuted" },
      { status: "queued", marker: "○", color: "textMuted" },
      { status: "running", marker: "»", color: "actionRunning" },
    ];

    for (const { status, marker, color } of cases) {
      const rendered = renderText(
        new ToolCardComponent({
          model: { toolCallId: status, status, presentation },
          theme,
        }),
        120,
      );
      expect(rendered).toContain(`<${color}>${marker}</${color}>`);
    }
  });

  it("preserves edit addition and removal colors", () => {
    const model = {
      toolCallId: "edit",
      status: "succeeded",
      presentation: buildToolRunPresentation({
        toolName: "edit",
        subject: "file.txt",
        details: [
          { text: "- old", tone: "removed" },
          { text: "+ new", tone: "added" },
          { text: "  same" },
        ],
      }),
    };
    const rendered = renderText(new ToolCardComponent({ model, theme }), 120);
    expect(rendered).toContain("<diffRemove>- old</diffRemove>");
    expect(rendered).toContain("<diffAdd>+ new</diffAdd>");
    expect(rendered).toContain("<textDim>  same</textDim>");
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
      "…6 more lines…",
      "detail 10",
      "detail 11",
      "detail 12",
    ]);

    const exactDetails = buildToolRunPresentation({
      toolName: "bash",
      subject: "echo test",
      details: Array.from({ length: 7 }, (_, index) => ({ text: `detail ${index + 1}` })),
    });
    expect(exactDetails.details.map((line) => line.text)).toEqual([
      "detail 1",
      "detail 2",
      "detail 3",
      "detail 4",
      "detail 5",
      "detail 6",
      "detail 7",
    ]);

    const customDetails = buildToolRunPresentation({
      toolName: "bash",
      subject: "echo test",
      details: Array.from({ length: 4 }, (_, index) => ({
        text: `detail ${index + 1} with long content`,
      })),
      detailTruncation: { maxLines: 3, maxLineChars: 8, strategy: "middle" },
    });
    expect(customDetails.details.map((line) => line.text)).toEqual([
      "detail …",
      "…2 more…",
      "detail …",
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

    const completeDetails = buildToolRunPresentation({
      toolName: "edit",
      subject: "file.txt",
      details: Array.from({ length: 20 }, (_, index) => ({
        text: index === 10 ? longLine : `detail ${index + 1}`,
      })),
      detailTruncation: false,
    });
    expect(completeDetails.details).toHaveLength(20);
    expect(completeDetails.details[10].text).toBe(longLine);
  });

  it("uses a head-only write preview and enforces single-line paths", async () => {
    const content = Array.from({ length: 17 }, (_, index) => `line ${index + 1}`).join("\n");
    const bytes = Buffer.byteLength(content, "utf8");
    const tool = createWriteToolDefinition({
      async writeFile(path, writtenContent) {
        return { path, bytes: Buffer.byteLength(writtenContent, "utf8"), lines: 17 };
      },
    });
    const execute = async (toolCall) => {
      const activities = [];
      const result = await tool.execute(toolCall, {
        agentId: "agent",
        turnId: "turn",
        assistantMessageId: "message",
        signal: new AbortController().signal,
        emitActivity: async (activity) => activities.push(activity),
      });
      return { result, uiEvent: activities.at(-1) };
    };

    expect(tool.schema.parameters.properties.path.pattern).toBe("^[^\\r\\n]+$");

    const invalid = await execute({
      id: "write-invalid",
      name: "write",
      arguments: { path: "one\ntwo", content },
    });
    expect(invalid.result.outcome).toBe("blocked");
    expect(invalid.uiEvent.presentation.details[0].text).toContain("single line");

    const succeeded = await execute({
      id: "write-valid",
      name: "write",
      arguments: { path: "file.txt", content },
    });
    expect(succeeded.result.outcome).toBe("succeeded");
    expect(succeeded.uiEvent.presentation.details.map((line) => line.text)).toEqual([
      ...Array.from({ length: 15 }, (_, index) => `line ${index + 1}`),
      "…2 more lines…",
    ]);
    expect(succeeded.uiEvent.presentation.details.map((line) => line.wrap)).toEqual([
      ...Array.from({ length: 15 }, () => "character"),
      "word",
    ]);
    expect(succeeded.uiEvent.presentation.metadata).toEqual([
      `~${Math.floor(bytes / 6)} tokens`,
      "17 lines",
    ]);
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
    expect(
      parseToolRunPresentation({
        ...presentation,
        details: [{ text: "x".repeat(TOOL_CARD_MAX_LINE_CHARS + 1), wrap: "word" }],
      }).details[0].text,
    ).toHaveLength(TOOL_CARD_MAX_LINE_CHARS + 1);
  });
});
