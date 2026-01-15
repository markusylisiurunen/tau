import type { Tool, ToolCall, ToolResultMessage } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import { z } from "zod";
import type { RiskLevel } from "../types.js";
import { createToolError, createToolResult } from "../utils/messages.js";
import {
  applyPreviewPolicy,
  buildCompactPreviewLines,
  READ_UI_MAX_LINES,
  READ_UI_MAX_TOKENS,
} from "../utils/tool_preview.js";
import { truncateMiddleForModel, truncateToBytesFromStart } from "../utils/truncate.js";
import type { ToolExecutionBackend } from "./execution_backend.js";
import type { ToolDefinition, ToolDispatchResult, ToolUiEvent, ToolUiText } from "./registry.js";

export const READ_TOOL_MAX_LINES = 4096;
export const READ_TOOL_MAX_TOKENS = 25000;
export const READ_MAX_CAPTURE_BYTES = 2 * 1024 * 1024;

const READ_DESCRIPTION = ["Read a file from the project safely."].join(" ");

const READ_PATH_DESCRIPTION = "File path to read (relative to the repo root).";
const READ_START_LINE_DESCRIPTION = "1-based inclusive start line.";
const READ_END_LINE_DESCRIPTION = "1-based inclusive end line.";

export const READ_TOOL: Tool = {
  name: "read",
  description: READ_DESCRIPTION,
  parameters: Type.Object(
    {
      path: Type.String({ description: READ_PATH_DESCRIPTION }),
      startLine: Type.Optional(
        Type.Integer({ description: READ_START_LINE_DESCRIPTION, minimum: 1 }),
      ),
      endLine: Type.Optional(Type.Integer({ description: READ_END_LINE_DESCRIPTION, minimum: 1 })),
    },
    { additionalProperties: false },
  ),
};

const readArgsSchema = z.object({
  path: z.string().trim().catch(""),
  startLine: z.number().int().positive().optional(),
  endLine: z.number().int().positive().optional(),
});

function parseReadArgs(raw: unknown): {
  path: string;
  startLine?: number;
  endLine?: number;
} {
  const parsed = readArgsSchema.safeParse(raw);
  return parsed.success ? parsed.data : { path: "" };
}

function formatRange(startLine: number, endLine: number | undefined): string {
  if (!endLine) {
    return `${startLine}-EOF`;
  }
  return `${startLine}-${endLine}`;
}

function formatReadToolResultText(args: {
  path: string;
  startLine: number;
  endLine?: number;
  content: string;
  truncation: ReturnType<typeof truncateMiddleForModel>;
}): string {
  const header = `read ${args.path} (${formatRange(args.startLine, args.endLine)})`;
  const parts: string[] = [header];

  const body = args.content.trimEnd();
  if (body) {
    parts.push("", body);
  }

  if (args.truncation.truncated) {
    parts.push(
      "",
      `truncated for model: ${args.truncation.outputLines} of ${args.truncation.totalLines} lines`,
    );
  }

  return parts.join("\n");
}

function buildReadUiText(args: {
  content: string;
  modelTruncation: ReturnType<typeof truncateMiddleForModel>;
  startLine: number;
  endLine?: number;
}): ToolUiText {
  const { content, modelTruncation, startLine, endLine } = args;
  const { truncation: previewTruncation, previewLines } = applyPreviewPolicy(
    modelTruncation.content,
    {
      maxLines: READ_UI_MAX_LINES,
      maxTokens: READ_UI_MAX_TOKENS,
      strategy: "middle",
    },
  );

  const totalLinesForSummary = modelTruncation.truncated
    ? modelTruncation.totalLines
    : previewTruncation.totalLines;
  const compactLines = buildCompactPreviewLines(previewLines, {
    totalLines: totalLinesForSummary,
    maxLines: 16,
    unitLabel: "lines",
  });
  const infoText = `${totalLinesForSummary} lines · ${formatRange(startLine, endLine)}`;
  const summaryLine = `    (${infoText})`;
  const previewText = [compactLines, summaryLine].filter(Boolean).join("\n");

  const trimmed = content.trimEnd();
  const sections: string[] = [];
  if (trimmed) {
    sections.push(trimmed);
  }
  if (modelTruncation.truncated) {
    sections.push(
      `truncated for model: ${modelTruncation.outputLines} of ${modelTruncation.totalLines} lines`,
    );
  }

  return {
    previewText,
    fullText: sections.join("\n\n"),
  };
}

export function createReadToolDefinition(backend: ToolExecutionBackend): ToolDefinition {
  return {
    schema: READ_TOOL,
    async dispatch(toolCall: ToolCall, _riskLevel: RiskLevel): Promise<ToolDispatchResult> {
      const { path, startLine, endLine } = parseReadArgs(toolCall.arguments);

      const blocked = (reason: string): ToolDispatchResult => {
        const toolResult = createToolError(toolCall, reason);
        const uiEvent: ToolUiEvent = {
          type: "read_blocked",
          path: path || "(missing path)",
          reason,
        };
        return { kind: "single", toolResult, uiEvent };
      };

      if (!path) {
        return blocked("Read tool error: missing 'path' parameter.");
      }

      if (startLine !== undefined && startLine < 1) {
        return blocked("Read tool error: startLine must be >= 1.");
      }

      if (endLine !== undefined && endLine < 1) {
        return blocked("Read tool error: endLine must be >= 1.");
      }

      if (startLine !== undefined && endLine !== undefined && endLine < startLine) {
        return blocked("Read tool error: endLine must be >= startLine.");
      }

      try {
        const { path: resolvedPath, content: rawContent } = await backend.readFile(path);

        const allLines = rawContent.split("\n");
        const totalLines = allLines.length;
        const start = startLine ?? 1;
        const end = endLine ?? totalLines;

        if (start > totalLines) {
          return blocked(
            `Read tool error: startLine (${start}) exceeds total lines (${totalLines}).`,
          );
        }

        const startIndex = Math.max(0, start - 1);
        const endIndex = Math.min(totalLines, Math.max(startIndex, end));

        let selected = allLines.slice(startIndex, endIndex).join("\n");
        if (Buffer.byteLength(selected, "utf-8") > READ_MAX_CAPTURE_BYTES) {
          selected = truncateToBytesFromStart(selected, READ_MAX_CAPTURE_BYTES);
        }

        const modelTruncation = truncateMiddleForModel(selected, {
          maxLines: READ_TOOL_MAX_LINES,
          maxTokens: READ_TOOL_MAX_TOKENS,
        });

        const toolText = formatReadToolResultText({
          path: resolvedPath,
          startLine: start,
          endLine: endLine,
          content: modelTruncation.content,
          truncation: modelTruncation,
        });

        const uiText = buildReadUiText({
          content: selected,
          modelTruncation,
          startLine: start,
          endLine,
        });

        const toolResult: ToolResultMessage = createToolResult(toolCall, toolText, false);
        const uiEvent: ToolUiEvent = {
          type: "read_success",
          path: resolvedPath,
          startLine: start,
          endLine: endLine,
          content: modelTruncation.content,
          modelTruncation: {
            truncated: modelTruncation.truncated,
            totalLines: modelTruncation.totalLines,
            outputLines: modelTruncation.outputLines,
          },
          uiText,
        };

        return { kind: "single", toolResult, uiEvent };
      } catch (e) {
        const errorMessage = e instanceof Error ? e.message : String(e);
        return blocked(`Read tool failed: ${errorMessage}`);
      }
    },
  };
}
