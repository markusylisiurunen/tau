import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, posix as pathPosix, sep as pathSep } from "node:path";
import type { SandboxConfig } from "../config/index.js";
import type { CoreDeps } from "../runtime/deps.js";
import { createDefaultCoreDeps } from "../runtime/deps.js";
import {
  resolveRestrictedDirPath,
  resolveRestrictedFilePath,
  resolveRestrictedPath,
} from "../utils/restricted_fs.js";
import { sanitizeEnvironment } from "../utils/sanitize_env.js";
import { spawnWithCapture } from "../utils/spawn_capture.js";
import { truncateToBytesFromStart } from "../utils/truncate.js";
import { createDockerSandbox } from "./sandbox/docker_sandbox.js";

const BASH_MAX_CAPTURE_BYTES = 2 * 1024 * 1024; // 2MB
const BASH_KILL_GRACE_MS = 2_000;

const GREP_MAX_CAPTURE_BYTES = 2 * 1024 * 1024;
const GREP_KILL_GRACE_MS = 2_000;

export type BashExecutionResult = {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  truncated: boolean;
};

export type ReadFileResult = {
  path: string;
  content: string;
};

export type WriteFileResult = {
  path: string;
  bytes: number;
  lines: number;
};

export type ListDirEntry = {
  name: string;
  isDirectory: boolean;
  isSymlink: boolean;
};

export type ListDirResult = {
  path: string;
  entries: ListDirEntry[];
};

export type GrepExecutionResult = {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  captureTruncated: boolean;
  resolvedPaths: string[];
};

export interface ToolExecutionBackend {
  kind: "local" | "sandbox";
  runBash(
    command: string,
    options?: { timeoutMs?: number; signal?: AbortSignal; cwd?: string },
  ): Promise<BashExecutionResult>;
  readFile(path: string, options?: { restricted?: boolean }): Promise<ReadFileResult>;
  writeFile(path: string, content: string): Promise<WriteFileResult>;
  editFile(path: string, patch: { oldText: string; newText: string }): Promise<void>;
  listDir(path: string): Promise<ListDirResult>;
  grep(options: {
    baseArgs: string[];
    pattern: string;
    paths: string[];
    signal?: AbortSignal;
    timeoutMs: number;
    dryRun?: boolean;
  }): Promise<GrepExecutionResult>;
}

export type SandboxToolExecutionBackend = {
  backend: ToolExecutionBackend;
  dispose: () => Promise<void>;
};

type LocalBackendDeps = Pick<CoreDeps, "spawn" | "env">;

