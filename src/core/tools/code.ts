import { resolve } from "node:path";
import type { Tool } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { z } from "zod";
import {
  CODE_MODE_MAX_OUTPUT_TOKENS_DESCRIPTION,
  TAU_CODE_MODE_DEFAULT_MAX_OUTPUT_TOKENS,
  TAU_CODE_MODE_MAX_OUTPUT_TOKENS,
} from "../../code_mode/runtime.js";
import { type AgentsCapabilityOptions, createAgentsCapability } from "../code_mode/agents.js";
import { createBashCapability } from "../code_mode/bash.js";
import type { CodeModeCapability } from "../code_mode/capability.js";
import { createHistoryCapability } from "../code_mode/history.js";
import { createMcpCapability } from "../code_mode/mcp.js";
import { createModelsCapability } from "../code_mode/models.js";
import { bindCodeModeSdk } from "../code_mode/sdk.js";
import { createWebCapability } from "../code_mode/web.js";
import type { Config } from "../config/index.js";
import type { HistoryQuery } from "../history/types.js";
import type { McpManager } from "../mcp/manager.js";
import { formatZodError } from "../utils/zod.js";
import type { BashJobRegistry } from "./bash_jobs.js";
import type { CodeJobRegistry } from "./code_jobs.js";
import {
  type CodeModeToolImplementation,
  executeCodeModeTool,
  executeInternalCodeMode,
} from "./code_mode.js";
import type { ToolExecutionBackend } from "./execution_backend.js";
import { buildToolRunPresentation } from "./presentation.js";
import { type AgentTool, createTextToolOutcome, executeTool } from "./registry.js";
import { TOOL_NAME_CODE } from "./tool_names.js";

const CODE_DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const CODE_MAX_TIMEOUT_MS = 60 * 60 * 1000;
const CODE_MAX_INPUT_BYTES = 16 * 1024;
const commonArgs = {
  input: z.json().optional(),
  background: z.boolean().optional(),
  timeout: z.number().int().positive().max(CODE_MAX_TIMEOUT_MS).optional(),
  maxOutputTokens: z.number().int().min(1).max(TAU_CODE_MODE_MAX_OUTPUT_TOKENS).optional(),
};
const argsSchema = z
  .union([
    z.strictObject({ ...commonArgs, code: z.string().trim().min(1) }),
    z.strictObject({
      ...commonArgs,
      file: z
        .string()
        .min(1)
        .regex(/^[^\r\n]+\.js$/),
    }),
  ])
  .superRefine((args, context) => {
    if (args.background && ("timeout" in args || "maxOutputTokens" in args))
      context.addIssue({
        code: "custom",
        message:
          "Background programs do not accept timeout or maxOutputTokens. Set output budgets when inspecting jobs.",
      });
    if (
      args.input !== undefined &&
      Buffer.byteLength(JSON.stringify(args.input)) > CODE_MAX_INPUT_BYTES
    )
      context.addIssue({ code: "custom", message: "input exceeds the 16 KiB limit." });
  });

function getCodeSubject(raw: unknown): string {
  if (typeof raw === "object" && raw !== null) {
    if ("file" in raw && typeof raw.file === "string") return raw.file;
    if ("code" in raw && typeof raw.code === "string" && raw.code) return raw.code;
  }
  return "(invalid code)";
}

