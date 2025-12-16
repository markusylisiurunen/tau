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

const WEB_SEARCH_DESCRIPTION = [
  "Search the web for relevant sources.",
  "Use this to discover good candidate URLs before fetching content with web_fetch.",
  "Provide a clear objective describing what you are trying to find (preferred sources, recency, and constraints help).",
  "Optionally provide searchQueries for keyword-style guidance.",
  "Use includeDomains/excludeDomains to enforce source policies when needed.",
  "You may adjust maxResults and maxCharsPerResult to balance coverage vs token usage.",
].join(" ");

export const WEB_SEARCH_TOOL: Tool = {
  name: "web_search",
  description: WEB_SEARCH_DESCRIPTION,
  parameters: Type.Object(
    {
      objective: Type.String({
        description: "What you are trying to find out.",
      }),
      searchQueries: Type.Optional(
        Type.Array(Type.String(), {
          description: "Optional keyword-style queries to guide the search.",
        }),
      ),
      maxResults: Type.Optional(
        Type.Integer({
          minimum: 1,
          maximum: 50,
        }),
      ),
      maxCharsPerResult: Type.Optional(
        Type.Integer({
          minimum: 200,
          maximum: 50_000,
        }),
      ),
      includeDomains: Type.Optional(Type.Array(Type.String())),
      excludeDomains: Type.Optional(Type.Array(Type.String())),
    },
    { additionalProperties: false },
  ),
};

type WebSearchArgs = {
  objective: string;
  searchQueries?: string[];
  maxResults?: number;
  maxCharsPerResult?: number;
  includeDomains?: string[];
  excludeDomains?: string[];
};

type ParallelSearchResponse = {
  results?: Array<{
    url: string;
    title?: string | null;
    publish_date?: string | null;
    excerpts?: string[] | null;
  }>;
  warnings?: unknown;
  usage?: unknown;
};

