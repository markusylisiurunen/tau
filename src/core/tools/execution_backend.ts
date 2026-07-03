import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import type { CoreDeps } from "../runtime/deps.js";
import { sanitizeEnvironment } from "../utils/sanitize_env.js";
import { spawnWithCapture } from "../utils/spawn_capture.js";
import { formatBytes } from "../utils/truncate.js";

const BASH_MAX_CAPTURE_BYTES = 1024 * 1024; // 1MB
const BASH_KILL_GRACE_MS = 2_000;

const GREP_MAX_CAPTURE_BYTES = 1024 * 1024;
const GREP_KILL_GRACE_MS = 2_000;

export type BashExecutionResult = {
  output: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  truncated: boolean;
};

export type ReadFileResult = {
  path: string;
  content: string;
};

export type ReadFileBinaryResult = {
  path: string;
  content: Buffer;
  bytes: number;
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
  output: string;
  exitCode: number | null;
  captureTruncated: boolean;
  resolvedPaths: string[];
};

export interface ToolExecutionBackend {
  dispose(): Promise<void>;
  runBash(
    command: string,
    options?: { timeoutMs?: number; signal?: AbortSignal; cwd?: string },
  ): Promise<BashExecutionResult>;
  runNodeScript(
    script: string,
    args?: string[],
    options?: { timeoutMs?: number; signal?: AbortSignal; cwd?: string },
  ): Promise<BashExecutionResult>;
  readFile(path: string): Promise<ReadFileResult>;
  readFileBinary(path: string, options?: { maxBytes?: number }): Promise<ReadFileBinaryResult>;
  writeFile(path: string, content: string): Promise<WriteFileResult>;
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

type LocalBackendDeps = Pick<CoreDeps, "spawn" | "env">;

export function createLocalToolExecutionBackend(
  deps?: Partial<LocalBackendDeps>,
): ToolExecutionBackend {
  const envProvider = deps?.env?.env ?? (() => process.env);
  const cwdProvider = deps?.env?.cwd ?? (() => process.cwd());
  const spawnCapture = deps?.spawn ?? spawnWithCapture;
  const resolvePath = (path: string): string => resolve(cwdProvider(), path);
  const resolveCwd = (cwd?: string): string => (cwd ? resolve(cwdProvider(), cwd) : cwdProvider());

  return {
    async dispose() {},

    async runBash(command, options = {}) {
      const timeoutMs = options.timeoutMs;
      const signal = options.signal;
      const cwd = resolveCwd(options.cwd);

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
        maxCaptureStrategy: "tail",
        captureOutput: "combined-and-split",
        killGraceMs: BASH_KILL_GRACE_MS,
      });

      let output = result.output ?? "";
      const stdout = result.stdout;
      let stderr = result.stderr;
      const truncated = result.captureLimitExceeded;

      let terminationNote: string | undefined;
      if (result.timedOut && effectiveTimeoutMs !== undefined) {
        terminationNote = `(tau) timed out after ${effectiveTimeoutMs}ms`;
      } else if (result.aborted) {
        terminationNote = "(tau) aborted";
      } else if (result.closeSignal) {
        terminationNote = `(tau) terminated by signal ${result.closeSignal}`;
      }

      const note = terminationNote?.trim();
      if (note && !output.includes(note)) {
        const noteText = `${output && !output.endsWith("\n") ? "\n" : ""}${note}\n`;
        output += noteText;
        stderr += noteText;
      }

      return { output, stdout, stderr, exitCode: result.exitCode, truncated };
    },

    async runNodeScript(script, args = [], options = {}) {
      const timeoutMs = options.timeoutMs;
      const signal = options.signal;
      const cwd = resolveCwd(options.cwd);

      const effectiveTimeoutMs =
        typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0
          ? timeoutMs
          : undefined;

      const result = await spawnCapture("node", ["-e", script, ...args], {
        stdio: ["ignore", "pipe", "pipe"],
        env: sanitizeEnvironment(envProvider()),
        detached: true,
        killProcessGroup: true,
        cwd,
        signal,
        timeoutMs: effectiveTimeoutMs,
        maxCaptureBytes: BASH_MAX_CAPTURE_BYTES,
        maxCaptureMode: "ignore",
        maxCaptureStrategy: "tail",
        captureOutput: "combined-and-split",
        killGraceMs: BASH_KILL_GRACE_MS,
      });

      let output = result.output ?? "";
      const stdout = result.stdout;
      let stderr = result.stderr;
      const truncated = result.captureLimitExceeded;

      let terminationNote: string | undefined;
      if (result.timedOut && effectiveTimeoutMs !== undefined) {
        terminationNote = `(tau) timed out after ${effectiveTimeoutMs}ms`;
      } else if (result.aborted) {
        terminationNote = "(tau) aborted";
      } else if (result.closeSignal) {
        terminationNote = `(tau) terminated by signal ${result.closeSignal}`;
      }

      const note = terminationNote?.trim();
      if (note && !output.includes(note)) {
        const noteText = `${output && !output.endsWith("\n") ? "\n" : ""}${note}\n`;
        output += noteText;
        stderr += noteText;
      }

      return { output, stdout, stderr, exitCode: result.exitCode, truncated };
    },

