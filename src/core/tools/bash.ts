import { randomUUID } from "node:crypto";
import type { Tool, ToolCall, ToolResultMessage } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import stripAnsi from "strip-ansi";
import { z } from "zod";
import type { RiskLevel } from "../types.js";
import { createToolError, createToolResult } from "../utils/messages.js";
import {
  BYTES_PER_TOKEN,
  bytesToTokens,
  formatTokenEstimate,
  tokensToBytes,
} from "../utils/token.js";
import {
  formatBytes,
  type TruncationResult,
  truncateMiddleForModel,
  truncateToBytesFromStart,
} from "../utils/truncate.js";
import type { ToolExecutionBackend } from "./execution_backend.js";
import type {
  ToolDefinition,
  ToolDispatchResult,
  ToolDispatchResultWithPhases,
  ToolUiEvent,
  ToolUiLine,
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

const BASH_MODEL_DEFAULT_MAX_TOTAL_LINES = 1024;
const BASH_MODEL_DEFAULT_MAX_TOTAL_TOKENS = 8000;
const BASH_MODEL_DEFAULT_MAX_LINE_TOKENS = 256;
const BASH_MODEL_DEFAULT_PREVIEW_HEAD_LINES = 4;
const BASH_MODEL_DEFAULT_PREVIEW_TAIL_LINES = 4;
const BASH_MODEL_DEFAULT_PREVIEW_MAX_LINE_CHARS = 512;

const BASH_STREAM_MIN_LINES = 16;
const BASH_STREAM_MIN_TOKENS = 256;

export type BashOutputMode = "model_default" | "model_extended" | "user";

export interface BashOutputPolicy {
  maxTotalTokens: number;
  maxTotalLines: number;
  maxLineTokens: number;
  maxStdoutTokens: number;
  maxStdoutLines: number;
  maxStderrTokens: number;
  maxStderrLines: number;
  previewHeadLines?: number;
  previewTailLines?: number;
  previewMaxLineChars?: number;
}

const BASH_MODEL_DEFAULT_POLICY: BashOutputPolicy = {
  maxTotalTokens: BASH_MODEL_DEFAULT_MAX_TOTAL_TOKENS,
  maxTotalLines: BASH_MODEL_DEFAULT_MAX_TOTAL_LINES,
  maxLineTokens: BASH_MODEL_DEFAULT_MAX_LINE_TOKENS,
  maxStdoutTokens: BASH_MODEL_DEFAULT_MAX_TOTAL_TOKENS,
  maxStdoutLines: BASH_MODEL_DEFAULT_MAX_TOTAL_LINES,
  maxStderrTokens: BASH_MODEL_DEFAULT_MAX_TOTAL_TOKENS,
  maxStderrLines: BASH_MODEL_DEFAULT_MAX_TOTAL_LINES,
  previewHeadLines: BASH_MODEL_DEFAULT_PREVIEW_HEAD_LINES,
  previewTailLines: BASH_MODEL_DEFAULT_PREVIEW_TAIL_LINES,
  previewMaxLineChars: BASH_MODEL_DEFAULT_PREVIEW_MAX_LINE_CHARS,
};

const BASH_MODEL_EXTENDED_POLICY: BashOutputPolicy = {
  maxTotalTokens: BASH_TOOL_MAX_STDOUT_TOKENS + BASH_TOOL_MAX_STDERR_TOKENS,
  maxTotalLines: BASH_TOOL_MAX_STDOUT_LINES + BASH_TOOL_MAX_STDERR_LINES,
  maxLineTokens: Number.POSITIVE_INFINITY,
  maxStdoutTokens: BASH_TOOL_MAX_STDOUT_TOKENS,
  maxStdoutLines: BASH_TOOL_MAX_STDOUT_LINES,
  maxStderrTokens: BASH_TOOL_MAX_STDERR_TOKENS,
  maxStderrLines: BASH_TOOL_MAX_STDERR_LINES,
};

const BASH_USER_POLICY: BashOutputPolicy = {
  maxTotalTokens: BASH_USER_MAX_STDOUT_TOKENS + BASH_USER_MAX_STDERR_TOKENS,
  maxTotalLines: BASH_USER_MAX_STDOUT_LINES + BASH_USER_MAX_STDERR_LINES,
  maxLineTokens: Number.POSITIVE_INFINITY,
  maxStdoutTokens: BASH_USER_MAX_STDOUT_TOKENS,
  maxStdoutLines: BASH_USER_MAX_STDOUT_LINES,
  maxStderrTokens: BASH_USER_MAX_STDERR_TOKENS,
  maxStderrLines: BASH_USER_MAX_STDERR_LINES,
};

export function getBashOutputPolicy(mode: BashOutputMode): BashOutputPolicy {
  switch (mode) {
    case "model_default":
      return BASH_MODEL_DEFAULT_POLICY;
    case "model_extended":
      return BASH_MODEL_EXTENDED_POLICY;
    case "user":
      return BASH_USER_POLICY;
  }
}

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

const BASH_WORKING_DIRECTORY_DESCRIPTION =
  "Working directory for the command. If omitted, uses the current working directory. Prefer this over `cd` in the command.";

const BASH_TIMEOUT_DESCRIPTION =
  "Timeout in milliseconds. If omitted, defaults to 60 seconds. Use a longer timeout for known slow operations like builds or large clones.";

const BASH_GRANT_CODE_DESCRIPTION =
  "Optional grant code for extended output when default mode gating is triggered.";

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
      workingDirectory: Type.Optional(
        Type.String({
          description: BASH_WORKING_DIRECTORY_DESCRIPTION,
        }),
      ),
      timeout: Type.Optional(
        Type.Number({
          description: BASH_TIMEOUT_DESCRIPTION,
        }),
      ),
      grantCode: Type.Optional(
        Type.String({
          description: BASH_GRANT_CODE_DESCRIPTION,
        }),
      ),
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
  gate?: {
    grantCode: string;
    preview: string;
  };
}

