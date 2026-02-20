import type { Tool, ToolCall, ToolResultMessage } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import { z } from "zod";
import type { Config } from "../config/index.js";
import { getParallelApiKey } from "../config/index.js";
import type { RiskLevel } from "../types.js";
import { createToolError, createToolResult } from "../utils/messages.js";
import {
  extractParallelErrorMessage,
  PARALLEL_API_BASE_URL,
  PARALLEL_BETA_HEADER,
} from "../utils/parallel_api.js";
import { TRUNCATION_MARKER, type TruncationResult, truncateForTokens } from "../utils/truncate.js";
import { formatZodError } from "../utils/zod.js";
import type {
  ToolDefinition,
  ToolDispatchResult,
  ToolDispatchResultWithPhases,
  ToolUiEvent,
} from "./registry.js";
import { TOOL_NAME_WEB_FETCH } from "./tool_names.js";

const WEB_FETCH_DESCRIPTION = [
  "Fetch and extract relevant content from a URL.",
  "When you are interested in only a specific part, use excerpts=true and fullContent=false.",
  "When you don't have a specific question or otherwise need the entire content of the page, use fullContent=true.",
  "You can provide an objective and/or searchQueries to focus the extraction on specific topics or keywords.",
  "Be mindful of the potential size of the content being fetched, especially when using fullContent=true.",
  "You may use maxCharsPerResult to limit the size of the extracted content if needed.",
].join(" ");

const WEB_FETCH_URL_DESCRIPTION = "URL to fetch.";
const WEB_FETCH_OBJECTIVE_DESCRIPTION =
  "If provided, focuses extracted content on the specified search objective.";
const WEB_FETCH_SEARCH_QUERIES_DESCRIPTION =
  "If provided, focuses extracted content on the specified keyword search queries.";
const WEB_FETCH_EXCERPTS_DESCRIPTION =
  "Include excerpts from URL relevant to the search objective and queries.";
const WEB_FETCH_FULL_CONTENT_DESCRIPTION = "Include full content from URL. Can be large.";
const WEB_FETCH_MAX_CHARS_PER_RESULT_DESCRIPTION =
  "Max number of characters per extracted excerpt.";

export const WEB_FETCH_TOOL: Tool = {
  name: TOOL_NAME_WEB_FETCH,
  description: WEB_FETCH_DESCRIPTION,
  parameters: Type.Object(
    {
      url: Type.String({
        description: WEB_FETCH_URL_DESCRIPTION,
      }),
      objective: Type.Optional(
        Type.String({
          description: WEB_FETCH_OBJECTIVE_DESCRIPTION,
        }),
      ),
      searchQueries: Type.Optional(
        Type.Array(Type.String(), {
          description: WEB_FETCH_SEARCH_QUERIES_DESCRIPTION,
        }),
      ),
      excerpts: Type.Optional(
        Type.Boolean({
          description: WEB_FETCH_EXCERPTS_DESCRIPTION,
        }),
      ),
      fullContent: Type.Optional(
        Type.Boolean({
          description: WEB_FETCH_FULL_CONTENT_DESCRIPTION,
        }),
      ),
      maxCharsPerResult: Type.Optional(
        Type.Integer({
          description: WEB_FETCH_MAX_CHARS_PER_RESULT_DESCRIPTION,
          minimum: 200,
          maximum: 100_000,
        }),
      ),
    },
    { additionalProperties: false },
  ),
};

const webFetchArgsSchema = z.object({
  url: z.string().trim().min(1),
  objective: z.string().trim().min(1).optional(),
  searchQueries: z.array(z.string().trim().min(1)).min(1).optional(),
  excerpts: z.boolean().optional(),
  fullContent: z.boolean().optional(),
  maxCharsPerResult: z.number().int().min(200).max(100_000).optional(),
});

type WebFetchArgs = z.infer<typeof webFetchArgsSchema>;

const extractResultSchema = z
  .object({
    url: z.string().min(1),
    title: z.string().nullable().optional(),
    publish_date: z.string().nullable().optional(),
    excerpts: z.array(z.string()).nullable().optional(),
    full_content: z.string().nullable().optional(),
  })
  .passthrough();

const extractErrorSchema = z
  .object({
    url: z.string().min(1),
    error_type: z.string().min(1),
    http_status_code: z.number().int().nullable(),
    content: z.string().nullable(),
  })
  .passthrough();

const extractResponseSchema = z
  .object({
    extract_id: z.string().min(1),
    results: z.array(extractResultSchema),
    errors: z.array(extractErrorSchema),
    warnings: z.unknown().optional(),
    usage: z.unknown().optional(),
  })
  .passthrough();

type ExtractResponse = z.infer<typeof extractResponseSchema>;

type ExtractResult = ExtractResponse["results"][number];

type ExtractError = ExtractResponse["errors"][number];

function parseArgs(raw: unknown): { ok: true; data: WebFetchArgs } | { ok: false; error: string } {
  const parsed = webFetchArgsSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: formatZodError(parsed.error) };
  }
  return { ok: true, data: parsed.data };
}

function estimateParallelExtractCostUsd(urlCount: number): number {
  return 0.001 * urlCount;
}

