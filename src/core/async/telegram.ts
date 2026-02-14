import { Api } from "grammy";
import type { AsyncProjectConfig } from "../config/schema.js";
import { isRecord } from "../utils/type_guards.js";
import {
  type AsyncSessionManager,
  AsyncSessionManagerError,
  type AsyncSessionManagerEvent,
  type AsyncSessionRecord,
} from "./session_manager.js";

type TelegramChat = {
  id: number;
  type: string;
};

type TelegramUser = {
  id: number;
};

type TelegramMessage = {
  chat?: TelegramChat;
  from?: TelegramUser;
  text?: string;
};

type TelegramUpdate = {
  update_id?: number;
  message?: TelegramMessage;
};

type TelegramAllowedUpdates =
  NonNullable<Parameters<Api["getUpdates"]>[0]> extends {
    allowed_updates?: infer T;
  }
    ? NonNullable<T>
    : readonly string[];

type TelegramBotCommand = {
  command: string;
  description: string;
};

export type AsyncTelegramApi = {
  getUpdates(args: {
    offset: number;
    timeoutSeconds: number;
    allowedUpdates: TelegramAllowedUpdates;
  }): Promise<TelegramUpdate[]>;
  sendMessage(chatId: number, text: string): Promise<void>;
  setCommands?(commands: TelegramBotCommand[]): Promise<void>;
};

export type AsyncTelegramLogLevel = "info" | "warn" | "error";

export type AsyncTelegramLogEntry = {
  level: AsyncTelegramLogLevel;
  message: string;
  data?: unknown;
};

export type AsyncTelegramAdapterOptions = {
  botToken: string;
  projects: Record<string, AsyncProjectConfig>;
  defaultProjectId?: string;
  systemMessage?: string;
  allowedUserIds?: number[];
  allowedChatIds?: number[];
  pollIntervalMs?: number;
  requestTimeoutSeconds?: number;
  sessionManager: AsyncSessionManager;
  api?: AsyncTelegramApi;
  onLog?: (entry: AsyncTelegramLogEntry) => void;
};

export type AsyncTelegramAdapterHandle = {
  close(): Promise<void>;
};

type NewCommandResolution =
  | {
      projectId: string;
    }
  | {
      error: string;
    };

const DEFAULT_POLL_INTERVAL_MS = 1000;
const DEFAULT_REQUEST_TIMEOUT_SECONDS = 30;
const MAX_COMMAND_PREVIEW_CHARS = 128;
const ABORTED = Symbol("aborted");

type SessionVerbosity = "verbose" | "quiet";

const TELEGRAM_COMMANDS: TelegramBotCommand[] = [
  { command: "new", description: "start a new session" },
  { command: "use", description: "switch active session" },
  { command: "list", description: "list sessions" },
  { command: "status", description: "show active session status" },
  { command: "cancel", description: "cancel active session" },
  { command: "verbose", description: "stream progress updates" },
  { command: "quiet", description: "only send final assistant message" },
];

function splitCommandText(text: string): string[] {
  return text
    .trim()
    .split(/\s+/)
    .map((part) => part.trim())
    .filter(Boolean);
}

function stripCommandMention(command: string): string {
  const mentionIndex = command.indexOf("@");
  if (mentionIndex === -1) {
    return command;
  }
  return command.slice(0, mentionIndex);
}

function truncateText(text: string, maxChars: number): string {
  const trimmed = text.trim();
  if (trimmed.length <= maxChars) {
    return trimmed;
  }

  if (maxChars <= 1) {
    return "…";
  }

  return `${trimmed.slice(0, maxChars - 1)}…`;
}

function describeSession(
  session: AsyncSessionRecord,
  details: {
    verbosity?: SessionVerbosity;
    lastCommand?: string;
    lastAssistantMessage?: string;
  } = {},
): string {
  return [
    formatSessionHeadline(session.id, "status"),
    `project: ${session.projectId}`,
    `state: ${session.state}`,
    `verbosity: ${details.verbosity ?? "verbose"}`,
    ...(session.error ? [`error: ${session.error}`] : []),
    ...(details.lastCommand
      ? [`last command: ${truncateText(details.lastCommand, MAX_COMMAND_PREVIEW_CHARS)}`]
      : []),
    ...(details.lastAssistantMessage
      ? ["last assistant message:", details.lastAssistantMessage]
      : []),
  ].join("\n");
}