export function createCodeToolDefinition(options: {
  backend: ToolExecutionBackend;
  cwd: string;
  allowedTools: readonly string[];
  config: Config;
  bashJobs: BashJobRegistry;
  codeJobs: CodeJobRegistry;
  history?: HistoryQuery;
  mcp?: McpManager;
  agents?: AgentsCapabilityOptions;
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
  if (allowed.has("mcp") && options.mcp?.available)
    capabilities.push(createMcpCapability(options.mcp));
  if (allowed.has("models"))
    capabilities.push(createModelsCapability(options.backend, options.config));
  if (options.agents) capabilities.push(createAgentsCapability(options.agents, ""));
  if (!capabilities.length) return undefined;
  const sdkFor = (origin: string) =>
    bindCodeModeSdk(
      capabilities.map((capability) =>
        capability.name === "agents" ? createAgentsCapability(options.agents!, origin) : capability,
      ),
    );
  const schema: Tool = {
    name: TOOL_NAME_CODE,
    description: [
      "Run a JavaScript program using enabled Tau capabilities, either inline or from a saved .js file. Use it to chain dependent calls, combine independent work, or process results before printing a concise answer.",
      `Available capabilities: ${capabilities.map((capability) => capability.name).join(", ")}.`,
      ...capabilities.map((capability) => `tau.${capability.name}: ${capability.description}`),
      "When this tool is useful and its runtime guide is not visible, first run only printText(docs). Read it before writing a later program. Before using each capability, printText(await tau.docs(name)) in a documentation-only call unless that reference is already visible. Do not guess API signatures.",
      "Use printText(string) and await printImage({ data, mimeType }) for output. printText rejects objects and arrays: select relevant fields and format concise plain text to save tokens. Only use JSON.stringify on selected data when JSON structure is needed; do not dump whole responses. Return values are ignored. Programs have request and output limits, and foreground programs also have a deadline. Side effects are not rolled back and programs are not automatically retried.",
      "Use background: true only when you can make useful independent progress while the program runs. If you would only wait for it to finish, run it in the foreground with an appropriate timeout. A background launch returns a job ID; use the code job tools to read, wait for, or stop it. Jobs keep running across turns and interruptions, but are not recovered after a session restart.",
    ].join("\n\n"),
    parameters: Type.Object(
      {
        timeout: Type.Optional(
          Type.Integer({
            description:
              "Program timeout in milliseconds for foreground programs. Defaults to 300000 (5 minutes). Extend only when the work needs it, up to 3600000 (60 minutes). The deadline covers the whole program, including API calls. Cannot be combined with background: true.",
            minimum: 1,
            maximum: CODE_MAX_TIMEOUT_MS,
          }),
        ),
        maxOutputTokens: Type.Optional(
          Type.Integer({
            description: CODE_MODE_MAX_OUTPUT_TOKENS_DESCRIPTION,
            minimum: 1,
            maximum: TAU_CODE_MODE_MAX_OUTPUT_TOKENS,
          }),
        ),
        file: Type.Optional(
          Type.String({
            description:
              "Path to a saved .js program, absolute or relative to the current working directory. The file is read once when the call starts, can be at most 1 MiB, and runs with the same capabilities and limits as inline code. Supply exactly one of code or file.",
          }),
        ),
        input: Type.Optional(
          Type.Unknown({
            description:
              "JSON value available to the program as the global input. Defaults to null. At most 16 KiB when serialized as JSON.",
          }),
        ),
        background: Type.Optional(
          Type.Boolean({
            description:
              "Run as a background job and return its ID immediately. The job has no overall deadline. Cannot be combined with timeout or maxOutputTokens. Set the output budget when reading or waiting for the job.",
          }),
        ),
        code: Type.Optional(
          Type.String({
            description:
              "JavaScript source. Supply exactly one of code or file. Print relevant text with printText and forward images with awaited printImage.",
          }),
        ),
      },
      { additionalProperties: false },
    ),
  };
  const implementation: CodeModeToolImplementation = {
    schema,
    execute: async ({ code, input, maxOutputTokens, timeoutMs, context }) => {
      return await executeInternalCodeMode({
        name: "tau",
        ...sdkFor(context.assistantMessageId),
        code,
        input,
        maxOutputTokens,
        backend: options.backend,
        signal: context.signal,
        timeoutMs,
      });
    },
  };
  return {
    schema,
    describe: (call) => ({
      presentation: buildToolRunPresentation({
        toolName: TOOL_NAME_CODE,
        operation: "code",
        subject: getCodeSubject(call.arguments),
      }),
    }),
    execute: async (call, context) => {
      const parsed = argsSchema.safeParse(call.arguments);
      if (!parsed.success)
        return executeCodeModeTool(implementation, call, context, {
          ok: false,
          error: formatZodError(parsed.error),
          subject: getCodeSubject(call.arguments),
        });
      const args = parsed.data;
      const subject = "file" in args ? args.file : args.code;
      const source = "file" in args ? args.file : "inline code";
      try {
        context.signal.throwIfAborted();
        const code =
          "code" in args
            ? args.code
            : (
                await options.backend.readFileBinary(resolve(options.cwd, args.file), {
                  maxBytes: 1024 * 1024,
                })
              ).content.toString("utf8");
        if (!code.trim()) throw new Error("Program source must not be empty.");
        context.signal.throwIfAborted();
        if (args.background) {
          const id = options.codeJobs.start({
            source,
            cwd: options.cwd,
            backend: options.backend,
            signal: context.signal,
            program: {
              name: "tau",
              ...sdkFor(context.assistantMessageId),
              code,
              input: args.input,
            },
          });
          const text = `Started background code job ${id} from ${JSON.stringify(source)} in ${JSON.stringify(options.cwd)}. Use read_code_job to check progress or wait_for_code_jobs to wait for completion.`;
          return executeTool(context, () => ({
            ...createTextToolOutcome(text, "succeeded"),
            uiEvent: {
              type: "code_mode_finished",
              toolCallId: call.id,
              toolName: TOOL_NAME_CODE,
              status: "success",
              presentation: buildToolRunPresentation({
                toolName: TOOL_NAME_CODE,
                operation: "background",
                subject,
                details: [{ text }],
                actionOverrides: { succeeded: "started" },
              }),
            },
          }));
        }
        return executeCodeModeTool(implementation, call, context, {
          ok: true,
          code,
          input: args.input,
          subject,
          timeoutMs: args.timeout ?? CODE_DEFAULT_TIMEOUT_MS,
          maxOutputTokens: args.maxOutputTokens ?? TAU_CODE_MODE_DEFAULT_MAX_OUTPUT_TOKENS,
        });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        return executeTool(context, () => ({
          ...createTextToolOutcome(reason, context.signal.aborted ? "cancelled" : "failed"),
          uiEvent: {
            type: "code_mode_blocked",
            toolCallId: call.id,
            toolName: TOOL_NAME_CODE,
            reason,
            presentation: buildToolRunPresentation({
              toolName: TOOL_NAME_CODE,
              operation: "code",
              subject,
              details: [{ text: reason }],
            }),
          },
        }));
      }
    },
  };
}
