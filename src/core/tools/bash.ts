import type { Tool, ToolCall, ToolResultMessage } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import stripAnsi from "strip-ansi";
import { z } from "zod";
import type { RiskLevel } from "../types.js";
import { createToolError, createToolResult } from "../utils/messages.js";
import { formatTokenEstimate } from "../utils/token.js";
import { formatBytes, type TruncationResult, truncateMiddleForModel } from "../utils/truncate.js";
import type { ToolExecutionBackend } from "./execution_backend.js";
import type {
  ToolDefinition,
  ToolDispatchResult,
  ToolDispatchResultWithPhases,
  ToolUiEvent,
  ToolUiText,
} from "./registry.js";

export const BASH_TOOL_MAX_STDOUT_LINES = 4096;
export const BASH_TOOL_MAX_STDOUT_TOKENS = 25000;
export const BASH_TOOL_MAX_STDERR_LINES = 4096;
export const BASH_TOOL_MAX_STDERR_TOKENS = 25000;

export const BASH_USER_MAX_STDOUT_LINES = 16384;
export const BASH_USER_MAX_STDOUT_TOKENS = 100000;
export const BASH_USER_MAX_STDERR_LINES = 4096;
export const BASH_USER_MAX_STDERR_TOKENS = 25000;

export const BASH_DEFAULT_TIMEOUT_MS = 60_000;

const BASH_DESCRIPTION = [
  "Execute a shell command in the current working directory and return stdout/stderr.",
  "Interactive commands are not supported (no TTY/stdin); commands that prompt or open editors will hang or fail.",
  "CRITICAL: Always evaluate and provide an accurate safetyLevel assessment.",
].join(" ");

const BASH_COMMAND_DESCRIPTION = "The shell command to execute.";

const BASH_SAFETY_LEVEL_DESCRIPTION = [
  "Safety classification: 'read' (query-only, no side effects) or 'write' (modifies or has the potential to modify system state).",
  "Use 'read' for: queries (ls, rg, cat, fd, find, ps, df, etc), information gathering (curl for APIs, git log, etc), analysis (wc, sort, sha256sum, etc).",
  "Use 'write' for: filesystem changes (cp, mv, rm, mkdir, touch, echo >, etc), file modifications (sed -i, tee, chmod, chown, etc), process management (kill, pkill, etc), package management (apt, npm, etc), network changes (firewall, DNS, interfaces, etc), or any command that creates/deletes/modifies resources.",
  "When in doubt, default to 'write' to be conservative. The system will enforce appropriate access controls based on your declared safetyLevel.",
  "Always respect and strictly adhere to user-defined risk tolerance levels; never exceed the configured risk level under any circumstances.",
].join(" ");

export const BASH_TOOL: Tool = {
  name: "bash",
  description: BASH_DESCRIPTION,
  parameters: Type.Object(
    {
      command: Type.String({
        description: BASH_COMMAND_DESCRIPTION,
      }),
      safetyLevel: Type.String({
        description: BASH_SAFETY_LEVEL_DESCRIPTION,
        enum: ["read", "write"],
      }),
    },
    { additionalProperties: false },
  ),
};

export type BashSafetyLevel = "read" | "write";

export interface BashTruncationInfo {
  output: string;
  rawOutput: string;
  model: TruncationResult;
  captureTruncated: boolean;
}

