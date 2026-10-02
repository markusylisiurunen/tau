import type { Tool, ToolCall } from "@earendil-works/pi-ai";
import {
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

export type ParsedCodeModeArguments =
  | { ok: true; code: string; subject: string }
  | { ok: false; error: string; code: string; subject: string };

export type CodeModeToolImplementation = {
  schema: Tool;
  timeoutMs: number;
  parseArguments(raw: unknown): ParsedCodeModeArguments;
  execute(input: {
    context: ToolExecutionContext;
    code: string;
  }): Promise<TauCodeModeRuntimeResult>;
};

export function executeInternalCodeMode(options: {
  name: string;
  documentation: string;
  api: TauCodeModeApi;
  code: string;
  backend: ToolExecutionBackend;
  signal: AbortSignal;
  timeoutMs: number;
}): Promise<TauCodeModeRuntimeResult> {
  return runTauCodeMode({
    name: options.name,
    documentation: options.documentation,
    api: options.api,
    code: options.code,
    signal: options.signal,
    timeoutMs: options.timeoutMs,
    persistOutput: async (output) => {
      if (!output.contextTruncated) return undefined;
      const path = await writeBashTempFile(options.backend, output.content);
      return path ? { path } : undefined;
    },
  });
}

function getCodeModeTerminationNote(
  runtime: TauCodeModeRuntimeResult,
  timeoutMs: number,
): string | undefined {
  if (runtime.status === "timed-out") {
    return `Program timed out after ${timeoutMs}ms.`;
  }
  if (runtime.status === "cancelled") return "Program was cancelled.";
  if (runtime.execution.closeSignal) {
    return `Program was terminated by signal ${runtime.execution.closeSignal}.`;
  }
  return undefined;
}

export function createCodeModeToolDefinition(
  implementation: CodeModeToolImplementation,
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

      return executeTool(
        context,
        async () => {
          try {
            const runtime = await implementation.execute({
              context,
              code: parsed.code,
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
                    line.text === terminationNote || line.text === `[${terminationNote}]`
                      ? { ...line, wrap: "word" as const }
                      : line,
                  ),
                }
              : outputPresentation;
            const uiEvent: ToolActivity = {
              type: "code_mode_finished",
              toolCallId: toolCall.id,
              toolName: implementation.schema.name,
              presentation,
              status: isError ? "error" : "success",
            };
            return {
              content: runtime.result.content,
              outcome: semanticOutcome,
              uiEvent,
            };
          } catch (error) {
            const errorMessage = error instanceof Error ? error.message : String(error);
            return blocked(`Could not execute program: ${errorMessage}`, "failed");
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
