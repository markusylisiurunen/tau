import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { createTauSdkClient } from "../../sdk/client.js";
import type { TauSdkClient, TauSdkClientOptions, TauSdkEvent } from "../../sdk/types.js";
import type { AsyncProjectConfig } from "../config/schema.js";
import type { CoreEvent } from "../events/types.js";
import { extractAssistantText } from "../utils/messages.js";
import { isRecord } from "../utils/type_guards.js";
import {
  cleanupWorkspacePath as cleanupWorkspacePathOnDisk,
  type PrepareWorkspaceOptions,
  prepareWorkspace,
  type RunBootstrapCommandsOptions,
  resolveWorkspacePath,
  runBootstrapCommands,
} from "./workspace.js";

export type AsyncSessionState =
  | "queued"
  | "preparing-workspace"
  | "running"
  | "waiting-input"
  | "failed";

export type AsyncSessionLogLevel = "info" | "warn" | "error";

export type AsyncSessionLogEntry = {
  timestamp: string;
  level: AsyncSessionLogLevel;
  message: string;
  data?: unknown;
};

export type AsyncSessionProgress =
  | {
      type: "bash-command";
      command: string;
    }
  | {
      type: "edited-file";
      path: string;
    }
  | {
      type: "wrote-file";
      path: string;
    }
  | {
      type: "assistant-message";
      text: string;
    };

export type AsyncSessionRecord = {
  id: string;
  projectId: string;
  ownerId?: string;
  state: AsyncSessionState;
  createdAt: string;
  updatedAt: string;
  workspacePath?: string;
  rpcSessionId?: string;
  error?: string;
};

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const PUBLIC_SESSION_ID_LENGTH = 8;
const NANOSECONDS_PER_MILLISECOND = 1_000_000n;

function elapsedMs(startTime: bigint): number {
  return Number((process.hrtime.bigint() - startTime) / NANOSECONDS_PER_MILLISECOND);
}

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
  unsubscribeClientEvents?: () => void;
  clientClosePromise?: Promise<void>;
  activeSubmit?: Promise<void>;
  initializePromise?: Promise<void>;
  backgroundBootstrapPromise?: Promise<void>;
  workspaceCleanupPromise?: Promise<void>;
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
    }
  | {
      type: "session-progress";
      sessionId: string;
      projectId: string;
      state: AsyncSessionState;
      timestamp: string;
      progress: AsyncSessionProgress;
    };

export type AsyncSessionSubmitOptions = {
  additionalSystemMessage?: string;
};

export type AsyncSessionInterruptResult = {
  session: AsyncSessionRecord;
  interrupted: boolean;
  isTurnRunning: boolean;
};

export type AsyncSessionManager = {
  createSession(input: {
    projectId: string;
    ownerId?: string;
    prompt?: string;
    additionalSystemMessage?: string;
  }): Promise<AsyncSessionRecord>;
  listSessions(): AsyncSessionRecord[];
  getSession(sessionId: string): AsyncSessionRecord | undefined;
  getLogs(sessionId: string): AsyncSessionLogEntry[] | undefined;
  sendMessage(
    sessionId: string,
    text: string,
    options?: AsyncSessionSubmitOptions,
  ): Promise<AsyncSessionRecord>;
  interruptSession(sessionId: string): Promise<AsyncSessionInterruptResult>;
  closeSession(sessionId: string): Promise<AsyncSessionRecord>;
  closeInactiveSessions(): Promise<AsyncSessionRecord[]>;
  close(): Promise<void>;
  onEvent(listener: (event: AsyncSessionManagerEvent) => void): () => void;
};

export type AsyncSessionManagerOptions = {
  projects: Record<string, AsyncProjectConfig>;
  workspaceRoot?: string;
  maxSessions?: number;
  systemMessage?: string;
  now?: () => Date;
  createClient?: (options: TauSdkClientOptions) => Promise<TauSdkClient>;
  prepareWorkspace?: (options: PrepareWorkspaceOptions) => Promise<{
    workspacePath: string;
    sessionCwd: string;
  }>;
  runBootstrapCommands?: (options: RunBootstrapCommandsOptions) => Promise<void>;
  cleanupWorkspacePath?: (workspacePath: string) => Promise<void>;
};