function parseArgs(raw: unknown): WebSearchArgs {
  const args = raw as Partial<WebSearchArgs> | undefined;
  const objective = typeof args?.objective === "string" ? args.objective.trim() : "";

  const searchQueries =
    Array.isArray(args?.searchQueries) && args.searchQueries.every((q) => typeof q === "string")
      ? args.searchQueries.map((q) => q.trim()).filter(Boolean)
      : undefined;

  const maxResultsRaw = args?.maxResults;
  const maxResults =
    typeof maxResultsRaw === "number" &&
    Number.isFinite(maxResultsRaw) &&
    Number.isInteger(maxResultsRaw) &&
    maxResultsRaw >= 1 &&
    maxResultsRaw <= 50
      ? maxResultsRaw
      : undefined;

  const maxCharsPerResultRaw = args?.maxCharsPerResult;
  const maxCharsPerResult =
    typeof maxCharsPerResultRaw === "number" &&
    Number.isFinite(maxCharsPerResultRaw) &&
    Number.isInteger(maxCharsPerResultRaw) &&
    maxCharsPerResultRaw >= 200 &&
    maxCharsPerResultRaw <= 50_000
      ? maxCharsPerResultRaw
      : undefined;

  const includeDomains =
    Array.isArray(args?.includeDomains) && args.includeDomains.every((d) => typeof d === "string")
      ? args.includeDomains.map((d) => d.trim()).filter(Boolean)
      : undefined;

  const excludeDomains =
    Array.isArray(args?.excludeDomains) && args.excludeDomains.every((d) => typeof d === "string")
      ? args.excludeDomains.map((d) => d.trim()).filter(Boolean)
      : undefined;

  return {
    objective,
    ...(searchQueries && searchQueries.length > 0 && { searchQueries }),
    ...(maxResults !== undefined && { maxResults }),
    ...(maxCharsPerResult !== undefined && { maxCharsPerResult }),
    ...(includeDomains && includeDomains.length > 0 && { includeDomains }),
    ...(excludeDomains && excludeDomains.length > 0 && { excludeDomains }),
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

function estimateParallelSearchCostUsd(
  maxResultsRequested: number | undefined,
  resultsReturned: number | undefined,
): number {
  const resultsCount =
    typeof resultsReturned === "number" && Number.isFinite(resultsReturned)
      ? resultsReturned
      : typeof maxResultsRequested === "number" && Number.isFinite(maxResultsRequested)
        ? maxResultsRequested
        : 10;

  const additionalResults = Math.max(0, resultsCount - 10);
  return 0.005 + 0.001 * additionalResults;
}

function formatSearchResults(response: ParallelSearchResponse): string {
  const results = response.results ?? [];
  if (results.length === 0) {
    return "No results.";
  }

  const lines: string[] = [];
  for (const r of results) {
    const title = r.title?.trim() || "(no title)";
    const date = r.publish_date ? ` (${r.publish_date})` : "";
    lines.push(`- ${title}${date}\n  ${r.url}`);

    const excerpts = (r.excerpts ?? []).map((e) => e.trim()).filter(Boolean);
    if (excerpts.length > 0) {
      for (const excerpt of excerpts.slice(0, 3)) {
        const excerptOneLine = excerpt.replace(/\s+/g, " ").trim();
        lines.push(`  - ${excerptOneLine}`);
      }
    }
  }

  const formatted = lines.join("\n");
  return truncateMiddleForModel(formatted, {
    maxLines: 4000,
    maxBytes: 200_000,
    bytesPerTokenApprox: 4,
  }).content;
}

export function createWebSearchToolDefinition(config: Config): ToolDefinition {
  return {
    schema: WEB_SEARCH_TOOL,
    async dispatch(
      toolCall: ToolCall,
      riskLevel: RiskLevel,
      signal?: AbortSignal,
    ): Promise<ToolDispatchResult | ToolDispatchResultWithPhases> {
      const args = parseArgs(toolCall.arguments);

      const blocked = (reason: string): ToolDispatchResult => {
        const toolResult = createToolError(toolCall, reason);
        const uiEvent: ToolUiEvent = {
          type: "web_search_finished",
          toolCallId: toolCall.id,
          objective: args.objective || "(missing objective)",
          status: "error",
        };
        return { kind: "single", toolResult, uiEvent };
      };

      if (riskLevel === "none") {
        return blocked(
          "web_search blocked due to risk level being set to 'none'. Ask the user to enable it with /risk:read-only or /risk:read-write.",
        );
      }

      if (!args.objective) {
        return blocked("web_search error: missing required parameter 'objective'.");
      }

      const apiKey = getParallelApiKey(config);
      if (!apiKey) {
        return blocked("web_search error: missing Parallel API key.");
      }

      return {
        kind: "phased",
        startedUiEvent: {
          type: "web_search_started",
          toolCallId: toolCall.id,
          objective: args.objective,
        },
        run: (async () => {
          try {
            const body: Record<string, unknown> = {
              objective: args.objective,
              mode: "one-shot",
              ...(args.searchQueries && { search_queries: args.searchQueries }),
              ...(typeof args.maxResults === "number" && { max_results: args.maxResults }),
              ...(typeof args.maxCharsPerResult === "number" && {
                excerpts: { max_chars_per_result: args.maxCharsPerResult },
              }),
              ...((args.includeDomains || args.excludeDomains) && {
                source_policy: {
                  ...(args.includeDomains && { include_domains: args.includeDomains }),
                  ...(args.excludeDomains && { exclude_domains: args.excludeDomains }),
                },
              }),
            };

            const res = await fetch(`${PARALLEL_API_BASE_URL}/v1beta/search`, {
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

            const response = parsed as ParallelSearchResponse;

            const text = formatSearchResults(response);
            const toolResult: ToolResultMessage = createToolResult(toolCall, text, false);
            const uiEvent: ToolUiEvent = {
              type: "web_search_finished",
              toolCallId: toolCall.id,
              objective: args.objective,
              status: "success",
              costUsd: estimateParallelSearchCostUsd(args.maxResults, response.results?.length),
            };
            return { kind: "single", toolResult, uiEvent };
          } catch (e) {
            const msg = `web_search failed: ${e instanceof Error ? e.message : String(e)}`;
            const toolResult = createToolError(toolCall, msg);
            const uiEvent: ToolUiEvent = {
              type: "web_search_finished",
              toolCallId: toolCall.id,
              objective: args.objective,
              status: "error",
            };
            return { kind: "single", toolResult, uiEvent };
          }
        })(),
      };
    },
  };
}
