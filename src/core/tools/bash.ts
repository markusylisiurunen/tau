import type { Tool, ToolCall, ToolResultMessage } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import stripAnsi from "strip-ansi";
import { z } from "zod";
import type { RiskLevel } from "../types.js";
import { createToolError, createToolResult } from "../utils/messages.js";
import { bytesToTokens, formatTokenEstimate } from "../utils/token.js";
import { buildHeadTailPreviewLines } from "../utils/tool_preview.js";
import {
  formatBytes,
  TRUNCATION_MARKER,
  type TruncationResult,
  truncateForTokens,
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
import { TOOL_NAME_BASH } from "./tool_names.js";

const BASH_MODEL_DEFAULT_MAX_TOKENS = 8192;
const BASH_MODEL_DEFAULT_PREVIEW_TOKENS = 2048;
const BASH_MODEL_MAX_AUTONOMOUS_TOKENS = 16384;
const BASH_MAX_OUTPUT_TOKENS = 65536;
const BASH_USER_MAX_TOKENS = BASH_MAX_OUTPUT_TOKENS;

export interface BashOutputPolicy {
  maxTokens: number;
  gateOnExcess?: boolean;
  previewTokens?: number;
}

const BASH_MODEL_DEFAULT_POLICY: BashOutputPolicy = {
  maxTokens: BASH_MODEL_DEFAULT_MAX_TOKENS,
  gateOnExcess: true,
  previewTokens: BASH_MODEL_DEFAULT_PREVIEW_TOKENS,
};

const BASH_USER_POLICY: BashOutputPolicy = {
  maxTokens: BASH_USER_MAX_TOKENS,
};

function clampOutputTokens(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined;
  return Math.min(Math.max(value, BASH_MODEL_DEFAULT_MAX_TOKENS), BASH_MAX_OUTPUT_TOKENS);
}

export function getBashOutputPolicy(args: {
  mode: "model" | "user";
  maxOutputTokens?: number;
  hasMaxOutputTokens?: boolean;
}): BashOutputPolicy {
  if (args.mode === "user") {
    return BASH_USER_POLICY;
  }

  if (args.hasMaxOutputTokens) {
    const maxTokens = clampOutputTokens(args.maxOutputTokens) ?? BASH_MODEL_DEFAULT_MAX_TOKENS;
    return { maxTokens };
  }

  return BASH_MODEL_DEFAULT_POLICY;
}

export const BASH_DEFAULT_TIMEOUT_MS = 60_000;

const BASH_DESCRIPTION = [
  "Execute a shell command in the current working directory and return its output.",
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

const BASH_MAX_OUTPUT_TOKENS_DESCRIPTION = [
  "Optional maximum number of output tokens to return to the model.",
  `Defaults to ${BASH_MODEL_DEFAULT_MAX_TOKENS} tokens if unset. If more output is needed, set a value between ${BASH_MODEL_DEFAULT_MAX_TOKENS} and ${BASH_MODEL_MAX_AUTONOMOUS_TOKENS}.`,
  `Only exceed ${BASH_MODEL_MAX_AUTONOMOUS_TOKENS} when the user explicitly requests more output, up to ${BASH_MAX_OUTPUT_TOKENS}.`,
  `User requests are checked by the system, so do not exceed ${BASH_MODEL_MAX_AUTONOMOUS_TOKENS} autonomously.`,
  `If unset and output exceeds the default ${BASH_MODEL_DEFAULT_MAX_TOKENS} tokens, the tool returns a ${BASH_MODEL_DEFAULT_PREVIEW_TOKENS}-token preview with a gating notice.`,
].join(" ");

export const BASH_TOOL: Tool = {
  name: TOOL_NAME_BASH,
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
      maxOutputTokens: Type.Optional(
        Type.Integer({
          description: BASH_MAX_OUTPUT_TOKENS_DESCRIPTION,
          minimum: 1,
          maximum: BASH_MAX_OUTPUT_TOKENS,
        }),
      ),
    },
    { additionalProperties: false },
  ),
};

export type BashSafetyLevel = "read" | "write";

export interface BashTruncationInfo {
  output: string;
  model: TruncationResult;
  captureTruncated: boolean;
  gated?: boolean;
  fullOutputPath?: string;
}

const BASH_TEMP_FILE_TEMPLATE = "/tmp/tau-bash-output.XXXXXX";
const BASH_TEMP_FILE_TIMEOUT_MS = 2_000;

async function createBashTempFilePath(backend: ToolExecutionBackend): Promise<string | undefined> {
  try {
    const result = await backend.runBash(`mktemp ${BASH_TEMP_FILE_TEMPLATE}`, {
      timeoutMs: BASH_TEMP_FILE_TIMEOUT_MS,
    });
    if (result.exitCode !== 0) return undefined;
    const path = result.output.trim().split(/\r?\n/)[0]?.trim();
    return path || undefined;
  } catch {
    return undefined;
  }
}

