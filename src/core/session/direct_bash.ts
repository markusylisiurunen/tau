import {
  BASH_DEFAULT_TIMEOUT_MS,
  buildBashPresentation,
  formatBashUserMessageText,
  getBashOutputPolicy,
  prepareBashOutput,
} from "../tools/bash.js";
import type { ToolExecutionBackend } from "../tools/execution_backend.js";
import type { ToolRunPresentation } from "../tools/presentation.js";
import { TOOL_NAME_BASH } from "../tools/tool_names.js";

export type DirectBashExecutionResult = {
  command: string;
  exitCode: number | null;
  presentation: ToolRunPresentation;
  userHistoryEntryId?: string;
};

export type DirectBashExecutionOptions = {
  command: string;
  backend: ToolExecutionBackend;
  signal?: AbortSignal;
  workingDirectory: string;
  actionLabel: string;
  addToContext: boolean;
  addUserText?: (text: string) => string | Promise<string>;
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
  } = await options.backend.runBash(options.command, {
    signal: options.signal,
    timeoutMs: BASH_DEFAULT_TIMEOUT_MS,
  });
  const durationMs = Math.max(0, now() - startedAt);
  const truncationInfo = await prepareBashOutput(
    output,
    captureTruncated,
    getBashOutputPolicy({ mode: "user" }),
    options.backend,
  );
  const userMessageText = formatBashUserMessageText({
    command: options.command,
    truncationInfo,
    exitCode,
  });
  const presentation = buildBashPresentation({
    toolName: TOOL_NAME_BASH,
    subject: options.command,
    truncationInfo,
    exitCode,
    durationMs,
    workingDirectory: options.workingDirectory,
    actionLabel: options.actionLabel,
  });
  const userHistoryEntryId =
    options.addToContext && options.addUserText
      ? await options.addUserText(userMessageText)
      : undefined;

  return {
    command: options.command,
    exitCode,
    presentation,
    ...(userHistoryEntryId !== undefined ? { userHistoryEntryId } : {}),
  };
}
