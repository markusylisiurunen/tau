import type { Tool, ToolCall } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { z } from "zod";
import { buildLineDiff } from "../utils/line_diff.js";
import { formatZodError } from "../utils/zod.js";
import type { ToolExecutionBackend } from "./execution_backend.js";
import {
  type AgentTool,
  createTextToolOutcome,
  executeTool,
  type ToolExecutionContext,
  type ToolExecutionOutcome,
  type ToolImplementationOutcome,
  type ToolUiEvent,
  type ToolUiLine,
  type ToolUiText,
} from "./registry.js";
import { TOOL_NAME_EDIT } from "./tool_names.js";

const EDIT_DESCRIPTION = [
  "Edit a file by replacing exact text matches.",
  "Finds and replaces exactly one occurrence of oldText with newText.",
  "Fails if the file doesn't exist, if oldText is not found, or if multiple matches exist.",
].join(" ");

const EDIT_PATH_DESCRIPTION = "Absolute or relative path to the file to edit.";
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
      path: Type.String({ description: EDIT_PATH_DESCRIPTION }),
      oldText: Type.String({ description: EDIT_OLD_TEXT_DESCRIPTION }),
      newText: Type.String({ description: EDIT_NEW_TEXT_DESCRIPTION }),
    },
    { additionalProperties: false },
  ),
};

const editArgsSchema = z.object({
  path: z.string().trim().min(1),
  oldText: z.string().min(1),
  newText: z.string(),
});

function parseEditArgs(
  raw: unknown,
):
  | { ok: true; data: { path: string; oldText: string; newText: string } }
  | { ok: false; error: string } {
  const parsed = editArgsSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: formatZodError(parsed.error) };
  }
  return { ok: true, data: parsed.data };
}

function getEditDisplayTarget(raw: unknown): string {
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

function findMatchContext(content: string, search: string, contextLines: number = 2): string {
  const index = content.indexOf(search);
  if (index === -1) return "";

  const lines = content.split(/\r?\n/);
  const matchLineIndex = content.slice(0, index).split(/\r?\n/).length - 1;

  const startLine = Math.max(0, matchLineIndex - contextLines);
  const endLine = Math.min(lines.length - 1, matchLineIndex + contextLines);

  const contextSnippet = lines.slice(startLine, endLine + 1).join("\n");
  return `Lines ${startLine + 1}-${endLine + 1}:\n${contextSnippet}`;
}

function formatEditToolResultText(args: { summaryLine: string }): string {
  return args.summaryLine;
}

function buildEditUiText(args: {
  summaryLine: string;
  statusLine: string;
  diffLines: string[];
}): ToolUiText {
  const { summaryLine, statusLine, diffLines } = args;

  const formatLine = (line: string): ToolUiLine => {
    const text = line;
    if (line.startsWith("+ ")) return { text, tone: "diffAdd" };
    if (line.startsWith("- ")) return { text, tone: "diffRemove" };
    return { text };
  };

  const previewLines: ToolUiLine[] = diffLines.map((line) => formatLine(line));

  const fullLines: ToolUiLine[] = [{ text: summaryLine }];
  if (diffLines.length > 0) {
    fullLines.push({ text: "" }, ...diffLines.map((line) => formatLine(line)));
  }

  return {
    previewLines,
    statusLine,
    fullLines,
  };
}

export function createEditToolDefinition(backend: ToolExecutionBackend): AgentTool {
  return {
    schema: EDIT_TOOL,
    describe: (toolCall) => ({ headerTarget: getEditDisplayTarget(toolCall.arguments) }),
    async execute(
      toolCall: ToolCall,
      context: ToolExecutionContext,
    ): Promise<ToolExecutionOutcome> {
      return executeTool(context, async () => {
        const parsedArgs = parseEditArgs(toolCall.arguments);
        const path = parsedArgs.ok ? parsedArgs.data.path : "";
        const headerTarget = getEditDisplayTarget(toolCall.arguments);

        const blocked = (
          reason: string,
          semanticOutcome: ToolExecutionOutcome["outcome"] = "blocked",
        ): ToolImplementationOutcome => {
          const outcome = createTextToolOutcome(reason, semanticOutcome);
          const uiEvent: ToolUiEvent = {
            type: "edit_blocked",
            toolCallId: toolCall.id,
            path: path || "(invalid path)",
            headerTarget,
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
          // Provide helpful context for debugging
          const trimmedOld = oldText.trim();
          const trimmedCount = trimmedOld !== oldText ? countOccurrences(content, trimmedOld) : 0;

          let hint = "";
          if (trimmedCount > 0) {
            hint =
              " Hint: Found matches when ignoring leading/trailing whitespace. Check that your oldText exactly matches the file content, including whitespace.";
          } else if (oldText.includes("\n")) {
            hint =
              " Hint: Your search contains newlines. Ensure line endings match the file (LF vs CRLF) and indentation is exact.";
          } else {
            // Check for partial matches
            const words = oldText.split(/\s+/).filter((w) => w.length > 3);
            const partialMatches = words.filter((w) => content.includes(w));
            if (partialMatches.length > 0 && partialMatches.length < words.length) {
              hint = ` Hint: Some words from oldText were found ('${partialMatches.slice(0, 3).join("', '")}'), but the exact string was not. Check for typos or extra whitespace.`;
            }
          }

          return blocked(
            `No exact match for oldText was found in the file.${hint} Read the file first to see its current content.`,
          );
        }

        if (matchCount > 1) {
          const firstMatchContext = findMatchContext(content, oldText);
          return blocked(
            `Found ${matchCount} matches for oldText, but exactly 1 is required. Make oldText more specific to match only one location.\n\nFirst match context:\n${firstMatchContext}`,
          );
        }

        // Exactly one match -> perform the replacement
        const newContent = content.replace(oldText, () => newText);

        try {
          await backend.writeFile(path, newContent);

          const { lines: diffLines, added, removed } = buildLineDiff(oldText, newText);
          const sizeDiff = newText.length - oldText.length;
          const sizeDiffStr =
            sizeDiff === 0
              ? "Same size"
              : sizeDiff > 0
                ? `+${sizeDiff} chars`
                : `${sizeDiff} chars`;
          const summaryLine = `Successfully edited ${path}: ${oldText.length} → ${newText.length} chars (${sizeDiffStr})`;
          const statusLine = `+${added}, -${removed} · ${oldText.length} → ${newText.length} chars (${sizeDiffStr})`;

          const resultText = formatEditToolResultText({ summaryLine });

          const outcome = createTextToolOutcome(resultText, "succeeded");
          const uiText = buildEditUiText({ summaryLine, statusLine, diffLines });
          const uiEvent: ToolUiEvent = {
            type: "edit_success",
            toolCallId: toolCall.id,
            path,
            headerTarget,
            oldLength: oldText.length,
            newLength: newText.length,
            oldText,
            newText,
            uiText,
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
