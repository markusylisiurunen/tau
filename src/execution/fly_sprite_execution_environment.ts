import { StringDecoder } from "node:string_decoder";
import { type Sprite, SpritesClient } from "@fly/sprites";
import {
  applyBashCommand,
  applyBashEnvironment,
  type BashExecutionResult,
  DEFAULT_COMMAND_CAPTURE_BYTES,
  type ListDirEntry,
  normalizeToolExecutionBackendError,
  type ToolExecutionBackend,
} from "../core/tools/execution_backend.js";
import type {
  SessionProtocolExecutionEnvironmentInput,
  SessionProtocolExecutionEnvironmentSnapshot,
  SessionProtocolFlySpriteExecutionEnvironmentInput,
  SessionProtocolFlySpriteExecutionEnvironmentSnapshot,
} from "../protocol/session_protocol.js";
import type { ExecutionEnvironmentResolver } from "./execution_environment.js";
import { assertFileWithinMaxBytes } from "./sandbox_tool_helpers.js";
import { ToolBackendExecutionEnvironment } from "./tool_backend_execution_environment.js";

const DEFAULT_BASE_URL = "https://api.sprites.dev";
const DEFAULT_HOME = "/home/sprite";
const HELPER_COMMAND_TIMEOUT_MS = 30_000;
const COMMAND_STOP_GRACE_MS = 2_000;

export type FlySpritesApiConfig = {
  baseURL?: string;
  token?: string;
  tokenEnv?: string;
  home?: string;
};

export type FlySpriteExecutionEnvironmentResolverOptions = {
  apis: Record<string, FlySpritesApiConfig>;
  env?: Record<string, string | undefined>;
  createClient?: (token: string, options: { baseURL: string }) => SpritesClientLike;
};

type SpritesClientLike = {
  sprite(name: string): SpriteLike;
};

type SpriteLike = Pick<Sprite, "spawn">;

type RunningSpriteCommand = ReturnType<SpriteLike["spawn"]>;

export class FlySpriteExecutionEnvironment extends ToolBackendExecutionEnvironment<SessionProtocolFlySpriteExecutionEnvironmentSnapshot> {
  readonly kind = "fly-sprite" as const;

  constructor(options: {
    apiId: string;
    spriteName: string;
    cwd: string;
    home: string;
    backend: ToolExecutionBackend;
  }) {
    super({
      snapshot: {
        kind: "fly-sprite",
        apiId: options.apiId,
        spriteName: options.spriteName,
        cwd: options.cwd,
        home: options.home,
      },
      backend: options.backend,
    });
  }
}

export class FlySpriteExecutionEnvironmentResolver implements ExecutionEnvironmentResolver {
  private readonly apis: Record<string, FlySpritesApiConfig>;
  private readonly env: Record<string, string | undefined>;
  private readonly createClient: (token: string, options: { baseURL: string }) => SpritesClientLike;

  constructor(options: FlySpriteExecutionEnvironmentResolverOptions) {
    this.apis = options.apis;
    this.env = options.env ?? process.env;
    this.createClient =
      options.createClient ?? ((token, clientOptions) => new SpritesClient(token, clientOptions));
  }

  async resolve(input: SessionProtocolExecutionEnvironmentInput) {
    if (input.kind !== "fly-sprite") {
      throw new Error(`unsupported execution environment kind '${input.kind}'`);
    }
    return this.createEnvironment(input);
  }

  canRestore(snapshot: SessionProtocolExecutionEnvironmentSnapshot): boolean {
    return snapshot.kind === "fly-sprite" && snapshot.apiId in this.apis;
  }

  async restore(snapshot: SessionProtocolExecutionEnvironmentSnapshot) {
    if (snapshot.kind !== "fly-sprite") {
      throw new Error(`unsupported execution environment kind '${snapshot.kind}'`);
    }
    return this.createEnvironment(snapshot);
  }

