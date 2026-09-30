import type { Tool, ToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { z } from "zod";
import {
  isSupportedImageType,
  prepareImageForModel,
  SUPPORTED_IMAGE_TYPES,
} from "../utils/model_image.js";
import { formatZodError } from "../utils/zod.js";
import type { ToolActivity } from "./activity.js";
import { isToolExecutionBackendError, type ToolExecutionBackend } from "./execution_backend.js";
import { buildToolRunPresentation } from "./presentation.js";
import {
  type AgentTool,
  createTextToolOutcome,
  executeTool,
  type ToolExecutionContext,
  type ToolExecutionOutcome,
  type ToolImplementationOutcome,
} from "./registry.js";
import { TOOL_NAME_VIEW_IMAGE } from "./tool_names.js";

const VIEW_IMAGE_DESCRIPTION = [
  "View an image file and return it to the model.",
  "Only use this tool when the user explicitly requests viewing or analyzing an image.",
].join(" ");

const VIEW_IMAGE_PATH_DESCRIPTION = "Single-line path to the image file to view.";

const VIEW_IMAGE_READ_MAX_BYTES = 50 * 1024 * 1024;
export const VIEW_IMAGE_TOOL: Tool = {
  name: TOOL_NAME_VIEW_IMAGE,
  description: VIEW_IMAGE_DESCRIPTION,
  parameters: Type.Object(
    {
      path: Type.String({
        description: VIEW_IMAGE_PATH_DESCRIPTION,
        pattern: "^[^\\r\\n]+$",
      }),
    },
    { additionalProperties: false },
  ),
};

const viewImageArgsSchema = z.object({ path: z.string() }).strict();

function parseViewImageArgs(
  raw: unknown,
): { ok: true; data: { path: string } } | { ok: false; error: string } {
  const parsed = viewImageArgsSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: formatZodError(parsed.error) };
  }
  const path = parsed.data.path.trim();
  if (!path) {
    return { ok: false, error: "path must not be empty." };
  }
  if (/[\r\n]/.test(path)) {
    return { ok: false, error: "path must be a single line." };
  }
  return { ok: true, data: { path } };
}

function getViewImageSubject(raw: unknown): string {
  const parsedArgs = parseViewImageArgs(raw);
  return parsedArgs.ok ? parsedArgs.data.path : "(invalid arguments)";
}

export function createViewImageToolDefinition(backend: ToolExecutionBackend): AgentTool {
  return {
    schema: VIEW_IMAGE_TOOL,
    describe: (toolCall) => {
      const subject = getViewImageSubject(toolCall.arguments);
      return {
        presentation: buildToolRunPresentation({ toolName: TOOL_NAME_VIEW_IMAGE, subject }),
      };
    },
    async execute(
      toolCall: ToolCall,
      context: ToolExecutionContext,
    ): Promise<ToolExecutionOutcome> {
      return executeTool(context, async () => {
        const parsedArgs = parseViewImageArgs(toolCall.arguments);
        const path = parsedArgs.ok ? parsedArgs.data.path : "";
        const subject = getViewImageSubject(toolCall.arguments);

        const blocked = (
          reason: string,
          semanticOutcome: ToolExecutionOutcome["outcome"] = "blocked",
        ): ToolImplementationOutcome => {
          const outcome = createTextToolOutcome(reason, semanticOutcome);
          const uiEvent: ToolActivity = {
            type: "view_image_blocked",
            toolCallId: toolCall.id,
            path: path || "(invalid path)",
            presentation: buildToolRunPresentation({
              toolName: TOOL_NAME_VIEW_IMAGE,
              subject: subject,
              details: [{ text: reason }],
            }),
            reason,
          };
          return { content: outcome.content, outcome: outcome.outcome, uiEvent };
        };

        if (!parsedArgs.ok) {
          return blocked(`Invalid arguments: ${parsedArgs.error}`);
        }

        try {
          const { path: resolvedPath, content } = await backend.readFileBinary(path, {
            maxBytes: VIEW_IMAGE_READ_MAX_BYTES,
          });
          const [{ fileTypeFromBuffer }, { default: sharp }] = await Promise.all([
            import("file-type"),
            import("sharp"),
          ]);

          const detected = await fileTypeFromBuffer(content);
          const mimeType = detected?.mime;
          if (!isSupportedImageType(mimeType)) {
            return blocked(
              `Unsupported image format. Supported formats: ${SUPPORTED_IMAGE_TYPES.join(", ")}.`,
            );
          }

          const encodedImage = await prepareImageForModel(content, mimeType, sharp);
          const data = encodedImage.content.toString("base64");
          const resultText = `Successfully viewed ${resolvedPath}.`;
          const outcome: ToolExecutionOutcome = {
            content: [
              { type: "text", text: resultText },
              { type: "image", data, mimeType: encodedImage.mimeType },
            ],
            outcome: "succeeded",
          };

          const uiEvent: ToolActivity = {
            type: "view_image_success",
            toolCallId: toolCall.id,
            path: resolvedPath,
            presentation: buildToolRunPresentation({
              toolName: TOOL_NAME_VIEW_IMAGE,
              subject,
              metadata: [encodedImage.mimeType, `${encodedImage.width}×${encodedImage.height}`],
            }),
          };

          return { content: outcome.content, outcome: outcome.outcome, uiEvent };
        } catch (e) {
          const errorMessage = e instanceof Error ? e.message : String(e);
          if (isToolExecutionBackendError(e, "not-found")) {
            return blocked(`File not found at '${path}'. Verify the path is correct.`);
          }
          return blocked(`Could not view image: ${errorMessage}`, "failed");
        }
      });
    },
  };
}
