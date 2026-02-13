import { spawn as spawnProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  RPC_ERROR_CODES,
  RPC_PROTOCOL_VERSION,
  type RpcInitializeParams,
  type RpcMethod,
  type RpcParamsByMethod,
  type RpcReadyMessage,
  type RpcRequestId,
  type RpcResultByMethod,
} from "../core/modes/rpc_protocol.js";
import { TauProcessError, TauRpcResponseError, TauTransportError } from "./errors.js";
import type {
  TauSdkClient,
  TauSdkClientOptions,
  TauSdkEvent,
  TauSdkEventListener,
  TauSdkSpawnFunction,
  TauSdkSubmitOptions,
} from "./types.js";

type PendingRequest = {
  readonly method: string;
  readonly requestId: RpcRequestId;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: unknown) => void;
};

const DEFAULT_CONNECT_TIMEOUT_MS = 5_000;
const DEFAULT_CLOSE_TIMEOUT_MS = 2_000;
const DEFAULT_MAIN_SCRIPT_PATH = fileURLToPath(new URL("../main.js", import.meta.url));

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
};

type ProcessExitInfo = {
  code: number | null;
  signal: NodeJS.Signals | null;
};

class TauSdkClientImpl implements TauSdkClient {
  private readonly process;
  private readonly eventListeners = new Set<TauSdkEventListener>();
  private readonly pendingRequests = new Map<RpcRequestId, PendingRequest>();
  private readonly readyDeferred = createDeferred<RpcReadyMessage>();
  private readonly exitDeferred = createDeferred<ProcessExitInfo>();

  private readonly closeTimeoutMs: number;
  private readyValue?: RpcReadyMessage;
  private stdoutBuffer = "";
  private stderrBuffer = "";
  private nextRequestId = 1;
  private closePromise?: Promise<void>;
  private shutdownPromise?: Promise<{ shutdown: true }>;
  private isClosed = false;
  private isExited = false;
  private fatalError?: Error;

  constructor(
    process: ReturnType<TauSdkSpawnFunction>,
    options: {
      connectTimeoutMs: number;
    },
  ) {
    this.process = process;
    this.closeTimeoutMs = Math.max(options.connectTimeoutMs, DEFAULT_CLOSE_TIMEOUT_MS);

    this.process.stdout.setEncoding("utf8");
    this.process.stderr.setEncoding("utf8");

    this.process.stdout.on("data", this.handleStdoutData);
    this.process.stderr.on("data", this.handleStderrData);
    this.process.on("error", this.handleProcessError);
    this.process.on("exit", this.handleProcessExit);
    this.process.on("close", this.handleProcessClose);
  }

  get ready(): RpcReadyMessage {
    if (!this.readyValue) {
      throw new TauTransportError("tau sdk client is not connected");
    }

    return this.readyValue;
  }

  async connect(initializeParams: RpcInitializeParams, timeoutMs: number): Promise<void> {
    const ready = await withTimeout(
      this.readyDeferred.promise,
      timeoutMs,
      new TauTransportError(`timed out waiting for rpc ready message after ${timeoutMs}ms`),
    );

    this.readyValue = ready;
    await this.request("initialize", initializeParams);
  }

  onEvent(listener: TauSdkEventListener): () => void {
    this.eventListeners.add(listener);
    return () => {
      this.eventListeners.delete(listener);
    };
  }

  submit(
    text: string,
    options: TauSdkSubmitOptions = {},
  ): Promise<RpcResultByMethod["session.submit"]> {
    return this.request("session.submit", {
      text,
      ...(options.historyEntryId === undefined ? {} : { historyEntryId: options.historyEntryId }),
    });
  }

  interrupt(): Promise<RpcResultByMethod["session.interrupt"]> {
    return this.request("session.interrupt", {});
  }

  snapshot(): Promise<RpcResultByMethod["session.snapshot"]> {
    return this.request("session.snapshot", {});
  }

  reset(): Promise<RpcResultByMethod["session.reset"]> {
    return this.request("session.reset", {});
  }

  async shutdown(): Promise<RpcResultByMethod["session.shutdown"]> {
    if (this.shutdownPromise) {
      return this.shutdownPromise;
    }

    if (this.isClosed) {
      this.shutdownPromise = Promise.resolve({ shutdown: true });
      return this.shutdownPromise;
    }

    this.shutdownPromise = (async () => {
      try {
        return await this.request("session.shutdown", {});
      } finally {
        await this.close();
      }
    })();

    return this.shutdownPromise;
  }