class AsyncSessionManagerImpl implements AsyncSessionManager {
  private readonly sessions = new Map<string, SessionEntry>();
  private readonly listeners = new Set<(event: AsyncSessionManagerEvent) => void>();
  private readonly projects: Record<string, AsyncProjectConfig>;
  private readonly workspaceRoot: string;
  private readonly maxSessions?: number;
  private readonly systemMessage?: string;
  private readonly now: () => Date;
  private readonly createClient: (options: TauSdkClientOptions) => Promise<TauSdkClient>;
  private readonly prepareWorkspace: (
    options: PrepareWorkspaceOptions,
  ) => Promise<{ workspacePath: string; sessionCwd: string }>;
  private readonly runBootstrapCommands: (options: RunBootstrapCommandsOptions) => Promise<void>;
  private readonly cleanupWorkspacePath: (workspacePath: string) => Promise<void>;
  private closePromise?: Promise<void>;

  constructor(options: AsyncSessionManagerOptions) {
    this.projects = options.projects;
    this.workspaceRoot = resolve(
      options.workspaceRoot ?? resolve(process.cwd(), ".tau/async-workspaces"),
    );
    this.maxSessions = options.maxSessions;
    this.systemMessage = options.systemMessage?.trim() || undefined;
    this.now = options.now ?? (() => new Date());
    this.createClient = options.createClient ?? createTauSdkClient;
    this.prepareWorkspace = options.prepareWorkspace ?? prepareWorkspace;
    this.runBootstrapCommands = options.runBootstrapCommands ?? runBootstrapCommands;
    this.cleanupWorkspacePath = options.cleanupWorkspacePath ?? cleanupWorkspacePathOnDisk;
  }

