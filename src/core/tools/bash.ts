import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { Context, Tool, ToolCall, ToolResultMessage } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import stripAnsi from "strip-ansi";
import { z } from "zod";
import { AuthStorage } from "../auth/auth_storage.js";
import { createCredentialResolver } from "../auth/credential_resolver.js";
import { parseModelReasoningTarget } from "../model_target.js";
import type { RiskLevel } from "../types.js";
import { CODEX_ORIGINATOR, CODEX_USER_AGENT } from "../utils/codex.js";
import { formatCwd } from "../utils/format.js";
import { createToolError, createToolResult, extractAssistantText } from "../utils/messages.js";
import { streamModel } from "../utils/model_stream.js";
import { parseStreamingSettings } from "../utils/streaming_settings.js";
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
  ToolDispatchContext,
  ToolDispatchResult,
  ToolDispatchResultWithPhases,
  ToolUiEvent,
  ToolUiLine,
  ToolUiText,
} from "./registry.js";
import { TOOL_NAME_BASH } from "./tool_names.js";

const BASH_MODEL_DEFAULT_MAX_TOKENS = 8192;
const BASH_MODEL_MIN_OUTPUT_TOKENS = 4096;
const BASH_MODEL_DEFAULT_PREVIEW_TOKENS = 2048;
const BASH_MODEL_MAX_AUTONOMOUS_TOKENS = 16384;
const BASH_MAX_OUTPUT_TOKENS = 65536;
const BASH_USER_MAX_TOKENS = BASH_MAX_OUTPUT_TOKENS;
const BASH_GATEKEEPER_PASSTHROUGH_MAX_TOKENS = 4096;
const BASH_GATEKEEPER_REVIEW_MAX_TOKENS = 12288;
const BASH_GATEKEEPER_RESPONSE_MAX_TOKENS = 16;

const BASH_GATEKEEPER_SYSTEM_PROMPT = [
  "You judge whether a bash command's large output should be passed through to a main coding model.",
  "Respond with exactly one lowercase word: allow or gate.",
  "Allow only when the output appears intentionally requested and useful for reasoning about the task.",
  "Gate when the output looks accidental, noisy, repetitive, generated, binary-like, minified, or otherwise likely too large to be useful.",
  "If uncertain, respond gate.",
].join(" ");

type BashOutputPolicy =
  | {
      kind: "user";
      maxTokens: number;
    }
  | {
      kind: "model-explicit-max";
      maxTokens: number;
    }
  | {
      kind: "model-default";
      maxTokens: number;
      previewTokens: number;
    }
  | {
      kind: "model-gatekeeper";
      maxTokens: number;
      previewTokens: number;
      passThroughTokens: number;
      gatekeeperModel: string;
    };

type BashGatekeeperDecision = {
  decision: "allow" | "gate";
  note?: string;
};

type PrepareBashOutputOptions = {
  command?: string;
  signal?: AbortSignal;
  gatekeeper?: (args: {
    command: string;
    output: string;
    signal: AbortSignal;
    model: string;
  }) => Promise<BashGatekeeperDecision>;
};

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
  "Most commands should leave this unset. Usually it is better to run a more scoped command than to request more output.",
  `If unset, Tau applies its configured bash output gating policy. Without the experimental bashOutputGatekeeper config, outputs above ${BASH_MODEL_DEFAULT_MAX_TOKENS} tokens are gated to a ${BASH_MODEL_DEFAULT_PREVIEW_TOKENS}-token preview.`,
  `When more output is truly needed, set a value between ${BASH_MODEL_MIN_OUTPUT_TOKENS} and ${BASH_MODEL_MAX_AUTONOMOUS_TOKENS}.`,
  `Only exceed ${BASH_MODEL_MAX_AUTONOMOUS_TOKENS} when the user explicitly requests more output, up to ${BASH_MAX_OUTPUT_TOKENS}.`,
  `User requests are checked by the system, so do not exceed ${BASH_MODEL_MAX_AUTONOMOUS_TOKENS} autonomously.`,
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
  gateNotice?: string;
  fullOutputPath?: string;
}

const BASH_TEMP_FILE_TEMPLATE = "/tmp/tau-bash-output.XXXXXX";
const BASH_TEMP_FILE_TIMEOUT_MS = 2_000;

