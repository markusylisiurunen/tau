import { basename } from "node:path";
import type { CoreDeps } from "../core/runtime/deps.js";
import type {
  CommandExecutionOptions,
  ListDirEntry,
  ToolExecutionBackend,
} from "../core/tools/execution_backend.js";
import type { SpawnCaptureResult } from "../core/utils/spawn_capture.js";
import { SESSION_PROTOCOL_MAX_FILE_BYTES } from "../protocol/session_protocol.js";
import type { TauSdkSession } from "../sdk/types.js";

const HELPER_TIMEOUT_MS = 10_000;

export function createSdkToolExecutionBackend(options: {
  session: TauSdkSession;
  cwd: string;
}): ToolExecutionBackend {
  const { session, cwd } = options;

  const runBash: ToolExecutionBackend["runBash"] = async (command, runOptions = {}) => {
    const result = await session.exec(command, {
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

  const runProcess: ToolExecutionBackend["runProcess"] = async (argv, runOptions = {}) => {
    const result = await session.execProcess(argv, {
      cwd: runOptions.cwd ?? cwd,
      ...(runOptions.env !== undefined ? { env: runOptions.env } : {}),
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
  ) => runProcess(["node", "-e", script, ...args], runOptions);

  return {
    async dispose() {},

    runProcess,
    runBash,
    runNodeScript,

    async readFile(path) {
      const result = await session.readFile(path, { maxBytes: SESSION_PROTOCOL_MAX_FILE_BYTES });
      return { path, content: Buffer.from(result.contentBase64, "base64").toString("utf-8") };
    },

    async readFileBinary(path, readOptions = {}) {
      const result = await session.readFile(path, {
        maxBytes: readOptions.maxBytes ?? SESSION_PROTOCOL_MAX_FILE_BYTES,
      });
      return {
        path,
        content: Buffer.from(result.contentBase64, "base64"),
        bytes: result.bytes,
      };
    },

    async writeFile(path, content) {
      const result = await session.writeFile(path, Buffer.from(content, "utf-8"));
      return { ...result, lines: content.split("\n").length };
    },

    async writeFileBinary(path, content) {
      return await session.writeFile(path, content);
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
      const result = await options.backend.runProcess([cmd, ...args], {
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
  options: CommandExecutionOptions & { cwd: string; timeoutMs: number },
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

const LIST_DIR_SCRIPT = `
const fs = require("fs");
const entries = fs.readdirSync(process.argv[1], { withFileTypes: true }).map((entry) => ({
  name: entry.name,
  isDirectory: entry.isDirectory(),
  isSymlink: entry.isSymbolicLink(),
}));
process.stdout.write(JSON.stringify(entries));
`.trim();
