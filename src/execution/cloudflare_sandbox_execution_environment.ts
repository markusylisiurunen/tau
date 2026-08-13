import { randomUUID } from "node:crypto";
import { dirname } from "node:path/posix";
import {
  applyBashCommand,
  applyBashEnvironment,
  applyCommandEnvironment,
  type BashExecutionResult,
  DEFAULT_COMMAND_CAPTURE_BYTES,
  type ListDirEntry,
  type ToolExecutionBackend,
} from "../core/tools/execution_backend.js";
import type {
  SessionProtocolCloudflareSandboxExecutionEnvironmentInput,
  SessionProtocolCloudflareSandboxExecutionEnvironmentSnapshot,
  SessionProtocolExecutionEnvironmentInput,
  SessionProtocolExecutionEnvironmentSnapshot,
} from "../protocol/session_protocol.js";
import type { ExecutionEnvironmentResolver } from "./execution_environment.js";
import {
  assertFileWithinMaxBytes,
  buildWriteFileResult,
  NODE_LIST_DIR_SCRIPT,
} from "./sandbox_tool_helpers.js";
import { ToolBackendExecutionEnvironment } from "./tool_backend_execution_environment.js";

const DEFAULT_HOME = "/home/sandbox";
const HELPER_OPERATION_TIMEOUT_MS = 30_000;

export type CloudflareSandboxBridgeConfig = {
  url: string;
  apiKey?: string;
  apiKeyEnv?: string;
  home?: string;
};

export type CloudflareSandboxExecutionEnvironmentResolverOptions = {
  bridges: Record<string, CloudflareSandboxBridgeConfig>;
  env?: Record<string, string | undefined>;
  fetch?: typeof fetch;
};

type BridgeClientOptions = {
  bridgeId: string;
  baseUrl: string;
  apiKey?: string;
  fetch: typeof fetch;
};

type BridgeErrorBody = {
  error?: string;
  code?: string;
};

export class CloudflareSandboxExecutionEnvironment extends ToolBackendExecutionEnvironment<SessionProtocolCloudflareSandboxExecutionEnvironmentSnapshot> {
  readonly kind = "cloudflare-sandbox" as const;

  constructor(options: {
    bridgeId: string;
    sandboxId: string;
    cwd: string;
    home: string;
    backend: ToolExecutionBackend;
  }) {
    super({
      snapshot: {
        kind: "cloudflare-sandbox",
        bridgeId: options.bridgeId,
        sandboxId: options.sandboxId,
        cwd: options.cwd,
        home: options.home,
      },
      backend: options.backend,
    });
  }
}

export class CloudflareSandboxExecutionEnvironmentResolver implements ExecutionEnvironmentResolver {
  private readonly bridges: Record<string, CloudflareSandboxBridgeConfig>;
  private readonly env: Record<string, string | undefined>;
  private readonly fetch: typeof fetch;

  constructor(options: CloudflareSandboxExecutionEnvironmentResolverOptions) {
    this.bridges = options.bridges;
    this.env = options.env ?? process.env;
    this.fetch = options.fetch ?? fetch;
  }

  async resolve(input: SessionProtocolExecutionEnvironmentInput) {
    if (input.kind !== "cloudflare-sandbox") {
      throw new Error(`unsupported execution environment kind '${input.kind}'`);
    }
    return this.createEnvironment(input);
  }

  canRestore(snapshot: SessionProtocolExecutionEnvironmentSnapshot): boolean {
    return snapshot.kind === "cloudflare-sandbox" && snapshot.bridgeId in this.bridges;
  }

  async restore(snapshot: SessionProtocolExecutionEnvironmentSnapshot) {
    if (snapshot.kind !== "cloudflare-sandbox") {
      throw new Error(`unsupported execution environment kind '${snapshot.kind}'`);
    }
    return this.createEnvironment(snapshot);
  }

  private createEnvironment(
    input:
      | SessionProtocolCloudflareSandboxExecutionEnvironmentInput
      | SessionProtocolCloudflareSandboxExecutionEnvironmentSnapshot,
  ) {
    const bridge = this.bridges[input.bridgeId];
    if (!bridge) {
      throw new Error(`unknown Cloudflare Sandbox bridge '${input.bridgeId}'`);
    }

    const apiKey = bridge.apiKey ?? (bridge.apiKeyEnv ? this.env[bridge.apiKeyEnv] : undefined);
    const client = new CloudflareSandboxBridgeClient({
      bridgeId: input.bridgeId,
      baseUrl: bridge.url,
      apiKey,
      fetch: this.fetch,
    });
    const backend = createCloudflareSandboxToolExecutionBackend({
      client,
      sandboxId: input.sandboxId,
      cwd: input.cwd,
    });

    return new CloudflareSandboxExecutionEnvironment({
      bridgeId: input.bridgeId,
      sandboxId: input.sandboxId,
      cwd: input.cwd,
      home: "home" in input ? input.home : (bridge.home ?? DEFAULT_HOME),
      backend,
    });
  }
}

