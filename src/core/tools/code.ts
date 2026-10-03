import { Type } from "typebox";
import { z } from "zod";
import { createBashCapability } from "../code_mode/bash.js";
import type { CodeModeCapability } from "../code_mode/capability.js";
import { createHistoryCapability } from "../code_mode/history.js";
import { createMcpCapability } from "../code_mode/mcp.js";
import { createModelsCapability } from "../code_mode/models.js";
import { createNookCapability } from "../code_mode/nook.js";
import { bindCodeModeSdk } from "../code_mode/sdk.js";
import { createWebCapability } from "../code_mode/web.js";
import type { Config } from "../config/index.js";
import type { HistoryQuery } from "../history/types.js";
import type { McpManager } from "../mcp/manager.js";
import { formatZodError } from "../utils/zod.js";
import type { BashJobRegistry } from "./bash_jobs.js";
import { createCodeModeToolDefinition, executeInternalCodeMode } from "./code_mode.js";
import type { ToolExecutionBackend } from "./execution_backend.js";
import type { AgentTool } from "./registry.js";
import { TOOL_NAME_CODE } from "./tool_names.js";

const CODE_TIMEOUT_MS = 15 * 60 * 1000;
const argsSchema = z.strictObject({ code: z.string().trim().min(1) });

export function createCodeToolDefinition(options: {
  backend: ToolExecutionBackend;
  cwd: string;
  allowedTools: readonly string[];
  config: Config;
  bashJobs: BashJobRegistry;
  history?: HistoryQuery;
  mcp?: McpManager;
}): AgentTool | undefined {
  const allowed = new Set(options.allowedTools);
  const capabilities: CodeModeCapability[] = [];
  if (allowed.has("bash"))
    capabilities.push(createBashCapability(options.backend, options.cwd, options.bashJobs));
  if (allowed.has("web")) capabilities.push(createWebCapability(options.backend, options.config));
  if (allowed.has("history")) {
    if (!options.history) throw new Error("history query is required when history is enabled");
    capabilities.push(createHistoryCapability(options.history));
  }
  if (allowed.has("nook") && options.config.nook)
    capabilities.push(createNookCapability(options.backend, options.config));
  if (allowed.has("mcp") && options.mcp?.available)
    capabilities.push(createMcpCapability(options.mcp));
  if (allowed.has("models"))
    capabilities.push(createModelsCapability(options.backend, options.config));
  if (!capabilities.length) return undefined;
  const sdk = bindCodeModeSdk(capabilities);
  return createCodeModeToolDefinition({
    schema: {
      name: TOOL_NAME_CODE,
      description: [
        "Run a one-shot JavaScript program using enabled Tau capabilities. Use it to chain dependent calls, combine independent work, or process results before printing a concise answer.",
        `Available capabilities: ${capabilities.map((capability) => capability.name).join(", ")}.`,
        ...capabilities.map((capability) => `tau.${capability.name}: ${capability.description}`),
        "When this tool is useful and its runtime guide is not visible, first run only printText(docs). Read it before writing a later program. Before using each capability, printText(await tau.docs(name)) in a documentation-only call unless that reference is already visible. Do not guess API signatures.",
        "Use printText(string) and await printImage({ data, mimeType }) for output. Return values are ignored. Programs have finite execution, request, and output limits. Side effects are not rolled back and programs are not automatically retried.",
      ].join("\n\n"),
      parameters: Type.Object(
        {
          code: Type.String({
            description:
              "JavaScript source. Print relevant text with printText and forward images with awaited printImage.",
          }),
        },
        { additionalProperties: false },
      ),
    },
    timeoutMs: CODE_TIMEOUT_MS,
    parseArguments(raw) {
      const code =
        typeof raw === "object" && raw !== null && "code" in raw && typeof raw.code === "string"
          ? raw.code
          : "";
      const subject =
        code
          .split(/\r?\n/)
          .map((line) => line.trim())
          .find(Boolean) ?? "(invalid code)";
      const parsed = argsSchema.safeParse(raw);
      return parsed.success
        ? { ok: true, code: parsed.data.code, subject }
        : { ok: false, error: formatZodError(parsed.error), code, subject };
    },
    execute: async ({ code, context }) => {
      return await executeInternalCodeMode({
        name: "tau",
        ...sdk,
        code,
        backend: options.backend,
        signal: context.signal,
        timeoutMs: CODE_TIMEOUT_MS,
      });
    },
  });
}
