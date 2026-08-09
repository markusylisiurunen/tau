import { basename } from "node:path";
import type { CoreDeps } from "../core/runtime/deps.js";
import type {
  BashExecutionOptions,
  ListDirEntry,
  ToolExecutionBackend,
} from "../core/tools/execution_backend.js";
import type { SpawnCaptureResult } from "../core/utils/spawn_capture.js";
import { SESSION_PROTOCOL_MAX_EXEC_STDIN_BYTES } from "../protocol/session_protocol.js";
import type { TauSdkClientToolExecutionEnvironment } from "../sdk/types.js";

const HELPER_TIMEOUT_MS = 10_000;
const MAX_FILE_BYTES = SESSION_PROTOCOL_MAX_EXEC_STDIN_BYTES;
const MAX_FILE_READ_CAPTURE_BYTES = 4 * Math.ceil(MAX_FILE_BYTES / 3) + 1024;
const EXEC_ARGUMENTS_COMMAND = 'exec "$0" "$@"';

export function createSdkToolExecutionBackend(options: {
  executionEnvironment: TauSdkClientToolExecutionEnvironment;
  cwd: string;
}): ToolExecutionBackend {
  const { executionEnvironment, cwd } = options;

  const runBash: ToolExecutionBackend["runBash"] = async (command, runOptions = {}) => {
    const result = await executionEnvironment.exec(command, {
      ...(runOptions.args !== undefined ? { args: runOptions.args } : {}),
      ...(runOptions.env !== undefined ? { env: runOptions.env } : {}),
      ...(runOptions.stdin !== undefined ? { stdin: runOptions.stdin } : {}),
      cwd: runOptions.cwd ?? cwd,
      ...(runOptions.timeoutMs !== undefined ? { timeoutMs: runOptions.timeoutMs } : {}),
      ...(runOptions.maxCaptureBytes !== undefined
        ? { maxCaptureBytes: runOptions.maxCaptureBytes }
        : {}),
      ...(runOptions.signal ? { signal: runOptions.signal } : {}),
    });
    runOptions.signal?.throwIfAborted();
    return result;
  };

  const runNodeScript: ToolExecutionBackend["runNodeScript"] = (
    script,
    args = [],
    runOptions = {},
  ) =>
    runBash(EXEC_ARGUMENTS_COMMAND, {
      ...runOptions,
      args: ["node", "-e", script, ...args],
    });

  return {
    async dispose() {},

    runBash,
    runNodeScript,

    async readFile(path) {
      const result = await this.readFileBinary(path, { maxBytes: MAX_FILE_BYTES });
      return { path, content: result.content.toString("utf-8") };
    },

    async readFileBinary(path, readOptions = {}) {
      const result = await runNodeHelper(
        runNodeScript,
        READ_FILE_BINARY_SCRIPT,
        [path, String(readOptions.maxBytes ?? MAX_FILE_BYTES)],
        {
          cwd,
          timeoutMs: HELPER_TIMEOUT_MS,
          maxCaptureBytes: MAX_FILE_READ_CAPTURE_BYTES,
        },
      );
      const parsed = JSON.parse(result) as { contentBase64: string; bytes: number };
      return {
        path,
        content: Buffer.from(parsed.contentBase64, "base64"),
        bytes: parsed.bytes,
      };
    },

    async writeFile(path, content) {
      const result = await writeFile(runNodeScript, cwd, path, Buffer.from(content, "utf-8"));
      return { ...result, lines: content.split("\n").length };
    },

    async writeFileBinary(path, content) {
      return await writeFile(runNodeScript, cwd, path, content);
    },

    async listDir(path) {
      const result = await runNodeHelper(runNodeScript, LIST_DIR_SCRIPT, [path], {
        cwd,
        timeoutMs: HELPER_TIMEOUT_MS,
      });
      return { path, entries: JSON.parse(result) as ListDirEntry[] };
    },
  };
}

