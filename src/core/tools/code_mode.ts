import type { Tool, ToolCall } from "@earendil-works/pi-ai";
import {
  buildTauCodeModeToolDescription,
  runTauCodeMode,
  type TauCodeModeApi,
  type TauCodeModeRuntimeResult,
} from "../../code_mode/runtime.js";
import type { ToolActivity } from "./activity.js";
import { buildBashPresentation, writeBashTempFile } from "./bash.js";
import type { ToolExecutionBackend } from "./execution_backend.js";
import { buildToolRunPresentation } from "./presentation.js";
import {
  type AgentTool,
  createTextToolOutcome,
  executeTool,
  type ToolExecutionContext,
  type ToolExecutionOutcome,
  type ToolImplementationOutcome,
} from "./registry.js";

export type ParsedCodeModeArguments<TArgs> =
  | { ok: true; args: TArgs; code: string; subject: string }
  | { ok: false; error: string; code: string; subject: string };

type CodeModeToolDescriptionOptions = {
  sdkGlobal: string;
  introduction: string[];
  additionalDocumentation?: string[];
};

export function buildCodeModeToolDescription({
  sdkGlobal,
  introduction,
  additionalDocumentation = [],
}: CodeModeToolDescriptionOptions): string {
  return buildTauCodeModeToolDescription({
    name: sdkGlobal,
    description: [...introduction, ...additionalDocumentation].join(" "),
  });
}

export type CodeModeToolImplementation<TArgs> = {
  schema: Tool;
  timeoutMs?: number;
  parseArguments(raw: unknown): ParsedCodeModeArguments<TArgs>;
  getBlockedReason?(args: TArgs): string | undefined;
  execute(input: {
    args: TArgs;
    code: string;
    agentId: string;
    backend: ToolExecutionBackend;
    signal: AbortSignal;
  }): Promise<TauCodeModeRuntimeResult>;
};

export function executeInternalCodeMode(options: {
  name: string;
  documentation: string;
  api: TauCodeModeApi;
  code: string;
  agentId: string;
  backend: ToolExecutionBackend;
  signal: AbortSignal;
  timeoutMs?: number;
}): Promise<TauCodeModeRuntimeResult> {
  return runTauCodeMode({
    name: options.name,
    documentation: options.documentation,
    api: options.api,
    code: options.code,
    signal: options.signal,
    ...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
    files: {
      agentId: options.agentId,
      adapter: {
        runNodeScript: async (script, fileOptions) =>
          await options.backend.runNodeScript(script, [], {
            signal: fileOptions.signal,
            stdin: Buffer.from(fileOptions.input),
            maxCaptureBytes: fileOptions.maxCaptureBytes,
          }),
      },
    },
    persistOutput: async (output) => {
      if (!output.contextTruncated) return undefined;
      const path = await writeBashTempFile(options.backend, output.content);
      return path ? { path } : undefined;
    },
  });
}

function getCodeModeTerminationNote(
  runtime: TauCodeModeRuntimeResult,
  timeoutMs: number | undefined,
): string | undefined {
  if (runtime.status === "timed-out") {
    return `(tau) timed out${timeoutMs === undefined ? "" : ` after ${timeoutMs}ms`}`;
  }
  if (runtime.status === "cancelled") return "(tau) aborted";
  if (runtime.execution.closeSignal) {
    return `(tau) terminated by signal ${runtime.execution.closeSignal}`;
  }
  return undefined;
}

export function createCodeModeToolDefinition<TArgs>(
  backend: ToolExecutionBackend,
  implementation: CodeModeToolImplementation<TArgs>,
): AgentTool {
  return {
    schema: implementation.schema,
    describe: (toolCall) => {
      const parsed = implementation.parseArguments(toolCall.arguments);
      return {
        presentation: buildToolRunPresentation({
          toolName: implementation.schema.name,
          operation: implementation.schema.name,
          subject: parsed.code || parsed.subject,
        }),
      };
    },
    async execute(
      toolCall: ToolCall,
      context: ToolExecutionContext,
    ): Promise<ToolExecutionOutcome> {
      const { signal } = context;
      const parsed = implementation.parseArguments(toolCall.arguments);
      const subject = parsed.subject;

      const blocked = (
        reason: string,
        semanticOutcome: ToolExecutionOutcome["outcome"] = "blocked",
      ): ToolImplementationOutcome => {
        const outcome = createTextToolOutcome(reason, semanticOutcome);
        const uiEvent: ToolActivity = {
          type: "code_mode_blocked",
          toolCallId: toolCall.id,
          toolName: implementation.schema.name,
          presentation: buildToolRunPresentation({
            toolName: implementation.schema.name,
            operation: implementation.schema.name,
            subject: parsed.code || subject,
            details: [{ text: reason }],
          }),
          reason,
        };
        return { content: outcome.content, outcome: outcome.outcome, uiEvent };
      };

      if (!parsed.ok) {
        return executeTool(context, () => blocked(`Invalid arguments: ${parsed.error}`));
      }
      const blockedReason = implementation.getBlockedReason?.(parsed.args);
      if (blockedReason) {
        return executeTool(context, () => blocked(blockedReason));
      }

      return executeTool(
        context,
        async () => {
          try {
            const runtime = await implementation.execute({
              args: parsed.args,
              code: parsed.code,
              agentId: context.agentId,
              backend,
              signal,
            });
            const execution = runtime.execution;
            const terminationNote = getCodeModeTerminationNote(runtime, implementation.timeoutMs);
            const isError = runtime.status !== "succeeded";
            const semanticOutcome =
              runtime.status === "cancelled" || runtime.status === "timed-out"
                ? "cancelled"
                : isError
                  ? "failed"
                  : "succeeded";
            const outputPresentation = buildBashPresentation({
              toolName: implementation.schema.name,
              operation: implementation.schema.name,
              subject: parsed.code || subject,
              truncationInfo: {
                output: runtime.projection.content,
                model: runtime.projection,
                captureTruncated: execution.truncated,
                ...(runtime.persistedPath ? { fullOutputPath: runtime.persistedPath } : {}),
              },
              exitCode: execution.exitCode,
              durationMs: runtime.durationMs,
              includeExitCode: false,
            });
            const presentation = terminationNote
              ? {
                  ...outputPresentation,
                  details: outputPresentation.details.map((line) =>
                    line.text === terminationNote ? { ...line, wrap: "word" as const } : line,
                  ),
                }
              : outputPresentation;
            const outcome = createTextToolOutcome(runtime.result.content, semanticOutcome);
            const uiEvent: ToolActivity = {
              type: "code_mode_finished",
              toolCallId: toolCall.id,
              toolName: implementation.schema.name,
              presentation,
              status: isError ? "error" : "success",
            };
            return { content: outcome.content, outcome: outcome.outcome, uiEvent };
          } catch (error) {
            return blocked(error instanceof Error ? error.message : String(error), "failed");
          }
        },
        {
          type: "code_mode_started",
          toolCallId: toolCall.id,
          toolName: implementation.schema.name,
          presentation: buildToolRunPresentation({
            toolName: implementation.schema.name,
            operation: implementation.schema.name,
            subject: parsed.code || subject,
          }),
        },
      );
    },
  };
}