async function writeBashTempFile(
  backend: ToolExecutionBackend,
  content: string,
): Promise<string | undefined> {
  if (!content) return undefined;
  const tempPath = await createBashTempFilePath(backend);
  if (!tempPath) return undefined;
  try {
    const result = await backend.writeFile(tempPath, content);
    return result.path;
  } catch {
    return undefined;
  }
}

function formatBashOutputFileHint(args: { path?: string }): string {
  if (!args.path) return "";
  return ` full output saved to ${args.path}. to see more output, either read the file or re-run with a higher maxOutputTokens. if reading the file, be mindful of its size.`;
}

export async function prepareBashOutput(
  output: string,
  captureTruncated: boolean,
  policy: BashOutputPolicy,
  backend: ToolExecutionBackend,
): Promise<BashTruncationInfo> {
  const cleanOutput = stripAnsi(output);
  const maxTruncation = truncateForTokens(cleanOutput, {
    maxTokens: policy.maxTokens,
    strategy: "middle",
  });
  const fullOutputPath = maxTruncation.truncated
    ? await writeBashTempFile(backend, cleanOutput)
    : undefined;

  if (policy.gateOnExcess && maxTruncation.truncated) {
    const previewTokens = policy.previewTokens ?? BASH_MODEL_DEFAULT_PREVIEW_TOKENS;
    const previewTruncation = truncateForTokens(cleanOutput, {
      maxTokens: previewTokens,
      strategy: "middle",
    });
    return {
      output: previewTruncation.content,
      model: previewTruncation,
      captureTruncated,
      gated: true,
      fullOutputPath,
    };
  }

  return {
    output: maxTruncation.content,
    model: maxTruncation,
    captureTruncated,
    fullOutputPath,
  };
}

export function formatBashToolResultText(args: {
  truncationInfo: BashTruncationInfo;
  exitCode: number | null;
}): string {
  const { truncationInfo, exitCode } = args;
  const { model, captureTruncated, gated, fullOutputPath } = truncationInfo;

  if (gated) {
    const preview = model.content;
    const totalTokenEstimate = bytesToTokens(model.totalBytes);
    const gateNote = `\n\n[output gated: this command already ran and any side effects have persisted. full output estimate: ~${totalTokenEstimate} tokens.${formatBashOutputFileHint({ path: fullOutputPath })} maxOutputTokens can be set to ${BASH_MODEL_DEFAULT_MAX_TOKENS}-${BASH_MODEL_MAX_AUTONOMOUS_TOKENS}; up to ${BASH_MAX_OUTPUT_TOKENS} only when the user explicitly requests it. user requests are checked by the system, so do not exceed ${BASH_MODEL_MAX_AUTONOMOUS_TOKENS} autonomously.]`;
    const exitNote = exitCode !== null && exitCode !== 0 ? `\n(exit ${exitCode})` : "";
    return `${preview}${gateNote}${exitNote}`;
  }

  const outputForContext = model.content;
  const truncNote =
    model.truncated || captureTruncated
      ? `\n\n[output truncated for context: ${model.outputLines} lines / ${formatBytes(model.outputBytes)} shown of ${model.totalLines} lines / ${formatBytes(model.totalBytes)} (full output estimate: ~${bytesToTokens(model.totalBytes)} tokens).${formatBashOutputFileHint({ path: fullOutputPath })}]`
      : "";
  const exitNote = exitCode !== null && exitCode !== 0 ? `\n(exit ${exitCode})` : "";
  return `${outputForContext}${truncNote}${exitNote}`;
}

export function formatBashUserMessageText(args: {
  command: string;
  truncationInfo: BashTruncationInfo;
}): string {
  const { command, truncationInfo } = args;
  const { model, captureTruncated, fullOutputPath } = truncationInfo;

  const outputForContext = model.content.trimEnd() || "(no output)";
  const truncNote =
    model.truncated || captureTruncated
      ? `\n\n[output truncated for context: ${model.outputLines} lines / ${formatBytes(model.outputBytes)} shown of ${model.totalLines} lines / ${formatBytes(model.totalBytes)} (full output estimate: ~${bytesToTokens(model.totalBytes)} tokens).${formatBashOutputFileHint({ path: fullOutputPath })}]`
      : "";
  const bashContextText = `$ ${command}\n${outputForContext}${truncNote}`;
  return `Bash command output:\n${bashContextText}`;
}

const COMPACT_OUTPUT_HEAD_LINES = 3;
const COMPACT_OUTPUT_TAIL_LINES = 3;

