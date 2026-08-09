import stripAnsi from "strip-ansi";
import {
  CODE_MODE_MAX_BRIDGE_PAYLOAD_BYTES,
  CODE_MODE_MAX_BRIDGE_REQUESTS,
  CODE_MODE_MAX_CONCURRENT_BRIDGE_REQUESTS,
  executeCodeModeWorker,
} from "../core/tools/code_mode_worker.js";
import { bytesToTokens } from "../core/utils/token.js";
import { formatBytes, truncateForTokens } from "../core/utils/truncate.js";

export const TAU_CODE_MODE_DEFAULT_TIMEOUT_MS = 60_000;
export const TAU_CODE_MODE_MAX_OUTPUT_TOKENS = 8_192;

const sandboxRunnerUrl = new URL("../core/static/code_mode/sandbox_runner.mjs", import.meta.url);
const javascriptIdentifierPattern = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const reservedNames = new Set([...Object.getOwnPropertyNames(globalThis), "docs"]);
const unsafeApiKeys = new Set(["__proto__", "constructor", "prototype"]);

export type TauCodeModeJsonValue =
  | null
  | boolean
  | number
  | string
  | TauCodeModeJsonValue[]
  | { [key: string]: TauCodeModeJsonValue };

export type TauCodeModeInvocation = {
  sessionId: string;
  callId: string;
};

export type TauCodeModeHandlerContext = {
  signal: AbortSignal;
  invocation: TauCodeModeInvocation | null;
};

export type TauCodeModeHandler = (
  args: unknown[],
  context: TauCodeModeHandlerContext,
) => unknown | Promise<unknown>;

