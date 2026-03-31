import { spawn } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { existsSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { join } from "node:path";
import { createInterface, type Interface } from "node:readline";
import type { Config, DiffToolConfig } from "../config/index.js";
import type { CoreDeps } from "../runtime/deps.js";
import { createDefaultCoreDeps } from "../runtime/deps.js";
import type { ToolExecutionBackend } from "../tools/execution_backend.js";
import type { Persona, Skill } from "../types.js";
import type {
  DiffReviewMethod,
  DiffReviewRequestId,
  DiffReviewRequestMessage,
  DiffReviewResultByMethod,
} from "./protocol.js";
import {
  createDiffReviewErrorResponse,
  createDiffReviewSuccessResponse,
  DIFF_REVIEW_ERROR_CODES,
  DIFF_REVIEW_METHODS,
  DIFF_REVIEW_PROTOCOL_VERSION,
  type DiffReviewInitializeResult,
  type DiffReviewResponseMessage,
  parseDiffReviewRequestLine,
  serializeDiffReviewMessage,
} from "./protocol.js";
import { DiffReviewThread, type DiffReviewThreadSession } from "./review_thread.js";
import { captureDiffReviewSnapshot, type DiffReviewSnapshot } from "./snapshot.js";

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

export type DiffReviewSessionOptions = {
  snapshot: DiffReviewSnapshot;
  persona: Persona;
  config: Config;
  discoveredSkills?: Skill[];
  includeAgentContext?: boolean;
  deps?: CoreDeps;
  toolExecutionBackend?: ToolExecutionBackend;
  createThread?: (threadId: string) => DiffReviewThreadSession;
};

export type StartDiffReviewSessionOptions = {
  cwd: string;
  diffArgs?: string[];
  signal?: AbortSignal;
  diffTool: DiffToolConfig;
  persona: Persona;
  config: Config;
  discoveredSkills?: Skill[];
  includeAgentContext?: boolean;
  deps?: CoreDeps;
  toolExecutionBackend?: ToolExecutionBackend;
};

export type StartedDiffReviewSession = {
  session: DiffReviewSession;
  result: Promise<DiffReviewResult>;
};

export type DiffReviewAgentActivityState =
  | {
      status: "idle";
    }
  | {
      status: "running";
      threadId: string;
    };

export type DiffReviewSessionUiState = {
  diffToolUiText?: string;
  reviewAgent: DiffReviewAgentActivityState;
};

export type DiffReviewSessionUiStateListener = (state: DiffReviewSessionUiState) => void;

type DiffReviewClientConnection = {
  socket: Socket;
  readline: Interface;
  initialized: boolean;
  queue: Promise<void>;
};

const DIFF_REVIEW_INITIALIZE_TIMEOUT_MS = 10_000;

export class DiffReviewSession {
  readonly sessionId: string;
  readonly snapshot: DiffReviewSnapshot;
  private readonly persona: Persona;
  private readonly config: Config;
  private readonly deps: CoreDeps;
  private readonly toolExecutionBackend?: ToolExecutionBackend;
  private readonly createThreadSession: (threadId: string) => DiffReviewThreadSession;
  private readonly socketPath: string;
  private readonly authToken: string;
  private server?: Server;
  private readonly threads = new Map<string, DiffReviewThreadSession>();
  private readonly connections = new Set<DiffReviewClientConnection>();
  private readonly uiStateListeners = new Set<DiffReviewSessionUiStateListener>();
  private uiState: DiffReviewSessionUiState = {
    reviewAgent: { status: "idle" },
  };
  private initializedConnection?: DiffReviewClientConnection;
  private initializeTimeout?: ReturnType<typeof setTimeout>;
  private completionResolver?: (result: DiffReviewResult) => void;
  private readonly completionPromise: Promise<DiffReviewResult>;
  private completedResult?: DiffReviewResult;
  private closed = false;

  constructor(options: DiffReviewSessionOptions) {
    this.sessionId = `tau-diff-review-${randomUUID()}`;
    this.snapshot = options.snapshot;
    this.persona = options.persona;
    this.config = options.config;
    this.deps = options.deps ?? createDefaultCoreDeps();
    this.toolExecutionBackend = options.toolExecutionBackend;
    this.socketPath = join("/tmp", `tau-diff-${randomBytes(8).toString("hex")}.sock`);
    this.authToken = randomBytes(24).toString("hex");
    this.createThreadSession =
      options.createThread ??
      ((threadId) =>
        new DiffReviewThread({
          threadId,
          snapshot: this.snapshot,
          persona: this.persona,
          config: this.config,
          discoveredSkills: options.discoveredSkills,
          includeAgentContext: options.includeAgentContext,
          deps: this.deps,
          toolExecutionBackend: this.toolExecutionBackend,
        }));
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

  getUiState(): DiffReviewSessionUiState {
    return cloneDiffReviewUiState(this.uiState);
  }

  onUiStateChange(listener: DiffReviewSessionUiStateListener): () => void {
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

    await new Promise<void>((resolve, reject) => {
      const child = spawn(diffTool.command, diffTool.args ?? [], {
        cwd: this.snapshot.cwd,
        env,
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

  async cancel(reason: DiffReviewCancelledReason = "controller_cancelled"): Promise<void> {
    if (this.completedResult) {
      return;
    }

    for (const thread of this.threads.values()) {
      thread.interrupt();
    }

    await this.complete({ status: "cancelled", reason });
  }

  async close(): Promise<void> {
    if (!this.completedResult) {
      await this.cancel("controller_cancelled");
      return;
    }

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
      queue: Promise.resolve(),
    };
    this.connections.add(connection);

    readline.on("line", (line) => {
      connection.queue = connection.queue
        .then(() => this.handleLine(connection, line))
        .catch((error) => {
          this.sendError(connection.socket, null, "internalError", "diff review request failed", {
            cause: error instanceof Error ? error.message : String(error),
          });
        });
    });

    socket.on("close", () => {
      readline.close();
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
    const parsed = parseDiffReviewRequestLine(line);
    if (!parsed.ok) {
      this.sendMessage(
        connection.socket,
        createDiffReviewErrorResponse(
          parsed.id,
          parsed.error.code,
          parsed.error.message,
          parsed.error.data,
        ),
      );
      return;
    }

    const request = parsed.request;
    if (this.completedResult && request.method !== "initialize") {
      this.sendError(
        connection.socket,
        request.id,
        "sessionClosed",
        "diff review session is closed",
      );
      return;
    }

    if (request.method !== "initialize" && !connection.initialized) {
      this.sendError(
        connection.socket,
        request.id,
        "notInitialized",
        "call initialize before other diff review methods",
      );
      return;
    }

    switch (request.method) {
      case "initialize":
        this.handleInitialize(connection, request);
        return;
      case "session.get_context":
        this.respond(connection.socket, request.id, request.method, {
          sessionId: this.sessionId,
          repoRoot: this.snapshot.repoRoot,
          cwd: this.snapshot.cwd,
          diffArgs: [...this.snapshot.diffArgs],
          diffCommand: this.snapshot.toDiffCommand(),
        });
        return;
      case "session.list_files":
        this.respond(connection.socket, request.id, request.method, {
          files: this.snapshot.files.map((file) => ({ ...file })),
        });
        return;
      case "session.get_diff":
        this.handleGetDiff(connection.socket, request);
        return;
      case "session.set_ui_text":
        this.updateDiffToolUiText(request.params.text);
        this.respond(connection.socket, request.id, request.method, { status: "updated" });
        return;
      case "thread.submit_message":
        await this.handleThreadSubmit(connection.socket, request);
        return;
      case "session.return_review":
        this.respond(connection.socket, request.id, request.method, { status: "returned" });
        await this.complete({ status: "returned", review: request.params.review });
        return;
      case "session.cancel":
        this.respond(connection.socket, request.id, request.method, { status: "cancelled" });
        await this.cancel("tool_cancelled");
        return;
    }
  }

  private handleInitialize(
    connection: DiffReviewClientConnection,
    request: Extract<DiffReviewRequestMessage, { method: "initialize" }>,
  ): void {
    if (request.params.token !== this.authToken) {
      this.sendError(connection.socket, request.id, "unauthorized", "invalid diff review token");
      return;
    }

    if (this.initializedConnection && this.initializedConnection !== connection) {
      this.sendError(
        connection.socket,
        request.id,
        "invalidRequest",
        "diff review session already has an active client",
      );
      return;
    }

    const result: DiffReviewInitializeResult = {
      protocolVersion: DIFF_REVIEW_PROTOCOL_VERSION,
      sessionId: this.sessionId,
      methods: [...DIFF_REVIEW_METHODS],
      alreadyInitialized: connection.initialized,
    };
    connection.initialized = true;
    this.initializedConnection = connection;
    this.clearInitializeTimeout();
    this.sendMessage(connection.socket, createDiffReviewSuccessResponse(request.id, result));
  }

  private handleGetDiff(
    socket: Socket,
    request: Extract<DiffReviewRequestMessage, { method: "session.get_diff" }>,
  ): void {
    if (!request.params.path) {
      this.respond(socket, request.id, request.method, {
        scope: "session",
        patch: this.snapshot.patch,
      });
      return;
    }

    const patch = this.snapshot.getFilePatch(request.params.path);
    if (patch === undefined) {
      this.sendError(
        socket,
        request.id,
        "invalidParams",
        `unknown diff file '${request.params.path}'`,
      );
      return;
    }

    this.respond(socket, request.id, request.method, {
      scope: "file",
      path: request.params.path,
      patch,
    });
  }

  private async handleThreadSubmit(
    socket: Socket,
    request: Extract<DiffReviewRequestMessage, { method: "thread.submit_message" }>,
  ): Promise<void> {
    const threadId = request.params.threadId ?? `thread-${randomUUID()}`;
    const thread = this.getOrCreateThread(threadId);

    this.updateReviewAgentActivity({ status: "running", threadId });
    try {
      const response = await thread.submitMessage(request.params.message);
      if (this.completedResult || socket.destroyed) {
        return;
      }
      this.respond(socket, request.id, request.method, { threadId, response });
    } catch (error) {
      if (this.completedResult || socket.destroyed) {
        return;
      }
      this.sendError(
        socket,
        request.id,
        "internalError",
        error instanceof Error ? error.message : String(error),
      );
    } finally {
      this.updateReviewAgentActivity({ status: "idle" });
    }
  }

  private getOrCreateThread(threadId: string): DiffReviewThreadSession {
    const existing = this.threads.get(threadId);
    if (existing) {
      return existing;
    }

    const created = this.createThreadSession(threadId);
    this.threads.set(threadId, created);
    return created;
  }

  private updateDiffToolUiText(text: string): void {
    const nextText = text.trim() || undefined;
    if (this.uiState.diffToolUiText === nextText) {
      return;
    }

    this.uiState = {
      ...(nextText ? { diffToolUiText: nextText } : {}),
      reviewAgent: this.uiState.reviewAgent,
    };
    this.emitUiState();
  }

  private updateReviewAgentActivity(activity: DiffReviewAgentActivityState): void {
    const current = this.uiState.reviewAgent;
    const isUnchanged =
      current.status === activity.status &&
      (current.status !== "running" ||
        (activity.status === "running" && current.threadId === activity.threadId));
    if (isUnchanged) {
      return;
    }

    this.uiState = {
      ...this.uiState,
      reviewAgent: activity,
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
    this.completionResolver?.(result);
    this.completionResolver = undefined;
    await this.close();
  }

  private async closeServer(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    this.clearInitializeTimeout();

    for (const connection of this.connections) {
      connection.readline.close();
      connection.socket.destroy();
    }
    this.connections.clear();
    this.initializedConnection = undefined;

    if (server) {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }

    if (existsSync(this.socketPath)) {
      rmSync(this.socketPath, { force: true });
    }
  }

  private respond<M extends DiffReviewMethod>(
    socket: Socket,
    id: DiffReviewRequestId,
    _method: M,
    result: DiffReviewResultByMethod[M],
  ): void {
    this.sendMessage(socket, createDiffReviewSuccessResponse(id, result));
  }

  private sendError(
    socket: Socket,
    id: DiffReviewRequestId | null,
    code: keyof typeof DIFF_REVIEW_ERROR_CODES,
    message: string,
    data?: unknown,
  ): void {
    const resolvedCode = DIFF_REVIEW_ERROR_CODES[code];
    this.sendMessage(socket, createDiffReviewErrorResponse(id, resolvedCode, message, data));
  }

  private sendMessage(socket: Socket, message: DiffReviewResponseMessage): void {
    if (socket.destroyed) {
      return;
    }
    socket.write(serializeDiffReviewMessage(message));
  }
}

function cloneDiffReviewUiState(state: DiffReviewSessionUiState): DiffReviewSessionUiState {
  return {
    ...(state.diffToolUiText ? { diffToolUiText: state.diffToolUiText } : {}),
    reviewAgent:
      state.reviewAgent.status === "running"
        ? { status: "running", threadId: state.reviewAgent.threadId }
        : { status: "idle" },
  };
}

export async function startDiffReviewSession(
  options: StartDiffReviewSessionOptions,
): Promise<StartedDiffReviewSession> {
  throwIfDiffReviewStartAborted(options.signal);

  const snapshot = await captureDiffReviewSnapshot({
    cwd: options.cwd,
    diffArgs: options.diffArgs,
    signal: options.signal,
    deps: options.deps,
  });
  throwIfDiffReviewStartAborted(options.signal);

  const session = new DiffReviewSession({
    snapshot,
    persona: options.persona,
    config: options.config,
    discoveredSkills: options.discoveredSkills,
    includeAgentContext: options.includeAgentContext,
    deps: options.deps,
    toolExecutionBackend: options.toolExecutionBackend,
  });

  await session.start();

  try {
    throwIfDiffReviewStartAborted(options.signal);
    await session.launchTool(options.diffTool);
  } catch (error) {
    await session.cancel("launch_failed");
    throw error;
  }

  return {
    session,
    result: session.result,
  };
}

function throwIfDiffReviewStartAborted(signal?: AbortSignal): void {
  if (!signal?.aborted) {
    return;
  }

  throw new Error("diff review start aborted");
}
