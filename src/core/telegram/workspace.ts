import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import type { TelegramProjectConfig, TelegramRepositoryProjectConfig } from "../config/schema.js";
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
  project: TelegramProjectConfig;
  projects: Record<string, TelegramProjectConfig>;
  workspaceRoot: string;
  defaultWorkspaceRoot: string;
  signal?: AbortSignal;
  onLog?: (entry: WorkspaceLogEntry) => void;
};

export type PreparedWorkspace = {
  workspacePath: string;
  sessionCwd: string;
  memberBackgroundBootstrapCommands?: Array<{
    commands: string[];
    cwd: string;
  }>;
};

export type WorkspaceRootCleanupResult = {
  workspaceRoot: string;
  deletedEntries: number;
  failures: Array<{
    path: string;
    cause: string;
  }>;
};

const NANOSECONDS_PER_MILLISECOND = 1_000_000n;
const repositoryCacheLocks = new Map<string, Promise<unknown>>();

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

function getErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }

  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
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

export type BootstrapCommandMode = "sync" | "background";

export type RunBootstrapCommandsOptions = {
  commands: string[];
  cwd: string;
  signal?: AbortSignal;
  onLog?: (entry: WorkspaceLogEntry) => void;
  mode?: BootstrapCommandMode;
};

function getBootstrapModeLabel(mode: BootstrapCommandMode): string {
  return mode === "background" ? "background bootstrap command" : "bootstrap command";
}

function getBootstrapOutputLabel(mode: BootstrapCommandMode): string {
  return mode === "background" ? "background bootstrap output" : "bootstrap output";
}

export async function runBootstrapCommands(options: RunBootstrapCommandsOptions): Promise<void> {
  const mode = options.mode ?? "sync";
  const commandLabel = getBootstrapModeLabel(mode);
  const outputLabel = getBootstrapOutputLabel(mode);

  for (const command of options.commands) {
    const bootstrapStart = process.hrtime.bigint();
    log(options.onLog, "info", `running ${commandLabel}`, { command, cwd: options.cwd });
    const bootstrapResult = await runShellCommand({
      command,
      cwd: options.cwd,
      signal: options.signal,
    });

    if (bootstrapResult.output.trim()) {
      log(options.onLog, "info", outputLabel, {
        command,
        output: bootstrapResult.output,
      });
    }

    if (bootstrapResult.exitCode !== 0) {
      log(options.onLog, "error", `${commandLabel} failed`, {
        command,
        output: bootstrapResult.output,
        durationMs: elapsedMs(bootstrapStart),
      });
      throw new Error(
        `${commandLabel} failed with exit code ${bootstrapResult.exitCode ?? "unknown"}`,
      );
    }

    log(options.onLog, "info", `${commandLabel} complete`, {
      command,
      durationMs: elapsedMs(bootstrapStart),
    });
  }
}

function isInsideWorkspace(workspacePath: string, sessionCwd: string): boolean {
  const relPath = relative(workspacePath, sessionCwd);
  return relPath === "" || (!relPath.startsWith(`..${sep}`) && relPath !== "..");
}

export function resolveWorkspacePath(options: {
  workspaceRoot: string;
  projectId: string;
  sessionId: string;
}): string {
  return join(resolve(options.workspaceRoot), options.projectId, options.sessionId);
}

function resolveRepositoryCachePath(options: { workspaceRoot: string; projectId: string }): string {
  return join(`${resolve(options.workspaceRoot)}-repo-cache`, `${options.projectId}.git`);
}

async function withRepositoryCacheLock<T>(cachePath: string, fn: () => Promise<T>): Promise<T> {
  const previous = repositoryCacheLocks.get(cachePath) ?? Promise.resolve();
  const current = previous.then(fn);
  const tracked = current
    .then(
      () => undefined,
      () => undefined,
    )
    .finally(() => {
      if (repositoryCacheLocks.get(cachePath) === tracked) {
        repositoryCacheLocks.delete(cachePath);
      }
    });

  repositoryCacheLocks.set(cachePath, tracked);

  return await current;
}

