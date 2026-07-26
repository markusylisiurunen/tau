import { randomUUID } from "node:crypto";
import { basename } from "node:path";
import type { CoreDeps } from "../core/runtime/deps.js";
import {
  applyCommandEnvironment,
  type BashExecutionResult,
  type ListDirEntry,
  type ToolExecutionBackend,
} from "../core/tools/execution_backend.js";
import type { SpawnCaptureResult } from "../core/utils/spawn_capture.js";
import type { TauSdkSession } from "../sdk/types.js";

const HELPER_TIMEOUT_MS = 10_000;

export function createSdkToolExecutionBackend(options: {
  session: TauSdkSession;
  cwd: string;
}): ToolExecutionBackend {
  const { session, cwd } = options;

  const runBash: ToolExecutionBackend["runBash"] = async (command, runOptions = {}) => {
    throwIfAborted(runOptions.signal);
    const result = await session.exec(command, {
      cwd: runOptions.cwd ?? cwd,
      ...(runOptions.timeoutMs !== undefined ? { timeoutMs: runOptions.timeoutMs } : {}),
      ...(typeof runOptions.maxCaptureBytes === "number"
        ? { maxCaptureBytes: runOptions.maxCaptureBytes }
        : {}),
      ...(runOptions.signal ? { signal: runOptions.signal } : {}),
    });
    throwIfAborted(runOptions.signal);
    return result;
  };

  const runNodeScript: ToolExecutionBackend["runNodeScript"] = async (
    script,
    args = [],
    runOptions = {},
  ) => await runFramedCommand(runBash, ["node", "-e", script, ...args], runOptions);

  return {
    async dispose() {},

    runBash,
    runNodeScript,

    async readFile(path) {
      const result = await runNodeHelper(runNodeScript, READ_FILE_SCRIPT, [path], {
        cwd,
        timeoutMs: HELPER_TIMEOUT_MS,
      });
      return { path, content: result };
    },

    async readFileBinary(path, readOptions = {}) {
      const result = await runNodeHelper(
        runNodeScript,
        READ_FILE_BINARY_SCRIPT,
        [path, String(readOptions.maxBytes ?? "")],
        { cwd, timeoutMs: HELPER_TIMEOUT_MS },
      );
      const parsed = JSON.parse(result) as { contentBase64: string; bytes: number };
      return {
        path,
        content: Buffer.from(parsed.contentBase64, "base64"),
        bytes: parsed.bytes,
      };
    },

    async writeFile(path, content) {
      const result = await runNodeHelper(
        runNodeScript,
        WRITE_FILE_SCRIPT,
        [path, Buffer.from(content, "utf-8").toString("base64")],
        { cwd, timeoutMs: HELPER_TIMEOUT_MS },
      );
      const parsed = JSON.parse(result) as { path: string; bytes: number; lines: number };
      return parsed;
    },

    async writeFileBinary(path, content) {
      const result = await runNodeHelper(
        runNodeScript,
        WRITE_FILE_SCRIPT,
        [path, content.toString("base64")],
        { cwd, timeoutMs: HELPER_TIMEOUT_MS },
      );
      const parsed = JSON.parse(result) as { path: string; bytes: number };
      return { path: parsed.path, bytes: parsed.bytes };
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
      throwIfAborted(spawnOptions.signal);
      const argv = applyCommandEnvironment([cmd, ...args], spawnOptions.env);
      const result = await runFramedCommand(options.backend.runBash, argv, {
        cwd: spawnOptions.cwd ?? options.cwd,
        timeoutMs: spawnOptions.timeoutMs,
        signal: spawnOptions.signal,
        maxCaptureBytes: spawnOptions.maxCaptureBytes,
      });
      throwIfAborted(spawnOptions.signal);
      return {
        stdout: result.stdout,
        stderr: result.stderr,
        ...(spawnOptions.captureOutput === "combined" ||
        spawnOptions.captureOutput === "combined-and-split"
          ? { output: result.output }
          : {}),
        exitCode: result.exitCode,
        captureLimitExceeded: result.truncated,
        timedOut: false,
        aborted: false,
        closeSignal: null,
      };
    },
    env: { env: () => ({}) },
    fs: {
      readFile: async (path) => (await options.backend.readFile(path)).content,
    },
  };
}

async function runFramedCommand(
  runBash: ToolExecutionBackend["runBash"],
  argv: string[],
  options: {
    timeoutMs?: number;
    signal?: AbortSignal;
    cwd?: string;
    env?: Record<string, string>;
    maxCaptureBytes?: number | null;
  } = {},
): Promise<BashExecutionResult> {
  const boundary = `__TAU_COMMAND_OUTPUT_${randomUUID()}__`;
  const quotedBoundary = shellQuote(boundary);
  const command = argv.map(shellQuote).join(" ");
  const framedCommand = `printf %s ${quotedBoundary}; printf %s ${quotedBoundary} >&2; if ${command}; then status=0; else status=$?; fi; printf %s ${quotedBoundary}; printf %s ${quotedBoundary} >&2; exit "$status"`;
  const maxCaptureBytes =
    typeof options.maxCaptureBytes === "number"
      ? options.maxCaptureBytes + Buffer.byteLength(boundary) * 4
      : options.maxCaptureBytes;
  const result = await runBash(framedCommand, {
    ...options,
    ...(maxCaptureBytes === undefined ? {} : { maxCaptureBytes }),
  });
  const extractOutput = (output: string): string => {
    const start = output.indexOf(boundary);
    const end = output.indexOf(boundary, start + boundary.length);
    if (start === -1 || end === -1) {
      if (result.truncated) {
        return "";
      }
      throw new Error("command returned invalid output boundaries");
    }
    return output.slice(start + boundary.length, end);
  };
  const stdout = extractOutput(result.stdout);
  const stderr = extractOutput(result.stderr);
  return {
    ...result,
    output: stdout + stderr,
    stdout,
    stderr,
  };
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new Error("operation aborted");
  }
}

async function runNodeHelper(
  runNodeScript: ToolExecutionBackend["runNodeScript"],
  script: string,
  args: string[],
  options: { cwd: string; timeoutMs: number },
): Promise<string> {
  const result = await runNodeScript(script, args, options);
  if (result.exitCode !== 0) {
    throw new Error(
      result.stderr.trim() || result.stdout.trim() || `${basename(args[0] ?? "helper")} failed`,
    );
  }
  return result.stdout;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

const READ_FILE_SCRIPT = `
const fs = require("fs");
process.stdout.write(fs.readFileSync(process.argv[1], "utf8"));
`.trim();

const READ_FILE_BINARY_SCRIPT = `
const fs = require("fs");
const path = process.argv[1];
const maxRaw = process.argv[2];
const maxBytes = maxRaw ? Number(maxRaw) : undefined;
const content = fs.readFileSync(path);
if (maxBytes !== undefined && Number.isFinite(maxBytes) && content.byteLength > maxBytes) {
  throw new Error(\`file exceeds maximum size of \${maxBytes} bytes\`);
}
process.stdout.write(JSON.stringify({
  contentBase64: content.toString("base64"),
  bytes: content.byteLength,
}));
`.trim();

const WRITE_FILE_SCRIPT = `
const fs = require("fs");
const path = require("path");
const file = process.argv[1];
const content = Buffer.from(process.argv[2], "base64");
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, content);
process.stdout.write(JSON.stringify({
  path: file,
  bytes: content.byteLength,
  lines: content.toString("utf8").split("\\n").length,
}));
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
