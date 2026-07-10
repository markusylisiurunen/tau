import { randomBytes } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { z } from "zod";
import type {
  SessionProtocolCreateParams,
  SessionProtocolDeltaMessage,
  SessionProtocolFacet,
  SessionProtocolInterruptResult,
  SessionProtocolMessage,
  SessionProtocolSnapshot,
  SessionProtocolSteerResult,
  SessionProtocolSubmitResult,
  SessionProtocolUnobserveResult,
} from "../../protocol/session_protocol.js";
import type { TelegramProjectConfig } from "../config/schema.js";
import type { RiskLevel } from "../types.js";
import { extractAssistantText } from "../utils/messages.js";
import { formatTauUserText } from "../utils/user_metadata.js";
import {
  cleanupWorkspacePath as cleanupWorkspacePathOnDisk,
  cleanupWorkspaceRootsOnStartup,
  type PrepareWorkspaceOptions,
  prepareWorkspace,
  type RunBootstrapCommandsOptions,
  resolveWorkspacePath,
  runBootstrapCommands,
  type WorkspaceLogEntry,
} from "./workspace.js";

export type TelegramSessionState =
  | "queued"
  | "preparing-workspace"
  | "running"
  | "waiting-input"
  | "failed";

export type TelegramSessionLogLevel = "info" | "warn" | "error";

export type TelegramSessionLogEntry = {
  timestamp: string;
  level: TelegramSessionLogLevel;
  message: string;
  data?: unknown;
};

export type TelegramSessionProgress =
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

export type TelegramSessionRecord = {
  id: string;
  projectId: string;
  ownerId?: string;
  state: TelegramSessionState;
  createdAt: string;
  updatedAt: string;
  workspacePath?: string;
  tauSessionId?: string;
  error?: string;
};

