import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import { createTauSdkClient } from "../../sdk/client.js";
import type { TauSdkClient, TauSdkClientOptions } from "../../sdk/types.js";
import type { AsyncProjectConfig } from "../config/schema.js";
import { type PrepareWorkspaceOptions, prepareWorkspace } from "./workspace.js";

export type AsyncSessionState =
  | "queued"
  | "preparing-workspace"
  | "running"
  | "waiting-input"
  | "done"
  | "failed"
  | "canceled";

export type AsyncSessionLogLevel = "info" | "warn" | "error";

export type AsyncSessionLogEntry = {
  timestamp: string;
  level: AsyncSessionLogLevel;
  message: string;
  data?: unknown;
};

export type AsyncSessionRecord = {
  id: string;
  projectId: string;
  state: AsyncSessionState;
  createdAt: string;
  updatedAt: string;
  workspacePath?: string;
  rpcSessionId?: string;
  error?: string;
};

export class AsyncSessionManagerError extends Error {
  code: "not_found" | "busy" | "invalid_project" | "not_ready" | "invalid_state" | "max_sessions";

  constructor(
    code: "not_found" | "busy" | "invalid_project" | "not_ready" | "invalid_state" | "max_sessions",
    message: string,
  ) {
    super(message);
    this.name = "AsyncSessionManagerError";
    this.code = code;
  }
}

type SessionEntry = {
  record: AsyncSessionRecord;
  logs: AsyncSessionLogEntry[];
  project: AsyncProjectConfig;
  abortController: AbortController;
  cancelRequested: boolean;
  client?: TauSdkClient;
  clientClosePromise?: Promise<void>;
  activeSubmit?: Promise<void>;
  initializePromise?: Promise<void>;
};

export type AsyncSessionManagerEvent =
  | {
      type: "session-created";
      session: AsyncSessionRecord;
    }
  | {
      type: "session-state-changed";
      sessionId: string;
      projectId: string;
      previousState: AsyncSessionState;
      state: AsyncSessionState;
      updatedAt: string;
    }
  | {
      type: "session-log";
      sessionId: string;
      projectId: string;
      state: AsyncSessionState;
      log: AsyncSessionLogEntry;
    };

export type AsyncSessionManager = {
  createSession(input: { projectId: string; prompt?: string }): Promise<AsyncSessionRecord>;
  listSessions(): AsyncSessionRecord[];
  getSession(sessionId: string): AsyncSessionRecord | undefined;
  getLogs(sessionId: string): AsyncSessionLogEntry[] | undefined;
  sendMessage(sessionId: string, text: string): Promise<AsyncSessionRecord>;
  cancelSession(sessionId: string): Promise<AsyncSessionRecord>;
  close(): Promise<void>;
  onEvent(listener: (event: AsyncSessionManagerEvent) => void): () => void;
};

export type AsyncSessionManagerOptions = {
  projects: Record<string, AsyncProjectConfig>;
  workspaceRoot?: string;
  maxSessions?: number;
  now?: () => Date;
  createClient?: (options: TauSdkClientOptions) => Promise<TauSdkClient>;
  prepareWorkspace?: (options: PrepareWorkspaceOptions) => Promise<{ workspacePath: string }>;
};

class AsyncSessionManagerImpl implements AsyncSessionManager {
  private readonly sessions = new Map<string, SessionEntry>();
  private readonly listeners = new Set<(event: AsyncSessionManagerEvent) => void>();
  private readonly projects: Record<string, AsyncProjectConfig>;
  private readonly workspaceRoot: string;
  private readonly maxSessions?: number;
  private readonly now: () => Date;
  private readonly createClient: (options: TauSdkClientOptions) => Promise<TauSdkClient>;
  private readonly prepareWorkspace: (
    options: PrepareWorkspaceOptions,
  ) => Promise<{ workspacePath: string }>;
  private closePromise?: Promise<void>;

