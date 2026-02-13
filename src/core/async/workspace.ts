import { mkdir, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import type { AsyncProjectConfig } from "../config/schema.js";
import { spawnWithCapture } from "../utils/spawn_capture.js";

export type WorkspaceLogLevel = "info" | "error";

export type WorkspaceLogEntry = {
  level: WorkspaceLogLevel;
  message: string;
  data?: unknown;
};

export type PrepareWorkspaceOptions = {
  sessionId: string;
  projectId: string;
  project: AsyncProjectConfig;
  workspaceRoot: string;
  signal?: AbortSignal;
  onLog?: (entry: WorkspaceLogEntry) => void;
};

export type PreparedWorkspace = {
  workspacePath: string;
};

function log(
  onLog: ((entry: WorkspaceLogEntry) => void) | undefined,
  level: WorkspaceLogLevel,
  message: string,
  data?: unknown,
): void {
  onLog?.({ level, message, ...(data === undefined ? {} : { data }) });
}

async function runCommand(args: {
  command: string;
  commandArgs: string[];
  cwd?: string;
  signal?: AbortSignal;
}): Promise<{ output: string; exitCode: number | null }> {
  const result = await spawnWithCapture(args.command, args.commandArgs, {
    cwd: args.cwd,
    signal: args.signal,
    captureOutput: "combined",
    maxCaptureBytes: 1024 * 1024,
  });

  return {
    output: result.output ?? "",
    exitCode: result.exitCode,
  };
}

async function runShellCommand(args: {
  command: string;
  cwd: string;
  signal?: AbortSignal;
}): Promise<{ output: string; exitCode: number | null }> {
  const result = await spawnWithCapture(args.command, [], {
    cwd: args.cwd,
    signal: args.signal,
    shell: true,
    captureOutput: "combined",
    maxCaptureBytes: 1024 * 1024,
  });

  return {
    output: result.output ?? "",
    exitCode: result.exitCode,
  };
}

export async function prepareWorkspace(
  options: PrepareWorkspaceOptions,
): Promise<PreparedWorkspace> {
  const workspacePath = join(resolve(options.workspaceRoot), options.projectId, options.sessionId);

  await rm(workspacePath, { recursive: true, force: true });
  await mkdir(dirname(workspacePath), { recursive: true });

  log(options.onLog, "info", "cloning repository", {
    repo: options.project.repo,
    workspacePath,
  });

  const cloneResult = await runCommand({
    command: "git",
    commandArgs: ["clone", options.project.repo, workspacePath],
    signal: options.signal,
  });

  if (cloneResult.exitCode !== 0) {
    log(options.onLog, "error", "git clone failed", { output: cloneResult.output });
    throw new Error(`git clone failed with exit code ${cloneResult.exitCode ?? "unknown"}`);
  }

  if (cloneResult.output.trim()) {
    log(options.onLog, "info", "git clone output", { output: cloneResult.output });
  }

  if (options.project.ref) {
    log(options.onLog, "info", "checking out ref", { ref: options.project.ref });
    const checkoutResult = await runCommand({
      command: "git",
      commandArgs: ["-C", workspacePath, "checkout", options.project.ref],
      signal: options.signal,
    });

    if (checkoutResult.exitCode !== 0) {
      log(options.onLog, "error", "git checkout failed", { output: checkoutResult.output });
      throw new Error(`git checkout failed with exit code ${checkoutResult.exitCode ?? "unknown"}`);
    }

    if (checkoutResult.output.trim()) {
      log(options.onLog, "info", "git checkout output", { output: checkoutResult.output });
    }
  }

  for (const command of options.project.bootstrapCommands ?? []) {
    log(options.onLog, "info", "running bootstrap command", { command });
    const bootstrapResult = await runShellCommand({
      command,
      cwd: workspacePath,
      signal: options.signal,
    });

    if (bootstrapResult.output.trim()) {
      log(options.onLog, "info", "bootstrap output", {
        command,
        output: bootstrapResult.output,
      });
    }

    if (bootstrapResult.exitCode !== 0) {
      log(options.onLog, "error", "bootstrap command failed", {
        command,
        output: bootstrapResult.output,
      });
      throw new Error(
        `bootstrap command failed with exit code ${bootstrapResult.exitCode ?? "unknown"}`,
      );
    }
  }

  return { workspacePath };
}
