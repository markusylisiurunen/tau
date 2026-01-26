import type { Tool, ToolCall, ToolResultMessage } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import { z } from "zod";
import type { RiskLevel } from "../types.js";
import { createToolError } from "../utils/messages.js";
import type { ToolExecutionBackend } from "./execution_backend.js";
import type { ToolDefinition, ToolDispatchResult, ToolUiEvent, ToolUiText } from "./registry.js";

const VIEW_IMAGE_DESCRIPTION = [
  "View an image file and return it to the model.",
  "Only use this tool when the user explicitly requests viewing or analyzing an image.",
].join(" ");

const VIEW_IMAGE_PATH_DESCRIPTION = "Path to the image file to view.";

const VIEW_IMAGE_MAX_BYTES = 5 * 1024 * 1024;
const SUPPORTED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;

export const VIEW_IMAGE_TOOL: Tool = {
  name: "view_image",
  description: VIEW_IMAGE_DESCRIPTION,
  parameters: Type.Object(
    {
      path: Type.String({ description: VIEW_IMAGE_PATH_DESCRIPTION }),
    },
    { additionalProperties: false },
  ),
};

const viewImageArgsSchema = z.object({
  path: z.string().trim().catch(""),
});

function parseViewImageArgs(raw: unknown): { path: string } {
  const parsed = viewImageArgsSchema.safeParse(raw);
  return parsed.success ? parsed.data : { path: "" };
}

function detectImageMime(buffer: Buffer): string | undefined {
  if (
    buffer.length >= 8 &&
    buffer[0] === 0x89 &&
    buffer[1] === 0x50 &&
    buffer[2] === 0x4e &&
    buffer[3] === 0x47 &&
    buffer[4] === 0x0d &&
    buffer[5] === 0x0a &&
    buffer[6] === 0x1a &&
    buffer[7] === 0x0a
  ) {
    return "image/png";
  }

  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
    return "image/jpeg";
  }

  if (
    buffer.length >= 12 &&
    buffer.toString("ascii", 0, 4) === "RIFF" &&
    buffer.toString("ascii", 8, 12) === "WEBP"
  ) {
    return "image/webp";
  }

  return undefined;
}

function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 bytes";
  if (bytes < 1024) return `${bytes} bytes`;
  const kb = bytes / 1024;
  if (kb < 1024) return `${kb.toFixed(kb < 10 ? 1 : 0)} KB`;
  const mb = kb / 1024;
  return `${mb.toFixed(mb < 10 ? 1 : 0)} MB`;
}

function buildViewImageUiText(args: { mimeType: string; bytes: number }): ToolUiText {
  const { mimeType, bytes } = args;
  const sizeLabel = formatBytes(bytes);
  const summary = `${sizeLabel} · ${bytes} bytes`;

  return {
    previewLines: [],
    statusLine: `(${mimeType} · ${sizeLabel})`,
    fullLines: [{ text: summary }],
  };
}

export function createViewImageToolDefinition(backend: ToolExecutionBackend): ToolDefinition {
  return {
    schema: VIEW_IMAGE_TOOL,
    async dispatch(toolCall: ToolCall, _riskLevel: RiskLevel): Promise<ToolDispatchResult> {
      const { path } = parseViewImageArgs(toolCall.arguments);

      const blocked = (reason: string): ToolDispatchResult => {
        const toolResult = createToolError(toolCall, reason);
        const uiEvent: ToolUiEvent = {
          type: "view_image_blocked",
          path: path || "(missing path)",
          reason,
        };
        return { kind: "single", toolResult, uiEvent };
      };

      if (!path) {
        return blocked("missing 'path' parameter.");
      }

      try {
        const {
          path: resolvedPath,
          content,
          bytes,
        } = await backend.readFileBinary(path, {
          maxBytes: VIEW_IMAGE_MAX_BYTES,
        });

        const mimeType = detectImageMime(content);
        if (!mimeType) {
          return blocked(
            `unsupported image format. supported: ${SUPPORTED_IMAGE_TYPES.join(", ")}.`,
          );
        }

        const data = content.toString("base64");
        const resultText = `viewed ${resolvedPath} (${mimeType}, ${bytes} bytes)`;
        const toolResult: ToolResultMessage = {
          role: "toolResult",
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          content: [
            { type: "text", text: resultText },
            { type: "image", data, mimeType },
          ],
          isError: false,
          timestamp: Date.now(),
        };

        const uiText = buildViewImageUiText({ mimeType, bytes });
        const uiEvent: ToolUiEvent = {
          type: "view_image_success",
          path: resolvedPath,
          mimeType,
          bytes,
          uiText,
        };

        return { kind: "single", toolResult, uiEvent };
      } catch (e) {
        const errorMessage = e instanceof Error ? e.message : String(e);
        return blocked(`view_image failed: ${errorMessage}`);
      }
    },
  };
}