function formatSessionHeadline(sessionId: string, label: string): string {
  return `(${sessionId}) ${label}`;
}

function createGrammyApi(botToken: string): AsyncTelegramApi {
  const api = new Api(botToken);

  return {
    async getUpdates(args) {
      const updates = await api.getUpdates({
        offset: args.offset,
        timeout: args.timeoutSeconds,
        allowed_updates: args.allowedUpdates,
      });

      return updates;
    },
    async sendMessage(chatId, text) {
      await api.sendMessage(chatId, text);
    },
    async setCommands(commands) {
      await api.setMyCommands(commands);
    },
  };
}

class AsyncTelegramAdapterImpl {
  private readonly projects: Record<string, AsyncProjectConfig>;
  private readonly defaultProjectId?: string;
  private readonly systemMessage?: string;
  private readonly allowedUserIds?: Set<number>;
  private readonly allowedChatIds?: Set<number>;
  private readonly pollIntervalMs: number;
  private readonly requestTimeoutSeconds: number;
  private readonly sessionManager: AsyncSessionManager;
  private readonly api: AsyncTelegramApi;
  private readonly onLog?: (entry: AsyncTelegramLogEntry) => void;
  private readonly abortController = new AbortController();
  private readonly activeSessionsByChat = new Map<number, string>();
  private readonly chatsBySession = new Map<string, Set<number>>();
  private readonly sessionVerbosityBySession = new Map<string, SessionVerbosity>();
  private readonly lastCommandBySession = new Map<string, string>();
  private readonly lastAssistantMessageBySession = new Map<string, string>();
  private readonly latestAssistantMessageByRun = new Map<string, string>();

  private readonly unsubscribeSessionEvents: () => void;
  private readonly loopPromise: Promise<void>;

  private nextUpdateOffset = 0;
  private closed = false;

  constructor(options: AsyncTelegramAdapterOptions) {
    this.projects = options.projects;
    this.defaultProjectId = options.defaultProjectId;
    this.systemMessage = options.systemMessage?.trim() || undefined;
    this.allowedUserIds =
      options.allowedUserIds && options.allowedUserIds.length > 0
        ? new Set(options.allowedUserIds)
        : undefined;
    this.allowedChatIds =
      options.allowedChatIds && options.allowedChatIds.length > 0
        ? new Set(options.allowedChatIds)
        : undefined;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.requestTimeoutSeconds = options.requestTimeoutSeconds ?? DEFAULT_REQUEST_TIMEOUT_SECONDS;
    this.sessionManager = options.sessionManager;
    this.api = options.api ?? createGrammyApi(options.botToken);
    this.onLog = options.onLog;

    this.unsubscribeSessionEvents = this.sessionManager.onEvent((event) => {
      this.onSessionEvent(event);
    });

    void this.syncCommands();
    this.loopPromise = this.runLoop();
    this.log("info", "telegram adapter started", {
      pollIntervalMs: this.pollIntervalMs,
      requestTimeoutSeconds: this.requestTimeoutSeconds,
    });
  }

  async close(): Promise<void> {
    if (this.closed) {
      return;
    }

    this.closed = true;
    this.abortController.abort();
    this.unsubscribeSessionEvents();

    try {
      await this.loopPromise;
    } finally {
      this.log("info", "telegram adapter stopped");
    }
  }

  private log(level: AsyncTelegramLogLevel, message: string, data?: unknown): void {
    this.onLog?.({ level, message, ...(data === undefined ? {} : { data }) });
  }

