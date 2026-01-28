import type { Tool, ToolCall, ToolResultMessage } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import { z } from "zod";
import type { RiskLevel } from "../types.js";
import { createToolError, createToolResult } from "../utils/messages.js";
import { buildHeadTailPreviewLines } from "../utils/tool_preview.js";
import {
  type TruncationResult,
  truncateForTokens,
  truncateToBytesFromStart,
} from "../utils/truncate.js";
import type { ToolExecutionBackend } from "./execution_backend.js";
import type {
  ToolDefinition,
  ToolDispatchResult,
  ToolUiEvent,
  ToolUiLine,
  ToolUiText,
} from "./registry.js";

export const READ_TOOL_MAX_TOKENS = 8192;
export const READ_MAX_CAPTURE_BYTES = 1024 * 1024;

const READ_DESCRIPTION = ["Read a file from the project safely."].join(" ");

const READ_PATH_DESCRIPTION = "File path to read (relative to the current working directory).";
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
  truncation: TruncationResult;
  captureTruncated: boolean;
  totalLines: number;
}): string {
  const header = `read ${args.path} (${formatRange(args.startLine, args.endLine)})`;
  const parts: string[] = [header];

  const body = args.content.trimEnd();
  if (body) {
    parts.push("", body);
  }

  if (args.truncation.truncated || args.captureTruncated) {
    parts.push(
      "",
      `truncated for model: ${args.truncation.outputLines} of ${args.totalLines} lines. read smaller chunks with startLine/endLine to see more.`,
    );
  }

  return parts.join("\n");
}

function buildReadUiText(args: {
  modelTruncation: TruncationResult;
  startLine: number;
  endLine?: number;
  fullText: string;
  totalLines: number;
  captureTruncated: boolean;
}): ToolUiText {
  const { modelTruncation, startLine, endLine, fullText, totalLines, captureTruncated } = args;
  const totalLinesForSummary =
    modelTruncation.truncated || captureTruncated ? totalLines : modelTruncation.outputLines;
  const previewContentLines = buildHeadTailPreviewLines(modelTruncation.content, {
    headLines: 5,
    tailLines: 5,
  });
  const infoText = `${totalLinesForSummary} lines · ${formatRange(startLine, endLine)}`;
  const summaryLine = infoText;
  const previewLines: ToolUiLine[] = previewContentLines.map((text) => ({ text }));

  const trimmedFullText = fullText.trimEnd();
  const fullLines: ToolUiLine[] = trimmedFullText
    ? trimmedFullText.split("\n").map((text) => ({ text }))
    : [];

  return {
    previewLines,
    statusLine: summaryLine,
    fullLines,
  };
}

export function createReadToolDefinition(backend: ToolExecutionBackend): ToolDefinition {
  return {
    schema: READ_TOOL,
    async dispatch(toolCall: ToolCall, _riskLevel: RiskLevel): Promise<ToolDispatchResult> {
      const { path, startLine, endLine } = parseReadArgs(toolCall.arguments);
      const headerTarget = path || "(missing path)";

      const blocked = (reason: string): ToolDispatchResult => {
        const toolResult = createToolError(toolCall, reason);
        const uiEvent: ToolUiEvent = {
          type: "read_blocked",
          path: path || "(missing path)",
          headerTarget,
          reason,
        };
        return { kind: "single", toolResult, uiEvent };
      };

      if (!path) {
        return blocked("missing 'path' parameter.");
      }

      if (startLine !== undefined && startLine < 1) {
        return blocked("startLine must be >= 1.");
      }

      if (endLine !== undefined && endLine < 1) {
        return blocked("endLine must be >= 1.");
      }

      if (startLine !== undefined && endLine !== undefined && endLine < startLine) {
        return blocked("endLine must be >= startLine.");
      }

      try {
        const { path: resolvedPath, content: rawContent } = await backend.readFile(path);

        const allLines = rawContent.split("\n");
        const totalLines = allLines.length;
        const start = startLine ?? 1;
        const endRequested = endLine ?? totalLines;
        const endEffective = Math.min(endRequested, totalLines);
        const endDisplay = endLine === undefined ? undefined : endEffective;

        if (start > totalLines) {
          return blocked(`startLine (${start}) exceeds total lines (${totalLines}).`);
        }

        const startIndex = Math.max(0, start - 1);
        const endIndex = Math.max(startIndex, endEffective);

        const selected = allLines.slice(startIndex, endIndex).join("\n");
        const selectedLines = Math.max(0, endIndex - startIndex);
        const selectedBytes = Buffer.byteLength(selected, "utf-8");
        const captureTruncated = selectedBytes > READ_MAX_CAPTURE_BYTES;
        const captured = captureTruncated
          ? truncateToBytesFromStart(selected, READ_MAX_CAPTURE_BYTES)
          : selected;

        const modelTruncation = truncateForTokens(captured, {
          maxTokens: READ_TOOL_MAX_TOKENS,
          strategy: "head",
        });

        const toolText = formatReadToolResultText({
          path: resolvedPath,
          startLine: start,
          endLine: endDisplay,
          content: modelTruncation.content,
          truncation: modelTruncation,
          captureTruncated,
          totalLines: selectedLines,
        });

        const uiText = buildReadUiText({
          modelTruncation,
          startLine: start,
          endLine: endDisplay,
          fullText: toolText,
          totalLines: selectedLines,
          captureTruncated,
        });

        const toolResult: ToolResultMessage = createToolResult(toolCall, toolText, false);
        const uiEvent: ToolUiEvent = {
          type: "read_success",
          path: resolvedPath,
          headerTarget: resolvedPath,
          startLine: start,
          endLine: endDisplay,
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
        return blocked(`read failed: ${errorMessage}`);
      }
    },
  };
}
