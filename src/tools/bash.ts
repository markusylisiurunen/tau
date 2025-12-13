import { spawn } from "node:child_process";
import type { Tool } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import { truncateToBytesFromStart } from "../utils/truncate.js";

export const BASH_MAX_CAPTURE_BYTES = 2 * 1024 * 1024; // 2MB

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