  private createEnvironment(
    input:
      | SessionProtocolFlySpriteExecutionEnvironmentInput
      | SessionProtocolFlySpriteExecutionEnvironmentSnapshot,
  ) {
    const api = this.apis[input.apiId];
    if (!api) {
      throw new Error(`unknown Fly Sprite API '${input.apiId}'`);
    }

    const token = api.token ?? (api.tokenEnv ? this.env[api.tokenEnv] : undefined);
    if (!token) {
      throw new Error(`Fly Sprite API '${input.apiId}' is missing a token`);
    }

    const client = this.createClient(token, { baseURL: api.baseURL ?? DEFAULT_BASE_URL });
    const backend = createFlySpriteToolExecutionBackend({
      sprite: client.sprite(input.spriteName),
      cwd: input.cwd,
    });

    return new FlySpriteExecutionEnvironment({
      apiId: input.apiId,
      spriteName: input.spriteName,
      cwd: input.cwd,
      home: "home" in input ? input.home : (api.home ?? DEFAULT_HOME),
      backend,
    });
  }
}

export function createFlySpriteToolExecutionBackend(options: {
  sprite: SpriteLike;
  cwd: string;
}): ToolExecutionBackend {
  const worker = new FlySpriteWorker(options.sprite, options.cwd);
  const runBash: ToolExecutionBackend["runBash"] = async (command, runOptions = {}) =>
    await worker.request(
      "exec",
      {
        command: applyBashCommand(command),
        args: runOptions.args,
        stdinBase64: runOptions.stdin?.toString("base64"),
        cwd: runOptions.cwd ?? options.cwd,
        timeoutMs: runOptions.timeoutMs,
        env: applyBashEnvironment(runOptions.env),
        maxCaptureBytes: runOptions.maxCaptureBytes,
      },
      { signal: runOptions.signal },
    );
  const runNodeScript: ToolExecutionBackend["runNodeScript"] = (
    script,
    args = [],
    runOptions = {},
  ) =>
    runBash('exec "$0" "$@"', {
      ...runOptions,
      args: ["node", "-e", script, ...args],
    });

  return {
    runBash,
    runNodeScript,

    async readFile(path) {
      try {
        const result = await worker.request("readFile", {
          path,
          timeoutMs: HELPER_COMMAND_TIMEOUT_MS,
        });
        return { path, content: result.content };
      } catch (error) {
        throw normalizeToolExecutionBackendError(error);
      }
    },

    async readFileBinary(path, readOptions = {}) {
      try {
        const result = await worker.request("readFileBinary", {
          path,
          timeoutMs: HELPER_COMMAND_TIMEOUT_MS,
          maxBytes: readOptions.maxBytes,
        });
        const content = Buffer.from(result.contentBase64, "base64");
        const bytes = result.bytes;
        assertFileWithinMaxBytes(bytes, readOptions.maxBytes);
        return { path, content, bytes };
      } catch (error) {
        throw normalizeToolExecutionBackendError(error);
      }
    },

    async writeFile(path, content) {
      return await worker.request("writeFile", {
        path,
        contentBase64: Buffer.from(content, "utf-8").toString("base64"),
        timeoutMs: HELPER_COMMAND_TIMEOUT_MS,
      });
    },

    async writeFileBinary(path, content) {
      const result = await worker.request("writeFile", {
        path,
        contentBase64: content.toString("base64"),
        timeoutMs: HELPER_COMMAND_TIMEOUT_MS,
      });
      return { path: result.path, bytes: result.bytes };
    },

    async listDir(path) {
      const result = await worker.request("listDir", {
        path,
        timeoutMs: HELPER_COMMAND_TIMEOUT_MS,
      });
      return { path, entries: result.entries };
    },

    async dispose() {
      await worker.dispose();
    },
  };
}

type FlySpriteWorkerRequestByMethod = {
  exec: {
    command: string;
    args?: string[];
    stdinBase64?: string;
    cwd: string;
    timeoutMs?: number;
    env?: Record<string, string>;
    maxCaptureBytes?: number;
  };
  readFile: {
    path: string;
    timeoutMs: number;
  };
  readFileBinary: {
    path: string;
    timeoutMs: number;
    maxBytes?: number;
  };
  writeFile: {
    path: string;
    contentBase64: string;
    timeoutMs: number;
  };
  listDir: {
    path: string;
    timeoutMs: number;
  };
  shutdown: {
    timeoutMs: number;
  };
  cancel: {
    targetId: number;
  };
};

