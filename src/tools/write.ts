import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { Tool, ToolCall } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import type { RiskLevel } from "../types.js";
import { createToolError, createToolSuccess } from "../utils/messages.js";
import type { ToolDefinition, ToolDispatchResult, ToolUiEvent } from "./registry.js";

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

function parseWriteArgs(raw: unknown): { path: string; content: string } {
  const args = raw as { path?: unknown; content?: unknown } | undefined;
  const path = typeof args?.path === "string" ? args.path.trim() : "";
  const content = typeof args?.content === "string" ? args.content : "";
  return { path, content };
}

const PREVIEW_LINES = 16;

interface PreviewResult {
  preview: string;
  truncation: {
    truncated: boolean;
    totalLines: number;
    outputLines: number;
  };
}

function buildPreview(content: string): PreviewResult {
  const contentLines = content.split("\n");
  const totalLines = contentLines.length;
  const truncated = totalLines > PREVIEW_LINES;
  const previewLines = truncated ? contentLines.slice(0, PREVIEW_LINES) : contentLines;
  const preview = previewLines.join("\n");

  return {
    preview,
    truncation: {
      truncated,
      totalLines,
      outputLines: previewLines.length,
    },
  };
}

export function createWriteToolDefinition(): ToolDefinition {
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
        return { toolResult, uiEvent };
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
        const dir = dirname(path);
        if (dir && dir !== ".") {
          mkdirSync(dir, { recursive: true });
        }

        writeFileSync(path, content, "utf-8");

        const bytes = Buffer.byteLength(content, "utf-8");
        const lines = content.split("\n").length;
        const resultText = `Successfully wrote ${bytes} bytes (${lines} lines) to ${path}`;

        const { preview, truncation: previewTruncation } = buildPreview(content);

        const toolResult = createToolSuccess(toolCall, resultText);
        const uiEvent: ToolUiEvent = {
          type: "write_success",
          path,
          bytes,
          lines,
          preview,
          previewTruncation,
        };
        return { toolResult, uiEvent };
      } catch (e) {
        const errorMessage = e instanceof Error ? e.message : String(e);
        return blocked(`Write tool failed: ${errorMessage}`);
      }
    },
  };
}
