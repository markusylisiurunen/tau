import type { ToolUiText } from "../tools/activity.js";
import {
  BASH_DEFAULT_TIMEOUT_MS,
  type BashTruncationInfo,
  buildBashUiText,
  formatBashUserMessageText,
  getBashOutputPolicy,
  prepareBashOutput,
} from "../tools/bash.js";
import type { ToolExecutionBackend } from "../tools/execution_backend.js";

export type DirectBashExecutionResult = {
  command: string;
  exitCode: number | null;
  truncationInfo: BashTruncationInfo;
  uiText: ToolUiText;
  durationMs: number;
  userHistoryEntryId?: string;
};

export type DirectBashExecutionOptions = {
  command: string;
  backend: ToolExecutionBackend;
  signal?: AbortSignal;
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
  const uiText = buildBashUiText({
    truncationInfo,
    exitCode,
    durationMs,
    previewLines: { head: 12, tail: 12 },
    fullText: userMessageText,
  });
  const userHistoryEntryId =
    options.addToContext && options.addUserText
      ? await options.addUserText(userMessageText)
      : undefined;

  return {
    command: options.command,
    exitCode,
    truncationInfo,
    uiText,
    durationMs,
    ...(userHistoryEntryId !== undefined ? { userHistoryEntryId } : {}),
  };
}
