import { readFileSync } from "node:fs";
import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import {
  CODE_MODE_MAX_BRIDGE_PAYLOAD_BYTES,
  executeCodeModeWorker,
} from "../core/tools/code_mode_worker.js";
import { bytesToTokens } from "../core/utils/token.js";
import { formatBytes, truncateForTokens } from "../core/utils/truncate.js";
import { SESSION_PROTOCOL_MAX_CLIENT_TOOL_IMAGES } from "../protocol/session_protocol.js";
import type { TauSdkClientToolExecutionEnvironment } from "../sdk/types.js";
import { codeModeError } from "./errors.js";
import { prepareCodeModeImage } from "./images.js";
import { CodeModeOutput } from "./output.js";
import { decodeBridgeValue, encodeBridgeValue } from "./wire.js";

export const TAU_CODE_MODE_DEFAULT_TIMEOUT_MS = 60_000;
export const TAU_CODE_MODE_DEFAULT_MAX_OUTPUT_TOKENS = 8_192;
export const TAU_CODE_MODE_MAX_OUTPUT_TOKENS = 65_536;
export const CODE_MODE_MAX_OUTPUT_TOKENS_DESCRIPTION =
  "Maximum estimated output tokens to return. Defaults to 8192. Printing selected results usually works better than raising this. Set it only when you need more output, to a value between 8192 and 16384. Go above 16384, up to 65536, only when the user explicitly asks for more output. Output over the limit is cut from the middle. Its side effects have already happened, so read saved output instead of running a program with side effects again.";

const CORE_PACKAGE = "@tau/core";
const sandboxRunnerUrl = new URL("../core/static/code_mode/sandbox_runner.mjs", import.meta.url);
const coreDocumentationUrl = new URL("../core/static/code_mode/docs/core.md", import.meta.url);
const toolPackageNamePattern = /^[A-Za-z][A-Za-z0-9_-]{0,63}$/;
const exportNamePattern = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const unsafeApiKeys = new Set(["__proto__", "constructor", "prototype"]);
let coreDocumentation: string | undefined;

export type TauCodeModeJsonValue =
  | null
  | boolean
  | number
  | string
  | TauCodeModeJsonValue[]
  | { [key: string]: TauCodeModeJsonValue };

export type TauCodeModeInvocation = {
  sessionId: string;
  agentId: string;
  callId: string;
};

export type TauCodeModeHandlerContext = {
  signal: AbortSignal;
  invocation: TauCodeModeInvocation | null;
  executionEnvironment: TauSdkClientToolExecutionEnvironment | null;
};

export type TauCodeModeHandler = (
  args: unknown[],
  context: TauCodeModeHandlerContext,
) => unknown | Promise<unknown>;

export type TauCodeModeApi = {
  [key: string]: TauCodeModeApi | TauCodeModeHandler;
};

/** A module that programs import by name. Its documentation is what `docs(name)` returns. */
export type TauCodeModePackage = {
  name: string;
  documentation: string;
  api: TauCodeModeApi;
};

export type TauCodeModeExecutionStatus = "succeeded" | "failed" | "timed-out" | "cancelled";

type TauCodeModeProjection = {
  content: string;
  truncated: boolean;
  truncatedBy: "lines" | "bytes" | null;
  totalLines: number;
  totalBytes: number;
  outputLines: number;
  outputBytes: number;
  maxLines: number;
  maxTokens: number;
};

/** How the program ended. Its output arrives through `onOutput` while it runs. */
export type CodeModeWorkerResult = {
  exitCode: number | null; // null after a timeout or cancellation
  truncated: boolean; // output beyond the capture limit was dropped
  timedOut: boolean;
  aborted: boolean;
};

export type TauCodeModePersistOutput = (
  output: {
    content: string;
    captureTruncated: boolean;
    contextTruncated: boolean;
    status: TauCodeModeExecutionStatus;
  },
  context: TauCodeModeHandlerContext,
) => Promise<{ path: string } | undefined>;

/** A code-mode tool whose programs import `api` from the module `name`, next to `@tau/core`. */
export type TauCodeModeDefinition = {
  name: string;
  documentation: string;
  api: TauCodeModeApi;
  timeoutMs?: number;
  persistOutput?: TauCodeModePersistOutput;
};

