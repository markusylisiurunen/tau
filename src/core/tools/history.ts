import { readFileSync } from "node:fs";
import type { Tool } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { z } from "zod";
import type { HistoryQuery } from "../history/types.js";
import { formatZodError } from "../utils/zod.js";
import {
  type CodeModeToolImplementation,
  createCodeModeToolDefinition,
  type ParsedCodeModeArguments,
} from "./code_mode.js";
import { type CodeModeBridgeRequest, executeCodeModeWorker } from "./code_mode_worker.js";
import type { ToolExecutionBackend } from "./execution_backend.js";
import type { AgentTool } from "./registry.js";
import { TOOL_NAME_HISTORY } from "./tool_names.js";

const HISTORY_CODE_MODE_TIMEOUT_MS = 60_000;
const HISTORY_CODE_MODE_OUTPUT_TOKENS = 8_192;

const HISTORY_DESCRIPTION = [
  "Run a one-shot JavaScript program to search and read durable transcripts from the configured history collection.",
  "Use this tool only when the user or other active instructions directly ask you to reference, search, or read historical transcripts; do not invoke it merely because prior sessions might be relevant.",
  "The tool is read-only and has global visibility across repositories and execution environments.",
  "Top-level await is supported. The program receives history, docs, and console globals.",
  "Only text written through console methods is returned; program return values are ignored.",
  "Use history.search to find concise session descriptors, then history.read only for the selected transcripts and ranges needed.",
  "Ordinary JavaScript can filter, map, group, and combine returned data.",
  "To discover the available APIs, run a program that prints docs with console.log(docs), then use that documentation in the next turn.",
].join(" ");

export const HISTORY_TOOL: Tool = {
  name: TOOL_NAME_HISTORY,
  description: HISTORY_DESCRIPTION,
  parameters: Type.Object(
    {
      code: Type.String({
        description: "JavaScript source to execute. Use console output to return information.",
      }),
    },
    { additionalProperties: false },
  ),
};

const historyArgsSchema = z.object({ code: z.string().trim().min(1) }).strict();
type HistoryArgs = z.infer<typeof historyArgsSchema>;

const attributesSchema = z
  .record(z.string().min(1).max(64), z.string().max(1_024))
  .refine((attributes) => Object.keys(attributes).length <= 32);
const searchInputSchema = z
  .object({
    query: z.string().trim().min(1).max(1_000).optional(),
    attributes: attributesSchema.optional(),
    limit: z.number().int().min(1).max(100).default(10),
    cursor: z.string().min(1).max(2_048).optional(),
  })
  .strict();
const readInputSchema = z
  .object({
    sessionId: z.string().trim().min(1).max(256),
    limit: z.number().int().min(1).max(100).default(50),
    cursor: z.string().min(1).max(2_048).optional(),
  })
  .strict();

const documentation = readFileSync(
  new URL("../static/code_mode/history/documentation.md", import.meta.url),
  "utf8",
);
const sandboxRunnerUrl = new URL("../static/code_mode/history/sandbox_runner.mjs", import.meta.url);

function parseHistoryArguments(raw: unknown): ParsedCodeModeArguments<HistoryArgs> {
  const rawCode =
    typeof raw === "object" && raw !== null && typeof (raw as { code?: unknown }).code === "string"
      ? (raw as { code: string }).code
      : "";
  const displayTarget =
    rawCode
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) ?? "(invalid code)";
  const parsed = historyArgsSchema.safeParse(raw);
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

function parseBridgeArguments(request: CodeModeBridgeRequest): unknown[] {
  let args: unknown;
  try {
    args = JSON.parse(request.argsJson);
  } catch {
    throw new Error("invalid history bridge arguments");
  }
  if (!Array.isArray(args) || args.length !== 1) {
    throw new Error(`history.${request.method} expects one options object`);
  }
  return args;
}

async function handleHistoryRequest(
  request: CodeModeBridgeRequest,
  history: HistoryQuery,
  signal: AbortSignal,
): Promise<unknown> {
  const args = parseBridgeArguments(request);
  if (request.method === "search") {
    const parsed = searchInputSchema.safeParse(args[0] ?? {});
    if (!parsed.success) {
      throw new Error(`Invalid history.search options: ${formatZodError(parsed.error)}`);
    }
    return await history.search(parsed.data, signal);
  }
  if (request.method === "read") {
    const parsed = readInputSchema.safeParse(args[0]);
    if (!parsed.success) {
      throw new Error(`Invalid history.read options: ${formatZodError(parsed.error)}`);
    }
    return await history.read(parsed.data, signal);
  }
  throw new Error(`unsupported history method '${request.method}'`);
}

export function createHistoryToolDefinition(
  backend: ToolExecutionBackend,
  history: HistoryQuery,
): AgentTool {
  const implementation: CodeModeToolImplementation<HistoryArgs> = {
    schema: HISTORY_TOOL,
    outputPolicy: { maxTokens: HISTORY_CODE_MODE_OUTPUT_TOKENS },
    timeoutMs: HISTORY_CODE_MODE_TIMEOUT_MS,
    parseArguments: parseHistoryArguments,
    execute: async ({ code, signal }) =>
      executeCodeModeWorker({
        sandboxRunnerUrl,
        workerData: { code, docs: documentation },
        signal,
        timeoutMs: HISTORY_CODE_MODE_TIMEOUT_MS,
        handleRequest: (request, requestSignal) =>
          handleHistoryRequest(request, history, requestSignal),
      }),
  };
  return createCodeModeToolDefinition(backend, implementation);
}
