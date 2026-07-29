import type { Tool, ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import { createToolError, createToolResult } from "../utils/messages.js";
import { bytesToTokens } from "../utils/token.js";
import { formatBytes } from "../utils/truncate.js";
import { type BashOutputPolicy, buildBashUiText, prepareBashOutput } from "./bash.js";
import type { BashExecutionResult, ToolExecutionBackend } from "./execution_backend.js";
import type {
  ToolDefinition,
  ToolDispatch,
  ToolDispatchContext,
  ToolDispatchResult,
  ToolUiEvent,
} from "./registry.js";
import { createToolDispatch } from "./registry.js";

export type ParsedCodeModeArguments<TArgs> =
  | { ok: true; args: TArgs; code: string; displayTarget: string }
  | { ok: false; error: string; code: string; displayTarget: string };

export type CodeModeToolImplementation<TArgs, TRuntime> = {
  schema: Tool;
  label: string;
  outputPolicy: BashOutputPolicy;
  parseArguments(raw: unknown): ParsedCodeModeArguments<TArgs>;
  prepare(input: {
    backend: ToolExecutionBackend;
    context: ToolDispatchContext;
    signal: AbortSignal;
  }): Promise<TRuntime>;
  execute(input: {
    args: TArgs;
    code: string;
    runtime: TRuntime;
    backend: ToolExecutionBackend;
    context: ToolDispatchContext;
    signal: AbortSignal;
  }): Promise<BashExecutionResult>;
};

function formatCodeModeResultText(
  truncationInfo: Awaited<ReturnType<typeof prepareBashOutput>>,
  exitCode: number | null,
): string {
  const { model, captureTruncated, fullOutputPath } = truncationInfo;
  if (model.outputBytes === 0 && exitCode === 0) {
    return "Program produced no output (exit 0)";
  }

  const output = model.content.trimEnd();
  const truncationNote =
    model.truncated || captureTruncated
      ? `\n\n[Output truncated for context: ${model.outputLines} lines / ${formatBytes(model.outputBytes)} shown of ${model.totalLines} lines / ${formatBytes(model.totalBytes)} (full output estimate: ~${bytesToTokens(model.totalBytes)} tokens).${fullOutputPath ? ` Full output saved to ${fullOutputPath}.` : ""}]`
      : "";
  const exitNote = exitCode !== null && exitCode !== 0 ? `\n(exit ${exitCode})` : "";
  return `${output || "(no output)"}${truncationNote}${exitNote}`;
}

export function createCodeModeToolDefinition<TArgs, TRuntime>(
  backend: ToolExecutionBackend,
  implementation: CodeModeToolImplementation<TArgs, TRuntime>,
): ToolDefinition {
  return {
    schema: implementation.schema,
    getDisplayTarget: (toolCall) => implementation.parseArguments(toolCall.arguments).displayTarget,
    async dispatch(
      toolCall: ToolCall,
      signal: AbortSignal,
      context: ToolDispatchContext,
    ): Promise<ToolDispatch> {
      const parsed = implementation.parseArguments(toolCall.arguments);
      const headerTarget = parsed.displayTarget;

      const blocked = (reason: string): ToolDispatchResult => {
        const toolResult = createToolError(toolCall, reason);
        const uiEvent: ToolUiEvent = {
          type: "code_mode_blocked",
          toolCallId: toolCall.id,
          toolName: implementation.schema.name,
          label: implementation.label,
          code: parsed.code,
          headerTarget,
          reason,
        };
        return { toolResult, uiEvent };
      };

      if (!parsed.ok) {
        return createToolDispatch(() => blocked(`Invalid arguments: ${parsed.error}`));
      }

      return {
        startedUiEvent: {
          type: "code_mode_started",
          toolCallId: toolCall.id,
          toolName: implementation.schema.name,
          label: implementation.label,
          code: parsed.code,
          headerTarget,
        },
        run: (async () => {
          try {
            const startedAt = Date.now();
            const runtime = await implementation.prepare({ backend, context, signal });
            const execution = await implementation.execute({
              args: parsed.args,
              code: parsed.code,
              runtime,
              backend,
              context,
              signal,
            });
            const durationMs = Math.max(0, Date.now() - startedAt);
            const truncationInfo = await prepareBashOutput(
              execution.output,
              execution.truncated,
              implementation.outputPolicy,
              backend,
            );
            const toolText = formatCodeModeResultText(truncationInfo, execution.exitCode);
            const isError = execution.exitCode === null || execution.exitCode !== 0;
            const uiText = buildBashUiText({
              truncationInfo,
              exitCode: execution.exitCode,
              durationMs,
              fullText: toolText,
            });
            const toolResult: ToolResultMessage = createToolResult(toolCall, toolText, isError);
            const uiEvent: ToolUiEvent = {
              type: "code_mode_finished",
              toolCallId: toolCall.id,
              toolName: implementation.schema.name,
              label: implementation.label,
              code: parsed.code,
              headerTarget,
              status: isError ? "error" : "success",
              uiText,
            };
            return { toolResult, uiEvent };
          } catch (error) {
            return blocked(error instanceof Error ? error.message : String(error));
          }
        })(),
      };
    },
  };
}
