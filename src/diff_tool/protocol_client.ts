import { once } from "node:events";
import { createConnection, type Socket } from "node:net";
import { createInterface, type Interface } from "node:readline";
import type {
  DiffReviewClientMethod,
  DiffReviewErrorCode,
  DiffReviewMessage,
  DiffReviewParamsByMethod,
  DiffReviewRequestId,
  DiffReviewRequestMessage,
  DiffReviewResponseMessage,
  DiffReviewResultByMethod,
} from "../core/diff_review/index.js";
import {
  createDiffReviewErrorResponse,
  createDiffReviewSuccessResponse,
  DIFF_REVIEW_PROTOCOL_VERSION,
  parseDiffReviewMessageLine,
  serializeDiffReviewMessage,
} from "../core/diff_review/index.js";

export type DiffToolLaunchEnvironment = {
  protocolVersion: number;
  socketPath: string;
  token: string;
  sessionId?: string;
  repoRoot?: string;
  cwd?: string;
  diffArgs: string[];
};

export class DiffToolLaunchEnvironmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "DiffToolLaunchEnvironmentError";
  }
}

type PendingRequest = {
  resolve: (result: unknown) => void;
  reject: (error: Error) => void;
};

type CloseListener = () => void;
type SessionCloseListener = () => void | Promise<void>;

export class DiffReviewProtocolClientError extends Error {
  readonly code: DiffReviewErrorCode;
  readonly data?: unknown;

  constructor(code: DiffReviewErrorCode, message: string, data?: unknown) {
    super(message);
    this.name = "DiffReviewProtocolClientError";
    this.code = code;
    this.data = data;
  }
}

export class DiffReviewProtocolClient {
  private readonly launchEnvironment: DiffToolLaunchEnvironment;
  private socket?: Socket;
  private readline?: Interface;
  private readonly pendingRequests = new Map<DiffReviewRequestId, PendingRequest>();
  private readonly closeListeners = new Set<CloseListener>();
  private readonly sessionCloseListeners = new Set<SessionCloseListener>();
  private connectPromise?: Promise<void>;
  private writeQueue: Promise<void> = Promise.resolve();
  private requestCounter = 0;
  private closed = false;
  private sessionClosing = false;
  private closeNotified = false;

  constructor(launchEnvironment: DiffToolLaunchEnvironment) {
    this.launchEnvironment = launchEnvironment;
  }

  async connect(): Promise<void> {
    if (this.closed) {
      throw new Error("diff review protocol client is closed");
    }
    if (this.sessionClosing) {
      throw new Error("diff review protocol client is closing");
    }

    if (!this.connectPromise) {
      this.connectPromise = this.connectInternal().catch((error) => {
        this.connectPromise = undefined;
        throw error;
      });
    }

    await this.connectPromise;
  }

  onClose(listener: CloseListener): () => void {
    this.closeListeners.add(listener);
    return () => {
      this.closeListeners.delete(listener);
    };
  }

  onSessionClose(listener: SessionCloseListener): () => void {
    this.sessionCloseListeners.add(listener);
    return () => {
      this.sessionCloseListeners.delete(listener);
    };
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }

    this.closed = true;
    this.sessionClosing = true;
    this.rejectAllPending(new Error("diff review protocol client closed"));
    this.notifyCloseListeners();

    const socket = this.socket;
    const readline = this.readline;
    this.socket = undefined;
    this.readline = undefined;
    this.connectPromise = undefined;
    this.writeQueue = Promise.resolve();

    readline?.close();
    if (!socket) {
      return;
    }