function formatDurationMs(durationMs: number | null | undefined): string {
  if (durationMs === null || durationMs === undefined || !Number.isFinite(durationMs)) {
    return "?ms";
  }
  const ms = Math.max(0, Math.round(durationMs));
  if (ms < 1000) return `${ms}ms`;
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms / 1000)}s`;
}

export function buildBashUiText(args: {
  truncationInfo: BashTruncationInfo;
  exitCode: number | null;
  durationMs?: number;
  previewLines?: { head?: number; tail?: number };
  fullText?: string;
}): ToolUiText {
  const { truncationInfo, exitCode, durationMs } = args;
  const { model, captureTruncated } = truncationInfo;

  const previewSource = truncationInfo.output;
  const outputLinesPreview = buildHeadTailPreviewLines(previewSource, {
    headLines: args.previewLines?.head ?? COMPACT_OUTPUT_HEAD_LINES,
    tailLines: args.previewLines?.tail ?? COMPACT_OUTPUT_TAIL_LINES,
  });
  const previewLines: ToolUiLine[] = outputLinesPreview.map((line) => ({
    text: line,
  }));

  const outputLines = model.outputLines;
  const outputBytes = model.outputBytes;
  const hasOutput = outputBytes > 0;

  const exitSummary = exitCode === null ? "exit ?" : `exit ${exitCode}`;
  const durationLabel = formatDurationMs(durationMs);
  const lineLabel = hasOutput ? `${outputLines} line${outputLines === 1 ? "" : "s"}` : "no output";
  const bytesLabel = hasOutput ? formatBytes(outputBytes) : undefined;
  const tokenLabel = hasOutput ? formatTokenEstimate(outputBytes) : undefined;
  const summaryParts: string[] = [];
  if (model.truncated || captureTruncated) {
    summaryParts.push(TRUNCATION_MARKER);
  }
  summaryParts.push(exitSummary, durationLabel, lineLabel);
  if (tokenLabel && bytesLabel) {
    summaryParts.push(tokenLabel, bytesLabel);
  }
  const summaryLine = summaryParts.join(" · ");

  const fullText = args.fullText?.trimEnd() ?? "";
  const fullLines: ToolUiLine[] = fullText ? fullText.split("\n").map((text) => ({ text })) : [];

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
  maxOutputTokens: z.number().int().positive().optional().catch(undefined),
});

function parseBashArgs(raw: unknown): {
  command: string;
  safetyLevel: BashSafetyLevel | undefined;
  workingDirectory: string | undefined;
  timeout: number | undefined;
  maxOutputTokens: number | undefined;
  hasMaxOutputTokens: boolean;
  commandForDisplay: string;
} {
  const parsed = bashArgsSchema.safeParse(raw);
  const command = parsed.success ? parsed.data.command : "";
  const safetyLevel = parsed.success
    ? (parsed.data.safetyLevel as BashSafetyLevel | undefined)
    : undefined;
  const workingDirectory = parsed.success ? parsed.data.workingDirectory : undefined;
  const timeout = parsed.success ? parsed.data.timeout : undefined;
  const maxOutputTokens = parsed.success ? parsed.data.maxOutputTokens : undefined;
  const hasMaxOutputTokens = typeof raw === "object" && raw !== null && "maxOutputTokens" in raw;
  const commandForDisplay = command || "(missing command)";
  return {
    command,
    safetyLevel,
    workingDirectory,
    timeout,
    maxOutputTokens: clampOutputTokens(maxOutputTokens),
    hasMaxOutputTokens,
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
      const {
        command,
        safetyLevel,
        workingDirectory,
        timeout,
        maxOutputTokens,
        hasMaxOutputTokens,
        commandForDisplay,
      } = parseBashArgs(toolCall.arguments);
      const headerTarget = commandForDisplay.split(/\r?\n/)[0] ?? commandForDisplay;

      const blocked = (reason: string): ToolDispatchResult => {
        const toolResult = createToolError(toolCall, reason);
        const uiEvent: ToolUiEvent = {
          type: "bash_blocked",
          toolCallId: toolCall.id,
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
          toolCallId: toolCall.id,
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
              output,
              exitCode,
              truncated: captureTruncated,
            } = await backend.runBash(command, {
              signal,
              timeoutMs: timeout ?? BASH_DEFAULT_TIMEOUT_MS,
              cwd: workingDirectory,
            });
            const durationMs = Math.max(0, Date.now() - startedAt);

            const outputPolicy = getBashOutputPolicy({
              mode: "model",
              maxOutputTokens,
              hasMaxOutputTokens,
            });
            const truncationInfo = await prepareBashOutput(
              output,
              captureTruncated,
              outputPolicy,
              backend,
            );
            const toolText = formatBashToolResultText({ truncationInfo, exitCode });
            const isError = exitCode === null || exitCode !== 0;
            const uiText = buildBashUiText({
              truncationInfo,
              exitCode,
              durationMs,
              fullText: toolText,
            });

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
