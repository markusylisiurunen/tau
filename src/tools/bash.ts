import { spawn } from "node:child_process";
import type { Tool } from "@mariozechner/pi-ai";
import { Type } from "@sinclair/typebox";
import { truncateToBytesFromStart } from "../utils/truncate.js";

export const BASH_MAX_CAPTURE_BYTES = 2 * 1024 * 1024; // 2MB

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
  output: string;
  exitCode: number | null;
  truncated: boolean;
};

export function executeBashTool(command: string): Promise<BashToolResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, {
      shell: true,
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env, // FIXME: consider restricting env for security
    });

    let output = "";
    let truncated = false;

    const append = (chunk: string) => {
      if (!chunk) return;
      output += chunk;
      if (Buffer.byteLength(output, "utf-8") > BASH_MAX_CAPTURE_BYTES) {
        truncated = true;
        output = truncateToBytesFromStart(output, BASH_MAX_CAPTURE_BYTES);
      }
    };

    child.stdout?.on("data", (d) => append(d.toString()));
    child.stderr?.on("data", (d) => append(d.toString()));

    child.on("error", () => {
      reject();
    });

    child.on("close", (exitCode) => {
      resolve({ output, exitCode, truncated });
    });
  });
}