const persistedTelegramSessionRecordSchema = z
  .object({
    id: z.string().min(1),
    projectId: z.string().min(1),
    ownerId: z.string().min(1).optional(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    tauSessionId: z.string().min(1).optional(),
  })
  .strict();

const telegramSessionStateSchema = z
  .object({
    version: z.literal(1),
    sessions: z.array(persistedTelegramSessionRecordSchema),
  })
  .strict();

type PersistedTelegramSessionRecord = z.infer<typeof persistedTelegramSessionRecordSchema>;

export function resolveTelegramSessionStatePath(workspaceRoot: string): string {
  return `${resolve(workspaceRoot)}-sessions.json`;
}

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const PUBLIC_SESSION_ID_LENGTH = 8;
const NANOSECONDS_PER_MILLISECOND = 1_000_000n;

const ACTIVE_STATES: Set<TelegramSessionState> = new Set([
  "queued",
  "preparing-workspace",
  "running",
  "waiting-input",
]);

function elapsedMs(startTime: bigint): number {
  return Number((process.hrtime.bigint() - startTime) / NANOSECONDS_PER_MILLISECOND);
}

function getErrorCode(error: unknown): string | undefined {
  if (!error || typeof error !== "object" || !("code" in error)) {
    return undefined;
  }
  return typeof error.code === "string" ? error.code : undefined;
}

async function pathIsDirectory(path: string): Promise<boolean> {
  const pathStat = await stat(path).catch((error) => {
    if (getErrorCode(error) === "ENOENT") {
      return undefined;
    }
    throw error;
  });
  return pathStat?.isDirectory() ?? false;
}

export class TelegramSessionManagerError extends Error {
  code: "not_found" | "busy" | "invalid_project" | "not_ready" | "invalid_state" | "max_sessions";

  constructor(
    code: "not_found" | "busy" | "invalid_project" | "not_ready" | "invalid_state" | "max_sessions",
    message: string,
  ) {
    super(message);
    this.name = "TelegramSessionManagerError";
    this.code = code;
  }
}

type SessionEntry = {
  record: TelegramSessionRecord;
  logs: TelegramSessionLogEntry[];
  project: TelegramProjectConfig;
  abortController: AbortController;
  cancelRequested: boolean;
  client?: TelegramSessionClient;
  tauSession?: TelegramTauSession;
  unsubscribeClientEvents?: () => void;
  clientClosePromise?: Promise<void>;
  activeSubmit?: Promise<void>;
  initializePromise?: Promise<void>;
  backgroundBootstrapPromise?: Promise<void>;
  workspaceCleanupPromise?: Promise<void>;
  consumedFacetEventCounts: Map<string, number>;
  emittedAssistantMessageIds: Set<string>;
};

export type TelegramSessionManagerEvent =
  | {
      type: "session-created";
      session: TelegramSessionRecord;
    }
  | {
      type: "session-state-changed";
      sessionId: string;
      projectId: string;
      previousState: TelegramSessionState;
      state: TelegramSessionState;
      updatedAt: string;
    }
  | {
      type: "session-log";
      sessionId: string;
      projectId: string;
      state: TelegramSessionState;
      log: TelegramSessionLogEntry;
    }
  | {
      type: "session-progress";
      sessionId: string;
      projectId: string;
      state: TelegramSessionState;
      timestamp: string;
      progress: TelegramSessionProgress;
    };

export type TelegramSessionSubmitOptions = {
  additionalSystemMessage?: string;
  mode?: "submit" | "steer";
};

export type TelegramSessionClientOptions = {
  cwd: string;
  persona?: string;
  riskLevel?: RiskLevel;
  noAgentContextFiles?: boolean;
};

export type TelegramSessionClientEvent = SessionProtocolDeltaMessage;

export type TelegramTauSession = {
  readonly id: string;
  onDelta(listener: (event: TelegramSessionClientEvent) => void): () => void;
  submit(text: string): Promise<SessionProtocolSubmitResult>;
  steer(text: string): Promise<SessionProtocolSteerResult>;
  interrupt(): Promise<SessionProtocolInterruptResult>;
  snapshot(): Promise<SessionProtocolSnapshot>;
  unobserve(): Promise<SessionProtocolUnobserveResult>;
};

export type TelegramSessionClient = {
  sessions: {
    create(input: SessionProtocolCreateParams): Promise<TelegramTauSession>;
    observe(sessionId: string): Promise<TelegramTauSession>;
  };
  close(): Promise<void>;
};

export type TelegramSessionInterruptResult = {
  session: TelegramSessionRecord;
  interrupted: boolean;
  isTurnRunning: boolean;
};

export type TelegramSessionManager = {
  initialize(): Promise<void>;
  createSession(input: { projectId: string; ownerId?: string }): Promise<TelegramSessionRecord>;
  listSessions(): TelegramSessionRecord[];
  getSession(sessionId: string): TelegramSessionRecord | undefined;
  getLogs(sessionId: string): TelegramSessionLogEntry[] | undefined;
  getSessionSnapshot(sessionId: string): Promise<SessionProtocolSnapshot | undefined>;
  sendMessage(
    sessionId: string,
    text: string,
    options?: TelegramSessionSubmitOptions,
  ): Promise<TelegramSessionRecord>;
  interruptSession(sessionId: string): Promise<TelegramSessionInterruptResult>;
  closeSession(sessionId: string): Promise<TelegramSessionRecord>;
  closeInactiveSessions(): Promise<TelegramSessionRecord[]>;
  close(): Promise<void>;
  onEvent(listener: (event: TelegramSessionManagerEvent) => void): () => void;
};

export type TelegramSessionManagerOptions = {
  projects: Record<string, TelegramProjectConfig>;
  workspaceRoot?: string;
  maxSessions?: number;
  systemMessage?: string;
  persistencePath?: string;
  now?: () => Date;
  onLog?: (entry: WorkspaceLogEntry) => void;
  createClient: (options: TelegramSessionClientOptions) => Promise<TelegramSessionClient>;
  prepareWorkspace?: (options: PrepareWorkspaceOptions) => Promise<{
    workspacePath: string;
    sessionCwd: string;
  }>;
  runBootstrapCommands?: (options: RunBootstrapCommandsOptions) => Promise<void>;
  cleanupWorkspacePath?: (workspacePath: string) => Promise<void>;
};

class TelegramSessionManagerImpl implements TelegramSessionManager {
  private readonly sessions = new Map<string, SessionEntry>();
  private readonly listeners = new Set<(event: TelegramSessionManagerEvent) => void>();
  private readonly projects: Record<string, TelegramProjectConfig>;
  private readonly workspaceRoot: string;
  private readonly maxSessions?: number;
  private readonly systemMessage?: string;
  private readonly persistencePath?: string;
  private readonly now: () => Date;
  private readonly onLog?: (entry: WorkspaceLogEntry) => void;
  private readonly createClient: (
    options: TelegramSessionClientOptions,
  ) => Promise<TelegramSessionClient>;
  private readonly prepareWorkspace: (
    options: PrepareWorkspaceOptions,
  ) => Promise<{ workspacePath: string; sessionCwd: string }>;
  private readonly runBootstrapCommands: (options: RunBootstrapCommandsOptions) => Promise<void>;
  private readonly cleanupWorkspacePath: (workspacePath: string) => Promise<void>;
  private persistenceQueue: Promise<void> = Promise.resolve();
  private initializePromise?: Promise<void>;
  private closePromise?: Promise<void>;

  constructor(options: TelegramSessionManagerOptions) {
    this.projects = options.projects;
    this.workspaceRoot = resolve(
      options.workspaceRoot ?? resolve(process.cwd(), ".tau/telegram-workspaces"),
    );
    this.maxSessions = options.maxSessions;
    this.systemMessage = options.systemMessage?.trim() || undefined;
    this.persistencePath = options.persistencePath ? resolve(options.persistencePath) : undefined;
    this.now = options.now ?? (() => new Date());
    this.onLog = options.onLog;
    if (!options.createClient) {
      throw new Error("missing telegram session client factory");
    }
    this.createClient = options.createClient;
    this.prepareWorkspace = options.prepareWorkspace ?? prepareWorkspace;
    this.runBootstrapCommands = options.runBootstrapCommands ?? runBootstrapCommands;
    this.cleanupWorkspacePath = options.cleanupWorkspacePath ?? cleanupWorkspacePathOnDisk;
  }

  async initialize(): Promise<void> {
    if (!this.initializePromise) {
      this.initializePromise = this.restorePersistedSessions();
    }
    await this.initializePromise;
  }

  async createSession(input: {
    projectId: string;
    ownerId?: string;
  }): Promise<TelegramSessionRecord> {
    await this.initialize();
    const project = this.projects[input.projectId];
    if (!project) {
      throw new TelegramSessionManagerError(
        "invalid_project",
        `unknown telegram project '${input.projectId}'`,
      );
    }

    if (this.maxSessions !== undefined && this.countActiveSessions() >= this.maxSessions) {
      throw new TelegramSessionManagerError("max_sessions", "maximum session count reached");
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
      consumedFacetEventCounts: new Map(),
      emittedAssistantMessageIds: new Set(),
    };

    this.sessions.set(id, entry);
    try {
      await this.persistSessions();
    } catch (error) {
      this.sessions.delete(id);
      throw error;
    }

    this.log(entry, "info", "session queued");
    this.emit({
      type: "session-created",
      session: this.toRecord(entry),
    });

    let initializePromise: Promise<void>;
    initializePromise = this.initializeSession(entry).finally(() => {
      if (entry.initializePromise === initializePromise) {
        entry.initializePromise = undefined;
      }
    });

    entry.initializePromise = initializePromise;
    return this.toRecord(entry);
  }

  listSessions(): TelegramSessionRecord[] {
    return Array.from(this.sessions.values()).map((entry) => this.toRecord(entry));
  }

  getSession(sessionId: string): TelegramSessionRecord | undefined {
    const entry = this.getEntryBySessionId(sessionId);
    return entry ? this.toRecord(entry) : undefined;
  }

  getLogs(sessionId: string): TelegramSessionLogEntry[] | undefined {
    const entry = this.getEntryBySessionId(sessionId);
    if (!entry) {
      return undefined;
    }

    return entry.logs.map((logEntry) => ({ ...logEntry }));
  }

  async getSessionSnapshot(sessionId: string): Promise<SessionProtocolSnapshot | undefined> {
    const entry = this.getEntryBySessionId(sessionId);
    if (!entry?.tauSession) {
      return undefined;
    }

    return await entry.tauSession.snapshot();
  }

  onEvent(listener: (event: TelegramSessionManagerEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  async sendMessage(
    sessionId: string,
    text: string,
    options?: TelegramSessionSubmitOptions,
  ): Promise<TelegramSessionRecord> {
    const entry = this.requireSession(sessionId);
    const trimmed = text.trim();
    if (!trimmed) {
      throw new TelegramSessionManagerError("invalid_state", "message text cannot be empty");
    }

    if (entry.record.state === "failed") {
      throw new TelegramSessionManagerError(
        "invalid_state",
        `cannot submit messages when session is ${entry.record.state}`,
      );
    }

    if (!entry.tauSession) {
      throw new TelegramSessionManagerError("not_ready", "session is still preparing");
    }

    const mode = options?.mode ?? "submit";
    if (mode !== "steer" && (entry.record.state === "running" || entry.activeSubmit)) {
      throw new TelegramSessionManagerError("busy", "session is running");
    }

    void this.submitText(entry, trimmed, "user-message", options?.additionalSystemMessage, mode);
    return this.toRecord(entry);
  }

  async interruptSession(sessionId: string): Promise<TelegramSessionInterruptResult> {
    const entry = this.requireSession(sessionId);

    if (entry.record.state !== "running" || !entry.activeSubmit) {
      return {
        session: this.toRecord(entry),
        interrupted: false,
        isTurnRunning: false,
      };
    }

    if (!entry.tauSession) {
      throw new TelegramSessionManagerError("not_ready", "session is still preparing");
    }

    const result = await entry.tauSession.interrupt();
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

  async closeSession(sessionId: string): Promise<TelegramSessionRecord> {
    const entry = this.requireSession(sessionId);
    return await this.closeEntry(entry, "close requested");
  }

  async closeInactiveSessions(): Promise<TelegramSessionRecord[]> {
    const entries = Array.from(this.sessions.values()).filter((entry) =>
      this.isCloseableWithCloseAll(entry.record.state),
    );

    const closed: TelegramSessionRecord[] = [];
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

  private async restorePersistedSessions(): Promise<void> {
    if (!this.persistencePath) {
      return;
    }

    const raw = await readFile(this.persistencePath, "utf8").catch((error) => {
      if (getErrorCode(error) === "ENOENT") {
        return undefined;
      }
      throw error;
    });
    let persistedSessions: PersistedTelegramSessionRecord[] = [];
    if (raw !== undefined) {
      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(raw);
      } catch (error) {
        throw new Error(
          `invalid telegram session state: ${error instanceof Error ? error.message : String(error)}`,
        );
      }

      const parsed = telegramSessionStateSchema.safeParse(parsedJson);
      if (!parsed.success) {
        throw new Error(`invalid telegram session state: ${parsed.error.message}`);
      }
      persistedSessions = parsed.data.sessions;
    }

    for (const record of persistedSessions) {
      const project = this.projects[record.projectId];
      if (!project || this.sessions.has(record.id)) {
        continue;
      }

      const entry: SessionEntry = {
        record: {
          ...record,
          state: record.tauSessionId ? "waiting-input" : "queued",
        },
        logs: [],
        project,
        abortController: new AbortController(),
        cancelRequested: false,
        consumedFacetEventCounts: new Map(),
        emittedAssistantMessageIds: new Set(),
      };
      this.sessions.set(record.id, entry);
    }

    await this.cleanupOrphanedWorkspaces();

    await Promise.all(
      Array.from(this.sessions.values(), async (entry) => {
        try {
          if (!entry.record.tauSessionId) {
            await this.initializeSession(entry);
            return;
          }
          await this.reconnectSession(entry);
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          entry.record.error = `recovery failed: ${message}`;
          this.setState(entry, "failed");
          this.log(entry, "error", "session recovery failed", { cause: message });
          await this.stopClient(entry);
        }
      }),
    );

    await this.persistSessions();
  }

  private async cleanupOrphanedWorkspaces(): Promise<void> {
    const workspaceRoots = new Set<string>([this.workspaceRoot]);
    const preservedWorkspacePaths: string[] = [];

    for (const entry of this.sessions.values()) {
      const workspaceRoot = resolve(entry.project.workspaceRoot ?? this.workspaceRoot);
      workspaceRoots.add(workspaceRoot);
      preservedWorkspacePaths.push(
        resolveWorkspacePath({
          workspaceRoot,
          projectId: entry.record.projectId,
          sessionId: entry.record.id,
        }),
      );
    }

    for (const project of Object.values(this.projects)) {
      if (project.workspaceRoot) {
        workspaceRoots.add(resolve(project.workspaceRoot));
      }
    }

    const results = await cleanupWorkspaceRootsOnStartup(
      Array.from(workspaceRoots),
      preservedWorkspacePaths,
    );
    for (const result of results) {
      if (result.deletedEntries > 0) {
        this.onLog?.({
          level: "info",
          message: "startup workspace cleanup complete",
          data: {
            workspaceRoot: result.workspaceRoot,
            deletedEntries: result.deletedEntries,
          },
        });
      }
      for (const failure of result.failures) {
        this.onLog?.({
          level: "error",
          message: "startup workspace cleanup failed",
          data: {
            workspaceRoot: result.workspaceRoot,
            path: failure.path,
            cause: failure.cause,
          },
        });
      }
    }
  }

  private async reconnectSession(entry: SessionEntry): Promise<void> {
    const tauSessionId = entry.record.tauSessionId;
    if (!tauSessionId) {
      throw new Error("persisted session is missing its Tau session id");
    }

    let workspacePath = resolveWorkspacePath({
      workspaceRoot: entry.project.workspaceRoot ?? this.workspaceRoot,
      projectId: entry.record.projectId,
      sessionId: entry.record.id,
    });
    let sessionCwd = resolve(workspacePath, entry.project.workingDirectory ?? ".");
    const shouldPrepareWorkspace = !(await pathIsDirectory(sessionCwd));
    if (shouldPrepareWorkspace) {
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
      workspacePath = workspace.workspacePath;
      sessionCwd = workspace.sessionCwd;
    }
    entry.record.workspacePath = workspacePath;

    const client = await this.createClient(this.buildClientOptions(entry, sessionCwd));
    entry.client = client;
    const tauSession = await client.sessions.observe(tauSessionId);
    entry.tauSession = tauSession;
    entry.unsubscribeClientEvents = tauSession.onDelta((event) => {
      this.handleClientEvent(entry, event);
    });
    entry.record.error = undefined;
    this.setState(entry, "waiting-input");
    this.log(entry, "info", "session recovered", { tauSessionId, workspacePath });
    if (shouldPrepareWorkspace) {
      this.startBackgroundBootstrap(entry, sessionCwd);
    }
  }

  private persistSessions(): Promise<void> {
    const persistencePath = this.persistencePath;
    if (!persistencePath) {
      return Promise.resolve();
    }

    const write = this.persistenceQueue
      .catch(() => undefined)
      .then(async () => {
        const state: z.infer<typeof telegramSessionStateSchema> = {
          version: 1,
          sessions: Array.from(this.sessions.values())
            .filter((entry) => this.isActiveState(entry.record.state))
            .map((entry) => ({
              id: entry.record.id,
              projectId: entry.record.projectId,
              ...(entry.record.ownerId ? { ownerId: entry.record.ownerId } : {}),
              createdAt: entry.record.createdAt,
              updatedAt: entry.record.updatedAt,
              ...(entry.record.tauSessionId ? { tauSessionId: entry.record.tauSessionId } : {}),
            })),
        };
        await mkdir(dirname(persistencePath), { recursive: true });
        const temporaryPath = `${persistencePath}.tmp`;
        await writeFile(temporaryPath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
        await rename(temporaryPath, persistencePath);
      });
    this.persistenceQueue = write;
    return write;
  }

  private async initializeSession(entry: SessionEntry): Promise<void> {
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
      const client = await this.createClient(this.buildClientOptions(entry, workspace.sessionCwd));
      entry.client = client;
      const tauSession = await client.sessions.create({
        executionEnvironment: {
          kind: "local",
          cwd: workspace.sessionCwd,
        },
      });
      const clientConnectDurationMs = elapsedMs(clientConnectStart);

      if (entry.cancelRequested) {
        entry.tauSession = tauSession;
        await this.stopClient(entry);
        return;
      }

      entry.tauSession = tauSession;
      entry.record.tauSessionId = tauSession.id;
      this.touch(entry);
      this.log(entry, "info", "session client connected", {
        tauSessionId: tauSession.id,
        durationMs: clientConnectDurationMs,
      });

      entry.unsubscribeClientEvents = tauSession.onDelta((event) => {
        this.handleClientEvent(entry, event);
      });

      this.log(entry, "info", "session preparation complete", {
        durationMs: elapsedMs(sessionPreparationStart),
      });

      this.startBackgroundBootstrap(entry, workspace.sessionCwd);

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
    mode: "submit" | "steer" = "submit",
  ): Promise<void> {
    if (!entry.tauSession) {
      throw new TelegramSessionManagerError("not_ready", "session is still preparing");
    }

    if (entry.activeSubmit && mode !== "steer") {
      throw new TelegramSessionManagerError("busy", "session is running");
    }

    this.setState(entry, "running");
    this.log(entry, "info", mode === "steer" ? "steering message" : "submitting message", {
      source,
      text,
    });

    const previousSubmit = entry.activeSubmit;
    const tauSession = entry.tauSession;
    const payload = this.buildSubmitPayload(text, additionalSystemMessage);

    let submitPromise!: Promise<void>;
    submitPromise = (async () => {
      try {
        const result =
          mode === "steer" ? await tauSession.steer(payload) : await tauSession.submit(payload);
        this.log(entry, result.turn.blocked ? "error" : "info", "message finished", {
          source,
          aborted: result.turn.aborted,
          blocked: result.turn.blocked,
          userHistoryEntryId: result.userHistoryEntryId,
        });

        if (!entry.cancelRequested) {
          if (result.turn.blocked) {
            entry.record.error = result.turn.blocked.message;
            this.setState(entry, "failed");
          } else if (!entry.activeSubmit || entry.activeSubmit === submitPromise) {
            this.setState(entry, "waiting-input");
          }
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

    const trackedSubmit = previousSubmit
      ? Promise.all([previousSubmit, submitPromise]).then(() => undefined)
      : submitPromise;
    entry.activeSubmit = trackedSubmit;
    void trackedSubmit
      .catch(() => undefined)
      .finally(() => {
        if (entry.activeSubmit === trackedSubmit) {
          entry.activeSubmit = undefined;
          if (!entry.cancelRequested && entry.record.state === "running") {
            this.setState(entry, "waiting-input");
          }
        }
      });

    return submitPromise;
  }

  private buildClientOptions(entry: SessionEntry, cwd: string): TelegramSessionClientOptions {
    const options: TelegramSessionClientOptions = { cwd };
    if (entry.project.persona) {
      options.persona = entry.project.persona;
    }
    if (entry.project.riskLevel) {
      options.riskLevel = entry.project.riskLevel;
    }
    if (entry.project.noAgentContextFiles !== undefined) {
      options.noAgentContextFiles = entry.project.noAgentContextFiles;
    }
    return options;
  }

  private async closeAllSessions(): Promise<void> {
    const entries = Array.from(this.sessions.values());

    for (const entry of entries) {
      if (this.isActiveState(entry.record.state)) {
        entry.cancelRequested = true;
        entry.abortController.abort();
      }
      if (entry.record.state === "running") {
        this.setState(entry, "waiting-input");
      }
    }

    await Promise.allSettled(entries.map(async (entry) => await this.stopClient(entry)));
    await Promise.allSettled(
      entries.flatMap((entry) =>
        [entry.initializePromise, entry.activeSubmit, entry.backgroundBootstrapPromise].filter(
          (promise): promise is Promise<void> => promise !== undefined,
        ),
      ),
    );
    await this.persistSessions();
  }

  private async closeEntry(entry: SessionEntry, message: string): Promise<TelegramSessionRecord> {
    if (this.isActiveState(entry.record.state)) {
      this.requestCancellation(entry, message);
    } else {
      this.log(entry, "info", message);
    }

    await this.stopClient(entry);
    await this.runWorkspaceCleanup(entry);

    const record = this.toRecord(entry);
    this.sessions.delete(entry.record.id);
    await this.persistSessions();
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
    const tauSession = entry.tauSession;

    let closePromise: Promise<void>;
    closePromise = (async () => {
      try {
        await tauSession?.interrupt();
      } catch (error) {
        this.log(entry, "warn", "interrupt failed", {
          cause: error instanceof Error ? error.message : String(error),
        });
      }

      try {
        await tauSession?.unobserve();
      } catch (error) {
        this.log(entry, "warn", "unobserve failed", {
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
      if (entry.tauSession === tauSession) {
        entry.tauSession = undefined;
      }
    });

    entry.clientClosePromise = closePromise;
    await closePromise;
  }

  private isActiveState(state: TelegramSessionState): boolean {
    return ACTIVE_STATES.has(state);
  }

  private isCloseableWithCloseAll(state: TelegramSessionState): boolean {
    return CLOSEABLE_STATES_WITH_CLOSE_ALL.has(state);
  }

  private getEntryBySessionId(sessionId: string): SessionEntry | undefined {
    return this.sessions.get(sessionId);
  }

  private requireSession(sessionId: string): SessionEntry {
    const entry = this.getEntryBySessionId(sessionId);
    if (!entry) {
      throw new TelegramSessionManagerError("not_found", `session '${sessionId}' not found`);
    }
    return entry;
  }

  private createSessionId(): string {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const random = randomBytes(PUBLIC_SESSION_ID_LENGTH);
      let id = "";
      for (const byte of random) {
        id += BASE58_ALPHABET[byte % BASE58_ALPHABET.length];
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

    return formatTauUserText({ text, hiddenSystemMessages: [messages.join("\n")] });
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

  private setState(entry: SessionEntry, state: TelegramSessionState): void {
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
    void this.persistSessions().catch((error) => {
      this.onLog?.({
        level: "error",
        message: "session state persistence failed",
        data: { cause: error instanceof Error ? error.message : String(error) },
      });
    });
  }

  private log(
    entry: SessionEntry,
    level: TelegramSessionLogLevel,
    message: string,
    data?: unknown,
  ): void {
    const logEntry: TelegramSessionLogEntry = {
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

  private emit(event: TelegramSessionManagerEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // ignore listener errors to keep session processing stable
      }
    }
  }

  private handleClientEvent(entry: SessionEntry, clientEvent: TelegramSessionClientEvent): void {
    if (clientEvent.delta.type === "snapshot.reset") {
      if (clientEvent.reason !== "assistant-message") {
        return;
      }

      const messages = clientEvent.delta.snapshot.messages;
      for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        if (message?.state === "committed" && isAssistantMessage(message.message)) {
          this.handleAssistantMessageProgress(entry, message);
          break;
        }
      }
      return;
    }

    for (const change of clientEvent.delta.changes) {
      if (change.type === "facet.set") {
        this.handleFacetProgress(entry, change.facet);
        continue;
      }

      if (clientEvent.reason !== "assistant-message") {
        continue;
      }

      if (change.type === "message.append" || change.type === "message.replace") {
        this.handleAssistantMessageProgress(entry, change.message);
      }
    }
  }

  private handleAssistantMessageProgress(
    entry: SessionEntry,
    message: SessionProtocolMessage,
  ): void {
    if (
      message.state !== "committed" ||
      !isAssistantMessage(message.message) ||
      entry.emittedAssistantMessageIds.has(message.id)
    ) {
      return;
    }

    const text = extractAssistantText(message.message);
    if (!text) {
      return;
    }

    entry.emittedAssistantMessageIds.add(message.id);
    this.emitProgress(entry, {
      type: "assistant-message",
      text,
    });
  }

  private handleFacetProgress(entry: SessionEntry, facet: SessionProtocolFacet): void {
    if (facet.kind !== "tau.tool-ui-events" || !Array.isArray(facet.data.events)) {
      return;
    }
    const consumed = Math.min(
      entry.consumedFacetEventCounts.get(facet.id) ?? 0,
      facet.data.events.length,
    );
    entry.consumedFacetEventCounts.set(facet.id, facet.data.events.length);

    for (const event of facet.data.events.slice(consumed)) {
      if (!isToolUiEvent(event)) {
        continue;
      }
      switch (event.type) {
        case "bash_started":
          if (typeof event.command === "string") {
            this.emitProgress(entry, {
              type: "bash-command",
              command: event.command,
            });
          }
          break;
        case "edit_success":
          if (typeof event.path === "string") {
            this.emitProgress(entry, {
              type: "edited-file",
              path: event.path,
            });
          }
          break;
        case "write_success":
          if (typeof event.path === "string") {
            this.emitProgress(entry, {
              type: "wrote-file",
              path: event.path,
            });
          }
          break;
      }
    }
  }

  private emitProgress(entry: SessionEntry, progress: TelegramSessionProgress): void {
    this.emit({
      type: "session-progress",
      sessionId: entry.record.id,
      projectId: entry.record.projectId,
      state: entry.record.state,
      timestamp: this.now().toISOString(),
      progress,
    });
  }

  private toRecord(entry: SessionEntry): TelegramSessionRecord {
    return { ...entry.record };
  }
}

function isAssistantMessage(message: unknown): message is AssistantMessage {
  return (
    typeof message === "object" &&
    message !== null &&
    "role" in message &&
    message.role === "assistant" &&
    "usage" in message &&
    "stopReason" in message
  );
}

function isToolUiEvent(value: unknown): value is {
  type: string;
  toolCallId: string;
  command?: string;
  path?: string;
} {
  return (
    typeof value === "object" &&
    value !== null &&
    "type" in value &&
    typeof value.type === "string" &&
    "toolCallId" in value &&
    typeof value.toolCallId === "string"
  );
}

type AsyncScopedSessionManagerOptions = {
  sessionManager: TelegramSessionManager;
  ownerId: string;
  allowedProjectIds: Set<string>;
};

const CLOSEABLE_STATES_WITH_CLOSE_ALL: Set<TelegramSessionState> = new Set([
  "waiting-input",
  "failed",
]);

class ScopedTelegramSessionManager implements TelegramSessionManager {
  private readonly sessionManager: TelegramSessionManager;
  private readonly ownerId: string;
  private readonly allowedProjectIds: Set<string>;

  constructor(options: AsyncScopedSessionManagerOptions) {
    this.sessionManager = options.sessionManager;
    this.ownerId = options.ownerId;
    this.allowedProjectIds = options.allowedProjectIds;
  }

  async initialize(): Promise<void> {
    await this.sessionManager.initialize();
  }

  async createSession(input: {
    projectId: string;
    ownerId?: string;
  }): Promise<TelegramSessionRecord> {
    if (!this.allowedProjectIds.has(input.projectId)) {
      throw new TelegramSessionManagerError(
        "invalid_project",
        `unknown telegram project '${input.projectId}'`,
      );
    }

    return await this.sessionManager.createSession({
      projectId: input.projectId,
      ownerId: this.ownerId,
    });
  }

  listSessions(): TelegramSessionRecord[] {
    return this.sessionManager.listSessions().filter((session) => this.isVisibleSession(session));
  }

  getSession(sessionId: string): TelegramSessionRecord | undefined {
    const session = this.sessionManager.getSession(sessionId);
    if (!session || !this.isVisibleSession(session)) {
      return undefined;
    }

    return session;
  }

  getLogs(sessionId: string): TelegramSessionLogEntry[] | undefined {
    const session = this.sessionManager.getSession(sessionId);
    if (!session || !this.isVisibleSession(session)) {
      return undefined;
    }

    return this.sessionManager.getLogs(sessionId);
  }

  async getSessionSnapshot(sessionId: string): Promise<SessionProtocolSnapshot | undefined> {
    this.requireSession(sessionId);
    return await this.sessionManager.getSessionSnapshot(sessionId);
  }

  async sendMessage(
    sessionId: string,
    text: string,
    options?: TelegramSessionSubmitOptions,
  ): Promise<TelegramSessionRecord> {
    this.requireSession(sessionId);
    return await this.sessionManager.sendMessage(sessionId, text, options);
  }

  async interruptSession(sessionId: string): Promise<TelegramSessionInterruptResult> {
    this.requireSession(sessionId);
    return await this.sessionManager.interruptSession(sessionId);
  }

  async closeSession(sessionId: string): Promise<TelegramSessionRecord> {
    this.requireSession(sessionId);
    return await this.sessionManager.closeSession(sessionId);
  }

  async closeInactiveSessions(): Promise<TelegramSessionRecord[]> {
    const closeableSessions = this.listSessions().filter((session) =>
      CLOSEABLE_STATES_WITH_CLOSE_ALL.has(session.state),
    );

    const closed: TelegramSessionRecord[] = [];
    for (const session of closeableSessions) {
      closed.push(await this.sessionManager.closeSession(session.id));
    }

    return closed;
  }

  async close(): Promise<void> {
    return;
  }

  onEvent(listener: (event: TelegramSessionManagerEvent) => void): () => void {
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

  private requireSession(sessionId: string): TelegramSessionRecord {
    const session = this.sessionManager.getSession(sessionId);
    if (!session || !this.isVisibleSession(session)) {
      throw new TelegramSessionManagerError("not_found", `session '${sessionId}' not found`);
    }

    return session;
  }

  private isVisibleSession(session: TelegramSessionRecord): boolean {
    return this.allowedProjectIds.has(session.projectId) && session.ownerId === this.ownerId;
  }
}

export function createTelegramSessionManager(
  options: TelegramSessionManagerOptions,
): TelegramSessionManager {
  return new TelegramSessionManagerImpl(options);
}

export function createScopedTelegramSessionManager(options: {
  sessionManager: TelegramSessionManager;
  ownerId: string;
  allowedProjectIds: string[];
}): TelegramSessionManager {
  return new ScopedTelegramSessionManager({
    sessionManager: options.sessionManager,
    ownerId: options.ownerId,
    allowedProjectIds: new Set(options.allowedProjectIds),
  });
}