async function pathIsDirectory(path: string): Promise<boolean> {
  const stats = await stat(path).catch((error) => {
    if (getErrorCode(error) === "ENOENT") {
      return undefined;
    }

    throw error;
  });

  return stats?.isDirectory() ?? false;
}

async function runRepositoryCacheConfig(options: {
  cachePath: string;
  key: string;
  value: string;
  signal?: AbortSignal;
  onLog?: (entry: WorkspaceLogEntry) => void;
}): Promise<void> {
  const configResult = await runCommand({
    command: "git",
    commandArgs: ["-C", options.cachePath, "config", options.key, options.value],
    signal: options.signal,
  });

  if (configResult.exitCode !== 0) {
    log(options.onLog, "error", "repository cache config failed", { output: configResult.output });
    throw new Error(
      `repository cache config failed with exit code ${configResult.exitCode ?? "unknown"}`,
    );
  }
}

async function configureRepositoryCache(options: {
  cachePath: string;
  repo?: string;
  signal?: AbortSignal;
  onLog?: (entry: WorkspaceLogEntry) => void;
}): Promise<void> {
  await runRepositoryCacheConfig({
    cachePath: options.cachePath,
    key: "gc.auto",
    value: "0",
    signal: options.signal,
    onLog: options.onLog,
  });

  if (options.repo !== undefined) {
    await runRepositoryCacheConfig({
      cachePath: options.cachePath,
      key: "tau.repo",
      value: options.repo,
      signal: options.signal,
      onLog: options.onLog,
    });
  }
}

async function initializeRepositoryCache(options: {
  repo: string;
  cachePath: string;
  signal?: AbortSignal;
  onLog?: (entry: WorkspaceLogEntry) => void;
}): Promise<void> {
  await rm(options.cachePath, { recursive: true, force: true });
  await mkdir(dirname(options.cachePath), { recursive: true });

  log(options.onLog, "info", "initializing repository cache", {
    repo: options.repo,
    cachePath: options.cachePath,
  });

  const cloneStart = process.hrtime.bigint();
  const cloneResult = await runCommand({
    command: "gh",
    commandArgs: ["repo", "clone", options.repo, options.cachePath, "--", "--bare"],
    signal: options.signal,
  });

  if (cloneResult.exitCode !== 0) {
    log(options.onLog, "error", "repository cache clone failed", { output: cloneResult.output });
    await rm(options.cachePath, { recursive: true, force: true });
    throw new Error(
      `repository cache clone failed with exit code ${cloneResult.exitCode ?? "unknown"}`,
    );
  }

  if (cloneResult.output.trim()) {
    log(options.onLog, "info", "repository cache clone output", { output: cloneResult.output });
  }

  await configureRepositoryCache({
    cachePath: options.cachePath,
    repo: options.repo,
    signal: options.signal,
    onLog: options.onLog,
  });

  log(options.onLog, "info", "repository cache initialized", {
    cachePath: options.cachePath,
    durationMs: elapsedMs(cloneStart),
  });
}

async function fetchRepositoryCache(options: {
  cachePath: string;
  signal?: AbortSignal;
  onLog?: (entry: WorkspaceLogEntry) => void;
}): Promise<void> {
  await configureRepositoryCache(options);

  log(options.onLog, "info", "fetching repository cache", { cachePath: options.cachePath });

  const fetchStart = process.hrtime.bigint();
  const fetchResult = await runCommand({
    command: "git",
    commandArgs: [
      "-C",
      options.cachePath,
      "fetch",
      "--prune",
      "origin",
      "+refs/heads/*:refs/heads/*",
    ],
    signal: options.signal,
  });

  if (fetchResult.exitCode !== 0) {
    log(options.onLog, "error", "repository cache fetch failed", { output: fetchResult.output });
    throw new Error(
      `repository cache fetch failed with exit code ${fetchResult.exitCode ?? "unknown"}`,
    );
  }

  if (fetchResult.output.trim()) {
    log(options.onLog, "info", "repository cache fetch output", { output: fetchResult.output });
  }

  log(options.onLog, "info", "repository cache updated", {
    cachePath: options.cachePath,
    durationMs: elapsedMs(fetchStart),
  });
}