type FlySpriteWorkerResultByMethod = {
  exec: BashExecutionResult;
  readFile: {
    content: string;
  };
  readFileBinary: {
    contentBase64: string;
    bytes: number;
  };
  writeFile: {
    path: string;
    bytes: number;
    lines: number;
  };
  listDir: {
    entries: ListDirEntry[];
  };
  shutdown: {
    exitCode: number;
  };
  cancel: {
    accepted: boolean;
  };
};

type FlySpriteWorkerMethod = keyof FlySpriteWorkerRequestByMethod;

type FlySpriteWorkerResponse =
  | {
      id: number;
      ok: true;
      result: unknown;
    }
  | {
      id: number;
      ok: false;
      error: {
        message: string;
        code?: string;
      };
    };

type FlySpritePendingRequest = {
  resolve: (value: unknown) => void;
  reject: (reason: unknown) => void;
  signal?: AbortSignal;
  abort?: () => void;
  timer?: ReturnType<typeof setTimeout>;
};

class FlySpriteWorker {
  private command?: RunningSpriteCommand;
  private readyPromise?: Promise<void>;
  private readonly stdoutBuffer = new LineBuffer();
  private stdoutDecoder = new StringDecoder("utf8");
  private nextRequestId = 1;
  private pendingRequests = new Map<number, FlySpritePendingRequest>();
  private disposePromise?: Promise<void>;
  private closed = false;

  constructor(
    private readonly sprite: SpriteLike,
    private readonly cwd: string,
  ) {}

  async request<M extends FlySpriteWorkerMethod>(
    method: M,
    params: FlySpriteWorkerRequestByMethod[M],
    options: { signal?: AbortSignal } = {},
  ): Promise<FlySpriteWorkerResultByMethod[M]> {
    if (this.closed && method !== "shutdown") {
      throw new Error("Fly Sprite worker is closed");
    }

    await this.ensureStarted();
    const id = this.nextRequestId++;
    const payload = JSON.stringify({ id, method, ...params });

    return await new Promise<FlySpriteWorkerResultByMethod[M]>((resolve, reject) => {
      const timeoutMs = "timeoutMs" in params ? params.timeoutMs : undefined;
      const { signal } = options;
      let shouldCancel = false;
      const pending: FlySpritePendingRequest = {
        resolve: (value) => resolve(value as FlySpriteWorkerResultByMethod[M]),
        reject,
        signal,
      };

      if (timeoutMs !== undefined && Number.isFinite(timeoutMs) && timeoutMs > 0) {
        pending.timer = setTimeout(
          () => {
            this.sendCancel(id);
            this.rejectPendingRequest(
              id,
              new Error(`Fly Sprite worker request '${method}' timed out after ${timeoutMs}ms`),
            );
          },
          timeoutMs + COMMAND_STOP_GRACE_MS + 1_000,
        );
      }

      if (signal) {
        pending.abort = () => {
          shouldCancel = true;
          this.sendCancel(id);
        };
        signal.addEventListener("abort", pending.abort, { once: true });
      }

      this.pendingRequests.set(id, pending);
      try {
        this.command!.stdin.write(`${payload}\n`);
        if (shouldCancel || signal?.aborted) {
          this.sendCancel(id);
        }
      } catch (err) {
        this.rejectPendingRequest(id, err);
      }
    });
  }

  async dispose(): Promise<void> {
    if (!this.disposePromise) {
      this.disposePromise = this.disposeNow();
    }
    return await this.disposePromise;
  }

  private async disposeNow(): Promise<void> {
    this.closed = true;
    const command = this.command;
    if (command) {
      await this.request("shutdown", { timeoutMs: HELPER_COMMAND_TIMEOUT_MS }).catch(
        () => undefined,
      );
      command.kill();
      if (this.command === command) {
        this.command = undefined;
      }
    }
    this.rejectAllPending(new Error("Fly Sprite worker was disposed"));
  }

