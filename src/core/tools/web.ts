import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { createInterface } from "node:readline";
import type { Readable } from "node:stream";
import type { Tool } from "@earendil-works/pi-ai";
import Exa from "exa-js";
import { Type } from "typebox";
import { z } from "zod";
import { getExaApiKey } from "../config/index.js";
import { truncateToBytesFromEnd } from "../utils/truncate.js";
import { formatZodError } from "../utils/zod.js";
import {
  type CodeModeToolImplementation,
  createCodeModeToolDefinition,
  type ParsedCodeModeArguments,
} from "./code_mode.js";
import {
  type BashExecutionResult,
  DEFAULT_COMMAND_CAPTURE_BYTES,
  type ToolExecutionBackend,
} from "./execution_backend.js";
import type { ToolDefinition } from "./registry.js";
import { TOOL_NAME_WEB } from "./tool_names.js";
import { discoverAgentContent } from "./web_discovery.js";

const WEB_CODE_MODE_TIMEOUT_MS = 60_000;
const WEB_CODE_MODE_OUTPUT_TOKENS = 8_192;
const WEB_SANDBOX_KILL_GRACE_MS = 2_000;

const WEB_DESCRIPTION = [
  "Run a one-shot JavaScript program to search the web and retrieve page content.",
  "Use this tool only when the user asks to browse or search the web, provides a URL, or otherwise clearly implies that web access is needed.",
  "For direct URLs, use web.discover first and print a concise discovery report before deciding in the next turn whether to use curl, web.fetch, or another approach.",
  "Top-level await is supported. The program receives web, docs, and console globals.",
  "Only text written through console methods is returned; program return values are ignored.",
  "Format results as concise, readable plain text instead of dumping raw JSON. Select only relevant fields when possible. When all fields are needed, still flatten and label them compactly rather than serializing the response object. Emit JSON only when the user explicitly requests JSON or another machine-readable result.",
  "To discover the available web APIs, run a program that prints docs with console.log(docs), then use that documentation in the next turn.",
].join(" ");

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
  search(query: string, options: Record<string, unknown>): Promise<unknown>;
  getContents(urls: string[], options: Record<string, unknown>): Promise<unknown>;
};

type WebToolDeps = {
  createExaClient(apiKey: string): ExaClient;
  discover(backend: ToolExecutionBackend, value: string, signal: AbortSignal): Promise<unknown>;
};

type WebBridgeRequest = {
  id: number;
  method: string;
  argsJson: string;
};

const nonEmptyStringSchema = z.string().trim().min(1);
const nonEmptyStringArraySchema = z.array(nonEmptyStringSchema).min(1);
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
    includeDomains: nonEmptyStringArraySchema.optional(),
    excludeDomains: nonEmptyStringArraySchema.optional(),
    startPublishedDate: nonEmptyStringSchema.optional(),
    endPublishedDate: nonEmptyStringSchema.optional(),
    category: z.enum(SEARCH_CATEGORIES).optional(),
    userLocation: z
      .string()
      .trim()
      .regex(/^[a-z]{2}$/i, "must be a two-letter country code")
      .transform((value) => value.toUpperCase())
      .optional(),
    maxAgeHours: z.number().int().min(-1).optional(),
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
  nonEmptyStringSchema.transform((url) => [url]),
  nonEmptyStringArraySchema,
]);
const fetchOptionsSchema = z
  .object({
    mode: z.enum(["highlights", "text"]).default("highlights"),
    query: nonEmptyStringSchema.optional(),
    maxCharacters: z.number().int().positive().optional(),
    maxAgeHours: z.number().int().min(-1).optional(),
    subpages: z.number().int().nonnegative().optional(),
    subpageTarget: z.union([nonEmptyStringSchema, nonEmptyStringArraySchema]).optional(),
    links: z.number().int().nonnegative().optional(),
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
const sandboxRunnerSource = readFileSync(
  new URL("../static/code_mode/web/sandbox_runner.mjs", import.meta.url),
  "utf8",
).replace('import "ses";', `import ${JSON.stringify(import.meta.resolve("ses"))};`);

function parseWebArguments(raw: unknown): ParsedCodeModeArguments<WebArgs> {
  const rawCode =
    typeof raw === "object" && raw !== null && typeof (raw as { code?: unknown }).code === "string"
      ? (raw as { code: string }).code
      : "";
  const displayTarget =
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
      displayTarget,
    };
  }
  return {
    ok: true,
    args: parsed.data,
    code: parsed.data.code,
    displayTarget,
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
    throw new Error("web.fetch urls must be a non-empty string or string array");
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

function serializeError(error: unknown): { name?: string; message: string } {
  if (error instanceof Error) {
    return { name: error.name, message: error.message };
  }
  return { message: String(error) };
}

async function handleWebRequest(
  request: WebBridgeRequest,
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
      return normalizeResponse(await exa.search(query, options));
    }
    case "fetch": {
      if (!exa) throw new Error("Missing Exa API key.");
      const [urls, options] = normalizeFetchArguments(args);
      return normalizeResponse(await exa.getContents(urls, options));
    }
    default:
      throw new Error(`unsupported web method '${request.method}'`);
  }
}

