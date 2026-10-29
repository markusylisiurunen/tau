import { resolve } from "node:path";
import { Type } from "typebox";
import { z } from "zod";
import {
  CODE_MODE_MAX_OUTPUT_TOKENS_DESCRIPTION,
  TAU_CODE_MODE_DEFAULT_MAX_OUTPUT_TOKENS,
  TAU_CODE_MODE_MAX_OUTPUT_TOKENS,
} from "../../code_mode/runtime.js";
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
import { createCodeModeToolDefinition, executeInternalCodeMode } from "./code_mode.js";
import type { ToolExecutionBackend } from "./execution_backend.js";
import { buildToolRunPresentation } from "./presentation.js";
import { type AgentTool, createTextToolOutcome, executeTool } from "./registry.js";
import { TOOL_NAME_CODE } from "./tool_names.js";

const CODE_DEFAULT_TIMEOUT_MS = 5 * 60 * 1000;
const CODE_MAX_TIMEOUT_MS = 15 * 60 * 1000;
const argsSchema = z
  .strictObject({
    code: z.string().trim().min(1).optional(),
    file: z
      .string()
      .min(1)
      .regex(/^[^\r\n]+\.js$/)
      .optional(),
    input: z.json().optional(),
    background: z.boolean().optional(),
    timeout: z.number().int().positive().max(CODE_MAX_TIMEOUT_MS).optional(),
    maxOutputTokens: z.number().int().min(1).max(TAU_CODE_MODE_MAX_OUTPUT_TOKENS).optional(),
  })
  .superRefine((args, context) => {
    if ((args.code !== undefined) === (args.file !== undefined))
      context.addIssue({ code: "custom", message: "Provide exactly one of code or file." });
    if (args.background && ("timeout" in args || "maxOutputTokens" in args))
      context.addIssue({
        code: "custom",
        message:
          "Background programs do not accept timeout or maxOutputTokens. Set output budgets when inspecting jobs.",
      });
    if (args.input !== undefined && Buffer.byteLength(JSON.stringify(args.input)) > 1024 * 1024)
      context.addIssue({ code: "custom", message: "input exceeds the 1 MiB limit." });
  });

export function createCodeToolDefinition(options: {
  backend: ToolExecutionBackend;
  cwd: string;
  allowedTools: readonly string[];
  config: Config;
  bashJobs: BashJobRegistry;
  codeJobs: CodeJobRegistry;
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
  if (allowed.has("mcp") && options.mcp?.available)
    capabilities.push(createMcpCapability(options.mcp));
  if (allowed.has("models"))
    capabilities.push(createModelsCapability(options.backend, options.config));
  if (!capabilities.length) return undefined;
  const sdk = bindCodeModeSdk(capabilities);
  const foreground = createCodeModeToolDefinition({
    schema: {
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
                "Program timeout in milliseconds for foreground programs. Defaults to 300000 (5 minutes). Extend only when the work needs it, up to 900000 (15 minutes). The deadline covers the whole program, including API calls. Cannot be combined with background: true.",
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
                "JSON value available to the program as the global input. Defaults to null. At most 1 MiB when serialized.",
            }),
          ),
          background: Type.Optional(
            Type.Boolean({
              description:
                "Run as a session-owned background job and return its ID immediately. The job has no overall deadline. Cannot be combined with timeout or maxOutputTokens; set an output budget when reading or waiting for the job instead.",
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
    },
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
        ? {
            ok: true,
            code: parsed.data.code ?? "",
            input: parsed.data.input,
            timeoutMs: parsed.data.timeout ?? CODE_DEFAULT_TIMEOUT_MS,
            maxOutputTokens: parsed.data.maxOutputTokens ?? TAU_CODE_MODE_DEFAULT_MAX_OUTPUT_TOKENS,
            subject,
          }
        : { ok: false, error: formatZodError(parsed.error), code, subject };
    },
    execute: async ({ code, input, maxOutputTokens, timeoutMs, context }) => {
      return await executeInternalCodeMode({
        name: "tau",
        ...sdk,
        code,
        input,
        maxOutputTokens,
        backend: options.backend,
        signal: context.signal,
        timeoutMs,
      });
    },
  });
  return {
    ...foreground,
    describe: (call) =>
      foreground.describe({
        ...call,
        arguments:
          typeof call.arguments === "object" && call.arguments !== null && "file" in call.arguments
            ? { code: call.arguments.file }
            : call.arguments,
      }),
    execute: async (call, context) => {
      const parsed = argsSchema.safeParse(call.arguments);
      if (!parsed.success) return foreground.execute(call, context);
      const args = parsed.data;
      try {
        context.signal.throwIfAborted();
        const code =
          args.file === undefined
            ? args.code!
            : (
                await options.backend.readFileBinary(resolve(options.cwd, args.file), {
                  maxBytes: 1024 * 1024,
                })
              ).content.toString("utf8");
        if (!code.trim()) throw new Error("Program source must not be empty.");
        context.signal.throwIfAborted();
        if (args.background) {
          const id = options.codeJobs.start({
            source: args.file ?? "inline code",
            cwd: options.cwd,
            backend: options.backend,
            signal: context.signal,
            program: { name: "tau", ...sdk, code, input: args.input },
          });
          const text = `Started background code job ${id} from ${JSON.stringify(args.file ?? "inline code")} in ${JSON.stringify(options.cwd)}. Use read_code_job to check progress or wait_for_code_jobs to wait for completion.`;
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
                subject: args.file ?? args.code!,
                details: [{ text }],
                actionOverrides: { succeeded: "started" },
              }),
            },
          }));
        }
        return foreground.execute(
          {
            ...call,
            arguments: {
              code,
              ...(args.input !== undefined ? { input: args.input } : {}),
              ...(args.timeout !== undefined ? { timeout: args.timeout } : {}),
              ...(args.maxOutputTokens !== undefined
                ? { maxOutputTokens: args.maxOutputTokens }
                : {}),
            },
          },
          context,
        );
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
              subject: args.file ?? args.code!,
              details: [{ text: reason }],
            }),
          },
        }));
      }
    },
  };
}
