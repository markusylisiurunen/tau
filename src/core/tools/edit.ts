import type { Tool, ToolCall } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import { z } from "zod";
import type { RiskLevel } from "../types.js";
import { buildLineDiff } from "../utils/line_diff.js";
import { createToolError, createToolSuccess } from "../utils/messages.js";
import type { ToolExecutionBackend } from "./execution_backend.js";
import type {
  ToolDefinition,
  ToolDispatchResult,
  ToolUiEvent,
  ToolUiLine,
  ToolUiText,
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
  path: z.string().trim().catch(""),
  oldText: z.string().catch(""),
  newText: z.string().catch(""),
});

function parseEditArgs(raw: unknown): { path: string; oldText: string; newText: string } {
  const parsed = editArgsSchema.safeParse(raw);
  return parsed.success ? parsed.data : { path: "", oldText: "", newText: "" };
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

export function createEditToolDefinition(backend: ToolExecutionBackend): ToolDefinition {
  return {
    schema: EDIT_TOOL,
    async dispatch(toolCall: ToolCall, riskLevel: RiskLevel): Promise<ToolDispatchResult> {
      const { path, oldText, newText } = parseEditArgs(toolCall.arguments);
      const headerTarget = path || "(missing path)";

      const blocked = (reason: string): ToolDispatchResult => {
        const toolResult = createToolError(toolCall, reason);
        const uiEvent: ToolUiEvent = {
          type: "edit_blocked",
          toolCallId: toolCall.id,
          path: path || "(missing path)",
          headerTarget,
          reason,
        };
        return { kind: "single", toolResult, uiEvent };
      };

      if (riskLevel !== "read-write") {
        return blocked(
          `requires risk level 'read-write', but current level is '${riskLevel}'. ask the user to run /risk:read-write.`,
        );
      }

      if (!path) {
        return blocked("missing 'path' parameter. provide the file path to edit.");
      }

      if (!oldText) {
        return blocked("missing 'oldText' parameter. provide the exact text to find and replace.");
      }

      let content: string;
      try {
        const result = await backend.readFile(path, { restricted: false });
        content = result.content;
      } catch (e) {
        const errorMessage = e instanceof Error ? e.message : String(e);
        if ((e as NodeJS.ErrnoException).code === "ENOENT") {
          return blocked(`file not found at '${path}'. verify the path is correct.`);
        }
        return blocked(`could not read file: ${errorMessage}`);
      }

      const matchCount = countOccurrences(content, oldText);

      if (matchCount === 0) {
        // Provide helpful context for debugging
        const trimmedOld = oldText.trim();
        const trimmedCount = trimmedOld !== oldText ? countOccurrences(content, trimmedOld) : 0;

        let hint = "";
        if (trimmedCount > 0) {
          hint =
            " hint: found matches when ignoring leading/trailing whitespace. check that your oldText exactly matches the file content including whitespace.";
        } else if (oldText.includes("\n")) {
          hint =
            " hint: your search contains newlines. ensure line endings match the file (LF vs CRLF) and indentation is exact.";
        } else {
          // Check for partial matches
          const words = oldText.split(/\s+/).filter((w) => w.length > 3);
          const partialMatches = words.filter((w) => content.includes(w));
          if (partialMatches.length > 0 && partialMatches.length < words.length) {
            hint = ` hint: some words from oldText were found ('${partialMatches.slice(0, 3).join("', '")}'), but the exact string was not. check for typos or extra whitespace.`;
          }
        }

        return blocked(
          `oldText not found in file.${hint} read the file first to see its current content.`,
        );
      }

      if (matchCount > 1) {
        const firstMatchContext = findMatchContext(content, oldText);
        return blocked(
          `found ${matchCount} matches for oldText, but exactly 1 is required. make oldText more specific to match only one location.\n\nfirst match context:\n${firstMatchContext}`,
        );
      }

      // Exactly one match -> perform the replacement
      const newContent = content.replace(oldText, () => newText);

      try {
        await backend.writeFile(path, newContent);

        const { lines: diffLines, added, removed } = buildLineDiff(oldText, newText);
        const sizeDiff = newText.length - oldText.length;
        const sizeDiffStr =
          sizeDiff === 0 ? "same size" : sizeDiff > 0 ? `+${sizeDiff} chars` : `${sizeDiff} chars`;
        const summaryLine = `successfully edited ${path}: ${oldText.length} → ${newText.length} chars (${sizeDiffStr})`;
        const statusLine = `+${added}, -${removed} · ${oldText.length} → ${newText.length} chars (${sizeDiffStr})`;

        const resultText = formatEditToolResultText({ summaryLine });

        const toolResult = createToolSuccess(toolCall, resultText);
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
        return { kind: "single", toolResult, uiEvent };
      } catch (e) {
        const errorMessage = e instanceof Error ? e.message : String(e);
        return blocked(`could not write file: ${errorMessage}`);
      }
    },
  };
}
