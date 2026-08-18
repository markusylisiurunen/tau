import { resolve } from "node:path";
import type { Tool, ToolCall } from "@earendil-works/pi-ai";
import stripAnsi from "strip-ansi";
import { Type } from "typebox";
import { z } from "zod";
import { formatCwd } from "../utils/format.js";
import { bytesToTokens, formatTokenEstimate } from "../utils/token.js";
import {
  formatBytes,
  TRUNCATION_MARKER,
  type TruncationResult,
  truncateForTokens,
} from "../utils/truncate.js";
import { formatZodError } from "../utils/zod.js";
import type { ToolActivity } from "./activity.js";
import type { ToolExecutionBackend } from "./execution_backend.js";
import {
  buildToolRunPresentation,
  formatToolDurationMs,
  type ToolCardDetailTruncation,
  type ToolCardLine,
  type ToolRunPresentation,
} from "./presentation.js";
import {
  type AgentTool,
  createTextToolOutcome,
  executeTool,
  type ToolExecutionContext,
  type ToolExecutionOutcome,
  type ToolImplementationOutcome,
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

  if (args.hasMaxOutputTokens && args.maxOutputTokens !== undefined) {
    const maxTokens = clampOutputTokens(args.maxOutputTokens) ?? BASH_MODEL_DEFAULT_MAX_TOKENS;
    return { maxTokens };
  }

  return BASH_MODEL_DEFAULT_POLICY;
}

export const BASH_DEFAULT_TIMEOUT_MS = 60_000;

const BASH_DESCRIPTION = [
  "Execute a command in a fresh non-interactive login Bash in the current working directory and return its output.",
  "Interactive commands are not supported (no TTY/stdin); commands that prompt or open editors will hang or fail.",
].join(" ");

const BASH_COMMAND_DESCRIPTION = "The Bash command to execute.";

const BASH_WORKING_DIRECTORY_DESCRIPTION =
  "Single-line working directory for the command. If omitted, uses the current working directory. Prefer this over `cd` in the command.";

const BASH_TIMEOUT_DESCRIPTION =
  "Timeout in milliseconds. If omitted, defaults to 60 seconds. Use a longer timeout for known slow operations like builds or large clones.";