function clampOutputTokens(value: number | undefined): number | undefined {
  if (value === undefined || !Number.isFinite(value)) return undefined;
  return Math.min(
    Math.max(Math.floor(value), BASH_MODEL_MIN_OUTPUT_TOKENS),
    BASH_MAX_OUTPUT_TOKENS,
  );
}

export function getBashOutputPolicy(args: {
  mode: "model" | "user";
  maxOutputTokens?: number;
  hasMaxOutputTokens?: boolean;
  gatekeeperModel?: string;
}): BashOutputPolicy {
  if (args.mode === "user") {
    return { kind: "user", maxTokens: BASH_USER_MAX_TOKENS };
  }

  if (args.hasMaxOutputTokens && args.maxOutputTokens !== undefined) {
    return {
      kind: "model-explicit-max",
      maxTokens: clampOutputTokens(args.maxOutputTokens) ?? BASH_MODEL_DEFAULT_MAX_TOKENS,
    };
  }

  const gatekeeperModel = args.gatekeeperModel?.trim();
  if (gatekeeperModel) {
    return {
      kind: "model-gatekeeper",
      maxTokens: BASH_GATEKEEPER_REVIEW_MAX_TOKENS,
      previewTokens: BASH_MODEL_DEFAULT_PREVIEW_TOKENS,
      passThroughTokens: BASH_GATEKEEPER_PASSTHROUGH_MAX_TOKENS,
      gatekeeperModel,
    };
  }

  return {
    kind: "model-default",
    maxTokens: BASH_MODEL_DEFAULT_MAX_TOKENS,
    previewTokens: BASH_MODEL_DEFAULT_PREVIEW_TOKENS,
  };
}

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
  return ` Full output saved to ${args.path}. To see more output, either read the file or re-run with a higher maxOutputTokens. If reading the file, be mindful of its size.`;
}

function buildUntruncatedBashResult(content: string, maxTokens: number): TruncationResult {
  if (!content) {
    return {
      content: "",
      truncated: false,
      truncatedBy: null,
      totalLines: 0,
      totalBytes: 0,
      outputLines: 0,
      outputBytes: 0,
      maxLines: 0,
      maxTokens,
    };
  }

  const totalBytes = Buffer.byteLength(content, "utf-8");
  const totalLines = content.split("\n").length;
  return {
    content,
    truncated: false,
    truncatedBy: null,
    totalLines,
    totalBytes,
    outputLines: totalLines,
    outputBytes: totalBytes,
    maxLines: totalLines,
    maxTokens,
  };
}

function formatBashMaxOutputTokensGuidance(): string {
  return ` To inspect more output intentionally, re-run with maxOutputTokens set to the desired token budget. Use up to ${BASH_MODEL_MAX_AUTONOMOUS_TOKENS} autonomously; up to ${BASH_MAX_OUTPUT_TOKENS} only when the user explicitly requests it. User requests are checked by the system, so do not exceed ${BASH_MODEL_MAX_AUTONOMOUS_TOKENS} autonomously.`;
}

function buildBashGateNotice(args: {
  message: string;
  totalTokenEstimate: number;
  fullOutputPath?: string;
}): string {
  return `${args.message} This command already ran and any side effects have persisted. Full output estimate: ~${args.totalTokenEstimate} tokens.${formatBashOutputFileHint({ path: args.fullOutputPath })}${formatBashMaxOutputTokensGuidance()}`;
}

async function createGatedBashOutput(args: {
  output: string;
  captureTruncated: boolean;
  previewTokens: number;
  backend: ToolExecutionBackend;
  message: string;
  totalTokenEstimate: number;
}): Promise<BashTruncationInfo> {
  const previewTruncation = truncateForTokens(args.output, {
    maxTokens: args.previewTokens,
    strategy: "middle",
  });
  const fullOutputPath = await writeBashTempFile(args.backend, args.output);
  return {
    output: previewTruncation.content,
    model: previewTruncation,
    captureTruncated: args.captureTruncated,
    gated: true,
    gateNotice: buildBashGateNotice({
      message: args.message,
      totalTokenEstimate: args.totalTokenEstimate,
      fullOutputPath,
    }),
    fullOutputPath,
  };
}