async function prepareRepositoryCache(options: {
  workspaceRoot: string;
  projectId: string;
  repo: string;
  signal?: AbortSignal;
  onLog?: (entry: WorkspaceLogEntry) => void;
}): Promise<string> {
  const cachePath = resolveRepositoryCachePath({
    workspaceRoot: options.workspaceRoot,
    projectId: options.projectId,
  });

  return await withRepositoryCacheLock(cachePath, async () => {
    if (await pathIsDirectory(cachePath)) {
      const cachedRepo = await getRepositoryCacheConfig({
        cachePath,
        key: "tau.repo",
        signal: options.signal,
      });

      if (cachedRepo === options.repo) {
        await fetchRepositoryCache({
          cachePath,
          signal: options.signal,
          onLog: options.onLog,
        });
      } else {
        log(options.onLog, "info", "repository cache repo mismatch", {
          repo: options.repo,
          cachePath,
          ...(cachedRepo ? { cachedRepo } : {}),
        });
        await initializeRepositoryCache({
          repo: options.repo,
          cachePath,
          signal: options.signal,
          onLog: options.onLog,
        });
      }
    } else {
      await initializeRepositoryCache({
        repo: options.repo,
        cachePath,
        signal: options.signal,
        onLog: options.onLog,
      });
    }

    return cachePath;
  });
}

async function getRepositoryCacheConfig(options: {
  cachePath: string;
  key: string;
  signal?: AbortSignal;
}): Promise<string | undefined> {
  const configResult = await runCommand({
    command: "git",
    commandArgs: ["-C", options.cachePath, "config", "--get", options.key],
    signal: options.signal,
  });

  if (configResult.exitCode !== 0) {
    return undefined;
  }

  return configResult.output.trim() || undefined;
}

async function getRepositoryCacheRemoteUrl(options: {
  cachePath: string;
  signal?: AbortSignal;
  onLog?: (entry: WorkspaceLogEntry) => void;
}): Promise<string> {
  const remoteResult = await runCommand({
    command: "git",
    commandArgs: ["-C", options.cachePath, "remote", "get-url", "origin"],
    signal: options.signal,
  });

  if (remoteResult.exitCode !== 0) {
    log(options.onLog, "error", "repository cache remote lookup failed", {
      output: remoteResult.output,
    });
    throw new Error(
      `repository cache remote lookup failed with exit code ${remoteResult.exitCode ?? "unknown"}`,
    );
  }

  const remoteUrl = remoteResult.output.trim();
  if (!remoteUrl) {
    throw new Error("repository cache origin remote is empty");
  }

  return remoteUrl;
}

async function cloneRepositoryFromCache(options: {
  cachePath: string;
  workspacePath: string;
  signal?: AbortSignal;
  onLog?: (entry: WorkspaceLogEntry) => void;
}): Promise<void> {
  const cloneStart = process.hrtime.bigint();
  const remoteUrl = await getRepositoryCacheRemoteUrl({
    cachePath: options.cachePath,
    signal: options.signal,
    onLog: options.onLog,
  });

  log(options.onLog, "info", "cloning repository from cache", {
    cachePath: options.cachePath,
    workspacePath: options.workspacePath,
  });

  const cloneResult = await runCommand({
    command: "git",
    commandArgs: ["clone", "--shared", options.cachePath, options.workspacePath],
    signal: options.signal,
  });

  if (cloneResult.exitCode !== 0) {
    log(options.onLog, "error", "repository clone from cache failed", {
      output: cloneResult.output,
    });
    throw new Error(
      `repository clone from cache failed with exit code ${cloneResult.exitCode ?? "unknown"}`,
    );
  }

  if (cloneResult.output.trim()) {
    log(options.onLog, "info", "repository clone output", { output: cloneResult.output });
  }

  const setRemoteResult = await runCommand({
    command: "git",
    commandArgs: ["-C", options.workspacePath, "remote", "set-url", "origin", remoteUrl],
    signal: options.signal,
  });

  if (setRemoteResult.exitCode !== 0) {
    log(options.onLog, "error", "repository remote update failed", {
      output: setRemoteResult.output,
    });
    throw new Error(
      `repository remote update failed with exit code ${setRemoteResult.exitCode ?? "unknown"}`,
    );
  }

  log(options.onLog, "info", "repository clone complete", {
    cachePath: options.cachePath,
    durationMs: elapsedMs(cloneStart),
  });
}

