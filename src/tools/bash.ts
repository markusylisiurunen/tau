import { spawn } from "node:child_process";
import type { Tool, ToolCall, ToolResultMessage } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import type { ToolAccessLevel } from "../types.js";
import { createToolError, createToolResult } from "../utils/messages.js";
import {
  type TruncationResult,
  truncateMiddle,
  truncateMiddleForModel,
  truncateToBytesFromStart,
} from "../utils/truncate.js";
import type { ToolDefinition, ToolDispatchResult, ToolUiEvent } from "./registry.js";

export const BASH_MAX_CAPTURE_BYTES = 2 * 1024 * 1024; // 2MB

export const BASH_DISPLAY_MAX_LINES = 32;
export const BASH_DISPLAY_MAX_BYTES = 50 * 1024; // 50KB

export const BASH_MODEL_MAX_LINES = 10_000;
export const BASH_MODEL_MAX_BYTES = 1024 * 1024; // 1MB
export const BASH_MODEL_BYTES_PER_TOKEN = 4;

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
  "Always provide a risk assessment: 'read' for commands without side effects, 'write' for commands that may modify state (filesystem, processes, network, etc).",
].join(" ");

const BASH_COMMAND_DESCRIPTION = "The shell command to execute.";

const BASH_RISK_DESCRIPTION = [
  "Risk level of the command: 'read' or 'write'.",
  "Use 'read' for non-mutating commands; use 'write' for anything that may change state.",
].join(" ");