export function prepareBashOutput(
  stdout: string,
  stderr: string,
  captureTruncated: boolean,
  limits: {
    stdout: { maxLines: number; maxTokens: number };
    stderr: { maxLines: number; maxTokens: number };
  },
): BashTruncationInfo {
  const cleanStdout = stripAnsi(stdout);
  const cleanStderr = stripAnsi(stderr);

  const stdoutTrunc = truncateMiddleForModel(cleanStdout, {
    maxLines: limits.stdout.maxLines,
    maxTokens: limits.stdout.maxTokens,
  });

  const stderrTrunc = truncateMiddleForModel(cleanStderr, {
    maxLines: limits.stderr.maxLines,
    maxTokens: limits.stderr.maxTokens,
  });

  const stdoutHasOutput = stdoutTrunc.content.trim().length > 0;
  const stderrHasOutput = stderrTrunc.content.trim().length > 0;

  const combinedParts: string[] = [];
  if (stdoutHasOutput) {
    combinedParts.push(stdoutTrunc.content);
  }
  if (stderrHasOutput) {
    combinedParts.push(`[stderr]\n${stderrTrunc.content}`);
  }
  const combined = combinedParts.join("\n");

  const combinedTotalParts: string[] = [];
  const stdoutRawHasOutput = cleanStdout.trim().length > 0;
  const stderrRawHasOutput = cleanStderr.trim().length > 0;
  if (stdoutRawHasOutput) {
    combinedTotalParts.push(cleanStdout);
  }
  if (stderrRawHasOutput) {
    combinedTotalParts.push(`[stderr]\n${cleanStderr}`);
  }
  const combinedTotal = combinedTotalParts.join("\n");

  const modelTruncation: TruncationResult = {
    content: combined,
    truncated: stdoutTrunc.truncated || stderrTrunc.truncated,
    truncatedBy: (stdoutTrunc.truncatedBy || stderrTrunc.truncatedBy) as "lines" | "bytes" | null,
    totalLines: combinedTotal === "" ? 0 : combinedTotal.split("\n").length,
    totalBytes: Buffer.byteLength(combinedTotal, "utf-8"),
    outputLines: combined === "" ? 0 : combined.split("\n").length,
    outputBytes: Buffer.byteLength(combined, "utf-8"),
    maxLines: limits.stdout.maxLines + limits.stderr.maxLines,
    maxTokens: limits.stdout.maxTokens + limits.stderr.maxTokens,
  };

  return {
    output: combined,
    rawOutput: combinedTotal,
    model: modelTruncation,
    captureTruncated,
  };
}

export function formatBashToolResultText(args: {
  truncationInfo: BashTruncationInfo;
  exitCode: number | null;
}): string {
  const { truncationInfo, exitCode } = args;
  const { model, captureTruncated } = truncationInfo;

  const outputForContext = model.content.trimEnd() || "(no output)";
  const truncNote =
    model.truncated || captureTruncated
      ? `\n\n[output truncated for context: ${model.outputLines} lines / ${model.outputBytes} bytes shown of ${model.totalLines} lines / ${model.totalBytes} bytes]`
      : "";
  const exitNote = exitCode !== null && exitCode !== 0 ? `\n(exit ${exitCode})` : "";
  return `${outputForContext}${truncNote}${exitNote}`;
}

export function formatBashUserMessageText(args: {
  command: string;
  truncationInfo: BashTruncationInfo;
}): string {
  const { command, truncationInfo } = args;
  const { model, captureTruncated } = truncationInfo;

  const outputForContext = model.content.trimEnd() || "(no output)";
  const truncNote =
    model.truncated || captureTruncated
      ? `\n\n[output truncated for context: ${model.outputLines} lines / ${model.outputBytes} bytes shown of ${model.totalLines} lines / ${model.totalBytes} bytes]`
      : "";
  const bashContextText = `$ ${command}\n${outputForContext}${truncNote}`;
  return `Bash command output:\n${bashContextText}`;
}

const COMPACT_OUTPUT_HEAD_LINES = 3;
const COMPACT_OUTPUT_TAIL_LINES = 3;
const BASH_UI_MAX_LINE_LENGTH: number = 256;

function truncateLineToMax(line: string): string {
  if (BASH_UI_MAX_LINE_LENGTH <= 0) return "";
  const chars = Array.from(line);
  if (chars.length <= BASH_UI_MAX_LINE_LENGTH) return line;
  if (BASH_UI_MAX_LINE_LENGTH === 1) return "…";
  return `${chars.slice(0, BASH_UI_MAX_LINE_LENGTH - 1).join("")}…`;
}

