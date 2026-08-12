import { randomBytes, randomUUID } from "node:crypto";
import { mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { z } from "zod";
import type {
  SessionProtocolCompactResult,
  SessionProtocolCreateParams,
  SessionProtocolDeltaMessage,
  SessionProtocolExecResult,
  SessionProtocolFacet,
  SessionProtocolInterruptResult,
  SessionProtocolMessage,
  SessionProtocolReasoningEffort,
  SessionProtocolSettingsUpdateResult,
  SessionProtocolSnapshot,
  SessionProtocolSteerResult,
  SessionProtocolSubmitResult,
  SessionProtocolTimelineNotice,
  SessionProtocolTurnOutcome,
  SessionProtocolTurnRecord,
  SessionProtocolUnobserveResult,
} from "../../protocol/session_protocol.js";
import { TauSessionProtocolResponseError } from "../../transport/errors.js";
import type { TelegramDirectoryProjectConfig, TelegramProjectConfig } from "../config/schema.js";
import { extractAssistantText } from "../utils/messages.js";
import { buildRepositoryAttribute, normalizeRepositoryReference } from "../utils/repository.js";
import { formatTauUserText } from "../utils/user_metadata.js";
import {
  cleanupWorkspacePath as cleanupWorkspacePathOnDisk,
  cleanupWorkspaceRootsOnStartup,
  type PreparedWorkspace,
  type PrepareWorkspaceOptions,
  prepareWorkspace,
  resolveWorkspacePath,
  type WorkspaceLogEntry,
  type WorkspaceProvisionTarget,
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
      messageId: string;
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

const telegramSessionStateValueSchema = z.enum([
  "queued",
  "preparing-workspace",
  "running",
  "waiting-input",
  "failed",
]);

const persistedTelegramSessionRecordV1Schema = z
  .object({
    id: z.string().min(1),
    projectId: z.string().min(1),
    ownerId: z.string().min(1).optional(),
    createdAt: z.string().datetime(),
    updatedAt: z.string().datetime(),
    tauSessionId: z.string().min(1).optional(),
  })
  .strip();

const persistedTelegramSessionRecordV2Schema = persistedTelegramSessionRecordV1Schema.extend({
  state: telegramSessionStateValueSchema,
  error: z.string().min(1).optional(),
});

const persistedTelegramSessionRecordV3Schema = persistedTelegramSessionRecordV2Schema.extend({
  activeTurnIds: z.array(z.string().min(1)),
});

const persistedTelegramTurnFailureSchema = z.discriminatedUnion("status", [
  z
    .object({
      status: z.literal("failed"),
      stopReason: z.literal("error"),
      errorMessage: z.string().optional(),
    })
    .strip(),
  z
    .object({
      status: z.literal("blocked"),
      reason: z.literal("auto-compaction-failed"),
      message: z.string(),
    })
    .strip(),
]);

const persistedTelegramTurnNotificationSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("failed"),
      historyEntryId: z.string().min(1),
      timestamp: z.string().datetime(),
      failure: persistedTelegramTurnFailureSchema,
    })
    .strip(),
  z
    .object({
      kind: z.literal("rejected"),
      historyEntryId: z.string().min(1),
      timestamp: z.string().datetime(),
    })
    .strip(),
]);

const persistedTelegramSessionRecordSchema = persistedTelegramSessionRecordV3Schema.extend({
  pendingTurnNotifications: z.array(persistedTelegramTurnNotificationSchema),
});

const telegramSessionStateSchema = z.discriminatedUnion("version", [
  z
    .object({
      version: z.literal(1),
      sessions: z.array(persistedTelegramSessionRecordV1Schema),
    })
    .strip(),
  z
    .object({
      version: z.literal(2),
      sessions: z.array(persistedTelegramSessionRecordV2Schema),
    })
    .strip(),
  z
    .object({
      version: z.literal(3),
      sessions: z.array(persistedTelegramSessionRecordV3Schema),
    })
    .strip(),
  z
    .object({
      version: z.literal(4),
      sessions: z.array(persistedTelegramSessionRecordSchema),
    })
    .strip(),
]);

type PersistedTelegramTurnNotification = z.infer<typeof persistedTelegramTurnNotificationSchema>;

type PersistedTelegramSessionRecord = z.infer<typeof persistedTelegramSessionRecordSchema>;

type PersistedTelegramSessionState = z.infer<typeof telegramSessionStateSchema>;

function normalizePersistedTelegramSessions(
  state: PersistedTelegramSessionState,
): PersistedTelegramSessionRecord[] {
  if (state.version === 4) {
    return state.sessions;
  }
  if (state.version === 3) {
    return state.sessions.map((record) => ({ ...record, pendingTurnNotifications: [] }));
  }
  if (state.version === 2) {
    return state.sessions.map((record) => ({
      ...record,
      activeTurnIds: [],
      pendingTurnNotifications: [],
    }));
  }
  return state.sessions.map((record) => ({
    ...record,
    state: record.tauSessionId ? "waiting-input" : "queued",
    activeTurnIds: [],
    pendingTurnNotifications: [],
  }));
}

export function resolveTelegramSessionStatePath(workspaceRoot: string): string {
  return `${resolve(workspaceRoot)}-sessions.json`;
}

const BASE58_ALPHABET = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
const PUBLIC_SESSION_ID_LENGTH = 8;
const NANOSECONDS_PER_MILLISECOND = 1_000_000n;
const PROVISION_SCRIPT_PATH = ".tau/scripts/provision";
const MAX_PROVISION_DIAGNOSTIC_CHARS = 2_000;
const TURN_RECOVERY_POLL_INTERVAL_MS = 1_000;

