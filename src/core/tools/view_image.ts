import type { Tool, ToolCall, ToolResultMessage } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import { fileTypeFromBuffer } from "file-type";
import sharp from "sharp";
import { z } from "zod";
import type { RiskLevel } from "../types.js";
import { createToolError } from "../utils/messages.js";
import { formatBytes } from "../utils/truncate.js";
import type { ToolExecutionBackend } from "./execution_backend.js";
import type { ToolDefinition, ToolDispatchResult, ToolUiEvent, ToolUiText } from "./registry.js";
import { TOOL_NAME_VIEW_IMAGE } from "./tool_names.js";

const VIEW_IMAGE_DESCRIPTION = [
  "View an image file and return it to the model.",
  "Only use this tool when the user explicitly requests viewing or analyzing an image.",
].join(" ");

const VIEW_IMAGE_PATH_DESCRIPTION = "Path to the image file to view.";

const VIEW_IMAGE_READ_MAX_BYTES = 50 * 1024 * 1024;
const VIEW_IMAGE_MODEL_MAX_BYTES = 2.5 * 1024 * 1024;
const VIEW_IMAGE_MAX_DIMENSION_PX = 2048;
const VIEW_IMAGE_DIMENSION_STEPS = [
  2048, 1920, 1792, 1664, 1536, 1408, 1280, 1152, 1024, 896, 768, 640, 512,
] as const;
const VIEW_IMAGE_LOSSY_QUALITY_STEPS = [95, 90, 85, 80, 75, 70, 65, 60] as const;
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

type ImageEncodePlan =
  | {
      mimeType: "image/jpeg";
      quality: number;
    }
  | {
      mimeType: "image/png";
    }
  | {
      mimeType: "image/webp";
      quality: number;
      lossless?: boolean;
    };

type EncodedImage = {
  content: Buffer;
  mimeType: SupportedImageType;
};

function isSupportedImageType(mimeType: string | undefined): mimeType is SupportedImageType {
  return mimeType ? SUPPORTED_IMAGE_TYPES.includes(mimeType as SupportedImageType) : false;
}

function buildDimensionCaps(maxDimension: number): number[] {
  const caps = new Set<number>([maxDimension]);
  for (const step of VIEW_IMAGE_DIMENSION_STEPS) {
    if (step < maxDimension) {
      caps.add(step);
    }
  }
  return [...caps];
}

function buildLossyEncodePlans(mimeType: "image/jpeg" | "image/webp"): ImageEncodePlan[] {
  return VIEW_IMAGE_LOSSY_QUALITY_STEPS.map((quality) => ({ mimeType, quality }));
}

function buildEncodePlans(args: {
  sourceMimeType: SupportedImageType;
  hasAlpha: boolean;
}): ImageEncodePlan[] {
  const { sourceMimeType, hasAlpha } = args;
  const plans: ImageEncodePlan[] = [];

  if (sourceMimeType === "image/png") {
    plans.push({ mimeType: "image/png" });
  } else {
    plans.push(...buildLossyEncodePlans(sourceMimeType));
  }

  if (sourceMimeType !== "image/webp") {
    plans.push({ mimeType: "image/webp", quality: 100, lossless: true });
    plans.push(...buildLossyEncodePlans("image/webp"));
  }

  if (!hasAlpha && sourceMimeType !== "image/jpeg") {
    plans.push(...buildLossyEncodePlans("image/jpeg"));
  }

  return plans;
}

async function encodeImageCandidate(args: {
  content: Buffer;
  maxDimension: number;
  plan: ImageEncodePlan;
}): Promise<EncodedImage> {
  const { content, maxDimension, plan } = args;
  const pipeline = sharp(content).resize({
    width: maxDimension,
    height: maxDimension,
    fit: "inside",
    withoutEnlargement: true,
  });

  if (plan.mimeType === "image/jpeg") {
    return {
      mimeType: "image/jpeg",
      content: await pipeline.jpeg({ quality: plan.quality }).toBuffer(),
    };
  }

  if (plan.mimeType === "image/png") {
    return {
      mimeType: "image/png",
      content: await pipeline.png({ compressionLevel: 9 }).toBuffer(),
    };
  }

  return {
    mimeType: "image/webp",
    content: await pipeline
      .webp({
        quality: plan.quality,
        lossless: plan.lossless,
      })
      .toBuffer(),
  };
}

async function prepareImageForModel(
  content: Buffer,
  sourceMimeType: SupportedImageType,
): Promise<EncodedImage> {
  const metadata = await sharp(content).metadata();
  const width = metadata.width;
  const height = metadata.height;

  if (!width || !height) {
    throw new Error("failed to read image dimensions.");
  }

  if (
    width <= VIEW_IMAGE_MAX_DIMENSION_PX &&
    height <= VIEW_IMAGE_MAX_DIMENSION_PX &&
    content.byteLength <= VIEW_IMAGE_MODEL_MAX_BYTES
  ) {
    return { content, mimeType: sourceMimeType };
  }

  const maxDimension = Math.min(VIEW_IMAGE_MAX_DIMENSION_PX, Math.max(width, height));
  const dimensionCaps = buildDimensionCaps(maxDimension);
  const encodePlans = buildEncodePlans({
    sourceMimeType,
    hasAlpha: metadata.hasAlpha ?? false,
  });

  let smallest: EncodedImage | undefined;

  for (const dimensionCap of dimensionCaps) {
    for (const plan of encodePlans) {
      const candidate = await encodeImageCandidate({
        content,
        maxDimension: dimensionCap,
        plan,
      });

      if (!smallest || candidate.content.byteLength < smallest.content.byteLength) {
        smallest = candidate;
      }

      if (candidate.content.byteLength <= VIEW_IMAGE_MODEL_MAX_BYTES) {
        return candidate;
      }
    }
  }

  const targetSizeLabel = formatBytes(VIEW_IMAGE_MODEL_MAX_BYTES);
  if (smallest) {
    throw new Error(
      `image could not be reduced below ${targetSizeLabel} (best effort produced ${formatBytes(smallest.content.byteLength)}).`,
    );
  }

  throw new Error(`image could not be reduced below ${targetSizeLabel}.`);
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

        const encodedImage = await prepareImageForModel(content, mimeType);
        const data = encodedImage.content.toString("base64");
        const resultText = `viewed ${resolvedPath} (${encodedImage.mimeType})`;
        const toolResult: ToolResultMessage = {
          role: "toolResult",
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          content: [
            { type: "text", text: resultText },
            { type: "image", data, mimeType: encodedImage.mimeType },
          ],
          isError: false,
          timestamp: Date.now(),
        };

        const uiText = buildViewImageUiText({
          mimeType: encodedImage.mimeType,
          fullText: resultText,
        });
        const uiEvent: ToolUiEvent = {
          type: "view_image_success",
          toolCallId: toolCall.id,
          path: resolvedPath,
          headerTarget: resolvedPath,
          mimeType: encodedImage.mimeType,
          bytes: encodedImage.content.byteLength,
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