type OutputStats = {
  lines: number;
  bytes: number;
  tokens: number;
};

type LineCapResult = {
  output: string;
  truncated: boolean;
};

function getOutputStats(content: string): OutputStats {
  if (content.trim().length === 0) {
    return { lines: 0, bytes: 0, tokens: 0 };
  }
  const bytes = Buffer.byteLength(content, "utf-8");
  return {
    lines: content.split("\n").length,
    bytes,
    tokens: Math.max(1, bytesToTokens(bytes)),
  };
}

function applyLineTokenCap(content: string, maxLineTokens: number): LineCapResult {
  if (!Number.isFinite(maxLineTokens)) {
    return { output: content, truncated: false };
  }
  if (maxLineTokens <= 0) {
    return { output: "", truncated: content.length > 0 };
  }

  const maxLineBytes = tokensToBytes(maxLineTokens);
  const lines = content.split("\n");
  let truncated = false;
  const outLines = lines.map((line) => {
    if (Buffer.byteLength(line, "utf-8") <= maxLineBytes) return line;
    truncated = true;
    return truncateToBytesFromStart(line, maxLineBytes);
  });
  return { output: outLines.join("\n"), truncated };
}

function truncateStreamForModel(
  content: string,
  limits: { maxLines: number; maxTokens: number },
): TruncationResult {
  if (content.trim().length === 0) {
    return {
      content: "",
      truncated: false,
      truncatedBy: null,
      totalLines: 0,
      totalBytes: 0,
      outputLines: 0,
      outputBytes: 0,
      maxLines: limits.maxLines,
      maxTokens: limits.maxTokens,
    };
  }

  return truncateMiddleForModel(content, limits);
}

