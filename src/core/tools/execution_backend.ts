import { mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  resolveRestrictedDirPath,
  resolveRestrictedFilePath,
  resolveRestrictedPath,
} from "../utils/restricted_fs.js";
import { spawnWithCapture } from "../utils/spawn_capture.js";
import { truncateToBytesFromStart } from "../utils/truncate.js";

const BASH_MAX_CAPTURE_BYTES = 2 * 1024 * 1024; // 2MB
const BASH_KILL_GRACE_MS = 2_000;

const GREP_MAX_CAPTURE_BYTES = 2 * 1024 * 1024;
const GREP_KILL_GRACE_MS = 2_000;

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
    if (ALLOWED_ENV_VARS.has(key)) {
      sanitized[key] = value;
      continue;
    }
    if (SENSITIVE_ENV_PATTERNS.some((pattern) => pattern.test(key))) {
      continue;
    }
    sanitized[key] = value;
  }
  return sanitized;
}

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

export function createLocalToolExecutionBackend(): ToolExecutionBackend {
  return {
    async runBash(command, options = {}) {
      const timeoutMs = options.timeoutMs;
      const signal = options.signal;
      const cwd = options.cwd;

      const effectiveTimeoutMs =
        typeof timeoutMs === "number" && Number.isFinite(timeoutMs) && timeoutMs > 0
          ? timeoutMs
          : undefined;

      const result = await spawnWithCapture(command, [], {
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
      let rootReal = process.cwd();

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
        const result = await spawnWithCapture("rg", fullArgs, {
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

export function createSandboxToolExecutionBackend(): ToolExecutionBackend {
  const unsupported = () => {
    throw new Error("sandbox execution backend not implemented");
  };

  return {
    runBash: async () => unsupported(),
    readFile: async () => unsupported(),
    writeFile: async () => unsupported(),
    editFile: async () => unsupported(),
    listDir: async () => unsupported(),
    grep: async () => unsupported(),
  };
}
