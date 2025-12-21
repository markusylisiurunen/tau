import { readdirSync } from "node:fs";
import type { Tool, ToolCall, ToolResultMessage } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import { z } from "zod";
import type { RiskLevel } from "../types.js";
import { createToolError, createToolResult } from "../utils/messages.js";
import { resolveRestrictedDirPath } from "../utils/restricted_fs.js";
import type { ToolDefinition, ToolDispatchResult, ToolUiEvent } from "./registry.js";

export const LIST_MAX_ENTRIES = 256;

const LIST_DEFAULT_LIMIT = 64;

const LIST_DESCRIPTION = ["List files in a directory (non-recursive)."].join(" ");

export const LIST_TOOL: Tool = {
  name: "list",
  description: LIST_DESCRIPTION,
  parameters: Type.Object(
    {
      path: Type.String({
        description: "Directory path to list (relative to the repo root). Use '.' for root.",
      }),
      offset: Type.Optional(
        Type.Integer({ description: "Number of entries to skip.", minimum: 0 }),
      ),
      limit: Type.Optional(
        Type.Integer({ description: "Max number of entries to return (<= 256).", minimum: 1 }),
      ),
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
  if (!parsed.success) {
    return { path: "", offset: 0, limit: LIST_DEFAULT_LIMIT };
  }

  return {
    path: parsed.data.path,
    offset: parsed.data.offset ?? 0,
    limit: parsed.data.limit ?? LIST_DEFAULT_LIMIT,
  };
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

export function createListToolDefinition(): ToolDefinition {
  return {
    schema: LIST_TOOL,
    async dispatch(toolCall: ToolCall, riskLevel: RiskLevel): Promise<ToolDispatchResult> {
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

      if (riskLevel !== "restricted") {
        return blocked(
          `List tool blocked: only available in restricted mode, but current level is '${riskLevel}'.`,
        );
      }

      if (!path) {
        return blocked("List tool error: missing 'path' parameter.");
      }

      if (offset < 0) {
        return blocked("List tool error: offset must be >= 0.");
      }

      const effectiveLimit = Math.min(Math.max(1, limit), LIST_MAX_ENTRIES);

      try {
        const resolved = resolveRestrictedDirPath(path);
        const dirents = readdirSync(resolved.realPath, { withFileTypes: true });

        const entries = dirents
          .map((d) => ({
            name: d.name,
            suffix: d.isDirectory() ? "/" : d.isSymbolicLink() ? "@" : "",
          }))
          .sort((a, b) => a.name.localeCompare(b.name))
          .map((e) => `${e.name}${e.suffix}`);

        const total = entries.length;
        const windowed = entries.slice(offset, offset + effectiveLimit);

        const toolText = formatListToolResultText({
          path: resolved.relPath,
          offset,
          limit: effectiveLimit,
          total,
          returned: windowed.length,
          entries: windowed,
        });

        const toolResult: ToolResultMessage = createToolResult(toolCall, toolText, false);
        const uiEvent: ToolUiEvent = {
          type: "list_success",
          path: resolved.relPath,
          offset,
          limit: effectiveLimit,
          total,
          returned: windowed.length,
          entries: windowed,
        };

        return { kind: "single", toolResult, uiEvent };
      } catch (e) {
        const errorMessage = e instanceof Error ? e.message : String(e);
        return blocked(`List tool failed: ${errorMessage}`);
      }
    },
  };
}
