import { readFileSync, writeFileSync } from "node:fs";
import type { Tool, ToolCall } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import { z } from "zod";
import type { RiskLevel } from "../types.js";
import { createToolError, createToolSuccess } from "../utils/messages.js";
import type { ToolDefinition, ToolDispatchResult, ToolUiEvent } from "./registry.js";

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
  name: "edit",
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

const DIFF_MAX_LINES = 200;
const DIFF_MAX_BYTES = 40_000;

interface DiffResult {
  diff: string;
  truncation: {
    truncated: boolean;
    totalLines: number;
    outputLines: number;
  };
}

function buildSimpleDiff(oldText: string, newText: string): DiffResult {
  const oldLines = oldText.length === 0 ? ["(empty)"] : oldText.split("\n");
  const newLines = newText.length === 0 ? ["(empty)"] : newText.split("\n");

  const diffLines: string[] = [];
  for (const line of oldLines) {
    diffLines.push(`- ${line}`);
  }
  for (const line of newLines) {
    diffLines.push(`+ ${line}`);
  }

  const totalLines = diffLines.length;
  let outputLines = diffLines;
  let truncated = false;

  // Truncate by lines first
  if (outputLines.length > DIFF_MAX_LINES) {
    const headCount = Math.floor(DIFF_MAX_LINES / 2);
    const tailCount = DIFF_MAX_LINES - headCount;
    outputLines = [...outputLines.slice(0, headCount), ...outputLines.slice(-tailCount)];
    truncated = true;
  }

  let diff = outputLines.join("\n");

  // Truncate by bytes if needed
  const byteLength = Buffer.byteLength(diff, "utf-8");
  if (byteLength > DIFF_MAX_BYTES) {
    // Simple byte truncation from middle
    const lines = diff.split("\n");
    while (Buffer.byteLength(lines.join("\n"), "utf-8") > DIFF_MAX_BYTES && lines.length > 2) {
      const mid = Math.floor(lines.length / 2);
      lines.splice(mid, 1);
    }
    diff = lines.join("\n");
    truncated = true;
  }

  return {
    diff,
    truncation: {
      truncated,
      totalLines,
      outputLines: diff.split("\n").length,
    },
  };
}

function findMatchContext(content: string, search: string, contextLines: number = 2): string {
  const index = content.indexOf(search);
  if (index === -1) return "";

  const lines = content.split("\n");
  let currentPos = 0;
  let matchLineIndex = 0;

  for (let i = 0; i < lines.length; i++) {
    const lineEnd = currentPos + lines[i]!.length + 1; // +1 for newline
    if (index < lineEnd) {
      matchLineIndex = i;
      break;
    }
    currentPos = lineEnd;
  }

  const startLine = Math.max(0, matchLineIndex - contextLines);
  const endLine = Math.min(lines.length - 1, matchLineIndex + contextLines);

  const contextSnippet = lines.slice(startLine, endLine + 1).join("\n");
  return `Lines ${startLine + 1}-${endLine + 1}:\n${contextSnippet}`;
}

export function createEditToolDefinition(): ToolDefinition {
  return {
    schema: EDIT_TOOL,
    async dispatch(toolCall: ToolCall, riskLevel: RiskLevel): Promise<ToolDispatchResult> {
      const { path, oldText, newText } = parseEditArgs(toolCall.arguments);

      const blocked = (reason: string): ToolDispatchResult => {
        const toolResult = createToolError(toolCall, reason);
        const uiEvent: ToolUiEvent = {
          type: "edit_blocked",
          path: path || "(missing path)",
          reason,
        };
        return { kind: "single", toolResult, uiEvent };
      };

      if (riskLevel !== "read-write") {
        return blocked(
          `Edit tool blocked: requires risk level 'read-write', but current level is '${riskLevel}'. Ask the user to run /risk:read-write.`,
        );
      }

      if (!path) {
        return blocked("Edit tool error: missing 'path' parameter. Provide the file path to edit.");
      }

      if (!oldText) {
        return blocked(
          "Edit tool error: missing 'oldText' parameter. Provide the exact text to find and replace.",
        );
      }

      let content: string;
      try {
        content = readFileSync(path, "utf-8");
      } catch (e) {
        const errorMessage = e instanceof Error ? e.message : String(e);
        if ((e as NodeJS.ErrnoException).code === "ENOENT") {
          return blocked(
            `Edit tool error: file not found at '${path}'. Verify the path is correct.`,
          );
        }
        return blocked(`Edit tool error: could not read file: ${errorMessage}`);
      }

      const matchCount = countOccurrences(content, oldText);

      if (matchCount === 0) {
        // Provide helpful context for debugging
        const trimmedOld = oldText.trim();
        const trimmedCount = trimmedOld !== oldText ? countOccurrences(content, trimmedOld) : 0;

        let hint = "";
        if (trimmedCount > 0) {
          hint =
            " Hint: Found matches when ignoring leading/trailing whitespace. Check that your oldText exactly matches the file content including whitespace.";
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
          `Edit tool error: oldText not found in file.${hint} Read the file first to see its current content.`,
        );
      }

      if (matchCount > 1) {
        const firstMatchContext = findMatchContext(content, oldText);
        return blocked(
          `Edit tool error: found ${matchCount} matches for oldText, but exactly 1 is required. Make oldText more specific to match only one location.\n\nFirst match context:\n${firstMatchContext}`,
        );
      }

      // Exactly one match -> perform the replacement
      const newContent = content.replace(oldText, newText);

      try {
        writeFileSync(path, newContent, "utf-8");

        const oldLines = oldText.split("\n").length;
        const newLines = newText.split("\n").length;
        const lineDiff = newLines - oldLines;
        const lineDiffStr =
          lineDiff === 0 ? "" : lineDiff > 0 ? ` (+${lineDiff} lines)` : ` (${lineDiff} lines)`;

        const resultText = `Successfully edited ${path}: replaced ${oldText.length} chars with ${newText.length} chars${lineDiffStr}`;

        const { diff, truncation: diffTruncation } = buildSimpleDiff(oldText, newText);

        const toolResult = createToolSuccess(toolCall, resultText);
        const uiEvent: ToolUiEvent = {
          type: "edit_success",
          path,
          oldLength: oldText.length,
          newLength: newText.length,
          diff,
          diffTruncation,
        };
        return { kind: "single", toolResult, uiEvent };
      } catch (e) {
        const errorMessage = e instanceof Error ? e.message : String(e);
        return blocked(`Edit tool error: could not write file: ${errorMessage}`);
      }
    },
  };
}