export function createCloudflareSandboxToolExecutionBackend(options: {
  client: CloudflareSandboxBridgeClient;
  sandboxId: string;
  cwd: string;
}): ToolExecutionBackend {
  const { client, sandboxId } = options;
  const commandSessions = new Map<string, Promise<{ id: string; cwd: string }>>();
  const commandQueues = new Map<string, Promise<void>>();
  const cleanupPromises = new Set<Promise<void>>();
  const disposeAbortController = new AbortController();
  let disposed = false;

  const assertActive = (): void => {
    if (disposed) {
      throw new Error("Cloudflare Sandbox execution backend is disposed");
    }
  };

  const createHelperSignal = (): AbortSignal =>
    AbortSignal.any([
      disposeAbortController.signal,
      AbortSignal.timeout(HELPER_OPERATION_TIMEOUT_MS),
    ]);

  const ensureCommandSession = async (cwd: string, signal: AbortSignal): Promise<string> => {
    const existing = commandSessions.get(cwd);
    if (existing) {
      return (await existing).id;
    }

    const sessionPromise = client
      .createSession(sandboxId, { cwd, signal })
      .then((id) => ({ id, cwd }))
      .catch((err) => {
        if (commandSessions.get(cwd) === sessionPromise) {
          commandSessions.delete(cwd);
        }
        throw err;
      });
    commandSessions.set(cwd, sessionPromise);
    return (await sessionPromise).id;
  };

  const resetCommandSession = async (cwd: string): Promise<void> => {
    const sessionPromise = commandSessions.get(cwd);
    commandSessions.delete(cwd);
    const session = await sessionPromise?.catch(() => undefined);
    if (session) {
      await client
        .deleteSession(sandboxId, session.id, AbortSignal.timeout(HELPER_OPERATION_TIMEOUT_MS))
        .catch(() => {});
    }
  };

  const scheduleCommandSessionReset = (cwd: string): void => {
    const cleanup = resetCommandSession(cwd);
    cleanupPromises.add(cleanup);
    void cleanup.then(
      () => cleanupPromises.delete(cleanup),
      () => cleanupPromises.delete(cleanup),
    );
  };

  const resetAllCommandSessions = async (): Promise<void> => {
    const sessionPromises = [...commandSessions.values()];
    commandSessions.clear();
    await Promise.all(
      sessionPromises.map(async (sessionPromise) => {
        const session = await sessionPromise.catch(() => undefined);
        if (session) {
          await client
            .deleteSession(sandboxId, session.id, AbortSignal.timeout(HELPER_OPERATION_TIMEOUT_MS))
            .catch(() => {});
        }
      }),
    );
  };

  const runQueued = async <T>(
    cwd: string,
    signal: AbortSignal,
    task: () => Promise<T>,
  ): Promise<T> => {
    assertActive();
    const previous = commandQueues.get(cwd) ?? Promise.resolve();
    const run = (async () => {
      await waitForQueue(previous, signal);
      signal.throwIfAborted();
      assertActive();
      return await task();
    })();
    const tail = run.then(
      () => undefined,
      () => undefined,
    );
    commandQueues.set(cwd, tail);
    try {
      return await run;
    } finally {
      if (commandQueues.get(cwd) === tail) {
        commandQueues.delete(cwd);
      }
    }
  };

  const runCommand = async (
    argv: [string, ...string[]],
    runOptions: {
      timeoutMs?: number;
      signal?: AbortSignal;
      cwd?: string;
      env?: Record<string, string>;
      maxCaptureBytes?: number;
      stdin?: Buffer;
    } = {},
  ): Promise<BashExecutionResult> => {
    assertActive();
    const cwd = runOptions.cwd ?? options.cwd;
    const timeoutSignal =
      runOptions.timeoutMs !== undefined &&
      Number.isFinite(runOptions.timeoutMs) &&
      runOptions.timeoutMs > 0
        ? AbortSignal.timeout(runOptions.timeoutMs)
        : undefined;
    const signal = AbortSignal.any(
      [disposeAbortController.signal, runOptions.signal, timeoutSignal].filter(
        (candidate): candidate is AbortSignal => candidate !== undefined,
      ),
    );
    const stdinPath =
      runOptions.stdin !== undefined ? `/tmp/tau-exec-${randomUUID()}.stdin` : undefined;
    let sessionAcquired = false;
    try {
      return await runQueued(cwd, signal, async () => {
        if (stdinPath && runOptions.stdin) {
          await client.writeFile(sandboxId, stdinPath, runOptions.stdin, signal);
        }
        const sessionId = await ensureCommandSession(cwd, signal);
        sessionAcquired = true;
        const executionArgv: [string, ...string[]] = stdinPath
          ? ["bash", "-c", 'exec "$@" < "$0"', stdinPath, ...argv]
          : argv;
        return await client.exec(sandboxId, {
          argv: applyCommandEnvironment(executionArgv, runOptions.env),
          cwd,
          timeoutMs: runOptions.timeoutMs,
          signal,
          maxCaptureBytes: runOptions.maxCaptureBytes,
          sessionId,
        });
      });
    } catch (error) {
      if (sessionAcquired && (signal.aborted || isAbortError(error))) {
        scheduleCommandSessionReset(cwd);
      }
      if (timeoutSignal?.aborted) {
        return terminatedExecutionResult(
          `(tau) timed out after ${runOptions.timeoutMs}ms`,
          "timeout",
        );
      }
      if (runOptions.signal?.aborted || disposeAbortController.signal.aborted) {
        return terminatedExecutionResult("(tau) aborted", "abort");
      }
      throw error;
    } finally {
      if (stdinPath) {
        await client
          .exec(sandboxId, {
            argv: ["rm", "-f", "--", stdinPath],
            cwd,
            timeoutMs: HELPER_OPERATION_TIMEOUT_MS,
            signal: AbortSignal.timeout(HELPER_OPERATION_TIMEOUT_MS),
            maxCaptureBytes: 1024,
          })
          .catch(() => {});
      }
    }
  };

  const runBash: ToolExecutionBackend["runBash"] = (command, runOptions = {}) =>
    runCommand(["bash", "-lc", applyBashCommand(command), ...(runOptions.args ?? [])], {
      ...runOptions,
      env: applyBashEnvironment(runOptions.env),
    });

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
    async dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      disposeAbortController.abort();
      await Promise.allSettled(commandQueues.values());
      await resetAllCommandSessions();
      await Promise.allSettled(cleanupPromises);
    },

    runBash,
    runNodeScript,

    async readFile(path) {
      assertActive();
      const content = await client.readFile(sandboxId, path, undefined, createHelperSignal());
      return { path, content: content.toString("utf-8") };
    },

    async readFileBinary(path, readOptions = {}) {
      assertActive();
      const content = await client.readFile(
        sandboxId,
        path,
        readOptions.maxBytes,
        createHelperSignal(),
      );
      const bytes = content.byteLength;
      assertFileWithinMaxBytes(bytes, readOptions.maxBytes);
      return { path, content, bytes };
    },

    async writeFile(path, content) {
      assertActive();
      const dir = dirname(path);
      if (dir && dir !== ".") {
        await runBash('exec "$0" "$@"', { args: ["mkdir", "-p", dir] });
      }
      await client.writeFile(sandboxId, path, Buffer.from(content, "utf-8"), createHelperSignal());
      return buildWriteFileResult(path, content);
    },

    async writeFileBinary(path, content) {
      assertActive();
      const dir = dirname(path);
      if (dir && dir !== ".") {
        await runBash('exec "$0" "$@"', { args: ["mkdir", "-p", dir] });
      }
      await client.writeFile(sandboxId, path, content, createHelperSignal());
      return { path, bytes: content.byteLength };
    },

    async listDir(path) {
      assertActive();
      const result = await runNodeScript(NODE_LIST_DIR_SCRIPT, [path]);
      if (result.exitCode !== 0) {
        throw new Error(result.output.trim() || `list failed for ${path}`);
      }
      const entries = JSON.parse(result.stdout) as ListDirEntry[];
      return { path, entries };
    },
  };
}