export function createLocalToolExecutionBackend(
  deps?: Partial<LocalBackendDeps>,
): ToolExecutionBackend {
  const envProvider = deps?.env?.env ?? (() => process.env);
  const cwdProvider = deps?.env?.cwd ?? (() => process.cwd());
  const spawnCapture = deps?.spawn ?? spawnWithCapture;

  return {
    kind: "local",
    async runBash(command, options = {}) {
      const timeoutMs = options.timeoutMs;
      const signal = options.signal;
      const cwd = options.cwd;

      const effectiveTimeoutMs =
        typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0
          ? timeoutMs
          : undefined;

      const result = await spawnCapture(command, [], {
        shell: true,
        stdio: ["ignore", "pipe", "pipe"],
        env: {
          ...sanitizeEnvironment(envProvider()),
          GIT_TERMINAL_PROMPT: "0",
          GIT_EDITOR: "true",
          GIT_SEQUENCE_EDITOR: "true",
          GIT_PAGER: "cat",
          GIT_ASKPASS: "true",
          GIT_SSH_COMMAND: "ssh -o BatchMode=yes",
        },
        detached: true,
        killProcessGroup: true,
        cwd,
        signal,
        timeoutMs: effectiveTimeoutMs,
        maxCaptureBytes: BASH_MAX_CAPTURE_BYTES,
        maxCaptureMode: "ignore",
        killGraceMs: BASH_KILL_GRACE_MS,
      });

      let stdout = result.stdout;
      let stderr = result.stderr;
      let truncated = result.captureLimitExceeded;

      if (result.captureLimitExceeded) {
        stdout = truncateToBytesFromStart(stdout, BASH_MAX_CAPTURE_BYTES / 2);
        stderr = truncateToBytesFromStart(stderr, BASH_MAX_CAPTURE_BYTES / 2);
      }

      let terminationNote: string | undefined;
      if (result.timedOut && effectiveTimeoutMs !== undefined) {
        terminationNote = `(tau) timed out after ${effectiveTimeoutMs}ms`;
      } else if (result.aborted) {
        terminationNote = "(tau) aborted";
      } else if (result.closeSignal) {
        terminationNote = `(tau) terminated by signal ${result.closeSignal}`;
      }

      const note = terminationNote?.trim();
      if (note && !stdout.includes(note) && !stderr.includes(note)) {
        const noteText = `${stderr && !stderr.endsWith("\n") ? "\n" : ""}${note}\n`;
        const noteBytes = Buffer.byteLength(noteText, "utf-8");
        const currentBytes =
          Buffer.byteLength(stdout, "utf-8") + Buffer.byteLength(stderr, "utf-8");

        if (currentBytes + noteBytes > BASH_MAX_CAPTURE_BYTES) {
          truncated = true;
          const remaining = Math.max(0, BASH_MAX_CAPTURE_BYTES - noteBytes);
          const stdoutBudget = Math.floor(remaining / 2);
          const stderrBudget = remaining - stdoutBudget;
          stdout = truncateToBytesFromStart(stdout, stdoutBudget);
          stderr = truncateToBytesFromStart(stderr, stderrBudget);
        }

        stderr += noteText;
      }

      return { stdout, stderr, exitCode: result.exitCode, truncated };
    },

    async readFile(path, options) {
      const restricted = options?.restricted ?? true;
      if (restricted) {
        const resolved = resolveRestrictedFilePath(path);
        const content = readFileSync(resolved.realPath, "utf-8");
        return { path: resolved.relPath, content };
      }

      const content = readFileSync(path, "utf-8");
      return { path, content };
    },

    async writeFile(path, content) {
      const dir = dirname(path);
      if (dir && dir !== ".") {
        mkdirSync(dir, { recursive: true });
      }

      writeFileSync(path, content, "utf-8");

      const bytes = Buffer.byteLength(content, "utf-8");
      const lines = content.split("\n").length;
      return { path, bytes, lines };
    },

    async editFile(path, patch) {
      const content = readFileSync(path, "utf-8");
      const nextContent = content.replace(patch.oldText, patch.newText);
      writeFileSync(path, nextContent, "utf-8");
    },

    async listDir(path) {
      const resolved = resolveRestrictedDirPath(path);
      const dirents = readdirSync(resolved.realPath, { withFileTypes: true });
      const entries = dirents.map((d) => ({
        name: d.name,
        isDirectory: d.isDirectory(),
        isSymlink: d.isSymbolicLink(),
      }));
      return { path: resolved.relPath, entries };
    },

    async grep(options) {
      const { baseArgs, pattern, paths, signal, timeoutMs, dryRun } = options;

      const resolvedPaths: string[] = [];
      let rootReal = cwdProvider();

      for (const p of paths) {
        const resolved = resolveRestrictedPath(p, { mustExist: true });
        rootReal = resolved.rootReal;
        resolvedPaths.push(resolved.relPath);
      }

      const fullArgs = [...baseArgs, "--", pattern, ...resolvedPaths];

      if (dryRun) {
        return {
          stdout: "",
          stderr: "",
          exitCode: 0,
          captureTruncated: false,
          resolvedPaths,
        };
      }

      try {
        const result = await spawnCapture("rg", fullArgs, {
          cwd: rootReal,
          windowsHide: true,
          signal,
          timeoutMs,
          maxCaptureBytes: GREP_MAX_CAPTURE_BYTES,
          killGraceMs: GREP_KILL_GRACE_MS,
        });

        return {
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode,
          captureTruncated: result.captureLimitExceeded || result.timedOut,
          resolvedPaths,
        };
      } catch (err) {
        return {
          stdout: "",
          stderr: err instanceof Error ? err.message : String(err),
          exitCode: 2,
          captureTruncated: false,
          resolvedPaths,
        };
      }
    },
  };
}

