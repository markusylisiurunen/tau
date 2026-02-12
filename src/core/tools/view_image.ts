import type { Tool, ToolCall, ToolResultMessage } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import { fileTypeFromBuffer } from "file-type";
import sharp from "sharp";
import { z } from "zod";
import type { RiskLevel } from "../types.js";
import { createToolError } from "../utils/messages.js";
import type { ToolExecutionBackend } from "./execution_backend.js";
import type { ToolDefinition, ToolDispatchResult, ToolUiEvent, ToolUiText } from "./registry.js";
import { TOOL_NAME_VIEW_IMAGE } from "./tool_names.js";

const VIEW_IMAGE_DESCRIPTION = [
  "View an image file and return it to the model.",
  "Only use this tool when the user explicitly requests viewing or analyzing an image.",
].join(" ");

const VIEW_IMAGE_PATH_DESCRIPTION = "Path to the image file to view.";

const VIEW_IMAGE_READ_MAX_BYTES = 50 * 1024 * 1024;
const VIEW_IMAGE_MAX_DIMENSION_PX = 2048;
const SUPPORTED_IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp"] as const;

export const VIEW_IMAGE_TOOL: Tool = {
  name: TOOL_NAME_VIEW_IMAGE,
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

type SupportedImageType = (typeof SUPPORTED_IMAGE_TYPES)[number];

function isSupportedImageType(mimeType: string | undefined): mimeType is SupportedImageType {
  return mimeType ? SUPPORTED_IMAGE_TYPES.includes(mimeType as SupportedImageType) : false;
}

async function downscaleImageForModel(
  content: Buffer,
  mimeType: SupportedImageType,
): Promise<Buffer> {
  const metadata = await sharp(content).metadata();
  const width = metadata.width;
  const height = metadata.height;

  if (!width || !height) {
    throw new Error("failed to read image dimensions.");
  }

  if (width <= VIEW_IMAGE_MAX_DIMENSION_PX && height <= VIEW_IMAGE_MAX_DIMENSION_PX) {
    return content;
  }

  const pipeline = sharp(content).resize({
    width: VIEW_IMAGE_MAX_DIMENSION_PX,
    height: VIEW_IMAGE_MAX_DIMENSION_PX,
    fit: "inside",
    withoutEnlargement: true,
  });

  if (mimeType === "image/jpeg") {
    return pipeline.jpeg({ quality: 90 }).toBuffer();
  }

  if (mimeType === "image/png") {
    return pipeline.png({ compressionLevel: 9 }).toBuffer();
  }

  return pipeline.webp({ quality: 90 }).toBuffer();
}

function buildViewImageUiText(args: { mimeType: string; fullText: string }): ToolUiText {
  const { mimeType, fullText } = args;
  const trimmedFullText = fullText.trimEnd();
  const fullLines = trimmedFullText
    ? trimmedFullText.split("\n").map((text) => ({ text }))
    : [{ text: mimeType }];

  return {
    previewLines: [],
    statusLine: mimeType,
    fullLines,
  };
}

export function createViewImageToolDefinition(backend: ToolExecutionBackend): ToolDefinition {
  return {
    schema: VIEW_IMAGE_TOOL,
    async dispatch(toolCall: ToolCall, _riskLevel: RiskLevel): Promise<ToolDispatchResult> {
      const { path } = parseViewImageArgs(toolCall.arguments);
      const headerTarget = path || "(missing path)";

      const blocked = (reason: string): ToolDispatchResult => {
        const toolResult = createToolError(toolCall, reason);
        const uiEvent: ToolUiEvent = {
          type: "view_image_blocked",
          toolCallId: toolCall.id,
          path: path || "(missing path)",
          headerTarget,
          reason,
        };
        return { kind: "single", toolResult, uiEvent };
      };

      if (!path) {
        return blocked("missing 'path' parameter.");
      }

      try {
        const { path: resolvedPath, content } = await backend.readFileBinary(path, {
          maxBytes: VIEW_IMAGE_READ_MAX_BYTES,
        });

        const detected = await fileTypeFromBuffer(content);
        const mimeType = detected?.mime;
        if (!isSupportedImageType(mimeType)) {
          return blocked(
            `unsupported image format. supported: ${SUPPORTED_IMAGE_TYPES.join(", ")}.`,
          );
        }

        const resizedContent = await downscaleImageForModel(content, mimeType);
        const data = resizedContent.toString("base64");
        const resultText = `viewed ${resolvedPath} (${mimeType})`;
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

        const uiText = buildViewImageUiText({ mimeType, fullText: resultText });
        const uiEvent: ToolUiEvent = {
          type: "view_image_success",
          toolCallId: toolCall.id,
          path: resolvedPath,
          headerTarget: resolvedPath,
          mimeType,
          bytes: resizedContent.byteLength,
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