export const BASH_TOOL: Tool = {
  name: "bash",
  description: BASH_DESCRIPTION,
  parameters: Type.Object(
    {
      command: Type.String({ description: BASH_COMMAND_DESCRIPTION }),
      risk: Type.String({ description: BASH_RISK_DESCRIPTION }),
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

export type BashRisk = "read" | "write";

export interface BashTruncationInfo {
  display: TruncationResult;
  model: TruncationResult;
  captureTruncated: boolean;
  hasStderr: boolean;
}

function combineOutputForDisplay(stdout: string, stderr: string): string {
  const parts: string[] = [];
  if (stdout.trim()) {
    parts.push(stdout);
  }
  if (stderr.trim()) {
    parts.push(`[stderr]\n${stderr}`);
  }
  return parts.join("\n");
}

export function prepareBashOutput(
  stdout: string,
  stderr: string,
  captureTruncated: boolean,
): BashTruncationInfo {
  const combined = combineOutputForDisplay(stdout, stderr);

  const modelTruncation = truncateMiddleForModel(combined, {
    maxLines: BASH_MODEL_MAX_LINES,
    maxBytes: BASH_MODEL_MAX_BYTES,
    bytesPerTokenApprox: BASH_MODEL_BYTES_PER_TOKEN,
  });

  const displayTruncation = truncateMiddle(modelTruncation.content, {
    maxLines: BASH_DISPLAY_MAX_LINES,
    maxBytes: BASH_DISPLAY_MAX_BYTES,
  });

  return {
    display: displayTruncation,
    model: modelTruncation,
    captureTruncated,
    hasStderr: stderr.trim().length > 0,
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

export function executeBashTool(command: string): Promise<BashToolResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, {
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: sanitizeEnvironment(),
    });

    let stdout = "";
    let stderr = "";
    let truncated = false;

    const appendStdout = (chunk: string) => {
      if (truncated) return;
      if (!chunk) return;
      stdout += chunk;
      const totalBytes = Buffer.byteLength(stdout, "utf-8") + Buffer.byteLength(stderr, "utf-8");
      if (totalBytes > BASH_MAX_CAPTURE_BYTES) {
        truncated = true;
        stdout = truncateToBytesFromStart(stdout, BASH_MAX_CAPTURE_BYTES / 2);
        stderr = truncateToBytesFromStart(stderr, BASH_MAX_CAPTURE_BYTES / 2);
      }
    };

    const appendStderr = (chunk: string) => {
      if (truncated) return;
      if (!chunk) return;
      stderr += chunk;
      const totalBytes = Buffer.byteLength(stdout, "utf-8") + Buffer.byteLength(stderr, "utf-8");
      if (totalBytes > BASH_MAX_CAPTURE_BYTES) {
        truncated = true;
        stdout = truncateToBytesFromStart(stdout, BASH_MAX_CAPTURE_BYTES / 2);
        stderr = truncateToBytesFromStart(stderr, BASH_MAX_CAPTURE_BYTES / 2);
      }
    };

    child.stdout?.on("data", (d) => appendStdout(d.toString()));
    child.stderr?.on("data", (d) => appendStderr(d.toString()));

    child.on("error", () => {
      reject();
    });

    child.on("close", (exitCode) => {
      resolve({ stdout, stderr, exitCode, truncated });
    });
  });
}

function getMissingArgsMessage(command: string, risk: BashRisk | undefined): string {
  if (!command && !risk) {
    return "bash tool call missing valid 'command' and 'risk' fields.";
  }
  if (!command) {
    return "bash tool call missing a valid 'command' string.";
  }
  return "bash tool call missing a valid 'risk' value ('read' or 'write').";
}

function parseBashArgs(raw: unknown): {
  command: string;
  risk: BashRisk | undefined;
  commandForDisplay: string;
} {
  const args = raw as { command?: unknown; risk?: unknown } | undefined;
  const command = typeof args?.command === "string" ? args.command.trim() : "";
  const risk: BashRisk | undefined =
    args?.risk === "read" || args?.risk === "write" ? (args.risk as BashRisk) : undefined;
  const commandForDisplay = command || "(missing command)";
  return { command, risk, commandForDisplay };
}

export function createBashToolDefinition(): ToolDefinition {
  return {
    schema: BASH_TOOL,
    async dispatch(toolCall: ToolCall, accessLevel: ToolAccessLevel): Promise<ToolDispatchResult> {
      const { command, risk, commandForDisplay } = parseBashArgs(toolCall.arguments);

      const blocked = (reason: string): ToolDispatchResult => {
        const toolResult = createToolError(toolCall, reason);
        const uiEvent: ToolUiEvent = { type: "bash_blocked", command: commandForDisplay, reason };
        return { toolResult, uiEvent };
      };

      if (accessLevel === "none") {
        return blocked(
          "Bash tool call blocked: tool access is set to 'none'. Ask the user to enable it with /tool:read or /tool:all.",
        );
      }

      if (!command || !risk) {
        const msg = getMissingArgsMessage(command, risk);
        const toolResult = createToolError(toolCall, msg);
        const uiEvent: ToolUiEvent = {
          type: "bash_blocked",
          command: commandForDisplay,
          reason: msg,
        };
        return { toolResult, uiEvent };
      }

      if (accessLevel === "read" && risk === "write") {
        return blocked(
          "Bash tool call blocked: declared risk 'write' exceeds current tool access 'read'. Ask the user to run /tool:all or revise to a read-only command.",
        );
      }

      try {
        const {
          stdout,
          stderr,
          exitCode,
          truncated: captureTruncated,
        } = await executeBashTool(command);

        const truncationInfo = prepareBashOutput(stdout, stderr, captureTruncated);
        const toolText = formatBashToolResultText({ truncationInfo, exitCode });
        const isError = exitCode !== null && exitCode !== 0;

        const toolResult: ToolResultMessage = createToolResult(toolCall, toolText, isError);
        const uiEvent: ToolUiEvent = { type: "bash_execution", command, exitCode, truncationInfo };
        return { toolResult, uiEvent };
      } catch (e) {
        const msg = `bash tool execution failed: ${e instanceof Error ? e.message : String(e)}`;
        const toolResult = createToolError(toolCall, msg);
        const uiEvent: ToolUiEvent = {
          type: "bash_blocked",
          command: commandForDisplay,
          reason: msg,
        };
        return { toolResult, uiEvent };
      }
    },
  };
}