function buildCombinedOutput(
  stdout: string,
  stderr: string,
): {
  output: string;
  stdoutHasOutput: boolean;
  stderrHasOutput: boolean;
} {
  const stdoutHasOutput = stdout.trim().length > 0;
  const stderrHasOutput = stderr.trim().length > 0;

  const parts: string[] = [];
  if (stdoutHasOutput) {
    parts.push(stdout);
  }
  if (stderrHasOutput) {
    parts.push(`[stderr]\n${stderr}`);
  }
  return { output: parts.join("\n"), stdoutHasOutput, stderrHasOutput };
}

function allocateStreamBudget(args: {
  total: number;
  stdoutSize: number;
  stderrSize: number;
  maxStdout: number;
  maxStderr: number;
  minReserve: number;
}): { stdout: number; stderr: number } {
  const total = Math.max(0, args.total);
  const stdoutHasOutput = args.stdoutSize > 0;
  const stderrHasOutput = args.stderrSize > 0;

  if (!stdoutHasOutput && !stderrHasOutput) {
    return { stdout: 0, stderr: 0 };
  }
  if (stdoutHasOutput && !stderrHasOutput) {
    return { stdout: Math.min(total, args.maxStdout), stderr: 0 };
  }
  if (!stdoutHasOutput && stderrHasOutput) {
    return { stdout: 0, stderr: Math.min(total, args.maxStderr) };
  }

  const minStdout = Math.min(args.minReserve, args.maxStdout);
  const minStderr = Math.min(args.minReserve, args.maxStderr);

  if (total <= minStdout + minStderr) {
    const totalSize = args.stdoutSize + args.stderrSize;
    if (totalSize <= 0) {
      const half = Math.floor(total / 2);
      return {
        stdout: Math.min(half, args.maxStdout),
        stderr: Math.min(total - half, args.maxStderr),
      };
    }
    const stdoutShare = Math.min(args.maxStdout, Math.floor(total * (args.stdoutSize / totalSize)));
    const stderrShare = Math.min(args.maxStderr, Math.max(0, total - stdoutShare));
    return { stdout: stdoutShare, stderr: stderrShare };
  }

  const remaining = total - minStdout - minStderr;
  const totalSize = args.stdoutSize + args.stderrSize;
  let stdoutExtra = 0;
  let stderrExtra = 0;
  if (totalSize > 0 && remaining > 0) {
    stdoutExtra = Math.floor(remaining * (args.stdoutSize / totalSize));
    stderrExtra = remaining - stdoutExtra;
  }

  stdoutExtra = Math.min(stdoutExtra, Math.max(0, args.maxStdout - minStdout));
  stderrExtra = Math.min(stderrExtra, Math.max(0, args.maxStderr - minStderr));

  let stdoutBudget = minStdout + stdoutExtra;
  let stderrBudget = minStderr + stderrExtra;
  let leftover = total - (stdoutBudget + stderrBudget);
  if (leftover > 0) {
    const stdoutCapacity = Math.max(0, args.maxStdout - stdoutBudget);
    const stderrCapacity = Math.max(0, args.maxStderr - stderrBudget);
    if (args.stdoutSize >= args.stderrSize) {
      const addStdout = Math.min(leftover, stdoutCapacity);
      stdoutBudget += addStdout;
      leftover -= addStdout;
      if (leftover > 0) {
        const addStderr = Math.min(leftover, stderrCapacity);
        stderrBudget += addStderr;
      }
    } else {
      const addStderr = Math.min(leftover, stderrCapacity);
      stderrBudget += addStderr;
      leftover -= addStderr;
      if (leftover > 0) {
        const addStdout = Math.min(leftover, stdoutCapacity);
        stdoutBudget += addStdout;
      }
    }
  }

  return { stdout: stdoutBudget, stderr: stderrBudget };
}