function buildBashGatekeeperPrompt(command: string, output: string): string {
  return [
    "Decide whether this bash output should be passed through to the main model.",
    "",
    "Command:",
    "```sh",
    command,
    "```",
    "",
    "Output:",
    "```text",
    output,
    "```",
  ].join("\n");
}

function parseBashGatekeeperResponse(text: string): BashGatekeeperDecision {
  const firstWord = text
    .trim()
    .toLowerCase()
    .match(/[a-z]+/)?.[0];
  if (firstWord === "allow") {
    return { decision: "allow" };
  }
  if (firstWord === "gate") {
    return {
      decision: "gate",
      note: "the output was judged likely accidental or too noisy.",
    };
  }
  return {
    decision: "gate",
    note: "the gatekeeper returned an invalid response.",
  };
}

function createBashGatekeeper(
  context: ToolDispatchContext,
): PrepareBashOutputOptions["gatekeeper"] {
  const gatekeeperModel = context.config.bashOutputGatekeeper?.model?.trim();
  if (!gatekeeperModel) {
    return undefined;
  }

  const parsedTarget = parseModelReasoningTarget(gatekeeperModel, {
    resolveModel: context.modelResolver,
  });
  if (!parsedTarget.target) {
    return async ({ model }) => ({
      decision: "gate",
      note: `the gatekeeper model '${model}' could not be resolved.`,
    });
  }

  const target = parsedTarget.target;
  const authStorage = new AuthStorage(context.authPath);
  const credentialResolver = createCredentialResolver({
    authStorage,
    getConfig: () => context.config,
  });

  return async ({ command, output, signal, model }) => {
    const sessionId = `tau-bash-gatekeeper-${randomUUID()}`;

    let apiKey: string | undefined;
    try {
      apiKey = await credentialResolver.getApiKey(target.model.provider, {
        sessionId,
      });
    } catch {
      return {
        decision: "gate",
        note: `the gatekeeper model '${model}' could not authenticate.`,
      };
    }

    if (!apiKey && target.model.provider === "openai-codex") {
      return {
        decision: "gate",
        note: `the gatekeeper model '${model}' could not authenticate.`,
      };
    }

    const prompt = buildBashGatekeeperPrompt(command, output);
    const modelContext: Context = {
      systemPrompt: BASH_GATEKEEPER_SYSTEM_PROMPT,
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: prompt }],
          timestamp: Date.now(),
        },
      ],
    };

    const streamOptions = parseStreamingSettings({
      reasoning: target.reasoning,
      maxTokens: BASH_GATEKEEPER_RESPONSE_MAX_TOKENS,
      signal,
      sessionId,
      ...(apiKey ? { apiKey } : {}),
    });

    if (target.model.provider === "openai-codex") {
      streamOptions.headers = {
        ...streamOptions.headers,
        originator: CODEX_ORIGINATOR,
        "User-Agent": CODEX_USER_AGENT,
      };
    }

    try {
      const stream = streamModel(target.model, modelContext, streamOptions);
      const finalMessage = await stream.result();
      return parseBashGatekeeperResponse(extractAssistantText(finalMessage));
    } catch (error) {
      try {
        await credentialResolver.noteProviderError?.(target.model.provider, {
          sessionId,
          error,
        });
      } catch {}
      return {
        decision: "gate",
        note: `the gatekeeper model '${model}' call failed.`,
      };
    }
  };
}

