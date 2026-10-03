import type { ImageContent, TextContent } from "@earendil-works/pi-ai";
import {
  CODE_MODE_MAX_BRIDGE_PAYLOAD_BYTES,
  CODE_MODE_MAX_BRIDGE_REQUESTS,
  CODE_MODE_MAX_CONCURRENT_BRIDGE_REQUESTS,
  executeCodeModeWorker,
} from "../core/tools/code_mode_worker.js";
import { bytesToTokens } from "../core/utils/token.js";
import { formatBytes, truncateForTokens } from "../core/utils/truncate.js";
import { SESSION_PROTOCOL_MAX_CLIENT_TOOL_IMAGES } from "../protocol/session_protocol.js";
import type { TauSdkClientToolExecutionEnvironment } from "../sdk/types.js";
import { CODE_MODE_MAX_IMAGE_PIXELS, prepareCodeModeImage } from "./images.js";
import { CodeModeOutput } from "./output.js";

export const TAU_CODE_MODE_DEFAULT_TIMEOUT_MS = 60_000;
export const TAU_CODE_MODE_MAX_OUTPUT_TOKENS = 8_192;

const sandboxRunnerUrl = new URL("../core/static/code_mode/sandbox_runner.mjs", import.meta.url);
const javascriptIdentifierPattern = /^[A-Za-z_$][A-Za-z0-9_$]*$/;
const reservedNames = new Set([
  ...Object.getOwnPropertyNames(globalThis),
  "docs",
  "printText",
  "printImage",
  "truncate",
  "truncateLines",
]);
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
  executionEnvironment?: TauSdkClientToolExecutionEnvironment | null;
};

export type TauCodeModeResult = {
  content: Array<TextContent | ImageContent>;
};

export type BuildTauCodeModeToolDescriptionOptions = {
  name: string;
  description: string;
};

type RegisteredMethod = {
  id: number;
  apiName: string;
  path: string[];
  handler: TauCodeModeHandler;
};

type RegisteredApi = {
  name: string;
  methods: RegisteredMethod[];
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
    "When this tool is useful, first check whether its documentation is already visible in the conversation context.",
    "If it is not, your first call must be a documentation-only program that does nothing except print docs with printText(docs).",
    `Read the returned documentation before writing a later tool call that uses ${name}.`,
    "Once the documentation is visible, use the API normally without reloading it, and do not guess API signatures.",
  ].join(" ");
}

export function validateTauCodeModeDefinition(definition: TauCodeModeDefinition): void {
  validateName(definition.name);
  if (!definition.documentation.trim()) {
    throw new Error("code-mode documentation must not be empty");
  }
  validateTimeout(definition.timeoutMs);
  registerMethods(definition.api, definition.name);
}

