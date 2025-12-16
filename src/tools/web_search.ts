import type { Tool, ToolCall, ToolResultMessage } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import { z } from "zod";
import type { Config } from "../config.js";
import { getParallelApiKey } from "../config.js";
import type { RiskLevel } from "../types.js";
import { createToolError, createToolResult } from "../utils/messages.js";
import { truncateMiddleForModel } from "../utils/truncate.js";
import { formatZodError } from "../utils/zod.js";
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

const webSearchArgsSchema = z.object({
  objective: z.string().trim().catch(""),
  searchQueries: z
    .array(z.string().trim())
    .transform((queries) => queries.filter(Boolean))
    .optional()
    .catch(undefined),
  maxResults: z.number().int().min(1).max(50).optional().catch(undefined),
  maxCharsPerResult: z.number().int().min(200).max(50_000).optional().catch(undefined),
  includeDomains: z
    .array(z.string().trim())
    .transform((domains) => domains.filter(Boolean))
    .optional()
    .catch(undefined),
  excludeDomains: z
    .array(z.string().trim())
    .transform((domains) => domains.filter(Boolean))
    .optional()
    .catch(undefined),
});

type WebSearchArgs = z.infer<typeof webSearchArgsSchema>;

const parallelApiErrorSchema = z.union([
  z.object({
    type: z.literal("error"),
    error: z.object({
      message: z.string(),
    }),
  }),
  z.object({
    message: z.string(),
  }),
]);

type ParallelApiError = z.infer<typeof parallelApiErrorSchema>;

const searchResultSchema = z
  .object({
    url: z.string().catch(""),
    title: z.string().nullable().optional().catch(undefined),
    publish_date: z.string().nullable().optional().catch(undefined),
    excerpts: z.array(z.string()).nullable().optional().catch(undefined),
  })
  .passthrough();

const parallelSearchResponseSchema = z
  .object({
    results: z.array(searchResultSchema).catch([]),
    warnings: z.unknown().optional(),
    usage: z.unknown().optional(),
  })
  .passthrough();

type ParallelSearchResponse = z.infer<typeof parallelSearchResponseSchema>;

type SearchResult = ParallelSearchResponse["results"][number];

function parseArgs(raw: unknown): WebSearchArgs {
  const parsed = webSearchArgsSchema.safeParse(raw);
  if (!parsed.success) {
    return { objective: "" };
  }

  const args = parsed.data;
  const objective = args.objective.trim();
  const searchQueries = args.searchQueries?.map((q) => q.trim()).filter(Boolean);
  const includeDomains = args.includeDomains?.map((d) => d.trim()).filter(Boolean);
  const excludeDomains = args.excludeDomains?.map((d) => d.trim()).filter(Boolean);

  return {
    objective,
    ...(searchQueries && searchQueries.length > 0 && { searchQueries }),
    ...(args.maxResults !== undefined && { maxResults: args.maxResults }),
    ...(args.maxCharsPerResult !== undefined && { maxCharsPerResult: args.maxCharsPerResult }),
    ...(includeDomains && includeDomains.length > 0 && { includeDomains }),
    ...(excludeDomains && excludeDomains.length > 0 && { excludeDomains }),
  };
}

function extractParallelErrorMessage(raw: unknown): string | undefined {
  const parsed = parallelApiErrorSchema.safeParse(raw);
  if (!parsed.success) return undefined;

  const obj: ParallelApiError = parsed.data;

  if ("type" in obj && obj.type === "error") {
    const msg = obj.error.message.trim();
    return msg ? msg : undefined;
  }

  if ("message" in obj) {
    const msg = obj.message.trim();
    return msg ? msg : undefined;
  }

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
  const results = response.results;
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

            const responseParsed = parallelSearchResponseSchema.safeParse(parsed);
            if (!responseParsed.success) {
              throw new Error(
                `Parallel API response parse error: ${formatZodError(responseParsed.error)}`,
              );
            }

            const response = responseParsed.data;

            const text = formatSearchResults(response);
            const toolResult: ToolResultMessage = createToolResult(toolCall, text, false);
            const uiEvent: ToolUiEvent = {
              type: "web_search_finished",
              toolCallId: toolCall.id,
              objective: args.objective,
              status: "success",
              costUsd: estimateParallelSearchCostUsd(args.maxResults, response.results.length),
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