  async close(): Promise<void> {
    if (this.closePromise) {
      return this.closePromise;
    }

    this.isClosed = true;

    const closeError = new TauTransportError("tau sdk client was closed");
    this.failPendingRequests(closeError);
    this.rejectReadyIfPending(closeError);
    this.eventListeners.clear();

    this.process.stdout.off("data", this.handleStdoutData);
    this.process.stderr.off("data", this.handleStderrData);

    this.closePromise = (async () => {
      if (!this.isExited) {
        try {
          this.process.stdin.end();
        } catch {
          // ignore transport shutdown errors
        }

        try {
          this.process.kill("SIGTERM");
        } catch {
          // ignore transport shutdown errors
        }

        await Promise.race([
          this.exitDeferred.promise,
          delay(this.closeTimeoutMs).then(() => {
            if (!this.isExited) {
              try {
                this.process.kill("SIGKILL");
              } catch {
                // ignore
              }
            }
          }),
        ]);
      }

      this.process.off("error", this.handleProcessError);
      this.process.off("exit", this.handleProcessExit);
      this.process.off("close", this.handleProcessClose);
    })();

    return this.closePromise;
  }

  private request<M extends RpcMethod>(
    method: M,
    params: RpcParamsByMethod[M],
  ): Promise<RpcResultByMethod[M]> {
    if (this.isClosed) {
      return Promise.reject(new TauTransportError("tau sdk client is closed"));
    }

    if (this.fatalError) {
      return Promise.reject(this.fatalError);
    }

    const requestId = this.nextRequestId++;
    const payload = JSON.stringify({
      version: RPC_PROTOCOL_VERSION,
      type: "request",
      id: requestId,
      method,
      params,
    });

    return new Promise<RpcResultByMethod[M]>((resolve, reject) => {
      const pending: PendingRequest = {
        method,
        requestId,
        resolve: resolve as (value: unknown) => void,
        reject,
      };

      this.pendingRequests.set(requestId, pending);

      try {
        this.process.stdin.write(`${payload}\n`, "utf8", (error) => {
          if (!error) {
            return;
          }

          if (this.pendingRequests.get(requestId) !== pending) {
            return;
          }

          this.pendingRequests.delete(requestId);
          reject(
            new TauTransportError("failed to write request to tau rpc process", { cause: error }),
          );
        });
      } catch (error) {
        this.pendingRequests.delete(requestId);
        reject(
          new TauTransportError("failed to write request to tau rpc process", { cause: error }),
        );
      }
    });
  }

  private readonly handleStdoutData = (chunk: string | Buffer): void => {
    this.stdoutBuffer += chunk.toString();

    while (true) {
      const nextLineIndex = this.stdoutBuffer.indexOf("\n");
      if (nextLineIndex === -1) {
        break;
      }

      const line = this.stdoutBuffer.slice(0, nextLineIndex).trim();
      this.stdoutBuffer = this.stdoutBuffer.slice(nextLineIndex + 1);

      if (!line) {
        continue;
      }

      this.handleRpcLine(line);
    }
  };

  private readonly handleStderrData = (chunk: string | Buffer): void => {
    this.stderrBuffer += chunk.toString();
  };

  private readonly handleProcessError = (error: Error): void => {
    this.failTransport(
      new TauProcessError("tau rpc process transport failure", {
        stderr: this.stderrBuffer,
        cause: error,
      }),
    );
  };

