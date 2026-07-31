import type { Tool, ToolCall } from "@earendil-works/pi-ai";
import { bytesToTokens } from "../utils/token.js";
import { formatBytes } from "../utils/truncate.js";
import { type BashOutputPolicy, buildBashUiText, prepareBashOutput } from "./bash.js";
import type { BashExecutionResult, ToolExecutionBackend } from "./execution_backend.js";
import {
  type AgentTool,
  createTextToolOutcome,
  executeTool,
  type ToolExecutionContext,
  type ToolExecutionOutcome,
  type ToolImplementationOutcome,
  type ToolUiEvent,
} from "./registry.js";

export type ParsedCodeModeArguments<TArgs> =
  | { ok: true; args: TArgs; code: string; displayTarget: string }
  | { ok: false; error: string; code: string; displayTarget: string };

export type CodeModeToolImplementation<TArgs> = {
  schema: Tool;
  outputPolicy: BashOutputPolicy;
  timeoutMs?: number;
  parseArguments(raw: unknown): ParsedCodeModeArguments<TArgs>;
  execute(input: {
    args: TArgs;
    code: string;
    backend: ToolExecutionBackend;
    signal: AbortSignal;
  }): Promise<BashExecutionResult>;
};

function getCodeModeTerminationNote(
  execution: BashExecutionResult,
  timeoutMs: number | undefined,
): string | undefined {
  if (execution.timedOut) {
    return `(tau) timed out${timeoutMs === undefined ? "" : ` after ${timeoutMs}ms`}`;
  }
  if (execution.aborted) return "(tau) aborted";
  if (execution.closeSignal) return `(tau) terminated by signal ${execution.closeSignal}`;
  return undefined;
}

function formatCodeModeResultText(
  truncationInfo: Awaited<ReturnType<typeof prepareBashOutput>>,
  execution: BashExecutionResult,
  terminated: boolean,
): string {
  const { model, captureTruncated, fullOutputPath } = truncationInfo;
  if (model.outputBytes === 0 && execution.exitCode === 0) {
    return "Program produced no output (exit 0)";
  }

  const output = model.content.trimEnd();
  const truncationNote =
    model.truncated || captureTruncated
      ? `\n\n[Output truncated for context: ${model.outputLines} lines / ${formatBytes(model.outputBytes)} shown of ${model.totalLines} lines / ${formatBytes(model.totalBytes)} (full output estimate: ~${bytesToTokens(model.totalBytes)} tokens).${fullOutputPath ? ` Full output saved to ${fullOutputPath}.` : ""}]`
      : "";
  const exitNote =
    !terminated && execution.exitCode !== null && execution.exitCode !== 0
      ? `\n(exit ${execution.exitCode})`
      : "";
  return `${output || "(no output)"}${truncationNote}${exitNote}`;
}

export function createCodeModeToolDefinition<TArgs>(
  backend: ToolExecutionBackend,
  implementation: CodeModeToolImplementation<TArgs>,
): AgentTool {
  return {
    schema: implementation.schema,
    describe: (toolCall) => {
      const parsed = implementation.parseArguments(toolCall.arguments);
      return { headerTarget: parsed.displayTarget, code: parsed.code };
    },
    async execute(
      toolCall: ToolCall,
      context: ToolExecutionContext,
    ): Promise<ToolExecutionOutcome> {
      const { signal } = context;
      const parsed = implementation.parseArguments(toolCall.arguments);
      const headerTarget = parsed.displayTarget;

      const blocked = (reason: string): ToolImplementationOutcome => {
        const outcome = createTextToolOutcome(reason, true);
        const uiEvent: ToolUiEvent = {
          type: "code_mode_blocked",
          toolCallId: toolCall.id,
          toolName: implementation.schema.name,
          code: parsed.code,
          headerTarget,
          reason,
        };
        return { content: outcome.content, isError: outcome.isError, uiEvent };
      };

      if (!parsed.ok) {
        return executeTool(context, () => blocked(`Invalid arguments: ${parsed.error}`));
      }

      return executeTool(
        context,
        async () => {
          try {
            const startedAt = Date.now();
            const execution = await implementation.execute({
              args: parsed.args,
              code: parsed.code,
              backend,
              signal,
            });
            const durationMs = Math.max(0, Date.now() - startedAt);
            const terminationNote = getCodeModeTerminationNote(execution, implementation.timeoutMs);
            const output = terminationNote
              ? `${execution.output}${execution.output && !execution.output.endsWith("\n") ? "\n" : ""}${terminationNote}\n`
              : execution.output;
            const truncationInfo = await prepareBashOutput(
              output,
              execution.truncated,
              implementation.outputPolicy,
              backend,
            );
            const toolText = formatCodeModeResultText(
              truncationInfo,
              execution,
              terminationNote !== undefined,
            );
            const isError = execution.exitCode === null || execution.exitCode !== 0;
            const uiText = buildBashUiText({
              truncationInfo,
              exitCode: execution.exitCode,
              durationMs,
              fullText: toolText,
            });
            const outcome = createTextToolOutcome(toolText, isError);
            const uiEvent: ToolUiEvent = {
              type: "code_mode_finished",
              toolCallId: toolCall.id,
              toolName: implementation.schema.name,
              code: parsed.code,
              headerTarget,
              status: isError ? "error" : "success",
              uiText,
            };
            return { content: outcome.content, isError: outcome.isError, uiEvent };
          } catch (error) {
            return blocked(error instanceof Error ? error.message : String(error));
          }
        },
        {
          type: "code_mode_started",
          toolCallId: toolCall.id,
          toolName: implementation.schema.name,
          code: parsed.code,
          headerTarget,
        },
      );
    },
  };
}
