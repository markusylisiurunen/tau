import type { Tool, ToolCall, ToolResultMessage } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import type { Config } from "../config.js";
import { getParallelApiKey } from "../config.js";
import type { RiskLevel } from "../types.js";
import { createToolError, createToolResult } from "../utils/messages.js";
import { truncateMiddleForModel } from "../utils/truncate.js";
import type {
  ToolDefinition,
  ToolDispatchResult,
  ToolDispatchResultWithPhases,
  ToolUiEvent,
} from "./registry.js";

const PARALLEL_API_BASE_URL = "https://api.parallel.ai";
const PARALLEL_BETA_HEADER = "search-extract-2025-10-10";

const WEB_FETCH_DESCRIPTION = [
  "Fetch and extract relevant content from a URL.",
  "When you are interested in only a specific part, use excerpts=true and fullContent=false.",
  "When you don't have a specific question or otherwise need the entire content of the page, use fullContent=true.",
  "You can provide an objective and/or searchQueries to focus the extraction on specific topics or keywords.",
  "Be mindful of the potential size of the content being fetched, especially when using fullContent=true.",
  "You may use maxCharsPerResult to limit the size of the extracted content if needed.",
].join(" ");

export const WEB_FETCH_TOOL: Tool = {
  name: "web_fetch",
  description: WEB_FETCH_DESCRIPTION,
  parameters: Type.Object(
    {
      url: Type.String({
        description: "URL to fetch.",
      }),
      objective: Type.Optional(
        Type.String({
          description: "If provided, focuses extracted content on the specified search objective.",
        }),
      ),
      searchQueries: Type.Optional(
        Type.Array(Type.String(), {
          description:
            "If provided, focuses extracted content on the specified keyword search queries.",
        }),
      ),
      excerpts: Type.Optional(
        Type.Boolean({
          description: "Include excerpts from URL relevant to the search objective and queries.",
        }),
      ),
      fullContent: Type.Optional(
        Type.Boolean({
          description: "Include full content from URL. Can be large.",
        }),
      ),
      maxCharsPerResult: Type.Optional(
        Type.Integer({
          minimum: 200,
          maximum: 100_000,
        }),
      ),
    },
    { additionalProperties: false },
  ),
};

type WebFetchArgs = {
  url: string;
  objective?: string;
  searchQueries?: string[];
  excerpts?: boolean;
  fullContent?: boolean;
  maxCharsPerResult?: number;
};

type ExtractResult = {
  url: string;
  title?: string | null;
  publish_date?: string | null;
  excerpts?: string[] | null;
  full_content?: string | null;
};

type ExtractError = {
  url: string;
  error_type: string;
  http_status_code: number | null;
  content: string | null;
};

type ExtractResponse = {
  extract_id: string;
  results: ExtractResult[];
  errors: ExtractError[];
  warnings?: unknown;
  usage?: unknown;
};

function parseArgs(raw: unknown): WebFetchArgs {
  const args = raw as Partial<WebFetchArgs> | undefined;
  const url = typeof args?.url === "string" ? args.url.trim() : "";
  const objective = typeof args?.objective === "string" ? args.objective.trim() : undefined;

  const searchQueries =
    Array.isArray(args?.searchQueries) && args.searchQueries.every((q) => typeof q === "string")
      ? args.searchQueries.map((q) => q.trim()).filter(Boolean)
      : undefined;

  const excerpts = typeof args?.excerpts === "boolean" ? args.excerpts : undefined;
  const fullContent = typeof args?.fullContent === "boolean" ? args.fullContent : undefined;

  const maxCharsPerResultRaw = args?.maxCharsPerResult;
  const maxCharsPerResult =
    typeof maxCharsPerResultRaw === "number" &&
    Number.isFinite(maxCharsPerResultRaw) &&
    Number.isInteger(maxCharsPerResultRaw) &&
    maxCharsPerResultRaw >= 200 &&
    maxCharsPerResultRaw <= 100_000
      ? maxCharsPerResultRaw
      : undefined;

  return {
    url,
    ...(objective && { objective }),
    ...(searchQueries && searchQueries.length > 0 && { searchQueries }),
    ...(excerpts !== undefined && { excerpts }),
    ...(fullContent !== undefined && { fullContent }),
    ...(maxCharsPerResult !== undefined && { maxCharsPerResult }),
  };
}

function extractParallelErrorMessage(raw: unknown): string | undefined {
  if (!raw || typeof raw !== "object") return undefined;

  const obj = raw as Record<string, unknown>;
  if (obj.type === "error") {
    const error = obj.error as Record<string, unknown> | undefined;
    const msg = error?.message;
    if (typeof msg === "string" && msg.trim()) return msg.trim();
  }

  const msg = obj.message;
  if (typeof msg === "string" && msg.trim()) return msg.trim();

  return undefined;
}

function estimateParallelExtractCostUsd(urlCount: number): number {
  return 0.001 * urlCount;
}

function formatExtractResults(response: ExtractResponse): string {
  const results = Array.isArray(response.results) ? response.results : [];
  const errors = Array.isArray(response.errors) ? response.errors : [];

  if (results.length === 0 && errors.length === 0) {
    return "No extract results.";
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
    lines.push("Errors:\n");
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
  return truncateMiddleForModel(formatted, {
    maxLines: 4000,
    maxBytes: 250_000,
    bytesPerTokenApprox: 4,
  }).content;
}

export function createWebFetchToolDefinition(config: Config): ToolDefinition {
  return {
    schema: WEB_FETCH_TOOL,
    async dispatch(
      toolCall: ToolCall,
      riskLevel: RiskLevel,
      signal?: AbortSignal,
    ): Promise<ToolDispatchResult | ToolDispatchResultWithPhases> {
      const args = parseArgs(toolCall.arguments);

      const blocked = (reason: string): ToolDispatchResult => {
        const toolResult = createToolError(toolCall, reason);
        const uiEvent: ToolUiEvent = {
          type: "web_fetch_finished",
          toolCallId: toolCall.id,
          url: args.url || "(missing url)",
          status: "error",
        };
        return { kind: "single", toolResult, uiEvent };
      };

      if (riskLevel === "none") {
        return blocked(
          "web_fetch blocked due to risk level being set to 'none'. Ask the user to enable it with /risk:read-only or /risk:read-write.",
        );
      }

      if (!args.url) {
        return blocked("web_fetch error: missing required parameter 'url'.");
      }

      const apiKey = getParallelApiKey(config);
      if (!apiKey) {
        return blocked("web_fetch error: missing Parallel API key.");
      }

      return {
        kind: "phased",
        startedUiEvent: {
          type: "web_fetch_started",
          toolCallId: toolCall.id,
          url: args.url,
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

            const response = parsed as ExtractResponse;
            const text = formatExtractResults(response);
            const toolResult: ToolResultMessage = createToolResult(toolCall, text, false);
            const uiEvent: ToolUiEvent = {
              type: "web_fetch_finished",
              toolCallId: toolCall.id,
              url: args.url,
              status: "success",
              costUsd: estimateParallelExtractCostUsd(1),
            };
            return { kind: "single", toolResult, uiEvent };
          } catch (e) {
            const msg = `web_fetch failed: ${e instanceof Error ? e.message : String(e)}`;
            const toolResult = createToolError(toolCall, msg);
            const uiEvent: ToolUiEvent = {
              type: "web_fetch_finished",
              toolCallId: toolCall.id,
              url: args.url,
              status: "error",
            };
            return { kind: "single", toolResult, uiEvent };
          }
        })(),
      };
    },
  };
}