export function createSdkDiffSnapshotDeps(options: {
  backend: ToolExecutionBackend;
  cwd: string;
}): Pick<CoreDeps, "spawn"> & {
  env: Pick<CoreDeps["env"], "env">;
  fs: { readFile: (path: string) => Promise<string> };
} {
  return {
    spawn: async (cmd, args, spawnOptions = {}): Promise<SpawnCaptureResult> => {
      spawnOptions.signal?.throwIfAborted();
      const result = await options.backend.runBash(EXEC_ARGUMENTS_COMMAND, {
        args: [cmd, ...args],
        cwd: spawnOptions.cwd ?? options.cwd,
        ...(spawnOptions.env ? { env: definedEnvironment(spawnOptions.env) } : {}),
        ...(spawnOptions.timeoutMs !== undefined ? { timeoutMs: spawnOptions.timeoutMs } : {}),
        ...(spawnOptions.maxCaptureBytes !== undefined
          ? { maxCaptureBytes: spawnOptions.maxCaptureBytes }
          : {}),
        ...(spawnOptions.signal ? { signal: spawnOptions.signal } : {}),
      });
      spawnOptions.signal?.throwIfAborted();
      return {
        stdout: result.stdout,
        stderr: result.stderr,
        ...(spawnOptions.captureOutput === "combined" ||
        spawnOptions.captureOutput === "combined-and-split"
          ? { output: result.output }
          : {}),
        exitCode: result.exitCode,
        captureLimitExceeded: result.truncated,
        timedOut: result.timedOut,
        aborted: result.aborted,
        closeSignal: result.closeSignal as NodeJS.Signals | null,
      };
    },
    env: { env: () => ({}) },
    fs: {
      readFile: async (path) => (await options.backend.readFile(path)).content,
    },
  };
}

function definedEnvironment(env: NodeJS.ProcessEnv): Record<string, string> {
  return Object.fromEntries(
    Object.entries(env).filter((entry): entry is [string, string] => entry[1] !== undefined),
  );
}

async function runNodeHelper(
  runNodeScript: ToolExecutionBackend["runNodeScript"],
  script: string,
  args: string[],
  options: BashExecutionOptions & { cwd: string; timeoutMs: number },
): Promise<string> {
  const result = await runNodeScript(script, args, options);
  if (result.truncated) {
    throw new Error(`${basename(args[0] ?? "helper")} output exceeded the capture limit`);
  }
  if (result.exitCode !== 0) {
    throw new Error(
      result.stderr.trim() || result.stdout.trim() || `${basename(args[0] ?? "helper")} failed`,
    );
  }
  return result.stdout;
}

async function writeFile(
  runNodeScript: ToolExecutionBackend["runNodeScript"],
  cwd: string,
  path: string,
  content: Buffer,
): Promise<{ path: string; bytes: number }> {
  if (content.byteLength > MAX_FILE_BYTES) {
    throw new Error(`file exceeds maximum size of ${MAX_FILE_BYTES} bytes`);
  }
  const result = await runNodeHelper(runNodeScript, WRITE_FILE_SCRIPT, [path], {
    cwd,
    timeoutMs: HELPER_TIMEOUT_MS,
    stdin: content,
  });
  return JSON.parse(result) as { path: string; bytes: number };
}

const READ_FILE_BINARY_SCRIPT = `
const fs = require("fs");
const path = process.argv[1];
const maxBytes = Number(process.argv[2]);
const stats = fs.statSync(path);
if (!stats.isFile()) throw new Error("path is not a file");
if (stats.size > maxBytes) {
  throw new Error(\`file exceeds maximum size of \${maxBytes} bytes (got \${stats.size} bytes)\`);
}
const content = fs.readFileSync(path);
process.stdout.write(JSON.stringify({
  contentBase64: content.toString("base64"),
  bytes: content.byteLength,
}));
`.trim();

const WRITE_FILE_SCRIPT = `
const fs = require("fs");
const path = require("path");
const file = process.argv[1];
const content = fs.readFileSync(0);
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, content);
process.stdout.write(JSON.stringify({ path: file, bytes: content.byteLength }));
`.trim();

const LIST_DIR_SCRIPT = `
const fs = require("fs");
const entries = fs.readdirSync(process.argv[1], { withFileTypes: true }).map((entry) => ({
  name: entry.name,
  isDirectory: entry.isDirectory(),
  isSymlink: entry.isSymbolicLink(),
}));
process.stdout.write(JSON.stringify(entries));
`.trim();
