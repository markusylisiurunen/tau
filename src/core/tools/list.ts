import type { Tool, ToolCall, ToolResultMessage } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import { z } from "zod";
import type { RiskLevel } from "../types.js";
import { createToolError, createToolResult } from "../utils/messages.js";
import { buildCompactPreviewLines } from "../utils/tool_preview.js";
import type { ToolExecutionBackend } from "./execution_backend.js";
import type { ToolDefinition, ToolDispatchResult, ToolUiEvent, ToolUiText } from "./registry.js";

export const LIST_MAX_ENTRIES = 256;

const LIST_DEFAULT_LIMIT = 64;

const LIST_DESCRIPTION = ["List files in a directory (non-recursive)."].join(" ");

const LIST_PATH_DESCRIPTION =
  "Directory path to list (relative to the repo root). Use '.' for root.";
const LIST_OFFSET_DESCRIPTION = "Number of entries to skip.";
const LIST_LIMIT_DESCRIPTION = "Max number of entries to return (<= 256).";

export const LIST_TOOL: Tool = {
  name: "list",
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
  path: z.string().trim().catch(""),
  offset: z.number().int().min(0).optional(),
  limit: z.number().int().min(1).optional(),
});

function parseListArgs(raw: unknown): {
  path: string;
  offset: number;
  limit: number;
} {
  const parsed = listArgsSchema.safeParse(raw);
  const path = parsed.success ? parsed.data.path : "";
  const offset = parsed.success ? (parsed.data.offset ?? 0) : 0;
  const limit = parsed.success ? (parsed.data.limit ?? LIST_DEFAULT_LIMIT) : LIST_DEFAULT_LIMIT;
  return { path, offset, limit };
}

function formatListToolResultText(args: {
  path: string;
  offset: number;
  limit: number;
  total: number;
  returned: number;
  entries: string[];
}): string {
  const parts: string[] = [];
  parts.push(`list ${args.path} (offset ${args.offset}, limit ${args.limit})`);
  parts.push(`${args.returned} of ${args.total} entries`);

  if (args.entries.length > 0) {
    parts.push("", ...args.entries);
  }

  return parts.join("\n");
}

function buildListUiText(args: {
  offset: number;
  limit: number;
  total: number;
  returned: number;
  entries: string[];
}): ToolUiText {
  const { offset, limit, total, returned, entries } = args;
  const compactLines = buildCompactPreviewLines(entries, {
    totalLines: entries.length,
    maxLines: 16,
    unitLabel: "entries",
  });
  const infoText = `${returned} of ${total} entries · offset ${offset} · limit ${limit}`;
  const summaryLine = `    (${infoText})`;
  const previewText = compactLines ?? "";

  const summary = `${returned} of ${total} entries (offset ${offset}, limit ${limit})`;
  const listText = entries.length > 0 ? entries.join("\n") : "";
  const fullText = listText ? `${summary}\n\n${listText}` : summary;

  return { previewText, statusLine: summaryLine, fullText };
}

export function createListToolDefinition(backend: ToolExecutionBackend): ToolDefinition {
  return {
    schema: LIST_TOOL,
    async dispatch(toolCall: ToolCall, _riskLevel: RiskLevel): Promise<ToolDispatchResult> {
      const { path, offset, limit } = parseListArgs(toolCall.arguments);

      const blocked = (reason: string): ToolDispatchResult => {
        const toolResult = createToolError(toolCall, reason);
        const uiEvent: ToolUiEvent = {
          type: "list_blocked",
          path: path || "(missing path)",
          reason,
        };
        return { kind: "single", toolResult, uiEvent };
      };

      // All acceptance checks passed; return result
      if (!path) {
        return blocked("missing 'path' parameter.");
      }

      if (offset < 0) {
        return blocked("offset must be >= 0.");
      }

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

        const toolText = formatListToolResultText({
          path: resolvedPath,
          offset,
          limit: effectiveLimit,
          total,
          returned: windowed.length,
          entries: windowed,
        });
        const uiText = buildListUiText({
          offset,
          limit: effectiveLimit,
          total,
          returned: windowed.length,
          entries: windowed,
        });

        const toolResult: ToolResultMessage = createToolResult(toolCall, toolText, false);
        const uiEvent: ToolUiEvent = {
          type: "list_success",
          path: resolvedPath,
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