const BASH_MAX_OUTPUT_TOKENS_DESCRIPTION = [
  "Optional maximum number of output tokens to return to the model.",
  `Defaults to ${BASH_MODEL_DEFAULT_MAX_TOKENS} tokens if unset. Most commands should leave this unset. Usually it is better to run a more scoped command than to request more output. Do not set it speculatively or just in case. Only set it when you genuinely need more output, such as after a truncated result or when the user explicitly asks for more detail.`,
  `When more output is truly needed, set a value between ${BASH_MODEL_DEFAULT_MAX_TOKENS} and ${BASH_MODEL_MAX_AUTONOMOUS_TOKENS}.`,
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
      workingDirectory: Type.Optional(
        Type.String({
          description: BASH_WORKING_DIRECTORY_DESCRIPTION,
          pattern: "^[^\\r\\n]+$",
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

export interface BashTruncationInfo {
  output: string;
  model: TruncationResult;
  captureTruncated: boolean;
  gated?: boolean;
  fullOutputPath?: string;
}

const BASH_TEMP_FILE_TIMEOUT_MS = 2_000;
const BASH_TEMP_FILE_SCRIPT = `
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const file = path.join(os.tmpdir(), "tau-bash-output." + randomUUID());
fs.closeSync(fs.openSync(file, "wx"));
process.stdout.write(file);
`.trim();

async function createBashTempFilePath(backend: ToolExecutionBackend): Promise<string | undefined> {
  try {
    const result = await backend.runNodeScript(BASH_TEMP_FILE_SCRIPT, [], {
      timeoutMs: BASH_TEMP_FILE_TIMEOUT_MS,
    });
    if (result.exitCode !== 0) return undefined;
    return result.stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

export async function writeBashTempFile(
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
  return ` Full output saved to ${args.path}. To see more output, either read the file or re-run with a higher maxOutputTokens. If reading the file, be mindful of its size.`;
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

function getBashTermination(args: {
  aborted: boolean;
  timedOut: boolean;
  closeSignal: string | null;
  timeoutMs: number;
}): { backendNote: string; resultText: string } | undefined {
  if (args.timedOut) {
    return {
      backendNote: `(tau) timed out after ${args.timeoutMs}ms`,
      resultText: `Command timed out after ${args.timeoutMs}ms.`,
    };
  }
  if (args.aborted) {
    return { backendNote: "(tau) aborted", resultText: "Command was cancelled." };
  }
  if (args.closeSignal) {
    return {
      backendNote: `(tau) terminated by signal ${args.closeSignal}`,
      resultText: `Command was terminated by signal ${args.closeSignal}.`,
    };
  }
  return undefined;
}

function stripBashTerminationNote(output: string, note: string): string {
  const trimmedOutput = output.trimEnd();
  return trimmedOutput.endsWith(note) ? trimmedOutput.slice(0, -note.length).trimEnd() : output;
}

function appendBashNotice(output: string, notice: string): string {
  const trimmedOutput = output.trimEnd();
  return trimmedOutput ? `${trimmedOutput}\n\n[${notice}]` : notice;
}

export function formatBashToolResultText(args: {
  truncationInfo: BashTruncationInfo;
  exitCode: number | null;
}): string {
  const { truncationInfo, exitCode } = args;
  const { model, captureTruncated, gated, fullOutputPath } = truncationInfo;
  const hasNoOutput = model.outputBytes === 0;

  if (gated) {
    const preview = model.content;
    const totalTokenEstimate = bytesToTokens(model.totalBytes);
    const gateNote = `\n\n[Output gated: This command already ran and any side effects have persisted. Full output estimate: ~${totalTokenEstimate} tokens.${formatBashOutputFileHint({ path: fullOutputPath })} If you need more output from this truncated result, either read the saved file or re-run with maxOutputTokens set to ${BASH_MODEL_DEFAULT_MAX_TOKENS}-${BASH_MODEL_MAX_AUTONOMOUS_TOKENS}. Only exceed ${BASH_MODEL_MAX_AUTONOMOUS_TOKENS} when the user explicitly requests more output, up to ${BASH_MAX_OUTPUT_TOKENS}. User requests are checked by the system, so do not exceed ${BASH_MODEL_MAX_AUTONOMOUS_TOKENS} autonomously.]`;
    const resultText = `${preview}${gateNote}`;
    return exitCode !== null && exitCode !== 0
      ? appendBashNotice(resultText, `Command failed with exit code ${exitCode}.`)
      : resultText;
  }

  if (hasNoOutput && exitCode === 0) {
    return "Command produced no output (exit 0)";
  }
  if (hasNoOutput && exitCode !== null) {
    return `Command failed with exit code ${exitCode} and produced no output.`;
  }

  const outputForContext = model.content;
  const truncNote =
    model.truncated || captureTruncated
      ? `\n\n[Output truncated for context: ${model.outputLines} lines / ${formatBytes(model.outputBytes)} shown of ${model.totalLines} lines / ${formatBytes(model.totalBytes)} (full output estimate: ~${bytesToTokens(model.totalBytes)} tokens).${formatBashOutputFileHint({ path: fullOutputPath })}]`
      : "";
  const resultText = `${outputForContext}${truncNote}`;
  return exitCode !== null && exitCode !== 0
    ? appendBashNotice(resultText, `Command failed with exit code ${exitCode}.`)
    : resultText;
}

export function formatBashUserMessageText(args: {
  command: string;
  truncationInfo: BashTruncationInfo;
  exitCode: number | null;
}): string {
  const { command, truncationInfo, exitCode } = args;
  const { model, captureTruncated, fullOutputPath } = truncationInfo;

  const outputForContext = model.content.trimEnd() || "(no output)";
  const truncNote =
    model.truncated || captureTruncated
      ? `\n\n[Output truncated for context: ${model.outputLines} lines / ${formatBytes(model.outputBytes)} shown of ${model.totalLines} lines / ${formatBytes(model.totalBytes)} (full output estimate: ~${bytesToTokens(model.totalBytes)} tokens).${formatBashOutputFileHint({ path: fullOutputPath })}]`
      : "";
  const exitNote = exitCode !== null && exitCode !== 0 ? `\n(exit ${exitCode})` : "";
  const bashContextText = `$ ${command}\n${outputForContext}${truncNote}${exitNote}`;
  return `Bash command output:\n${bashContextText}`;
}

export function buildBashPresentation(args: {
  toolName: string;
  operation?: string;
  subject: string;
  truncationInfo: BashTruncationInfo;
  exitCode: number | null;
  durationMs: number;
  workingDirectory?: string;
  includeExitCode?: boolean;
  actionLabel?: string;
  detailTruncation?: Exclude<ToolCardDetailTruncation, false>;
}): ToolRunPresentation {
  const { truncationInfo, exitCode, durationMs } = args;
  const { model, captureTruncated } = truncationInfo;

  const detailText = truncationInfo.output.replace(/\r\n?/g, "\n").trimEnd();
  const details: ToolCardLine[] = detailText
    ? detailText.split("\n").map((text) => ({ text, wrap: "character" }))
    : [];

  const outputLines = model.outputLines;
  const outputBytes = model.outputBytes;
  const hasOutput = outputBytes > 0;

  const exitSummary = exitCode === null ? "exit ?" : `exit ${exitCode}`;
  const workingDirectoryLabel = args.workingDirectory
    ? formatCwd(args.workingDirectory)
    : undefined;
  const durationLabel = formatToolDurationMs(durationMs);
  const lineLabel = hasOutput ? `${outputLines} line${outputLines === 1 ? "" : "s"}` : undefined;
  const tokenLabel = hasOutput ? formatTokenEstimate(outputBytes) : undefined;
  const summaryParts: string[] = [];
  if (model.truncated || captureTruncated) {
    summaryParts.push(TRUNCATION_MARKER);
  }
  if (args.includeExitCode !== false) {
    summaryParts.push(exitSummary);
  }
  if (workingDirectoryLabel) {
    summaryParts.push(workingDirectoryLabel);
  }
  summaryParts.push(durationLabel);
  if (tokenLabel) {
    summaryParts.push(tokenLabel);
  }
  if (lineLabel) {
    summaryParts.push(lineLabel);
  }
  return buildToolRunPresentation({
    toolName: args.toolName,
    operation: args.operation,
    subject: args.subject,
    details,
    metadata: summaryParts,
    ...(args.detailTruncation ? { detailTruncation: args.detailTruncation } : {}),
    actionOverrides: args.actionLabel
      ? { succeeded: args.actionLabel, failed: args.actionLabel }
      : undefined,
  });
}

function resolveBashWorkingDirectory(args: {
  contextCwd?: string;
  workingDirectory?: string;
}): string {
  const baseCwd = args.contextCwd ?? process.cwd();
  return args.workingDirectory ? resolve(baseCwd, args.workingDirectory) : baseCwd;
}

const bashArgsSchema = z
  .object({
    command: z.string(),
    workingDirectory: z.string().optional(),
    timeout: z.number().optional(),
    maxOutputTokens: z.number().int().optional(),
  })
  .strict();

function parseBashArgs(raw: unknown):
  | {
      ok: true;
      data: {
        command: string;
        workingDirectory?: string;
        timeout?: number;
        maxOutputTokens?: number;
        hasMaxOutputTokens: boolean;
        commandForDisplay: string;
      };
    }
  | { ok: false; error: string; commandForDisplay: string } {
  const rawRecord =
    typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>) : undefined;
  const hasMaxOutputTokens = rawRecord ? "maxOutputTokens" in rawRecord : false;
  const commandForDisplay =
    rawRecord && typeof rawRecord.command === "string"
      ? rawRecord.command.trim() || "(invalid command)"
      : "(invalid command)";

  const parsed = bashArgsSchema.safeParse(raw);
  if (!parsed.success) {
    return {
      ok: false,
      error: formatZodError(parsed.error),
      commandForDisplay,
    };
  }

  const command = parsed.data.command.trim();
  if (!command) {
    return { ok: false, error: "command must not be empty.", commandForDisplay };
  }

  const workingDirectory = parsed.data.workingDirectory?.trim();
  if (parsed.data.workingDirectory !== undefined && !workingDirectory) {
    return { ok: false, error: "workingDirectory must not be empty.", commandForDisplay };
  }
  if (workingDirectory && /[\r\n]/.test(workingDirectory)) {
    return {
      ok: false,
      error: "workingDirectory must be a single line.",
      commandForDisplay,
    };
  }
  if (parsed.data.timeout !== undefined && parsed.data.timeout <= 0) {
    return { ok: false, error: "timeout must be greater than 0.", commandForDisplay };
  }
  if (parsed.data.maxOutputTokens !== undefined && parsed.data.maxOutputTokens <= 0) {
    return {
      ok: false,
      error: "maxOutputTokens must be greater than 0.",
      commandForDisplay,
    };
  }
  if (
    parsed.data.maxOutputTokens !== undefined &&
    parsed.data.maxOutputTokens > BASH_MAX_OUTPUT_TOKENS
  ) {
    return {
      ok: false,
      error: `maxOutputTokens must not exceed ${BASH_MAX_OUTPUT_TOKENS}.`,
      commandForDisplay,
    };
  }

  return {
    ok: true,
    data: {
      command,
      workingDirectory,
      timeout: parsed.data.timeout,
      maxOutputTokens: clampOutputTokens(parsed.data.maxOutputTokens),
      hasMaxOutputTokens,
      commandForDisplay: command,
    },
  };
}

function getBashSubject(raw: unknown): string {
  const parsed = parseBashArgs(raw);
  return parsed.ok ? parsed.data.commandForDisplay : parsed.commandForDisplay;
}

export function createBashToolDefinition(backend: ToolExecutionBackend, cwd: string): AgentTool {
  return {
    schema: BASH_TOOL,
    describe: (toolCall) => {
      const parsedArgs = parseBashArgs(toolCall.arguments);
      const workingDirectory = resolveBashWorkingDirectory({
        contextCwd: cwd,
        workingDirectory: parsedArgs.ok ? parsedArgs.data.workingDirectory : undefined,
      });
      return {
        presentation: buildToolRunPresentation({
          toolName: TOOL_NAME_BASH,
          subject: getBashSubject(toolCall.arguments),
          metadata: [formatCwd(workingDirectory)],
        }),
      };
    },
    async execute(
      toolCall: ToolCall,
      context: ToolExecutionContext,
    ): Promise<ToolExecutionOutcome> {
      const { signal } = context;
      const parsedArgs = parseBashArgs(toolCall.arguments);
      const commandForDisplay = parsedArgs.ok
        ? parsedArgs.data.commandForDisplay
        : parsedArgs.commandForDisplay;
      const subject = commandForDisplay;
      const effectiveWorkingDirectory = resolveBashWorkingDirectory({
        contextCwd: cwd,
        workingDirectory: parsedArgs.ok ? parsedArgs.data.workingDirectory : undefined,
      });

      const blocked = (
        reason: string,
        semanticOutcome: ToolExecutionOutcome["outcome"] = "blocked",
      ): ToolImplementationOutcome => {
        const outcome = createTextToolOutcome(reason, semanticOutcome);
        const uiEvent: ToolActivity = {
          type: "bash_blocked",
          toolCallId: toolCall.id,
          command: commandForDisplay,
          presentation: buildToolRunPresentation({
            toolName: TOOL_NAME_BASH,
            subject: commandForDisplay,
            details: [{ text: reason }],
            metadata: [formatCwd(effectiveWorkingDirectory)],
          }),
          reason,
        };
        return { content: outcome.content, outcome: outcome.outcome, uiEvent };
      };

      if (!parsedArgs.ok) {
        return executeTool(context, () => blocked(`Invalid arguments: ${parsedArgs.error}`));
      }

      const { command, timeout, maxOutputTokens, hasMaxOutputTokens } = parsedArgs.data;

      return executeTool(
        context,
        async () => {
          try {
            const startedAt = Date.now();
            const effectiveTimeoutMs = timeout ?? BASH_DEFAULT_TIMEOUT_MS;
            const {
              output,
              exitCode,
              truncated: captureTruncated,
              aborted,
              timedOut,
              closeSignal,
            } = await backend.runBash(command, {
              signal,
              timeoutMs: effectiveTimeoutMs,
              cwd: effectiveWorkingDirectory,
            });
            const durationMs = Math.max(0, Date.now() - startedAt);
            const termination = getBashTermination({
              aborted,
              timedOut,
              closeSignal,
              timeoutMs: effectiveTimeoutMs,
            });

            const outputPolicy = getBashOutputPolicy({
              mode: "model",
              maxOutputTokens,
              hasMaxOutputTokens,
            });
            const truncationInfo = await prepareBashOutput(
              termination ? stripBashTerminationNote(output, termination.backendNote) : output,
              captureTruncated,
              outputPolicy,
              backend,
            );
            const resultText = formatBashToolResultText({
              truncationInfo,
              exitCode: termination ? null : exitCode,
            });
            const toolText = termination
              ? appendBashNotice(resultText, termination.resultText)
              : resultText;
            const isError = termination !== undefined || exitCode === null || exitCode !== 0;
            const presentation = buildBashPresentation({
              toolName: TOOL_NAME_BASH,
              subject: command,
              truncationInfo,
              exitCode,
              durationMs,
              workingDirectory: effectiveWorkingDirectory,
              includeExitCode: !termination,
            });

            const outcome = createTextToolOutcome(
              toolText,
              aborted || timedOut ? "cancelled" : isError ? "failed" : "succeeded",
            );
            const uiEvent: ToolActivity = {
              type: "bash_execution",
              toolCallId: toolCall.id,
              command,
              presentation,
              exitCode,
            };
            return { content: outcome.content, outcome: outcome.outcome, uiEvent };
          } catch (e) {
            const errorMessage = e instanceof Error ? e.message : String(e);
            return blocked(`Could not execute command: ${errorMessage}`, "failed");
          }
        },
        {
          type: "bash_started",
          toolCallId: toolCall.id,
          command,
          presentation: buildToolRunPresentation({
            toolName: TOOL_NAME_BASH,
            subject: command,
            metadata: [formatCwd(effectiveWorkingDirectory)],
          }),
        },
      );
    },
  };
}