  private async syncCommands(): Promise<void> {
    if (!this.api.setCommands) {
      return;
    }

    try {
      await this.api.setCommands(TELEGRAM_COMMANDS);
      this.log("info", "telegram commands synced", { count: TELEGRAM_COMMANDS.length });
    } catch (error) {
      this.log("warn", "failed to sync telegram commands", {
        cause: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async runLoop(): Promise<void> {
    while (!this.abortController.signal.aborted) {
      try {
        const updates = await this.getUpdates();
        for (const update of updates) {
          if (this.abortController.signal.aborted) {
            return;
          }

          const updateId = update.update_id;
          if (typeof updateId === "number" && Number.isFinite(updateId)) {
            this.nextUpdateOffset = Math.max(this.nextUpdateOffset, updateId + 1);
          }

          await this.handleUpdate(update);
        }
      } catch (error) {
        if (this.abortController.signal.aborted) {
          return;
        }

        this.log("warn", "telegram poll failed", {
          cause: error instanceof Error ? error.message : String(error),
        });
        await this.wait(this.pollIntervalMs);
      }
    }
  }

  private async getUpdates(): Promise<TelegramUpdate[]> {
    const updates = await this.raceWithAbort(
      this.api.getUpdates({
        offset: this.nextUpdateOffset,
        timeoutSeconds: this.requestTimeoutSeconds,
        allowedUpdates: ["message"],
      }),
    );

    if (updates === undefined) {
      return [];
    }

    return updates.filter((entry): entry is TelegramUpdate => isRecord(entry));
  }

  private async raceWithAbort<T>(promise: Promise<T>): Promise<T | undefined> {
    if (this.abortController.signal.aborted) {
      return undefined;
    }

    let abortListener: (() => void) | undefined;
    const abortPromise = new Promise<typeof ABORTED>((resolve) => {
      abortListener = () => resolve(ABORTED);
      this.abortController.signal.addEventListener("abort", abortListener, { once: true });
    });

    const settled = promise.then(
      (value) => ({ ok: true as const, value }),
      (error) => ({ ok: false as const, error }),
    );

    const raceResult = await Promise.race([settled, abortPromise]);

    if (abortListener) {
      this.abortController.signal.removeEventListener("abort", abortListener);
    }

    if (raceResult === ABORTED) {
      return undefined;
    }

    if (!raceResult.ok) {
      throw raceResult.error;
    }

    return raceResult.value;
  }

  private async handleUpdate(update: TelegramUpdate): Promise<void> {
    const message = update.message;
    if (!message) {
      return;
    }

    const chat = message.chat;
    if (!chat || chat.type !== "private") {
      return;
    }

    const chatId = chat.id;
    if (!this.isChatAllowed(chatId)) {
      return;
    }

    const userId = message.from?.id;
    if (!this.isUserAllowed(userId)) {
      return;
    }

    const text = typeof message.text === "string" ? message.text.trim() : "";
    if (!text) {
      return;
    }

    if (text.startsWith("/")) {
      await this.handleCommand(chatId, text);
      return;
    }

    await this.handleMessage(chatId, text);
  }

  private isChatAllowed(chatId: number): boolean {
    if (!this.allowedChatIds) {
      return true;
    }
    return this.allowedChatIds.has(chatId);
  }

  private isUserAllowed(userId: number | undefined): boolean {
    if (!this.allowedUserIds) {
      return true;
    }
    if (typeof userId !== "number") {
      return false;
    }
    return this.allowedUserIds.has(userId);
  }

  private async handleCommand(chatId: number, text: string): Promise<void> {
    const parts = splitCommandText(text);
    const command = stripCommandMention(parts[0] ?? "");
    const args = parts.slice(1);

    if (command === "/new") {
      await this.handleNew(chatId, args);
      return;
    }

    if (command === "/use") {
      await this.handleUse(chatId, args);
      return;
    }

    if (command === "/list") {
      await this.handleList(chatId);
      return;
    }

    if (command === "/status") {
      await this.handleStatus(chatId);
      return;
    }

    if (command === "/cancel") {
      await this.handleCancel(chatId);
      return;
    }

    if (command === "/verbose") {
      await this.handleVerbosityCommand(chatId, "verbose");
      return;
    }

    if (command === "/quiet") {
      await this.handleVerbosityCommand(chatId, "quiet");
      return;
    }

    await this.reply(
      chatId,
      "supported commands: /new, /use, /list, /status, /cancel, /verbose, /quiet",
    );
  }

  private resolveNewCommand(args: string[]): NewCommandResolution {
    const projectIds = Object.keys(this.projects);

    const resolveFallbackProjectId = (): { projectId?: string; error?: string } => {
      if (this.defaultProjectId) {
        if (!this.projects[this.defaultProjectId]) {
          return {
            error: `async.server.telegram.defaultProjectId '${this.defaultProjectId}' is not configured`,
          };
        }
        return { projectId: this.defaultProjectId };
      }

      if (projectIds.length === 1) {
        return { projectId: projectIds[0] };
      }

      if (projectIds.length === 0) {
        return { error: "no async projects configured" };
      }

      return { error: "missing project id. usage: /new [projectId]" };
    };

    if (args.length > 1) {
      return { error: "usage: /new [projectId]" };
    }

    if (args.length === 1) {
      const projectId = args[0];
      if (!projectId) {
        return { error: "usage: /new [projectId]" };
      }

      if (!this.projects[projectId]) {
        return {
          error: `unknown project '${projectId}'. usage: /new [projectId]`,
        };
      }

      return { projectId };
    }

    const fallback = resolveFallbackProjectId();
    if (!fallback.projectId) {
      return {
        error: fallback.error ?? "unable to resolve project id",
      };
    }

    return {
      projectId: fallback.projectId,
    };
  }

  private async handleNew(chatId: number, args: string[]): Promise<void> {
    const parsed = this.resolveNewCommand(args);
    if ("error" in parsed) {
      await this.reply(chatId, parsed.error);
      return;
    }

    try {
      const session = await this.sessionManager.createSession({
        projectId: parsed.projectId,
      });

      this.setActiveSession(chatId, session.id);
      this.sessionVerbosityBySession.set(session.id, "verbose");
      await this.reply(chatId, this.formatSessionPreparing(session.projectId));
    } catch (error) {
      await this.reply(chatId, this.formatManagerError(error));
    }
  }

  private async handleUse(chatId: number, args: string[]): Promise<void> {
    const sessionId = args[0]?.trim();
    if (!sessionId) {
      await this.reply(chatId, "usage: /use <sessionId>");
      return;
    }

    const session = this.sessionManager.getSession(sessionId);
    if (!session) {
      await this.reply(chatId, `session '${sessionId}' not found`);
      return;
    }

    this.setActiveSession(chatId, sessionId);
    await this.reply(chatId, formatSessionHeadline(session.id, `using session (${session.state})`));
  }

  private async handleList(chatId: number): Promise<void> {
    const sessions = this.sessionManager.listSessions();
    if (sessions.length === 0) {
      await this.reply(chatId, "no sessions");
      return;
    }

    const activeSessionId = this.activeSessionsByChat.get(chatId);
    const lines = sessions.map((session) => {
      const marker = session.id === activeSessionId ? "* " : "";
      return `${marker}${session.id} ${session.projectId} ${session.state}`;
    });

    await this.reply(chatId, lines.join("\n"));
  }

  private async handleStatus(chatId: number): Promise<void> {
    const session = this.getActiveSession(chatId);
    if (!session) {
      await this.reply(chatId, "no active session. use /new or /use <sessionId>");
      return;
    }

    await this.reply(
      chatId,
      describeSession(session, {
        verbosity: this.getSessionVerbosity(session.id),
        lastCommand: this.lastCommandBySession.get(session.id),
        lastAssistantMessage: this.lastAssistantMessageBySession.get(session.id),
      }),
    );
  }

  private async handleCancel(chatId: number): Promise<void> {
    const session = this.getActiveSession(chatId);
    if (!session) {
      await this.reply(chatId, "no active session. use /new or /use <sessionId>");
      return;
    }

    try {
      const canceled = await this.sessionManager.cancelSession(session.id);
      await this.reply(chatId, formatSessionHeadline(canceled.id, "canceled"));
    } catch (error) {
      await this.reply(chatId, this.formatManagerError(error));
    }
  }

  private async handleVerbosityCommand(chatId: number, verbosity: SessionVerbosity): Promise<void> {
    const session = this.getActiveSession(chatId);
    if (!session) {
      await this.reply(chatId, "no active session. use /new or /use <sessionId>");
      return;
    }

    this.sessionVerbosityBySession.set(session.id, verbosity);
    await this.reply(chatId, formatSessionHeadline(session.id, `verbosity set to ${verbosity}`));
  }

  private async handleMessage(chatId: number, text: string): Promise<void> {
    const session = this.getActiveSession(chatId);
    if (!session) {
      await this.reply(chatId, "no active session. use /new or /use <sessionId>");
      return;
    }

    try {
      await this.sessionManager.sendMessage(
        session.id,
        text,
        this.systemMessage ? { additionalSystemMessage: this.systemMessage } : undefined,
      );
      await this.reply(chatId, this.formatMessageQueued(session.id));
    } catch (error) {
      await this.reply(chatId, this.formatManagerError(error));
    }
  }

  private getActiveSession(chatId: number): AsyncSessionRecord | undefined {
    const sessionId = this.activeSessionsByChat.get(chatId);
    if (!sessionId) {
      return undefined;
    }

    const session = this.sessionManager.getSession(sessionId);
    if (!session) {
      this.clearActiveSession(chatId);
      return undefined;
    }

    return session;
  }

  private setActiveSession(chatId: number, sessionId: string): void {
    const currentSessionId = this.activeSessionsByChat.get(chatId);
    if (currentSessionId && currentSessionId !== sessionId) {
      const currentChats = this.chatsBySession.get(currentSessionId);
      currentChats?.delete(chatId);
      if (currentChats && currentChats.size === 0) {
        this.chatsBySession.delete(currentSessionId);
      }
    }

    this.activeSessionsByChat.set(chatId, sessionId);

    const chats = this.chatsBySession.get(sessionId) ?? new Set<number>();
    chats.add(chatId);
    this.chatsBySession.set(sessionId, chats);
  }

  private clearActiveSession(chatId: number): void {
    const sessionId = this.activeSessionsByChat.get(chatId);
    if (!sessionId) {
      return;
    }

    this.activeSessionsByChat.delete(chatId);

    const chats = this.chatsBySession.get(sessionId);
    if (!chats) {
      return;
    }

    chats.delete(chatId);
    if (chats.size === 0) {
      this.chatsBySession.delete(sessionId);
    }
  }

  private getSessionVerbosity(sessionId: string): SessionVerbosity {
    return this.sessionVerbosityBySession.get(sessionId) ?? "verbose";
  }

  private isVerboseSession(sessionId: string): boolean {
    return this.getSessionVerbosity(sessionId) === "verbose";
  }

  private onSessionEvent(event: AsyncSessionManagerEvent): void {
    if (event.type === "session-progress") {
      this.handleSessionProgress(event);
      return;
    }

    if (event.type !== "session-state-changed") {
      return;
    }

    if (event.state === "running") {
      this.latestAssistantMessageByRun.delete(event.sessionId);
      if (this.isVerboseSession(event.sessionId)) {
        this.notifyLifecycle(event.sessionId, event.projectId, "started");
      }
      return;
    }

    if (event.state === "failed") {
      this.latestAssistantMessageByRun.delete(event.sessionId);
      this.notifyLifecycle(event.sessionId, event.projectId, "failed");
      return;
    }

    if (event.state === "canceled") {
      this.latestAssistantMessageByRun.delete(event.sessionId);
      this.notifyLifecycle(event.sessionId, event.projectId, "canceled");
      return;
    }

    if (event.state === "waiting-input" && event.previousState === "preparing-workspace") {
      this.notifySession(
        event.sessionId,
        this.formatSessionReady(event.sessionId, event.projectId),
      );
      return;
    }

    if (event.state === "waiting-input" && event.previousState === "running") {
      if (this.isVerboseSession(event.sessionId)) {
        this.notifyLifecycle(event.sessionId, event.projectId, "finished");
        return;
      }

      const message = this.latestAssistantMessageByRun.get(event.sessionId);
      this.latestAssistantMessageByRun.delete(event.sessionId);
      if (message) {
        this.notifySession(event.sessionId, message);
      }
    }
  }

  private handleSessionProgress(
    event: Extract<AsyncSessionManagerEvent, { type: "session-progress" }>,
  ): void {
    const isVerbose = this.isVerboseSession(event.sessionId);

    if (event.progress.type === "bash-command") {
      this.lastCommandBySession.set(event.sessionId, event.progress.command);
      if (!isVerbose) {
        return;
      }

      this.notifySession(
        event.sessionId,
        [
          formatSessionHeadline(event.sessionId, "bash command"),
          `$ ${truncateText(event.progress.command, MAX_COMMAND_PREVIEW_CHARS)}`,
        ].join("\n"),
      );
      return;
    }

    if (event.progress.type === "edited-file") {
      if (!isVerbose) {
        return;
      }

      this.notifySession(
        event.sessionId,
        [formatSessionHeadline(event.sessionId, "edited file"), event.progress.path].join("\n"),
      );
      return;
    }

    if (event.progress.type === "wrote-file") {
      if (!isVerbose) {
        return;
      }

      this.notifySession(
        event.sessionId,
        [formatSessionHeadline(event.sessionId, "wrote file"), event.progress.path].join("\n"),
      );
      return;
    }

    this.lastAssistantMessageBySession.set(event.sessionId, event.progress.text);
    this.latestAssistantMessageByRun.set(event.sessionId, event.progress.text);

    if (!isVerbose) {
      return;
    }

    this.notifySession(
      event.sessionId,
      [formatSessionHeadline(event.sessionId, "assistant message"), event.progress.text].join("\n"),
    );
  }

  private notifyLifecycle(
    sessionId: string,
    projectId: string,
    state: "started" | "finished" | "failed" | "canceled",
  ): void {
    const stateLabel = {
      started: "run started",
      finished: "run finished",
      failed: "run failed",
      canceled: "run canceled",
    }[state];

    this.notifySession(
      sessionId,
      [formatSessionHeadline(sessionId, stateLabel), `project: ${projectId}`].join("\n"),
    );
  }

  private notifySession(sessionId: string, text: string): void {
    const chatIds = this.chatsBySession.get(sessionId);
    if (!chatIds || chatIds.size === 0) {
      return;
    }

    for (const chatId of chatIds) {
      void this.reply(chatId, text);
    }
  }

  private formatSessionPreparing(projectId: string): string {
    return ["session is being prepared", `project: ${projectId}`].join("\n");
  }

  private formatSessionReady(sessionId: string, projectId: string): string {
    return [formatSessionHeadline(sessionId, "session is ready"), `project: ${projectId}`].join(
      "\n",
    );
  }

  private formatMessageQueued(sessionId: string): string {
    return formatSessionHeadline(sessionId, "message queued");
  }

  private formatManagerError(error: unknown): string {
    if (error instanceof AsyncSessionManagerError) {
      return error.message;
    }

    return error instanceof Error ? error.message : String(error);
  }

  private async reply(chatId: number, text: string): Promise<void> {
    try {
      await this.api.sendMessage(chatId, text);
    } catch (error) {
      this.log("warn", "failed to send telegram message", {
        chatId,
        cause: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async wait(durationMs: number): Promise<void> {
    if (durationMs <= 0 || this.abortController.signal.aborted) {
      return;
    }

    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        this.abortController.signal.removeEventListener("abort", onAbort);
        resolve();
      }, durationMs);
      timeout.unref?.();

      const onAbort = () => {
        clearTimeout(timeout);
        resolve();
      };

      this.abortController.signal.addEventListener("abort", onAbort, { once: true });
    });
  }
}

export async function startAsyncTelegramAdapter(
  options: AsyncTelegramAdapterOptions,
): Promise<AsyncTelegramAdapterHandle> {
  const adapter = new AsyncTelegramAdapterImpl(options);

  return {
    close: () => adapter.close(),
  };
}