  private readonly handleProcessExit = (
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void => {
    this.onProcessTerminated({ code, signal });
  };

  private readonly handleProcessClose = (
    code: number | null,
    signal: NodeJS.Signals | null,
  ): void => {
    this.onProcessTerminated({ code, signal });
  };

  private onProcessTerminated(exit: ProcessExitInfo): void {
    if (!this.isExited) {
      this.isExited = true;
      this.exitDeferred.resolve(exit);
    }

    if (this.isClosed) {
      return;
    }

    this.isClosed = true;

    const message = [
      "tau rpc process exited unexpectedly",
      `code=${exit.code ?? "null"}`,
      `signal=${exit.signal ?? "null"}`,
    ].join(" ");

    this.failTransport(
      new TauProcessError(message, {
        exitCode: exit.code,
        signal: exit.signal,
        stderr: this.stderrBuffer,
      }),
    );
  }

  private handleRpcLine(line: string): void {
    let message: unknown;
    try {
      message = JSON.parse(line);
    } catch (error) {
      this.failTransport(
        new TauTransportError("received malformed JSON from tau rpc process", { cause: error }),
      );
      return;
    }

    if (!isRecord(message)) {
      this.failTransport(new TauTransportError("received non-object rpc payload from tau process"));
      return;
    }

    if (message.version !== RPC_PROTOCOL_VERSION) {
      this.failTransport(
        new TauTransportError(
          `received unsupported rpc version from tau process: ${String(message.version)}`,
        ),
      );
      return;
    }

    if (message.type === "ready") {
      if (typeof message.sessionId !== "string") {
        this.failTransport(
          new TauTransportError("received invalid ready payload from tau process"),
        );
        return;
      }

      if (!Array.isArray(message.methods)) {
        this.failTransport(
          new TauTransportError("received invalid ready payload from tau process"),
        );
        return;
      }

      if (!this.readyValue) {
        const readyMessage = message as RpcReadyMessage;
        this.readyValue = readyMessage;
        this.readyDeferred.resolve(readyMessage);
      }
      return;
    }

    if (message.type === "event") {
      if (!isRecord(message.event)) {
        this.failTransport(
          new TauTransportError("received invalid event payload from tau process"),
        );
        return;
      }

      const event = message as TauSdkEvent;
      for (const listener of [...this.eventListeners]) {
        try {
          listener(event);
        } catch {
          // ignore listener errors so transport handling can continue
        }
      }
      return;
    }

    if (message.type === "response") {
      this.handleResponse(message);
      return;
    }

    this.failTransport(
      new TauTransportError(`received unsupported rpc message type: ${String(message.type)}`),
    );
  }

  private handleResponse(message: Record<string, unknown>): void {
    const requestId = parseRequestId(message.id);
    if (!requestId.ok) {
      this.failTransport(new TauTransportError("received response without a valid request id"));
      return;
    }

    if (requestId.id === null) {
      this.failTransport(new TauTransportError("received uncorrelated rpc error response"));
      return;
    }

    const pending = this.pendingRequests.get(requestId.id);
    if (!pending) {
      return;
    }

    this.pendingRequests.delete(requestId.id);

    if (message.ok === true) {
      pending.resolve(message.result);
      return;
    }

    if (!isRecord(message.error)) {
      pending.reject(new TauTransportError("received malformed rpc error response"));
      return;
    }

    const code = message.error.code;
    const rpcMessage = message.error.message;
    if (!isRpcErrorCode(code) || typeof rpcMessage !== "string") {
      pending.reject(new TauTransportError("received malformed rpc error response"));
      return;
    }

    pending.reject(
      new TauRpcResponseError({
        requestId: requestId.id,
        error: {
          code,
          message: rpcMessage,
          ...("data" in message.error ? { data: message.error.data } : {}),
        },
      }),
    );
  }

  private failTransport(error: Error): void {
    if (this.fatalError) {
      return;
    }

    this.fatalError = error;
    this.failPendingRequests(error);
    this.rejectReadyIfPending(error);
  }

  private rejectReadyIfPending(error: Error): void {
    if (this.readyValue) {
      return;
    }

    this.readyDeferred.reject(error);
  }

  private failPendingRequests(error: Error): void {
    for (const pending of this.pendingRequests.values()) {
      pending.reject(error);
    }
    this.pendingRequests.clear();
  }
}

export async function createTauSdkClient(options: TauSdkClientOptions = {}): Promise<TauSdkClient> {
  const spawn = options.spawn ?? spawnProcess;
  const command = options.executable ?? process.execPath;
  const args = buildProcessArgs(options);

  const env = options.env ? { ...process.env, ...options.env } : process.env;

  let childProcess: ReturnType<TauSdkSpawnFunction>;
  try {
    childProcess = spawn(command, args, {
      cwd: options.cwd,
      env,
      stdio: "pipe",
    });
  } catch (error) {
    throw new TauProcessError("failed to spawn tau rpc process", { cause: error });
  }

  const client = new TauSdkClientImpl(childProcess, {
    connectTimeoutMs: options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
  });

  try {
    await client.connect(
      options.initialize ?? {},
      options.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS,
    );
    return client;
  } catch (error) {
    await client.close();
    throw error;
  }
}

function buildProcessArgs(options: TauSdkClientOptions): string[] {
  const scriptPath =
    options.scriptPath === undefined ? DEFAULT_MAIN_SCRIPT_PATH : options.scriptPath;
  return [
    ...(options.executableArgs ?? []),
    ...(scriptPath ? [scriptPath] : []),
    ...(options.scriptArgs ?? []),
    "rpc",
    ...(options.persona ? ["--persona", options.persona] : []),
    ...(options.riskLevel ? ["--risk", options.riskLevel] : []),
    ...(options.sandbox ? ["--sandbox"] : []),
    ...(options.noAgentContextFiles ? ["--no-agent-context-files"] : []),
    ...(options.rpcArgs ?? []),
  ];
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;

  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });

  return { promise, resolve, reject };
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, timeoutError: Error): Promise<T> {
  const timeoutPromise = new Promise<T>((_, reject) => {
    const timeout = setTimeout(() => reject(timeoutError), timeoutMs);
    timeout.unref?.();
  });

  return Promise.race([promise, timeoutPromise]);
}

function delay(timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    const timeout = setTimeout(resolve, timeoutMs);
    timeout.unref?.();
  });
}

function parseRequestId(value: unknown): { ok: true; id: RpcRequestId | null } | { ok: false } {
  if (value === null || typeof value === "string" || typeof value === "number") {
    return { ok: true, id: value };
  }

  return { ok: false };
}

function isRpcErrorCode(
  value: unknown,
): value is (typeof RPC_ERROR_CODES)[keyof typeof RPC_ERROR_CODES] {
  return typeof value === "string" && (Object.values(RPC_ERROR_CODES) as string[]).includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
