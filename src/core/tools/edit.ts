import type { Tool, ToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { z } from "zod";
import { buildLineDiff } from "../utils/line_diff.js";
import { formatZodError } from "../utils/zod.js";
import type { ToolActivity } from "./activity.js";
import type { ToolExecutionBackend } from "./execution_backend.js";
import { buildToolRunPresentation, type ToolCardLine } from "./presentation.js";
import {
  type AgentTool,
  createTextToolOutcome,
  executeTool,
  type ToolExecutionContext,
  type ToolExecutionOutcome,
  type ToolImplementationOutcome,
} from "./registry.js";
import { TOOL_NAME_EDIT } from "./tool_names.js";

const EDIT_DESCRIPTION = [
  "Edit a file by replacing exact text matches.",
  "Finds and replaces exactly one occurrence of oldText with newText.",
  "Fails if the file doesn't exist, if oldText is not found, or if multiple matches exist.",
].join(" ");

const EDIT_PATH_DESCRIPTION = "Single-line absolute or relative path to the file to edit.";
const EDIT_OLD_TEXT_DESCRIPTION = [
  "The exact text to find and replace, including whitespace and newlines.",
  "Must match exactly one occurrence.",
  "If multiple matches are found, you should re-attempt with a more specific oldText.",
].join(" ");
const EDIT_NEW_TEXT_DESCRIPTION = "The text to replace oldText with.";

export const EDIT_TOOL: Tool = {
  name: TOOL_NAME_EDIT,
  description: EDIT_DESCRIPTION,
  parameters: Type.Object(
    {
      path: Type.String({
        description: EDIT_PATH_DESCRIPTION,
        pattern: "^[^\\r\\n]+$",
      }),
      oldText: Type.String({ description: EDIT_OLD_TEXT_DESCRIPTION }),
      newText: Type.String({ description: EDIT_NEW_TEXT_DESCRIPTION }),
    },
    { additionalProperties: false },
  ),
};

const editArgsSchema = z
  .object({
    path: z.string(),
    oldText: z.string(),
    newText: z.string(),
  })
  .strict();

function parseEditArgs(
  raw: unknown,
):
  | { ok: true; data: { path: string; oldText: string; newText: string } }
  | { ok: false; error: string } {
  const parsed = editArgsSchema.safeParse(raw);
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
  if (!parsed.data.oldText) {
    return { ok: false, error: "oldText must not be empty." };
  }
  return { ok: true, data: { ...parsed.data, path } };
}

function getEditSubject(raw: unknown): string {
  const parsedArgs = parseEditArgs(raw);
  return parsedArgs.ok ? parsedArgs.data.path : "(invalid arguments)";
}

function countOccurrences(content: string, search: string): number {
  if (!search) return 0;
  let count = 0;
  let pos = 0;
  let index = content.indexOf(search, pos);
  while (index !== -1) {
    count++;
    pos = index + search.length;
    index = content.indexOf(search, pos);
  }
  return count;
}

function formatSignedDelta(value: number, unit: string): string {
  const prefix = value > 0 ? "+" : "";
  return `${prefix}${value} ${unit}${Math.abs(value) === 1 ? "" : "s"}`;
}

function buildEditPresentation(args: {
  subject: string;
  diffLines: string[];
  added: number;
  removed: number;
  oldLength: number;
  newLength: number;
}) {
  const details: ToolCardLine[] = args.diffLines.map((text) => {
    if (text.startsWith("+ ")) return { text, tone: "added", wrap: "character" };
    if (text.startsWith("- ")) return { text, tone: "removed", wrap: "character" };
    return { text, wrap: "character" };
  });
  return buildToolRunPresentation({
    toolName: TOOL_NAME_EDIT,
    subject: args.subject,
    details,
    detailTruncation: false,
    metadata: [
      formatSignedDelta(args.added - args.removed, "line"),
      formatSignedDelta(args.newLength - args.oldLength, "char"),
    ],
  });
}

export function createEditToolDefinition(backend: ToolExecutionBackend): AgentTool {
  return {
    schema: EDIT_TOOL,
    describe: (toolCall) => {
      const subject = getEditSubject(toolCall.arguments);
      return {
        presentation: buildToolRunPresentation({ toolName: TOOL_NAME_EDIT, subject }),
      };
    },
    async execute(
      toolCall: ToolCall,
      context: ToolExecutionContext,
    ): Promise<ToolExecutionOutcome> {
      return executeTool(context, async () => {
        const parsedArgs = parseEditArgs(toolCall.arguments);
        const path = parsedArgs.ok ? parsedArgs.data.path : "";
        const subject = getEditSubject(toolCall.arguments);

        const blocked = (
          reason: string,
          semanticOutcome: ToolExecutionOutcome["outcome"] = "blocked",
        ): ToolImplementationOutcome => {
          const outcome = createTextToolOutcome(reason, semanticOutcome);
          const uiEvent: ToolActivity = {
            type: "edit_blocked",
            toolCallId: toolCall.id,
            path: path || "(invalid path)",
            presentation: buildToolRunPresentation({
              toolName: TOOL_NAME_EDIT,
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

        const { oldText, newText } = parsedArgs.data;

        let content: string;
        try {
          const result = await backend.readFile(path);
          content = result.content;
        } catch (e) {
          const errorMessage = e instanceof Error ? e.message : String(e);
          if ((e as NodeJS.ErrnoException).code === "ENOENT") {
            return blocked(`File not found at '${path}'. Verify the path is correct.`);
          }
          return blocked(`Could not read file: ${errorMessage}`, "failed");
        }

        const matchCount = countOccurrences(content, oldText);

        if (matchCount === 0) {
          const noMatchMessage =
            "No exact match for oldText was found in the file. Read the file first to see its current content.";
          const trimmedOld = oldText.trim();
          const hasWhitespaceOnlyMismatch =
            trimmedOld !== oldText && countOccurrences(content, trimmedOld) > 0;
          return blocked(
            hasWhitespaceOnlyMismatch
              ? `${noMatchMessage} Hint: Found matches when ignoring leading/trailing whitespace.`
              : noMatchMessage,
          );
        }

        if (matchCount > 1) {
          return blocked(
            `Found ${matchCount} matches for oldText, but exactly 1 is required. Make oldText more specific to match only one location.`,
          );
        }

        const newContent = content.replace(oldText, () => newText);

        try {
          await backend.writeFile(path, newContent);

          const { lines: diffLines, added, removed } = buildLineDiff(oldText, newText);
          const outcome = createTextToolOutcome(`Successfully edited ${path}.`, "succeeded");
          const uiEvent: ToolActivity = {
            type: "edit_success",
            toolCallId: toolCall.id,
            path,
            presentation: buildEditPresentation({
              subject: subject,
              diffLines,
              added,
              removed,
              oldLength: oldText.length,
              newLength: newText.length,
            }),
          };
          return { content: outcome.content, outcome: outcome.outcome, uiEvent };
        } catch (e) {
          const errorMessage = e instanceof Error ? e.message : String(e);
          return blocked(`Could not write file: ${errorMessage}`, "failed");
        }
      });
    },
  };
}
