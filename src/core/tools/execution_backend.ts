import { mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { SESSION_PROTOCOL_MAX_EXEC_CAPTURE_BYTES } from "../../protocol/session_protocol.js";
import type { CoreDeps } from "../runtime/deps.js";
import { sanitizeEnvironment } from "../utils/sanitize_env.js";
import { spawnWithCapture } from "../utils/spawn_capture.js";
import { formatBytes } from "../utils/truncate.js";

export const DEFAULT_COMMAND_CAPTURE_BYTES = 1024 * 1024;
export const MAX_COMMAND_CAPTURE_BYTES = SESSION_PROTOCOL_MAX_EXEC_CAPTURE_BYTES;

const COMMAND_KILL_GRACE_MS = 2_000;

export type CommandExecutionResult = {
  output: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  truncated: boolean;
  timedOut: boolean;
  aborted: boolean;
  closeSignal: string | null;
};

export type BashExecutionResult = CommandExecutionResult;

export type CommandExecutionOptions = {
  timeoutMs?: number;
  signal?: AbortSignal;
  cwd?: string;
  env?: Record<string, string>;
  maxCaptureBytes?: number;
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

export type WriteFileBinaryResult = {
  path: string;
  bytes: number;
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

export const NONINTERACTIVE_GIT_ENV = {
  GIT_TERMINAL_PROMPT: "0",
  GIT_EDITOR: "true",
  GIT_SEQUENCE_EDITOR: "true",
  GIT_PAGER: "cat",
  GIT_ASKPASS: "true",
  GIT_SSH_COMMAND: "ssh -o BatchMode=yes",
} as const;

export function applyCommandEnvironment(
  argv: string[],
  env: Record<string, string | undefined> | undefined,
): string[] {
  const assignments = Object.entries(env ?? {}).flatMap(([key, value]) =>
    value === undefined ? [] : [`${key}=${value}`],
  );
  return assignments.length > 0 ? ["env", ...assignments, ...argv] : argv;
}

export function applyBashEnvironment(
  env: Record<string, string> | undefined,
): Record<string, string> {
  return { ...env, ...NONINTERACTIVE_GIT_ENV };
}

export interface ToolExecutionBackend {
  dispose(): Promise<void>;
  runProcess(
    argv: [string, ...string[]],
    options?: CommandExecutionOptions,
  ): Promise<CommandExecutionResult>;
  runBash(command: string, options?: CommandExecutionOptions): Promise<BashExecutionResult>;
  runNodeScript(
    script: string,
    args?: string[],
    options?: CommandExecutionOptions,
  ): Promise<CommandExecutionResult>;
  readFile(path: string): Promise<ReadFileResult>;
  readFileBinary(path: string, options?: { maxBytes?: number }): Promise<ReadFileBinaryResult>;
  writeFile(path: string, content: string): Promise<WriteFileResult>;
  writeFileBinary(path: string, content: Buffer): Promise<WriteFileBinaryResult>;
  listDir(path: string): Promise<ListDirResult>;
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
  const resolveEnvironment = (env?: Record<string, string>): NodeJS.ProcessEnv => ({
    ...sanitizeEnvironment(envProvider()),
    ...env,
  });

  const runProcess = async (
    argv: [string, ...string[]],
    options: CommandExecutionOptions = {},
  ): Promise<CommandExecutionResult> => {
    const [command, ...args] = argv;
    const effectiveTimeoutMs =
      typeof options.timeoutMs === "number" &&
      Number.isFinite(options.timeoutMs) &&
      options.timeoutMs > 0
        ? options.timeoutMs
        : undefined;
    const result = await spawnCapture(command, args, {
      stdio: ["ignore", "pipe", "pipe"],
      env: resolveEnvironment(options.env),
      detached: true,
      killProcessGroup: true,
      cwd: resolveCwd(options.cwd),
      signal: options.signal,
      timeoutMs: effectiveTimeoutMs,
      maxCaptureBytes: options.maxCaptureBytes ?? DEFAULT_COMMAND_CAPTURE_BYTES,
      maxCaptureMode: "ignore",
      maxCaptureStrategy: "tail",
      captureOutput: "combined-and-split",
      killGraceMs: COMMAND_KILL_GRACE_MS,
    });

    let output = result.output ?? "";
    const stdout = result.stdout;
    let stderr = result.stderr;
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

    return {
      output,
      stdout,
      stderr,
      exitCode: result.exitCode,
      truncated: result.captureLimitExceeded,
      timedOut: result.timedOut,
      aborted: result.aborted,
      closeSignal: result.closeSignal,
    };
  };

  return {
    async dispose() {},

    runProcess,

    runBash(command, options = {}) {
      return runProcess(["bash", "-lc", command], {
        ...options,
        env: applyBashEnvironment(options.env),
      });
    },

    runNodeScript(script, args = [], options = {}) {
      return runProcess(["node", "-e", script, ...args], options);
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

    async writeFileBinary(path, content) {
      const resolvedPath = resolvePath(path);
      const dir = dirname(resolvedPath);
      if (dir && dir !== ".") {
        mkdirSync(dir, { recursive: true });
      }
      writeFileSync(resolvedPath, content);
      return { path: resolvedPath, bytes: content.byteLength };
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
  };
}

export function scopeToolExecutionBackend(
  backend: ToolExecutionBackend,
  workingDirectory: string,
  env?: Record<string, string>,
): ToolExecutionBackend {
  const resolvePath = (path: string): string => resolve(workingDirectory, path);
  const resolveCwd = (cwd?: string): string =>
    cwd ? resolve(workingDirectory, cwd) : workingDirectory;
  const mergeEnvironment = (
    overrides?: Record<string, string>,
  ): { env?: Record<string, string> } => {
    const merged = { ...env, ...overrides };
    return Object.keys(merged).length > 0 ? { env: merged } : {};
  };

  const scopeCommandOptions = (options: CommandExecutionOptions): CommandExecutionOptions => ({
    ...options,
    cwd: resolveCwd(options.cwd),
    ...mergeEnvironment(options.env),
  });

  return {
    dispose() {
      return backend.dispose();
    },
    runProcess(argv, options = {}) {
      return backend.runProcess(argv, scopeCommandOptions(options));
    },
    runBash(command, options = {}) {
      return backend.runBash(command, scopeCommandOptions(options));
    },
    runNodeScript(script, args = [], options = {}) {
      return backend.runNodeScript(script, args, scopeCommandOptions(options));
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
    writeFileBinary(path, content) {
      return backend.writeFileBinary(resolvePath(path), content);
    },
    listDir(path) {
      return backend.listDir(resolvePath(path));
    },
  };
}