  constructor(options: AsyncSessionManagerOptions) {
    this.projects = options.projects;
    this.workspaceRoot = resolve(
      options.workspaceRoot ?? resolve(process.cwd(), ".tau/async-workspaces"),
    );
    this.maxSessions = options.maxSessions;
    this.now = options.now ?? (() => new Date());
    this.createClient = options.createClient ?? createTauSdkClient;
    this.prepareWorkspace = options.prepareWorkspace ?? prepareWorkspace;
  }

  async createSession(input: { projectId: string; prompt?: string }): Promise<AsyncSessionRecord> {
    const project = this.projects[input.projectId];
    if (!project) {
      throw new AsyncSessionManagerError(
        "invalid_project",
        `unknown async project '${input.projectId}'`,
      );
    }

    if (this.maxSessions !== undefined && this.countActiveSessions() >= this.maxSessions) {
      throw new AsyncSessionManagerError("max_sessions", "maximum session count reached");
    }

    const id = randomUUID();
    const now = this.now().toISOString();
    const entry: SessionEntry = {
      record: {
        id,
        projectId: input.projectId,
        state: "queued",
        createdAt: now,
        updatedAt: now,
      },
      logs: [],
      project,
      abortController: new AbortController(),
      cancelRequested: false,
    };

    this.sessions.set(id, entry);
    this.log(entry, "info", "session queued");
    this.emit({
      type: "session-created",
      session: this.toRecord(entry),
    });

    let initializePromise: Promise<void>;
    initializePromise = this.initializeSession(entry, input.prompt).finally(() => {
      if (entry.initializePromise === initializePromise) {
        entry.initializePromise = undefined;
      }
    });

    entry.initializePromise = initializePromise;
    return this.toRecord(entry);
  }

  listSessions(): AsyncSessionRecord[] {
    return Array.from(this.sessions.values()).map((entry) => this.toRecord(entry));
  }

  getSession(sessionId: string): AsyncSessionRecord | undefined {
    const entry = this.sessions.get(sessionId);
    return entry ? this.toRecord(entry) : undefined;
  }

  getLogs(sessionId: string): AsyncSessionLogEntry[] | undefined {
    const entry = this.sessions.get(sessionId);
    if (!entry) {
      return undefined;
    }

    return entry.logs.map((logEntry) => ({ ...logEntry }));
  }

