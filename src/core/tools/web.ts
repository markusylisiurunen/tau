import { readFileSync } from "node:fs";
import type { Tool } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { z } from "zod";
import { type Config, getExaApiKey } from "../config/index.js";
import { formatZodError } from "../utils/zod.js";
import {
  buildCodeModeToolDescription,
  type CodeModeToolImplementation,
  createCodeModeToolDefinition,
  type ParsedCodeModeArguments,
} from "./code_mode.js";
import { type CodeModeBridgeRequest, executeCodeModeWorker } from "./code_mode_worker.js";
import type { ToolExecutionBackend } from "./execution_backend.js";
import type { AgentTool } from "./registry.js";
import { TOOL_NAME_WEB } from "./tool_names.js";
import { discoverAgentContent } from "./web_discovery.js";

const WEB_CODE_MODE_TIMEOUT_MS = 60_000;
const WEB_CODE_MODE_OUTPUT_TOKENS = 8_192;
const EXA_API_BASE_URL = "https://api.exa.ai";
const EXA_MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

const WEB_DESCRIPTION = buildCodeModeToolDescription({
  sdkGlobal: "web",
  introduction: [
    "Run a one-shot JavaScript program to search the web and retrieve page content.",
    "Use this tool only when the task requires open-web search or webpage extraction and no more direct or structured source can answer it.",
    "Before using it, prefer local files and repository data, purpose-built CLIs, first-party APIs and SDKs, and direct structured endpoints.",
    "A URL alone does not justify using this tool.",
    "For any GitHub URL, prefer gh for pull requests, issues, releases, repository metadata, and authenticated GitHub access; prefer git for source, diffs, status, and history available from a repository checkout.",
    "Use this tool only if those options cannot provide the needed information or the user explicitly asks to search the open web or inspect a webpage as a webpage.",
  ],
});

export const WEB_TOOL: Tool = {
  name: TOOL_NAME_WEB,
  description: WEB_DESCRIPTION,
  parameters: Type.Object(
    {
      code: Type.String({
        description: "JavaScript source to execute. Use console output to return information.",
      }),
    },
    { additionalProperties: false },
  ),
};

const webArgsSchema = z
  .object({
    code: z.string().trim().min(1),
  })
  .strict();

type WebArgs = z.infer<typeof webArgsSchema>;

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
  timeoutMs?: number;
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
const fetchOptionsSchema = z
  .object({
    mode: z.enum(["highlights", "text"]).default("highlights"),
    query: nonEmptyStringSchema.optional(),
    maxCharacters: z.number().int().min(1).max(10_000).optional(),
    maxAgeHours: maxAgeHoursSchema.optional(),
    subpages: z.number().int().min(0).max(100).optional(),
    subpageTarget: subpageTargetSchema.optional(),
    links: z.number().int().min(0).max(1_000).optional(),
  })
  .strict()
  .superRefine((options, context) => {
    if (options.mode === "text" && options.query !== undefined) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["query"],
        message: "is only supported in highlights mode",
      });
    }
  });

const documentation = readFileSync(
  new URL("../static/code_mode/web/documentation.md", import.meta.url),
  "utf8",
);
const sandboxRunnerUrl = new URL("../static/code_mode/web/sandbox_runner.mjs", import.meta.url);

async function readExaResponse(response: Response): Promise<string> {
  const contentLength = response.headers.get("content-length");
  if (contentLength !== null && Number(contentLength) > EXA_MAX_RESPONSE_BYTES) {
    await response.body?.cancel().catch(() => {});
    throw new Error("Exa response exceeded the 16 MiB limit");
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
      throw new Error("Exa response exceeded the 16 MiB limit");
    }
    chunks.push(Buffer.from(value));
  }
  return Buffer.concat(chunks, bytes).toString("utf8");
}