    const closePromise = once(socket, "close").catch(() => undefined);
    socket.destroy();
    await closePromise;
  }

  async getContext(): Promise<DiffReviewResultByMethod["session.get_context"]> {
    return await this.call("session.get_context", {});
  }

  async listFiles(): Promise<DiffReviewResultByMethod["session.list_files"]> {
    return await this.call("session.list_files", {});
  }

  async getDiff(
    params: DiffReviewParamsByMethod["session.get_diff"] = {},
  ): Promise<DiffReviewResultByMethod["session.get_diff"]> {
    return await this.call("session.get_diff", params);
  }

  async setUiText(
    params: DiffReviewParamsByMethod["session.set_ui_text"],
  ): Promise<DiffReviewResultByMethod["session.set_ui_text"]> {
    return await this.call("session.set_ui_text", params);
  }

  async submitThreadMessage(
    params: DiffReviewParamsByMethod["thread.submit_message"],
  ): Promise<DiffReviewResultByMethod["thread.submit_message"]> {
    return await this.call("thread.submit_message", params);
  }

  async returnReview(
    params: DiffReviewParamsByMethod["session.return_review"],
  ): Promise<DiffReviewResultByMethod["session.return_review"]> {
    return await this.call("session.return_review", params);
  }

  async cancelSession(): Promise<DiffReviewResultByMethod["session.cancel"]> {
    return await this.call("session.cancel", {});
  }

  private async call<M extends DiffReviewClientMethod>(
    method: M,
    params: DiffReviewParamsByMethod[M],
    options: { skipConnect?: boolean } = {},
  ): Promise<DiffReviewResultByMethod[M]> {
    if (this.closed) {
      throw new Error("diff review protocol client is closed");
    }
    if (this.sessionClosing) {
      throw new Error("diff review protocol client is closing");
    }

    if (!options.skipConnect) {
      await this.connect();
    }

    const socket = this.socket;
    if (!socket || socket.destroyed) {
      throw new Error("diff review protocol socket is not available");
    }

    const id = `req-${++this.requestCounter}`;
    const request = {
      version: DIFF_REVIEW_PROTOCOL_VERSION,
      type: "request",
      id,
      method,
      params,
    } as DiffReviewRequestMessage;

    return await new Promise<DiffReviewResultByMethod[M]>((resolve, reject) => {
      this.pendingRequests.set(id, {
        resolve: (result) => resolve(result as DiffReviewResultByMethod[M]),
        reject,
      });

      const writePromise = this.writeQueue.then(() => this.writeMessage(socket, request));
      this.writeQueue = writePromise.catch(() => {});
      void writePromise.catch((error) => {
        const pending = this.pendingRequests.get(id);
        if (!pending) {
          return;
        }

        this.pendingRequests.delete(id);
        pending.reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }

  private async writeMessage(socket: Socket, message: DiffReviewMessage): Promise<void> {
    if (
      this.closed ||
      this.socket !== socket ||
      socket.destroyed ||
      socket.writableEnded ||
      !socket.writable
    ) {
      throw new Error("diff review protocol socket is not available");
    }

    const payload = serializeDiffReviewMessage(message);
    await new Promise<void>((resolve, reject) => {
      let settled = false;
      const finish = (callback: () => void) => {
        if (settled) {
          return;
        }
        settled = true;
        socket.off("close", onClose);
        socket.off("error", onError);
        callback();
      };
      const onClose = () => {
        finish(() => {
          reject(new Error("diff review protocol connection closed"));
        });
      };
      const onError = (error: Error) => {
        finish(() => {
          reject(normalizeSocketWriteError(error));
        });
      };

      socket.once("close", onClose);
      socket.once("error", onError);

      try {
        socket.write(payload, (error) => {
          if (error) {
            finish(() => {
              reject(normalizeSocketWriteError(error));
            });
            return;
          }
          finish(resolve);
        });
      } catch (error) {
        finish(() => {
          reject(normalizeSocketWriteError(error));
        });
      }
    });
  }

  private async connectInternal(): Promise<void> {
    const socket = createConnection(this.launchEnvironment.socketPath);
    const readline = createInterface({ input: socket, crlfDelay: Number.POSITIVE_INFINITY });
    this.socket = socket;
    this.readline = readline;

    readline.on("line", (line) => {
      void this.handleLine(line);
    });
    readline.on("error", () => {});

    socket.on("close", () => {
      this.rejectAllPending(new Error("diff review protocol connection closed"));
      this.socket = undefined;
      this.readline = undefined;
      this.connectPromise = undefined;
      this.writeQueue = Promise.resolve();
      this.notifyCloseListeners();
    });

    socket.on("error", (error) => {
      this.rejectAllPending(normalizeSocketWriteError(error));
    });

    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        socket.off("connect", onConnect);
        reject(error);
      };
      const onConnect = () => {
        socket.off("error", onError);
        resolve();
      };

      socket.once("error", onError);
      socket.once("connect", onConnect);
    });
    await this.initialize();
  }

  private async initialize(): Promise<void> {
    const result = await this.call(
      "initialize",
      { token: this.launchEnvironment.token },
      { skipConnect: true },
    );
    if (result.protocolVersion !== DIFF_REVIEW_PROTOCOL_VERSION) {
      throw new Error(
        `unsupported diff review protocol version: ${String(result.protocolVersion)}`,
      );
    }
  }

  private async handleLine(line: string): Promise<void> {
    const parsed = parseDiffReviewMessageLine(line);
    if (!parsed.ok) {
      this.rejectAllPending(new Error(parsed.error.message));
      return;
    }

    if (parsed.message.type === "response") {
      this.handleResponse(parsed.message);
      return;
    }

    await this.handleRequest(parsed.message);
  }

  private handleResponse(message: DiffReviewResponseMessage): void {
    if (message.id === null) {
      this.rejectAllPending(new Error("diff review response did not include a request id"));
      return;
    }

    const pending = this.pendingRequests.get(message.id);
    if (!pending) {
      return;
    }

    this.pendingRequests.delete(message.id);
    if (message.ok) {
      pending.resolve(message.result);
      return;
    }

    pending.reject(
      new DiffReviewProtocolClientError(
        message.error.code,
        message.error.message,
        message.error.data,
      ),
    );
  }

  private async handleRequest(message: DiffReviewRequestMessage): Promise<void> {
    if (message.method !== "session.close") {
      await this.sendResponse(
        createDiffReviewErrorResponse(
          message.id,
          "method_not_found",
          `unsupported diff review method '${message.method}'`,
        ),
      );
      return;
    }

    if (!this.sessionClosing) {
      this.sessionClosing = true;
    }

    await this.sendResponse(createDiffReviewSuccessResponse(message.id, { status: "closed" }));

    try {
      await this.notifySessionCloseListeners();
    } finally {
      await this.close();
    }
  }

  private async sendResponse(message: DiffReviewResponseMessage): Promise<void> {
    const socket = this.socket;
    if (!socket || socket.destroyed) {
      return;
    }

    try {
      const writePromise = this.writeQueue.then(() => this.writeMessage(socket, message));
      this.writeQueue = writePromise.catch(() => {});
      await writePromise;
    } catch {
      if (!socket.destroyed) {
        socket.destroy();
      }
    }
  }

  private rejectAllPending(error: Error): void {
    for (const [id, pending] of this.pendingRequests) {
      this.pendingRequests.delete(id);
      pending.reject(error);
    }
  }

  private async notifySessionCloseListeners(): Promise<void> {
    for (const listener of this.sessionCloseListeners) {
      await listener();
    }
  }

  private notifyCloseListeners(): void {
    if (this.closeNotified) {
      return;
    }

    this.closeNotified = true;
    for (const listener of this.closeListeners) {
      listener();
    }
  }
}