function buildGrantPreview(output: string, policy: BashOutputPolicy): string {
  const previewLines = buildCompactOutputLines(
    output,
    policy.previewHeadLines ?? BASH_MODEL_DEFAULT_PREVIEW_HEAD_LINES,
    policy.previewTailLines ?? BASH_MODEL_DEFAULT_PREVIEW_TAIL_LINES,
    policy.previewMaxLineChars ?? BASH_MODEL_DEFAULT_PREVIEW_MAX_LINE_CHARS,
  );
  return previewLines.join("\n");
}

export function prepareBashOutput(
  stdout: string,
  stderr: string,
  captureTruncated: boolean,
  options: {
    mode: BashOutputMode;
    policy: BashOutputPolicy;
  },
): BashTruncationInfo {
  const { mode, policy } = options;
  const cleanStdout = stripAnsi(stdout);
  const cleanStderr = stripAnsi(stderr);

  const rawCombined = buildCombinedOutput(cleanStdout, cleanStderr);
  const stdoutStats = getOutputStats(cleanStdout);
  const stderrStats = getOutputStats(cleanStderr);

  const markerLines = rawCombined.stdoutHasOutput && rawCombined.stderrHasOutput ? 1 : 0;
  const markerBytes =
    rawCombined.stdoutHasOutput && rawCombined.stderrHasOutput
      ? Buffer.byteLength("[stderr]\n", "utf-8")
      : 0;
  const markerTokens = markerBytes === 0 ? 0 : Math.ceil(markerBytes / BYTES_PER_TOKEN);

  const totalLineBudget = Math.max(0, policy.maxTotalLines - markerLines);
  const totalTokenBudget = Math.max(0, policy.maxTotalTokens - markerTokens);

  const lineBudgets = allocateStreamBudget({
    total: totalLineBudget,
    stdoutSize: stdoutStats.lines,
    stderrSize: stderrStats.lines,
    maxStdout: policy.maxStdoutLines,
    maxStderr: policy.maxStderrLines,
    minReserve: BASH_STREAM_MIN_LINES,
  });

  const tokenBudgets = allocateStreamBudget({
    total: totalTokenBudget,
    stdoutSize: stdoutStats.tokens,
    stderrSize: stderrStats.tokens,
    maxStdout: policy.maxStdoutTokens,
    maxStderr: policy.maxStderrTokens,
    minReserve: BASH_STREAM_MIN_TOKENS,
  });

  const stdoutLineCap =
    mode === "model_default"
      ? applyLineTokenCap(cleanStdout, policy.maxLineTokens)
      : { output: cleanStdout, truncated: false };
  const stderrLineCap =
    mode === "model_default"
      ? applyLineTokenCap(cleanStderr, policy.maxLineTokens)
      : { output: cleanStderr, truncated: false };
  const lineTruncated = stdoutLineCap.truncated || stderrLineCap.truncated;

  const stdoutTrunc = truncateStreamForModel(stdoutLineCap.output, {
    maxLines: lineBudgets.stdout,
    maxTokens: tokenBudgets.stdout,
  });

  const stderrTrunc = truncateStreamForModel(stderrLineCap.output, {
    maxLines: lineBudgets.stderr,
    maxTokens: tokenBudgets.stderr,
  });

  const combined = buildCombinedOutput(stdoutTrunc.content, stderrTrunc.content);
  const rawOutput = rawCombined.output;
  const combinedOutput = combined.output;

  const truncated = stdoutTrunc.truncated || stderrTrunc.truncated || lineTruncated;
  const truncatedBy =
    stdoutTrunc.truncatedBy || stderrTrunc.truncatedBy || (lineTruncated ? "bytes" : null);

  const modelTruncation: TruncationResult = {
    content: combinedOutput,
    truncated,
    truncatedBy,
    totalLines: rawOutput === "" ? 0 : rawOutput.split("\n").length,
    totalBytes: Buffer.byteLength(rawOutput, "utf-8"),
    outputLines: combinedOutput === "" ? 0 : combinedOutput.split("\n").length,
    outputBytes: Buffer.byteLength(combinedOutput, "utf-8"),
    maxLines: policy.maxTotalLines,
    maxTokens: policy.maxTotalTokens,
  };

  let gate: BashTruncationInfo["gate"];
  if (mode === "model_default") {
    const totalTokens = bytesToTokens(modelTruncation.totalBytes);
    const exceedsTotals =
      modelTruncation.totalLines > policy.maxTotalLines || totalTokens > policy.maxTotalTokens;
    if (exceedsTotals || lineTruncated) {
      gate = {
        grantCode: randomUUID(),
        preview: buildGrantPreview(rawOutput, policy),
      };
    }
  }

  return {
    output: combinedOutput,
    rawOutput,
    model: modelTruncation,
    captureTruncated,
    ...(gate ? { gate } : {}),
  };
}