export type ExecuteTauCodeModeOptions = TauCodeModeDefinition & {
  code: string;
  maxOutputTokens?: number;
  signal?: AbortSignal;
  invocation?: TauCodeModeInvocation | null;
  executionEnvironment?: TauSdkClientToolExecutionEnvironment | null;
};

export type TauCodeModeResult = {
  content: Array<TextContent | ImageContent>;
};

export type BuildTauCodeModeToolDescriptionOptions = {
  name: string;
  description: string;
  timeoutMs?: number;
};

/** Where relative `.js` imports load from. Without it, programs cannot import local files. */
export type CodeModeSources = {
  cwd: string;
  entryPath?: string;
  read(path: string, signal: AbortSignal): Promise<string>;
};

export type RunTauCodeModeOptions = {
  packages: TauCodeModePackage[];
  /** Further `docs(page)` pages that are not packages, such as recipes. */
  pages?: Record<string, string>;
  code: string;
  sources?: CodeModeSources;
  input?: TauCodeModeJsonValue;
  maxOutputTokens?: number;
  /** `null` runs without a deadline. */
  timeoutMs: number | null;
  signal?: AbortSignal;
  invocation?: TauCodeModeInvocation | null;
  executionEnvironment?: TauSdkClientToolExecutionEnvironment | null;
  persistOutput?: TauCodeModePersistOutput;
  output?: CodeModeOutput;
};

type RegisteredMethod = {
  id: number;
  label: string;
  path: string[];
  handler: TauCodeModeHandler;
};

export type TauCodeModeRuntimeResult = {
  result: TauCodeModeResult;
  status: TauCodeModeExecutionStatus;
  execution: CodeModeWorkerResult;
  durationMs: number;
  projection: TauCodeModeProjection;
  persistedPath?: string;
};

/** Lists the importable packages and tells the model how to read their references. */
export function describeTauCodeModePackages(
  packages: ReadonlyArray<{ name: string; description: string }>,
): string {
  const example = packages[0]?.name ?? CORE_PACKAGE;
  return [
    [
      "Available packages:",
      `- ${CORE_PACKAGE}: input, printText, printImage, truncate, and docs.`,
      ...packages.map(({ name, description }) => `- ${name}: ${description}`),
    ].join("\n"),
    `Before you first use a package, read its reference unless it is already in the conversation. Load references in a program of their own: \`import { docs, printText } from "${CORE_PACKAGE}"; printText(await docs());\` prints the general guide and the ${CORE_PACKAGE} reference, and \`docs(${JSON.stringify(example)})\` returns the reference of that package. Load only the pages you need.`,
  ].join("\n\n");
}

export function buildTauCodeModeToolDescription({
  name,
  description,
  timeoutMs,
}: BuildTauCodeModeToolDescriptionOptions): string {
  validateToolPackageName(name);
  const trimmed = description.trim();
  if (!trimmed) throw new Error("code-mode tool description must not be empty");
  return [
    trimmed,
    "Run a JavaScript program that imports this tool's API. Programs use static imports and top-level await, and only printed output comes back.",
    describeTauCodeModePackages([{ name, description: "the API of this tool." }]),
    describeCodeModeDeadline(timeoutMs),
  ].join("\n\n");
}

export function describeCodeModeDeadline(timeoutMs = TAU_CODE_MODE_DEFAULT_TIMEOUT_MS): string {
  return `Each program must finish within ${timeoutMs} ms, including time spent waiting for API calls.`;
}

export function validateTauCodeModeDefinition(definition: TauCodeModeDefinition): void {
  validateToolPackageName(definition.name);
  validateTimeout(definition.timeoutMs);
  validatePackage(definitionPackage(definition));
}

export async function executeTauCodeMode(
  options: ExecuteTauCodeModeOptions,
): Promise<TauCodeModeResult> {
  validateTauCodeModeDefinition(options);
  const runtime = await runTauCodeMode({
    packages: [definitionPackage(options)],
    code: options.code,
    maxOutputTokens: options.maxOutputTokens,
    timeoutMs: options.timeoutMs ?? TAU_CODE_MODE_DEFAULT_TIMEOUT_MS,
    signal: options.signal,
    invocation: options.invocation,
    executionEnvironment: options.executionEnvironment,
    persistOutput: options.persistOutput,
  });
  if (runtime.status === "succeeded") return runtime.result;
  throw new Error(
    runtime.result.content
      .filter((part): part is TextContent => part.type === "text")
      .map((part) => part.text)
      .join("\n"),
  );
}