type SandboxBackendDeps = Pick<CoreDeps, "spawn" | "env" | "clock">;

function toPosixRelPath(value: string): string {
  if (!value || value === ".") return ".";
  return value.split(pathSep).join(pathPosix.sep);
}

export async function createSandboxToolExecutionBackend(options: {
  config: SandboxConfig;
  deps?: Partial<SandboxBackendDeps>;
  cwd?: string;
}): Promise<SandboxToolExecutionBackend> {
  const baseDeps = createDefaultCoreDeps();
  const deps: CoreDeps = {
    ...baseDeps,
    spawn: options.deps?.spawn ?? baseDeps.spawn,
    env: options.deps?.env ?? baseDeps.env,
    clock: options.deps?.clock ?? baseDeps.clock,
  };

  const sandbox = await createDockerSandbox({ config: options.config, deps, cwd: options.cwd });

  const mapToContainerPath = (relPath: string): string => {
    const relPosix = toPosixRelPath(relPath);
    if (!relPosix || relPosix === ".") {
      return sandbox.runtime.mountPath;
    }
    return pathPosix.join(sandbox.runtime.mountPath, relPosix);
  };

  const backend: ToolExecutionBackend = {
    kind: "sandbox",
    async runBash(command, options = {}) {
      const timeoutMs = options.timeoutMs;
      const signal = options.signal;
      const cwd = options.cwd;

      const effectiveTimeoutMs =
        typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0
          ? timeoutMs
          : undefined;

      const trimmedCwd = cwd?.trim();
      const execCwd = trimmedCwd
        ? sandbox.mapPath(trimmedCwd, { mustExist: true, kind: "dir" }).containerPath
        : sandbox.runtime.workdir;

      const result = await sandbox.exec(["sh", "-lc", command], {
        cwd: execCwd,
        signal,
        timeoutMs: effectiveTimeoutMs,
        maxCaptureBytes: BASH_MAX_CAPTURE_BYTES,
        maxCaptureMode: "ignore",
        killGraceMs: BASH_KILL_GRACE_MS,
        env: {
          GIT_TERMINAL_PROMPT: "0",
          GIT_EDITOR: "true",
          GIT_SEQUENCE_EDITOR: "true",
          GIT_PAGER: "cat",
          GIT_ASKPASS: "true",
          GIT_SSH_COMMAND: "ssh -o BatchMode=yes",
        },
      });

      let stdout = result.stdout;
      let stderr = result.stderr;
      let truncated = result.captureLimitExceeded;

      if (result.captureLimitExceeded) {
        stdout = truncateToBytesFromStart(stdout, BASH_MAX_CAPTURE_BYTES / 2);
        stderr = truncateToBytesFromStart(stderr, BASH_MAX_CAPTURE_BYTES / 2);
      }

      let terminationNote: string | undefined;
      if (result.timedOut && effectiveTimeoutMs !== undefined) {
        terminationNote = `(tau) timed out after ${effectiveTimeoutMs}ms`;
      } else if (result.aborted) {
        terminationNote = "(tau) aborted";
      } else if (result.closeSignal) {
        terminationNote = `(tau) terminated by signal ${result.closeSignal}`;
      }

      const note = terminationNote?.trim();
      if (note && !stdout.includes(note) && !stderr.includes(note)) {
        const noteText = `${stderr && !stderr.endsWith("\n") ? "\n" : ""}${note}\n`;
        const noteBytes = Buffer.byteLength(noteText, "utf-8");
        const currentBytes =
          Buffer.byteLength(stdout, "utf-8") + Buffer.byteLength(stderr, "utf-8");

        if (currentBytes + noteBytes > BASH_MAX_CAPTURE_BYTES) {
          truncated = true;
          const remaining = Math.max(0, BASH_MAX_CAPTURE_BYTES - noteBytes);
          const stdoutBudget = Math.floor(remaining / 2);
          const stderrBudget = remaining - stdoutBudget;
          stdout = truncateToBytesFromStart(stdout, stdoutBudget);
          stderr = truncateToBytesFromStart(stderr, stderrBudget);
        }

        stderr += noteText;
      }

      return { stdout, stderr, exitCode: result.exitCode, truncated };
    },

    async readFile(path, _options) {
      const resolved = sandbox.mapPath(path, { mustExist: true, kind: "file" });
      const result = await sandbox.exec(["cat", "--", resolved.containerPath]);

      if (result.exitCode !== 0) {
        const message = result.stderr.trim() || "failed to read file.";
        throw new Error(message);
      }

      return { path: resolved.relPath, content: result.stdout };
    },

    async writeFile(path, content) {
      const resolved = sandbox.mapPath(path);
      const dir = pathPosix.dirname(resolved.containerPath);
      if (dir && dir !== ".") {
        const mkdir = await sandbox.exec(["mkdir", "-p", dir]);
        if (mkdir.exitCode !== 0) {
          const message = mkdir.stderr.trim() || "failed to create directory.";
          throw new Error(message);
        }
      }

      const write = await sandbox.exec(["tee", resolved.containerPath], {
        input: content,
        stdio: ["pipe", "ignore", "pipe"],
      });

      if (write.exitCode !== 0) {
        const message = write.stderr.trim() || "failed to write file.";
        throw new Error(message);
      }

      const bytes = Buffer.byteLength(content, "utf-8");
      const lines = content.split("\n").length;
      return { path: resolved.relPath, bytes, lines };
    },

    async editFile(path, patch) {
      const content = await backend.readFile(path, { restricted: false });
      const nextContent = content.content.replace(patch.oldText, patch.newText);
      await backend.writeFile(path, nextContent);
    },

    async listDir(path) {
      const resolved = sandbox.mapPath(path, { mustExist: true, kind: "dir" });
      const listing = await sandbox.exec(["ls", "-A", "-1", "--", resolved.containerPath]);
      if (listing.exitCode !== 0) {
        const message = listing.stderr.trim() || "failed to list directory.";
        throw new Error(message);
      }

      const entries: ListDirEntry[] = [];
      const names = listing.stdout.split("\n").filter(Boolean);

      for (const name of names) {
        const entryPath = pathPosix.join(resolved.containerPath, name);
        const stat = await sandbox.exec(["ls", "-ld", "--", entryPath]);
        if (stat.exitCode !== 0) {
          continue;
        }
        const firstChar = stat.stdout.trim().charAt(0);
        entries.push({
          name,
          isDirectory: firstChar === "d",
          isSymlink: firstChar === "l",
        });
      }

      return { path: resolved.relPath, entries };
    },

    async grep(options) {
      const { baseArgs, pattern, paths, signal, timeoutMs, dryRun } = options;

      const resolvedPaths: string[] = [];
      const commandPaths: string[] = [];
      for (const p of paths) {
        const resolved = sandbox.mapPath(p, { mustExist: true });
        resolvedPaths.push(resolved.relPath);
        commandPaths.push(toPosixRelPath(resolved.relPath));
      }

      const fullArgs = [...baseArgs, "--", pattern, ...commandPaths];

      if (dryRun) {
        return {
          stdout: "",
          stderr: "",
          exitCode: 0,
          captureTruncated: false,
          resolvedPaths,
        };
      }

      const execCwd = mapToContainerPath(".");

      try {
        const result = await sandbox.exec(["rg", ...fullArgs], {
          cwd: execCwd,
          signal,
          timeoutMs,
          maxCaptureBytes: GREP_MAX_CAPTURE_BYTES,
          killGraceMs: GREP_KILL_GRACE_MS,
        });

        return {
          stdout: result.stdout,
          stderr: result.stderr,
          exitCode: result.exitCode,
          captureTruncated: result.captureLimitExceeded || result.timedOut,
          resolvedPaths,
        };
      } catch (err) {
        return {
          stdout: "",
          stderr: err instanceof Error ? err.message : String(err),
          exitCode: 2,
          captureTruncated: false,
          resolvedPaths,
        };
      }
    },
  };

  return { backend, dispose: sandbox.dispose };
}