export function formatBashToolResultText(args: {
  truncationInfo: BashTruncationInfo;
  exitCode: number | null;
}): string {
  const { truncationInfo, exitCode } = args;
  const { model, captureTruncated, gate } = truncationInfo;

  if (gate) {
    const preview = gate.preview.trimEnd() || "(no output)";
    const grantNote = `\n\n[output gated: re-run this bash tool call with grantCode "${gate.grantCode}" to retrieve full output]`;
    const exitNote = exitCode !== null && exitCode !== 0 ? `\n(exit ${exitCode})` : "";
    return `${preview}${grantNote}${exitNote}`;
  }

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

function truncateLineToMax(line: string, maxLineLength: number): string {
  if (maxLineLength <= 0) return "";
  const chars = Array.from(line);
  if (chars.length <= maxLineLength) return line;
  if (maxLineLength === 1) return "…";
  return `${chars.slice(0, maxLineLength - 1).join("")}…`;
}

function buildCompactOutputLines(
  output: string,
  headCount: number = COMPACT_OUTPUT_HEAD_LINES,
  tailCount: number = COMPACT_OUTPUT_TAIL_LINES,
  maxLineChars: number = BASH_UI_MAX_LINE_LENGTH,
): string[] {
  const cleaned = output.replace(/\n+$/, "");
  if (cleaned.trim().length === 0) return [];
  const lines = cleaned.split("\n");
  const total = lines.length;
  if (total <= headCount + tailCount) {
    return lines.map((line) => truncateLineToMax(line, maxLineChars));
  }

  const head = lines.slice(0, headCount).map((line) => truncateLineToMax(line, maxLineChars));
  const tail = lines
    .slice(Math.max(total - tailCount, headCount))
    .map((line) => truncateLineToMax(line, maxLineChars));
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
  const previewLines: ToolUiLine[] = outputLinesPreview.map((line) => ({
    text: line,
  }));

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
  const summaryLine = `${exitSummary} · ${infoText}`;

  const fullLines: ToolUiLine[] = [];
  const pushSection = (text: string): void => {
    if (!text) return;
    if (fullLines.length > 0) {
      fullLines.push({ text: "" });
    }
    for (const line of text.split("\n")) {
      fullLines.push({ text: line });
    }
  };

  const rawOutput = truncationInfo.rawOutput.trimEnd();
  if (rawOutput) {
    pushSection(rawOutput);
  }

  if (model.truncated || captureTruncated) {
    const shown = formatSizeSummary(model.outputLines, model.outputBytes);
    const total = formatSizeSummary(model.totalLines, model.totalBytes);
    pushSection(`truncated for model: ${shown} of ${total}`);
  }

  if (exitCode !== null && exitCode !== 0) {
    pushSection(`(exit ${exitCode})`);
  }

  return {
    previewLines,
    statusLine: summaryLine,
    fullLines,
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
  workingDirectory: z.string().trim().optional().catch(undefined),
  timeout: z.number().positive().optional().catch(undefined),
  grantCode: z.string().trim().optional().catch(undefined),
});

function parseBashArgs(raw: unknown): {
  command: string;
  safetyLevel: BashSafetyLevel | undefined;
  workingDirectory: string | undefined;
  timeout: number | undefined;
  grantCode: string | undefined;
  commandForDisplay: string;
} {
  const parsed = bashArgsSchema.safeParse(raw);
  const command = parsed.success ? parsed.data.command : "";
  const safetyLevel = parsed.success
    ? (parsed.data.safetyLevel as BashSafetyLevel | undefined)
    : undefined;
  const workingDirectory = parsed.success ? parsed.data.workingDirectory : undefined;
  const timeout = parsed.success ? parsed.data.timeout : undefined;
  const grantCode = parsed.success ? parsed.data.grantCode : undefined;
  const commandForDisplay = command || "(missing command)";
  return {
    command,
    safetyLevel,
    workingDirectory,
    timeout,
    grantCode: grantCode?.trim() ? grantCode : undefined,
    commandForDisplay,
  };
}

export function createBashToolDefinition(backend: ToolExecutionBackend): ToolDefinition {
  return {
    schema: BASH_TOOL,
    async dispatch(
      toolCall: ToolCall,
      riskLevel: RiskLevel,
      signal?: AbortSignal,
    ): Promise<ToolDispatchResult | ToolDispatchResultWithPhases> {
      const { command, safetyLevel, workingDirectory, timeout, grantCode, commandForDisplay } =
        parseBashArgs(toolCall.arguments);
      const headerTarget = commandForDisplay.split(/\r?\n/)[0] ?? commandForDisplay;

      const blocked = (reason: string): ToolDispatchResult => {
        const toolResult = createToolError(toolCall, reason);
        const uiEvent: ToolUiEvent = {
          type: "bash_blocked",
          command: commandForDisplay,
          headerTarget,
          reason,
        };
        return { kind: "single", toolResult, uiEvent };
      };

      if (!command || !safetyLevel) {
        const msg = getMissingArgsMessage(command, safetyLevel);
        const toolResult = createToolError(toolCall, msg);
        const uiEvent: ToolUiEvent = {
          type: "bash_blocked",
          command: commandForDisplay,
          headerTarget,
          reason: msg,
        };
        return { kind: "single", toolResult, uiEvent };
      }

      if (riskLevel === "read-only" && safetyLevel === "write") {
        return blocked(
          "blocked due to risk level being set to 'read-only'. the declared safetyLevel 'write' exceeds the current risk level. ask the user to enable it with /risk:read-write or revise to a read-only command.",
        );
      }

      // All acceptance checks passed; return two-phase result
      return {
        kind: "phased",
        startedUiEvent: {
          type: "bash_started",
          toolCallId: toolCall.id,
          command,
          headerTarget,
        },
        run: (async () => {
          try {
            const startedAt = Date.now();
            const {
              stdout,
              stderr,
              exitCode,
              truncated: captureTruncated,
            } = await backend.runBash(command, {
              signal,
              timeoutMs: timeout ?? BASH_DEFAULT_TIMEOUT_MS,
              cwd: workingDirectory,
            });
            const durationMs = Math.max(0, Date.now() - startedAt);

            const outputMode: BashOutputMode = grantCode ? "model_extended" : "model_default";
            const truncationInfo = prepareBashOutput(stdout, stderr, captureTruncated, {
              mode: outputMode,
              policy: getBashOutputPolicy(outputMode),
            });
            const toolText = formatBashToolResultText({ truncationInfo, exitCode });
            const isError = exitCode === null || exitCode !== 0;
            const uiText = buildBashUiText({ truncationInfo, exitCode, durationMs });

            const toolResult: ToolResultMessage = createToolResult(toolCall, toolText, isError);
            const uiEvent: ToolUiEvent = {
              type: "bash_execution",
              toolCallId: toolCall.id,
              command,
              headerTarget,
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
              headerTarget,
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
