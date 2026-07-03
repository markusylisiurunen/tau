import type { ChildProcessWithoutNullStreams } from "node:child_process";

import {
  parseSessionProtocolOutgoingLine,
  type SessionProtocolInitializeParams,
  type SessionProtocolMethod,
  type SessionProtocolParamsByMethod,
  type SessionProtocolReadyMessage,
  type SessionProtocolResultByMethod,
} from "../protocol/session_protocol.js";
import { TauProcessError, TauTransportError } from "./errors.js";
import {
  type PendingSessionProtocolRequest,
  PendingSessionProtocolRequests,
} from "./pending_session_protocol_requests.js";
import {
  createDeferred,
  handleSessionProtocolTransportParseFailure,
  handleSessionProtocolTransportResponse,
  notifySessionProtocolDeltaListeners,
  notifySessionProtocolEphemeralListeners,
  waitForPromiseOrTimeout,
  withTimeout,
} from "./session_protocol_transport_helpers.js";
import type {
  SessionProtocolDeltaListener,
  SessionProtocolEphemeralListener,
  SessionProtocolTransport,
} from "./session_transport.js";

type ProcessExitInfo = {
  code: number | null;
  signal: NodeJS.Signals | null;
};

export type SessionProtocolSpawnedProcess = ChildProcessWithoutNullStreams;

const CLOSE_TIMEOUT_MS = 2_000;

export class StdioSessionProtocolTransport implements SessionProtocolTransport {
  private readonly process;
  private readonly deltaListeners = new Set<SessionProtocolDeltaListener>();
  private readonly ephemeralListeners = new Set<SessionProtocolEphemeralListener>();
  private readonly pendingRequests = new PendingSessionProtocolRequests();
  private readonly readyDeferred = createDeferred<SessionProtocolReadyMessage>();
  private readonly exitDeferred = createDeferred<ProcessExitInfo>();

  private readyValue?: SessionProtocolReadyMessage;
  private readonly stdoutBuffer = new LineBuffer();
  private stderrBuffer = "";
  private connectPromise?: Promise<void>;
  private closePromise?: Promise<void>;
  private isConnected = false;
  private isClosed = false;
  private isExited = false;
  private fatalError?: Error;

  constructor(process: SessionProtocolSpawnedProcess) {
    this.process = process;

    this.process.stdout.setEncoding("utf8");
    this.process.stderr.setEncoding("utf8");

    this.process.stdout.on("data", this.handleStdoutData);
    this.process.stderr.on("data", this.handleStderrData);
    this.process.on("error", this.handleProcessError);
    this.process.on("exit", this.handleProcessExit);
    this.process.on("close", this.handleProcessClose);
  }

  get ready(): SessionProtocolReadyMessage {
    if (!this.readyValue) {
      throw new TauTransportError("tau sdk client is not connected");
    }

    return this.readyValue;
  }

  async connect(
    initializeParams: SessionProtocolInitializeParams,
    timeoutMs: number,
  ): Promise<void> {
    if (this.isClosed) {
      throw new TauTransportError("tau sdk client is closed");
    }

    if (this.fatalError) {
      throw this.fatalError;
    }

    if (this.isConnected) {
      return;
    }

    this.connectPromise ??= this.establishConnection(initializeParams, timeoutMs);
    await this.connectPromise;
  }

  private async establishConnection(
    initializeParams: SessionProtocolInitializeParams,
    timeoutMs: number,
  ): Promise<void> {
    const ready = await withTimeout(
      this.readyDeferred.promise,
      timeoutMs,
      new TauTransportError(
        `timed out waiting for session protocol ready message after ${timeoutMs}ms`,
      ),
    );

    this.readyValue = ready;
    await this.request("initialize", initializeParams);
    this.isConnected = true;
  }

  onDelta(listener: SessionProtocolDeltaListener): () => void {
    this.deltaListeners.add(listener);
    return () => {
      this.deltaListeners.delete(listener);
    };
  }

  onEphemeral(listener: SessionProtocolEphemeralListener): () => void {
    this.ephemeralListeners.add(listener);
    return () => {
      this.ephemeralListeners.delete(listener);
    };
  }