  onEvent(listener: (event: AsyncSessionManagerEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async sendMessage(sessionId: string, text: string): Promise<AsyncSessionRecord> {
    const entry = this.requireSession(sessionId);
    const trimmed = text.trim();
    if (!trimmed) {
      throw new AsyncSessionManagerError("invalid_state", "message text cannot be empty");
    }

    if (entry.record.state === "running") {
      throw new AsyncSessionManagerError("busy", "session is running");
    }

    if (
      entry.record.state === "failed" ||
      entry.record.state === "canceled" ||
      entry.record.state === "done"
    ) {
      throw new AsyncSessionManagerError(
        "invalid_state",
        `cannot submit messages when session is ${entry.record.state}`,
      );
    }

    if (!entry.client) {
      throw new AsyncSessionManagerError("not_ready", "session is still preparing");
    }

    if (entry.activeSubmit) {
      throw new AsyncSessionManagerError("busy", "session is running");
    }

    await this.submitText(entry, trimmed, "user-message");
    return this.toRecord(entry);
  }

  async cancelSession(sessionId: string): Promise<AsyncSessionRecord> {
    const entry = this.requireSession(sessionId);
    if (
      entry.record.state === "canceled" ||
      entry.record.state === "failed" ||
      entry.record.state === "done"
    ) {
      return this.toRecord(entry);
    }

    this.requestCancellation(entry, "cancel requested");
    await this.stopClient(entry);
    return this.toRecord(entry);
  }

  async close(): Promise<void> {
    if (this.closePromise) {
      await this.closePromise;
      return;
    }

    this.closePromise = this.closeAllSessions();
    await this.closePromise;
  }

  private async initializeSession(entry: SessionEntry, prompt?: string): Promise<void> {
    try {
      this.setState(entry, "preparing-workspace");
      this.log(entry, "info", "preparing workspace", {
        workspaceRoot: this.workspaceRoot,
      });

      const workspace = await this.prepareWorkspace({
        sessionId: entry.record.id,
        projectId: entry.record.projectId,
        project: entry.project,
        workspaceRoot: entry.project.workspaceRoot ?? this.workspaceRoot,
        signal: entry.abortController.signal,
        onLog: (workspaceLog) => {
          this.log(
            entry,
            workspaceLog.level === "error" ? "error" : "info",
            workspaceLog.message,
            workspaceLog.data,
          );
        },
      });

      if (entry.cancelRequested) {
        this.setState(entry, "canceled");
        return;
      }

      entry.record.workspacePath = workspace.workspacePath;
      this.touch(entry);
      this.log(entry, "info", "workspace ready", { workspacePath: workspace.workspacePath });

      const client = await this.createClient({
        cwd: workspace.workspacePath,
        ...(entry.project.persona ? { persona: entry.project.persona } : {}),
        ...(entry.project.riskLevel ? { riskLevel: entry.project.riskLevel } : {}),
        ...(entry.project.sandbox !== undefined ? { sandbox: entry.project.sandbox } : {}),
        ...(entry.project.noAgentContextFiles !== undefined
          ? { noAgentContextFiles: entry.project.noAgentContextFiles }
          : {}),
      });

      if (entry.cancelRequested) {
        entry.client = client;
        await this.stopClient(entry);
        this.setState(entry, "canceled");
        return;
      }

      entry.client = client;
      entry.record.rpcSessionId = client.ready.sessionId;
      this.touch(entry);
      this.log(entry, "info", "rpc client connected", { rpcSessionId: client.ready.sessionId });

      if (prompt?.trim()) {
        await this.submitText(entry, prompt.trim(), "initial-prompt");
      }

      if (!entry.cancelRequested && entry.record.state !== "failed") {
        this.setState(entry, "waiting-input");
      }
    } catch (error) {
      if (entry.cancelRequested) {
        this.setState(entry, "canceled");
        return;
      }

      const message = error instanceof Error ? error.message : String(error);
      entry.record.error = message;
      this.setState(entry, "failed");
      this.log(entry, "error", "session failed", { cause: message });
    }
  }

  private async submitText(entry: SessionEntry, text: string, source: string): Promise<void> {
    if (!entry.client) {
      throw new AsyncSessionManagerError("not_ready", "session is still preparing");
    }

    if (entry.activeSubmit) {
      throw new AsyncSessionManagerError("busy", "session is running");
    }

    this.setState(entry, "running");
    this.log(entry, "info", "submitting message", { source, text });

    const submitPromise = entry.client.submit(text).then((result) => {
      this.log(entry, "info", "message finished", {
        source,
        aborted: result.turn.aborted,
        userHistoryEntryId: result.userHistoryEntryId,
      });
    });

    entry.activeSubmit = submitPromise;

    try {
      await submitPromise;
      if (!entry.cancelRequested) {
        this.setState(entry, "waiting-input");
      }
    } catch (error) {
      if (!entry.cancelRequested) {
        const message = error instanceof Error ? error.message : String(error);
        entry.record.error = message;
        this.setState(entry, "failed");
        this.log(entry, "error", "submit failed", { source, cause: message });
      }
      throw error;
    } finally {
      if (entry.activeSubmit === submitPromise) {
        entry.activeSubmit = undefined;
      }
    }
  }

  private async closeAllSessions(): Promise<void> {
    const entries = Array.from(this.sessions.values());

    for (const entry of entries) {
      if (this.isActiveState(entry.record.state)) {
        this.requestCancellation(entry, "manager shutdown requested");
      }
    }

    await Promise.allSettled(
      entries.map(async (entry) => {
        await this.stopClient(entry);

        const pendingWork = [entry.activeSubmit, entry.initializePromise].filter(
          (promise): promise is Promise<void> => promise !== undefined,
        );

        if (pendingWork.length > 0) {
          await Promise.allSettled(pendingWork);
        }
      }),
    );
  }

  private requestCancellation(entry: SessionEntry, message: string): void {
    entry.cancelRequested = true;
    entry.abortController.abort();

    if (this.isActiveState(entry.record.state)) {
      this.setState(entry, "canceled");
    }

    this.log(entry, "info", message);
  }

  private async stopClient(entry: SessionEntry): Promise<void> {
    if (!entry.client) {
      return;
    }

    if (entry.clientClosePromise) {
      await entry.clientClosePromise;
      return;
    }

    const client = entry.client;

    let closePromise: Promise<void>;
    closePromise = (async () => {
      try {
        await client.interrupt();
      } catch (error) {
        this.log(entry, "warn", "interrupt failed", {
          cause: error instanceof Error ? error.message : String(error),
        });
      }

      try {
        await client.shutdown();
      } catch (error) {
        this.log(entry, "warn", "shutdown failed", {
          cause: error instanceof Error ? error.message : String(error),
        });
      }

      try {
        await client.close();
      } catch (error) {
        this.log(entry, "warn", "close failed", {
          cause: error instanceof Error ? error.message : String(error),
        });
      }
    })().finally(() => {
      if (entry.clientClosePromise === closePromise) {
        entry.clientClosePromise = undefined;
      }

      if (entry.client === client) {
        entry.client = undefined;
      }
    });

    entry.clientClosePromise = closePromise;
    await closePromise;
  }

  private isActiveState(state: AsyncSessionState): boolean {
    return (
      state === "queued" ||
      state === "preparing-workspace" ||
      state === "running" ||
      state === "waiting-input"
    );
  }

  private requireSession(sessionId: string): SessionEntry {
    const entry = this.sessions.get(sessionId);
    if (!entry) {
      throw new AsyncSessionManagerError("not_found", `session '${sessionId}' not found`);
    }
    return entry;
  }

  private countActiveSessions(): number {
    let count = 0;
    for (const entry of this.sessions.values()) {
      if (this.isActiveState(entry.record.state)) {
        count += 1;
      }
    }
    return count;
  }

  private setState(entry: SessionEntry, state: AsyncSessionState): void {
    const previousState = entry.record.state;
    if (previousState === state) {
      return;
    }

    entry.record.state = state;
    this.touch(entry);
    this.emit({
      type: "session-state-changed",
      sessionId: entry.record.id,
      projectId: entry.record.projectId,
      previousState,
      state,
      updatedAt: entry.record.updatedAt,
    });
  }

  private touch(entry: SessionEntry): void {
    entry.record.updatedAt = this.now().toISOString();
  }

  private log(
    entry: SessionEntry,
    level: AsyncSessionLogLevel,
    message: string,
    data?: unknown,
  ): void {
    const logEntry: AsyncSessionLogEntry = {
      timestamp: this.now().toISOString(),
      level,
      message,
      ...(data === undefined ? {} : { data }),
    };

    entry.logs.push(logEntry);
    this.emit({
      type: "session-log",
      sessionId: entry.record.id,
      projectId: entry.record.projectId,
      state: entry.record.state,
      log: { ...logEntry },
    });
  }

  private emit(event: AsyncSessionManagerEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // ignore listener errors to keep session processing stable
      }
    }
  }

  private toRecord(entry: SessionEntry): AsyncSessionRecord {
    return { ...entry.record };
  }
}

export function createAsyncSessionManager(
  options: AsyncSessionManagerOptions,
): AsyncSessionManager {
  return new AsyncSessionManagerImpl(options);
}