function normalizeSocketWriteError(error: unknown): Error {
  if (
    error &&
    typeof error === "object" &&
    "code" in error &&
    (error.code === "EPIPE" || error.code === "ECONNRESET")
  ) {
    return new Error("diff review protocol connection closed");
  }

  return error instanceof Error ? error : new Error(String(error));
}

export function parseDiffToolLaunchEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): DiffToolLaunchEnvironment {
  const socketPath = env.TAU_DIFF_SOCKET?.trim();
  if (!socketPath) {
    throw new DiffToolLaunchEnvironmentError(
      "missing TAU_DIFF_SOCKET from the Tau diff review session environment",
    );
  }

  const token = env.TAU_DIFF_TOKEN?.trim();
  if (!token) {
    throw new DiffToolLaunchEnvironmentError(
      "missing TAU_DIFF_TOKEN from the Tau diff review session environment",
    );
  }

  const protocolVersionRaw = env.TAU_DIFF_PROTOCOL_VERSION?.trim();
  const protocolVersion = Number(protocolVersionRaw);
  if (!Number.isInteger(protocolVersion)) {
    throw new DiffToolLaunchEnvironmentError("TAU_DIFF_PROTOCOL_VERSION must be an integer");
  }

  if (protocolVersion !== DIFF_REVIEW_PROTOCOL_VERSION) {
    throw new DiffToolLaunchEnvironmentError(
      `unsupported diff review protocol version: ${String(protocolVersion)}`,
    );
  }

  let diffArgs: string[] = [];
  const diffArgsJson = env.TAU_DIFF_ARGS_JSON;
  if (diffArgsJson?.trim()) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(diffArgsJson);
    } catch (error) {
      throw new DiffToolLaunchEnvironmentError(
        `TAU_DIFF_ARGS_JSON must be valid json: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== "string")) {
      throw new DiffToolLaunchEnvironmentError("TAU_DIFF_ARGS_JSON must be a json string array");
    }

    diffArgs = [...parsed];
  }

  return {
    protocolVersion,
    socketPath,
    token,
    sessionId: env.TAU_DIFF_SESSION_ID?.trim() || undefined,
    repoRoot: env.TAU_DIFF_REPO_ROOT?.trim() || undefined,
    cwd: env.TAU_DIFF_CWD?.trim() || undefined,
    diffArgs,
  };
}