  request<M extends SessionProtocolMethod>(
    method: M,
    params: SessionProtocolParamsByMethod[M],
  ): Promise<SessionProtocolResultByMethod[M]> {
    if (this.isClosed) {
      return Promise.reject(new TauTransportError("tau sdk client is closed"));
    }

    if (this.fatalError) {
      return Promise.reject(this.fatalError);
    }

    let pending: PendingSessionProtocolRequest<M>;
    try {
      pending = this.pendingRequests.create(method, params);
    } catch (error) {
      return Promise.reject(error);
    }

    const payload = JSON.stringify(pending.request);
    const requestId = pending.request.id;
    try {
      this.process.stdin.write(`${payload}\n`, "utf8", (error) => {
        if (!error) {
          return;
        }

        this.pendingRequests.reject(
          requestId,
          new TauTransportError("failed to write request to tau rpc process", { cause: error }),
        );
      });
    } catch (error) {
      this.pendingRequests.reject(
        requestId,
        new TauTransportError("failed to write request to tau rpc process", { cause: error }),
      );
    }

    return pending.promise;
  }

  async close(): Promise<void> {
    if (this.closePromise) {
      return this.closePromise;
    }

    this.isClosed = true;

    const closeError = new TauTransportError("tau sdk client was closed");
    this.pendingRequests.rejectAll(closeError);
    this.rejectReadyIfPending(closeError);
    this.deltaListeners.clear();
    this.ephemeralListeners.clear();

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

        await waitForExitOrTimeout(this.exitDeferred.promise, CLOSE_TIMEOUT_MS);

        if (!this.isExited) {
          try {
            this.process.kill("SIGKILL");
          } catch {
            // ignore transport shutdown errors
          }

          await waitForExitOrTimeout(this.exitDeferred.promise, CLOSE_TIMEOUT_MS);
        }
      }

      this.process.off("error", this.handleProcessError);
      this.process.off("exit", this.handleProcessExit);
      this.process.off("close", this.handleProcessClose);
    })();

    return this.closePromise;
  }

  private readonly handleStdoutData = (chunk: string | Buffer): void => {
    for (const line of this.stdoutBuffer.push(chunk.toString())) {
      if (!line) {
        continue;
      }

      this.handleSessionProtocolLine(line);
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

  private handleSessionProtocolLine(line: string): void {
    const parsed = parseSessionProtocolOutgoingLine(line);
    if (!parsed.ok) {
      handleSessionProtocolTransportParseFailure({
        failure: parsed,
        pendingRequests: this.pendingRequests,
        failTransport: (error) => this.failTransport(error),
        malformedJsonPeer: "tau rpc process",
        invalidPayloadPeer: "tau process",
      });
      return;
    }

    const message = parsed.message;
    if (message.type === "ready") {
      if (!this.readyValue) {
        this.readyValue = message;
        this.readyDeferred.resolve(message);
      }
      return;
    }

    if (message.type === "session.delta") {
      notifySessionProtocolDeltaListeners(this.deltaListeners, message, {
        ignoreListenerErrors: true,
      });
      return;
    }

    if (message.type === "session.ephemeral") {
      notifySessionProtocolEphemeralListeners(this.ephemeralListeners, message, {
        ignoreListenerErrors: true,
      });
      return;
    }

    handleSessionProtocolTransportResponse(message, this.pendingRequests, (error) =>
      this.failTransport(error),
    );
  }

  private failTransport(error: Error): void {
    if (this.fatalError) {
      return;
    }

    this.fatalError = error;
    this.pendingRequests.rejectAll(error);
    this.rejectReadyIfPending(error);
  }

  private rejectReadyIfPending(error: Error): void {
    if (this.readyValue || !this.connectPromise) {
      return;
    }

    this.readyDeferred.reject(error);
  }
}

async function waitForExitOrTimeout(
  exitPromise: Promise<ProcessExitInfo>,
  timeoutMs: number,
): Promise<void> {
  await waitForPromiseOrTimeout(exitPromise, timeoutMs);
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

  private flushLine(): string {
    const line = this.chunks.length === 1 ? this.chunks[0]! : this.chunks.join("");
    this.chunks.length = 0;
    return line.trim();
  }
}
