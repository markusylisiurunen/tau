import { spawn } from "node:child_process";
import type { Tool, ToolCall, ToolResultMessage } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import stripAnsi from "strip-ansi";
import { z } from "zod";
import type { RiskLevel } from "../types.js";
import { createToolError, createToolResult } from "../utils/messages.js";
import {
  type TruncationResult,
  truncateMiddleForModel,
  truncateToBytesFromStart,
} from "../utils/truncate.js";
import type {
  ToolDefinition,
  ToolDispatchResult,
  ToolDispatchResultWithPhases,
  ToolUiEvent,
} from "./registry.js";

export const BASH_MAX_CAPTURE_BYTES = 2 * 1024 * 1024; // 2MB

export const BASH_TOOL_MAX_STDOUT_LINES = 4096;
export const BASH_TOOL_MAX_STDOUT_TOKENS = 25000;
export const BASH_TOOL_MAX_STDERR_LINES = 4096;
export const BASH_TOOL_MAX_STDERR_TOKENS = 25000;

export const BASH_USER_MAX_STDOUT_LINES = 16384;
export const BASH_USER_MAX_STDOUT_TOKENS = 100000;
export const BASH_USER_MAX_STDERR_LINES = 4096;
export const BASH_USER_MAX_STDERR_TOKENS = 25000;

export const BASH_DEFAULT_TIMEOUT_MS = 60_000;
export const BASH_KILL_GRACE_MS = 2_000;

const SENSITIVE_ENV_PATTERNS = [/_KEY$/, /_SECRET$/, /_TOKEN$/, /_PASSWORD$/, /^API_KEY$/];
const ALLOWED_ENV_VARS = new Set([
  "PATH",
  "HOME",
  "USER",
  "SHELL",
  "TERM",
  "LANG",
  "LC_ALL",
  "LC_CTYPE",
  "TMPDIR",
  "TMP",
  "TEMP",
  "PWD",
  "OLDPWD",
  "EDITOR",
  "VISUAL",
  "PAGER",
  "XDG_CONFIG_HOME",
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
]);

function sanitizeEnvironment(): NodeJS.ProcessEnv {
  const sanitized: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    // Always include explicitly allowed vars
    if (ALLOWED_ENV_VARS.has(key)) {
      sanitized[key] = value;
      continue;
    }
    // Exclude vars matching sensitive patterns
    if (SENSITIVE_ENV_PATTERNS.some((pattern) => pattern.test(key))) {
      continue;
    }
    // Include other vars (e.g., npm config, go paths, etc.)
    sanitized[key] = value;
  }
  return sanitized;
}

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

export type BashToolResult = {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  truncated: boolean;
};

export type BashSafetyLevel = "read" | "write";

