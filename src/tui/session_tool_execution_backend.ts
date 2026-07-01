import { basename } from "node:path";
import type { CoreDeps } from "../core/runtime/deps.js";
import type {
  BashExecutionResult,
  GrepExecutionResult,
  ListDirEntry,
  ToolExecutionBackend,
} from "../core/tools/execution_backend.js";
import type { SpawnCaptureResult } from "../core/utils/spawn_capture.js";
import type { TauSdkSession } from "../sdk/types.js";

const HELPER_TIMEOUT_MS = 10_000;

export function createSdkToolExecutionBackend(options: {
  session: TauSdkSession;
  cwd: string;
}): ToolExecutionBackend {
  const { session, cwd } = options;

  const runBash = async (
    command: string,
    runOptions: { timeoutMs?: number; signal?: AbortSignal; cwd?: string } = {},
  ): Promise<BashExecutionResult> => {
    throwIfAborted(runOptions.signal);
    const result = await session.exec(command, {
      cwd: runOptions.cwd ?? cwd,
      ...(runOptions.timeoutMs !== undefined ? { timeoutMs: runOptions.timeoutMs } : {}),
    });
    throwIfAborted(runOptions.signal);
    return result;
  };

  return {
    async dispose() {},

    runBash,

    async readFile(path) {
      const result = await runNodeHelper(runBash, READ_FILE_SCRIPT, [path], {
        cwd,
        timeoutMs: HELPER_TIMEOUT_MS,
      });
      return { path, content: result };
    },

    async readFileBinary(path, readOptions = {}) {
      const result = await runNodeHelper(
        runBash,
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
        runBash,
        WRITE_FILE_SCRIPT,
        [path, Buffer.from(content, "utf-8").toString("base64")],
        { cwd, timeoutMs: HELPER_TIMEOUT_MS },
      );
      const parsed = JSON.parse(result) as { path: string; bytes: number; lines: number };
      return parsed;
    },

    async listDir(path) {
      const result = await runNodeHelper(runBash, LIST_DIR_SCRIPT, [path], {
        cwd,
        timeoutMs: HELPER_TIMEOUT_MS,
      });
      return { path, entries: JSON.parse(result) as ListDirEntry[] };
    },

    async grep(grepOptions) {
      const resolvedPaths = grepOptions.paths.map((path) => path.trim()).filter(Boolean);
      if (grepOptions.dryRun) {
        return {
          output: "",
          exitCode: 0,
          captureTruncated: false,
          resolvedPaths,
        } satisfies GrepExecutionResult;
      }

      const command = ["rg", ...grepOptions.baseArgs, "--", grepOptions.pattern, ...resolvedPaths]
        .map(shellQuote)
        .join(" ");
      try {
        const result = await runBash(command, {
          cwd,
          timeoutMs: grepOptions.timeoutMs,
          signal: grepOptions.signal,
        });
        return {
          output: result.output,
          exitCode: result.exitCode,
          captureTruncated: result.truncated,
          resolvedPaths,
        } satisfies GrepExecutionResult;
      } catch (error) {
        return {
          output: error instanceof Error ? error.message : String(error),
          exitCode: 2,
          captureTruncated: false,
          resolvedPaths,
        } satisfies GrepExecutionResult;
      }
    },
  };
}

export function createSdkDiffSnapshotDeps(options: {
  backend: ToolExecutionBackend;
  cwd: string;
  home: string;
}): Pick<CoreDeps, "spawn" | "env"> {
  return {
    spawn: async (cmd, args, spawnOptions = {}): Promise<SpawnCaptureResult> => {
      throwIfAborted(spawnOptions.signal);
      const command = [cmd, ...args].map(shellQuote).join(" ");
      const result = await options.backend.runBash(command, {
        cwd: spawnOptions.cwd ?? options.cwd,
        timeoutMs: spawnOptions.timeoutMs,
        signal: spawnOptions.signal,
      });
      throwIfAborted(spawnOptions.signal);
      const output = result.output;
      return {
        stdout: output,
        stderr: "",
        ...(spawnOptions.captureOutput === "combined" ? { output } : {}),
        exitCode: result.exitCode,
        captureLimitExceeded: result.truncated,
        timedOut: false,
        aborted: false,
        closeSignal: null,
      };
    },
    env: {
      cwd: () => options.cwd,
      home: () => options.home,
      platform: () => process.platform,
      nodeVersion: () => process.version,
      env: () => process.env,
    },
  };
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new Error("operation aborted");
  }
}

async function runNodeHelper(
  runBash: ToolExecutionBackend["runBash"],
  script: string,
  args: string[],
  options: { cwd: string; timeoutMs: number },
): Promise<string> {
  const command = ["node", "-e", script, ...args].map(shellQuote).join(" ");
  const result = await runBash(command, options);
  if (result.exitCode !== 0) {
    throw new Error(result.output.trim() || `${basename(args[0] ?? "helper")} failed`);
  }
  return result.output;
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
const content = Buffer.from(process.argv[2], "base64").toString("utf8");
fs.mkdirSync(path.dirname(file), { recursive: true });
fs.writeFileSync(file, content, "utf8");
process.stdout.write(JSON.stringify({
  path: file,
  bytes: Buffer.byteLength(content, "utf8"),
  lines: content.split("\\n").length,
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
