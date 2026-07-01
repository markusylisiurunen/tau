import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { createInterface, type Interface } from "node:readline";
import type { DiffToolConfig } from "../config/index.js";
import type { CoreDeps } from "../runtime/deps.js";
import { createDefaultCoreDeps } from "../runtime/deps.js";
import type {
  DiffReviewMessage,
  DiffReviewMethod,
  DiffReviewParamsByMethod,
  DiffReviewRequestId,
  DiffReviewRequestMessage,
  DiffReviewResponseMessage,
  DiffReviewResultByMethod,
  DiffReviewServerMethod,
} from "./protocol.js";
import {
  createDiffReviewErrorResponse,
  createDiffReviewSuccessResponse,
  DIFF_REVIEW_CLIENT_METHODS,
  DIFF_REVIEW_ERROR_CODES,
  DIFF_REVIEW_PROTOCOL_VERSION,
  type DiffReviewInitializeResult,
  parseDiffReviewMessageLine,
  serializeDiffReviewMessage,
} from "./protocol.js";
import type { DiffReviewAgentUsageSnapshot, DiffReviewThreadUpdate } from "./review_thread.js";
import type { DiffReviewSnapshot } from "./snapshot.js";

export type DiffReviewCancelledReason =
  | "tool_cancelled"
  | "tool_disconnected"
  | "controller_cancelled"
  | "launch_failed";

export type DiffReviewResult =
  | {
      status: "returned";
      review: string;
    }
  | {
      status: "cancelled";
      reason: DiffReviewCancelledReason;
    };

export type DiffReviewSubmitThreadMessageOptions = {
  threadId: string;
  forkFromThreadId?: string;
  message: string;
};

export type DiffReviewSubmitThreadMessageResult = {
  threadId: string;
  response: string;
};

export type DiffReviewSubmitThreadMessage = (
  options: DiffReviewSubmitThreadMessageOptions,
) => Promise<DiffReviewSubmitThreadMessageResult>;

export type DiffReviewToolLauncher = (options: {
  diffTool: DiffToolConfig;
  cwd: string;
  env: NodeJS.ProcessEnv;
}) => Promise<void>;

export type DiffReviewBridgeOptions = {
  snapshot: DiffReviewSnapshot;
  contextWindow: number;
  submitThreadMessage: DiffReviewSubmitThreadMessage;
  deps?: CoreDeps;
  toolLaunchCwd?: string;
  toolLauncher?: DiffReviewToolLauncher;
};

export type StartedDiffReviewBridge = {
  bridge: DiffReviewBridge;
  result: Promise<DiffReviewResult>;
};

export type DiffReviewAgentStatus = "running" | "idle";

export type DiffReviewAgentActivity = {
  threadId: string;
  status: DiffReviewAgentStatus;
  costTotal: number;
  usage: DiffReviewAgentUsageSnapshot;
  lastActivityText?: string;
};

export type DiffReviewBridgeUiState = {
  diffToolUiText?: string;
  reviewAgents: DiffReviewAgentActivity[];
};

export type DiffReviewBridgeUiStateListener = (state: DiffReviewBridgeUiState) => void;

type PendingToolResponse = {
  method: DiffReviewServerMethod;
  resolve: (message: DiffReviewResponseMessage) => void;
  reject: (error: Error) => void;
};

type DiffReviewClientConnection = {
  socket: Socket;
  readline: Interface;
  initialized: boolean;
  writeQueue: Promise<void>;
  pendingResponses: Map<DiffReviewRequestId, PendingToolResponse>;
  requestCounter: number;
};

type DiffReviewAgentRecord = DiffReviewAgentActivity & {
  activeRequestCount: number;
};

class DiffReviewRequestError extends Error {
  readonly code: keyof typeof DIFF_REVIEW_ERROR_CODES;

  constructor(code: keyof typeof DIFF_REVIEW_ERROR_CODES, message: string) {
    super(message);
    this.name = "DiffReviewRequestError";
    this.code = code;
  }
}

