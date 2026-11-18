import { z } from "zod";
import { type ApiKeysConfig, getExaApiKey } from "../config/index.js";
import type { ToolExecutionBackend } from "../tools/execution_backend.js";
import { discoverAgentContent } from "../tools/web_discovery.js";
import { formatZodError } from "../utils/zod.js";
import { type CodeModePackage, definePackage, method } from "./package.js";

const EXA_API_BASE_URL = "https://api.exa.ai";
const EXA_MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

const description = [
  "Search the web, discover agent-friendly resources, and retrieve page content.",
  "Use it when the task needs open-web search or page extraction and no more direct source can answer, such as local files and repository data, purpose-built CLIs, first-party APIs and SDKs, or structured endpoints.",
  "A URL alone is no reason to use @tau/web.",
  "For a GitHub URL, use gh for pull requests, issues, releases, repository metadata, and authenticated access, and use git for source, diffs, status, and history in a checkout.",
  "Use @tau/web for these only when those tools cannot provide what you need, or when the user explicitly asks to search the open web or inspect the page itself.",
].join(" ");

type ExaClient = {
  search(query: string, options: Record<string, unknown>, signal: AbortSignal): Promise<unknown>;
  getContents(
    urls: string[],
    options: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<unknown>;
};

type WebToolDeps = {
  createExaClient(apiKey: string): ExaClient;
  discover(backend: ToolExecutionBackend, value: string, signal: AbortSignal): Promise<unknown>;
};

const nonEmptyStringSchema = z.string().trim().min(1);
const nonEmptyStringArraySchema = z.array(nonEmptyStringSchema).min(1);
const domainFilterSchema = nonEmptyStringArraySchema.max(1_200);
const maxAgeHoursSchema = z.number().int().min(-1).max(720);
const fetchUrlSchema = nonEmptyStringSchema.max(2_048);
const subpageTargetSchema = z.union([
  nonEmptyStringSchema.max(100),
  z.array(nonEmptyStringSchema.max(100)).min(1).max(100),
]);
const SEARCH_CATEGORIES = [
  "company",
  "people",
  "publication",
  "news",
  "personal site",
  "financial report",
] as const;
const searchOptionsSchema = z
  .object({
    objective: nonEmptyStringSchema.max(4_096).optional(),
    numResults: z.number().int().min(1).max(100).optional(),
    includeDomains: domainFilterSchema.optional(),
    excludeDomains: domainFilterSchema.optional(),
    startPublishedDate: nonEmptyStringSchema.optional(),
    endPublishedDate: nonEmptyStringSchema.optional(),
    category: z.enum(SEARCH_CATEGORIES).optional(),
    userLocation: z
      .string()
      .trim()
      .regex(/^[a-z]{2}$/i, "must be a two-letter country code")
      .transform((value) => value.toUpperCase())
      .optional(),
    maxAgeHours: maxAgeHoursSchema.optional(),
  })
  .strict()
  .superRefine((options, context) => {
    if (
      (options.category === "company" || options.category === "people") &&
      (options.excludeDomains || options.startPublishedDate || options.endPublishedDate)
    ) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: `category '${options.category}' does not support excludeDomains or publication-date filters`,
      });
    }
  });
const fetchUrlsSchema = z.union([
  fetchUrlSchema.transform((url) => [url]),
  z.array(fetchUrlSchema).min(1).max(100),
]);
const maxCharacters = z.number().int().min(1).max(10_000);
const fetchOptionsSchema = z.strictObject({
  text: z
    .union([z.boolean(), z.strictObject({ maxCharacters: maxCharacters.optional() })])
    .optional(),
  highlights: z
    .union([
      z.boolean(),
      z.strictObject({
        maxCharacters: maxCharacters.optional(),
        query: nonEmptyStringSchema.optional(),
      }),
    ])
    .optional(),
  maxAgeHours: maxAgeHoursSchema.optional(),
  subpages: z.number().int().min(0).max(100).optional(),
  subpageTarget: subpageTargetSchema.optional(),
  extras: z.strictObject({ links: z.number().int().min(0).max(1_000).optional() }).optional(),
});

async function readExaResponse(response: Response): Promise<string> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null && Number(contentLength) > EXA_MAX_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => {});
    throw new Error("Web response exceeded the 16 MiB limit");
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  const chunks: Buffer[] = [];
  let bytes = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    bytes += value.byteLength;
    if (bytes > EXA_MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => {});
      throw new Error("Web response exceeded the 16 MiB limit");
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, bytes).toString("utf8");
}