async function waitForQueue(queue: Promise<void>, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  await new Promise<void>((resolve, reject) => {
    const onAbort = () => {
      signal.removeEventListener("abort", onAbort);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
    void queue.then(
      () => {
        signal.removeEventListener("abort", onAbort);
        resolve();
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

export class CloudflareSandboxBridgeClient {
  private readonly bridgeId: string;
  private readonly baseUrl: string;
  private readonly apiKey?: string;
  private readonly fetch: typeof fetch;

  constructor(options: BridgeClientOptions) {
    this.bridgeId = options.bridgeId;
    this.baseUrl = options.baseUrl.replace(/\/+$/, "");
    this.apiKey = options.apiKey;
    this.fetch = options.fetch;
  }

  async exec(
    sandboxId: string,
    options: {
      argv: string[];
      cwd?: string;
      timeoutMs?: number;
      signal?: AbortSignal;
      maxCaptureBytes?: number;
      sessionId?: string;
    },
  ): Promise<BashExecutionResult> {
    const controller = new AbortController();
    const abort = () => controller.abort();
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.signal?.aborted) {
      controller.abort();
    }

    try {
      const response = await this.request(`/v1/sandbox/${encodeURIComponent(sandboxId)}/exec`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(options.sessionId ? { "Session-Id": options.sessionId } : {}),
        },
        body: JSON.stringify({
          argv: options.argv,
          ...(options.cwd ? { cwd: options.cwd } : {}),
          ...(options.timeoutMs !== undefined ? { timeout_ms: options.timeoutMs } : {}),
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        throw await this.createHttpError(response);
      }
      if (!response.body) {
        throw new Error(`Cloudflare Sandbox bridge '${this.bridgeId}' returned an empty exec body`);
      }

      return await parseExecSse(response.body, options.maxCaptureBytes);
    } finally {
      options.signal?.removeEventListener("abort", abort);
    }
  }

  async readFile(
    sandboxId: string,
    path: string,
    maxBytes?: number,
    signal?: AbortSignal,
  ): Promise<Buffer> {
    const response = await this.request(
      `/v1/sandbox/${encodeURIComponent(sandboxId)}/file/${encodeBridgeFilePath(path)}`,
      { method: "GET", signal },
    );
    if (!response.ok) {
      throw await this.createHttpError(response);
    }

    const contentLength = Number(response.headers.get("Content-Length"));
    if (Number.isFinite(contentLength)) {
      try {
        assertFileWithinMaxBytes(contentLength, maxBytes);
      } catch (error) {
        await response.body?.cancel().catch(() => {});
        throw error;
      }
    }
    if (!response.body) {
      return Buffer.alloc(0);
    }

    const reader = response.body.getReader();
    const chunks: Buffer[] = [];
    let bytes = 0;
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      const chunk = Buffer.from(value);
      bytes += chunk.byteLength;
      try {
        assertFileWithinMaxBytes(bytes, maxBytes);
      } catch (error) {
        await reader.cancel().catch(() => {});
        throw error;
      }
      chunks.push(chunk);
    }
    return Buffer.concat(chunks, bytes);
  }

  async writeFile(
    sandboxId: string,
    path: string,
    content: Buffer,
    signal?: AbortSignal,
  ): Promise<void> {
    const response = await this.request(
      `/v1/sandbox/${encodeURIComponent(sandboxId)}/file/${encodeBridgeFilePath(path)}`,
      { method: "PUT", body: Uint8Array.from(content), signal },
    );
    if (!response.ok) {
      throw await this.createHttpError(response);
    }
  }

  async createSession(
    sandboxId: string,
    options: { cwd: string; signal?: AbortSignal },
  ): Promise<string> {
    const response = await this.request(`/v1/sandbox/${encodeURIComponent(sandboxId)}/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: randomUUID(), cwd: options.cwd }),
      signal: options.signal,
    });
    if (!response.ok) {
      throw await this.createHttpError(response);
    }
    const body = (await response.json()) as { id?: unknown };
    if (typeof body.id !== "string" || !body.id) {
      throw new Error(`Cloudflare Sandbox bridge '${this.bridgeId}' returned an invalid session`);
    }
    return body.id;
  }

  async deleteSession(sandboxId: string, sessionId: string, signal?: AbortSignal): Promise<void> {
    const response = await this.request(
      `/v1/sandbox/${encodeURIComponent(sandboxId)}/session/${encodeURIComponent(sessionId)}`,
      { method: "DELETE", signal },
    );
    if (!response.ok) {
      throw await this.createHttpError(response);
    }
  }

  private request(path: string, init: RequestInit): Promise<Response> {
    return this.fetch(`${this.baseUrl}${path}`, {
      ...init,
      headers: {
        ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
        ...init.headers,
      },
    });
  }

  private async createHttpError(response: Response): Promise<Error> {
    let detail = "";
    try {
      const body = (await response.json()) as BridgeErrorBody;
      detail = body.error || body.code || "";
    } catch {
      detail = await response.text().catch(() => "");
    }
    return new Error(
      `Cloudflare Sandbox bridge '${this.bridgeId}' request failed (${response.status})${
        detail ? `: ${detail}` : ""
      }`,
    );
  }
}

function terminatedExecutionResult(note: string, reason: "timeout" | "abort"): BashExecutionResult {
  return {
    output: `${note}\n`,
    stdout: "",
    stderr: `${note}\n`,
    exitCode: null,
    truncated: false,
    timedOut: reason === "timeout",
    aborted: reason === "abort",
    closeSignal: null,
  };
}

async function parseExecSse(
  body: ReadableStream<Uint8Array>,
  maxCaptureBytes: number = DEFAULT_COMMAND_CAPTURE_BYTES,
): Promise<BashExecutionResult> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const output = new ExecCaptureBuffer(maxCaptureBytes);
  const stdout = new ExecCaptureBuffer(maxCaptureBytes);
  const stderr = new ExecCaptureBuffer(maxCaptureBytes);
  let exitCode: number | null = null;
  let truncated = false;

  const appendOutput = (target: "stdout" | "stderr", chunk: Buffer) => {
    truncated = output.append(chunk) || truncated;
    if (target === "stdout") {
      truncated = stdout.append(chunk) || truncated;
    } else {
      truncated = stderr.append(chunk) || truncated;
    }
  };

  const processEvent = (raw: string) => {
    const lines = raw.split("\n");
    let event = "message";
    const dataLines: string[] = [];
    for (const line of lines) {
      if (line.startsWith("event:")) {
        event = line.slice("event:".length).trim();
      } else if (line.startsWith("data:")) {
        dataLines.push(line.slice("data:".length).trimStart());
      }
    }
    const data = dataLines.join("\n");

    if (event === "stdout" || event === "stderr") {
      appendOutput(event, Buffer.from(data, "base64"));
    } else if (event === "exit") {
      const parsed = JSON.parse(data) as { exit_code?: unknown };
      exitCode = typeof parsed.exit_code === "number" ? parsed.exit_code : null;
    } else if (event === "error") {
      const parsed = JSON.parse(data) as BridgeErrorBody;
      throw new Error(parsed.error || parsed.code || "Cloudflare Sandbox exec failed");
    }
  };

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let splitIndex = buffer.indexOf("\n\n");
    while (splitIndex !== -1) {
      const raw = buffer.slice(0, splitIndex);
      buffer = buffer.slice(splitIndex + 2);
      if (raw.trim()) {
        processEvent(raw);
      }
      splitIndex = buffer.indexOf("\n\n");
    }
  }

  buffer += decoder.decode();
  if (buffer.trim()) {
    processEvent(buffer);
  }

  return {
    output: output.toString(),
    stdout: stdout.toString(),
    stderr: stderr.toString(),
    exitCode,
    truncated,
    timedOut: false,
    aborted: false,
    closeSignal: null,
  };
}

class ExecCaptureBuffer {
  private chunks: Buffer[] = [];
  private bytes = 0;

  constructor(private readonly maxBytes: number) {}

  append(value: Buffer): boolean {
    this.chunks.push(value);
    this.bytes += value.byteLength;
    let truncated = false;
    while (this.bytes > this.maxBytes && this.chunks.length > 0) {
      const excessBytes = this.bytes - this.maxBytes;
      const first = this.chunks[0]!;
      if (first.byteLength <= excessBytes) {
        this.chunks.shift();
        this.bytes -= first.byteLength;
      } else {
        this.chunks[0] = first.subarray(excessBytes);
        this.bytes -= excessBytes;
      }
      truncated = true;
    }
    return truncated;
  }

  toString(): string {
    return Buffer.concat(this.chunks, this.bytes).toString("utf-8");
  }
}

function encodeBridgeFilePath(path: string): string {
  return path
    .replace(/^\/+/, "")
    .split("/")
    .map((part) => encodeURIComponent(part))
    .join("/");
}

function isAbortError(err: unknown): boolean {
  return (
    typeof err === "object" &&
    err !== null &&
    "name" in err &&
    (err as { name?: unknown }).name === "AbortError"
  );
}