const DIFF_REVIEW_INITIALIZE_TIMEOUT_MS = 10_000;
const DIFF_REVIEW_CLOSE_TIMEOUT_MS = 1_000;

async function launchDiffToolProcess(options: {
  diffTool: DiffToolConfig;
  cwd: string;
  env: NodeJS.ProcessEnv;
}): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(options.diffTool.command, options.diffTool.args ?? [], {
      cwd: options.cwd,
      env: options.env,
      stdio: "ignore",
      detached: true,
    });

    const onError = (error: Error) => reject(error);
    child.once("error", onError);
    child.once("spawn", () => {
      child.off("error", onError);
      child.unref();
      resolve();
    });
  });
}

export class DiffReviewBridge {
  readonly sessionId: string;
  readonly snapshot: DiffReviewSnapshot;
  private readonly contextWindow: number;
  private readonly submitThreadMessage: DiffReviewSubmitThreadMessage;
  private readonly deps: CoreDeps;
  private readonly toolLaunchCwd?: string;
  private readonly toolLauncher: DiffReviewToolLauncher;
  private readonly socketPath: string;
  private readonly authToken: string;
  private server?: Server;
  private readonly reviewAgentRecords = new Map<string, DiffReviewAgentRecord>();
  private readonly connections = new Set<DiffReviewClientConnection>();
  private readonly uiStateListeners = new Set<DiffReviewBridgeUiStateListener>();
  private uiState: DiffReviewBridgeUiState = {
    reviewAgents: [],
  };
  private initializedConnection?: DiffReviewClientConnection;
  private initializeTimeout?: ReturnType<typeof setTimeout>;
  private completionResolver?: (result: DiffReviewResult) => void;
  private readonly completionPromise: Promise<DiffReviewResult>;
  private completedResult?: DiffReviewResult;
  private closed = false;

  constructor(options: DiffReviewBridgeOptions) {
    this.sessionId = `diff-review-${randomUUID()}`;
    this.snapshot = options.snapshot;
    this.contextWindow = options.contextWindow;
    this.submitThreadMessage = options.submitThreadMessage;
    this.deps = options.deps ?? createDefaultCoreDeps();
    this.toolLaunchCwd = options.toolLaunchCwd;
    this.toolLauncher = options.toolLauncher ?? launchDiffToolProcess;
    this.socketPath = join("/tmp", `tau-diff-${randomBytes(8).toString("hex")}.sock`);
    this.authToken = randomBytes(24).toString("hex");
    this.completionPromise = new Promise<DiffReviewResult>((resolve) => {
      this.completionResolver = resolve;
    });
  }

  get result(): Promise<DiffReviewResult> {
    return this.completionPromise;
  }

  get protocolVersion(): typeof DIFF_REVIEW_PROTOCOL_VERSION {
    return DIFF_REVIEW_PROTOCOL_VERSION;
  }

  getUiState(): DiffReviewBridgeUiState {
    return cloneDiffReviewUiState(this.uiState);
  }

  onUiStateChange(listener: DiffReviewBridgeUiStateListener): () => void {
    this.uiStateListeners.add(listener);
    listener(this.getUiState());
    return () => {
      this.uiStateListeners.delete(listener);
    };
  }

  get launchEnvironment(): Record<string, string> {
    return {
      TAU_DIFF_PROTOCOL_VERSION: String(DIFF_REVIEW_PROTOCOL_VERSION),
      TAU_DIFF_SOCKET: this.socketPath,
      TAU_DIFF_TOKEN: this.authToken,
      TAU_DIFF_SESSION_ID: this.sessionId,
      TAU_DIFF_REPO_ROOT: this.snapshot.repoRoot,
      TAU_DIFF_CWD: this.snapshot.cwd,
      TAU_DIFF_ARGS_JSON: JSON.stringify(this.snapshot.diffArgs),
    };
  }

