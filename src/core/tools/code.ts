import type { Tool } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { z } from "zod";
import {
  CODE_MODE_MAX_OUTPUT_TOKENS_DESCRIPTION,
  describeTauCodeModePackages,
  TAU_CODE_MODE_DEFAULT_MAX_OUTPUT_TOKENS,
  TAU_CODE_MODE_MAX_OUTPUT_TOKENS,
} from "../../code_mode/runtime.js";
import type { AgentCapabilities } from "../agent/capabilities.js";
import type { NotificationInbox } from "../agent/notification_inbox.js";
import {
  type AgentsPackageOptions,
  agentsPackageDescription,
  createAgentsPackage,
  createUnavailableAgentsPackage,
} from "../code_mode/agents.js";
import { createBashPackage } from "../code_mode/bash.js";
import { createFilesPackage } from "../code_mode/files.js";
import { createHistoryPackage } from "../code_mode/history.js";
import { createMcpPackage } from "../code_mode/mcp.js";
import { createModelsPackage } from "../code_mode/models.js";
import { createNotificationsPackage } from "../code_mode/notifications.js";
import type { CodeModePackage } from "../code_mode/package.js";
import { createWebPackage } from "../code_mode/web.js";
import type { SessionRuntimeSettings } from "../config/index.js";
import type { HistoryQuery } from "../history/types.js";
import type { McpManager } from "../mcp/manager.js";
import { formatZodError } from "../utils/zod.js";
import type { BashJobRegistry } from "./bash_jobs.js";
import type { CodeJobRegistry } from "./code_jobs.js";
import {
  type CodeProgramRun,
  presentCodeProgramBlocked,
  presentCodeProgramResult,
  runCodeProgram,
} from "./code_mode.js";
import { loadCodeProgram } from "./code_modules.js";
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

/** The `code` tool with every Tau package. Capabilities decide which calls succeed. */
export function createCodeToolDefinition(options: {
  backend: ToolExecutionBackend;
  cwd: string;
  config: SessionRuntimeSettings;
  bashJobs: BashJobRegistry;
  codeJobs: CodeJobRegistry;
  history: HistoryQuery;
  mcp: McpManager;
  notifications: NotificationInbox;
  capabilities: AgentCapabilities;
  agents?: AgentsPackageOptions;
}): AgentTool {
  const { capabilities } = options;
  const packages: CodeModePackage[] = [
    createBashPackage(options.backend, options.cwd, options.bashJobs),
    createFilesPackage(options.backend),
    createWebPackage(options.backend, options.config, capabilities.web),
    createModelsPackage(options.backend, options.config, capabilities.models),
    createHistoryPackage(options.history),
    createMcpPackage(options.mcp),
    createNotificationsPackage(options.notifications),
  ];
  const agents = options.agents;
  return createCodeTool({
    backend: options.backend,
    cwd: options.cwd,
    codeJobs: options.codeJobs,
    summaries: [...packages, { name: "@tau/agents", description: agentsPackageDescription }],
    packagesFor: (origin) => [
      ...packages,
      agents
        ? createAgentsPackage(agents, capabilities, origin)
        : createUnavailableAgentsPackage(capabilities.delegation),
    ],
  });
}

/**
 * The `code` tool over a fixed set of packages. `packagesFor` receives the assistant message
 * that launches a program, because `@tau/agents` records it as the origin of new workers.
 */
export function createCodeTool(options: {
  backend: ToolExecutionBackend;
  cwd: string;
  codeJobs: CodeJobRegistry;
  summaries: ReadonlyArray<{ name: string; description: string }>;
  packagesFor(origin: string): CodeModePackage[];
}): AgentTool {
  const schema: Tool = {
    name: TOOL_NAME_CODE,
    description: [
      "Run a JavaScript program that imports Tau packages, either inline or from a saved .js file. Use it to pass results between dependent calls, run independent work in parallel, or reduce large results before printing a short answer. A direct tool call is simpler when a program adds nothing.",
      `${describeTauCodeModePackages(options.summaries)} \`docs("examples")\` returns recipes that combine packages.`,
      "Only printed output comes back. Side effects are not rolled back, and programs are not retried automatically.",
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
              "Path to a saved .js program, absolute or relative to the current working directory. It runs like inline code, and each source file can be at most 1 MiB. Supply exactly one of code or file.",
          }),
        ),
        input: Type.Optional(
          Type.Unknown({
            description:
              "JSON value available as the input export of @tau/core. Defaults to null. At most 16 KiB when serialized as JSON.",
          }),
        ),
        background: Type.Optional(
          Type.Boolean({
            description:
              "Run as a background job and return its ID immediately. Use it only when you can make useful progress while the program runs. The job has no overall deadline and keeps running across turns and interruptions, but is lost when the session restarts. Read, wait for, or stop it with the code job tools, and set the output budget there. Cannot be combined with timeout or maxOutputTokens.",
          }),
        ),
        code: Type.Optional(
          Type.String({
            description:
              "JavaScript source. Supply exactly one of code or file. Print relevant text with printText and forward images with awaited printImage, both from @tau/core.",
          }),
        ),
      },
      { additionalProperties: false },
    ),
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
      if (!parsed.success) {
        const reason = `Invalid arguments: ${formatZodError(parsed.error)}`;
        return executeTool(
          context,
          presentCodeProgramBlocked(call, getCodeSubject(call.arguments), reason, "blocked"),
        );
      }
      const args = parsed.data;
      const subject = "file" in args ? args.file : args.code;
      const source = "file" in args ? args.file : "inline code";
      let run: CodeProgramRun;
      let jobId: string | undefined;
      try {
        context.signal.throwIfAborted();
        const program = await loadCodeProgram({
          backend: options.backend,
          cwd: options.cwd,
          source: args,
          signal: context.signal,
        });
        context.signal.throwIfAborted();
        run = {
          program,
          packages: options.packagesFor(context.assistantMessageId),
          input: args.input,
        };
        if (args.background)
          jobId = options.codeJobs.start({ source, backend: options.backend, run });
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        const outcome = context.signal.aborted ? "cancelled" : "failed";
        return executeTool(context, presentCodeProgramBlocked(call, subject, reason, outcome));
      }
      if (jobId !== undefined) {
        const text = `Started background code job ${jobId} from ${JSON.stringify(source)} in ${JSON.stringify(options.cwd)}. Use read_code_job to check progress or wait_for_code_jobs to wait for completion.`;
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
      const timeoutMs = args.timeout ?? CODE_DEFAULT_TIMEOUT_MS;
      return executeTool(
        context,
        async () => {
          try {
            const runtime = await runCodeProgram(options.backend, run, {
              signal: context.signal,
              timeoutMs,
              maxOutputTokens: args.maxOutputTokens ?? TAU_CODE_MODE_DEFAULT_MAX_OUTPUT_TOKENS,
              persistTruncatedOutput: true,
            });
            return presentCodeProgramResult(call, subject, timeoutMs, runtime);
          } catch (error) {
            const reason = `Could not execute program: ${error instanceof Error ? error.message : String(error)}`;
            return presentCodeProgramBlocked(call, subject, reason, "failed");
          }
        },
        {
          type: "code_mode_started",
          toolCallId: call.id,
          toolName: TOOL_NAME_CODE,
          presentation: buildToolRunPresentation({
            toolName: TOOL_NAME_CODE,
            operation: TOOL_NAME_CODE,
            subject,
          }),
        },
      );
    },
  };
}
