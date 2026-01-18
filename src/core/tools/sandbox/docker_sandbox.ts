import { randomUUID } from "node:crypto";
import { realpathSync } from "node:fs";
import type { SandboxConfig } from "../../config/index.js";
import type { CoreDeps } from "../../runtime/deps.js";
import { getGitRoot } from "../../utils/git.js";
import { normalizeSandboxMountPath, resolveSandboxWorkdir } from "../../utils/sandbox_paths.js";
import { sanitizeEnvironment } from "../../utils/sanitize_env.js";
import type { SpawnCaptureResult } from "../../utils/spawn_capture.js";

const DEFAULT_MOUNT_PATH = "/workspace";
const DEFAULT_PRUNE_AFTER_HOURS = 72;
const DOCKER_MAX_CAPTURE_BYTES = 512 * 1024;

const SANDBOX_LABEL = "tau.sandbox";
const SESSION_LABEL = "tau.session_id";
const STARTED_AT_LABEL = "tau.started_at";
const CWD_LABEL = "tau.cwd";
const ROOT_LABEL = "tau.root";

type NormalizedSandboxConfig = {
  image: string;
  mountPath: string;
  pruneAfterHours: number;
  extraDockerArgs: string[];
  environmentInfo?: string;
};

export type DockerSandboxRuntime = {
  containerId: string;
  containerName: string;
  mountPath: string;
  workdir: string;
  rootReal: string;
};

export type DockerExecOptions = {
  cwd?: string;
  env?: Record<string, string>;
  signal?: AbortSignal;
  timeoutMs?: number;
  input?: string | Buffer;
  stdio?: ["ignore" | "pipe", "ignore" | "pipe", "ignore" | "pipe"];
  maxCaptureBytes?: number;
  maxCaptureMode?: "terminate" | "ignore";
  killGraceMs?: number;
};

export type DockerSandbox = {
  runtime: DockerSandboxRuntime;
  exec: (args: string[], options?: DockerExecOptions) => Promise<SpawnCaptureResult>;
  dispose: () => Promise<void>;
};

function normalizeSandboxConfig(config: SandboxConfig): NormalizedSandboxConfig {
  const image = config.image?.trim();
  if (!image) {
    throw new Error("sandbox.image is required when --sandbox is enabled.");
  }

  const mountPath = normalizeSandboxMountPath(config.mountPath ?? DEFAULT_MOUNT_PATH);
  if (!mountPath.startsWith("/")) {
    throw new Error("sandbox.mountPath must be an absolute unix path.");
  }

  const pruneAfterHours = config.pruneAfterHours ?? DEFAULT_PRUNE_AFTER_HOURS;
  if (!Number.isFinite(pruneAfterHours) || pruneAfterHours <= 0) {
    throw new Error("sandbox.pruneAfterHours must be a positive number.");
  }

  const extraDockerArgs = (config.extraDockerArgs ?? []).filter((arg) => arg.trim().length > 0);

  return {
    image,
    mountPath: mountPath.endsWith("/") && mountPath.length > 1 ? mountPath.slice(0, -1) : mountPath,
    pruneAfterHours,
    extraDockerArgs,
    environmentInfo: config.environmentInfo,
  };
}

async function runDocker(
  deps: CoreDeps,
  args: string[],
  options?: DockerExecOptions,
): Promise<SpawnCaptureResult> {
  const env = sanitizeEnvironment(deps.env.env());
  return deps.spawn("docker", args, {
    env,
    signal: options?.signal,
    timeoutMs: options?.timeoutMs,
    maxCaptureBytes: options?.maxCaptureBytes,
    maxCaptureMode: options?.maxCaptureMode,
    killGraceMs: options?.killGraceMs,
    stdio: options?.stdio,
    input: options?.input,
  });
}

async function ensureDockerAvailable(deps: CoreDeps): Promise<void> {
  const result = await runDocker(deps, ["version", "--format", "{{.Server.Version}}"]);
  if (result.exitCode !== 0) {
    const message = result.stderr.trim() || "docker is unavailable or not running.";
    throw new Error(`sandbox requires docker: ${message}`);
  }
}

async function pruneStaleContainers(deps: CoreDeps, cutoffMs: number): Promise<void> {
  const result = await runDocker(
    deps,
    [
      "ps",
      "-a",
      "--filter",
      `label=${SANDBOX_LABEL}=true`,
      "--format",
      `{{.ID}}\t{{.Label "${STARTED_AT_LABEL}"}}`,
    ],
    { maxCaptureBytes: DOCKER_MAX_CAPTURE_BYTES },
  );

  if (result.exitCode !== 0) {
    const message = result.stderr.trim() || "failed to list sandbox containers.";
    throw new Error(`sandbox prune failed: ${message}`);
  }

  const lines = result.stdout.trim().split("\n").filter(Boolean);
  for (const line of lines) {
    const [id, startedAtRaw] = line.split("\t");
    if (!id) continue;
    const startedAt = Number.parseInt((startedAtRaw ?? "").trim(), 10);
    if (!Number.isFinite(startedAt) || startedAt <= cutoffMs) {
      await runDocker(deps, ["rm", "-f", id], { maxCaptureBytes: DOCKER_MAX_CAPTURE_BYTES }).catch(
        () => {},
      );
    }
  }
}