  async start(): Promise<void> {
    if (this.server) {
      return;
    }

    if (existsSync(this.socketPath)) {
      rmSync(this.socketPath, { force: true });
    }

    this.server = createServer((socket) => this.handleConnection(socket));
    await new Promise<void>((resolve, reject) => {
      const server = this.server;
      if (!server) {
        reject(new Error("diff review server was not created"));
        return;
      }

      const onError = (error: Error) => {
        server.off("listening", onListening);
        reject(error);
      };
      const onListening = () => {
        server.off("error", onError);
        resolve();
      };

      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(this.socketPath);
    });

    this.armInitializeTimeout();
  }

  async launchTool(diffTool: DiffToolConfig): Promise<void> {
    const env = {
      ...this.deps.env.env(),
      ...(diffTool.env ?? {}),
      ...this.launchEnvironment,
    };

    await this.toolLauncher({
      diffTool,
      cwd: this.toolLaunchCwd ?? this.snapshot.cwd,
      env,
    });
  }

  async cancel(reason: DiffReviewCancelledReason = "controller_cancelled"): Promise<void> {
    if (this.completedResult) {
      return;
    }

    await this.complete({ status: "cancelled", reason });
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }

    this.closed = true;
    await this.closeServer();
  }

  private handleConnection(socket: Socket): void {
    const readline = createInterface({ input: socket, crlfDelay: Number.POSITIVE_INFINITY });
    const connection: DiffReviewClientConnection = {
      socket,
      readline,
      initialized: false,
      writeQueue: Promise.resolve(),
      pendingResponses: new Map(),
      requestCounter: 0,
    };
    this.connections.add(connection);

    readline.on("line", (line) => {
      void this.handleLine(connection, line).catch((error) => {
        void this.sendError(connection, null, "internalError", "diff review request failed", {
          cause: error instanceof Error ? error.message : String(error),
        });
      });
    });
    readline.on("error", () => {});

    socket.on("close", () => {
      readline.close();
      this.rejectPendingToolResponses(
        connection,
        new Error("diff review protocol connection closed"),
      );
      this.connections.delete(connection);

      const lostInitializedConnection = this.initializedConnection === connection;
      if (lostInitializedConnection) {
        this.initializedConnection = undefined;
      }

      if (!this.completedResult && lostInitializedConnection) {
        void this.cancel("tool_disconnected");
        return;
      }

      if (!this.completedResult && this.connections.size === 0 && !this.initializedConnection) {
        void this.cancel("tool_disconnected");
      }
    });

    socket.on("error", () => {});
  }

  private async handleLine(connection: DiffReviewClientConnection, line: string): Promise<void> {
    const parsed = parseDiffReviewMessageLine(line);
    if (!parsed.ok) {
      await this.sendMessage(
        connection,
        createDiffReviewErrorResponse(
          parsed.id,
          parsed.error.code,
          parsed.error.message,
          parsed.error.data,
        ),
      );
      return;
    }

    if (parsed.message.type === "response") {
      this.handleToolResponse(connection, parsed.message);
      return;
    }

    const request = parsed.message;
    if (this.completedResult && request.method !== "initialize") {
      await this.sendError(
        connection,
        request.id,
        "sessionClosed",
        "diff review session is closed",
      );
      return;
    }

    if (request.method !== "initialize" && !connection.initialized) {
      await this.sendError(
        connection,
        request.id,
        "notInitialized",
        "call initialize before other diff review methods",
      );
      return;
    }

    switch (request.method) {
      case "initialize":
        await this.handleInitialize(connection, request);
        return;
      case "session.get_context":
        await this.respond(connection, request.id, request.method, {
          sessionId: this.sessionId,
          repoRoot: this.snapshot.repoRoot,
          cwd: this.snapshot.cwd,
          diffArgs: [...this.snapshot.diffArgs],
          diffCommand: this.snapshot.toDiffCommand(),
        });
        return;
      case "session.list_files":
        await this.respond(connection, request.id, request.method, {
          files: this.snapshot.files.map((file) => ({ ...file })),
        });
        return;
      case "session.get_diff":
        await this.handleGetDiff(connection, request);
        return;
      case "session.set_ui_text":
        this.updateDiffToolUiText(request.params.text);
        await this.respond(connection, request.id, request.method, { status: "updated" });
        return;
      case "thread.submit_message":
        await this.handleThreadSubmit(connection, request);
        return;
      case "session.return_review":
        await this.respond(connection, request.id, request.method, { status: "returned" });
        await this.complete({ status: "returned", review: request.params.review });
        return;
      case "session.cancel":
        await this.respond(connection, request.id, request.method, { status: "cancelled" });
        await this.cancel("tool_cancelled");
        return;
      case "session.close":
        await this.sendError(
          connection,
          request.id,
          "invalidRequest",
          "session.close is sent by Tau, not the diff tool",
        );
        return;
    }
  }

  private handleToolResponse(
    connection: DiffReviewClientConnection,
    message: DiffReviewResponseMessage,
  ): void {
    if (message.id === null) {
      return;
    }

    const pending = connection.pendingResponses.get(message.id);
    if (!pending) {
      return;
    }

    connection.pendingResponses.delete(message.id);
    if (message.ok) {
      pending.resolve(message);
      return;
    }

    pending.reject(new Error(message.error.message));
  }

  private async handleInitialize(
    connection: DiffReviewClientConnection,
    request: Extract<DiffReviewRequestMessage, { method: "initialize" }>,
  ): Promise<void> {
    if (request.params.token !== this.authToken) {
      await this.sendError(connection, request.id, "unauthorized", "invalid diff review token");
      return;
    }

    if (this.initializedConnection && this.initializedConnection !== connection) {
      await this.sendError(
        connection,
        request.id,
        "invalidRequest",
        "diff review session already has an active client",
      );
      return;
    }

    const result: DiffReviewInitializeResult = {
      protocolVersion: DIFF_REVIEW_PROTOCOL_VERSION,
      sessionId: this.sessionId,
      methods: [...DIFF_REVIEW_CLIENT_METHODS],
      alreadyInitialized: connection.initialized,
    };
    connection.initialized = true;
    this.initializedConnection = connection;
    this.clearInitializeTimeout();
    await this.sendMessage(connection, createDiffReviewSuccessResponse(request.id, result));
  }

  private async handleGetDiff(
    connection: DiffReviewClientConnection,
    request: Extract<DiffReviewRequestMessage, { method: "session.get_diff" }>,
  ): Promise<void> {
    if (!request.params.path) {
      await this.respond(connection, request.id, request.method, {
        scope: "session",
        patch: this.snapshot.patch,
      });
      return;
    }

    const patch = this.snapshot.getFilePatch(request.params.path);
    if (patch === undefined) {
      await this.sendError(
        connection,
        request.id,
        "invalidParams",
        `unknown diff file '${request.params.path}'`,
      );
      return;
    }

    await this.respond(connection, request.id, request.method, {
      scope: "file",
      path: request.params.path,
      patch,
    });
  }

  private async handleThreadSubmit(
    connection: DiffReviewClientConnection,
    request: Extract<DiffReviewRequestMessage, { method: "thread.submit_message" }>,
  ): Promise<void> {
    let acquired:
      | {
          threadId: string;
          forkFromThreadId?: string;
        }
      | undefined;
    try {
      acquired = this.acquireThreadForSubmit(request.params);
      const result = await this.submitThreadMessage({
        threadId: acquired.threadId,
        ...(acquired.forkFromThreadId ? { forkFromThreadId: acquired.forkFromThreadId } : {}),
        message: request.params.message,
      });
      if (this.completedResult || connection.socket.destroyed) {
        return;
      }
      await this.respond(connection, request.id, request.method, {
        threadId: result.threadId,
        response: result.response,
      });
    } catch (error) {
      if (this.completedResult || connection.socket.destroyed) {
        return;
      }
      if (error instanceof DiffReviewRequestError) {
        await this.sendError(connection, request.id, error.code, error.message);
        return;
      }
      await this.sendError(
        connection,
        request.id,
        "internalError",
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      if (acquired) {
        this.markReviewAgentIdle(acquired.threadId);
      }
    }
  }

  private acquireThreadForSubmit(params: { threadId?: string; forkFromThreadId?: string }): {
    threadId: string;
    forkFromThreadId?: string;
  } {
    if (params.threadId) {
      if (!this.reviewAgentRecords.has(params.threadId)) {
        throw new DiffReviewRequestError("invalidParams", `unknown thread '${params.threadId}'`);
      }
      this.markReviewAgentRunning(params.threadId);
      return { threadId: params.threadId };
    }

    const threadId = randomUUID();
    if (params.forkFromThreadId && !this.reviewAgentRecords.has(params.forkFromThreadId)) {
      throw new DiffReviewRequestError(
        "invalidParams",
        `unknown fork source thread '${params.forkFromThreadId}'`,
      );
    }
    if (params.forkFromThreadId && this.hasActiveReviewAgentRequest(params.forkFromThreadId)) {
      throw new DiffReviewRequestError(
        "invalidRequest",
        `thread '${params.forkFromThreadId}' already has an active request and cannot be used as a fork source`,
      );
    }

    this.ensureReviewAgentRecord(threadId);
    this.markReviewAgentRunning(threadId);
    return {
      threadId,
      ...(params.forkFromThreadId ? { forkFromThreadId: params.forkFromThreadId } : {}),
    };
  }

  private updateDiffToolUiText(text: string): void {
    const nextText = text.trim() || undefined;
    if (this.uiState.diffToolUiText === nextText) {
      return;
    }

    this.uiState = {
      ...(nextText ? { diffToolUiText: nextText } : {}),
      reviewAgents: this.uiState.reviewAgents,
    };
    this.emitUiState();
  }

  private ensureReviewAgentRecord(threadId: string): DiffReviewAgentRecord {
    const existing = this.reviewAgentRecords.get(threadId);
    if (existing) {
      return existing;
    }

    const created: DiffReviewAgentRecord = {
      threadId,
      status: "idle",
      activeRequestCount: 0,
      costTotal: 0,
      usage: createEmptyReviewAgentUsage(this.contextWindow),
    };
    this.reviewAgentRecords.set(threadId, created);
    return created;
  }

  private markReviewAgentRunning(threadId: string): void {
    const record = this.ensureReviewAgentRecord(threadId);
    if (record.activeRequestCount > 0) {
      throw new DiffReviewRequestError(
        "invalidRequest",
        `thread '${threadId}' already has an active request`,
      );
    }
    record.activeRequestCount = 1;
    if (record.status !== "running") {
      record.status = "running";
      this.syncReviewAgents();
    }
  }

  private markReviewAgentIdle(threadId: string): void {
    const record = this.ensureReviewAgentRecord(threadId);
    if (record.activeRequestCount > 0) {
      record.activeRequestCount -= 1;
    }
    if (record.activeRequestCount === 0 && record.status !== "idle") {
      record.status = "idle";
      this.syncReviewAgents();
    }
  }

  applyThreadUpdate(threadId: string, update: DiffReviewThreadUpdate): void {
    const record = this.ensureReviewAgentRecord(threadId);
    let changed = false;

    if (record.costTotal !== update.costTotal) {
      record.costTotal = update.costTotal;
      changed = true;
    }

    if (!isSameUsageSnapshot(record.usage, update.usage)) {
      record.usage = { ...update.usage };
      changed = true;
    }

    if (record.lastActivityText !== update.lastActivityText) {
      record.lastActivityText = update.lastActivityText;
      changed = true;
    }

    if (changed) {
      this.syncReviewAgents();
    }
  }

  private hasActiveReviewAgentRequest(threadId: string): boolean {
    return (this.reviewAgentRecords.get(threadId)?.activeRequestCount ?? 0) > 0;
  }

  private syncReviewAgents(): void {
    this.uiState = {
      ...this.uiState,
      reviewAgents: [...this.reviewAgentRecords.values()].map((agent) => ({
        threadId: agent.threadId,
        status: agent.status,
        costTotal: agent.costTotal,
        usage: { ...agent.usage },
        ...(agent.lastActivityText ? { lastActivityText: agent.lastActivityText } : {}),
      })),
    };
    this.emitUiState();
  }

  private emitUiState(): void {
    const state = this.getUiState();
    for (const listener of this.uiStateListeners) {
      listener(state);
    }
  }

  private armInitializeTimeout(): void {
    if (this.initializeTimeout || this.completedResult || this.initializedConnection) {
      return;
    }

    this.initializeTimeout = setTimeout(() => {
      this.initializeTimeout = undefined;
      if (this.completedResult || this.initializedConnection) {
        return;
      }
      void this.cancel("tool_disconnected");
    }, DIFF_REVIEW_INITIALIZE_TIMEOUT_MS);
  }

  private clearInitializeTimeout(): void {
    if (!this.initializeTimeout) {
      return;
    }

    clearTimeout(this.initializeTimeout);
    this.initializeTimeout = undefined;
  }

  private async complete(result: DiffReviewResult): Promise<void> {
    if (this.completedResult) {
      return;
    }

    this.clearInitializeTimeout();
    this.completedResult = result;
    try {
      await this.requestToolShutdown();
      await this.close();
    } finally {
      this.completionResolver?.(result);
      this.completionResolver = undefined;
    }
  }

  private async requestToolShutdown(): Promise<void> {
    const connection = this.initializedConnection;
    if (!connection || connection.socket.destroyed) {
      return;
    }

    try {
      await Promise.race([
        this.requestTool(connection, "session.close", {}),
        new Promise<DiffReviewResultByMethod["session.close"]>((_, reject) => {
          setTimeout(() => {
            reject(new Error("diff review tool close request timed out"));
          }, DIFF_REVIEW_CLOSE_TIMEOUT_MS);
        }),
      ]);
    } catch {
      // ignore
    }
  }

  private async requestTool<M extends DiffReviewServerMethod>(
    connection: DiffReviewClientConnection,
    method: M,
    params: DiffReviewParamsByMethod[M],
  ): Promise<DiffReviewResultByMethod[M]> {
    if (
      connection.socket.destroyed ||
      connection.socket.writableEnded ||
      !connection.socket.writable
    ) {
      throw new Error("diff review protocol socket is not available");
    }

    const id = `tau-${++connection.requestCounter}`;
    const request = {
      version: DIFF_REVIEW_PROTOCOL_VERSION,
      type: "request",
      id,
      method,
      params,
    } as DiffReviewRequestMessage;

    return await new Promise<DiffReviewResultByMethod[M]>((resolve, reject) => {
      connection.pendingResponses.set(id, {
        method,
        resolve: (message) => {
          if (!message.ok) {
            reject(new Error(message.error.message));
            return;
          }
          resolve(message.result as DiffReviewResultByMethod[M]);
        },
        reject,
      });

      void this.sendMessage(connection, request).catch((error) => {
        const pending = connection.pendingResponses.get(id);
        if (!pending) {
          return;
        }

        connection.pendingResponses.delete(id);
        pending.reject(error instanceof Error ? error : new Error(String(error)));
      });
    });
  }

  private async closeServer(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    this.clearInitializeTimeout();

    const connectionClosePromises: Promise<void>[] = [];
    for (const connection of this.connections) {
      connection.readline.close();
      this.rejectPendingToolResponses(
        connection,
        new Error("diff review protocol connection closed"),
      );

      if (!connection.socket.destroyed) {
        connectionClosePromises.push(
          new Promise<void>((resolve) => {
            const socket = connection.socket;
            const destroyTimeout = setTimeout(() => {
              socket.destroy();
            }, 100);

            socket.once("close", () => {
              clearTimeout(destroyTimeout);
              resolve();
            });
            socket.end();
          }),
        );
      }
    }
    this.connections.clear();
    this.initializedConnection = undefined;

    await Promise.all(connectionClosePromises);

    if (server) {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }

    if (existsSync(this.socketPath)) {
      rmSync(this.socketPath, { force: true });
    }
  }

  private rejectPendingToolResponses(connection: DiffReviewClientConnection, error: Error): void {
    for (const [id, pending] of connection.pendingResponses) {
      connection.pendingResponses.delete(id);
      pending.reject(error);
    }
  }

  private async respond<M extends DiffReviewMethod>(
    connection: DiffReviewClientConnection,
    id: DiffReviewRequestId,
    _method: M,
    result: DiffReviewResultByMethod[M],
  ): Promise<void> {
    await this.sendMessage(connection, createDiffReviewSuccessResponse(id, result));
  }

  private async sendError(
    connection: DiffReviewClientConnection,
    id: DiffReviewRequestId | null,
    code: keyof typeof DIFF_REVIEW_ERROR_CODES,
    message: string,
    data?: unknown,
  ): Promise<void> {
    const resolvedCode = DIFF_REVIEW_ERROR_CODES[code];
    await this.sendMessage(
      connection,
      createDiffReviewErrorResponse(id, resolvedCode, message, data),
    );
  }

  private async sendMessage(
    connection: DiffReviewClientConnection,
    message: DiffReviewMessage,
  ): Promise<void> {
    if (
      connection.socket.destroyed ||
      connection.socket.writableEnded ||
      !connection.socket.writable
    ) {
      return;
    }

    const payload = serializeDiffReviewMessage(message);
    const writePromise = connection.writeQueue.then(
      () =>
        new Promise<void>((resolve, reject) => {
          if (
            connection.socket.destroyed ||
            connection.socket.writableEnded ||
            !connection.socket.writable
          ) {
            resolve();
            return;
          }

          let settled = false;
          const finish = (callback: () => void) => {
            if (settled) {
              return;
            }
            settled = true;
            connection.socket.off("close", onClose);
            connection.socket.off("drain", onDrain);
            connection.socket.off("error", onError);
            callback();
          };
          const onClose = () => {
            finish(resolve);
          };
          const onDrain = () => {
            finish(resolve);
          };
          const onError = (error: Error) => {
            finish(() => {
              reject(error);
            });
          };

          connection.socket.once("close", onClose);
          connection.socket.once("error", onError);

          try {
            if (connection.socket.write(payload)) {
              finish(resolve);
              return;
            }

            connection.socket.once("drain", onDrain);
          } catch (error) {
            finish(() => {
              reject(error instanceof Error ? error : new Error(String(error)));
            });
          }
        }),
    );
    connection.writeQueue = writePromise.catch(() => {});

    try {
      await writePromise;
    } catch {
      if (!connection.socket.destroyed) {
        connection.socket.destroy();
      }
    }
  }
}

function createEmptyReviewAgentUsage(contextWindow: number): DiffReviewAgentUsageSnapshot {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    contextWindowUsageTokens: 0,
    contextWindow,
  };
}

function isSameUsageSnapshot(
  left: DiffReviewAgentUsageSnapshot,
  right: DiffReviewAgentUsageSnapshot,
): boolean {
  return (
    left.input === right.input &&
    left.output === right.output &&
    left.cacheRead === right.cacheRead &&
    left.cacheWrite === right.cacheWrite &&
    left.contextWindowUsageTokens === right.contextWindowUsageTokens &&
    left.contextWindow === right.contextWindow
  );
}

function cloneDiffReviewUiState(state: DiffReviewBridgeUiState): DiffReviewBridgeUiState {
  return {
    ...(state.diffToolUiText ? { diffToolUiText: state.diffToolUiText } : {}),
    reviewAgents: state.reviewAgents.map((agent) => ({
      threadId: agent.threadId,
      status: agent.status,
      costTotal: agent.costTotal,
      usage: { ...agent.usage },
      ...(agent.lastActivityText ? { lastActivityText: agent.lastActivityText } : {}),
    })),
  };
}
