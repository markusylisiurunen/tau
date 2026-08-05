import type { Tool, ToolCall } from "@earendil-works/pi-ai";
import { bytesToTokens } from "../utils/token.js";
import { formatBytes } from "../utils/truncate.js";
import type { ToolActivity } from "./activity.js";
import { type BashOutputPolicy, buildBashPresentation, prepareBashOutput } from "./bash.js";
import type { BashExecutionResult, ToolExecutionBackend } from "./execution_backend.js";
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
  return [
    ...introduction,
    `Top-level await is supported. The program receives ${sdkGlobal}, docs, and console globals.`,
    "Only text written through console methods is returned; program return values are ignored.",
    "The SDK is progressively disclosed through docs.",
    "When this tool is useful for a task, your first call to it must be a documentation-only program that does nothing except print docs with console.log(docs).",
    `Read the returned documentation before writing a later tool call that uses ${sdkGlobal}.`,
    "Do not guess SDK signatures or reuse signatures from other code-mode tools.",
    ...additionalDocumentation,
  ].join(" ");
}

export type CodeModeToolImplementation<TArgs> = {
  schema: Tool;
  outputPolicy: BashOutputPolicy;
  timeoutMs?: number;
  parseArguments(raw: unknown): ParsedCodeModeArguments<TArgs>;
  getBlockedReason?(args: TArgs): string | undefined;
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
      return {
        presentation: buildToolRunPresentation({
          toolName: implementation.schema.name,
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
            subject: parsed.code || subject,
            details: [{ text: reason, tone: "error" }],
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
            const semanticOutcome =
              execution.aborted || execution.timedOut
                ? "cancelled"
                : isError
                  ? "failed"
                  : "succeeded";
            const presentation = buildBashPresentation({
              toolName: implementation.schema.name,
              subject: parsed.code || subject,
              truncationInfo,
              exitCode: execution.exitCode,
              durationMs,
            });
            const outcome = createTextToolOutcome(toolText, semanticOutcome);
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
            subject: parsed.code || subject,
          }),
        },
      );
    },
  };
}