  async createSession(input: {
    projectId: string;
    ownerId?: string;
    prompt?: string;
    additionalSystemMessage?: string;
  }): Promise<AsyncSessionRecord> {
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

    const id = this.createSessionId();
    const now = this.now().toISOString();
    const entry: SessionEntry = {
      record: {
        id,
        projectId: input.projectId,
        ...(input.ownerId ? { ownerId: input.ownerId } : {}),
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
    initializePromise = this.initializeSession(
      entry,
      input.prompt,
      input.additionalSystemMessage,
    ).finally(() => {
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
    const entry = this.getEntryBySessionId(sessionId);
    return entry ? this.toRecord(entry) : undefined;
  }

  getLogs(sessionId: string): AsyncSessionLogEntry[] | undefined {
    const entry = this.getEntryBySessionId(sessionId);
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

  async sendMessage(
    sessionId: string,
    text: string,
    options?: AsyncSessionSubmitOptions,
  ): Promise<AsyncSessionRecord> {
    const entry = this.requireSession(sessionId);
    const trimmed = text.trim();
    if (!trimmed) {
      throw new AsyncSessionManagerError("invalid_state", "message text cannot be empty");
    }

    if (entry.record.state === "running") {
      throw new AsyncSessionManagerError("busy", "session is running");
    }

    if (entry.record.state === "failed") {
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

    void this.submitText(entry, trimmed, "user-message", options?.additionalSystemMessage);
    return this.toRecord(entry);
  }

  async interruptSession(sessionId: string): Promise<AsyncSessionInterruptResult> {
    const entry = this.requireSession(sessionId);

    if (entry.record.state !== "running" || !entry.activeSubmit) {
      return {
        session: this.toRecord(entry),
        interrupted: false,
        isTurnRunning: false,
      };
    }

    if (!entry.client) {
      throw new AsyncSessionManagerError("not_ready", "session is still preparing");
    }

    const result = await entry.client.interrupt();
    this.log(entry, "info", "interrupt requested", {
      interrupted: result.interrupted,
      isTurnRunning: result.isTurnRunning,
    });

    return {
      session: this.toRecord(entry),
      interrupted: result.interrupted,
      isTurnRunning: result.isTurnRunning,
    };
  }

  async closeSession(sessionId: string): Promise<AsyncSessionRecord> {
    const entry = this.requireSession(sessionId);
    return await this.closeEntry(entry, "close requested");
  }

  async closeInactiveSessions(): Promise<AsyncSessionRecord[]> {
    const entries = Array.from(this.sessions.values()).filter((entry) =>
      this.isCloseableWithCloseAll(entry.record.state),
    );

    const closed: AsyncSessionRecord[] = [];
    for (const entry of entries) {
      closed.push(await this.closeEntry(entry, "close requested"));
    }

    return closed;
  }

  async close(): Promise<void> {
    if (this.closePromise) {
      await this.closePromise;
      return;
    }

    this.closePromise = this.closeAllSessions();
    await this.closePromise;
  }

  private async initializeSession(
    entry: SessionEntry,
    prompt?: string,
    additionalSystemMessage?: string,
  ): Promise<void> {
    try {
      const sessionPreparationStart = process.hrtime.bigint();
      this.setState(entry, "preparing-workspace");
      this.log(entry, "info", "preparing workspace", {
        workspaceRoot: this.workspaceRoot,
      });

      const workspacePreparationStart = process.hrtime.bigint();
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
      const workspacePreparationDurationMs = elapsedMs(workspacePreparationStart);

      if (entry.cancelRequested) {
        return;
      }

      entry.record.workspacePath = workspace.workspacePath;
      this.touch(entry);
      this.log(entry, "info", "workspace ready", {
        workspacePath: workspace.workspacePath,
        sessionCwd: workspace.sessionCwd,
        durationMs: workspacePreparationDurationMs,
      });

      const clientConnectStart = process.hrtime.bigint();
      const client = await this.createClient({
        cwd: workspace.sessionCwd,
        ...(entry.project.persona ? { persona: entry.project.persona } : {}),
        ...(entry.project.riskLevel ? { riskLevel: entry.project.riskLevel } : {}),
        ...(entry.project.sandbox !== undefined ? { sandbox: entry.project.sandbox } : {}),
        ...(entry.project.noAgentContextFiles !== undefined
          ? { noAgentContextFiles: entry.project.noAgentContextFiles }
          : {}),
      });
      const clientConnectDurationMs = elapsedMs(clientConnectStart);

      if (entry.cancelRequested) {
        entry.client = client;
        await this.stopClient(entry);
        return;
      }

      entry.client = client;
      entry.record.rpcSessionId = client.ready.sessionId;
      this.touch(entry);
      this.log(entry, "info", "rpc client connected", {
        rpcSessionId: client.ready.sessionId,
        durationMs: clientConnectDurationMs,
      });

      entry.unsubscribeClientEvents = client.onEvent((event) => {
        this.handleClientEvent(entry, event);
      });

      this.log(entry, "info", "session preparation complete", {
        durationMs: elapsedMs(sessionPreparationStart),
      });

      this.startBackgroundBootstrap(entry, workspace.sessionCwd);

      if (prompt?.trim()) {
        await this.submitText(entry, prompt.trim(), "initial-prompt", additionalSystemMessage);
      }

      if (!entry.cancelRequested && entry.record.state !== "failed") {
        this.setState(entry, "waiting-input");
      }
    } catch (error) {
      if (entry.cancelRequested) {
        return;
      }

      if (entry.record.state !== "failed") {
        const message = error instanceof Error ? error.message : String(error);
        entry.record.error = message;
        this.setState(entry, "failed");
        this.log(entry, "error", "session failed", { cause: message });
      }

      await this.stopClient(entry);
    }
  }

  private startBackgroundBootstrap(entry: SessionEntry, sessionCwd: string): void {
    const commands = entry.project.backgroundBootstrapCommands;
    if (!commands || commands.length === 0 || entry.backgroundBootstrapPromise) {
      return;
    }

    let backgroundBootstrapPromise: Promise<void>;
    backgroundBootstrapPromise = this.runBootstrapCommands({
      commands,
      cwd: sessionCwd,
      signal: entry.abortController.signal,
      mode: "background",
      onLog: (workspaceLog) => {
        this.log(
          entry,
          workspaceLog.level === "error" ? "error" : "info",
          workspaceLog.message,
          workspaceLog.data,
        );
      },
    })
      .catch((error) => {
        if (entry.cancelRequested) {
          this.log(entry, "info", "background bootstrap cancelled");
          return;
        }

        this.log(entry, "warn", "background bootstrap failed", {
          cause: error instanceof Error ? error.message : String(error),
        });
      })
      .finally(() => {
        if (entry.backgroundBootstrapPromise === backgroundBootstrapPromise) {
          entry.backgroundBootstrapPromise = undefined;
        }
      });

    entry.backgroundBootstrapPromise = backgroundBootstrapPromise;
  }

  private submitText(
    entry: SessionEntry,
    text: string,
    source: string,
    additionalSystemMessage?: string,
  ): Promise<void> {
    if (!entry.client) {
      throw new AsyncSessionManagerError("not_ready", "session is still preparing");
    }

    if (entry.activeSubmit) {
      throw new AsyncSessionManagerError("busy", "session is running");
    }

    this.setState(entry, "running");
    this.log(entry, "info", "submitting message", { source, text });

    const client = entry.client;
    const payload = this.buildSubmitPayload(text, additionalSystemMessage);

    const submitPromise = (async () => {
      try {
        const result = await client.submit(payload);
        this.log(entry, "info", "message finished", {
          source,
          aborted: result.turn.aborted,
          userHistoryEntryId: result.userHistoryEntryId,
        });

        if (!entry.cancelRequested) {
          this.setState(entry, "waiting-input");
        }
      } catch (error) {
        if (!entry.cancelRequested) {
          const message = error instanceof Error ? error.message : String(error);
          entry.record.error = message;
          this.setState(entry, "failed");
          this.log(entry, "error", "submit failed", { source, cause: message });
          await this.stopClient(entry);
        }
      }
    })();

    entry.activeSubmit = submitPromise;
    void submitPromise.finally(() => {
      if (entry.activeSubmit === submitPromise) {
        entry.activeSubmit = undefined;
      }
    });

    return submitPromise;
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

        const pendingWork = [
          entry.activeSubmit,
          entry.initializePromise,
          entry.backgroundBootstrapPromise,
        ].filter((promise): promise is Promise<void> => promise !== undefined);

        if (pendingWork.length > 0) {
          await Promise.allSettled(pendingWork);
        }
      }),
    );
  }

  private async closeEntry(entry: SessionEntry, message: string): Promise<AsyncSessionRecord> {
    if (this.isActiveState(entry.record.state)) {
      this.requestCancellation(entry, message);
    } else {
      this.log(entry, "info", message);
    }

    await this.stopClient(entry);
    await this.runWorkspaceCleanup(entry);

    const record = this.toRecord(entry);
    this.deleteEntry(entry.record.id);
    return record;
  }

  private async runWorkspaceCleanup(entry: SessionEntry): Promise<void> {
    if (entry.workspaceCleanupPromise) {
      await entry.workspaceCleanupPromise;
      return;
    }

    let cleanupPromise: Promise<void>;
    cleanupPromise = (async () => {
      const pendingWork = [
        entry.activeSubmit,
        entry.initializePromise,
        entry.backgroundBootstrapPromise,
      ].filter((promise): promise is Promise<void> => promise !== undefined);

      if (pendingWork.length > 0) {
        await Promise.allSettled(pendingWork);
      }

      const workspacePath = this.resolveWorkspacePathForCleanup(entry);

      try {
        await this.cleanupWorkspacePath(workspacePath);
        this.log(entry, "info", "workspace cleanup complete", { workspacePath });
      } catch (error) {
        this.log(entry, "warn", "workspace cleanup failed", {
          workspacePath,
          cause: error instanceof Error ? error.message : String(error),
        });
      }
    })().finally(() => {
      if (entry.workspaceCleanupPromise === cleanupPromise) {
        entry.workspaceCleanupPromise = undefined;
      }
    });

    entry.workspaceCleanupPromise = cleanupPromise;
    await cleanupPromise;
  }

  private resolveWorkspacePathForCleanup(entry: SessionEntry): string {
    if (entry.record.workspacePath) {
      return entry.record.workspacePath;
    }

    return resolveWorkspacePath({
      workspaceRoot: entry.project.workspaceRoot ?? this.workspaceRoot,
      projectId: entry.record.projectId,
      sessionId: entry.record.id,
    });
  }

  private requestCancellation(entry: SessionEntry, message: string): void {
    entry.cancelRequested = true;
    entry.abortController.abort();
    this.log(entry, "info", message);
  }

  private async stopClient(entry: SessionEntry): Promise<void> {
    if (entry.unsubscribeClientEvents) {
      entry.unsubscribeClientEvents();
      entry.unsubscribeClientEvents = undefined;
    }

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

  private isCloseableWithCloseAll(state: AsyncSessionState): boolean {
    return state === "waiting-input" || state === "failed";
  }

  private deleteEntry(sessionId: string): void {
    this.sessions.delete(sessionId);
  }

  private getEntryBySessionId(sessionId: string): SessionEntry | undefined {
    return this.sessions.get(sessionId);
  }

  private requireSession(sessionId: string): SessionEntry {
    const entry = this.getEntryBySessionId(sessionId);
    if (!entry) {
      throw new AsyncSessionManagerError("not_found", `session '${sessionId}' not found`);
    }
    return entry;
  }

  private createSessionId(): string {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const random = randomBytes(PUBLIC_SESSION_ID_LENGTH);
      let id = "";
      for (const byte of random) {
        const character = BASE58_ALPHABET[byte % BASE58_ALPHABET.length];
        if (character === undefined) {
          throw new Error("failed to allocate session id");
        }
        id += character;
      }

      if (!this.sessions.has(id)) {
        return id;
      }
    }

    throw new Error("failed to allocate session id");
  }

  private buildSubmitPayload(text: string, additionalSystemMessage?: string): string {
    const messages = [this.systemMessage, additionalSystemMessage?.trim() || undefined].filter(
      (message): message is string => Boolean(message),
    );

    if (messages.length === 0) {
      return text;
    }

    return [`<system>`, messages.join("\n"), `</system>`, text].join("\n");
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

  private handleClientEvent(entry: SessionEntry, sdkEvent: TauSdkEvent): void {
    if (!entry.activeSubmit) {
      return;
    }

    const coreEvent = this.parseCoreEvent(sdkEvent);
    if (!coreEvent) {
      return;
    }

    if (coreEvent.type === "tool_ui") {
      if (coreEvent.uiEvent.type === "bash_started") {
        this.emitProgress(entry, {
          type: "bash-command",
          command: coreEvent.uiEvent.command,
        });
        return;
      }

      if (coreEvent.uiEvent.type === "edit_success") {
        this.emitProgress(entry, {
          type: "edited-file",
          path: coreEvent.uiEvent.path,
        });
        return;
      }

      if (coreEvent.uiEvent.type === "write_success") {
        this.emitProgress(entry, {
          type: "wrote-file",
          path: coreEvent.uiEvent.path,
        });
      }
      return;
    }

    if (coreEvent.type === "assistant_final") {
      const text = extractAssistantText(coreEvent.message);
      if (!text) {
        return;
      }

      this.emitProgress(entry, {
        type: "assistant-message",
        text,
      });
    }
  }

  private parseCoreEvent(sdkEvent: TauSdkEvent): CoreEvent | undefined {
    if (!isRecord(sdkEvent.event)) {
      return undefined;
    }

    const coreEvent = sdkEvent.event.event;
    if (!isRecord(coreEvent) || typeof coreEvent.type !== "string") {
      return undefined;
    }

    return coreEvent as CoreEvent;
  }

  private emitProgress(entry: SessionEntry, progress: AsyncSessionProgress): void {
    this.emit({
      type: "session-progress",
      sessionId: entry.record.id,
      projectId: entry.record.projectId,
      state: entry.record.state,
      timestamp: this.now().toISOString(),
      progress,
    });
  }

  private toRecord(entry: SessionEntry): AsyncSessionRecord {
    return { ...entry.record };
  }
}

type AsyncScopedSessionManagerOptions = {
  sessionManager: AsyncSessionManager;
  ownerId: string;
  allowedProjectIds: Set<string>;
};

const CLOSEABLE_STATES_WITH_CLOSE_ALL: Set<AsyncSessionState> = new Set([
  "waiting-input",
  "failed",
]);

class ScopedAsyncSessionManager implements AsyncSessionManager {
  private readonly sessionManager: AsyncSessionManager;
  private readonly ownerId: string;
  private readonly allowedProjectIds: Set<string>;

  constructor(options: AsyncScopedSessionManagerOptions) {
    this.sessionManager = options.sessionManager;
    this.ownerId = options.ownerId;
    this.allowedProjectIds = options.allowedProjectIds;
  }

  async createSession(input: {
    projectId: string;
    ownerId?: string;
    prompt?: string;
    additionalSystemMessage?: string;
  }): Promise<AsyncSessionRecord> {
    if (!this.allowedProjectIds.has(input.projectId)) {
      throw new AsyncSessionManagerError(
        "invalid_project",
        `unknown async project '${input.projectId}'`,
      );
    }

    return await this.sessionManager.createSession({
      projectId: input.projectId,
      ownerId: this.ownerId,
      ...(input.prompt === undefined ? {} : { prompt: input.prompt }),
      ...(input.additionalSystemMessage === undefined
        ? {}
        : { additionalSystemMessage: input.additionalSystemMessage }),
    });
  }

  listSessions(): AsyncSessionRecord[] {
    return this.sessionManager.listSessions().filter((session) => this.isVisibleSession(session));
  }

  getSession(sessionId: string): AsyncSessionRecord | undefined {
    const session = this.sessionManager.getSession(sessionId);
    if (!session || !this.isVisibleSession(session)) {
      return undefined;
    }

    return session;
  }

  getLogs(sessionId: string): AsyncSessionLogEntry[] | undefined {
    const session = this.sessionManager.getSession(sessionId);
    if (!session || !this.isVisibleSession(session)) {
      return undefined;
    }

    return this.sessionManager.getLogs(sessionId);
  }

  async sendMessage(
    sessionId: string,
    text: string,
    options?: AsyncSessionSubmitOptions,
  ): Promise<AsyncSessionRecord> {
    this.requireSession(sessionId);
    return await this.sessionManager.sendMessage(sessionId, text, options);
  }

  async interruptSession(sessionId: string): Promise<AsyncSessionInterruptResult> {
    this.requireSession(sessionId);
    return await this.sessionManager.interruptSession(sessionId);
  }

  async closeSession(sessionId: string): Promise<AsyncSessionRecord> {
    this.requireSession(sessionId);
    return await this.sessionManager.closeSession(sessionId);
  }

  async closeInactiveSessions(): Promise<AsyncSessionRecord[]> {
    const closeableSessions = this.listSessions().filter((session) =>
      CLOSEABLE_STATES_WITH_CLOSE_ALL.has(session.state),
    );

    const closed: AsyncSessionRecord[] = [];
    for (const session of closeableSessions) {
      closed.push(await this.sessionManager.closeSession(session.id));
    }

    return closed;
  }

  async close(): Promise<void> {
    return;
  }

  onEvent(listener: (event: AsyncSessionManagerEvent) => void): () => void {
    return this.sessionManager.onEvent((event) => {
      if (event.type === "session-created") {
        if (this.isVisibleSession(event.session)) {
          listener(event);
        }
        return;
      }

      const session = this.sessionManager.getSession(event.sessionId);
      if (session && this.isVisibleSession(session)) {
        listener(event);
      }
    });
  }

  private requireSession(sessionId: string): AsyncSessionRecord {
    const session = this.sessionManager.getSession(sessionId);
    if (!session || !this.isVisibleSession(session)) {
      throw new AsyncSessionManagerError("not_found", `session '${sessionId}' not found`);
    }

    return session;
  }

  private isVisibleSession(session: AsyncSessionRecord): boolean {
    return this.allowedProjectIds.has(session.projectId) && session.ownerId === this.ownerId;
  }
}

export function createAsyncSessionManager(
  options: AsyncSessionManagerOptions,
): AsyncSessionManager {
  return new AsyncSessionManagerImpl(options);
}

export function createScopedAsyncSessionManager(options: {
  sessionManager: AsyncSessionManager;
  ownerId: string;
  allowedProjectIds: string[];
}): AsyncSessionManager {
  return new ScopedAsyncSessionManager({
    sessionManager: options.sessionManager,
    ownerId: options.ownerId,
    allowedProjectIds: new Set(options.allowedProjectIds),
  });
}