export async function executeTauCodeMode(
  options: ExecuteTauCodeModeOptions,
): Promise<TauCodeModeResult> {
  const runtime = await runTauCodeMode(options);
  if (runtime.status === "succeeded") return runtime.result;
  throw new Error(
    runtime.result.content
      .filter((part): part is TextContent => part.type === "text")
      .map((part) => part.text)
      .join("\n"),
  );
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

  const apiMethods = registerMethods(options.api, options.name);
  const apis: RegisteredApi[] = [{ name: options.name, methods: apiMethods }];
  const methods = apis.flatMap((api) => api.methods);
  const orderedOutput = new CodeModeOutput();
  let imageCount = 0;
  const imageMethodId = methods.length;
  methods.push({
    id: imageMethodId,
    apiName: "printImage",
    path: [],
    handler: async (args, context) => {
      if (args.length !== 1) throw new Error("printImage() expects exactly one image block.");
      if (imageCount >= SESSION_PROTOCOL_MAX_CLIENT_TOOL_IMAGES) {
        throw new Error(
          `printImage() allows at most ${SESSION_PROTOCOL_MAX_CLIENT_TOOL_IMAGES} images per program.`,
        );
      }
      imageCount += 1;
      const slot = orderedOutput.reserveImage();
      try {
        context.signal.throwIfAborted();
        const prepared = await prepareCodeModeImage(args[0]);
        context.signal.throwIfAborted();
        slot.value = prepared;
        return null;
      } catch (error) {
        imageCount -= 1;
        throw error;
      }
    },
  });
  const timeoutMs = options.timeoutMs ?? TAU_CODE_MODE_DEFAULT_TIMEOUT_MS;
  const invocation = options.invocation ?? null;
  const executionEnvironment = options.executionEnvironment ?? null;
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
        imageMethodId,
        apis: apis.map((api) => ({
          name: api.name,
          methods: api.methods.map(({ id, path }) => ({ id, path })),
        })),
      },
      signal,
      timeoutMs,
      onOutput: (text) => orderedOutput.appendText(text),
      handleRequest: async (request, requestSignal) => {
        const method = methods[request.methodId];
        if (!method) throw new Error("unsupported code-mode API method");
        const args = parseBridgeArguments(request.argsJson, method.apiName, method.path);
        const value = await method.handler(args, {
          signal: requestSignal,
          invocation,
          executionEnvironment,
        });
        return serializeBridgeResult(value, method.apiName, method.path);
      },
    });
  } catch (error) {
    const message = error instanceof Error ? error.stack || error.message : String(error);
    const output = `${message}\n`;
    orderedOutput.appendText(output);
    execution = {
      output: orderedOutput.text,
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
  const rawOutput = orderedOutput.text;
  const output = appendTerminationNote(rawOutput, execution, timeoutMs);
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

function registerMethods(api: TauCodeModeApi, apiName: string, firstId = 0): RegisteredMethod[] {
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
        methods.push({ id: firstId + methods.length, apiName, path: childPath, handler: child });
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
    "- `printText(text)`: emits a string to the model.",
    "- `await printImage(block)`: emits a validated base64 image to the model.",
    "- `truncate(text, { maxChars, position? })`: bounds Unicode characters, including an omission marker.",
    "- `truncateLines(text, { maxLines, position? })`: bounds lines, including an omission marker.",
    "Truncation position is `middle` (default), `start` (keep the start), or `end` (keep the end). Limits must be positive integers.",
    "- `Date`: standard date handling with live current-time access.",
    "- `Math`: standard math operations, including `Math.random()`.",
    "",
    "Top-level `await` is supported. Methods on the exposed API return promises; await them before using their results. TypeScript blocks in capability references describe signatures and data shapes; write programs in JavaScript.",
    "Each tool call starts a fresh program. Variables do not persist between calls; supply required values again. The program return value is ignored; printed text and explicitly forwarded images are returned.",
    "Generated code has no direct filesystem, process, environment, network, credential, import, timer, or fetch access. Use explicitly exposed capabilities.",
    "",
    "## API limits",
    "",
    `Each API request and response must be JSON-serializable and fit within ${formatBytes(CODE_MODE_MAX_BRIDGE_PAYLOAD_BYTES)}. Request smaller results using service filters or pagination when available; filtering after receiving a response cannot avoid this limit.`,
    "Undefined object properties are omitted from API arguments. Undefined arguments and array entries remain invalid.",
    `A program may make at most ${CODE_MODE_MAX_BRIDGE_REQUESTS} API calls, with at most ${CODE_MODE_MAX_CONCURRENT_BRIDGE_REQUESTS} unresolved calls concurrently. Exceeding these limits fails the program.`,
    `The program must finish within ${formatDuration(timeoutMs)}.`,
    "",
    "## Output",
    "",
    `Output is middle-truncated above roughly ${TAU_CODE_MODE_MAX_OUTPUT_TOKENS.toLocaleString("en-US")} tokens. Print only information needed for the task.`,
    "",
    "Print only relevant parts of API responses, not entire objects or large collections. Filter, select, or summarize before printing. Prefer concise, readable plain text: labels, lines, and selected fields usually use fewer tokens than JSON envelopes and metadata. Use JSON when the structure itself matters or machine-readable output is requested. Keep identifiers and other fields needed for follow-up actions. Printed output consumes conversation context.",
    "",
    "For example, print selected fields rather than whole objects:",
    "",
    "```js",
    'printText(items.map(item => item.id + ": " + item.title).join("\\n"));',
    "```",
    "",
    "When a response contains text blocks, print their text rather than serializing the surrounding objects:",
    "",
    "```js",
    "printText(blocks",
    '  .filter(block => block.type === "text")',
    "  .map(block => block.text)",
    '  .join("\\n\\n"));',
    "```",
    "",
    "These examples illustrate output formatting, not API signatures. Use the documented response shape. Forward relevant images with `await printImage(block)`; never print their base64 data.",
    "",
    "## Images",
    "",
    'Use `await printImage({ type: "image", data, mimeType })` to forward a base64-encoded image block returned by any API. Images are never forwarded automatically. Do not print base64 data.',
    "Await each call so validation and preparation finish before the program exits. Invalid blocks reject and can be caught. No files are created.",
    `Supported MIME types are image/jpeg, image/png, and image/webp. Each image block, including its base64 data, must fit within ${formatBytes(CODE_MODE_MAX_BRIDGE_PAYLOAD_BYTES)}, and source images cannot exceed ${CODE_MODE_MAX_IMAGE_PIXELS / 1_000_000} megapixels. At most ${SESSION_PROTOCOL_MAX_CLIENT_TOOL_IMAGES} images can be forwarded per program. Images are validated against their actual bytes and resized or re-encoded to fit the model's image limits.`,
    "Printed text and images are returned as ordered content blocks. Adjacent text writes form one text block; each awaited image stays between the text printed before and after it. Text truncation keeps images in their original positions. Complete the program successfully to ensure all outputs are returned.",
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
  let notice: string | undefined;
  if (execution.timedOut) {
    notice = `Program timed out after ${timeoutMs}ms.`;
  } else if (execution.aborted) {
    notice = "Program was cancelled.";
  } else if (execution.closeSignal) {
    notice = `Program was terminated by signal ${execution.closeSignal}.`;
  }
  if (!notice) return output;
  if (!output) return `${notice}\n`;
  return `${output}${output.endsWith("\n") ? "\n" : "\n\n"}[${notice}]\n`;
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