async function pruneWorkspaceDirectory(
  directoryPath: string,
  preservedWorkspacePaths: string[],
  result: WorkspaceRootCleanupResult,
): Promise<void> {
  const entries = await readdir(directoryPath, { withFileTypes: true }).catch((error) => {
    if (getErrorCode(error) === "ENOENT") {
      return undefined;
    }
    result.failures.push({
      path: directoryPath,
      cause: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  });
  if (!entries) {
    return;
  }

  for (const entry of entries) {
    const entryPath = join(directoryPath, entry.name);
    const matchingPaths = preservedWorkspacePaths.filter((workspacePath) =>
      isInsideWorkspace(entryPath, workspacePath),
    );
    if (matchingPaths.includes(entryPath)) {
      continue;
    }
    if (matchingPaths.length > 0) {
      if (entry.isDirectory()) {
        await pruneWorkspaceDirectory(entryPath, matchingPaths, result);
      } else {
        result.failures.push({
          path: entryPath,
          cause: "expected a directory containing a preserved workspace",
        });
      }
      continue;
    }

    try {
      await cleanupWorkspacePath(entryPath);
      result.deletedEntries += 1;
    } catch (error) {
      result.failures.push({
        path: entryPath,
        cause: error instanceof Error ? error.message : String(error),
      });
    }
  }
}

export async function cleanupWorkspaceRootsOnStartup(
  workspaceRoots: string[],
  preservedWorkspacePaths: string[],
): Promise<WorkspaceRootCleanupResult[]> {
  const roots = Array.from(new Set(workspaceRoots.map((workspaceRoot) => resolve(workspaceRoot))));
  const preservedPaths = Array.from(
    new Set(preservedWorkspacePaths.map((workspacePath) => resolve(workspacePath))),
  );
  const results: WorkspaceRootCleanupResult[] = [];

  for (const workspaceRoot of roots) {
    const result: WorkspaceRootCleanupResult = {
      workspaceRoot,
      deletedEntries: 0,
      failures: [],
    };
    if (preservedPaths.includes(workspaceRoot)) {
      results.push(result);
      continue;
    }
    const preservedUnderRoot = preservedPaths.filter((workspacePath) =>
      isInsideWorkspace(workspaceRoot, workspacePath),
    );
    await pruneWorkspaceDirectory(workspaceRoot, preservedUnderRoot, result);
    results.push(result);
  }

  return results;
}

export async function cleanupWorkspacePath(workspacePath: string): Promise<void> {
  await rm(workspacePath, { recursive: true, force: true });
}

function isRepositoryProject(
  project: TelegramProjectConfig,
): project is TelegramRepositoryProjectConfig {
  return "repo" in project;
}

async function prepareRepositoryWorkspace(options: {
  workspacePath: string;
  cacheWorkspaceRoot: string;
  projectId: string;
  project: TelegramRepositoryProjectConfig;
  signal?: AbortSignal;
  onLog?: (entry: WorkspaceLogEntry) => void;
}): Promise<string> {
  const cachePath = await prepareRepositoryCache({
    workspaceRoot: options.cacheWorkspaceRoot,
    projectId: options.projectId,
    repo: options.project.repo,
    signal: options.signal,
    onLog: options.onLog,
  });

  await cloneRepositoryFromCache({
    cachePath,
    workspacePath: options.workspacePath,
    signal: options.signal,
    onLog: options.onLog,
  });

  if (options.project.ref) {
    const checkoutStart = process.hrtime.bigint();
    log(options.onLog, "info", "checking out ref", {
      projectId: options.projectId,
      ref: options.project.ref,
    });
    const checkoutResult = await runCommand({
      command: "git",
      commandArgs: ["-C", options.workspacePath, "checkout", options.project.ref],
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
      projectId: options.projectId,
      ref: options.project.ref,
      durationMs: elapsedMs(checkoutStart),
    });
  }

  let projectCwd = options.workspacePath;
  if (options.project.workingDirectory) {
    const configuredPath = options.project.workingDirectory;
    const resolvedPath = resolve(options.workspacePath, configuredPath);

    if (!isInsideWorkspace(options.workspacePath, resolvedPath)) {
      log(options.onLog, "error", "project working directory escapes workspace", {
        projectId: options.projectId,
        workingDirectory: configuredPath,
        projectCwd: resolvedPath,
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

    projectCwd = resolvedPath;
    log(options.onLog, "info", "using project working directory", {
      projectId: options.projectId,
      workingDirectory: configuredPath,
      projectCwd,
    });
  }

  await runBootstrapCommands({
    commands: options.project.bootstrapCommands ?? [],
    cwd: projectCwd,
    signal: options.signal,
    onLog: options.onLog,
    mode: "sync",
  });

  return projectCwd;
}

async function pathIsFile(path: string): Promise<boolean> {
  const stats = await stat(path).catch((error) => {
    if (getErrorCode(error) === "ENOENT") {
      return undefined;
    }
    throw error;
  });
  return stats?.isFile() ?? false;
}

async function collectMemberAgentContextFiles(options: {
  workspacePath: string;
  memberProjectId: string;
  project: TelegramRepositoryProjectConfig;
}): Promise<string[]> {
  const memberPath = join(options.workspacePath, options.memberProjectId);
  const candidates = [join(memberPath, "AGENTS.md")];
  let currentPath = memberPath;

  for (const segment of options.project.workingDirectory?.split(/[\\/]/).filter(Boolean) ?? []) {
    currentPath = join(currentPath, segment);
    candidates.push(join(currentPath, "AGENTS.md"));
  }

  const contextFiles: string[] = [];
  for (const candidate of candidates) {
    if (await pathIsFile(candidate)) {
      contextFiles.push(relative(options.workspacePath, candidate));
    }
  }
  return contextFiles;
}

function formatCompositeAgentsFile(options: {
  project: Extract<TelegramProjectConfig, { projectIds: string[] }>;
  projects: Record<string, TelegramProjectConfig>;
}): string {
  const lines = [
    "# Multi-repository workspace",
    "",
    "This workspace contains multiple independent Git repositories:",
    "",
  ];

  for (const memberProjectId of options.project.projectIds) {
    const memberProject = options.projects[memberProjectId];
    if (!memberProject || !isRepositoryProject(memberProject)) {
      throw new Error(`composite project references invalid member '${memberProjectId}'`);
    }

    const details = [
      `repository \`${memberProject.repo}\``,
      memberProject.ref ? `ref \`${memberProject.ref}\`` : "its default branch",
      memberProject.description,
      memberProject.workingDirectory
        ? `working directory \`${memberProject.workingDirectory}\``
        : undefined,
    ].filter((detail): detail is string => detail !== undefined);
    lines.push(`- \`${memberProjectId}/\`: ${details.join(", ")}`);
  }

  lines.push(
    "",
    "Each child directory is an independent Git repository. Instructions from AGENTS.md files inside each repository apply to work in that repository's subtree.",
  );

  if (options.project.instructions) {
    lines.push("", "## Workspace instructions", "", options.project.instructions);
  }

  return `${lines.join("\n")}\n`;
}

async function writeCompositeWorkspaceFiles(options: {
  workspacePath: string;
  project: Extract<TelegramProjectConfig, { projectIds: string[] }>;
  projects: Record<string, TelegramProjectConfig>;
}): Promise<void> {
  const agentContextFiles: string[] = [];
  for (const memberProjectId of options.project.projectIds) {
    const memberProject = options.projects[memberProjectId];
    if (!memberProject || !isRepositoryProject(memberProject)) {
      throw new Error(`composite project references invalid member '${memberProjectId}'`);
    }
    agentContextFiles.push(
      ...(await collectMemberAgentContextFiles({
        workspacePath: options.workspacePath,
        memberProjectId,
        project: memberProject,
      })),
    );
  }

  await mkdir(join(options.workspacePath, ".tau"), { recursive: true });
  await Promise.all([
    writeFile(join(options.workspacePath, "AGENTS.md"), formatCompositeAgentsFile(options), "utf8"),
    writeFile(
      join(options.workspacePath, ".tau", "config.json"),
      `${JSON.stringify({ agentContextFiles }, null, 2)}\n`,
      "utf8",
    ),
  ]);
}

export async function prepareWorkspace(
  options: PrepareWorkspaceOptions,
): Promise<PreparedWorkspace> {
  const workspaceStart = process.hrtime.bigint();
  const workspacePath = resolveWorkspacePath({
    workspaceRoot: options.workspaceRoot,
    projectId: options.projectId,
    sessionId: options.sessionId,
  });

  await rm(workspacePath, { recursive: true, force: true });
  await mkdir(dirname(workspacePath), { recursive: true });

  try {
    if (isRepositoryProject(options.project)) {
      const sessionCwd = await prepareRepositoryWorkspace({
        workspacePath,
        cacheWorkspaceRoot: options.workspaceRoot,
        projectId: options.projectId,
        project: options.project,
        signal: options.signal,
        onLog: options.onLog,
      });

      log(options.onLog, "info", "workspace prepared", {
        workspacePath,
        sessionCwd,
        durationMs: elapsedMs(workspaceStart),
      });
      return { workspacePath, sessionCwd };
    }

    await mkdir(workspacePath, { recursive: true });
    const memberBackgroundBootstrapCommands: NonNullable<
      PreparedWorkspace["memberBackgroundBootstrapCommands"]
    > = [];

    for (const memberProjectId of options.project.projectIds) {
      const memberProject = options.projects[memberProjectId];
      if (!memberProject || !isRepositoryProject(memberProject)) {
        throw new Error(`composite project references invalid member '${memberProjectId}'`);
      }

      const memberCwd = await prepareRepositoryWorkspace({
        workspacePath: join(workspacePath, memberProjectId),
        cacheWorkspaceRoot: memberProject.workspaceRoot ?? options.defaultWorkspaceRoot,
        projectId: memberProjectId,
        project: memberProject,
        signal: options.signal,
        onLog: options.onLog,
      });
      if (memberProject.backgroundBootstrapCommands) {
        memberBackgroundBootstrapCommands.push({
          commands: memberProject.backgroundBootstrapCommands,
          cwd: memberCwd,
        });
      }
    }

    await writeCompositeWorkspaceFiles({
      workspacePath,
      project: options.project,
      projects: options.projects,
    });
    await runBootstrapCommands({
      commands: options.project.bootstrapCommands ?? [],
      cwd: workspacePath,
      signal: options.signal,
      onLog: options.onLog,
      mode: "sync",
    });

    log(options.onLog, "info", "workspace prepared", {
      workspacePath,
      sessionCwd: workspacePath,
      durationMs: elapsedMs(workspaceStart),
    });
    return {
      workspacePath,
      sessionCwd: workspacePath,
      ...(memberBackgroundBootstrapCommands.length > 0
        ? { memberBackgroundBootstrapCommands }
        : {}),
    };
  } catch (error) {
    await rm(workspacePath, { recursive: true, force: true });
    throw error;
  }
}