function formatExtractResults(response: ExtractResponse): TruncationResult {
  const results = response.results;
  const errors = response.errors;

  if (results.length === 0 && errors.length === 0) {
    const content = "no extract results";
    const bytes = Buffer.byteLength(content, "utf-8");
    return {
      content,
      truncated: false,
      truncatedBy: null,
      totalLines: 1,
      totalBytes: bytes,
      outputLines: 1,
      outputBytes: bytes,
      maxLines: 1,
      maxTokens: 16384,
    };
  }

  const lines: string[] = [];

  for (const r of results) {
    const title = r.title?.trim() || "(no title)";
    const date = r.publish_date ? ` (${r.publish_date})` : "";
    lines.push(`${title}${date}\n${r.url}`);

    const excerpts = (r.excerpts ?? []).map((e) => e.trim()).filter(Boolean);
    if (excerpts.length > 0) {
      lines.push("");
      lines.push(...excerpts);
    }

    const full = r.full_content?.trim();
    if (full) {
      if (excerpts.length > 0) lines.push("\n(full content)\n");
      lines.push(full);
    }

    lines.push("\n---\n");
  }

  if (errors.length > 0) {
    lines.push("errors:\n");
    for (const err of errors) {
      const status =
        typeof err.http_status_code === "number" ? ` (HTTP ${err.http_status_code})` : "";
      lines.push(`- ${err.url}: ${err.error_type}${status}`);
      const content = err.content?.trim();
      if (content) {
        lines.push(`  ${content}`);
      }
    }
    lines.push("\n---\n");
  }

  const formatted = lines.join("\n");
  return truncateForTokens(formatted, {
    maxTokens: 16384,
    strategy: "middle",
  });
}

export function createWebFetchToolDefinition(config: Config): ToolDefinition {
  return {
    schema: WEB_FETCH_TOOL,
    async dispatch(
      toolCall: ToolCall,
      _riskLevel: RiskLevel,
      signal?: AbortSignal,
    ): Promise<ToolDispatchResult | ToolDispatchResultWithPhases> {
      const parsedArgs = parseArgs(toolCall.arguments);
      const url = parsedArgs.ok ? parsedArgs.data.url : "";
      const headerTarget = url || "(invalid arguments)";

      const blocked = (reason: string): ToolDispatchResult => {
        const toolResult = createToolError(toolCall, reason);
        const uiEvent: ToolUiEvent = {
          type: "web_fetch_finished",
          toolCallId: toolCall.id,
          url: url || "(invalid url)",
          headerTarget,
          status: "error",
        };
        return { kind: "single", toolResult, uiEvent };
      };

      if (!parsedArgs.ok) {
        return blocked(`invalid arguments: ${parsedArgs.error}`);
      }

      const args = parsedArgs.data;

      const apiKey = getParallelApiKey(config);
      if (!apiKey) {
        return blocked("missing Parallel API key.");
      }

      return {
        kind: "phased",
        startedUiEvent: {
          type: "web_fetch_started",
          toolCallId: toolCall.id,
          url: args.url,
          headerTarget,
        },
        run: (async () => {
          try {
            const body: Record<string, unknown> = {
              urls: [args.url],
              ...(args.objective && { objective: args.objective }),
              ...(args.searchQueries && { search_queries: args.searchQueries }),
              ...(args.fullContent !== undefined && { full_content: args.fullContent }),
              ...(typeof args.maxCharsPerResult === "number"
                ? { excerpts: { max_chars_per_result: args.maxCharsPerResult } }
                : args.excerpts !== undefined
                  ? { excerpts: args.excerpts }
                  : {}),
            };

            const res = await fetch(`${PARALLEL_API_BASE_URL}/v1beta/extract`, {
              method: "POST",
              headers: {
                "content-type": "application/json",
                accept: "application/json",
                "parallel-beta": PARALLEL_BETA_HEADER,
                "x-api-key": apiKey,
              },
              body: JSON.stringify(body),
              signal,
            });

            let parsed: unknown;
            try {
              parsed = await res.json();
            } catch {
              parsed = undefined;
            }

            if (!res.ok) {
              const details =
                extractParallelErrorMessage(parsed) || res.statusText || "request failed";
              throw new Error(`Parallel API error (${res.status}): ${details}`);
            }

            const responseParsed = extractResponseSchema.safeParse(parsed);
            if (!responseParsed.success) {
              throw new Error(
                `Parallel API response parse error: ${formatZodError(responseParsed.error)}`,
              );
            }

            const response = responseParsed.data;
            const resultText = formatExtractResults(response);
            const toolResult: ToolResultMessage = createToolResult(
              toolCall,
              resultText.content,
              false,
            );
            const uiEvent: ToolUiEvent = {
              type: "web_fetch_finished",
              toolCallId: toolCall.id,
              url: args.url,
              headerTarget,
              status: "success",
              costUsd: estimateParallelExtractCostUsd(1),
              message: resultText.truncated ? TRUNCATION_MARKER : undefined,
            };
            return { kind: "single", toolResult, uiEvent };
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            const reason = msg.trim() ? msg : "request failed";
            const toolResult = createToolError(toolCall, reason);
            const uiEvent: ToolUiEvent = {
              type: "web_fetch_finished",
              toolCallId: toolCall.id,
              url: args.url,
              headerTarget,
              status: "error",
            };
            return { kind: "single", toolResult, uiEvent };
          }
        })(),
      };
    },
  };
}