function resolveSandboxPaths(
  cwd: string,
  mountPath: string,
): { rootReal: string; workdir: string } {
  const root = getGitRoot(cwd) ?? cwd;
  const rootReal = realpathSync(root);
  const cwdReal = realpathSync(cwd);
  const workdir = resolveSandboxWorkdir({ cwdReal, rootReal, mountPath });

  return { rootReal, workdir };
}

async function preflightImage(deps: CoreDeps, containerId: string): Promise<void> {
  const required = ["sh", "cat", "ls", "rg", "tee", "mkdir", "tail", "find"];
  const check = [
    ...required.map((cmd) => `command -v ${cmd} >/dev/null 2>&1`),
    "find . -maxdepth 0 -printf '' >/dev/null 2>&1",
  ].join(" && ");
  const result = await runDocker(deps, ["exec", containerId, "sh", "-lc", check]);
  if (result.exitCode !== 0) {
    throw new Error(
      `sandbox image missing required commands (or find -printf support): ${required.join(", ")}. ${result.stderr.trim()}`,
    );
  }
}

export async function createDockerSandbox(args: {
  config: SandboxConfig;
  deps: CoreDeps;
  cwd?: string;
}): Promise<DockerSandbox> {
  const normalized = normalizeSandboxConfig(args.config);
  const cwd = args.cwd ?? args.deps.env.cwd();
  const { rootReal, workdir } = resolveSandboxPaths(cwd, normalized.mountPath);
  const deps = args.deps;

  await ensureDockerAvailable(deps);
  const cutoffMs = deps.clock.now() - normalized.pruneAfterHours * 60 * 60 * 1000;
  await pruneStaleContainers(deps, cutoffMs);

  const startedAt = deps.clock.now();
  const sessionId = randomUUID();
  const containerName = `tau-sandbox-${sessionId}`;

  const runArgs = [
    "run",
    "-d",
    "--name",
    containerName,
    "--label",
    `${SANDBOX_LABEL}=true`,
    "--label",
    `${SESSION_LABEL}=${sessionId}`,
    "--label",
    `${STARTED_AT_LABEL}=${startedAt}`,
    "--label",
    `${CWD_LABEL}=${cwd}`,
    "--label",
    `${ROOT_LABEL}=${rootReal}`,
    "--mount",
    `type=bind,source=${rootReal},target=${normalized.mountPath}`,
    "--workdir",
    workdir,
    ...normalized.extraDockerArgs,
    normalized.image,
    "sh",
    "-lc",
    "tail -f /dev/null",
  ];

  const result = await runDocker(deps, runArgs, { maxCaptureBytes: DOCKER_MAX_CAPTURE_BYTES });
  if (result.exitCode !== 0) {
    throw new Error(`sandbox failed to start: ${result.stderr.trim() || result.stdout.trim()}`);
  }

  const containerId = result.stdout.trim().split("\n").filter(Boolean)[0];
  if (!containerId) {
    throw new Error("sandbox failed to start: could not determine container id.");
  }

  try {
    await preflightImage(deps, containerId);
  } catch (err) {
    await runDocker(deps, ["rm", "-f", containerId], {
      maxCaptureBytes: DOCKER_MAX_CAPTURE_BYTES,
    }).catch(() => {});
    throw err;
  }

  const runtime: DockerSandboxRuntime = {
    containerId,
    containerName,
    mountPath: normalized.mountPath,
    workdir,
    rootReal,
  };

  const exec = async (
    execArgs: string[],
    options: DockerExecOptions = {},
  ): Promise<SpawnCaptureResult> => {
    const args: string[] = ["exec"];
    if (options.input !== undefined) {
      args.push("-i");
    }
    if (options.cwd) {
      args.push("-w", options.cwd);
    }
    if (options.env) {
      for (const [key, value] of Object.entries(options.env)) {
        args.push("-e", `${key}=${value}`);
      }
    }
    args.push(containerId, ...execArgs);
    return runDocker(deps, args, options);
  };

  const dispose = async (): Promise<void> => {
    await runDocker(deps, ["rm", "-f", containerId], {
      maxCaptureBytes: DOCKER_MAX_CAPTURE_BYTES,
    }).catch(() => {});
  };

  return { runtime, exec, dispose };
}