  private async ensureStarted(): Promise<void> {
    if (this.command && this.readyPromise) {
      await this.readyPromise;
      return;
    }

    this.readyPromise = this.start();
    await this.readyPromise;
  }

  private async start(): Promise<void> {
    const command = this.sprite.spawn("node", ["-e", WORKER_SCRIPT], {
      cwd: this.cwd,
    });
    this.command = command;
    this.stdoutBuffer.clear();
    this.stdoutDecoder = new StringDecoder("utf8");

    return await new Promise<void>((resolve, reject) => {
      let settled = false;
      const timer = setTimeout(() => {
        cleanup();
        command.kill();
        reject(new Error("timed out waiting for Fly Sprite worker"));
      }, HELPER_COMMAND_TIMEOUT_MS);

      const cleanup = () => {
        clearTimeout(timer);
        command.off("error", onError);
      };

      const finishReady = () => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve();
      };

      const onError = (err: unknown) => {
        if (settled) return;
        settled = true;
        cleanup();
        this.command = undefined;
        this.readyPromise = undefined;
        reject(err);
      };

      command.on("error", onError);
      command.stdout.on("data", (chunk: Buffer) => {
        this.handleStdoutChunk(chunk, finishReady);
      });
      command.stderr.resume();
      command.on("exit", (exitCode: number) => {
        this.command = undefined;
        this.readyPromise = undefined;
        if (!settled) {
          settled = true;
          cleanup();
          reject(new Error(`Fly Sprite worker exited before ready with code ${exitCode}`));
        }
        this.rejectAllPending(new Error(`Fly Sprite worker exited with code ${exitCode}`));
      });
    });
  }

  private handleStdoutChunk(chunk: Buffer, onReady?: () => void): void {
    for (const line of this.stdoutBuffer.push(this.stdoutDecoder.write(chunk))) {
      this.handleStdoutLine(line, onReady);
    }
  }

  private handleStdoutLine(line: string, onReady?: () => void): void {
    if (!line.trim()) {
      return;
    }

    let message: FlySpriteWorkerResponse | { type: "ready" };
    try {
      message = JSON.parse(line) as FlySpriteWorkerResponse | { type: "ready" };
    } catch {
      return;
    }

    if ("type" in message && message.type === "ready") {
      onReady?.();
      return;
    }

    if (!("id" in message)) {
      return;
    }

    const pending = this.pendingRequests.get(message.id);
    if (!pending) {
      return;
    }
    this.pendingRequests.delete(message.id);
    this.cleanupPendingRequest(pending);

    if (message.ok) {
      pending.resolve(message.result);
      return;
    }

    const error = new Error(message.error.message);
    if (message.error.code) {
      Object.assign(error, { code: message.error.code });
    }
    pending.reject(error);
  }

  private sendCancel(targetId: number): void {
    const command = this.command;
    if (!command) {
      return;
    }
    try {
      command.stdin.write(
        `${JSON.stringify({ id: this.nextRequestId++, method: "cancel", targetId })}\n`,
      );
    } catch {
      // The worker exit path rejects the original request.
    }
  }

  private rejectPendingRequest(id: number, reason: unknown): void {
    const pending = this.pendingRequests.get(id);
    if (!pending) {
      return;
    }
    this.pendingRequests.delete(id);
    this.cleanupPendingRequest(pending);
    pending.reject(reason);
  }

  private rejectAllPending(reason: unknown): void {
    const pending = [...this.pendingRequests.values()];
    this.pendingRequests.clear();
    for (const request of pending) {
      this.cleanupPendingRequest(request);
      request.reject(reason);
    }
  }

  private cleanupPendingRequest(request: FlySpritePendingRequest): void {
    if (request.timer) {
      clearTimeout(request.timer);
    }
    if (request.signal && request.abort) {
      request.signal.removeEventListener("abort", request.abort);
    }
  }
}

class LineBuffer {
  private readonly chunks: string[] = [];