function buildCompactOutputLines(
  output: string,
  headCount: number = COMPACT_OUTPUT_HEAD_LINES,
  tailCount: number = COMPACT_OUTPUT_TAIL_LINES,
): string[] {
  const cleaned = output.replace(/\n+$/, "");
  if (cleaned.trim().length === 0) return [];
  const lines = cleaned.split("\n");
  const total = lines.length;
  if (total <= headCount + tailCount) return lines.map(truncateLineToMax);

  const head = lines.slice(0, headCount).map(truncateLineToMax);
  const tail = lines.slice(Math.max(total - tailCount, headCount)).map(truncateLineToMax);
  const remaining = Math.max(0, total - head.length - tail.length);
  const label = remaining === 1 ? "line" : "lines";
  return [...head, `…${remaining} more ${label}…`, ...tail];
}

function formatDurationMs(durationMs: number | null | undefined): string {
  if (durationMs === null || durationMs === undefined || !Number.isFinite(durationMs)) {
    return "?ms";
  }
  const ms = Math.max(0, Math.round(durationMs));
  if (ms < 1000) return `${ms}ms`;
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms / 1000)}s`;
}

function formatSizeSummary(lines: number, bytes: number): string {
  return `${lines} lines (${formatTokenEstimate(bytes)} · ${formatBytes(bytes)})`;
}

export function buildBashUiText(args: {
  truncationInfo: BashTruncationInfo;
  exitCode: number | null;
  durationMs?: number;
  previewLines?: { head?: number; tail?: number };
}): ToolUiText {
  const { truncationInfo, exitCode, durationMs } = args;
  const { model, captureTruncated } = truncationInfo;

  const previewSource = truncationInfo.output;
  const outputLinesPreview = buildCompactOutputLines(
    previewSource,
    args.previewLines?.head ?? COMPACT_OUTPUT_HEAD_LINES,
    args.previewLines?.tail ?? COMPACT_OUTPUT_TAIL_LINES,
  );
  const outputBlock =
    outputLinesPreview.length > 0
      ? outputLinesPreview.map((line) => `    ${line}`).join("\n")
      : undefined;

  const hasOutput = model.totalBytes > 0;
  const showTotals = model.truncated || captureTruncated;
  const outputLines = showTotals ? model.totalLines : model.outputLines;
  const outputBytes = showTotals ? model.totalBytes : model.outputBytes;

  const exitSummary = exitCode === null ? "exit ?" : `exit ${exitCode}`;
  const durationLabel = formatDurationMs(durationMs);
  const lineLabel = hasOutput ? `${outputLines} line${outputLines === 1 ? "" : "s"}` : "no output";
  const bytesLabel = hasOutput ? formatBytes(outputBytes).toLowerCase() : undefined;
  const tokenLabel = hasOutput ? formatTokenEstimate(outputBytes) : "";
  const infoParts = bytesLabel
    ? [durationLabel, lineLabel, tokenLabel, bytesLabel]
    : [durationLabel, lineLabel];
  const infoText = infoParts.join(" · ");
  const details = `(${exitSummary} · ${infoText})`;

  const summaryLine = `    ${details}`;
  const previewText = [outputBlock, summaryLine].filter(Boolean).join("\n");

  const sections: string[] = [];
  const rawOutput = truncationInfo.rawOutput.trimEnd();
  if (rawOutput) {
    sections.push(rawOutput);
  }

  if (model.truncated || captureTruncated) {
    const shown = formatSizeSummary(model.outputLines, model.outputBytes);
    const total = formatSizeSummary(model.totalLines, model.totalBytes);
    sections.push(`truncated for model: ${shown} of ${total}`);
  }

  if (exitCode !== null && exitCode !== 0) {
    sections.push(`(exit ${exitCode})`);
  }

  return {
    previewText,
    fullText: sections.join("\n\n"),
  };
}

function getMissingArgsMessage(command: string, safetyLevel: BashSafetyLevel | undefined): string {
  if (!command && !safetyLevel) {
    return "bash tool call missing valid 'command' and 'safetyLevel' fields.";
  }
  if (!command) {
    return "bash tool call missing a valid 'command' string.";
  }
  return "bash tool call missing a valid 'safetyLevel' value ('read' or 'write').";
}

const bashArgsSchema = z.object({
  command: z.string().trim().catch(""),
  safetyLevel: z.enum(["read", "write"]).optional().catch(undefined),
});

function parseBashArgs(raw: unknown): {
  command: string;
  safetyLevel: BashSafetyLevel | undefined;
  commandForDisplay: string;
} {
  const parsed = bashArgsSchema.safeParse(raw);
  const command = parsed.success ? parsed.data.command : "";
  const safetyLevel = parsed.success
    ? (parsed.data.safetyLevel as BashSafetyLevel | undefined)
    : undefined;
  const commandForDisplay = command || "(missing command)";
  return { command, safetyLevel, commandForDisplay };
}

export function createBashToolDefinition(backend: ToolExecutionBackend): ToolDefinition {
  return {
    schema: BASH_TOOL,
    async dispatch(
      toolCall: ToolCall,
      riskLevel: RiskLevel,
      signal?: AbortSignal,
    ): Promise<ToolDispatchResult | ToolDispatchResultWithPhases> {
      const { command, safetyLevel, commandForDisplay } = parseBashArgs(toolCall.arguments);

      const blocked = (reason: string): ToolDispatchResult => {
        const toolResult = createToolError(toolCall, reason);
        const uiEvent: ToolUiEvent = { type: "bash_blocked", command: commandForDisplay, reason };
        return { kind: "single", toolResult, uiEvent };
      };

      if (riskLevel === "restricted") {
        return blocked(
          "Blocked due to risk level being set to 'restricted'. Ask the user to enable it with /risk:read-only or /risk:read-write.",
        );
      }

      if (!command || !safetyLevel) {
        const msg = getMissingArgsMessage(command, safetyLevel);
        const toolResult = createToolError(toolCall, msg);
        const uiEvent: ToolUiEvent = {
          type: "bash_blocked",
          command: commandForDisplay,
          reason: msg,
        };
        return { kind: "single", toolResult, uiEvent };
      }

      if (riskLevel === "read-only" && safetyLevel === "write") {
        return blocked(
          "Blocked due to risk level being set to 'read-only'. The declared safetyLevel 'write' exceeds the current risk level. Ask the user to enable it with /risk:read-write or revise to a read-only command.",
        );
      }

      // All acceptance checks passed; return two-phase result
      return {
        kind: "phased",
        startedUiEvent: {
          type: "bash_started",
          toolCallId: toolCall.id,
          command,
        },
        run: (async () => {
          try {
            const startedAt = Date.now();
            const {
              stdout,
              stderr,
              exitCode,
              truncated: captureTruncated,
            } = await backend.runBash(command, { signal, timeoutMs: BASH_DEFAULT_TIMEOUT_MS });
            const durationMs = Math.max(0, Date.now() - startedAt);

            const truncationInfo = prepareBashOutput(stdout, stderr, captureTruncated, {
              stdout: {
                maxLines: BASH_TOOL_MAX_STDOUT_LINES,
                maxTokens: BASH_TOOL_MAX_STDOUT_TOKENS,
              },
              stderr: {
                maxLines: BASH_TOOL_MAX_STDERR_LINES,
                maxTokens: BASH_TOOL_MAX_STDERR_TOKENS,
              },
            });
            const toolText = formatBashToolResultText({ truncationInfo, exitCode });
            const isError = exitCode === null || exitCode !== 0;
            const uiText = buildBashUiText({ truncationInfo, exitCode, durationMs });

            const toolResult: ToolResultMessage = createToolResult(toolCall, toolText, isError);
            const uiEvent: ToolUiEvent = {
              type: "bash_execution",
              toolCallId: toolCall.id,
              command,
              exitCode,
              truncationInfo,
              uiText,
              durationMs,
            };
            return { kind: "single", toolResult, uiEvent };
          } catch (e) {
            const msg = `bash tool execution failed: ${e instanceof Error ? e.message : String(e)}`;
            const toolResult = createToolError(toolCall, msg);
            const uiEvent: ToolUiEvent = {
              type: "bash_blocked",
              command: commandForDisplay,
              reason: msg,
              toolCallId: toolCall.id,
            };
            return { kind: "single", toolResult, uiEvent };
          }
        })(),
      };
    },
  };
}