async function requestExa(
  fetchImpl: typeof fetch,
  apiKey: string,
  endpoint: "/search" | "/contents",
  body: Record<string, unknown>,
  signal: AbortSignal,
): Promise<unknown> {
  const response = await fetchImpl(`${EXA_API_BASE_URL}${endpoint}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": "tau-web",
      "x-api-key": apiKey,
      ...(endpoint === "/search" ? { "Exa-Beta": "dynamic-highlights-2026-08-28" } : {}),
    },
    body: JSON.stringify(body),
    signal,
  });
  const responseText = await readExaResponse(response);
  let payload: unknown;
  if (responseText) {
    try {
      payload = JSON.parse(responseText);
    } catch {
      if (response.ok) {
        throw new Error("Web service returned a non-JSON response");
      }
    }
  }
  if (!response.ok) {
    const error =
      typeof payload === "object" && payload !== null
        ? (payload as { error?: unknown; message?: unknown })
        : undefined;
    const detail = [error?.error, error?.message]
      .filter((value): value is string => typeof value === "string" && Boolean(value.trim()))
      .join(". ");
    throw new Error(detail || `Web request failed with HTTP ${response.status}`);
  }
  if (payload === undefined) {
    throw new Error("Web service returned an empty response");
  }
  return payload;
}

export function createExaClient(apiKey: string, fetchImpl: typeof fetch = fetch): ExaClient {
  return {
    search: (query, options, signal) =>
      requestExa(fetchImpl, apiKey, "/search", { query, ...options }, signal),
    getContents: (urls, options, signal) =>
      requestExa(fetchImpl, apiKey, "/contents", { urls, ...options }, signal),
  };
}

function searchRequest(options: z.output<typeof searchOptionsSchema>): Record<string, unknown> {
  const { maxAgeHours, ...filters } = options;
  return {
    type: "auto",
    ...filters,
    contents: {
      highlights: { dynamic: true },
      ...(maxAgeHours !== undefined ? { maxAgeHours } : {}),
    },
  };
}

function fetchRequest(options: z.output<typeof fetchOptionsSchema>): Record<string, unknown> {
  return {
    ...(options.text === undefined && options.highlights === undefined ? { highlights: true } : {}),
    ...options,
  };
}

type ExaResult = {
  id?: string;
  title: string;
  url: string;
  publishedDate?: string;
  author?: string | null;
  text?: string;
  highlights?: string[];
  subpages?: ExaResult[];
  extras?: { links?: string[] };
};

const exaResultSchema: z.ZodType<ExaResult> = z.lazy(() =>
  z
    .object({
      id: z.string().optional(),
      title: z.string(),
      url: z.string(),
      publishedDate: z.string().optional(),
      author: z.string().nullable().optional(),
      text: z.string().optional(),
      highlights: z.array(z.string()).optional(),
      subpages: z.array(exaResultSchema).optional(),
      extras: z
        .object({ links: z.array(z.string()).optional() })
        .strip()
        .optional(),
    })
    .strip(),
);
const exaStatusSchema = z
  .object({
    id: z.string(),
    status: z.enum(["success", "error"]),
    error: z
      .object({
        tag: z.string().optional(),
        httpStatusCode: z.number().int().nullable().optional(),
      })
      .strip()
      .nullable()
      .optional(),
  })
  .strip();
const exaNoticeSchema = z
  .object({
    code: z.string(),
    path: z.string(),
    message: z.string(),
    details: z.record(z.string(), z.unknown()).optional(),
  })
  .strip();
const exaResponseSchema = z
  .object({
    results: z.array(exaResultSchema),
    statuses: z.array(exaStatusSchema).default([]),
    notices: z.array(exaNoticeSchema).default([]),
  })
  .strip();

type ExaStatus = z.infer<typeof exaStatusSchema>;

function normalizeStatus(status: ExaStatus): Record<string, unknown> {
  const normalized: Record<string, unknown> = {
    id: status.id,
    status: status.status,
  };
  if (status.error) {
    normalized.error = {
      ...(status.error.tag !== undefined ? { tag: status.error.tag } : {}),
      ...(status.error.httpStatusCode !== undefined && status.error.httpStatusCode !== null
        ? { httpStatusCode: status.error.httpStatusCode }
        : {}),
    };
  }
  return normalized;
}

function normalizeResult(result: ExaResult): Record<string, unknown> {
  return {
    ...(result.id !== undefined ? { id: result.id } : {}),
    title: result.title,
    url: result.url,
    ...(result.publishedDate !== undefined ? { publishedDate: result.publishedDate } : {}),
    ...(result.author !== undefined && result.author !== null ? { author: result.author } : {}),
    ...(result.text !== undefined ? { text: result.text } : {}),
    ...(result.highlights !== undefined ? { highlights: result.highlights } : {}),
    ...(result.subpages !== undefined ? { subpages: result.subpages.map(normalizeResult) } : {}),
    ...(result.extras?.links !== undefined ? { extras: { links: result.extras.links } } : {}),
  };
}

function normalizeResponse(value: unknown): {
  results: Record<string, unknown>[];
  statuses: Record<string, unknown>[];
  notices: z.infer<typeof exaNoticeSchema>[];
} {
  const parsed = exaResponseSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(`Invalid web response: ${formatZodError(parsed.error)}`);
  }
  return {
    results: parsed.data.results.map(normalizeResult),
    statuses: parsed.data.statuses.map(normalizeStatus),
    notices: parsed.data.notices,
  };
}

const defaultDeps: WebToolDeps = { createExaClient, discover: discoverAgentContent };

export function createWebPackage(
  backend: ToolExecutionBackend,
  config: ApiKeysConfig,
  deps: WebToolDeps = defaultDeps,
): CodeModePackage {
  let exa: ExaClient | undefined;
  const client = () => {
    const apiKey = getExaApiKey(config);
    if (apiKey && !exa) exa = deps.createExaClient(apiKey);
    if (!exa) throw new Error("Web search and fetch are not configured.");
    return exa;
  };
  return definePackage("web", description, {
    search: method(
      z.tuple([nonEmptyStringSchema, searchOptionsSchema.optional()]),
      async ([query, options], { signal }) =>
        normalizeResponse(await client().search(query, searchRequest(options ?? {}), signal)),
    ),
    fetch: method(
      z.tuple([fetchUrlsSchema, fetchOptionsSchema.optional()]),
      async ([urls, options], { signal }) =>
        normalizeResponse(await client().getContents(urls, fetchRequest(options ?? {}), signal)),
    ),
    discover: method(z.tuple([nonEmptyStringSchema]), ([url], { signal }) =>
      deps.discover(backend, url, signal),
    ),
  });
}
