import { describe, expect, it } from "vitest";
import {
  buildToolRunPresentation,
  parseToolRunPresentation,
  TOOL_CARD_MAX_LINE_CHARS,
  TOOL_RUN_PRESENTATION_MAX_BYTES,
} from "../dist/core/tools/presentation.js";
import { createWriteToolDefinition } from "../dist/core/tools/write.js";
import {
  SESSION_PROTOCOL_MAX_CLIENT_TOOL_PRESENTATION_DETAIL_BYTES,
  SESSION_PROTOCOL_MAX_CLIENT_TOOL_PRESENTATION_DETAILS,
  SESSION_PROTOCOL_MAX_CLIENT_TOOL_PRESENTATION_SUBJECT_BYTES,
} from "../dist/protocol/session_protocol.js";

describe("tool cards", () => {
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
        if (path === "failed.txt") throw new Error("disk is full");
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
    expect(invalid.result.content).toEqual([
      { type: "text", text: "Invalid arguments: path must be a single line." },
    ]);

    const succeeded = await execute({
      id: "write-valid",
      name: "write",
      arguments: { path: "file.txt", content },
    });
    expect(succeeded.result.outcome).toBe("succeeded");
    expect(succeeded.result.content).toEqual([
      { type: "text", text: "Successfully wrote file.txt." },
    ]);
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

    const failed = await execute({
      id: "write-failed",
      name: "write",
      arguments: { path: "failed.txt", content },
    });
    expect(failed.result.outcome).toBe("failed");
    expect(failed.result.content).toEqual([
      { type: "text", text: "Could not write file: disk is full" },
    ]);
  });

  it("rejects transported presentations outside the canonical bounds", () => {
    const presentation = buildToolRunPresentation({ toolName: "bash", subject: "echo ok" });

    expect(() =>
      parseToolRunPresentation({
        ...presentation,
        subject: "x".repeat(SESSION_PROTOCOL_MAX_CLIENT_TOOL_PRESENTATION_SUBJECT_BYTES + 1),
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
    expect(() =>
      parseToolRunPresentation({
        ...presentation,
        details: [
          {
            text: "x".repeat(SESSION_PROTOCOL_MAX_CLIENT_TOOL_PRESENTATION_DETAIL_BYTES + 1),
            wrap: "word",
          },
        ],
      }),
    ).toThrow();
    expect(() =>
      parseToolRunPresentation({
        ...presentation,
        details: Array.from(
          { length: SESSION_PROTOCOL_MAX_CLIENT_TOOL_PRESENTATION_DETAILS + 1 },
          () => ({ text: "x", wrap: "word" }),
        ),
      }),
    ).toThrow();
    expect(() =>
      parseToolRunPresentation({
        ...presentation,
        details: Array.from({ length: 9 }, () => ({
          text: "x".repeat(TOOL_RUN_PRESENTATION_MAX_BYTES / 8),
          wrap: "word",
        })),
      }),
    ).toThrow();
  });
});