function appendCapture(current: string, chunk: string): string {
  return truncateToBytesFromEnd(current + chunk, DEFAULT_COMMAND_CAPTURE_BYTES);
}

function executeWebProgram(
  code: string,
  exa: ExaClient | undefined,
  deps: WebToolDeps,
  backend: ToolExecutionBackend,
  signal: AbortSignal,
): Promise<BashExecutionResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--input-type=module", "--eval", sandboxRunnerSource], {
      env: {
        ...(process.env.LANG ? { LANG: process.env.LANG } : {}),
        ...(process.env.LC_ALL ? { LC_ALL: process.env.LC_ALL } : {}),
        ...(process.env.TZ ? { TZ: process.env.TZ } : {}),
      },
      stdio: ["pipe", "pipe", "pipe", "pipe"],
    });
    const rpcOutput = child.stdio[3];
    if (!rpcOutput) {
      child.kill();
      reject(new Error("failed to create web sandbox bridge"));
      return;
    }

    let stdout = "";
    let stderr = "";
    let output = "";
    let capturedBytes = 0;
    let truncated = false;
    let timedOut = false;
    let aborted = false;
    let settled = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;

    const capture = (target: "stdout" | "stderr", chunk: Buffer): void => {
      capturedBytes += chunk.length;
      if (capturedBytes > DEFAULT_COMMAND_CAPTURE_BYTES) truncated = true;
      const text = chunk.toString("utf8");
      output = appendCapture(output, text);
      if (target === "stdout") {
        stdout = appendCapture(stdout, text);
      } else {
        stderr = appendCapture(stderr, text);
      }
    };

    const terminate = (reason: "abort" | "timeout"): void => {
      if (reason === "abort") aborted = true;
      if (reason === "timeout") timedOut = true;
      child.kill("SIGTERM");
      if (!killTimer) {
        killTimer = setTimeout(() => child.kill("SIGKILL"), WEB_SANDBOX_KILL_GRACE_MS);
        killTimer.unref?.();
      }
    };

    const abortHandler = (): void => terminate("abort");
    if (signal.aborted) {
      abortHandler();
    } else {
      signal.addEventListener("abort", abortHandler, { once: true });
    }
    const timeout = setTimeout(() => terminate("timeout"), WEB_CODE_MODE_TIMEOUT_MS);
    timeout.unref?.();

    child.stdout.on("data", (chunk: Buffer) => capture("stdout", chunk));
    child.stderr.on("data", (chunk: Buffer) => capture("stderr", chunk));

    const rpcLines = createInterface({ input: rpcOutput as Readable, crlfDelay: Infinity });
    rpcLines.on("line", (line) => {
      void (async () => {
        let request: WebBridgeRequest | undefined;
        try {
          const parsed = JSON.parse(line) as Partial<WebBridgeRequest>;
          if (
            typeof parsed.id !== "number" ||
            typeof parsed.method !== "string" ||
            typeof parsed.argsJson !== "string"
          ) {
            throw new Error("invalid web sandbox request");
          }
          request = parsed as WebBridgeRequest;
          const value = await handleWebRequest(request, exa, deps, backend, signal);
          child.stdin.write(`${JSON.stringify({ id: request.id, ok: true, value })}\n`);
        } catch (error) {
          if (!child.stdin.writable) return;
          child.stdin.write(
            `${JSON.stringify({
              id: request?.id,
              ok: false,
              error: serializeError(error),
            })}\n`,
          );
        }
      })();
    });

    child.once("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      signal.removeEventListener("abort", abortHandler);
      rpcLines.close();
      reject(error);
    });
    child.once("close", (exitCode, closeSignal) => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      if (killTimer) clearTimeout(killTimer);
      signal.removeEventListener("abort", abortHandler);
      rpcLines.close();
      resolve({
        output,
        stdout,
        stderr,
        exitCode,
        truncated,
        timedOut,
        aborted,
        closeSignal,
      });
    });

    child.stdin.on("error", () => {});
    child.stdin.write(`${JSON.stringify({ code, docs: documentation })}\n`);
  });
}

const ExaConstructor = Exa as unknown as new (apiKey: string) => ExaClient;

const defaultDeps: WebToolDeps = {
  createExaClient: (apiKey) => new ExaConstructor(apiKey),
  discover: discoverAgentContent,
};

export function createWebToolDefinition(
  backend: ToolExecutionBackend,
  deps: WebToolDeps = defaultDeps,
): ToolDefinition {
  const implementation: CodeModeToolImplementation<WebArgs> = {
    schema: WEB_TOOL,
    outputPolicy: { maxTokens: WEB_CODE_MODE_OUTPUT_TOKENS },
    parseArguments: parseWebArguments,
    execute: async ({ code, context, signal, backend: executionBackend }) => {
      const apiKey = getExaApiKey(context.config);
      const exa = apiKey ? deps.createExaClient(apiKey) : undefined;
      return executeWebProgram(code, exa, deps, executionBackend, signal);
    },
  };

  return createCodeModeToolDefinition(backend, implementation);
}
