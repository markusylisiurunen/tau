import type { Tool, ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { z } from "zod";
import type { Config } from "../config/index.js";
import { getParallelApiKey } from "../config/index.js";
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
import { TOOL_NAME_WEB_SEARCH } from "./tool_names.js";

const WEB_SEARCH_DESCRIPTION = [
  "Search the web for relevant sources.",
  "Use this to discover good candidate URLs before fetching content with web_fetch.",
  "Provide a clear objective describing what you are trying to find (preferred sources, recency, and constraints help).",
  "Optionally provide searchQueries for keyword-style guidance.",
  "Use includeDomains/excludeDomains to enforce source policies when needed.",
  "You may adjust maxResults and maxCharsPerResult to balance coverage vs token usage.",
].join(" ");

const WEB_SEARCH_OBJECTIVE_DESCRIPTION = "What you are trying to find out.";
const WEB_SEARCH_SEARCH_QUERIES_DESCRIPTION = "Optional keyword-style queries to guide the search.";
const WEB_SEARCH_MAX_RESULTS_DESCRIPTION = "Max number of results to return.";
const WEB_SEARCH_MAX_CHARS_PER_RESULT_DESCRIPTION = "Max characters per result excerpt.";
const WEB_SEARCH_INCLUDE_DOMAINS_DESCRIPTION = "List of domains to include in search.";
const WEB_SEARCH_EXCLUDE_DOMAINS_DESCRIPTION = "List of domains to exclude from search.";

export const WEB_SEARCH_TOOL: Tool = {
  name: TOOL_NAME_WEB_SEARCH,
  description: WEB_SEARCH_DESCRIPTION,
  parameters: Type.Object(
    {
      objective: Type.String({
        description: WEB_SEARCH_OBJECTIVE_DESCRIPTION,
      }),
      searchQueries: Type.Optional(
        Type.Array(Type.String(), {
          description: WEB_SEARCH_SEARCH_QUERIES_DESCRIPTION,
        }),
      ),
      maxResults: Type.Optional(
        Type.Integer({
          description: WEB_SEARCH_MAX_RESULTS_DESCRIPTION,
          minimum: 1,
          maximum: 50,
        }),
      ),
      maxCharsPerResult: Type.Optional(
        Type.Integer({
          description: WEB_SEARCH_MAX_CHARS_PER_RESULT_DESCRIPTION,
          minimum: 200,
          maximum: 50_000,
        }),
      ),
      includeDomains: Type.Optional(
        Type.Array(Type.String(), {
          description: WEB_SEARCH_INCLUDE_DOMAINS_DESCRIPTION,
        }),
      ),
      excludeDomains: Type.Optional(
        Type.Array(Type.String(), {
          description: WEB_SEARCH_EXCLUDE_DOMAINS_DESCRIPTION,
        }),
      ),
    },
    { additionalProperties: false },
  ),
};

const webSearchArgsSchema = z.object({
  objective: z.string().trim().min(1),
  searchQueries: z.array(z.string().trim().min(1)).min(1).optional(),
  maxResults: z.number().int().min(1).max(50).optional(),
  maxCharsPerResult: z.number().int().min(200).max(50_000).optional(),
  includeDomains: z.array(z.string().trim().min(1)).min(1).optional(),
  excludeDomains: z.array(z.string().trim().min(1)).min(1).optional(),
});

type WebSearchArgs = z.infer<typeof webSearchArgsSchema>;

const searchResultSchema = z
  .object({
    url: z.string().min(1),
    title: z.string().nullable().optional(),
    publish_date: z.string().nullable().optional(),
    excerpts: z.array(z.string()).nullable().optional(),
  })
  .passthrough();

const parallelSearchResponseSchema = z
  .object({
    results: z.array(searchResultSchema),
    warnings: z.unknown().optional(),
    usage: z.unknown().optional(),
  })
  .passthrough();

type ParallelSearchResponse = z.infer<typeof parallelSearchResponseSchema>;

type SearchResult = ParallelSearchResponse["results"][number];

function parseArgs(raw: unknown): { ok: true; data: WebSearchArgs } | { ok: false; error: string } {
  const parsed = webSearchArgsSchema.safeParse(raw);
  if (!parsed.success) {
    return { ok: false, error: formatZodError(parsed.error) };
  }
  return { ok: true, data: parsed.data };
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

function formatSearchResults(response: ParallelSearchResponse): TruncationResult {
  const results = response.results;
  if (results.length === 0) {
    const content = "No results.";
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
      maxTokens: 8192,
    };
  }

  const lines: string[] = [];
  for (const r of results) {
    const title = r.title?.trim() || "(No title)";
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
  return truncateForTokens(formatted, {
    maxTokens: 8192,
    strategy: "middle",
  });
}

export function createWebSearchToolDefinition(config: Config): ToolDefinition {
  return {
    schema: WEB_SEARCH_TOOL,
    async dispatch(
      toolCall: ToolCall,
      signal?: AbortSignal,
    ): Promise<ToolDispatchResult | ToolDispatchResultWithPhases> {
      const parsedArgs = parseArgs(toolCall.arguments);
      const objective = parsedArgs.ok ? parsedArgs.data.objective : "";
      const headerTarget = objective || "(invalid arguments)";

      const blocked = (reason: string): ToolDispatchResult => {
        const toolResult = createToolError(toolCall, reason);
        const uiEvent: ToolUiEvent = {
          type: "web_search_finished",
          toolCallId: toolCall.id,
          objective: objective || "(invalid objective)",
          headerTarget,
          status: "error",
          message: reason,
        };
        return { kind: "single", toolResult, uiEvent };
      };

      if (!parsedArgs.ok) {
        return blocked(`Invalid arguments: ${parsedArgs.error}`);
      }

      const args = parsedArgs.data;

      const apiKey = getParallelApiKey(config);
      if (!apiKey) {
        return blocked("Missing Parallel API key.");
      }

      return {
        kind: "phased",
        startedUiEvent: {
          type: "web_search_started",
          toolCallId: toolCall.id,
          objective: args.objective,
          headerTarget,
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
                extractParallelErrorMessage(parsed) || res.statusText || "Request failed.";
              throw new Error(`Parallel API error (${res.status}): ${details}`);
            }

            const responseParsed = parallelSearchResponseSchema.safeParse(parsed);
            if (!responseParsed.success) {
              throw new Error(
                `Parallel API response parse error: ${formatZodError(responseParsed.error)}`,
              );
            }

            const response = responseParsed.data;

            const resultText = formatSearchResults(response);
            const toolResult: ToolResultMessage = createToolResult(
              toolCall,
              resultText.content,
              false,
            );
            const uiEvent: ToolUiEvent = {
              type: "web_search_finished",
              toolCallId: toolCall.id,
              objective: args.objective,
              headerTarget,
              status: "success",
              costUsd: estimateParallelSearchCostUsd(args.maxResults, response.results.length),
              message: resultText.truncated ? TRUNCATION_MARKER : undefined,
            };
            return { kind: "single", toolResult, uiEvent };
          } catch (e) {
            const msg = e instanceof Error ? e.message : String(e);
            const reason = msg.trim() ? msg : "Request failed.";
            const toolResult = createToolError(toolCall, reason);
            const uiEvent: ToolUiEvent = {
              type: "web_search_finished",
              toolCallId: toolCall.id,
              objective: args.objective,
              headerTarget,
              status: "error",
              message: reason,
            };
            return { kind: "single", toolResult, uiEvent };
          }
        })(),
      };
    },
  };
}
