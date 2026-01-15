import type { Tool, ToolCall } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import { z } from "zod";
import type { RiskLevel } from "../types.js";
import { createToolError, createToolSuccess } from "../utils/messages.js";
import { formatTokenEstimate } from "../utils/token.js";
import {
  applyPreviewPolicy,
  buildCompactPreviewLines,
  WRITE_UI_PREVIEW_LINES,
} from "../utils/tool_preview.js";
import type { ToolExecutionBackend } from "./execution_backend.js";
import type { ToolDefinition, ToolDispatchResult, ToolUiEvent, ToolUiText } from "./registry.js";

const WRITE_DESCRIPTION = [
  "Write content to a file, creating the file if it doesn't exist or overwriting if it does.",
  "Creates parent directories as needed.",
].join(" ");

const WRITE_PATH_DESCRIPTION = "Absolute or relative path to the file to write.";
const WRITE_CONTENT_DESCRIPTION = "The content to write to the file.";

export const WRITE_TOOL: Tool = {
  name: "write",
  description: WRITE_DESCRIPTION,
  parameters: Type.Object(
    {
      path: Type.String({ description: WRITE_PATH_DESCRIPTION }),
      content: Type.String({ description: WRITE_CONTENT_DESCRIPTION }),
    },
    { additionalProperties: false },
  ),
};

const writeArgsSchema = z.object({
  path: z.string().trim().catch(""),
  content: z.string().catch(""),
});

function parseWriteArgs(raw: unknown): { path: string; content: string } {
  const parsed = writeArgsSchema.safeParse(raw);
  return parsed.success ? parsed.data : { path: "", content: "" };
}

function buildWriteUiText(args: { bytes: number; lines: number; content: string }): ToolUiText {
  const { bytes, lines, content } = args;
  const { previewLines } = applyPreviewPolicy(content, {
    maxLines: WRITE_UI_PREVIEW_LINES,
    strategy: "head",
  });

  const compactLines = buildCompactPreviewLines(previewLines, {
    totalLines: lines,
    maxLines: 16,
    unitLabel: "lines",
  });
  const infoText = `${lines} lines · ${formatTokenEstimate(bytes)} · ${bytes} bytes`;
  const summaryLine = `    (${infoText})`;
  const previewText = [compactLines, summaryLine].filter(Boolean).join("\n");

  const summary = infoText;
  const trimmed = content.trimEnd();
  const fullText = trimmed ? `${summary}\n\n${trimmed}` : summary;

  return {
    previewText,
    fullText,
  };
}

export function createWriteToolDefinition(backend: ToolExecutionBackend): ToolDefinition {
  return {
    schema: WRITE_TOOL,
    async dispatch(toolCall: ToolCall, riskLevel: RiskLevel): Promise<ToolDispatchResult> {
      const { path, content } = parseWriteArgs(toolCall.arguments);

      const blocked = (reason: string): ToolDispatchResult => {
        const toolResult = createToolError(toolCall, reason);
        const uiEvent: ToolUiEvent = {
          type: "write_blocked",
          path: path || "(missing path)",
          reason,
        };
        return { kind: "single", toolResult, uiEvent };
      };

      if (riskLevel !== "read-write") {
        return blocked(
          `Write tool blocked: requires risk level 'read-write', but current level is '${riskLevel}'. Ask the user to run /risk:read-write.`,
        );
      }

      if (!path) {
        return blocked(
          "Write tool error: missing 'path' parameter. Provide the file path to write to.",
        );
      }

      try {
        const { bytes, lines } = await backend.writeFile(path, content);
        const resultText = `Successfully wrote ${bytes} bytes (${lines} lines) to ${path}`;

        const toolResult = createToolSuccess(toolCall, resultText);
        const uiText = buildWriteUiText({ bytes, lines, content });
        const uiEvent: ToolUiEvent = {
          type: "write_success",
          path,
          bytes,
          lines,
          content,
          uiText,
        };
        return { kind: "single", toolResult, uiEvent };
      } catch (e) {
        const errorMessage = e instanceof Error ? e.message : String(e);
        return blocked(`Write tool failed: ${errorMessage}`);
      }
    },
  };
}