export async function runTauCodeMode(
  options: RunTauCodeModeOptions,
): Promise<TauCodeModeRuntimeResult> {
  if (typeof options.code !== "string" || !options.code.trim()) {
    throw new Error("code-mode source must be a non-empty string");
  }
  validateTimeout(options.timeoutMs);
  validateMaxOutputTokens(options.maxOutputTokens);
  const pages = new Map<string, string>([[CORE_PACKAGE, readCoreDocumentation()]]);
  for (const pkg of options.packages) {
    validatePackage(pkg);
    if (pages.has(pkg.name)) throw new Error(`code-mode package '${pkg.name}' is defined twice`);
    pages.set(pkg.name, pkg.documentation);
  }
  for (const [name, page] of Object.entries(options.pages ?? {})) {
    if (pages.has(name)) throw new Error(`code-mode page '${name}' is defined twice`);
    pages.set(name, page);
  }

  const orderedOutput = options.output ?? new CodeModeOutput();
  let imageCount = 0;
  const core: TauCodeModeApi = {
    docs: ([page = CORE_PACKAGE]) => {
      const documentation = typeof page === "string" ? pages.get(page) : undefined;
      if (documentation !== undefined) return documentation;
      throw codeModeError(
        "unknown_page",
        `Unknown docs page ${JSON.stringify(page)}. Available pages: ${[...pages.keys()].join(", ")}`,
      );
    },
    printImage: async (args, context) => {
      if (args.length !== 1) throw new Error("printImage() expects exactly one image.");
      if (imageCount >= SESSION_PROTOCOL_MAX_CLIENT_TOOL_IMAGES) {
        throw new Error(
          `printImage() allows at most ${SESSION_PROTOCOL_MAX_CLIENT_TOOL_IMAGES} images per program.`,
        );
      }
      imageCount += 1;
      const slot = orderedOutput.reserveImage();
      try {
        context.signal.throwIfAborted();
        slot.value = await prepareCodeModeImage(args[0]);
        context.signal.throwIfAborted();
        return null;
      } catch (error) {
        imageCount -= 1;
        throw error;
      }
    },
  };
  const packages = [{ name: CORE_PACKAGE, api: core }, ...options.packages];
  const methods: RegisteredMethod[] = [];
  const apis = packages.map(({ name, api }) => {
    const registered = registerMethods(api, name, methods.length);
    methods.push(...registered);
    return { name, methods: registered.map(({ id, path }) => ({ id, path })) };
  });
  const sources = options.sources;
  const sourceMethodId = methods.length;
  methods.push({
    id: sourceMethodId,
    label: "module loader",
    path: [],
    handler: ([path], context) => {
      if (!sources) throw new Error("This tool cannot import local files");
      if (typeof path !== "string") throw new Error("Invalid module path");
      return sources.read(path, context.signal);
    },
  });

  const timeoutMs = options.timeoutMs;
  const invocation = options.invocation ?? null;
  const executionEnvironment = options.executionEnvironment ?? null;
  const signal = options.signal ?? new AbortController().signal;
  const startedAt = Date.now();
  let execution: CodeModeWorkerResult;
  try {
    execution = await executeCodeModeWorker({
      sandboxRunnerUrl,
      workerData: {
        code: options.code,
        cwd: sources?.cwd ?? "/",
        entryPath: sources?.entryPath,
        sourceMethodId,
        inputJson: JSON.stringify(options.input ?? null),
        apis,
      },
      signal,
      timeoutMs,
      onOutput: (text, truncated) => {
        orderedOutput.appendText(text);
        orderedOutput.truncated ||= truncated;
      },
      handleRequest: async (request, requestSignal) => {
        const method = methods[request.methodId];
        if (!method) throw new Error("unsupported code-mode API method");
        const args = parseBridgeArguments(request.argsJson, method);
        const value = await method.handler(args, {
          signal: requestSignal,
          invocation,
          executionEnvironment,
        });
        return serializeBridgeResult(value, method);
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.stack || error.message : String(error);
    orderedOutput.appendText(`${message}\n`);
    execution = { exitCode: 1, truncated: false, timedOut: false, aborted: false };
  }
  const durationMs = Math.max(0, Date.now() - startedAt);
  const status = getExecutionStatus(execution);
  const rawOutput = orderedOutput.text;
  const output = appendTerminationNote(rawOutput, execution, timeoutMs);
  const projection = truncateForTokens(output, {
    maxTokens: options.maxOutputTokens ?? TAU_CODE_MODE_DEFAULT_MAX_OUTPUT_TOKENS,
    strategy: "middle",
  });

  let persistedPath: string | undefined;
  if (options.persistOutput) {
    try {
      const persisted = await options.persistOutput(
        {
          content: output,
          captureTruncated: execution.truncated,
          contextTruncated: projection.truncated,
          status,
        },
        { signal, invocation, executionEnvironment },
      );
      if (persisted?.path.trim()) persistedPath = persisted.path;
    } catch {}
  }

  const formatted = formatResultContent({ execution, projection, persistedPath, status });
  const displayedText = projection.content.trimEnd();
  const footer = displayedText
    ? formatted.slice(displayedText.length)
    : imageCount > 0 && status === "succeeded"
      ? ""
      : formatted;
  const result: TauCodeModeResult = {
    content: orderedOutput.project({
      terminationNote: output.slice(rawOutput.length),
      projection,
      footer,
    }),
  };
  return {
    result,
    status,
    execution,
    durationMs,
    projection,
    ...(persistedPath ? { persistedPath } : {}),
  };
}

function definitionPackage(definition: TauCodeModeDefinition): TauCodeModePackage {
  return { name: definition.name, documentation: definition.documentation, api: definition.api };
}

function readCoreDocumentation(): string {
  coreDocumentation ??= readFileSync(coreDocumentationUrl, "utf8");
  return coreDocumentation;
}

function validateToolPackageName(name: string): void {
  if (!toolPackageNamePattern.test(name)) {
    throw new Error(
      `code-mode name '${name}' must start with a letter and contain only letters, digits, '_', or '-'`,
    );
  }
}

function validatePackage(pkg: TauCodeModePackage): void {
  if (!pkg.name || pkg.name === CORE_PACKAGE || pkg.name.startsWith(".")) {
    throw new Error(`code-mode package name '${pkg.name}' is reserved`);
  }
  if (!pkg.documentation.trim()) {
    throw new Error(`code-mode package '${pkg.name}' needs documentation`);
  }
  registerMethods(pkg.api, pkg.name, 0);
}

function validateTimeout(timeoutMs: number | null | undefined): void {
  if (
    timeoutMs !== undefined &&
    timeoutMs !== null &&
    (!Number.isInteger(timeoutMs) || timeoutMs <= 0)
  ) {
    throw new Error("code-mode timeoutMs must be a positive integer");
  }
}

function validateMaxOutputTokens(value: unknown): void {
  if (
    value !== undefined &&
    (typeof value !== "number" ||
      !Number.isInteger(value) ||
      value < 1 ||
      value > TAU_CODE_MODE_MAX_OUTPUT_TOKENS)
  ) {
    throw new Error(
      `maxOutputTokens must be an integer from 1 to ${TAU_CODE_MODE_MAX_OUTPUT_TOKENS}`,
    );
  }
}

export function parseCodeModeArguments(value: unknown): {
  code: string;
  maxOutputTokens?: number;
} {
  if (!isPlainObject(value)) throw new Error("code-mode arguments must be an object");
  const args = value as Record<string, unknown>;
  if (
    typeof args.code !== "string" ||
    !args.code.trim() ||
    Object.keys(args).some((key) => key !== "code" && key !== "maxOutputTokens")
  ) {
    throw new Error(
      "code-mode arguments require a non-empty code string and optional maxOutputTokens",
    );
  }
  validateMaxOutputTokens(args.maxOutputTokens);
  return { code: args.code, maxOutputTokens: args.maxOutputTokens as number | undefined };
}

// Top-level keys become a package's named exports, and nested objects become frozen namespaces.
function registerMethods(api: TauCodeModeApi, name: string, firstId: number): RegisteredMethod[] {
  const methods: RegisteredMethod[] = [];
  const visit = (value: TauCodeModeApi, path: string[]): void => {
    if (!isPlainObject(value)) {
      throw new Error(`code-mode API '${formatPath(name, path)}' must be a plain object`);
    }
    const entries = Object.entries(value);
    if (entries.length === 0) {
      throw new Error(`code-mode API '${formatPath(name, path)}' must not be empty`);
    }
    for (const [key, child] of entries) {
      const childPath = [...path, key];
      const valid = path.length === 0 ? exportNamePattern.test(key) : key.length > 0;
      if (!valid || unsafeApiKeys.has(key)) {
        throw new Error(`code-mode API key '${formatPath(name, childPath)}' is not allowed`);
      }
      if (typeof child === "function") {
        methods.push({
          id: firstId + methods.length,
          label: formatPath(name, childPath),
          path: childPath,
          handler: child,
        });
      } else {
        visit(child, childPath);
      }
    }
  };
  visit(api, []);
  return methods;
}

function isPlainObject(value: unknown): value is TauCodeModeApi {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function formatPath(name: string, path: string[]): string {
  return path.length > 0 ? `${name}.${path.join(".")}` : name;
}

function parseBridgeArguments(argsJson: string, method: RegisteredMethod): unknown[] {
  if (Buffer.byteLength(argsJson, "utf8") > CODE_MODE_MAX_BRIDGE_PAYLOAD_BYTES) {
    throw new Error(
      `${method.label} arguments exceeded the ${formatBytes(CODE_MODE_MAX_BRIDGE_PAYLOAD_BYTES)} bridge payload limit; use file paths instead of inline media`,
    );
  }
  let args: unknown;
  try {
    args = decodeBridgeValue(argsJson);
  } catch {
    throw new Error(`invalid ${method.label} arguments`);
  }
  if (!Array.isArray(args)) throw new Error(`invalid ${method.label} arguments`);
  return args;
}

function serializeBridgeResult(value: unknown, method: RegisteredMethod): string {
  let json: string;
  try {
    json = encodeBridgeValue(value, false);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${method.label} returned a non-JSON value: ${detail}`);
  }
  if (Buffer.byteLength(json, "utf8") > CODE_MODE_MAX_BRIDGE_PAYLOAD_BYTES) {
    throw new Error(
      `${method.label} result exceeded the ${formatBytes(CODE_MODE_MAX_BRIDGE_PAYLOAD_BYTES)} bridge payload limit`,
    );
  }
  return json;
}

function getExecutionStatus(execution: CodeModeWorkerResult): TauCodeModeExecutionStatus {
  if (execution.aborted) return "cancelled";
  if (execution.timedOut) return "timed-out";
  return execution.exitCode === 0 ? "succeeded" : "failed";
}

function appendTerminationNote(
  output: string,
  execution: CodeModeWorkerResult,
  timeoutMs: number | null,
): string {
  let notice: string | undefined;
  if (execution.timedOut) {
    notice = `Program timed out after ${timeoutMs}ms.`;
  } else if (execution.aborted) {
    notice = "Program was cancelled.";
  }
  if (!notice) return output;
  if (!output) return `${notice}\n`;
  return `${output}${output.endsWith("\n") ? "\n" : "\n\n"}[${notice}]\n`;
}

function formatResultContent(args: {
  execution: CodeModeWorkerResult;
  projection: TauCodeModeProjection;
  persistedPath?: string;
  status: TauCodeModeExecutionStatus;
}): string {
  const { execution, projection, persistedPath, status } = args;
  const output = projection.content.trimEnd();
  if (!output && status === "succeeded") {
    return persistedPath
      ? `Program produced no output.\n\n[Output saved to ${persistedPath}.]`
      : "Program produced no output.";
  }
  if (!output && status === "failed" && execution.exitCode !== null && execution.exitCode !== 0) {
    return `Program failed with exit code ${execution.exitCode} and produced no output.`;
  }

  const truncationNote =
    projection.truncated || execution.truncated
      ? `\n\n[Output truncated for context: ${projection.outputLines} lines / ${formatBytes(projection.outputBytes)} shown of ${projection.totalLines} lines / ${formatBytes(projection.totalBytes)} (full output estimate: ~${bytesToTokens(projection.totalBytes)} tokens).${persistedPath ? ` Output before context truncation saved to ${persistedPath}.` : ""}]`
      : persistedPath
        ? `\n\n[Output saved to ${persistedPath}.]`
        : "";
  const resultText = `${output || "Program failed without producing output."}${truncationNote}`;
  return status === "failed" && execution.exitCode !== null && execution.exitCode !== 0
    ? `${resultText.trimEnd()}\n\n[Program failed with exit code ${execution.exitCode}.]`
    : resultText;
}
