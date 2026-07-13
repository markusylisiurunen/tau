import { randomUUID } from "node:crypto";
import { dirname } from "node:path/posix";
import type {
  BashExecutionResult,
  GrepExecutionResult,
  ListDirEntry,
  ToolExecutionBackend,
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
  buildSandboxGrepDryRunResult,
  buildSandboxGrepErrorResult,
  buildWriteFileResult,
  NODE_LIST_DIR_SCRIPT,
  resolveSandboxGrepPaths,
  shellQuote,
} from "./sandbox_tool_helpers.js";
import { ToolBackendExecutionEnvironment } from "./tool_backend_execution_environment.js";

const BASH_MAX_CAPTURE_BYTES = 1024 * 1024;
const DEFAULT_HOME = "/home/sandbox";

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
  const disposeAbortController = new AbortController();
  let disposed = false;

  const assertActive = (): void => {
    if (disposed) {
      throw new Error("Cloudflare Sandbox execution backend is disposed");
    }
  };

  const ensureCommandSession = async (cwd: string): Promise<string> => {
    const existing = commandSessions.get(cwd);
    if (existing) {
      return (await existing).id;
    }

    const sessionPromise = client
      .createSession(sandboxId, { cwd })
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
      await client.deleteSession(sandboxId, session.id).catch(() => {});
    }
  };

  const resetAllCommandSessions = async (): Promise<void> => {
    const sessionPromises = [...commandSessions.values()];
    commandSessions.clear();
    await Promise.all(
      sessionPromises.map(async (sessionPromise) => {
        const session = await sessionPromise.catch(() => undefined);
        if (session) {
          await client.deleteSession(sandboxId, session.id).catch(() => {});
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

  const exec = async (
    command: string,
    runOptions: { timeoutMs?: number; signal?: AbortSignal; cwd?: string } = {},
  ): Promise<BashExecutionResult> => {
    const cwd = runOptions.cwd ?? options.cwd;
    const signal = runOptions.signal
      ? AbortSignal.any([runOptions.signal, disposeAbortController.signal])
      : disposeAbortController.signal;
    return await runQueued(cwd, signal, async () => {
      const sessionId = await ensureCommandSession(cwd);

      try {
        return await client.exec(sandboxId, {
          argv: ["sh", "-lc", command],
          cwd,
          timeoutMs: runOptions.timeoutMs,
          signal,
          sessionId,
          onAbort: () => resetCommandSession(cwd),
        });
      } catch (err) {
        if (isAbortError(err)) {
          await resetCommandSession(cwd);
        }
        throw err;
      }
    });
  };

  return {
    async dispose() {
      if (disposed) {
        return;
      }
      disposed = true;
      disposeAbortController.abort();
      await Promise.allSettled(commandQueues.values());
      await resetAllCommandSessions();
    },

    runBash: exec,

    async runNodeScript(script, args = [], runOptions = {}) {
      const cwd = runOptions.cwd ?? options.cwd;
      const signal = runOptions.signal
        ? AbortSignal.any([runOptions.signal, disposeAbortController.signal])
        : disposeAbortController.signal;
      return await runQueued(cwd, signal, async () => {
        const sessionId = await ensureCommandSession(cwd);

        try {
          return await client.exec(sandboxId, {
            argv: ["node", "-e", script, ...args],
            cwd,
            timeoutMs: runOptions.timeoutMs,
            signal,
            maxCaptureBytes: runOptions.maxCaptureBytes,
            sessionId,
            onAbort: () => resetCommandSession(cwd),
          });
        } catch (err) {
          if (isAbortError(err)) {
            await resetCommandSession(cwd);
          }
          throw err;
        }
      });
    },

    async readFile(path) {
      assertActive();
      const content = await client.readFile(sandboxId, path);
      return { path, content: content.toString("utf-8") };
    },

    async readFileBinary(path, readOptions = {}) {
      assertActive();
      const content = await client.readFile(sandboxId, path);
      const bytes = content.byteLength;
      assertFileWithinMaxBytes(bytes, readOptions.maxBytes);
      return { path, content, bytes };
    },

    async writeFile(path, content) {
      assertActive();
      const dir = dirname(path);
      if (dir && dir !== ".") {
        await exec(`mkdir -p ${shellQuote(dir)}`);
      }
      await client.writeFile(sandboxId, path, Buffer.from(content, "utf-8"));
      return buildWriteFileResult(path, content);
    },

    async writeFileBinary(path, content) {
      assertActive();
      const dir = dirname(path);
      if (dir && dir !== ".") {
        await exec(`mkdir -p ${shellQuote(dir)}`);
      }
      await client.writeFile(sandboxId, path, content);
      return { path, bytes: content.byteLength };
    },

    async listDir(path) {
      assertActive();
      const result = await exec(`node -e ${shellQuote(NODE_LIST_DIR_SCRIPT)} ${shellQuote(path)}`);
      if (result.exitCode !== 0) {
        throw new Error(result.output.trim() || `list failed for ${path}`);
      }
      const entries = JSON.parse(result.output) as ListDirEntry[];
      return { path, entries };
    },

    async grep(grepOptions) {
      assertActive();
      const resolvedPaths = resolveSandboxGrepPaths(grepOptions.paths);

      if (grepOptions.dryRun) {
        return buildSandboxGrepDryRunResult(resolvedPaths);
      }

      const command = ["rg", ...grepOptions.baseArgs, "--", grepOptions.pattern, ...resolvedPaths]
        .map(shellQuote)
        .join(" ");
      try {
        const result = await exec(command, {
          timeoutMs: grepOptions.timeoutMs,
          signal: grepOptions.signal,
        });
        return {
          output: result.output,
          exitCode: result.exitCode,
          captureTruncated: result.truncated,
          resolvedPaths,
        } satisfies GrepExecutionResult;
      } catch (err) {
        return buildSandboxGrepErrorResult(err, resolvedPaths);
      }
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
      maxCaptureBytes?: number | null;
      sessionId?: string;
      onAbort?: () => Promise<void>;
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
    } catch (err) {
      if (isAbortError(err) && options.onAbort) {
        await options.onAbort();
      }
      throw err;
    } finally {
      options.signal?.removeEventListener("abort", abort);
    }
  }

  async readFile(sandboxId: string, path: string): Promise<Buffer> {
    const response = await this.request(
      `/v1/sandbox/${encodeURIComponent(sandboxId)}/file/${encodeBridgeFilePath(path)}`,
      { method: "GET" },
    );
    if (!response.ok) {
      throw await this.createHttpError(response);
    }
    return Buffer.from(await response.arrayBuffer());
  }

  async writeFile(sandboxId: string, path: string, content: Buffer): Promise<void> {
    const response = await this.request(
      `/v1/sandbox/${encodeURIComponent(sandboxId)}/file/${encodeBridgeFilePath(path)}`,
      { method: "PUT", body: content },
    );
    if (!response.ok) {
      throw await this.createHttpError(response);
    }
  }

  async createSession(sandboxId: string, options: { cwd: string }): Promise<string> {
    const response = await this.request(`/v1/sandbox/${encodeURIComponent(sandboxId)}/session`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ id: randomUUID(), cwd: options.cwd }),
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

  async deleteSession(sandboxId: string, sessionId: string): Promise<void> {
    const response = await this.request(
      `/v1/sandbox/${encodeURIComponent(sandboxId)}/session/${encodeURIComponent(sessionId)}`,
      { method: "DELETE" },
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

async function parseExecSse(
  body: ReadableStream<Uint8Array>,
  maxCaptureBytes: number | null = BASH_MAX_CAPTURE_BYTES,
): Promise<BashExecutionResult> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const output = new ExecCaptureBuffer(maxCaptureBytes);
  const stdout = new ExecCaptureBuffer(maxCaptureBytes);
  const stderr = new ExecCaptureBuffer(maxCaptureBytes);
  let exitCode: number | null = null;
  let truncated = false;

  const appendOutput = (target: "stdout" | "stderr", chunk: string) => {
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
      appendOutput(event, Buffer.from(data, "base64").toString("utf-8"));
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
  };
}

class ExecCaptureBuffer {
  private chunks: Buffer[] = [];
  private bytes = 0;

  constructor(private readonly maxBytes: number | null) {}

  append(value: string): boolean {
    let truncated = false;
    let nextValue = value;
    if (this.maxBytes !== null && Buffer.byteLength(nextValue, "utf-8") > this.maxBytes) {
      truncated = true;
      while (Buffer.byteLength(nextValue, "utf-8") > this.maxBytes) {
        nextValue = nextValue.slice(Math.max(1, Math.floor(nextValue.length / 10)));
      }
    }

    let chunk = Buffer.from(nextValue, "utf-8");
    if (this.maxBytes !== null && chunk.byteLength > this.maxBytes) {
      chunk = chunk.subarray(chunk.byteLength - this.maxBytes);
      truncated = true;
    }

    this.chunks.push(chunk);
    this.bytes += chunk.byteLength;
    while (this.maxBytes !== null && this.bytes > this.maxBytes && this.chunks.length > 0) {
      const removed = this.chunks.shift()!;
      this.bytes -= removed.byteLength;
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