export interface BashTruncationInfo {
  output: string;
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

export function executeBashTool(
  command: string,
  options: { timeoutMs?: number; signal?: AbortSignal; cwd?: string } = {},
): Promise<BashToolResult> {
  return new Promise((resolve, reject) => {
    const timeoutMs = options.timeoutMs;
    const signal = options.signal;
    const cwd = options.cwd;

    const child = spawn(command, {
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...sanitizeEnvironment(),
        GIT_TERMINAL_PROMPT: "0",
        GIT_EDITOR: "true",
        GIT_SEQUENCE_EDITOR: "true",
        GIT_PAGER: "cat",
        GIT_ASKPASS: "true",
        GIT_SSH_COMMAND: "ssh -o BatchMode=yes",
      },
      detached: true,
      cwd,
    });

    let stdout = "";
    let stderr = "";
    let truncated = false;
    let terminationNote: string | undefined;

    const truncateIfNeeded = () => {
      const totalBytes = Buffer.byteLength(stdout, "utf-8") + Buffer.byteLength(stderr, "utf-8");
      if (totalBytes > BASH_MAX_CAPTURE_BYTES) {
        truncated = true;
        stdout = truncateToBytesFromStart(stdout, BASH_MAX_CAPTURE_BYTES / 2);
        stderr = truncateToBytesFromStart(stderr, BASH_MAX_CAPTURE_BYTES / 2);
      }
    };

    const appendStdout = (chunk: string) => {
      if (truncated) return;
      if (!chunk) return;
      stdout += chunk;
      truncateIfNeeded();
    };

    const appendStderr = (chunk: string) => {
      if (truncated) return;
      if (!chunk) return;
      stderr += chunk;
      truncateIfNeeded();
    };

    const ensureTerminationNote = () => {
      const note = terminationNote?.trim();
      if (!note) return;
      if (stdout.includes(note) || stderr.includes(note)) return;

      const noteText = `${stderr && !stderr.endsWith("\n") ? "\n" : ""}${note}\n`;
      const noteBytes = Buffer.byteLength(noteText, "utf-8");

      const currentBytes = Buffer.byteLength(stdout, "utf-8") + Buffer.byteLength(stderr, "utf-8");

      if (currentBytes + noteBytes > BASH_MAX_CAPTURE_BYTES) {
        truncated = true;

        const remaining = Math.max(0, BASH_MAX_CAPTURE_BYTES - noteBytes);
        const stdoutBudget = Math.floor(remaining / 2);
        const stderrBudget = remaining - stdoutBudget;

        stdout = truncateToBytesFromStart(stdout, stdoutBudget);
        stderr = truncateToBytesFromStart(stderr, stderrBudget);
      }

      stderr += noteText;
    };

    const killProcess = (sig: NodeJS.Signals) => {
      if (child.killed) return;

      if (child.pid) {
        try {
          // Kill the whole process group, not just the shell.
          process.kill(-child.pid, sig);
          return;
        } catch {
          // Fall back to killing only the child.
        }
      }

      try {
        child.kill(sig);
      } catch {
        // ignore
      }
    };

    let terminationRequested = false;
    let killTimer: ReturnType<typeof setTimeout> | undefined;

    const requestTermination = (note: string) => {
      if (terminationRequested) return;
      terminationRequested = true;
      terminationNote = note;

      killProcess("SIGTERM");
      killTimer = setTimeout(() => killProcess("SIGKILL"), BASH_KILL_GRACE_MS);
    };

    const abortHandler = () => requestTermination("(tau) aborted");

    const timeoutId =
      typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0
        ? setTimeout(() => requestTermination(`(tau) timed out after ${timeoutMs}ms`), timeoutMs)
        : undefined;

    const cleanup = () => {
      if (timeoutId) {
        clearTimeout(timeoutId);
      }
      if (killTimer) {
        clearTimeout(killTimer);
      }
      if (signal) {
        signal.removeEventListener("abort", abortHandler);
      }
    };

    if (signal) {
      if (signal.aborted) {
        abortHandler();
      } else {
        signal.addEventListener("abort", abortHandler, { once: true });
      }
    }

    child.stdout?.on("data", (d) => appendStdout(d.toString()));
    child.stderr?.on("data", (d) => appendStderr(d.toString()));

    child.on("error", (err) => {
      cleanup();
      reject(err);
    });

    child.on("close", (exitCode, closeSignal) => {
      if (!terminationNote && closeSignal) {
        terminationNote = `(tau) terminated by signal ${closeSignal}`;
      }

      cleanup();
      ensureTerminationNote();
      resolve({ stdout, stderr, exitCode, truncated });
    });
  });
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

export function createBashToolDefinition(): ToolDefinition {
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
            } = await executeBashTool(command, { signal, timeoutMs: BASH_DEFAULT_TIMEOUT_MS });
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

            const toolResult: ToolResultMessage = createToolResult(toolCall, toolText, isError);
            const uiEvent: ToolUiEvent = {
              type: "bash_execution",
              toolCallId: toolCall.id,
              command,
              exitCode,
              truncationInfo,
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