async function requestExa(
  apiKey: string,
  endpoint: "/search" | "/contents",
  body: Record<string, unknown>,
  signal: AbortSignal,
): Promise<unknown> {
  const response = await fetch(`${EXA_API_BASE_URL}${endpoint}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "User-Agent": "tau-web",
      "x-api-key": apiKey,
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
        throw new Error("Exa returned a non-JSON response");
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
    throw new Error(detail || `Exa request failed with HTTP ${response.status}`);
  }
  if (payload === undefined) {
    throw new Error("Exa returned an empty response");
  }
  return payload;
}

function createExaClient(apiKey: string): ExaClient {
  return {
    search: (query, options, signal) =>
      requestExa(apiKey, "/search", { query, ...options }, signal),
    getContents: (urls, options, signal) =>
      requestExa(apiKey, "/contents", { urls, ...options }, signal),
  };
}

function parseWebArguments(raw: unknown): ParsedCodeModeArguments<WebArgs> {
  const rawCode =
    typeof raw === "object" && raw !== null && typeof (raw as { code?: unknown }).code === "string"
      ? (raw as { code: string }).code
      : "";
  const subject =
    rawCode
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? "(invalid code)";
  const parsed = webArgsSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      error: formatZodError(parsed.error),
      code: rawCode,
      subject,
    };
  }
  return {
    ok: true,
    args: parsed.data,
    code: parsed.data.code,
    subject,
  };
}

function requireString(value: unknown, name: string): string {
  const parsed = nonEmptyStringSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(`${name} must be a non-empty string`);
  }
  return parsed.data;
}

function parseMethodOptions<T>(
  value: unknown,
  schema: z.ZodType<T>,
  method: "search" | "fetch",
): T {
  const parsed = schema.safeParse(value ?? {});
  if (!parsed.success) {
    throw new Error(`Invalid web.${method} options: ${formatZodError(parsed.error)}`);
  }
  return parsed.data;
}

function normalizeSearchArguments(args: unknown): [string, Record<string, unknown>] {
  if (!Array.isArray(args) || args.length < 1 || args.length > 2) {
    throw new Error("web.search expects query and optional options");
  }
  const query = requireString(args[0], "web.search query");
  const options = parseMethodOptions(args[1], searchOptionsSchema, "search");

  return [
    query,
    {
      type: "auto",
      ...(options.numResults !== undefined ? { numResults: options.numResults } : {}),
      ...(options.includeDomains ? { includeDomains: options.includeDomains } : {}),
      ...(options.excludeDomains ? { excludeDomains: options.excludeDomains } : {}),
      ...(options.startPublishedDate ? { startPublishedDate: options.startPublishedDate } : {}),
      ...(options.endPublishedDate ? { endPublishedDate: options.endPublishedDate } : {}),
      ...(options.category ? { category: options.category } : {}),
      ...(options.userLocation ? { userLocation: options.userLocation } : {}),
      contents: {
        highlights: true,
        ...(options.maxAgeHours !== undefined ? { maxAgeHours: options.maxAgeHours } : {}),
      },
    },
  ];
}

function normalizeFetchArguments(args: unknown): [string[], Record<string, unknown>] {
  if (!Array.isArray(args) || args.length < 1 || args.length > 2) {
    throw new Error("web.fetch expects urls and optional options");
  }
  const parsedUrls = fetchUrlsSchema.safeParse(args[0]);
  if (!parsedUrls.success) {
    throw new Error(`Invalid web.fetch urls: ${formatZodError(parsedUrls.error)}`);
  }
  const options = parseMethodOptions(args[1], fetchOptionsSchema, "fetch");
  const contentOptions =
    options.mode === "text"
      ? {
          text:
            options.maxCharacters === undefined ? true : { maxCharacters: options.maxCharacters },
        }
      : {
          highlights:
            options.query === undefined && options.maxCharacters === undefined
              ? true
              : {
                  ...(options.query ? { query: options.query } : {}),
                  ...(options.maxCharacters !== undefined
                    ? { maxCharacters: options.maxCharacters }
                    : {}),
                },
        };

  return [
    parsedUrls.data,
    {
      ...contentOptions,
      ...(options.maxAgeHours !== undefined ? { maxAgeHours: options.maxAgeHours } : {}),
      ...(options.subpages !== undefined ? { subpages: options.subpages } : {}),
      ...(options.subpageTarget ? { subpageTarget: options.subpageTarget } : {}),
      ...(options.links !== undefined ? { extras: { links: options.links } } : {}),
    },
  ];
}

type ExaResult = {
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
const exaResponseSchema = z
  .object({
    results: z.array(exaResultSchema),
    statuses: z.array(exaStatusSchema).default([]),
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
    title: result.title,
    url: result.url,
    ...(result.publishedDate !== undefined ? { publishedDate: result.publishedDate } : {}),
    ...(result.author !== undefined && result.author !== null ? { author: result.author } : {}),
    ...(result.text !== undefined ? { text: result.text } : {}),
    ...(result.highlights !== undefined ? { highlights: result.highlights } : {}),
    ...(result.subpages !== undefined ? { subpages: result.subpages.map(normalizeResult) } : {}),
    ...(result.extras?.links !== undefined ? { links: result.extras.links } : {}),
  };
}

function normalizeResponse(value: unknown): {
  results: Record<string, unknown>[];
  statuses: Record<string, unknown>[];
} {
  const parsed = exaResponseSchema.safeParse(value);
  if (!parsed.success) {
    throw new Error(`Invalid Exa response: ${formatZodError(parsed.error)}`);
  }
  return {
    results: parsed.data.results.map(normalizeResult),
    statuses: parsed.data.statuses.map(normalizeStatus),
  };
}

async function handleWebRequest(
  request: CodeModeBridgeRequest,
  exa: ExaClient | undefined,
  deps: WebToolDeps,
  backend: ToolExecutionBackend,
  signal: AbortSignal,
): Promise<unknown> {
  let args: unknown;
  try {
    args = JSON.parse(request.argsJson);
  } catch {
    throw new Error("invalid web bridge arguments");
  }

  switch (request.method) {
    case "discover": {
      if (!Array.isArray(args) || args.length !== 1) {
        throw new Error("web.discover expects one URL");
      }
      return deps.discover(backend, requireString(args[0], "web.discover url"), signal);
    }
    case "search": {
      if (!exa) throw new Error("Missing Exa API key.");
      const [query, options] = normalizeSearchArguments(args);
      return normalizeResponse(await exa.search(query, options, signal));
    }
    case "fetch": {
      if (!exa) throw new Error("Missing Exa API key.");
      const [urls, options] = normalizeFetchArguments(args);
      return normalizeResponse(await exa.getContents(urls, options, signal));
    }
    default:
      throw new Error(`unsupported web method '${request.method}'`);
  }
}

function executeWebProgram(
  code: string,
  exa: ExaClient | undefined,
  deps: WebToolDeps,
  backend: ToolExecutionBackend,
  signal: AbortSignal,
  timeoutMs: number,
) {
  return executeCodeModeWorker({
    sandboxRunnerUrl,
    workerData: { code, docs: documentation },
    signal,
    timeoutMs,
    handleRequest: (request, requestSignal) =>
      handleWebRequest(request, exa, deps, backend, requestSignal),
  });
}

const defaultDeps: WebToolDeps = {
  createExaClient,
  discover: discoverAgentContent,
};

export function createWebToolDefinition(
  backend: ToolExecutionBackend,
  config: Config,
  deps: WebToolDeps = defaultDeps,
): AgentTool {
  const timeoutMs = deps.timeoutMs ?? WEB_CODE_MODE_TIMEOUT_MS;
  const implementation: CodeModeToolImplementation<WebArgs> = {
    schema: WEB_TOOL,
    outputPolicy: { maxTokens: WEB_CODE_MODE_OUTPUT_TOKENS },
    timeoutMs,
    parseArguments: parseWebArguments,
    execute: async ({ code, signal, backend: executionBackend }) => {
      const apiKey = getExaApiKey(config);
      const exa = apiKey ? deps.createExaClient(apiKey) : undefined;
      return executeWebProgram(code, exa, deps, executionBackend, signal, timeoutMs);
    },
  };

  return createCodeModeToolDefinition(backend, implementation);
}
