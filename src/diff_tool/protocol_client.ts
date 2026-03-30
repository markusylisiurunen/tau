import { once } from "node:events";
import { createConnection, type Socket } from "node:net";
import { createInterface, type Interface } from "node:readline";
import type {
  DiffReviewErrorCode,
  DiffReviewMethod,
  DiffReviewParamsByMethod,
  DiffReviewRequestId,
  DiffReviewResponseMessage,
  DiffReviewResultByMethod,
} from "../core/diff_review/index.js";
import { DIFF_REVIEW_PROTOCOL_VERSION } from "../core/diff_review/index.js";

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
  private connectPromise?: Promise<void>;
  private requestCounter = 0;
  private closed = false;
  private closeNotified = false;

  constructor(launchEnvironment: DiffToolLaunchEnvironment) {
    this.launchEnvironment = launchEnvironment;
  }

  async connect(): Promise<void> {
    if (this.closed) {
      throw new Error("diff review protocol client is closed");
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

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }

    this.closed = true;
    this.rejectAllPending(new Error("diff review protocol client closed"));
    this.notifyCloseListeners();

    const socket = this.socket;
    const readline = this.readline;
    this.socket = undefined;
    this.readline = undefined;
    this.connectPromise = undefined;

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

  private async call<M extends DiffReviewMethod>(
    method: M,
    params: DiffReviewParamsByMethod[M],
    options: { skipConnect?: boolean } = {},
  ): Promise<DiffReviewResultByMethod[M]> {
    if (!options.skipConnect) {
      await this.connect();
    }

    const socket = this.socket;
    if (!socket || socket.destroyed) {
      throw new Error("diff review protocol socket is not available");
    }

    const id = `req-${++this.requestCounter}`;
    const requestLine = `${JSON.stringify({
      version: DIFF_REVIEW_PROTOCOL_VERSION,
      type: "request",
      id,
      method,
      params,
    })}\n`;

    return await new Promise<DiffReviewResultByMethod[M]>((resolve, reject) => {
      this.pendingRequests.set(id, {
        resolve: (result) => resolve(result as DiffReviewResultByMethod[M]),
        reject,
      });

      socket.write(requestLine, (error) => {
        if (!error) {
          return;
        }

        const pending = this.pendingRequests.get(id);
        if (!pending) {
          return;
        }

        this.pendingRequests.delete(id);
        pending.reject(error);
      });
    });
  }

  private async connectInternal(): Promise<void> {
    const socket = createConnection(this.launchEnvironment.socketPath);
    const readline = createInterface({ input: socket, crlfDelay: Number.POSITIVE_INFINITY });
    this.socket = socket;
    this.readline = readline;

    readline.on("line", (line) => {
      this.handleResponseLine(line);
    });

    socket.on("close", () => {
      this.rejectAllPending(new Error("diff review protocol connection closed"));
      this.socket = undefined;
      this.readline = undefined;
      this.connectPromise = undefined;
      this.notifyCloseListeners();
    });

    socket.on("error", (error) => {
      this.rejectAllPending(error);
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

  private handleResponseLine(line: string): void {
    let message: DiffReviewResponseMessage;
    try {
      message = JSON.parse(line) as DiffReviewResponseMessage;
    } catch (error) {
      this.rejectAllPending(
        error instanceof Error ? error : new Error("failed to parse diff review response"),
      );
      return;
    }

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

  private rejectAllPending(error: Error): void {
    for (const [id, pending] of this.pendingRequests) {
      this.pendingRequests.delete(id);
      pending.reject(error);
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
