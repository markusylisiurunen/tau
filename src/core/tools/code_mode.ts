import type { ToolCall } from "@earendil-works/pi-ai";
import type { CodeModeOutput } from "../../code_mode/output.js";
import {
  runTauCodeMode,
  type TauCodeModeJsonValue,
  type TauCodeModePackage,
  type TauCodeModeRuntimeResult,
} from "../../code_mode/runtime.js";
import { readPage } from "../code_mode/package.js";
import type { ToolActivity } from "./activity.js";
import { buildBashPresentation } from "./bash.js";
import { type CodeProgram, readCodeModule } from "./code_modules.js";
import type { ToolExecutionBackend } from "./execution_backend.js";
import { writeOutputFile } from "./output_file.js";
import { buildToolRunPresentation } from "./presentation.js";
import type { ToolImplementationOutcome } from "./registry.js";
import { TOOL_NAME_CODE } from "./tool_names.js";

/** Everything one run of the code tool needs, in the foreground or as a background job. */
export type CodeProgramRun = {
  program: CodeProgram;
  packages: TauCodeModePackage[];
  input?: TauCodeModeJsonValue;
  /** Whether relative imports may read local files, which requires Bash permission. */
  readFiles: boolean;
};

export function runCodeProgram(
  backend: ToolExecutionBackend,
  { program, packages, input, readFiles }: CodeProgramRun,
  options: {
    signal: AbortSignal;
    timeoutMs: number | null;
    maxOutputTokens?: number;
    output?: CodeModeOutput;
    persistTruncatedOutput: boolean;
  },
): Promise<TauCodeModeRuntimeResult> {
  return runTauCodeMode({
    packages,
    pages: { examples: readPage("examples") },
    code: program.code,
    sources: readFiles
      ? {
          cwd: program.cwd,
          entryPath: program.entryPath,
          read: (path, signal) => readCodeModule(backend, path, signal),
        }
      : undefined,
    input,
    maxOutputTokens: options.maxOutputTokens,
    signal: options.signal,
    timeoutMs: options.timeoutMs,
    output: options.output,
    ...(options.persistTruncatedOutput
      ? {
          persistOutput: async (output) => {
            if (!output.contextTruncated) return undefined;
            const path = await writeOutputFile(backend, output.content);
            return path ? { path } : undefined;
          },
        }
      : {}),
  });
}

/** Turns a finished foreground run into the tool result and its card. */
export function presentCodeProgramResult(
  call: ToolCall,
  subject: string,
  timeoutMs: number,
  runtime: TauCodeModeRuntimeResult,
): ToolImplementationOutcome {
  const execution = runtime.execution;
  const terminationNote =
    runtime.status === "timed-out"
      ? `Program timed out after ${timeoutMs}ms.`
      : runtime.status === "cancelled"
        ? "Program was cancelled."
        : undefined;
  const outputPresentation = buildBashPresentation({
    toolName: TOOL_NAME_CODE,
    operation: TOOL_NAME_CODE,
    subject,
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
    toolCallId: call.id,
    toolName: TOOL_NAME_CODE,
    presentation,
    status: runtime.status === "succeeded" ? "success" : "error",
  };
  return {
    content: runtime.result.content,
    outcome:
      runtime.status === "cancelled" || runtime.status === "timed-out"
        ? "cancelled"
        : runtime.status,
    uiEvent,
  };
}

export function presentCodeProgramBlocked(
  call: ToolCall,
  subject: string,
  reason: string,
  outcome: ToolImplementationOutcome["outcome"],
): ToolImplementationOutcome {
  return {
    content: [{ type: "text", text: reason }],
    outcome,
    uiEvent: {
      type: "code_mode_blocked",
      toolCallId: call.id,
      toolName: TOOL_NAME_CODE,
      reason,
      presentation: buildToolRunPresentation({
        toolName: TOOL_NAME_CODE,
        operation: TOOL_NAME_CODE,
        subject,
        details: [{ text: reason }],
      }),
    },
  };
}