export async function prepareBashOutput(
  output: string,
  captureTruncated: boolean,
  policy: BashOutputPolicy,
  backend: ToolExecutionBackend,
  options?: PrepareBashOutputOptions,
): Promise<BashTruncationInfo> {
  const cleanOutput = stripAnsi(output);

  if (policy.kind === "model-gatekeeper") {
    const totalBytes = Buffer.byteLength(cleanOutput, "utf-8");
    const totalTokenEstimate = bytesToTokens(totalBytes);

    if (totalTokenEstimate <= policy.passThroughTokens) {
      const model = buildUntruncatedBashResult(cleanOutput, policy.maxTokens);
      return {
        output: model.content,
        model,
        captureTruncated,
      };
    }

    if (totalTokenEstimate > policy.maxTokens) {
      return createGatedBashOutput({
        output: cleanOutput,
        captureTruncated,
        previewTokens: policy.previewTokens,
        backend,
        message: `Output gated by experimental bashOutputGatekeeper hard limit because the full output exceeded ${policy.maxTokens} tokens.`,
        totalTokenEstimate,
      });
    }

    if (options?.command && options.signal && options.gatekeeper) {
      const decision = await options.gatekeeper({
        command: options.command,
        output: cleanOutput,
        signal: options.signal,
        model: policy.gatekeeperModel,
      });
      if (decision.decision === "allow") {
        const model = buildUntruncatedBashResult(cleanOutput, policy.maxTokens);
        return {
          output: model.content,
          model,
          captureTruncated,
        };
      }

      return createGatedBashOutput({
        output: cleanOutput,
        captureTruncated,
        previewTokens: policy.previewTokens,
        backend,
        message: `Output gated by experimental bashOutputGatekeeper model '${policy.gatekeeperModel}' because ${decision.note ?? "the output was judged likely accidental or too noisy."}`,
        totalTokenEstimate,
      });
    }

    return createGatedBashOutput({
      output: cleanOutput,
      captureTruncated,
      previewTokens: policy.previewTokens,
      backend,
      message: `Output gated by experimental bashOutputGatekeeper model '${policy.gatekeeperModel}' because the gatekeeper was unavailable.`,
      totalTokenEstimate,
    });
  }

  const maxTruncation = truncateForTokens(cleanOutput, {
    maxTokens: policy.maxTokens,
    strategy: "middle",
  });
  const fullOutputPath = maxTruncation.truncated
    ? await writeBashTempFile(backend, cleanOutput)
    : undefined;

  if (policy.kind === "model-default" && maxTruncation.truncated) {
    const previewTruncation = truncateForTokens(cleanOutput, {
      maxTokens: policy.previewTokens,
      strategy: "middle",
    });
    return {
      output: previewTruncation.content,
      model: previewTruncation,
      captureTruncated,
      gated: true,
      gateNotice: buildBashGateNotice({
        message: "Output gated by Tau's default bash output policy.",
        totalTokenEstimate: bytesToTokens(maxTruncation.totalBytes),
        fullOutputPath,
      }),
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
  const { model, captureTruncated, gated, gateNotice, fullOutputPath } = truncationInfo;
  const hasNoOutput = model.outputBytes === 0;

  if (gated) {
    const preview = model.content;
    const gateNote = gateNotice
      ? `\n\n[${gateNotice}]`
      : `\n\n[Output gated: This command already ran and any side effects have persisted. Full output estimate: ~${bytesToTokens(model.totalBytes)} tokens.${formatBashOutputFileHint({ path: fullOutputPath })}${formatBashMaxOutputTokensGuidance()}]`;
    const exitNote = exitCode !== null && exitCode !== 0 ? `\n(exit ${exitCode})` : "";
    return `${preview}${gateNote}${exitNote}`;
  }

  if (hasNoOutput && exitCode === 0) {
    return "Command produced no output (exit 0)";
  }

  const outputForContext = model.content;
  const truncNote =
    model.truncated || captureTruncated
      ? `\n\n[Output truncated for context: ${model.outputLines} lines / ${formatBytes(model.outputBytes)} shown of ${model.totalLines} lines / ${formatBytes(model.totalBytes)} (full output estimate: ~${bytesToTokens(model.totalBytes)} tokens).${formatBashOutputFileHint({ path: fullOutputPath })}]`
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
      ? `\n\n[Output truncated for context: ${model.outputLines} lines / ${formatBytes(model.outputBytes)} shown of ${model.totalLines} lines / ${formatBytes(model.totalBytes)} (full output estimate: ~${bytesToTokens(model.totalBytes)} tokens).${formatBashOutputFileHint({ path: fullOutputPath })}]`
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
  workingDirectory?: string;
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
  const workingDirectoryLabel = args.workingDirectory
    ? formatCwd(args.workingDirectory)
    : undefined;
  const durationLabel = formatDurationMs(durationMs);
  const lineLabel = hasOutput ? `${outputLines} line${outputLines === 1 ? "" : "s"}` : "no output";
  const bytesLabel = hasOutput ? formatBytes(outputBytes) : undefined;
  const tokenLabel = hasOutput ? formatTokenEstimate(outputBytes) : undefined;
  const summaryParts: string[] = [];
  if (model.truncated || captureTruncated) {
    summaryParts.push(TRUNCATION_MARKER);
  }
  summaryParts.push(exitSummary);
  if (workingDirectoryLabel) {
    summaryParts.push(workingDirectoryLabel);
  }
  summaryParts.push(durationLabel, lineLabel);
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

function resolveBashWorkingDirectory(args: {
  contextCwd?: string;
  workingDirectory?: string;
}): string {
  const baseCwd = args.contextCwd ?? process.cwd();
  return args.workingDirectory ? resolve(baseCwd, args.workingDirectory) : baseCwd;
}

const bashArgsSchema = z.object({
  command: z.string().trim().min(1),
  safetyLevel: z.enum(["read", "write"]),
  workingDirectory: z.string().trim().min(1).optional(),
  timeout: z.number().positive().optional(),
  maxOutputTokens: z.number().int().positive().optional(),
});

function parseBashArgs(raw: unknown):
  | {
      ok: true;
      data: {
        command: string;
        safetyLevel: BashSafetyLevel;
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
      error: parsed.error.issues.map((issue) => issue.message).join("; "),
      commandForDisplay,
    };
  }

  return {
    ok: true,
    data: {
      command: parsed.data.command,
      safetyLevel: parsed.data.safetyLevel as BashSafetyLevel,
      workingDirectory: parsed.data.workingDirectory,
      timeout: parsed.data.timeout,
      maxOutputTokens: clampOutputTokens(parsed.data.maxOutputTokens),
      hasMaxOutputTokens,
      commandForDisplay: parsed.data.command,
    },
  };
}

export function createBashToolDefinition(backend: ToolExecutionBackend): ToolDefinition {
  return {
    schema: BASH_TOOL,
    async dispatch(
      toolCall: ToolCall,
      riskLevel: RiskLevel,
      signal: AbortSignal,
      context: ToolDispatchContext,
    ): Promise<ToolDispatchResult | ToolDispatchResultWithPhases> {
      const parsedArgs = parseBashArgs(toolCall.arguments);
      const commandForDisplay = parsedArgs.ok
        ? parsedArgs.data.commandForDisplay
        : parsedArgs.commandForDisplay;
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

      if (!parsedArgs.ok) {
        return blocked(`Invalid arguments: ${parsedArgs.error}`);
      }

      const {
        command,
        safetyLevel,
        workingDirectory,
        timeout,
        maxOutputTokens,
        hasMaxOutputTokens,
      } = parsedArgs.data;

      if (riskLevel === "read-only" && safetyLevel === "write") {
        return blocked(
          "Blocked because the risk level is set to 'read-only'. The declared safetyLevel 'write' exceeds the current risk level. Ask the user to enable it with /risk:read-write or revise to a read-only command.",
        );
      }

      const effectiveWorkingDirectory = resolveBashWorkingDirectory({
        contextCwd: context.cwd,
        workingDirectory,
      });

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
              cwd: effectiveWorkingDirectory,
            });
            const durationMs = Math.max(0, Date.now() - startedAt);

            const outputPolicy = getBashOutputPolicy({
              mode: "model",
              maxOutputTokens,
              hasMaxOutputTokens,
              gatekeeperModel: context.config.bashOutputGatekeeper?.model,
            });
            const truncationInfo = await prepareBashOutput(
              output,
              captureTruncated,
              outputPolicy,
              backend,
              {
                command,
                signal,
                gatekeeper: createBashGatekeeper(context),
              },
            );
            const toolText = formatBashToolResultText({ truncationInfo, exitCode });
            const isError = exitCode === null || exitCode !== 0;
            const uiText = buildBashUiText({
              truncationInfo,
              exitCode,
              durationMs,
              workingDirectory: workingDirectory ? effectiveWorkingDirectory : undefined,
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
            const msg = `Bash tool execution failed: ${e instanceof Error ? e.message : String(e)}`;
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
