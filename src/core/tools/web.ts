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
  "For documentation URLs, use web.discover first and print a concise discovery report before deciding in the next turn whether to use curl, web.fetch, or another approach.",
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
  discover(value: string): Promise<unknown>;
};

type WebBridgeRequest = {
  id: number;
  method: string;
  argsJson: string;
};

const SEARCH_OPTION_KEYS = new Set([
  "numResults",
  "includeDomains",
  "excludeDomains",
  "startPublishedDate",
  "endPublishedDate",
  "category",
  "userLocation",
  "maxAgeHours",
]);
const FETCH_OPTION_KEYS = new Set([
  "mode",
  "query",
  "maxCharacters",
  "maxAgeHours",
  "subpages",
  "subpageTarget",
  "links",
]);
const SEARCH_CATEGORIES = new Set([
  "company",
  "people",
  "publication",
  "news",
  "personal site",
  "financial report",
]);

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

function parseOptions(
  value: unknown,
  allowedKeys: Set<string>,
  method: string,
): Record<string, unknown> {
  if (value === undefined) return {};
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`web.${method} options must be an object`);
  }
  for (const key of Object.keys(value)) {
    if (!allowedKeys.has(key)) {
      throw new Error(`web.${method} does not support option '${key}'`);
    }
  }
  return value as Record<string, unknown>;
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${name} must be a non-empty string`);
  }
  return value.trim();
}

function optionalInteger(
  value: unknown,
  name: string,
  minimum: number,
  maximum?: number,
): number | undefined {
  if (value === undefined) return undefined;
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < minimum ||
    (maximum !== undefined && value > maximum)
  ) {
    const range =
      maximum === undefined ? `at least ${minimum}` : `between ${minimum} and ${maximum}`;
    throw new Error(`${name} must be an integer ${range}`);
  }
  return value;
}

function optionalStringArray(value: unknown, name: string): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value) || value.length === 0) {
    throw new Error(`${name} must be a non-empty string array`);
  }
  return value.map((entry, index) => requireString(entry, `${name}[${index}]`));
}

function normalizeSearchArguments(args: unknown): [string, Record<string, unknown>] {
  if (!Array.isArray(args) || args.length < 1 || args.length > 2) {
    throw new Error("web.search expects query and optional options");
  }
  const query = requireString(args[0], "web.search query");
  const options = parseOptions(args[1], SEARCH_OPTION_KEYS, "search");
  const numResults = optionalInteger(options.numResults, "web.search numResults", 1, 100);
  const includeDomains = optionalStringArray(options.includeDomains, "web.search includeDomains");
  const excludeDomains = optionalStringArray(options.excludeDomains, "web.search excludeDomains");
  const startPublishedDate =
    options.startPublishedDate === undefined
      ? undefined
      : requireString(options.startPublishedDate, "web.search startPublishedDate");
  const endPublishedDate =
    options.endPublishedDate === undefined
      ? undefined
      : requireString(options.endPublishedDate, "web.search endPublishedDate");
  const category = options.category;
  if (category !== undefined && !SEARCH_CATEGORIES.has(String(category))) {
    throw new Error(`web.search category must be one of: ${[...SEARCH_CATEGORIES].join(", ")}`);
  }
  if (
    (category === "company" || category === "people") &&
    (excludeDomains || startPublishedDate || endPublishedDate)
  ) {
    throw new Error(
      `web.search category '${category}' does not support excludeDomains or publication-date filters`,
    );
  }
  let userLocation: string | undefined;
  if (options.userLocation !== undefined) {
    userLocation = requireString(options.userLocation, "web.search userLocation").toUpperCase();
    if (!/^[A-Z]{2}$/.test(userLocation)) {
      throw new Error("web.search userLocation must be a two-letter country code");
    }
  }
  const maxAgeHours = optionalInteger(options.maxAgeHours, "web.search maxAgeHours", -1);

  return [
    query,
    {
      type: "auto",
      ...(numResults !== undefined ? { numResults } : {}),
      ...(includeDomains ? { includeDomains } : {}),
      ...(excludeDomains ? { excludeDomains } : {}),
      ...(startPublishedDate ? { startPublishedDate } : {}),
      ...(endPublishedDate ? { endPublishedDate } : {}),
      ...(category ? { category } : {}),
      ...(userLocation ? { userLocation } : {}),
      contents: {
        highlights: true,
        ...(maxAgeHours !== undefined ? { maxAgeHours } : {}),
      },
    },
  ];
}

function normalizeFetchArguments(args: unknown): [string[], Record<string, unknown>] {
  if (!Array.isArray(args) || args.length < 1 || args.length > 2) {
    throw new Error("web.fetch expects urls and optional options");
  }
  const rawUrls = typeof args[0] === "string" ? [args[0]] : args[0];
  const urls = optionalStringArray(rawUrls, "web.fetch urls");
  if (!urls) throw new Error("web.fetch urls must be a non-empty string or string array");
  const options = parseOptions(args[1], FETCH_OPTION_KEYS, "fetch");
  const mode = options.mode ?? "highlights";
  if (mode !== "highlights" && mode !== "text") {
    throw new Error("web.fetch mode must be 'highlights' or 'text'");
  }
  const query =
    options.query === undefined ? undefined : requireString(options.query, "web.fetch query");
  if (mode === "text" && query !== undefined) {
    throw new Error("web.fetch query is only supported in highlights mode");
  }
  const maxCharacters = optionalInteger(options.maxCharacters, "web.fetch maxCharacters", 1);
  const maxAgeHours = optionalInteger(options.maxAgeHours, "web.fetch maxAgeHours", -1);
  const subpages = optionalInteger(options.subpages, "web.fetch subpages", 0);
  const subpageTarget =
    typeof options.subpageTarget === "string"
      ? requireString(options.subpageTarget, "web.fetch subpageTarget")
      : optionalStringArray(options.subpageTarget, "web.fetch subpageTarget");
  const links = optionalInteger(options.links, "web.fetch links", 0);

  const contentOptions =
    mode === "text"
      ? { text: maxCharacters === undefined ? true : { maxCharacters } }
      : {
          highlights:
            query === undefined && maxCharacters === undefined
              ? true
              : {
                  ...(query ? { query } : {}),
                  ...(maxCharacters !== undefined ? { maxCharacters } : {}),
                },
        };

  return [
    urls,
    {
      ...contentOptions,
      ...(maxAgeHours !== undefined ? { maxAgeHours } : {}),
      ...(subpages !== undefined ? { subpages } : {}),
      ...(subpageTarget ? { subpageTarget } : {}),
      ...(links !== undefined ? { extras: { links } } : {}),
    },
  ];
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : undefined;
}

function normalizeStatus(value: unknown): Record<string, unknown> {
  const status = asRecord(value);
  const normalized: Record<string, unknown> = {
    id: status?.id,
    status: status?.status,
  };
  const error = asRecord(status?.error);
  if (error) {
    normalized.error = {
      tag: error.tag,
      httpStatusCode: error.httpStatusCode,
    };
  }
  return normalized;
}

function normalizeResult(value: unknown): Record<string, unknown> {
  const result = asRecord(value);
  const normalized: Record<string, unknown> = {
    title: result?.title,
    url: result?.url,
  };
  for (const key of ["publishedDate", "author", "text", "highlights"]) {
    if (result?.[key] !== undefined) normalized[key] = result[key];
  }
  if (Array.isArray(result?.subpages)) {
    normalized.subpages = result.subpages.map(normalizeResult);
  }
  const extras = asRecord(result?.extras);
  if (Array.isArray(extras?.links)) {
    normalized.links = extras.links;
  }
  return normalized;
}

function normalizeResponse(value: unknown): {
  results: Record<string, unknown>[];
  statuses: Record<string, unknown>[];
} {
  const response = asRecord(value);
  return {
    results: Array.isArray(response?.results) ? response.results.map(normalizeResult) : [],
    statuses: Array.isArray(response?.statuses) ? response.statuses.map(normalizeStatus) : [],
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
      return deps.discover(requireString(args[0], "web.discover url"));
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
          const value = await handleWebRequest(request, exa, deps);
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
  const implementation: CodeModeToolImplementation<WebArgs, undefined> = {
    schema: WEB_TOOL,
    label: "web",
    outputPolicy: { maxTokens: WEB_CODE_MODE_OUTPUT_TOKENS },
    parseArguments: parseWebArguments,
    prepare: async () => undefined,
    execute: async ({ code, context, signal }) => {
      const apiKey = getExaApiKey(context.config);
      const exa = apiKey ? deps.createExaClient(apiKey) : undefined;
      return executeWebProgram(code, exa, deps, signal);
    },
  };

  return createCodeModeToolDefinition(backend, implementation);
}