export type TauCodeModeApi = {
  [key: string]: TauCodeModeApi | TauCodeModeHandler;
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

type TauCodeModeExecutionCapture = {
  output: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  truncated: boolean;
  timedOut: boolean;
  aborted: boolean;
  closeSignal: string | null;
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

export type TauCodeModeDefinition = {
  name: string;
  documentation: string;
  api: TauCodeModeApi;
  timeoutMs?: number;
  persistOutput?: TauCodeModePersistOutput;
};

export type ExecuteTauCodeModeOptions = TauCodeModeDefinition & {
  code: string;
  signal?: AbortSignal;
  invocation?: TauCodeModeInvocation | null;
};

export type TauCodeModeResult = {
  content: string;
};

export type BuildTauCodeModeToolDescriptionOptions = {
  name: string;
  description: string;
};

type RegisteredMethod = {
  id: number;
  path: string[];
  handler: TauCodeModeHandler;
};

export type TauCodeModeRuntimeResult = {
  result: TauCodeModeResult;
  status: TauCodeModeExecutionStatus;
  execution: TauCodeModeExecutionCapture;
  durationMs: number;
  projection: TauCodeModeProjection;
  persistedPath?: string;
};

export function buildTauCodeModeToolDescription({
  name,
  description,
}: BuildTauCodeModeToolDescriptionOptions): string {
  validateName(name);
  const trimmedDescription = description.trim();
  if (!trimmedDescription) throw new Error("code-mode tool description must not be empty");
  return [
    trimmedDescription,
    "When this tool is useful, your first call must be a documentation-only program that does nothing except print docs with console.log(docs).",
    `Read the returned documentation before writing a later tool call that uses ${name}.`,
    "Do not guess API signatures.",
  ].join(" ");
}

export function validateTauCodeModeDefinition(definition: TauCodeModeDefinition): void {
  validateName(definition.name);
  if (!definition.documentation.trim()) {
    throw new Error("code-mode documentation must not be empty");
  }
  validateTimeout(definition.timeoutMs);
  registerMethods(definition.api);
}

export async function executeTauCodeMode(
  options: ExecuteTauCodeModeOptions,
): Promise<TauCodeModeResult> {
  const runtime = await runTauCodeMode(options);
  if (runtime.status === "succeeded") return runtime.result;
  throw new Error(runtime.result.content);
}

export async function runTauCodeMode(
  options: ExecuteTauCodeModeOptions,
): Promise<TauCodeModeRuntimeResult> {
  validateName(options.name);
  if (typeof options.code !== "string" || !options.code.trim()) {
    throw new Error("code-mode source must be a non-empty string");
  }
  if (!options.documentation.trim()) {
    throw new Error("code-mode documentation must not be empty");
  }
  validateTimeout(options.timeoutMs);

  const methods = registerMethods(options.api);
  const timeoutMs = options.timeoutMs ?? TAU_CODE_MODE_DEFAULT_TIMEOUT_MS;
  const invocation = options.invocation ?? null;
  const signal = options.signal ?? new AbortController().signal;
  const docs = buildRuntimeDocumentation(options.name, options.documentation, timeoutMs);
  const startedAt = Date.now();
  let execution: TauCodeModeExecutionCapture;
  try {
    execution = await executeCodeModeWorker({
      sandboxRunnerUrl,
      workerData: {
        code: options.code,
        docs,
        name: options.name,
        methods: methods.map(({ id, path }) => ({ id, path })),
      },
      signal,
      timeoutMs,
      handleRequest: async (request, requestSignal) => {
        const method = methods[request.methodId];
        if (!method) throw new Error(`unsupported ${options.name} API method`);
        const args = parseBridgeArguments(request.argsJson, options.name, method.path);
        const value = await method.handler(args, { signal: requestSignal, invocation });
        return serializeBridgeResult(value, options.name, method.path);
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.stack || error.message : String(error);
    const output = `${message}\n`;
    execution = {
      output,
      stdout: "",
      stderr: output,
      exitCode: 1,
      truncated: false,
      timedOut: false,
      aborted: false,
      closeSignal: null,
    };
  }
  const durationMs = Math.max(0, Date.now() - startedAt);
  const status = getExecutionStatus(execution);
  const output = appendTerminationNote(stripAnsi(execution.output), execution, timeoutMs);
  const projection = truncateForTokens(output, {
    maxTokens: TAU_CODE_MODE_MAX_OUTPUT_TOKENS,
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
        { signal, invocation },
      );
      if (persisted?.path.trim()) persistedPath = persisted.path;
    } catch {}
  }

  const result = {
    content: formatResultContent({ execution, projection, persistedPath, status }),
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

function validateName(name: string): void {
  let isIdentifier = javascriptIdentifierPattern.test(name);
  if (isIdentifier) {
    try {
      Function(`"use strict"; let ${name};`);
    } catch {
      isIdentifier = false;
    }
  }
  if (!isIdentifier || reservedNames.has(name)) {
    throw new Error(`code-mode name '${name}' must be a non-reserved JavaScript identifier`);
  }
}

function validateTimeout(timeoutMs: number | undefined): void {
  if (timeoutMs !== undefined && (!Number.isInteger(timeoutMs) || timeoutMs <= 0)) {
    throw new Error("code-mode timeoutMs must be a positive integer");
  }
}

function registerMethods(api: TauCodeModeApi): RegisteredMethod[] {
  const methods: RegisteredMethod[] = [];
  const visit = (value: TauCodeModeApi, path: string[]): void => {
    if (!isPlainObject(value)) {
      throw new Error(
        `code-mode API '${formatPath(path)}' must be a plain object with function leaves`,
      );
    }
    const entries = Object.entries(value);
    if (entries.length === 0) {
      throw new Error(`code-mode API '${formatPath(path)}' must not be empty`);
    }
    for (const [key, child] of entries) {
      const childPath = [...path, key];
      if (!key || unsafeApiKeys.has(key)) {
        throw new Error(`code-mode API key '${formatPath(childPath)}' is not allowed`);
      }
      if (typeof child === "function") {
        methods.push({ id: methods.length, path: childPath, handler: child });
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

function formatPath(path: string[]): string {
  return path.length > 0 ? path.join(".") : "<root>";
}

function parseBridgeArguments(argsJson: string, name: string, path: string[]): unknown[] {
  const method = `${name}.${formatPath(path)}`;
  if (Buffer.byteLength(argsJson, "utf8") > CODE_MODE_MAX_BRIDGE_PAYLOAD_BYTES) {
    throw new Error(
      `${method} arguments exceeded the ${formatBytes(CODE_MODE_MAX_BRIDGE_PAYLOAD_BYTES)} bridge payload limit`,
    );
  }
  let args: unknown;
  try {
    args = JSON.parse(argsJson);
  } catch {
    throw new Error(`invalid ${method} arguments`);
  }
  if (!Array.isArray(args)) {
    throw new Error(`invalid ${method} arguments`);
  }
  return args;
}

function serializeBridgeResult(value: unknown, name: string, path: string[]): string {
  let json: string | undefined;
  try {
    json = JSON.stringify(value, (_key, nested) => {
      if (
        nested === undefined ||
        typeof nested === "function" ||
        typeof nested === "symbol" ||
        typeof nested === "bigint" ||
        (typeof nested === "number" && !Number.isFinite(nested))
      ) {
        throw new TypeError("Code-mode API results must be JSON-serializable values");
      }
      return nested;
    });
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${name}.${formatPath(path)} returned a non-JSON value: ${detail}`);
  }
  if (json === undefined) {
    throw new Error(`${name}.${formatPath(path)} returned a non-JSON value`);
  }
  if (Buffer.byteLength(json, "utf8") > CODE_MODE_MAX_BRIDGE_PAYLOAD_BYTES) {
    throw new Error(
      `${name}.${formatPath(path)} result exceeded the ${formatBytes(CODE_MODE_MAX_BRIDGE_PAYLOAD_BYTES)} bridge payload limit`,
    );
  }
  return json;
}

function buildRuntimeDocumentation(name: string, documentation: string, timeoutMs: number): string {
  return [
    "# Code-mode runtime",
    "",
    "## Available globals",
    "",
    `- \`${name}\`: the explicitly exposed API documented below.`,
    "- `docs`: this document.",
    "- `console`: program output through `debug`, `error`, `info`, `log`, and `warn`.",
    "- `Date`: standard date handling with live current-time access.",
    "- `Math`: standard math operations, including `Math.random()`.",
    "",
    "Top-level `await` is supported. The program return value is ignored; only console output is returned.",
    "Generated code has no direct filesystem, process, environment, network, credential, import, timer, or `fetch` access.",
    "",
    "## API boundary",
    "",
    `Arguments passed to \`${name}\` methods and their results cross a JSON serialization boundary with a ${formatBytes(CODE_MODE_MAX_BRIDGE_PAYLOAD_BYTES)} limit per request or response.`,
    `A program may make at most ${CODE_MODE_MAX_BRIDGE_REQUESTS} API calls, with at most ${CODE_MODE_MAX_CONCURRENT_BRIDGE_REQUESTS} unresolved calls concurrently. Exceeding any bridge limit fails the program.`,
    `The program must finish within ${formatDuration(timeoutMs)}.`,
    "",
    "## Output",
    "",
    `Output is middle-truncated above roughly ${TAU_CODE_MODE_MAX_OUTPUT_TOKENS.toLocaleString("en-US")} tokens. Print only information needed for the task.`,
    "",
    documentation.trim(),
  ].join("\n");
}

function formatDuration(timeoutMs: number): string {
  if (timeoutMs % 1_000 === 0) {
    const seconds = timeoutMs / 1_000;
    return `${seconds} second${seconds === 1 ? "" : "s"}`;
  }
  return `${timeoutMs}ms`;
}

function getExecutionStatus(execution: TauCodeModeExecutionCapture): TauCodeModeExecutionStatus {
  if (execution.aborted) return "cancelled";
  if (execution.timedOut) return "timed-out";
  return execution.exitCode === 0 ? "succeeded" : "failed";
}

function appendTerminationNote(
  output: string,
  execution: TauCodeModeExecutionCapture,
  timeoutMs: number,
): string {
  let note: string | undefined;
  if (execution.timedOut) {
    note = `(tau) timed out after ${timeoutMs}ms`;
  } else if (execution.aborted) {
    note = "(tau) aborted";
  } else if (execution.closeSignal) {
    note = `(tau) terminated by signal ${execution.closeSignal}`;
  }
  if (!note) return output;
  return `${output}${output && !output.endsWith("\n") ? "\n" : ""}${note}\n`;
}

function formatResultContent(args: {
  execution: TauCodeModeExecutionCapture;
  projection: TauCodeModeProjection;
  persistedPath?: string;
  status: TauCodeModeExecutionStatus;
}): string {
  const { execution, projection, persistedPath, status } = args;
  const output = projection.content.trimEnd();
  if (!output && status === "succeeded") {
    return persistedPath
      ? `Program produced no output\n\n[Output saved to ${persistedPath}.]`
      : "Program produced no output";
  }

  const truncationNote =
    projection.truncated || execution.truncated
      ? `\n\n[Output truncated for context: ${projection.outputLines} lines / ${formatBytes(projection.outputBytes)} shown of ${projection.totalLines} lines / ${formatBytes(projection.totalBytes)} (full output estimate: ~${bytesToTokens(projection.totalBytes)} tokens).${persistedPath ? ` Output before context truncation saved to ${persistedPath}.` : ""}]`
      : persistedPath
        ? `\n\n[Output saved to ${persistedPath}.]`
        : "";
  const exitNote =
    status === "failed" && execution.exitCode !== null && execution.exitCode !== 0
      ? `\n(exit ${execution.exitCode})`
      : "";
  return `${output || "(no output)"}${truncationNote}${exitNote}`;
}