const ACTIVE_STATES: Set<TelegramSessionState> = new Set([
  "queued",
  "preparing-workspace",
  "running",
  "waiting-input",
]);

function isDirectoryProject(
  project: TelegramProjectConfig,
): project is TelegramDirectoryProjectConfig {
  return "directory" in project;
}

function elapsedMs(startTime: bigint): number {
  return Number((process.hrtime.bigint() - startTime) / NANOSECONDS_PER_MILLISECOND);
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function buildProvisionCommand(repositoryRoot: string): string {
  return [
    `provision_path=${shellQuote(resolve(repositoryRoot, PROVISION_SCRIPT_PATH))}`,
    'if [ ! -e "$provision_path" ] && [ ! -L "$provision_path" ]; then exit 0; fi',
    'if [ -L "$provision_path" ] || [ ! -f "$provision_path" ]; then echo ".tau/scripts/provision must be a regular file" >&2; exit 1; fi',
    'if [ ! -x "$provision_path" ]; then echo ".tau/scripts/provision must be executable" >&2; exit 1; fi',
    'provision_prefix=$(LC_ALL=C dd if="$provision_path" bs=2 count=1 2>/dev/null)',
    'if [ "$provision_prefix" != "#!" ]; then echo ".tau/scripts/provision must start with a shebang" >&2; exit 1; fi',
    'exec "$provision_path"',
  ].join("\n");
}

function isCancelledProtocolResponse(error: unknown): boolean {
  return error instanceof TauSessionProtocolResponseError && error.code === "cancelled";
}

function formatErrorDiagnostic(error: unknown): string {
  const messages: string[] = [];
  const seen = new Set<unknown>();
  let current = error;
  while (current !== undefined && !seen.has(current)) {
    seen.add(current);
    messages.push(current instanceof Error ? current.message : String(current));
    if (current instanceof TauSessionProtocolResponseError) {
      const data = current.data;
      if (
        typeof data === "object" &&
        data !== null &&
        "cause" in data &&
        typeof data.cause === "string"
      ) {
        messages.push(data.cause);
      }
    }
    current = current instanceof Error ? current.cause : undefined;
  }
  return messages.filter((message, index) => message && message !== messages[index - 1]).join(": ");
}

function truncateProvisionDiagnostic(diagnostic: string): string {
  const trimmed = diagnostic.trim();
  if (trimmed.length <= MAX_PROVISION_DIAGNOSTIC_CHARS) {
    return trimmed;
  }
  return `...${trimmed.slice(-(MAX_PROVISION_DIAGNOSTIC_CHARS - 3))}`;
}

function formatProvisionFailure(result: SessionProtocolExecResult): string {
  const status = `provision exited with code ${result.exitCode ?? "unknown"}`;
  const output = result.output.trim();
  return truncateProvisionDiagnostic(output ? `${status}\n${output}` : status);
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
  provisionPromise?: Promise<void>;
  workspaceCleanupPromise?: Promise<void>;
  consumedFacetEventCounts: Map<string, number>;
  emittedAssistantMessageIds: Set<string>;
  emittedNoticeIds: Set<string>;
  finalAssistantResponse?: { messageId: string; text: string };
  turnSequenceUnsuccessful: boolean;
  activeTurnIds: Set<string>;
  settledTurnIds: Set<string>;
  pendingTurnNotifications: Map<string, PersistedTelegramTurnNotification>;
  emittedTurnNotificationIds: Set<string>;
  turnChangeResolvers: Map<string, () => void>;
};

export type TelegramSessionProvisionFailure = {
  type: "session-provision-failed";
  sessionId: string;
  projectId: string;
  targetProjectId: string;
  diagnostic: string;
};

export type TelegramSessionTurnFailure = {
  type: "session-turn-failed";
  sessionId: string;
  projectId: string;
  timestamp: string;
  historyEntryId: string;
  failure: Extract<SessionProtocolTurnOutcome, { status: "failed" | "blocked" }>;
};

export type TelegramSessionTurnRejected = {
  type: "session-turn-rejected";
  sessionId: string;
  projectId: string;
  timestamp: string;
  historyEntryId: string;
};

export type TelegramSessionTurnNotification =
  | TelegramSessionTurnFailure
  | TelegramSessionTurnRejected;

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
  | TelegramSessionTurnNotification
  | {
      type: "session-notice";
      sessionId: string;
      projectId: string;
      timestamp: string;
      severity: "warn" | "error";
      text: string;
    }
  | {
      type: "session-progress";
      sessionId: string;
      projectId: string;
      state: TelegramSessionState;
      timestamp: string;
      progress: TelegramSessionProgress;
    }
  | {
      type: "session-response-completed";
      sessionId: string;
      projectId: string;
      timestamp: string;
      messageId: string;
      text: string;
    }
  | TelegramSessionProvisionFailure;

function shouldDeliverTelegramTimelineNotice(
  notice: SessionProtocolTimelineNotice,
): notice is SessionProtocolTimelineNotice & { severity: "warn" | "error" } {
  return (
    notice.severity !== "info" &&
    notice.kind !== "tau.turn.failed" &&
    notice.kind !== "tau.turn.blocked"
  );
}

function formatTelegramTimelineNotice(notice: SessionProtocolTimelineNotice): string {
  const title = notice.presentation.title.trim();
  const sentence = `${title.charAt(0).toLocaleUpperCase()}${title.slice(1)}`;
  return /[.!?]$/.test(sentence) ? sentence : `${sentence}.`;
}

export type TelegramSessionSubmitOptions = {
  additionalSystemMessage?: string;
  mode?: "auto" | "submit" | "steer";
};

export type TelegramSessionClientOptions = {
  cwd: string;
  persona?: string;
  noAgentContextFiles?: boolean;
};

export type TelegramSessionClientEvent = SessionProtocolDeltaMessage;

export type TelegramTauSession = {
  readonly id: string;
  onDelta(listener: (event: TelegramSessionClientEvent) => void): () => void;
  submit(text: string, options?: { historyEntryId?: string }): Promise<SessionProtocolSubmitResult>;
  steer(text: string): Promise<SessionProtocolSteerResult>;
  interrupt(): Promise<SessionProtocolInterruptResult>;
  compact(mode: "summary-only" | "summary-and-last"): Promise<SessionProtocolCompactResult>;
  setReasoning(
    reasoning: SessionProtocolReasoningEffort,
  ): Promise<SessionProtocolSettingsUpdateResult>;
  exec(
    command: string,
    options?: { cwd?: string; timeoutMs?: number },
  ): Promise<SessionProtocolExecResult>;
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
  getProvisionFailures(sessionId: string): TelegramSessionProvisionFailure[];
  getPendingTurnNotifications(sessionId: string): TelegramSessionTurnNotification[];
  acknowledgeTurnNotification(sessionId: string, historyEntryId: string): Promise<void>;
  getSessionSnapshot(sessionId: string): Promise<SessionProtocolSnapshot | undefined>;
  sendMessage(
    sessionId: string,
    text: string,
    options?: TelegramSessionSubmitOptions,
  ): Promise<TelegramSessionRecord>;
  interruptSession(sessionId: string): Promise<TelegramSessionInterruptResult>;
  compactSession(sessionId: string): Promise<SessionProtocolCompactResult>;
  setReasoning(
    sessionId: string,
    reasoning: SessionProtocolReasoningEffort,
  ): Promise<SessionProtocolSettingsUpdateResult>;
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
  prepareWorkspace?: (options: PrepareWorkspaceOptions) => Promise<PreparedWorkspace>;
  cleanupWorkspacePath?: (workspacePath: string) => Promise<void>;
};

class TelegramSessionManagerImpl implements TelegramSessionManager {
  private readonly sessions = new Map<string, SessionEntry>();
  private readonly provisionFailures = new Map<string, TelegramSessionProvisionFailure[]>();
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
  ) => Promise<PreparedWorkspace>;
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
      emittedNoticeIds: new Set(),
      turnSequenceUnsuccessful: false,
      activeTurnIds: new Set(),
      settledTurnIds: new Set(),
      pendingTurnNotifications: new Map(),
      emittedTurnNotificationIds: new Set(),
      turnChangeResolvers: new Map(),
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

  getProvisionFailures(sessionId: string): TelegramSessionProvisionFailure[] {
    if (!this.getEntryBySessionId(sessionId)) {
      return [];
    }
    return (this.provisionFailures.get(sessionId) ?? []).map((failure) => ({ ...failure }));
  }

  getPendingTurnNotifications(sessionId: string): TelegramSessionTurnNotification[] {
    const entry = this.getEntryBySessionId(sessionId);
    if (!entry) {
      return [];
    }
    return Array.from(entry.pendingTurnNotifications.values(), (notification) =>
      this.toTurnNotificationEvent(entry, notification),
    );
  }

  async acknowledgeTurnNotification(sessionId: string, historyEntryId: string): Promise<void> {
    const entry = this.requireSession(sessionId);
    if (!entry.pendingTurnNotifications.delete(historyEntryId)) {
      return;
    }
    entry.emittedTurnNotificationIds.delete(historyEntryId);
    await this.persistSessions();
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

    const requestedMode = options?.mode ?? "submit";
    const running = entry.record.state === "running" || Boolean(entry.activeSubmit);
    const mode = requestedMode === "auto" ? (running ? "steer" : "submit") : requestedMode;
    if (mode !== "steer" && running) {
      throw new TelegramSessionManagerError("busy", "session is running");
    }

    void this.submitText(entry, trimmed, "user-message", options?.additionalSystemMessage, mode);
    return this.toRecord(entry);
  }

  async interruptSession(sessionId: string): Promise<TelegramSessionInterruptResult> {
    const entry = this.requireSession(sessionId);

    if (
      entry.record.state !== "running" ||
      (!entry.activeSubmit && entry.activeTurnIds.size === 0)
    ) {
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

  async compactSession(sessionId: string): Promise<SessionProtocolCompactResult> {
    const entry = this.requireSession(sessionId);
    if (entry.record.state === "running" || entry.activeSubmit) {
      throw new TelegramSessionManagerError("busy", "session is running");
    }
    if (!entry.tauSession) {
      throw new TelegramSessionManagerError("not_ready", "session is still preparing");
    }
    return await entry.tauSession.compact("summary-only");
  }

  async setReasoning(
    sessionId: string,
    reasoning: SessionProtocolReasoningEffort,
  ): Promise<SessionProtocolSettingsUpdateResult> {
    const entry = this.requireSession(sessionId);
    if (!entry.tauSession) {
      throw new TelegramSessionManagerError("not_ready", "session is still preparing");
    }
    return await entry.tauSession.setReasoning(reasoning);
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
      persistedSessions = normalizePersistedTelegramSessions(parsed.data);
    }

    for (const record of persistedSessions) {
      const project = this.projects[record.projectId];
      if (!project || this.sessions.has(record.id)) {
        continue;
      }

      const { activeTurnIds, pendingTurnNotifications, ...sessionRecord } = record;
      const entry: SessionEntry = {
        record: sessionRecord,
        logs: [],
        project,
        abortController: new AbortController(),
        cancelRequested: false,
        consumedFacetEventCounts: new Map(),
        emittedAssistantMessageIds: new Set(),
        emittedNoticeIds: new Set(),
        turnSequenceUnsuccessful: false,
        activeTurnIds: new Set(activeTurnIds),
        settledTurnIds: new Set(),
        pendingTurnNotifications: new Map(
          pendingTurnNotifications.map((notification) => [
            notification.historyEntryId,
            notification,
          ]),
        ),
        emittedTurnNotificationIds: new Set(),
        turnChangeResolvers: new Map(),
      };
      this.sessions.set(record.id, entry);
    }

    await this.cleanupOrphanedWorkspaces();

    await Promise.all(
      Array.from(this.sessions.values(), async (entry) => {
        if (entry.record.state === "failed" && entry.activeTurnIds.size === 0) {
          return;
        }
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
          await this.stopClient(entry, "recovery failure cleanup");
        }
      }),
    );

    await this.persistSessions();
    for (const entry of this.sessions.values()) {
      this.emitPendingTurnNotifications(entry);
    }
  }

  private async cleanupOrphanedWorkspaces(): Promise<void> {
    const workspaceRoots = new Set<string>([this.workspaceRoot]);
    const preservedWorkspacePaths: string[] = [];

    for (const entry of this.sessions.values()) {
      if (isDirectoryProject(entry.project)) {
        preservedWorkspacePaths.push(entry.project.directory);
        continue;
      }

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
      if (isDirectoryProject(project)) {
        preservedWorkspacePaths.push(project.directory);
      } else if (project.workspaceRoot) {
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

    const projectWorkspaceRoot = isDirectoryProject(entry.project)
      ? this.workspaceRoot
      : (entry.project.workspaceRoot ?? this.workspaceRoot);
    let workspacePath = isDirectoryProject(entry.project)
      ? entry.project.directory
      : resolveWorkspacePath({
          workspaceRoot: projectWorkspaceRoot,
          projectId: entry.record.projectId,
          sessionId: entry.record.id,
        });
    let sessionCwd = resolve(
      workspacePath,
      "repo" in entry.project ? (entry.project.workingDirectory ?? ".") : ".",
    );
    let provisionTargets: PreparedWorkspace["provisionTargets"] = [];
    const shouldPrepareWorkspace = !(await pathIsDirectory(sessionCwd));
    if (shouldPrepareWorkspace) {
      const workspace = await this.prepareWorkspace({
        sessionId: entry.record.id,
        projectId: entry.record.projectId,
        project: entry.project,
        projects: this.projects,
        workspaceRoot: projectWorkspaceRoot,
        defaultWorkspaceRoot: this.workspaceRoot,
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
      provisionTargets = workspace.provisionTargets;
    }
    entry.record.workspacePath = workspacePath;

    const client = await this.createClient(this.buildClientOptions(entry, sessionCwd));
    entry.client = client;
    const tauSession = await client.sessions.observe(tauSessionId);
    entry.tauSession = tauSession;
    const snapshot = await tauSession.snapshot();
    if (
      isDirectoryProject(entry.project) &&
      (snapshot.executionEnvironment.kind !== "local" ||
        resolve(snapshot.executionEnvironment.cwd) !== sessionCwd)
    ) {
      throw new Error(
        `persisted Tau session directory '${snapshot.executionEnvironment.cwd}' does not match configured project directory '${sessionCwd}'`,
      );
    }
    entry.unsubscribeClientEvents = tauSession.onDelta((event) => {
      this.handleClientEvent(entry, event);
    });
    this.initializeRecoveredSnapshotDeliveryState(entry, snapshot);
    entry.record.error = undefined;
    if (entry.activeTurnIds.size > 0) {
      this.setState(entry, "running");
      this.trackRecoveredTurns(entry, tauSession);
    } else {
      this.setState(entry, "waiting-input");
    }
    this.log(entry, "info", "session recovered", { tauSessionId, workspacePath });
    if (shouldPrepareWorkspace) {
      this.startProvision(entry, tauSession, provisionTargets);
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
        const state: Extract<PersistedTelegramSessionState, { version: 4 }> = {
          version: 4,
          sessions: Array.from(this.sessions.values(), (entry) => ({
            id: entry.record.id,
            projectId: entry.record.projectId,
            ...(entry.record.ownerId ? { ownerId: entry.record.ownerId } : {}),
            state: entry.record.state,
            createdAt: entry.record.createdAt,
            updatedAt: entry.record.updatedAt,
            ...(entry.record.tauSessionId ? { tauSessionId: entry.record.tauSessionId } : {}),
            ...(entry.record.error ? { error: entry.record.error } : {}),
            activeTurnIds: [...entry.activeTurnIds],
            pendingTurnNotifications: [...entry.pendingTurnNotifications.values()],
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
        projects: this.projects,
        workspaceRoot: isDirectoryProject(entry.project)
          ? this.workspaceRoot
          : (entry.project.workspaceRoot ?? this.workspaceRoot),
        defaultWorkspaceRoot: this.workspaceRoot,
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
        attributes: this.buildSessionAttributes(entry),
      });
      const clientConnectDurationMs = elapsedMs(clientConnectStart);

      if (entry.cancelRequested) {
        entry.tauSession = tauSession;
        await this.stopClient(entry, "cancelled initialization cleanup");
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
      const snapshot = await tauSession.snapshot();
      this.reconcileSnapshotTurns(entry, snapshot, { rejectMissingActiveTurns: false });
      this.initializeSnapshotMessageDeliveryState(entry, snapshot);
      this.handleSnapshotNotices(entry, snapshot);

      this.log(entry, "info", "session preparation complete", {
        durationMs: elapsedMs(sessionPreparationStart),
      });

      if (!entry.cancelRequested && entry.record.state !== "failed") {
        this.setState(entry, "waiting-input");
        this.startProvision(entry, tauSession, workspace.provisionTargets);
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

      await this.stopClient(entry, "initialization failure cleanup");
    }
  }

  private startProvision(
    entry: SessionEntry,
    tauSession: TelegramTauSession,
    targets: WorkspaceProvisionTarget[],
  ): void {
    if (targets.length === 0 || entry.provisionPromise) {
      return;
    }

    let provisionPromise: Promise<void>;
    provisionPromise = (async () => {
      for (const target of targets) {
        const startedAt = process.hrtime.bigint();
        this.log(entry, "info", "workspace provision started", {
          targetProjectId: target.projectId,
          cwd: target.cwd,
        });

        while (!entry.cancelRequested) {
          try {
            const result = await tauSession.exec(buildProvisionCommand(target.repositoryRoot), {
              cwd: target.cwd,
            });
            if (result.exitCode !== 0) {
              this.reportProvisionFailure(entry, target, formatProvisionFailure(result));
              break;
            }
            this.log(entry, "info", "workspace provision complete", {
              targetProjectId: target.projectId,
              durationMs: elapsedMs(startedAt),
            });
            break;
          } catch (error) {
            if (entry.cancelRequested) {
              this.log(entry, "info", "workspace provision cancelled", {
                targetProjectId: target.projectId,
              });
              return;
            }
            if (isCancelledProtocolResponse(error)) {
              this.log(entry, "info", "workspace provision restarting after session interrupt", {
                targetProjectId: target.projectId,
              });
              continue;
            }
            this.reportProvisionFailure(
              entry,
              target,
              truncateProvisionDiagnostic(
                `provision execution failed\n${error instanceof Error ? error.message : String(error)}`,
              ),
            );
            break;
          }
        }
      }
    })().finally(() => {
      if (entry.provisionPromise === provisionPromise) {
        entry.provisionPromise = undefined;
      }
    });

    entry.provisionPromise = provisionPromise;
  }

  private reportProvisionFailure(
    entry: SessionEntry,
    target: WorkspaceProvisionTarget,
    diagnostic: string,
  ): void {
    this.log(entry, "warn", "workspace provision failed", {
      targetProjectId: target.projectId,
      diagnostic,
    });
    const failure: TelegramSessionProvisionFailure = {
      type: "session-provision-failed",
      sessionId: entry.record.id,
      projectId: entry.record.projectId,
      targetProjectId: target.projectId,
      diagnostic,
    };
    const failures = this.provisionFailures.get(entry.record.id) ?? [];
    failures.push(failure);
    this.provisionFailures.set(entry.record.id, failures);
    this.emit(failure);
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

    if (entry.record.state !== "running") {
      entry.finalAssistantResponse = undefined;
      entry.turnSequenceUnsuccessful = false;
    }
    this.setState(entry, "running");
    this.log(entry, "info", mode === "steer" ? "steering message" : "submitting message", {
      source,
      text,
    });

    const previousSubmit = entry.activeSubmit;
    const tauSession = entry.tauSession;
    const payload = this.buildSubmitPayload(text, additionalSystemMessage);
    const requestedHistoryEntryId = mode === "submit" ? `telegram-turn-${randomUUID()}` : undefined;

    let submitPromise!: Promise<void>;
    submitPromise = (async () => {
      let requestStarted = false;
      try {
        if (requestedHistoryEntryId) {
          entry.activeTurnIds.add(requestedHistoryEntryId);
          await this.persistSessions();
        }
        requestStarted = true;
        const result =
          mode === "steer"
            ? await tauSession.steer(payload)
            : await tauSession.submit(payload, { historyEntryId: requestedHistoryEntryId });
        if (requestedHistoryEntryId && result.userHistoryEntryId !== requestedHistoryEntryId) {
          throw new Error(
            `Tau accepted turn '${result.userHistoryEntryId}' instead of requested turn '${requestedHistoryEntryId}'`,
          );
        }
        this.reconcileTurnRecord(
          entry,
          {
            userHistoryEntryId: result.userHistoryEntryId,
            state: "settled",
            outcome: result.turn,
          },
          { owned: true },
        );
        await this.persistSessions();
        this.emitPendingTurnNotifications(entry);
        this.log(
          entry,
          result.turn.status === "failed" || result.turn.status === "blocked" ? "error" : "info",
          "message finished",
          {
            source,
            turn: result.turn,
            userHistoryEntryId: result.userHistoryEntryId,
          },
        );

        if (
          !entry.cancelRequested &&
          (!entry.activeSubmit || entry.activeSubmit === submitPromise) &&
          entry.activeTurnIds.size === 0
        ) {
          this.setState(entry, "waiting-input");
        }
      } catch (error) {
        if (requestedHistoryEntryId && !requestStarted) {
          entry.activeTurnIds.delete(requestedHistoryEntryId);
        }
        if (!entry.cancelRequested && requestedHistoryEntryId && requestStarted) {
          try {
            if (
              await this.recoverRejectedSubmit(entry, tauSession, requestedHistoryEntryId, error)
            ) {
              return;
            }
          } catch (recoveryError) {
            this.log(entry, "warn", "failed to inspect rejected submit", {
              userHistoryEntryId: requestedHistoryEntryId,
              cause: formatErrorDiagnostic(recoveryError),
            });
          }
        }
        if (!entry.cancelRequested) {
          const diagnostic = formatErrorDiagnostic(error);
          entry.record.error = diagnostic;
          this.setState(entry, "failed");
          const data = {
            sessionId: entry.record.id,
            tauSessionId: tauSession.id,
            source,
            cause: diagnostic,
          };
          this.log(entry, "error", "submit failed", data);
          this.onLog?.({ level: "error", message: "telegram session submit failed", data });
          try {
            await this.persistSessions();
          } catch (persistenceError) {
            this.onLog?.({
              level: "error",
              message: "failed to persist telegram session failure",
              data: {
                ...data,
                persistenceCause: formatErrorDiagnostic(persistenceError),
              },
            });
          }
          await this.stopClient(entry, "submit failure cleanup");
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
          this.emitCompletedResponseIfReady(entry);
          if (
            !entry.cancelRequested &&
            entry.record.state === "running" &&
            entry.activeTurnIds.size === 0
          ) {
            this.setState(entry, "waiting-input");
          }
        }
      });

    return submitPromise;
  }

  private async recoverRejectedSubmit(
    entry: SessionEntry,
    tauSession: TelegramTauSession,
    historyEntryId: string,
    error: unknown,
  ): Promise<boolean> {
    const snapshot = await tauSession.snapshot();
    const turn = Object.hasOwn(snapshot.turns, historyEntryId)
      ? snapshot.turns[historyEntryId]
      : undefined;
    if (!turn) {
      this.recordTurnRejection(entry, historyEntryId);
      await this.persistSessions();
      this.emitPendingTurnNotifications(entry);
      this.log(entry, "warn", "submit rejected before turn acceptance", {
        userHistoryEntryId: historyEntryId,
        cause: formatErrorDiagnostic(error),
      });
      return true;
    }

    this.reconcileTurnRecord(entry, turn);
    await this.persistSessions();
    this.emitPendingTurnNotifications(entry);
    this.log(entry, "warn", "submit response recovered from turn ledger", {
      userHistoryEntryId: historyEntryId,
      turn,
      cause: formatErrorDiagnostic(error),
    });
    if (turn.state === "running") {
      await this.followRunningTurn(entry, tauSession, historyEntryId);
    } else if (entry.activeTurnIds.size === 0) {
      this.setState(entry, "waiting-input");
    }
    return true;
  }

  private trackRecoveredTurns(entry: SessionEntry, tauSession: TelegramTauSession): void {
    const trackedTurns = Promise.all(
      [...entry.activeTurnIds].map(
        async (historyEntryId) => await this.followRunningTurn(entry, tauSession, historyEntryId),
      ),
    ).then(() => undefined);
    entry.activeSubmit = trackedTurns;
    void trackedTurns
      .catch((error) => {
        this.log(entry, "error", "recovered turn tracking failed", {
          cause: formatErrorDiagnostic(error),
        });
      })
      .finally(() => {
        if (entry.activeSubmit === trackedTurns) {
          entry.activeSubmit = undefined;
          this.emitCompletedResponseIfReady(entry);
          if (!entry.cancelRequested && entry.record.state === "running") {
            this.setState(entry, "waiting-input");
          }
        }
      });
  }

  private async followRunningTurn(
    entry: SessionEntry,
    tauSession: TelegramTauSession,
    historyEntryId: string,
  ): Promise<void> {
    while (entry.activeTurnIds.has(historyEntryId) && !entry.cancelRequested) {
      await this.waitForTurnChange(entry, historyEntryId);
      if (!entry.activeTurnIds.has(historyEntryId) || entry.cancelRequested) {
        return;
      }

      let snapshot: SessionProtocolSnapshot;
      try {
        snapshot = await tauSession.snapshot();
      } catch (error) {
        this.log(entry, "warn", "failed to refresh recovered turn", {
          userHistoryEntryId: historyEntryId,
          cause: formatErrorDiagnostic(error),
        });
        continue;
      }

      const turn = Object.hasOwn(snapshot.turns, historyEntryId)
        ? snapshot.turns[historyEntryId]
        : undefined;
      if (!turn) {
        this.recordTurnRejection(entry, historyEntryId);
      } else {
        this.reconcileTurnRecord(entry, turn);
      }
      await this.persistSessions();
      this.emitPendingTurnNotifications(entry);
    }
  }

  private waitForTurnChange(entry: SessionEntry, historyEntryId: string): Promise<void> {
    return new Promise((resolve) => {
      let settled = false;
      const finish = () => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timeout);
        entry.abortController.signal.removeEventListener("abort", finish);
        if (entry.turnChangeResolvers.get(historyEntryId) === finish) {
          entry.turnChangeResolvers.delete(historyEntryId);
        }
        resolve();
      };
      const timeout = setTimeout(finish, TURN_RECOVERY_POLL_INTERVAL_MS);
      entry.turnChangeResolvers.set(historyEntryId, finish);
      entry.abortController.signal.addEventListener("abort", finish, { once: true });
    });
  }

  private reconcileTurnRecord(
    entry: SessionEntry,
    turn: SessionProtocolTurnRecord,
    options: { owned?: boolean } = {},
  ): boolean {
    const historyEntryId = turn.userHistoryEntryId;
    if (turn.state === "running") {
      if (entry.settledTurnIds.has(historyEntryId) || entry.activeTurnIds.has(historyEntryId)) {
        return false;
      }
      entry.activeTurnIds.add(historyEntryId);
      return true;
    }

    if (entry.settledTurnIds.has(historyEntryId)) {
      return false;
    }
    entry.settledTurnIds.add(historyEntryId);
    const wasActive = entry.activeTurnIds.delete(historyEntryId);
    if (!wasActive && !options.owned) {
      return false;
    }
    entry.turnChangeResolvers.get(historyEntryId)?.();
    if (turn.outcome.status === "completed") {
      if (turn.outcome.stopReason === "stop" || turn.outcome.stopReason === "length") {
        this.emitCompletedResponseIfReady(entry);
      }
    } else {
      entry.turnSequenceUnsuccessful = true;
      entry.finalAssistantResponse = undefined;
      if (turn.outcome.status === "failed" || turn.outcome.status === "blocked") {
        this.recordTurnFailure(entry, historyEntryId, turn.outcome);
      }
    }
    if (
      entry.activeTurnIds.size === 0 &&
      !entry.activeSubmit &&
      !entry.cancelRequested &&
      entry.record.state === "running"
    ) {
      this.setState(entry, "waiting-input");
    }
    return true;
  }

  private recordTurnFailure(
    entry: SessionEntry,
    historyEntryId: string,
    failure: Extract<SessionProtocolTurnOutcome, { status: "failed" | "blocked" }>,
  ): void {
    if (entry.pendingTurnNotifications.has(historyEntryId)) {
      return;
    }
    entry.pendingTurnNotifications.set(historyEntryId, {
      kind: "failed",
      historyEntryId,
      timestamp: this.now().toISOString(),
      failure: structuredClone(failure),
    });
  }

  private recordTurnRejection(entry: SessionEntry, historyEntryId: string): void {
    entry.turnSequenceUnsuccessful = true;
    entry.finalAssistantResponse = undefined;
    entry.activeTurnIds.delete(historyEntryId);
    entry.settledTurnIds.add(historyEntryId);
    entry.turnChangeResolvers.get(historyEntryId)?.();
    if (!entry.pendingTurnNotifications.has(historyEntryId)) {
      entry.pendingTurnNotifications.set(historyEntryId, {
        kind: "rejected",
        historyEntryId,
        timestamp: this.now().toISOString(),
      });
    }
    if (
      entry.activeTurnIds.size === 0 &&
      !entry.activeSubmit &&
      !entry.cancelRequested &&
      entry.record.state === "running"
    ) {
      this.setState(entry, "waiting-input");
    }
  }

  private toTurnNotificationEvent(
    entry: SessionEntry,
    notification: PersistedTelegramTurnNotification,
  ): TelegramSessionTurnNotification {
    if (notification.kind === "failed") {
      return {
        type: "session-turn-failed",
        sessionId: entry.record.id,
        projectId: entry.record.projectId,
        timestamp: notification.timestamp,
        historyEntryId: notification.historyEntryId,
        failure: structuredClone(notification.failure),
      };
    }
    return {
      type: "session-turn-rejected",
      sessionId: entry.record.id,
      projectId: entry.record.projectId,
      timestamp: notification.timestamp,
      historyEntryId: notification.historyEntryId,
    };
  }

  private emitPendingTurnNotifications(entry: SessionEntry): void {
    for (const notification of entry.pendingTurnNotifications.values()) {
      if (entry.emittedTurnNotificationIds.has(notification.historyEntryId)) {
        continue;
      }
      entry.emittedTurnNotificationIds.add(notification.historyEntryId);
      this.emit(this.toTurnNotificationEvent(entry, notification));
    }
  }

  private reconcileSnapshotTurns(
    entry: SessionEntry,
    snapshot: SessionProtocolSnapshot,
    options: { rejectMissingActiveTurns: boolean },
  ): boolean {
    let changed = false;
    const snapshotTurnIds = new Set(Object.keys(snapshot.turns));
    if (options.rejectMissingActiveTurns) {
      for (const historyEntryId of entry.activeTurnIds) {
        if (!snapshotTurnIds.has(historyEntryId)) {
          this.recordTurnRejection(entry, historyEntryId);
          changed = true;
        }
      }
    }
    for (const turn of Object.values(snapshot.turns)) {
      if (turn.state === "running" || entry.activeTurnIds.has(turn.userHistoryEntryId)) {
        changed = this.reconcileTurnRecord(entry, turn) || changed;
      } else {
        entry.settledTurnIds.add(turn.userHistoryEntryId);
      }
    }
    return changed;
  }

  private persistTurnState(entry: SessionEntry): void {
    void this.persistSessions()
      .then(() => {
        this.emitPendingTurnNotifications(entry);
      })
      .catch((error) => {
        this.onLog?.({
          level: "error",
          message: "turn state persistence failed",
          data: { cause: formatErrorDiagnostic(error) },
        });
      });
  }

  private buildSessionAttributes(entry: SessionEntry): Record<string, string> {
    const configuredRepositories =
      "repo" in entry.project
        ? [entry.project.repo]
        : "projectIds" in entry.project
          ? entry.project.projectIds.flatMap((projectId) => {
              const project = this.projects[projectId];
              return project && "repo" in project ? [project.repo] : [];
            })
          : [];
    const repository = buildRepositoryAttribute(
      configuredRepositories.map(
        (configuredRepository) =>
          normalizeRepositoryReference(configuredRepository, { defaultHost: "github.com" }) ??
          configuredRepository,
      ),
    );
    return {
      source: "telegram",
      project: entry.record.projectId,
      ...(repository ? { repository } : {}),
    };
  }

  private buildClientOptions(entry: SessionEntry, cwd: string): TelegramSessionClientOptions {
    const options: TelegramSessionClientOptions = { cwd };
    if (entry.project.persona) {
      options.persona = entry.project.persona;
    }
    if ("noAgentContextFiles" in entry.project && entry.project.noAgentContextFiles !== undefined) {
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

    await Promise.allSettled(
      entries.map(async (entry) => await this.stopClient(entry, "manager shutdown")),
    );
    await Promise.allSettled(
      entries.flatMap((entry) =>
        [entry.initializePromise, entry.activeSubmit, entry.provisionPromise].filter(
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

    await this.stopClient(entry, "session close");
    await this.runWorkspaceCleanup(entry);

    const record = this.toRecord(entry);
    this.sessions.delete(entry.record.id);
    this.provisionFailures.delete(entry.record.id);
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
        entry.provisionPromise,
      ].filter((promise): promise is Promise<void> => promise !== undefined);

      if (pendingWork.length > 0) {
        await Promise.allSettled(pendingWork);
      }

      if (isDirectoryProject(entry.project)) {
        this.log(entry, "info", "persistent workspace preserved", {
          workspacePath: entry.project.directory,
        });
        return;
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
    if (isDirectoryProject(entry.project)) {
      return entry.project.directory;
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

  private async stopClient(entry: SessionEntry, reason: string): Promise<void> {
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
      if (tauSession) {
        this.log(entry, "info", "internal cleanup interrupt requested", { reason });
      }
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
      if (
        this.reconcileSnapshotTurns(entry, clientEvent.delta.snapshot, {
          rejectMissingActiveTurns: false,
        })
      ) {
        this.persistTurnState(entry);
      }
      this.handleSnapshotNotices(entry, clientEvent.delta.snapshot);
      if (clientEvent.cause.type !== "assistant-message") {
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
      if (change.type === "turn.set") {
        if (this.reconcileTurnRecord(entry, change.turn)) {
          this.persistTurnState(entry);
        }
        continue;
      }
      if (change.type === "facet.set") {
        this.handleFacetProgress(entry, change.facet);
        continue;
      }
      if (change.type === "timeline.append" && change.item.type === "notice") {
        this.handleNotice(entry, change.item.id, change.item.notice);
        continue;
      }

      if (clientEvent.cause.type !== "assistant-message") {
        continue;
      }

      if (change.type === "message.append" || change.type === "message.replace") {
        this.handleAssistantMessageProgress(entry, change.message);
      }
    }
  }

  private initializeRecoveredSnapshotDeliveryState(
    entry: SessionEntry,
    snapshot: SessionProtocolSnapshot,
  ): void {
    this.reconcileSnapshotTurns(entry, snapshot, { rejectMissingActiveTurns: true });
    this.initializeSnapshotMessageDeliveryState(entry, snapshot);
    for (const item of snapshot.timeline.items) {
      if (item.type === "notice") {
        entry.emittedNoticeIds.add(item.id);
      }
    }
  }

  private initializeSnapshotMessageDeliveryState(
    entry: SessionEntry,
    snapshot: SessionProtocolSnapshot,
  ): void {
    for (const message of snapshot.messages) {
      if (message.state === "committed" && isAssistantMessage(message.message)) {
        entry.emittedAssistantMessageIds.add(message.id);
      }
    }
  }

  private handleSnapshotNotices(entry: SessionEntry, snapshot: SessionProtocolSnapshot): void {
    for (const item of snapshot.timeline.items) {
      if (item.type === "notice") {
        this.handleNotice(entry, item.id, item.notice);
      }
    }
  }

  private handleNotice(
    entry: SessionEntry,
    id: string,
    notice: SessionProtocolTimelineNotice,
  ): void {
    if (!shouldDeliverTelegramTimelineNotice(notice) || entry.emittedNoticeIds.has(id)) {
      return;
    }
    entry.emittedNoticeIds.add(id);
    this.emit({
      type: "session-notice",
      sessionId: entry.record.id,
      projectId: entry.record.projectId,
      timestamp: this.now().toISOString(),
      severity: notice.severity,
      text: formatTelegramTimelineNotice(notice),
    });
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
      messageId: message.id,
      text,
    });
    if (message.message.stopReason === "stop" || message.message.stopReason === "length") {
      entry.finalAssistantResponse = { messageId: message.id, text };
      this.emitCompletedResponseIfReady(entry);
    }
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

  private emitCompletedResponseIfReady(entry: SessionEntry): void {
    if (
      entry.activeSubmit ||
      entry.activeTurnIds.size > 0 ||
      entry.turnSequenceUnsuccessful ||
      !entry.finalAssistantResponse
    ) {
      return;
    }

    const response = entry.finalAssistantResponse;
    entry.finalAssistantResponse = undefined;
    this.emit({
      type: "session-response-completed",
      sessionId: entry.record.id,
      projectId: entry.record.projectId,
      timestamp: this.now().toISOString(),
      messageId: response.messageId,
      text: response.text,
    });
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

  getProvisionFailures(sessionId: string): TelegramSessionProvisionFailure[] {
    const session = this.sessionManager.getSession(sessionId);
    if (!session || !this.isVisibleSession(session)) {
      return [];
    }

    return this.sessionManager.getProvisionFailures(sessionId);
  }

  getPendingTurnNotifications(sessionId: string): TelegramSessionTurnNotification[] {
    const session = this.sessionManager.getSession(sessionId);
    if (!session || !this.isVisibleSession(session)) {
      return [];
    }

    return this.sessionManager.getPendingTurnNotifications(sessionId);
  }

  async acknowledgeTurnNotification(sessionId: string, historyEntryId: string): Promise<void> {
    this.requireSession(sessionId);
    await this.sessionManager.acknowledgeTurnNotification(sessionId, historyEntryId);
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

  async compactSession(sessionId: string): Promise<SessionProtocolCompactResult> {
    this.requireSession(sessionId);
    return await this.sessionManager.compactSession(sessionId);
  }

  async setReasoning(
    sessionId: string,
    reasoning: SessionProtocolReasoningEffort,
  ): Promise<SessionProtocolSettingsUpdateResult> {
    this.requireSession(sessionId);
    return await this.sessionManager.setReasoning(sessionId, reasoning);
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
