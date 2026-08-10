import type { Tool, ToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { z } from "zod";
import { formatTokenEstimate } from "../utils/token.js";
import { formatBytes } from "../utils/truncate.js";
import { formatZodError } from "../utils/zod.js";
import type { ToolActivity } from "./activity.js";
import type { ToolExecutionBackend } from "./execution_backend.js";
import {
  buildToolRunPresentation,
  TOOL_CARD_MAX_LINE_CHARS,
  type ToolRunPresentation,
} from "./presentation.js";
import {
  type AgentTool,
  createTextToolOutcome,
  executeTool,
  type ToolExecutionContext,
  type ToolExecutionOutcome,
  type ToolImplementationOutcome,
} from "./registry.js";
import { TOOL_NAME_WRITE } from "./tool_names.js";

const WRITE_DESCRIPTION = [
  "Write content to a file, creating the file if it doesn't exist or overwriting if it does.",
  "Creates parent directories as needed.",
].join(" ");

const WRITE_PATH_DESCRIPTION = "Single-line absolute or relative path to the file to write.";
const WRITE_CONTENT_DESCRIPTION = "The content to write to the file.";

export const WRITE_TOOL: Tool = {
  name: TOOL_NAME_WRITE,
  description: WRITE_DESCRIPTION,
  parameters: Type.Object(
    {
      path: Type.String({
        description: WRITE_PATH_DESCRIPTION,
        pattern: "^[^\\r\\n]+$",
      }),
      content: Type.String({ description: WRITE_CONTENT_DESCRIPTION }),
    },
    { additionalProperties: false },
  ),
};

const writeArgsSchema = z.object({
  path: z
    .string()
    .trim()
    .min(1)
    .refine((path) => !/[\r\n]/.test(path), "Path must be a single line."),
  content: z.string(),
});

function parseWriteArgs(
  raw: unknown,
): { ok: true; data: { path: string; content: string } } | { ok: false; error: string } {
  const parsed = writeArgsSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: formatZodError(parsed.error) };
  }
  return { ok: true, data: parsed.data };
}

function getWriteSubject(raw: unknown): string {
  const parsedArgs = parseWriteArgs(raw);
  return parsedArgs.ok ? parsedArgs.data.path : "(invalid arguments)";
}

function buildWritePresentation(args: {
  subject: string;
  bytes: number;
  lines: number;
  content: string;
}): ToolRunPresentation {
  const { subject, bytes, lines, content } = args;
  const detailText = content.replace(/\r\n?/g, "\n").trimEnd();
  return buildToolRunPresentation({
    toolName: TOOL_NAME_WRITE,
    subject,
    details: detailText
      ? detailText.split("\n").map((text) => ({ text, wrap: "character" as const }))
      : [],
    detailTruncation: {
      maxLines: 16,
      maxLineChars: TOOL_CARD_MAX_LINE_CHARS,
      strategy: "head",
    },
    metadata: [formatTokenEstimate(bytes), `${lines} ${lines === 1 ? "line" : "lines"}`],
  });
}

export function createWriteToolDefinition(backend: ToolExecutionBackend): AgentTool {
  return {
    schema: WRITE_TOOL,
    describe: (toolCall) => {
      const subject = getWriteSubject(toolCall.arguments);
      return {
        presentation: buildToolRunPresentation({ toolName: TOOL_NAME_WRITE, subject }),
      };
    },
    async execute(
      toolCall: ToolCall,
      context: ToolExecutionContext,
    ): Promise<ToolExecutionOutcome> {
      return executeTool(context, async () => {
        const parsedArgs = parseWriteArgs(toolCall.arguments);
        const path = parsedArgs.ok ? parsedArgs.data.path : "";
        const subject = getWriteSubject(toolCall.arguments);

        const blocked = (
          reason: string,
          semanticOutcome: ToolExecutionOutcome["outcome"] = "blocked",
        ): ToolImplementationOutcome => {
          const outcome = createTextToolOutcome(reason, semanticOutcome);
          const uiEvent: ToolActivity = {
            type: "write_blocked",
            toolCallId: toolCall.id,
            path: path || "(invalid path)",
            presentation: buildToolRunPresentation({
              toolName: TOOL_NAME_WRITE,
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

        const { content } = parsedArgs.data;

        try {
          const { bytes, lines } = await backend.writeFile(path, content);
          const resultText = `Successfully wrote ${formatBytes(bytes)} (${lines} lines) to ${path}`;

          const outcome = createTextToolOutcome(resultText, "succeeded");
          const uiEvent: ToolActivity = {
            type: "write_success",
            toolCallId: toolCall.id,
            path,
            presentation: buildWritePresentation({
              subject: subject,
              bytes,
              lines,
              content,
            }),
          };
          return { content: outcome.content, outcome: outcome.outcome, uiEvent };
        } catch (e) {
          const errorMessage = e instanceof Error ? e.message : String(e);
          return blocked(`Write failed: ${errorMessage}`, "failed");
        }
      });
    },
  };
}
