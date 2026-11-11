import {
  BASH_DEFAULT_TIMEOUT_MS,
  buildBashPresentation,
  formatBashUserMessageText,
  getBashOutputPolicy,
  getBashTerminationNotice,
  prepareBashOutput,
} from "../tools/bash.js";
import type { ToolExecutionBackend } from "../tools/execution_backend.js";
import { TOOL_CARD_MAX_LINE_CHARS, type ToolRunPresentation } from "../tools/presentation.js";
import { TOOL_NAME_BASH } from "../tools/tool_names.js";

export type DirectBashExecutionResult = {
  exitCode: number | null;
  presentation: ToolRunPresentation;
};

export type DirectBashExecutionOptions = {
  command: string;
  backend: ToolExecutionBackend;
  signal?: AbortSignal;
  workingDirectory: string;
  /** Adds the output to the model's context. Without it, the command runs incognito. */
  recordOutput?: (text: string) => Promise<void>;
  now?: () => number;
};

export async function runDirectBashCommand(
  options: DirectBashExecutionOptions,
): Promise<DirectBashExecutionResult> {
  const now = options.now ?? Date.now;
  const startedAt = now();
  const {
    output,
    exitCode,
    truncated: captureTruncated,
    aborted,
    timedOut,
    closeSignal,
  } = await options.backend.runBash(options.command, {
    signal: options.signal,
    timeoutMs: BASH_DEFAULT_TIMEOUT_MS,
  });
  const durationMs = Math.max(0, now() - startedAt);
  const terminationNotice = getBashTerminationNotice({
    aborted,
    timedOut,
    closeSignal,
    timeoutMs: BASH_DEFAULT_TIMEOUT_MS,
  });
  const truncationInfo = await prepareBashOutput(
    output,
    captureTruncated,
    getBashOutputPolicy({ mode: "user" }),
    options.backend,
  );
  const userMessageText = formatBashUserMessageText({
    command: options.command,
    truncationInfo,
    exitCode: terminationNotice ? null : exitCode,
    terminationNotice,
  });
  const presentation = buildBashPresentation({
    toolName: TOOL_NAME_BASH,
    subject: options.command,
    truncationInfo,
    exitCode,
    durationMs,
    workingDirectory: options.workingDirectory,
    includeExitCode: !terminationNotice,
    terminationNotice,
    actionLabel: options.recordOutput ? "you ran" : "incognito",
    detailTruncation: {
      maxLines: 33,
      maxLineChars: TOOL_CARD_MAX_LINE_CHARS,
      strategy: "middle",
    },
  });
  await options.recordOutput?.(userMessageText);
  return { exitCode, presentation };
}
