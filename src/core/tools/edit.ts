import type { Tool, ToolCall } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import { z } from "zod";
import type { RiskLevel } from "../types.js";
import { createToolError, createToolSuccess } from "../utils/messages.js";
import { EDIT_DIFF_MAX_LINES, EDIT_DIFF_MAX_TOKENS, truncateForUi } from "../utils/tool_preview.js";
import type { ToolExecutionBackend } from "./execution_backend.js";
import type { ToolDefinition, ToolDispatchResult, ToolUiEvent, ToolUiText } from "./registry.js";

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

interface DiffTruncation {
  truncated: boolean;
  totalLines: number;
  outputLines: number;
}

interface DiffResult {
  diff: string;
  truncation: DiffTruncation;
  added: number;
  removed: number;
}

function* iterateTextLinesForDiff(text: string): Iterable<string> {
  if (text.length === 0) return;

  let start = 0;
  while (true) {
    const idx = text.indexOf("\n", start);
    if (idx === -1) {
      yield text.slice(start);
      break;
    }
    yield text.slice(start, idx);
    start = idx + 1;
    if (start === text.length) {
      yield "";
      break;
    }
  }
}

function buildSimpleDiff(oldText: string, newText: string): DiffResult {
  const safeMaxLines = Math.max(1, EDIT_DIFF_MAX_LINES);
  const headCount = Math.floor(safeMaxLines / 2);
  const tailCount = safeMaxLines - headCount;

  let totalLines = 0;
  let added = 0;
  let removed = 0;

  let allLines: string[] | undefined = [];
  const headLines: string[] = [];

  const tailBuffer = tailCount > 0 ? new Array<string>(tailCount) : [];
  let tailSize = 0;
  let tailPos = 0;

  const handleLine = (line: string): void => {
    totalLines++;

    if (allLines) {
      allLines.push(line);
      if (allLines.length > safeMaxLines) {
        allLines = undefined;
      }
    }

    if (headLines.length < headCount) {
      headLines.push(line);
    }

    if (tailCount > 0) {
      tailBuffer[tailPos] = line;
      tailPos = (tailPos + 1) % tailCount;
      tailSize = Math.min(tailSize + 1, tailCount);
    }
  };

  for (const line of iterateTextLinesForDiff(oldText)) {
    removed++;
    handleLine(`- ${line}`);
  }

  for (const line of iterateTextLinesForDiff(newText)) {
    added++;
    handleLine(`+ ${line}`);
  }

  if (totalLines === 0) {
    return {
      diff: "",
      truncation: {
        truncated: false,
        totalLines: 0,
        outputLines: 0,
      },
      added,
      removed,
    };
  }

  const truncatedByLines = totalLines > safeMaxLines;

  let diffCandidate: string;
  if (!truncatedByLines) {
    diffCandidate = (allLines ?? []).join("\n");
  } else {
    const tailLines: string[] = [];
    for (let i = 0; i < tailSize; i++) {
      const idx = (tailPos - tailSize + i + tailCount) % tailCount;
      tailLines.push(tailBuffer[idx]!);
    }
    diffCandidate = [...headLines, ...tailLines].join("\n");
  }

  const display = truncateForUi(diffCandidate, {
    maxLines: Math.min(totalLines, safeMaxLines),
    maxTokens: EDIT_DIFF_MAX_TOKENS,
    strategy: "middle",
  });

  const truncated = truncatedByLines || display.truncated;

  return {
    diff: display.content,
    truncation: {
      truncated,
      totalLines,
      outputLines: display.outputLines,
    },
    added,
    removed,
  };
}

function buildFullDiffLines(oldText: string, newText: string): string[] {
  const lines: string[] = [];
  for (const line of iterateTextLinesForDiff(oldText)) {
    lines.push(`- ${line}`);
  }
  for (const line of iterateTextLinesForDiff(newText)) {
    lines.push(`+ ${line}`);
  }
  return lines;
}

function buildEditUiText(args: {
  oldLength: number;
  newLength: number;
  oldText: string;
  newText: string;
}): ToolUiText {
  const { oldLength, newLength, oldText, newText } = args;
  const { diff, truncation, added, removed } = buildSimpleDiff(oldText, newText);
  const diffLines = diff ? diff.split("\n") : [];

  const compactLines: string[] = diffLines.map((line) => `    ${line}`);
  if (truncation.truncated) {
    compactLines.push(
      `    ◆ truncated: ${truncation.outputLines} of ${truncation.totalLines} lines`,
    );
  }

  const sizeDiff = newLength - oldLength;
  const diffStr =
    sizeDiff === 0 ? "same size" : sizeDiff > 0 ? `+${sizeDiff} chars` : `${sizeDiff} chars`;
  const summaryLine = `replaced ${oldLength} → ${newLength} chars (${diffStr})`;
  const statusLine = `    (+${added}, -${removed}) · ${summaryLine}`;

  const fullDiffLines = buildFullDiffLines(oldText, newText);
  const fullText =
    fullDiffLines.length > 0 ? `${summaryLine}\n\n${fullDiffLines.join("\n")}` : summaryLine;

  return {
    previewText: compactLines.join("\n"),
    statusLine,
    fullText,
  };
}

export function createEditToolDefinition(backend: ToolExecutionBackend): ToolDefinition {
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
        const result = await backend.readFile(path, { restricted: false });
        content = result.content;
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
        await backend.writeFile(path, newContent);

        const oldLines = oldText.split("\n").length;
        const newLines = newText.split("\n").length;
        const lineDiff = newLines - oldLines;
        const lineDiffStr =
          lineDiff === 0 ? "" : lineDiff > 0 ? ` (+${lineDiff} lines)` : ` (${lineDiff} lines)`;

        const resultText = `Successfully edited ${path}: replaced ${oldText.length} chars with ${newText.length} chars${lineDiffStr}`;

        const toolResult = createToolSuccess(toolCall, resultText);
        const uiText = buildEditUiText({
          oldLength: oldText.length,
          newLength: newText.length,
          oldText,
          newText,
        });
        const uiEvent: ToolUiEvent = {
          type: "edit_success",
          path,
          oldLength: oldText.length,
          newLength: newText.length,
          oldText,
          newText,
          uiText,
        };
        return { kind: "single", toolResult, uiEvent };
      } catch (e) {
        const errorMessage = e instanceof Error ? e.message : String(e);
        return blocked(`Edit tool error: could not write file: ${errorMessage}`);
      }
    },
  };
}