    async readFile(path) {
      const resolvedPath = resolvePath(path);
      const content = readFileSync(resolvedPath, "utf-8");
      return { path: resolvedPath, content };
    },

    async readFileBinary(path, options = {}) {
      const resolvedPath = resolvePath(path);
      const stats = statSync(resolvedPath);
      if (!stats.isFile()) {
        throw new Error("path is not a file.");
      }
      const bytes = stats.size;
      const maxBytes = options.maxBytes;
      if (maxBytes !== undefined && bytes > maxBytes) {
        throw new Error(
          `file exceeds maximum size of ${formatBytes(maxBytes)} (got ${formatBytes(bytes)}).`,
        );
      }
      const content = readFileSync(resolvedPath);
      return { path: resolvedPath, content, bytes };
    },

    async writeFile(path, content) {
      const resolvedPath = resolvePath(path);
      const dir = dirname(resolvedPath);
      if (dir && dir !== ".") {
        mkdirSync(dir, { recursive: true });
      }

      writeFileSync(resolvedPath, content, "utf-8");

      const bytes = Buffer.byteLength(content, "utf-8");
      const lines = content.split("\n").length;
      return { path: resolvedPath, bytes, lines };
    },

    async listDir(path) {
      const resolvedPath = resolvePath(path);
      const dirents = readdirSync(resolvedPath, { withFileTypes: true });
      const entries = dirents.map((d) => ({
        name: d.name,
        isDirectory: d.isDirectory(),
        isSymlink: d.isSymbolicLink(),
      }));
      return { path: resolvedPath, entries };
    },

    async grep(options) {
      const { baseArgs, pattern, paths, signal, timeoutMs, dryRun } = options;

      const resolvedPaths = paths.map((path) => {
        const cleaned = path.trim();
        if (!cleaned) {
          throw new Error("invalid grep path: empty path.");
        }
        return cleaned;
      });
      const fullArgs = [...baseArgs, "--", pattern, ...resolvedPaths];

      if (dryRun) {
        return {
          output: "",
          exitCode: 0,
          captureTruncated: false,
          resolvedPaths,
        };
      }

      try {
        const result = await spawnCapture("rg", fullArgs, {
          cwd: cwdProvider(),
          windowsHide: true,
          signal,
          timeoutMs,
          maxCaptureBytes: GREP_MAX_CAPTURE_BYTES,
          maxCaptureMode: "ignore",
          captureOutput: "combined",
          killGraceMs: GREP_KILL_GRACE_MS,
        });

        return {
          output: result.output ?? "",
          exitCode: result.exitCode,
          captureTruncated: result.captureLimitExceeded || result.timedOut,
          resolvedPaths,
        };
      } catch (err) {
        return {
          output: err instanceof Error ? err.message : String(err),
          exitCode: 2,
          captureTruncated: false,
          resolvedPaths,
        };
      }
    },
  };
}

export function scopeToolExecutionBackend(
  backend: ToolExecutionBackend,
  workingDirectory: string,
): ToolExecutionBackend {
  const resolvePath = (path: string): string => resolve(workingDirectory, path);
  const resolveCwd = (cwd?: string): string =>
    cwd ? resolve(workingDirectory, cwd) : workingDirectory;

  return {
    dispose() {
      return backend.dispose();
    },
    runBash(command, options = {}) {
      return backend.runBash(command, {
        ...options,
        cwd: resolveCwd(options.cwd),
      });
    },
    runNodeScript(script, args = [], options = {}) {
      return backend.runNodeScript(script, args, {
        ...options,
        cwd: resolveCwd(options.cwd),
      });
    },
    readFile(path) {
      return backend.readFile(resolvePath(path));
    },
    readFileBinary(path, options) {
      return backend.readFileBinary(resolvePath(path), options);
    },
    writeFile(path, content) {
      return backend.writeFile(resolvePath(path), content);
    },
    listDir(path) {
      return backend.listDir(resolvePath(path));
    },
    grep(options) {
      return backend.grep({
        ...options,
        paths: options.paths.map((path) => resolvePath(path)),
      });
    },
  };
}