  push(chunk: string): string[] {
    const lines: string[] = [];
    let start = 0;

    while (true) {
      const newlineIndex = chunk.indexOf("\n", start);
      if (newlineIndex === -1) {
        break;
      }

      this.chunks.push(chunk.slice(start, newlineIndex));
      lines.push(this.flushLine());
      start = newlineIndex + 1;
    }

    if (start < chunk.length) {
      this.chunks.push(chunk.slice(start));
    }

    return lines;
  }

  clear(): void {
    this.chunks.length = 0;
  }

  private flushLine(): string {
    const line = this.chunks.length === 1 ? this.chunks[0]! : this.chunks.join("");
    this.clear();
    return line;
  }
}

const WORKER_SCRIPT = `
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");
const { spawn } = require("node:child_process");

const DEFAULT_COMMAND_CAPTURE_BYTES = ${DEFAULT_COMMAND_CAPTURE_BYTES};
const COMMAND_STOP_GRACE_MS = ${COMMAND_STOP_GRACE_MS};
const running = new Map();
const rl = readline.createInterface({ input: process.stdin });

console.log(JSON.stringify({ type: "ready" }));

rl.on("line", (line) => {
  void handleLine(line);
});

async function handleLine(line) {
  let request;
  try {
    request = JSON.parse(line);
  } catch (err) {
    return;
  }

  try {
    if (request.method === "shutdown") {
      const active = [...running.values()];
      for (const runningRequest of active) {
        runningRequest.cancel("abort");
      }
      await Promise.all(active.map((runningRequest) => runningRequest.stopped));
      respond(request.id, { exitCode: 0 });
      process.exit(0);
      return;
    }

    if (request.method === "cancel") {
      const runningRequest = running.get(request.targetId);
      if (runningRequest) {
        runningRequest.cancel("abort");
      }
      respond(request.id, { accepted: Boolean(runningRequest) });
      return;
    }

    if (request.method === "exec") {
      const result = await runCommand(
        request.id,
        "bash",
        ["-lc", request.command, ...(request.args ?? [])],
        {
          cwd: request.cwd,
          timeoutMs: request.timeoutMs,
          env: request.env,
          maxCaptureBytes: request.maxCaptureBytes,
          stdinBase64: request.stdinBase64,
        },
      );
      respond(request.id, result);
      return;
    }

    if (request.method === "readFile") {
      const content = await fs.promises.readFile(request.path, "utf-8");
      respond(request.id, { content });
      return;
    }

    if (request.method === "readFileBinary") {
      const stats = await fs.promises.stat(request.path);
      if (request.maxBytes !== undefined && stats.size > request.maxBytes) {
        throw new Error(
          "file exceeds maximum size of " + request.maxBytes + " bytes (got " + stats.size + " bytes).",
        );
      }
      const content = await fs.promises.readFile(request.path);
      if (request.maxBytes !== undefined && content.byteLength > request.maxBytes) {
        throw new Error(
          "file exceeds maximum size of " + request.maxBytes + " bytes (got " + content.byteLength + " bytes).",
        );
      }
      respond(request.id, {
        contentBase64: content.toString("base64"),
        bytes: content.byteLength,
      });
      return;
    }

    if (request.method === "writeFile") {
      const content = Buffer.from(request.contentBase64, "base64");
      await fs.promises.mkdir(path.dirname(request.path), { recursive: true });
      await fs.promises.writeFile(request.path, content);
      respond(request.id, {
        path: request.path,
        bytes: content.byteLength,
        lines: content.toString("utf-8").split("\\n").length,
      });
      return;
    }

    if (request.method === "listDir") {
      const entries = (await fs.promises.readdir(request.path, { withFileTypes: true })).map((entry) => ({
        name: entry.name,
        isDirectory: entry.isDirectory(),
        isSymlink: entry.isSymbolicLink(),
      }));
      respond(request.id, { entries });
      return;
    }

    fail(request.id, new Error("unknown worker method"));
  } catch (err) {
    fail(request.id, err);
  }
}

function runCommand(id, command, args, options) {
  return new Promise((resolve) => {
    const chunks = [];
    const stdoutChunks = [];
    const stderrChunks = [];
    let bytes = 0;
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let truncated = false;
    let timedOut = false;
    let aborted = false;
    let settled = false;
    let timer;
    let stopTimer;
    let markStopped = () => {};
    const stopped = new Promise((resolveStopped) => {
      markStopped = resolveStopped;
    });
    const maxCaptureBytes = options.maxCaptureBytes ?? DEFAULT_COMMAND_CAPTURE_BYTES;

    const child = spawn(command, args, {
      cwd: options.cwd,
      env: { ...process.env, ...options.env },
      detached: true,
      stdio: [options.stdinBase64 === undefined ? "ignore" : "pipe", "pipe", "pipe"],
    });
    if (options.stdinBase64 !== undefined) {
      child.stdin.end(Buffer.from(options.stdinBase64, "base64"));
    }

    const trimChunks = (targetChunks, targetBytes) => {
      let nextBytes = targetBytes;
      while (nextBytes > maxCaptureBytes && targetChunks.length > 0) {
        const excessBytes = nextBytes - maxCaptureBytes;
        const first = targetChunks[0];
        if (first.byteLength <= excessBytes) {
          targetChunks.shift();
          nextBytes -= first.byteLength;
        } else {
          targetChunks[0] = first.subarray(excessBytes);
          nextBytes -= excessBytes;
        }
        truncated = true;
      }
      return nextBytes;
    };

    const append = (chunk, target) => {
      const buffer = Buffer.from(chunk);
      chunks.push(buffer);
      bytes += buffer.byteLength;
      bytes = trimChunks(chunks, bytes);

      if (target === "stdout") {
        stdoutChunks.push(buffer);
        stdoutBytes += buffer.byteLength;
        stdoutBytes = trimChunks(stdoutChunks, stdoutBytes);
      } else {
        stderrChunks.push(buffer);
        stderrBytes += buffer.byteLength;
        stderrBytes = trimChunks(stderrChunks, stderrBytes);
      }
    };

    const cleanup = () => {
      running.delete(id);
      if (timer) clearTimeout(timer);
      if (stopTimer) clearTimeout(stopTimer);
    };

    const finish = (exitCode, closeSignal = null) => {
      if (settled) return;
      settled = true;
      cleanup();
      markStopped();
      const output = Buffer.concat(chunks).toString("utf-8");
      const stdout = Buffer.concat(stdoutChunks).toString("utf-8");
      const stderr = Buffer.concat(stderrChunks).toString("utf-8");
      resolve({
        output,
        stdout,
        stderr,
        exitCode,
        truncated,
        timedOut,
        aborted,
        closeSignal,
      });
    };

    const killProcessGroup = (signal) => {
      try {
        process.kill(-child.pid, signal);
      } catch {
        child.kill(signal);
      }
    };

    const cancel = (reason) => {
      if (settled) return;
      if (reason === "timeout") timedOut = true;
      if (reason === "abort") aborted = true;
      killProcessGroup("SIGTERM");
      if (stopTimer) clearTimeout(stopTimer);
      stopTimer = setTimeout(() => killProcessGroup("SIGKILL"), COMMAND_STOP_GRACE_MS);
    };

    running.set(id, { cancel, stopped });

    if (options.timeoutMs && Number.isFinite(options.timeoutMs) && options.timeoutMs > 0) {
      timer = setTimeout(() => cancel("timeout"), options.timeoutMs);
    }

    child.stdout.on("data", (chunk) => append(chunk, "stdout"));
    child.stderr.on("data", (chunk) => append(chunk, "stderr"));
    child.on("error", (err) => {
      append(Buffer.from(err.message), "stderr");
      finish(1);
    });
    child.on("close", (exitCode, closeSignal) => finish(exitCode, closeSignal));
  });
}

function respond(id, result) {
  console.log(JSON.stringify({ id, ok: true, result }));
}

function fail(id, error) {
  const message = error instanceof Error ? error.message : String(error);
  const code = error && typeof error === "object" && typeof error.code === "string"
    ? error.code
    : undefined;
  console.log(JSON.stringify({ id, ok: false, error: { message, ...(code ? { code } : {}) } }));
}
`;
