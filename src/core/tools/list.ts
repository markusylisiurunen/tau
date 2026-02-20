import type { Tool, ToolCall, ToolResultMessage } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import { z } from "zod";
import type { RiskLevel } from "../types.js";
import { createToolError, createToolResult } from "../utils/messages.js";
import { buildHeadTailPreviewLines } from "../utils/tool_preview.js";
import { TRUNCATION_MARKER } from "../utils/truncate.js";
import { formatZodError } from "../utils/zod.js";
import type { ToolExecutionBackend } from "./execution_backend.js";
import type {
  ToolDefinition,
  ToolDispatchResult,
  ToolUiEvent,
  ToolUiLine,
  ToolUiText,
} from "./registry.js";
import { TOOL_NAME_LIST } from "./tool_names.js";

export const LIST_MAX_ENTRIES = 4096;

const LIST_DEFAULT_LIMIT = 256;

const LIST_DESCRIPTION = ["List files in a directory (non-recursive)."].join(" ");

const LIST_PATH_DESCRIPTION =
  "Directory path to list (relative to the current working directory). Use '.' for root.";
const LIST_OFFSET_DESCRIPTION = "Number of entries to skip.";
const LIST_LIMIT_DESCRIPTION = "Max number of entries to return (<= 4096).";

export const LIST_TOOL: Tool = {
  name: TOOL_NAME_LIST,
  description: LIST_DESCRIPTION,
  parameters: Type.Object(
    {
      path: Type.String({
        description: LIST_PATH_DESCRIPTION,
      }),
      offset: Type.Optional(Type.Integer({ description: LIST_OFFSET_DESCRIPTION, minimum: 0 })),
      limit: Type.Optional(Type.Integer({ description: LIST_LIMIT_DESCRIPTION, minimum: 1 })),
    },
    { additionalProperties: false },
  ),
};

const listArgsSchema = z.object({
  path: z.string().trim().min(1),
  offset: z.number().int().min(0).default(0),
  limit: z.number().int().min(1).default(LIST_DEFAULT_LIMIT),
});

function parseListArgs(raw: unknown):
  | {
      ok: true;
      data: {
        path: string;
        offset: number;
        limit: number;
      };
    }
  | { ok: false; error: string } {
  const parsed = listArgsSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: formatZodError(parsed.error) };
  }
  return { ok: true, data: parsed.data };
}

function formatListToolResultText(entries: string[]): string {
  return entries.join("\n");
}

function buildListUiText(args: {
  offset: number;
  limit: number;
  total: number;
  returned: number;
  entries: string[];
  fullText: string;
}): ToolUiText {
  const { offset, limit, total, returned, entries, fullText } = args;
  const previewContentLines = buildHeadTailPreviewLines(entries.join("\n"), {
    headLines: 5,
    tailLines: 5,
    unitLabel: "entries",
    unitLabelSingular: "entry",
  });
  const infoText = `${returned} of ${total} entries · offset ${offset} · limit ${limit}`;
  const hasMore = total > offset + returned;
  const summaryLine = hasMore ? `${TRUNCATION_MARKER} · ${infoText}` : infoText;
  const previewLines: ToolUiLine[] = previewContentLines.map((text) => ({ text }));

  const trimmedFullText = fullText.trimEnd();
  const fullLines: ToolUiLine[] = trimmedFullText
    ? trimmedFullText.split("\n").map((text) => ({ text }))
    : [];

  return { previewLines, statusLine: summaryLine, fullLines };
}

export function createListToolDefinition(backend: ToolExecutionBackend): ToolDefinition {
  return {
    schema: LIST_TOOL,
    async dispatch(toolCall: ToolCall, _riskLevel: RiskLevel): Promise<ToolDispatchResult> {
      const parsedArgs = parseListArgs(toolCall.arguments);
      const path = parsedArgs.ok ? parsedArgs.data.path : "";
      const headerTarget = path || "(invalid arguments)";

      const blocked = (reason: string): ToolDispatchResult => {
        const toolResult = createToolError(toolCall, reason);
        const uiEvent: ToolUiEvent = {
          type: "list_blocked",
          toolCallId: toolCall.id,
          path: path || "(invalid path)",
          headerTarget,
          reason,
        };
        return { kind: "single", toolResult, uiEvent };
      };

      if (!parsedArgs.ok) {
        return blocked(`invalid arguments: ${parsedArgs.error}`);
      }

      const { offset, limit } = parsedArgs.data;
      const effectiveLimit = Math.min(Math.max(1, limit), LIST_MAX_ENTRIES);

      try {
        const { path: resolvedPath, entries: dirents } = await backend.listDir(path);

        const entries = dirents
          .map((d) => ({
            name: d.name,
            suffix: d.isDirectory ? "/" : d.isSymlink ? "@" : "",
          }))
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((e) => `${e.name}${e.suffix}`);

        const total = entries.length;
        const windowed = entries.slice(offset, offset + effectiveLimit);

        const toolText = formatListToolResultText(windowed);
        const uiText = buildListUiText({
          offset,
          limit: effectiveLimit,
          total,
          returned: windowed.length,
          entries: windowed,
          fullText: toolText,
        });

        const toolResult: ToolResultMessage = createToolResult(toolCall, toolText, false);
        const uiEvent: ToolUiEvent = {
          type: "list_success",
          toolCallId: toolCall.id,
          path: resolvedPath,
          headerTarget: resolvedPath,
          offset,
          limit: effectiveLimit,
          total,
          returned: windowed.length,
          entries: windowed,
          uiText,
        };

        return { kind: "single", toolResult, uiEvent };
      } catch (e) {
        const errorMessage = e instanceof Error ? e.message : String(e);
        return blocked(`list failed: ${errorMessage}`);
      }
    },
  };
}
