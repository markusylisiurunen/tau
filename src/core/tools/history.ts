import { readFileSync } from "node:fs";
import type { Tool } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { z } from "zod";
import type { HistoryQuery } from "../history/types.js";
import { formatZodError } from "../utils/zod.js";
import {
  buildCodeModeToolDescription,
  type CodeModeToolImplementation,
  createCodeModeToolDefinition,
  executeInternalCodeMode,
  type ParsedCodeModeArguments,
} from "./code_mode.js";
import type { ToolExecutionBackend } from "./execution_backend.js";
import type { AgentTool } from "./registry.js";
import { TOOL_NAME_HISTORY } from "./tool_names.js";

const HISTORY_CODE_MODE_TIMEOUT_MS = 60_000;

const HISTORY_DESCRIPTION = buildCodeModeToolDescription({
  sdkGlobal: "history",
  introduction: [
    "Run a one-shot JavaScript program to search and read durable transcripts from the configured history collection.",
    "Use this tool only when the user or other active instructions directly ask you to reference, search, or read historical transcripts; do not invoke it merely because prior sessions might be relevant.",
    "The tool is read-only and has global visibility across repositories and execution environments.",
  ],
});

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

const attributeFilterSchema = z.union([
  z.string().max(1_024),
  z.object({ contains: z.string().min(1).max(1_024) }).strict(),
]);
const attributeFiltersSchema = z
  .record(z.string().min(1).max(64), attributeFilterSchema)
  .refine((attributes) => Object.keys(attributes).length <= 32);
const searchInputSchema = z
  .object({
    query: z.string().trim().min(1).max(1_000).optional(),
    attributes: attributeFiltersSchema.optional(),
    limit: z.number().int().min(1).max(75).default(10),
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
function parseHistoryArguments(raw: unknown): ParsedCodeModeArguments<HistoryArgs> {
  const rawCode =
    typeof raw === "object" && raw !== null && typeof (raw as { code?: unknown }).code === "string"
      ? (raw as { code: string }).code
      : "";
  const subject =
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

async function handleHistoryRequest(
  method: "search" | "read",
  args: unknown[],
  history: HistoryQuery,
  signal: AbortSignal,
): Promise<unknown> {
  if (args.length !== 1) {
    throw new Error(`history.${method} expects one options object`);
  }
  if (method === "search") {
    const parsed = searchInputSchema.safeParse(args[0] ?? {});
    if (!parsed.success) {
      throw new Error(`Invalid history.search options: ${formatZodError(parsed.error)}`);
    }
    return await history.search(parsed.data, signal);
  }
  if (method === "read") {
    const parsed = readInputSchema.safeParse(args[0]);
    if (!parsed.success) {
      throw new Error(`Invalid history.read options: ${formatZodError(parsed.error)}`);
    }
    return await history.read(parsed.data, signal);
  }
  throw new Error(`unsupported history method '${method}'`);
}

export function createHistoryToolDefinition(
  backend: ToolExecutionBackend,
  history: HistoryQuery,
): AgentTool {
  const implementation: CodeModeToolImplementation<HistoryArgs> = {
    schema: HISTORY_TOOL,
    timeoutMs: HISTORY_CODE_MODE_TIMEOUT_MS,
    parseArguments: parseHistoryArguments,
    execute: async ({ code, agentId, signal, backend: executionBackend }) =>
      executeInternalCodeMode({
        name: TOOL_NAME_HISTORY,
        documentation,
        api: {
          search: (args, context) => handleHistoryRequest("search", args, history, context.signal),
          read: (args, context) => handleHistoryRequest("read", args, history, context.signal),
        },
        code,
        agentId,
        backend: executionBackend,
        signal,
        timeoutMs: HISTORY_CODE_MODE_TIMEOUT_MS,
      }),
  };
  return createCodeModeToolDefinition(backend, implementation);
}
