import { mkdir, rm, stat } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
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
  sessionCwd: string;
};

const NANOSECONDS_PER_MILLISECOND = 1_000_000n;

function elapsedMs(startTime: bigint): number {
  return Number((process.hrtime.bigint() - startTime) / NANOSECONDS_PER_MILLISECOND);
}

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

function isInsideWorkspace(workspacePath: string, sessionCwd: string): boolean {
  const relPath = relative(workspacePath, sessionCwd);
  return relPath === "" || (!relPath.startsWith(`..${sep}`) && relPath !== "..");
}

function buildCloneCommandArgs(args: {
  repo: string;
  workspacePath: string;
  ref?: string;
  shallow: boolean;
}): string[] {
  const gitCloneArgs: string[] = [];

  if (args.shallow) {
    gitCloneArgs.push("--depth=1", "--no-single-branch");
    if (args.ref) {
      gitCloneArgs.push("--branch", args.ref);
    }
  }

  return [
    "repo",
    "clone",
    args.repo,
    args.workspacePath,
    ...(gitCloneArgs.length > 0 ? ["--", ...gitCloneArgs] : []),
  ];
}

export async function prepareWorkspace(
  options: PrepareWorkspaceOptions,
): Promise<PreparedWorkspace> {
  const workspaceStart = process.hrtime.bigint();
  const workspacePath = join(resolve(options.workspaceRoot), options.projectId, options.sessionId);

  await rm(workspacePath, { recursive: true, force: true });
  await mkdir(dirname(workspacePath), { recursive: true });

  log(options.onLog, "info", "cloning repository", {
    repo: options.project.repo,
    workspacePath,
  });

  const cloneStart = process.hrtime.bigint();
  let cloneMode: "shallow" | "full" = "shallow";
  let cloneResult = await runCommand({
    command: "gh",
    commandArgs: buildCloneCommandArgs({
      repo: options.project.repo,
      workspacePath,
      ref: options.project.ref,
      shallow: true,
    }),
    signal: options.signal,
  });

  if (cloneResult.exitCode !== 0) {
    log(options.onLog, "info", "shallow clone failed, retrying full clone", {
      exitCode: cloneResult.exitCode,
      output: cloneResult.output,
    });

    cloneMode = "full";
    cloneResult = await runCommand({
      command: "gh",
      commandArgs: buildCloneCommandArgs({
        repo: options.project.repo,
        workspacePath,
        shallow: false,
      }),
      signal: options.signal,
    });
  }

  if (cloneResult.exitCode !== 0) {
    log(options.onLog, "error", "gh repo clone failed", { output: cloneResult.output });
    throw new Error(`gh repo clone failed with exit code ${cloneResult.exitCode ?? "unknown"}`);
  }

  if (cloneResult.output.trim()) {
    log(options.onLog, "info", "gh repo clone output", { output: cloneResult.output });
  }

  log(options.onLog, "info", "repository clone complete", {
    mode: cloneMode,
    durationMs: elapsedMs(cloneStart),
    ...(options.project.ref ? { ref: options.project.ref } : {}),
  });

  if (options.project.ref) {
    const checkoutStart = process.hrtime.bigint();
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

    log(options.onLog, "info", "ref checkout complete", {
      ref: options.project.ref,
      durationMs: elapsedMs(checkoutStart),
    });
  }

  let sessionCwd = workspacePath;
  if (options.project.workingDirectory) {
    const configuredPath = options.project.workingDirectory;
    const resolvedPath = resolve(workspacePath, configuredPath);

    if (!isInsideWorkspace(workspacePath, resolvedPath)) {
      log(options.onLog, "error", "project working directory escapes workspace", {
        workingDirectory: configuredPath,
        sessionCwd: resolvedPath,
      });
      throw new Error("project workingDirectory must resolve inside the repository workspace");
    }

    const stats = await stat(resolvedPath).catch(() => {
      throw new Error(
        `project workingDirectory does not exist in cloned repository: ${configuredPath}`,
      );
    });

    if (!stats.isDirectory()) {
      throw new Error(`project workingDirectory is not a directory: ${configuredPath}`);
    }

    sessionCwd = resolvedPath;
    log(options.onLog, "info", "using project working directory", {
      workingDirectory: configuredPath,
      sessionCwd,
    });
  }

  for (const command of options.project.bootstrapCommands ?? []) {
    const bootstrapStart = process.hrtime.bigint();
    log(options.onLog, "info", "running bootstrap command", { command, cwd: sessionCwd });
    const bootstrapResult = await runShellCommand({
      command,
      cwd: sessionCwd,
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
        durationMs: elapsedMs(bootstrapStart),
      });
      throw new Error(
        `bootstrap command failed with exit code ${bootstrapResult.exitCode ?? "unknown"}`,
      );
    }

    log(options.onLog, "info", "bootstrap command complete", {
      command,
      durationMs: elapsedMs(bootstrapStart),
    });
  }

  log(options.onLog, "info", "workspace prepared", {
    workspacePath,
    sessionCwd,
    durationMs: elapsedMs(workspaceStart),
  });

  return { workspacePath, sessionCwd };
}
