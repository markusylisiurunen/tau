import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import { z } from "zod";
import type { AsyncProjectConfig } from "../config/schema.js";
import { transcribeMistralAudio } from "../utils/mistral_transcription.js";
import { formatZodError } from "../utils/zod.js";
import {
  type AsyncSessionManager,
  AsyncSessionManagerError,
  type AsyncSessionManagerEvent,
  type AsyncSessionRecord,
  createScopedAsyncSessionManager,
} from "./session_manager.js";

type TelegramChat = {
  id: number;
  type: string;
};

type TelegramUser = {
  id: number;
};

type TelegramMessage = {
  message_id?: number;
  chat?: TelegramChat;
  from?: TelegramUser;
  text?: string;
  caption?: string;
  photo?: {
    file_id?: string;
    file_size?: number;
    width?: number;
    height?: number;
  }[];
  document?: {
    file_id?: string;
    file_name?: string;
    mime_type?: string;
    file_size?: number;
  };
  voice?: {
    file_id?: string;
    mime_type?: string;
  };
  audio?: {
    file_id?: string;
    mime_type?: string;
    file_name?: string;
  };
};

type TelegramInlineKeyboardButton = {
  text: string;
  callback_data: string;
};

type TelegramInlineKeyboardMarkup = {
  inline_keyboard: TelegramInlineKeyboardButton[][];
};

type TelegramCallbackQuery = {
  id?: string;
  from?: TelegramUser;
  data?: string;
  message?: TelegramMessage;
};

type TelegramUpdate = {
  update_id?: number;
  message?: TelegramMessage;
  callback_query?: TelegramCallbackQuery;
};

type TelegramAllowedUpdates = readonly string[];

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
  sendMessage(
    chatId: number,
    text: string,
    options?: {
      replyMarkup?: TelegramInlineKeyboardMarkup;
    },
  ): Promise<void>;
  downloadFile(fileId: string): Promise<Buffer>;
  setCommands?(commands: TelegramBotCommand[]): Promise<void>;
  setMessageReaction?(chatId: number, messageId: number): Promise<void>;
  answerCallbackQuery?(callbackQueryId: string, text?: string): Promise<void>;
};

export type AsyncTelegramLogLevel = "info" | "warn" | "error";

export type AsyncTelegramLogEntry = {
  level: AsyncTelegramLogLevel;
  message: string;
  data?: unknown;
};

export type AsyncTelegramAdapterOptions = {
  botId: string;
  botToken: string;
  projects: Record<string, AsyncProjectConfig>;
  defaultProjectId?: string;
  systemMessage?: string;
  allowedUserIds?: number[];
  allowedChatIds?: number[];
  pollIntervalMs?: number;
  requestTimeoutSeconds?: number;
  mistralApiKey?: string;
  sessionManager: AsyncSessionManager;
  api?: AsyncTelegramApi;
  fetchImpl?: typeof fetch;
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

type TelegramAudioMessage = {
  fileId: string;
  mimeType: string;
  fileName: string;
};

type TelegramPendingAttachment = {
  fileId: string;
  fileName: string;
  mimeType: string;
  declaredSizeBytes?: number;
  caption?: string;
  materialized?: {
    path: string;
    sizeBytes: number;
  };
};

type TelegramAttachmentDescriptor = {
  fileId: string;
  fileName: string;
  mimeType: string;
  sizeBytes?: number;
  caption?: string;
};

type TelegramMaterializedAttachment = {
  path: string;
  mimeType: string;
  sizeBytes: number;
  caption?: string;
};

const DEFAULT_POLL_INTERVAL_MS = 1000;
const DEFAULT_REQUEST_TIMEOUT_SECONDS = 30;
const MAX_COMMAND_PREVIEW_CHARS = 128;
const DEFAULT_TELEGRAM_VOICE_MIME_TYPE = "audio/ogg";
const DEFAULT_TELEGRAM_VOICE_FILE_NAME = "voice.ogg";
const DEFAULT_TELEGRAM_AUDIO_MIME_TYPE = "audio/mpeg";
const DEFAULT_TELEGRAM_AUDIO_FILE_NAME = "audio.mp3";
const DEFAULT_TELEGRAM_PHOTO_MIME_TYPE = "image/jpeg";
const DEFAULT_TELEGRAM_DOCUMENT_MIME_TYPE = "application/octet-stream";
const MESSAGE_QUEUED_REACTION_EMOJI = "👀";
const MESSAGE_QUEUED_REACTION_DELAY_MS = 1000;
const TELEGRAM_MAX_MESSAGE_BYTES = 4096;

const TELEGRAM_MESSAGE_BYTE_BUFFER_RATIO = 0.95;
const TELEGRAM_SAFE_MESSAGE_BYTES = Math.floor(
  TELEGRAM_MAX_MESSAGE_BYTES * TELEGRAM_MESSAGE_BYTE_BUFFER_RATIO,
);
const TELEGRAM_MESSAGE_SPLIT_DELAY_MS = 1000;
const ABORTED = Symbol("aborted");
const CALLBACK_ACTION_PREFIX = "tau:action:";
const CALLBACK_USE_PREFIX = "tau:use:";
const MAX_SESSION_PREVIEW_CHARS = 64;
const MAX_TELEGRAM_ATTACHMENTS_PER_TURN = 10;
const MAX_TELEGRAM_ATTACHMENT_FILE_BYTES = 20 * 1024 * 1024;
const MAX_TELEGRAM_ATTACHMENT_TOTAL_BYTES = 50 * 1024 * 1024;
const TELEGRAM_ATTACHMENT_TEMP_DIR_PREFIX = "tau-telegram-attachments-";
const NO_ACTIVE_SESSION_MESSAGE = "no active session. use /new or /sessions";

const SUPPORTED_TEXT_ATTACHMENT_EXTENSIONS = new Set([
  ".txt",
  ".md",
  ".json",
  ".csv",
  ".yaml",
  ".yml",
]);

const SUPPORTED_IMAGE_ATTACHMENT_EXTENSIONS = new Set([".jpg", ".jpeg", ".png", ".webp", ".gif"]);

const SUPPORTED_TEXT_ATTACHMENT_MIME_TYPES = new Set([
  "text/plain",
  "text/markdown",
  "application/json",
  "text/csv",
  "application/csv",
  "text/yaml",
  "application/yaml",
  "application/x-yaml",
  "text/x-yaml",
]);

const MIME_EXTENSION_BY_TYPE: Record<string, string> = {
  "application/pdf": ".pdf",
  "application/json": ".json",
  "text/markdown": ".md",
  "text/csv": ".csv",
  "application/csv": ".csv",
  "text/plain": ".txt",
  "text/yaml": ".yaml",
  "application/yaml": ".yaml",
  "application/x-yaml": ".yaml",
  "text/x-yaml": ".yaml",
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
  "image/gif": ".gif",
};

const MIME_TYPE_BY_EXTENSION: Record<string, string> = {
  ".pdf": "application/pdf",
  ".txt": "text/plain",
  ".md": "text/markdown",
  ".json": "application/json",
  ".csv": "text/csv",
  ".yaml": "text/yaml",
  ".yml": "text/yaml",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".png": "image/png",
  ".webp": "image/webp",
  ".gif": "image/gif",
};

async function sweepStaleTelegramAttachmentTempDirs(): Promise<void> {
  const systemTmpDir = tmpdir();

  try {
    const entries = await readdir(systemTmpDir, { withFileTypes: true, encoding: "utf8" });

    for (const entry of entries) {
      if (!entry.isDirectory() || !entry.name.startsWith(TELEGRAM_ATTACHMENT_TEMP_DIR_PREFIX)) {
        continue;
      }

      try {
        await rm(join(systemTmpDir, entry.name), { recursive: true, force: true });
      } catch {}
    }
  } catch {
    return;
  }
}

type QuickAction = "new" | "sessions" | "status" | "interrupt" | "close" | "quiet" | "verbose";

type SessionVerbosity = "verbose" | "quiet";

type TelegramCommandHandler = (chatId: number, args: string[]) => Promise<void>;

type TelegramCommandDefinition = {
  command: `/${string}`;
  description: string;
  usage: string;
  callbackAction?: QuickAction;
  handler: TelegramCommandHandler;
};

const QUICK_ACTION_ROWS: readonly (readonly QuickAction[])[] = [
  ["new", "sessions", "status"],
  ["interrupt", "close"],
  ["quiet", "verbose"],
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

function splitTelegramMessage(text: string): string[] {
  if (Buffer.byteLength(text, "utf8") <= TELEGRAM_SAFE_MESSAGE_BYTES) {
    return [text];
  }

  const chunks: string[] = [];
  let currentChunk = "";

  for (const character of text) {
    const nextChunk = `${currentChunk}${character}`;
    if (Buffer.byteLength(nextChunk, "utf8") <= TELEGRAM_SAFE_MESSAGE_BYTES) {
      currentChunk = nextChunk;
      continue;
    }

    if (currentChunk) {
      chunks.push(currentChunk);
      currentChunk = character;
      continue;
    }

    chunks.push(character);
  }

  if (currentChunk) {
    chunks.push(currentChunk);
  }

  return chunks;
}

function normalizeSizeBytes(value: number | undefined): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    return undefined;
  }

  const rounded = Math.floor(value);
  if (rounded <= 0) {
    return undefined;
  }

  return rounded;
}

function selectLargestPhotoVariant(
  variants: TelegramMessage["photo"],
): { fileId: string; sizeBytes?: number } | undefined {
  if (!variants || variants.length === 0) {
    return undefined;
  }

  let selected: NonNullable<TelegramMessage["photo"]>[number] | undefined;
  let selectedScore = -1;

  for (const variant of variants) {
    const fileId = variant.file_id?.trim();
    if (!fileId) {
      continue;
    }

    const fileSize = normalizeSizeBytes(variant.file_size);
    const width = normalizeSizeBytes(variant.width) ?? 0;
    const height = normalizeSizeBytes(variant.height) ?? 0;
    const resolutionScore = width * height;
    const sizeScore = fileSize ?? 0;
    const score = Math.max(sizeScore, resolutionScore);

    if (!selected || score >= selectedScore) {
      selected = variant;
      selectedScore = score;
    }
  }

  const selectedFileId = selected?.file_id?.trim();
  if (!selectedFileId) {
    return undefined;
  }

  return {
    fileId: selectedFileId,
    sizeBytes: normalizeSizeBytes(selected?.file_size),
  };
}

function inferExtensionFromMimeType(mimeType: string): string | undefined {
  const trimmed = mimeType.trim().toLowerCase();
  if (!trimmed) {
    return undefined;
  }

  return MIME_EXTENSION_BY_TYPE[trimmed];
}

function sanitizeAttachmentFileName(fileName: string, fallback: string): string {
  const trimmed = basename(fileName.trim());
  const normalized = trimmed
    .replace(/\s+/g, "-")
    .replace(/[^a-zA-Z0-9._-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^[-.]+/, "")
    .replace(/[-.]+$/, "");

  if (!normalized) {
    return fallback;
  }

  return normalized;
}

function inferMimeTypeFromFileName(fileName: string): string | undefined {
  const extension = extname(fileName.trim()).toLowerCase();
  if (!extension) {
    return undefined;
  }

  return MIME_TYPE_BY_EXTENSION[extension];
}

function isSupportedDocumentAttachment(mimeType: string, fileName: string): boolean {
  const normalizedMimeType = mimeType.trim().toLowerCase();
  if (normalizedMimeType.startsWith("image/")) {
    return true;
  }

  if (normalizedMimeType === "application/pdf") {
    return true;
  }

  if (SUPPORTED_TEXT_ATTACHMENT_MIME_TYPES.has(normalizedMimeType)) {
    return true;
  }

  const extension = extname(fileName.trim()).toLowerCase();
  if (SUPPORTED_TEXT_ATTACHMENT_EXTENSIONS.has(extension)) {
    return true;
  }

  if (extension === ".pdf") {
    return true;
  }

  return SUPPORTED_IMAGE_ATTACHMENT_EXTENSIONS.has(extension);
}

function describeAttachmentLimitBytes(sizeBytes: number): string {
  const megabytes = sizeBytes / (1024 * 1024);
  if (Number.isInteger(megabytes)) {
    return `${megabytes} MB`;
  }

  return `${megabytes.toFixed(1)} MB`;
}

function describeAttachment(fileName: string, mimeType: string): string {
  const trimmedFileName = fileName.trim();
  const trimmedMimeType = mimeType.trim();
  if (trimmedFileName) {
    return `'${trimmedFileName}'`;
  }

  if (trimmedMimeType) {
    return `'${trimmedMimeType}'`;
  }

  return "attachment";
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
    `verbosity: ${details.verbosity ?? "quiet"}`,
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

const telegramObject = <Shape extends z.ZodRawShape>(shape: Shape) => z.object(shape).passthrough();

const telegramPartialObject = <Shape extends z.ZodRawShape>(shape: Shape) =>
  telegramObject(shape).partial();

function parseOrThrow<Result>(schema: z.ZodType<Result>, raw: unknown, message: string): Result {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`${message}: ${formatZodError(parsed.error)}`);
  }
  return parsed.data;
}

const TelegramEnvelopeSchema = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    description: z.string().optional(),
    result: z.unknown(),
  }),
  z.object({
    ok: z.literal(false),
    description: z.string().optional(),
    result: z.unknown().optional(),
  }),
]);

const TelegramChatSchema = telegramObject({ id: z.number(), type: z.string() });
const TelegramUserSchema = telegramObject({ id: z.number() });
const TELEGRAM_FILE_SHAPE = {
  file_id: z.string(),
  file_name: z.string(),
  mime_type: z.string(),
  file_size: z.number(),
};
const TelegramFileSchema = telegramPartialObject(TELEGRAM_FILE_SHAPE);

const TelegramPhotoVariantSchema = telegramPartialObject({
  file_id: z.string(),
  file_size: z.number(),
  width: z.number(),
  height: z.number(),
});

const TelegramVoiceSchema = TelegramFileSchema.pick({ file_id: true, mime_type: true });
const TelegramAudioSchema = TelegramFileSchema.pick({
  file_id: true,
  mime_type: true,
  file_name: true,
});

const TelegramMessageSchema = telegramPartialObject({
  message_id: z.number(),
  chat: TelegramChatSchema,
  from: TelegramUserSchema,
  text: z.string(),
  caption: z.string(),
  photo: z.array(TelegramPhotoVariantSchema),
  document: TelegramFileSchema,
  voice: TelegramVoiceSchema,
  audio: TelegramAudioSchema,
});

const TelegramCallbackQuerySchema = telegramPartialObject({
  id: z.string(),
  from: TelegramUserSchema,
  data: z.string(),
  message: telegramPartialObject({ chat: TelegramChatSchema }),
});

const TelegramUpdateSchema = telegramPartialObject({
  update_id: z.number(),
  message: TelegramMessageSchema,
  callback_query: TelegramCallbackQuerySchema,
});

const TelegramGetUpdatesResultSchema = z.array(TelegramUpdateSchema);
const TelegramGetFileResultSchema = z.object({ file_path: z.string() });
const TelegramAckResultSchema = z.literal(true);

function createTelegramApi(botToken: string): AsyncTelegramApi {
  const apiUrl = `https://api.telegram.org/bot${botToken}`;

  async function callTelegramMethod<Result>(
    method: string,
    payload: Record<string, unknown>,
    resultSchema: z.ZodType<Result>,
  ): Promise<Result> {
    const response = await fetch(`${apiUrl}/${method}`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
      },
      body: JSON.stringify(payload),
    });

    if (!response.ok) {
      const detail = (await response.text()).trim();
      throw new Error(detail || `telegram ${method} failed: HTTP ${response.status}`);
    }

    let raw: unknown;
    try {
      raw = await response.json();
    } catch {
      throw new Error(`telegram ${method} returned invalid JSON`);
    }

    const envelope = parseOrThrow(
      TelegramEnvelopeSchema,
      raw,
      `telegram ${method} returned an invalid response payload`,
    );

    if (!envelope.ok) {
      const detail = envelope.description?.trim() ?? "";
      throw new Error(detail || `telegram ${method} request failed`);
    }

    return parseOrThrow(
      resultSchema,
      envelope.result,
      `telegram ${method} returned an invalid result`,
    );
  }

  return {
    async getUpdates(args) {
      return callTelegramMethod(
        "getUpdates",
        {
          offset: args.offset,
          timeout: args.timeoutSeconds,
          allowed_updates: args.allowedUpdates,
        },
        TelegramGetUpdatesResultSchema,
      );
    },
    async sendMessage(chatId, text, options) {
      await callTelegramMethod(
        "sendMessage",
        {
          chat_id: chatId,
          text,
          ...(options?.replyMarkup ? { reply_markup: options.replyMarkup } : {}),
        },
        z.unknown(),
      );
    },
    async downloadFile(fileId) {
      const parsed = await callTelegramMethod(
        "getFile",
        {
          file_id: fileId,
        },
        TelegramGetFileResultSchema,
      );

      const filePath = parsed.file_path?.trim();
      if (!filePath) {
        throw new Error("telegram file path is missing");
      }

      const response = await fetch(`https://api.telegram.org/file/bot${botToken}/${filePath}`);
      if (!response.ok) {
        const detail = (await response.text()).trim();
        throw new Error(detail || `telegram file download failed: HTTP ${response.status}`);
      }

      const bytes = await response.arrayBuffer();
      return Buffer.from(bytes);
    },
    async setCommands(commands) {
      await callTelegramMethod(
        "setMyCommands",
        {
          commands,
        },
        TelegramAckResultSchema,
      );
    },
    async setMessageReaction(chatId, messageId) {
      await callTelegramMethod(
        "setMessageReaction",
        {
          chat_id: chatId,
          message_id: messageId,
          reaction: [{ type: "emoji", emoji: MESSAGE_QUEUED_REACTION_EMOJI }],
        },
        TelegramAckResultSchema,
      );
    },
    async answerCallbackQuery(callbackQueryId, text) {
      await callTelegramMethod(
        "answerCallbackQuery",
        {
          callback_query_id: callbackQueryId,
          ...(text ? { text } : {}),
        },
        TelegramAckResultSchema,
      );
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
  private readonly mistralApiKey?: string;
  private readonly sessionManager: AsyncSessionManager;
  private readonly enforceChatOwnership: boolean;
  private readonly botOwnerPrefix: string;
  private readonly allowedProjectIds: string[];
  private readonly api: AsyncTelegramApi;
  private readonly fetchImpl?: typeof fetch;
  private readonly onLog?: (entry: AsyncTelegramLogEntry) => void;
  private readonly commandDefinitions: TelegramCommandDefinition[];
  private readonly commandHandlers: Map<string, TelegramCommandHandler>;
  private readonly callbackActionHandlers: Map<QuickAction, TelegramCommandHandler>;
  private readonly abortController = new AbortController();
  private readonly activeSessionsByChat = new Map<number, string>();
  private readonly sessionsByChat = new Map<number, Set<string>>();
  private readonly chatsBySession = new Map<string, Set<number>>();
  private readonly sessionVerbosityBySession = new Map<string, SessionVerbosity>();
  private readonly lastCommandBySession = new Map<string, string>();
  private readonly lastAssistantMessageBySession = new Map<string, string>();
  private readonly latestAssistantMessageByRun = new Map<string, string>();
  private readonly pendingAttachmentsBySession = new Map<string, TelegramPendingAttachment[]>();
  private readonly pendingAttachmentTempDirBySession = new Map<string, string>();
  private readonly attachmentTempDirsBySession = new Map<string, Set<string>>();
  private readonly updateQueueTailByKey = new Map<string, Promise<void>>();
  private readonly inFlightUpdateTasks = new Set<Promise<void>>();

  private readonly unsubscribeSessionEvents: () => void;
  private readonly loopPromise: Promise<void>;

  private nextUpdateOffset = 0;
  private closed = false;

  constructor(options: AsyncTelegramAdapterOptions) {
    const botId = options.botId.trim();
    if (!botId) {
      throw new Error("telegram bot id must be a non-empty string");
    }

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
    this.mistralApiKey = options.mistralApiKey?.trim() || undefined;
    this.sessionManager = options.sessionManager;
    this.enforceChatOwnership = true;
    this.botOwnerPrefix = `telegram:${botId}`;
    this.allowedProjectIds = Object.keys(options.projects);
    this.api = options.api ?? createTelegramApi(options.botToken);
    this.fetchImpl = options.fetchImpl;
    this.onLog = options.onLog;
    this.commandDefinitions = this.createCommandDefinitions();
    this.commandHandlers = new Map();
    this.callbackActionHandlers = new Map();

    for (const definition of this.commandDefinitions) {
      this.commandHandlers.set(definition.command, definition.handler);
      if (definition.callbackAction) {
        this.callbackActionHandlers.set(definition.callbackAction, definition.handler);
      }
    }

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
      await this.waitForInFlightUpdateTasks();

      for (const sessionId of Array.from(this.attachmentTempDirsBySession.keys())) {
        await this.cleanupSessionAttachmentTempDirs(sessionId);
      }
      this.pendingAttachmentsBySession.clear();
      this.pendingAttachmentTempDirBySession.clear();
    } finally {
      this.log("info", "telegram adapter stopped");
    }
  }

  private log(level: AsyncTelegramLogLevel, message: string, data?: unknown): void {
    this.onLog?.({ level, message, ...(data === undefined ? {} : { data }) });
  }

  private createCommandDefinitions(): TelegramCommandDefinition[] {
    return [
      {
        command: "/help",
        description: "show supported commands",
        usage: "/help",
        handler: async (chatId) => this.handleHelp(chatId),
      },
      {
        command: "/new",
        description: "start a new session",
        usage: "/new [projectId]",
        callbackAction: "new",
        handler: async (chatId, args) => this.handleNew(chatId, args),
      },
      {
        command: "/projects",
        description: "list configured projects",
        usage: "/projects",
        handler: async (chatId) => this.handleProjects(chatId),
      },
      {
        command: "/use",
        description: "switch active session",
        usage: "/use <sessionId|prefix|index>",
        handler: async (chatId, args) => this.handleUse(chatId, args),
      },
      {
        command: "/sessions",
        description: "list sessions",
        usage: "/sessions",
        callbackAction: "sessions",
        handler: async (chatId) => this.handleSessions(chatId),
      },
      {
        command: "/status",
        description: "show active session status",
        usage: "/status",
        callbackAction: "status",
        handler: async (chatId) => this.handleStatus(chatId),
      },
      {
        command: "/interrupt",
        description: "interrupt active run",
        usage: "/interrupt",
        callbackAction: "interrupt",
        handler: async (chatId) => this.handleInterrupt(chatId),
      },
      {
        command: "/close",
        description: "close session(s)",
        usage: "/close [<sessionId>|all]",
        callbackAction: "close",
        handler: async (chatId, args) => this.handleClose(chatId, args),
      },
      {
        command: "/verbose",
        description: "stream progress updates",
        usage: "/verbose",
        callbackAction: "verbose",
        handler: async (chatId) => this.handleVerbosityCommand(chatId, "verbose"),
      },
      {
        command: "/quiet",
        description: "only send final assistant message",
        usage: "/quiet",
        callbackAction: "quiet",
        handler: async (chatId) => this.handleVerbosityCommand(chatId, "quiet"),
      },
    ];
  }

  private async syncCommands(): Promise<void> {
    if (!this.api.setCommands) {
      return;
    }

    const commands: TelegramBotCommand[] = this.commandDefinitions.map((definition) => ({
      command: definition.command.slice(1),
      description: definition.description,
    }));

    try {
      await this.api.setCommands(commands);
      this.log("info", "telegram commands synced", { count: commands.length });
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

          this.enqueueUpdate(update);
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

  private enqueueUpdate(update: TelegramUpdate): void {
    const queueKey = this.getUpdateQueueKey(update);
    const previousTask = this.updateQueueTailByKey.get(queueKey) ?? Promise.resolve();

    const queuedTask = previousTask
      .then(async () => {
        if (this.abortController.signal.aborted) {
          return;
        }

        await this.handleUpdate(update);
      })
      .catch((error) => {
        if (this.abortController.signal.aborted) {
          return;
        }

        const updateId =
          typeof update.update_id === "number" && Number.isFinite(update.update_id)
            ? update.update_id
            : undefined;
        this.log("warn", "telegram update handling failed", {
          ...(updateId === undefined ? {} : { updateId }),
          cause: error instanceof Error ? error.message : String(error),
        });
      });

    const trackedTask = queuedTask.finally(() => {
      this.inFlightUpdateTasks.delete(trackedTask);
      if (this.updateQueueTailByKey.get(queueKey) === trackedTask) {
        this.updateQueueTailByKey.delete(queueKey);
      }
    });

    this.updateQueueTailByKey.set(queueKey, trackedTask);
    this.inFlightUpdateTasks.add(trackedTask);
  }

  private getUpdateQueueKey(update: TelegramUpdate): string {
    const messageChatId = update.message?.chat?.id;
    if (typeof messageChatId === "number" && Number.isFinite(messageChatId)) {
      return `chat:${messageChatId}`;
    }

    const callbackChatId = update.callback_query?.message?.chat?.id;
    if (typeof callbackChatId === "number" && Number.isFinite(callbackChatId)) {
      return `chat:${callbackChatId}`;
    }

    return "global";
  }

  private async waitForInFlightUpdateTasks(): Promise<void> {
    if (this.inFlightUpdateTasks.size === 0) {
      return;
    }

    await Promise.allSettled(Array.from(this.inFlightUpdateTasks));
  }

  private async getUpdates(): Promise<TelegramUpdate[]> {
    const updates = await this.raceWithAbort(
      this.api.getUpdates({
        offset: this.nextUpdateOffset,
        timeoutSeconds: this.requestTimeoutSeconds,
        allowedUpdates: ["message", "callback_query"],
      }),
    );

    if (updates === undefined) {
      return [];
    }

    return updates;
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
    if (message) {
      const chat = message.chat;
      if (chat?.type !== "private") {
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
      const isCommand = text.startsWith("/");

      if (!isCommand) {
        await this.queueMessageAttachments(chatId, message);
      }

      if (text) {
        if (isCommand) {
          await this.handleCommand(chatId, text);
          return;
        }

        await this.handleMessage(chatId, text, message.message_id);
        return;
      }

      const audioMessage = this.parseAudioMessage(message);
      if (!audioMessage) {
        return;
      }

      await this.handleAudioMessage(chatId, audioMessage, message.message_id);
      return;
    }

    const callbackQuery = update.callback_query;
    if (!callbackQuery) {
      return;
    }

    const chat = callbackQuery.message?.chat;
    if (chat?.type !== "private") {
      await this.answerCallbackQuery(callbackQuery.id);
      return;
    }

    const chatId = chat.id;
    if (!this.isChatAllowed(chatId)) {
      await this.answerCallbackQuery(callbackQuery.id);
      return;
    }

    if (!this.isUserAllowed(callbackQuery.from?.id)) {
      await this.answerCallbackQuery(callbackQuery.id);
      return;
    }

    const callbackData = callbackQuery.data?.trim();
    if (!callbackData) {
      await this.answerCallbackQuery(callbackQuery.id);
      return;
    }

    const callbackHandled = await this.handleCallback(chatId, callbackData);
    await this.answerCallbackQuery(callbackQuery.id, callbackHandled ? "done" : undefined);
  }

  private parseAudioMessage(message: TelegramMessage): TelegramAudioMessage | undefined {
    const voiceFileId = message.voice?.file_id?.trim();
    if (voiceFileId) {
      return {
        fileId: voiceFileId,
        mimeType: message.voice?.mime_type?.trim() || DEFAULT_TELEGRAM_VOICE_MIME_TYPE,
        fileName: DEFAULT_TELEGRAM_VOICE_FILE_NAME,
      };
    }

    const audioFileId = message.audio?.file_id?.trim();
    if (!audioFileId) {
      return undefined;
    }

    return {
      fileId: audioFileId,
      mimeType: message.audio?.mime_type?.trim() || DEFAULT_TELEGRAM_AUDIO_MIME_TYPE,
      fileName: message.audio?.file_name?.trim() || DEFAULT_TELEGRAM_AUDIO_FILE_NAME,
    };
  }

  private async queueMessageAttachments(chatId: number, message: TelegramMessage): Promise<void> {
    const caption = typeof message.caption === "string" ? message.caption.trim() : "";
    const attachmentCaption = caption || undefined;
    const parsedAttachments: TelegramAttachmentDescriptor[] = [];

    const photo = selectLargestPhotoVariant(message.photo);
    if (photo) {
      const extension = inferExtensionFromMimeType(DEFAULT_TELEGRAM_PHOTO_MIME_TYPE) ?? ".jpg";
      const fileName = sanitizeAttachmentFileName(`photo${extension}`, `photo${extension}`);
      parsedAttachments.push({
        fileId: photo.fileId,
        fileName,
        mimeType: DEFAULT_TELEGRAM_PHOTO_MIME_TYPE,
        sizeBytes: photo.sizeBytes,
        caption: attachmentCaption,
      });
    }

    const documentFileId = message.document?.file_id?.trim();
    if (documentFileId) {
      const rawMimeType = message.document?.mime_type?.trim().toLowerCase();
      const mimeTypeForExtension =
        rawMimeType && rawMimeType !== DEFAULT_TELEGRAM_DOCUMENT_MIME_TYPE
          ? rawMimeType
          : undefined;
      const inferredExtension = inferExtensionFromMimeType(mimeTypeForExtension ?? "") ?? "";
      const fallbackFileName = `attachment${inferredExtension}`;
      const rawFileName = message.document?.file_name?.trim() || fallbackFileName;
      let fileName = sanitizeAttachmentFileName(rawFileName, fallbackFileName || "attachment");
      if (!extname(fileName) && inferredExtension) {
        fileName = `${fileName}${inferredExtension}`;
      }

      const mimeType =
        mimeTypeForExtension ??
        inferMimeTypeFromFileName(fileName) ??
        rawMimeType ??
        DEFAULT_TELEGRAM_DOCUMENT_MIME_TYPE;

      if (!isSupportedDocumentAttachment(mimeType, fileName)) {
        await this.reply(
          chatId,
          `skipped attachment ${describeAttachment(fileName, mimeType)}: unsupported file type`,
        );
      } else {
        parsedAttachments.push({
          fileId: documentFileId,
          fileName,
          mimeType,
          sizeBytes: normalizeSizeBytes(message.document?.file_size),
          caption: attachmentCaption,
        });
      }
    }

    if (parsedAttachments.length === 0) {
      return;
    }

    const session = await this.requireActiveOrSingleSession(chatId);
    if (!session) {
      return;
    }

    const pending = this.pendingAttachmentsBySession.get(session.id) ?? [];
    let totalSizeBytes = pending.reduce((total, attachment) => {
      return total + (attachment.materialized?.sizeBytes ?? attachment.declaredSizeBytes ?? 0);
    }, 0);

    for (const attachment of parsedAttachments) {
      const attachmentLabel = describeAttachment(attachment.fileName, attachment.mimeType);
      if (pending.length >= MAX_TELEGRAM_ATTACHMENTS_PER_TURN) {
        await this.replySkippedAttachment(
          chatId,
          attachmentLabel,
          `exceeds attachment limit (${MAX_TELEGRAM_ATTACHMENTS_PER_TURN} files per turn)`,
        );
        continue;
      }

      const declaredFileLimitReason =
        typeof attachment.sizeBytes === "number"
          ? this.getAttachmentPerFileLimitReason(attachment.sizeBytes)
          : undefined;
      if (declaredFileLimitReason) {
        await this.replySkippedAttachment(chatId, attachmentLabel, declaredFileLimitReason);
        continue;
      }

      const declaredTotalLimitReason =
        typeof attachment.sizeBytes === "number"
          ? this.getAttachmentTotalLimitReason(totalSizeBytes, attachment.sizeBytes)
          : undefined;
      if (declaredTotalLimitReason) {
        await this.replySkippedAttachment(chatId, attachmentLabel, declaredTotalLimitReason);
        continue;
      }

      let bytes: Buffer;
      try {
        bytes = await this.api.downloadFile(attachment.fileId);
      } catch (error) {
        await this.reply(
          chatId,
          `failed to download attachment ${attachmentLabel}: ${this.formatManagerError(error)}`,
        );
        continue;
      }

      const sizeBytes = bytes.byteLength;
      const fileLimitReason = this.getAttachmentPerFileLimitReason(sizeBytes);
      if (fileLimitReason) {
        await this.replySkippedAttachment(chatId, attachmentLabel, fileLimitReason);
        continue;
      }

      const totalLimitReason = this.getAttachmentTotalLimitReason(totalSizeBytes, sizeBytes);
      if (totalLimitReason) {
        await this.replySkippedAttachment(chatId, attachmentLabel, totalLimitReason);
        continue;
      }

      const tempDirPath = await this.getOrCreatePendingAttachmentTempDir(session.id);
      const indexedFileName = `${String(pending.length + 1).padStart(2, "0")}-${attachment.fileName}`;
      const filePath = join(tempDirPath, indexedFileName);

      try {
        await writeFile(filePath, bytes);
      } catch (error) {
        await this.reply(
          chatId,
          `failed to materialize attachment ${attachmentLabel}: ${this.formatManagerError(error)}`,
        );
        continue;
      }

      pending.push({
        fileId: attachment.fileId,
        fileName: attachment.fileName,
        mimeType: attachment.mimeType,
        declaredSizeBytes: attachment.sizeBytes,
        caption: attachment.caption,
        materialized: {
          path: filePath,
          sizeBytes,
        },
      });

      totalSizeBytes += sizeBytes;
    }

    if (pending.length > 0) {
      this.pendingAttachmentsBySession.set(session.id, pending);
    }
  }

  private async buildMessageTextWithAttachments(
    sessionId: string,
    text: string,
    chatId: number,
  ): Promise<string> {
    const attachments = await this.materializePendingAttachments(sessionId, chatId);
    if (attachments.length === 0) {
      return text;
    }

    return [this.formatAttachmentBlock(attachments), text].join("\n\n");
  }

  private formatAttachmentBlock(attachments: TelegramMaterializedAttachment[]): string {
    const lines = ["attachments:"];
    for (const attachment of attachments) {
      lines.push(`- path: ${attachment.path}`);
      lines.push(`  mime: ${attachment.mimeType}`);
      lines.push(`  size_bytes: ${attachment.sizeBytes}`);
      if (attachment.caption) {
        lines.push(`  caption: ${JSON.stringify(attachment.caption)}`);
      }
    }

    return lines.join("\n");
  }

  private async materializePendingAttachments(
    sessionId: string,
    chatId: number,
  ): Promise<TelegramMaterializedAttachment[]> {
    const pending = this.pendingAttachmentsBySession.get(sessionId);
    if (!pending || pending.length === 0) {
      return [];
    }

    let totalSizeBytes = 0;
    const nextPending: TelegramPendingAttachment[] = [];
    const readyAttachments: TelegramMaterializedAttachment[] = [];

    for (const attachment of pending) {
      const attachmentLabel = describeAttachment(attachment.fileName, attachment.mimeType);
      const materialized = attachment.materialized;
      if (!materialized) {
        await this.reply(
          chatId,
          `skipped attachment ${attachmentLabel}: local temp file is missing`,
        );
        continue;
      }

      const fileLimitReason = this.getAttachmentPerFileLimitReason(materialized.sizeBytes);
      if (fileLimitReason) {
        await this.replySkippedAttachment(chatId, attachmentLabel, fileLimitReason);
        continue;
      }

      const totalLimitReason = this.getAttachmentTotalLimitReason(
        totalSizeBytes,
        materialized.sizeBytes,
      );
      if (totalLimitReason) {
        await this.replySkippedAttachment(chatId, attachmentLabel, totalLimitReason);
        continue;
      }

      totalSizeBytes += materialized.sizeBytes;
      nextPending.push(attachment);
      readyAttachments.push({
        path: materialized.path,
        mimeType: attachment.mimeType,
        sizeBytes: materialized.sizeBytes,
        caption: attachment.caption,
      });
    }

    if (nextPending.length === 0) {
      this.pendingAttachmentsBySession.delete(sessionId);
    } else {
      this.pendingAttachmentsBySession.set(sessionId, nextPending);
    }

    return readyAttachments;
  }

  private async getOrCreatePendingAttachmentTempDir(sessionId: string): Promise<string> {
    const existingPath = this.pendingAttachmentTempDirBySession.get(sessionId);
    if (existingPath) {
      return existingPath;
    }

    const directoryPath = await mkdtemp(join(tmpdir(), TELEGRAM_ATTACHMENT_TEMP_DIR_PREFIX));
    this.pendingAttachmentTempDirBySession.set(sessionId, directoryPath);

    const directories = this.attachmentTempDirsBySession.get(sessionId) ?? new Set<string>();
    directories.add(directoryPath);
    this.attachmentTempDirsBySession.set(sessionId, directories);
    return directoryPath;
  }

  private resetPendingAttachmentQueue(sessionId: string): void {
    this.pendingAttachmentsBySession.delete(sessionId);
    this.pendingAttachmentTempDirBySession.delete(sessionId);
  }

  private clearSessionAttachments(sessionId: string): void {
    this.resetPendingAttachmentQueue(sessionId);
    void this.cleanupSessionAttachmentTempDirs(sessionId);
  }

  private async cleanupSessionAttachmentTempDirs(sessionId: string): Promise<void> {
    const directories = this.attachmentTempDirsBySession.get(sessionId);
    if (!directories || directories.size === 0) {
      return;
    }

    this.attachmentTempDirsBySession.delete(sessionId);

    for (const directoryPath of directories) {
      try {
        await rm(directoryPath, { recursive: true, force: true });
      } catch (error) {
        this.log("warn", "failed to clean up telegram attachment temp directory", {
          sessionId,
          directoryPath,
          cause: this.formatManagerError(error),
        });
      }
    }
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

  private ownerIdForChat(chatId: number): string {
    if (!this.enforceChatOwnership) {
      return this.botOwnerPrefix;
    }

    return `${this.botOwnerPrefix}:chat:${chatId}`;
  }

  private getSessionManagerForChat(chatId: number): AsyncSessionManager {
    if (!this.enforceChatOwnership) {
      return this.sessionManager;
    }

    return createScopedAsyncSessionManager({
      sessionManager: this.sessionManager,
      ownerId: this.ownerIdForChat(chatId),
      allowedProjectIds: this.allowedProjectIds,
    });
  }

  private async handleCommand(chatId: number, text: string): Promise<void> {
    const parts = splitCommandText(text);
    const command = stripCommandMention(parts[0] ?? "");
    const args = parts.slice(1);
    const handler = this.commandHandlers.get(command);

    if (!handler) {
      await this.reply(chatId, "unsupported command. use /help");
      return;
    }

    await handler(chatId, args);
  }

  private async handleCallback(chatId: number, callbackData: string): Promise<boolean> {
    if (callbackData.startsWith(CALLBACK_USE_PREFIX)) {
      const sessionId = callbackData.slice(CALLBACK_USE_PREFIX.length).trim();
      if (!sessionId) {
        return false;
      }

      await this.handleUse(chatId, [sessionId]);
      return true;
    }

    if (!callbackData.startsWith(CALLBACK_ACTION_PREFIX)) {
      return false;
    }

    const action = callbackData.slice(CALLBACK_ACTION_PREFIX.length).trim() as QuickAction;
    const handler = this.callbackActionHandlers.get(action);
    if (!handler) {
      return false;
    }

    await handler(chatId, []);
    return true;
  }

  private async handleHelp(chatId: number): Promise<void> {
    const lines = [
      "commands:",
      ...this.commandDefinitions.map((definition) => definition.usage),
      "",
      "tip: use /sessions and tap a session button to switch quickly",
    ];

    await this.reply(chatId, lines.join("\n"), {
      replyMarkup: this.buildQuickActionsKeyboard(),
    });
  }

  private resolveNewCommand(args: string[]): NewCommandResolution {
    const projectIds = Object.keys(this.projects);

    const resolveFallbackProjectId = (): { projectId?: string; error?: string } => {
      if (this.defaultProjectId) {
        if (!this.projects[this.defaultProjectId]) {
          return {
            error: `telegram.<botId>.defaultProjectId '${this.defaultProjectId}' is not configured`,
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

      return {
        error: "missing project id. usage: /new [projectId]. use /projects to list options",
      };
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
          error: `unknown project '${projectId}'. usage: /new [projectId]. use /projects to list options`,
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

  private async handleProjects(chatId: number): Promise<void> {
    const entries = Object.entries(this.projects).sort(([left], [right]) =>
      left.localeCompare(right),
    );

    if (entries.length === 0) {
      await this.reply(chatId, "no async projects configured");
      return;
    }

    const lines = entries.map(([projectId, project]) => {
      if (!project.description) {
        return projectId;
      }

      return `${projectId}: ${project.description}`;
    });

    await this.reply(chatId, [`projects:`, ...lines].join("\n"));
  }

  private async handleNew(chatId: number, args: string[]): Promise<void> {
    const parsed = this.resolveNewCommand(args);
    if ("error" in parsed) {
      await this.reply(chatId, parsed.error);
      return;
    }

    try {
      const sessionManager = this.getSessionManagerForChat(chatId);
      const session = await sessionManager.createSession({
        projectId: parsed.projectId,
      });

      this.setActiveSession(chatId, session.id);
      this.sessionVerbosityBySession.set(session.id, "quiet");
      await this.reply(chatId, this.formatSessionPreparing(session.projectId));
    } catch (error) {
      await this.reply(chatId, this.formatManagerError(error));
    }
  }

  private async handleUse(chatId: number, args: string[]): Promise<void> {
    const selector = args[0]?.trim();
    if (!selector) {
      await this.reply(chatId, "usage: /use <sessionId|prefix|index>");
      return;
    }

    const sessionManager = this.getSessionManagerForChat(chatId);
    const sessions = sessionManager.listSessions();
    const selectedSession = this.resolveSessionSelector(selector, sessions, sessionManager);
    if ("error" in selectedSession) {
      await this.reply(chatId, selectedSession.error);
      return;
    }

    this.setActiveSession(chatId, selectedSession.session.id);
    await this.reply(
      chatId,
      formatSessionHeadline(
        selectedSession.session.id,
        `using session (${selectedSession.session.state})`,
      ),
    );
  }

  private resolveSessionSelector(
    selector: string,
    sessions: AsyncSessionRecord[],
    sessionManager: AsyncSessionManager,
  ): { session: AsyncSessionRecord } | { error: string } {
    const exactSession = sessionManager.getSession(selector);
    if (exactSession) {
      return { session: exactSession };
    }

    if (/^\d+$/.test(selector)) {
      const index = Number.parseInt(selector, 10);
      if (index <= 0 || index > sessions.length) {
        return {
          error:
            sessions.length === 0
              ? "no sessions"
              : `session index '${selector}' is out of range (1-${sessions.length})`,
        };
      }

      const indexedSession = sessions[index - 1];
      if (!indexedSession) {
        return { error: "session index lookup failed" };
      }

      return { session: indexedSession };
    }

    const prefixMatches = sessions.filter((session) => session.id.startsWith(selector));
    if (prefixMatches.length === 1) {
      const [prefixMatch] = prefixMatches;
      if (!prefixMatch) {
        return { error: "session prefix lookup failed" };
      }

      return { session: prefixMatch };
    }

    if (prefixMatches.length > 1) {
      return {
        error: `session prefix '${selector}' is ambiguous: ${prefixMatches.map((session) => session.id).join(", ")}`,
      };
    }

    return { error: `session '${selector}' not found` };
  }

  private async handleSessions(chatId: number): Promise<void> {
    const sessionManager = this.getSessionManagerForChat(chatId);
    const sessions = sessionManager.listSessions();
    const lines = this.formatSessions(chatId, sessions);

    await this.reply(chatId, lines.join("\n"), {
      replyMarkup: this.buildSessionsKeyboard(chatId, sessions),
    });
  }

  private formatSessions(chatId: number, sessions: AsyncSessionRecord[]): string[] {
    if (sessions.length === 0) {
      return ["no sessions"];
    }

    const activeSessionId = this.activeSessionsByChat.get(chatId);
    return [
      "sessions:",
      ...sessions.map((session, index) => {
        const marker = session.id === activeSessionId ? "*" : "-";
        const preview = this.formatSessionPreview(session.id);
        return `${index + 1}. ${marker} ${session.id} ${session.projectId} ${session.state}${preview ? ` · ${preview}` : ""}`;
      }),
    ];
  }

  private formatSessionPreview(sessionId: string): string | undefined {
    const previews: string[] = [];

    const lastCommand = this.lastCommandBySession.get(sessionId);
    if (lastCommand) {
      previews.push(`$ ${truncateText(lastCommand, MAX_SESSION_PREVIEW_CHARS)}`);
    }

    const lastAssistantMessage = this.lastAssistantMessageBySession.get(sessionId);
    if (lastAssistantMessage) {
      previews.push(truncateText(lastAssistantMessage, MAX_SESSION_PREVIEW_CHARS));
    }

    if (previews.length === 0) {
      return undefined;
    }

    return previews.join(" | ");
  }

  private buildSessionsKeyboard(
    chatId: number,
    sessions: AsyncSessionRecord[],
  ): TelegramInlineKeyboardMarkup {
    const activeSessionId = this.activeSessionsByChat.get(chatId);
    const inlineKeyboard: TelegramInlineKeyboardButton[][] = sessions.map((session, index) => [
      {
        text: `${index + 1}. ${session.id}${session.id === activeSessionId ? " *" : ""}`,
        callback_data: `${CALLBACK_USE_PREFIX}${session.id}`,
      },
    ]);

    inlineKeyboard.push(...this.buildQuickActionsKeyboard().inline_keyboard);
    return {
      inline_keyboard: inlineKeyboard,
    };
  }

  private buildQuickActionsKeyboard(): TelegramInlineKeyboardMarkup {
    return {
      inline_keyboard: QUICK_ACTION_ROWS.map((row) =>
        row.map((action) => ({
          text: `/${action}`,
          callback_data: `${CALLBACK_ACTION_PREFIX}${action}`,
        })),
      ),
    };
  }

  private async handleStatus(chatId: number): Promise<void> {
    const session = await this.requireActiveSession(chatId);
    if (!session) {
      return;
    }

    await this.reply(
      chatId,
      describeSession(session, {
        verbosity: this.getSessionVerbosity(session.id),
        lastCommand: this.lastCommandBySession.get(session.id),
        lastAssistantMessage: this.lastAssistantMessageBySession.get(session.id),
      }),
      {
        replyMarkup: this.buildQuickActionsKeyboard(),
      },
    );
  }

  private async handleInterrupt(chatId: number): Promise<void> {
    const session = await this.requireActiveSession(chatId);
    if (!session) {
      return;
    }

    try {
      const sessionManager = this.getSessionManagerForChat(chatId);
      const result = await sessionManager.interruptSession(session.id);
      if (!result.interrupted) {
        await this.reply(chatId, formatSessionHeadline(result.session.id, "no run in progress"));
        return;
      }

      await this.reply(chatId, formatSessionHeadline(result.session.id, "interrupt requested"));
    } catch (error) {
      await this.reply(chatId, this.formatManagerError(error));
    }
  }

  private async handleClose(chatId: number, args: string[]): Promise<void> {
    if (args.length > 1) {
      await this.reply(chatId, "usage: /close [<sessionId>|all]");
      return;
    }

    const target = args[0]?.trim();
    if (target === "all") {
      try {
        const sessionManager = this.getSessionManagerForChat(chatId);
        const closed = await sessionManager.closeInactiveSessions();
        for (const session of closed) {
          this.clearClosedSession(session.id);
        }

        if (closed.length === 0) {
          await this.reply(chatId, "no sessions to close");
          return;
        }

        const label = closed.length === 1 ? "session" : "sessions";
        await this.reply(
          chatId,
          [`closed ${closed.length} ${label}`, closed.map((session) => session.id).join(", ")].join(
            "\n",
          ),
        );
      } catch (error) {
        await this.reply(chatId, this.formatManagerError(error));
      }

      return;
    }

    const sessionId = target ?? this.getActiveSession(chatId)?.id;
    if (!sessionId) {
      await this.reply(chatId, NO_ACTIVE_SESSION_MESSAGE);
      return;
    }

    try {
      const sessionManager = this.getSessionManagerForChat(chatId);
      const closed = await sessionManager.closeSession(sessionId);
      this.clearClosedSession(closed.id);
      await this.reply(chatId, formatSessionHeadline(closed.id, "closed"));
    } catch (error) {
      await this.reply(chatId, this.formatManagerError(error));
    }
  }

  private async handleVerbosityCommand(chatId: number, verbosity: SessionVerbosity): Promise<void> {
    const session = await this.requireActiveSession(chatId);
    if (!session) {
      return;
    }

    this.sessionVerbosityBySession.set(session.id, verbosity);
    await this.reply(chatId, formatSessionHeadline(session.id, `verbosity set to ${verbosity}`));
  }

  private async handleMessage(
    chatId: number,
    text: string,
    sourceMessageId?: number,
  ): Promise<void> {
    const session = await this.requireActiveOrSingleSession(chatId);
    if (!session) {
      return;
    }

    try {
      await this.submitSessionMessage(chatId, session.id, text, sourceMessageId);
    } catch (error) {
      await this.reply(chatId, this.formatManagerError(error));
    }
  }

  private async handleAudioMessage(
    chatId: number,
    message: TelegramAudioMessage,
    sourceMessageId?: number,
  ): Promise<void> {
    const session = await this.requireActiveOrSingleSession(chatId);
    if (!session) {
      return;
    }

    if (!this.mistralApiKey) {
      await this.reply(
        chatId,
        "set MISTRAL_API_KEY or apiKeys.mistral to transcribe Telegram audio",
      );
      return;
    }

    let transcript = "";
    try {
      const audio = await this.api.downloadFile(message.fileId);
      transcript = (
        await transcribeMistralAudio({
          apiKey: this.mistralApiKey,
          audio,
          fileName: message.fileName,
          mimeType: message.mimeType,
          fetchImpl: this.fetchImpl,
        })
      ).trim();
    } catch (error) {
      await this.reply(chatId, `audio transcription failed: ${this.formatManagerError(error)}`);
      return;
    }

    if (!transcript) {
      await this.reply(chatId, "audio transcription failed: transcription result was empty");
      return;
    }

    try {
      await this.submitSessionMessage(chatId, session.id, transcript, sourceMessageId);
    } catch (error) {
      await this.reply(chatId, this.formatManagerError(error));
    }
  }

  private async requireActiveSession(chatId: number): Promise<AsyncSessionRecord | undefined> {
    const session = this.getActiveSession(chatId);
    if (!session) {
      await this.reply(chatId, NO_ACTIVE_SESSION_MESSAGE);
      return undefined;
    }

    return session;
  }

  private async requireActiveOrSingleSession(
    chatId: number,
  ): Promise<AsyncSessionRecord | undefined> {
    const session = this.getActiveOrSingleSession(chatId);
    if (!session) {
      await this.reply(chatId, NO_ACTIVE_SESSION_MESSAGE);
      return undefined;
    }

    return session;
  }

  private async submitSessionMessage(
    chatId: number,
    sessionId: string,
    text: string,
    sourceMessageId?: number,
  ): Promise<void> {
    const textWithAttachments = await this.buildMessageTextWithAttachments(sessionId, text, chatId);
    const sessionManager = this.getSessionManagerForChat(chatId);
    await sessionManager.sendMessage(
      sessionId,
      textWithAttachments,
      this.systemMessage ? { additionalSystemMessage: this.systemMessage } : undefined,
    );
    this.resetPendingAttachmentQueue(sessionId);
    await this.reactToQueuedMessage(chatId, sourceMessageId);
    if (this.isVerboseSession(sessionId)) {
      await this.reply(chatId, this.formatMessageQueued(sessionId));
    }
  }

  private getAttachmentPerFileLimitReason(sizeBytes: number): string | undefined {
    if (sizeBytes <= MAX_TELEGRAM_ATTACHMENT_FILE_BYTES) {
      return undefined;
    }

    return `exceeds per-file limit (${describeAttachmentLimitBytes(MAX_TELEGRAM_ATTACHMENT_FILE_BYTES)})`;
  }

  private getAttachmentTotalLimitReason(
    totalSizeBytes: number,
    nextSizeBytes: number,
  ): string | undefined {
    if (totalSizeBytes + nextSizeBytes <= MAX_TELEGRAM_ATTACHMENT_TOTAL_BYTES) {
      return undefined;
    }

    return `exceeds per-turn total limit (${describeAttachmentLimitBytes(MAX_TELEGRAM_ATTACHMENT_TOTAL_BYTES)})`;
  }

  private async replySkippedAttachment(
    chatId: number,
    attachmentLabel: string,
    reason: string,
  ): Promise<void> {
    await this.reply(chatId, `skipped attachment ${attachmentLabel}: ${reason}`);
  }

  private getActiveSession(chatId: number): AsyncSessionRecord | undefined {
    const sessionId = this.activeSessionsByChat.get(chatId);
    if (!sessionId) {
      return undefined;
    }

    const sessionManager = this.getSessionManagerForChat(chatId);
    const session = sessionManager.getSession(sessionId);
    if (!session) {
      this.clearActiveSession(chatId);
      this.clearSessionAttachments(sessionId);
      return undefined;
    }

    return session;
  }

  private getActiveOrSingleSession(chatId: number): AsyncSessionRecord | undefined {
    const activeSession = this.getActiveSession(chatId);
    if (activeSession) {
      return activeSession;
    }

    const sessionManager = this.getSessionManagerForChat(chatId);
    const sessions = sessionManager.listSessions();
    if (sessions.length !== 1) {
      return undefined;
    }

    const [singleSession] = sessions;
    if (!singleSession) {
      return undefined;
    }

    this.setActiveSession(chatId, singleSession.id);
    return singleSession;
  }

  private setActiveSession(chatId: number, sessionId: string): void {
    this.activeSessionsByChat.set(chatId, sessionId);
    this.linkChatToSession(chatId, sessionId);
  }

  private clearActiveSession(chatId: number): void {
    const sessionId = this.activeSessionsByChat.get(chatId);
    if (!sessionId) {
      return;
    }

    this.activeSessionsByChat.delete(chatId);
    this.unlinkChatFromSession(chatId, sessionId);
  }

  private linkChatToSession(chatId: number, sessionId: string): void {
    const sessions = this.sessionsByChat.get(chatId) ?? new Set<string>();
    sessions.add(sessionId);
    this.sessionsByChat.set(chatId, sessions);

    const chats = this.chatsBySession.get(sessionId) ?? new Set<number>();
    chats.add(chatId);
    this.chatsBySession.set(sessionId, chats);
  }

  private unlinkChatFromSession(chatId: number, sessionId: string): void {
    const sessions = this.sessionsByChat.get(chatId);
    if (sessions) {
      sessions.delete(sessionId);
      if (sessions.size === 0) {
        this.sessionsByChat.delete(chatId);
      }
    }

    const chats = this.chatsBySession.get(sessionId);
    if (!chats) {
      return;
    }

    chats.delete(chatId);
    if (chats.size === 0) {
      this.chatsBySession.delete(sessionId);
    }
  }

  private clearClosedSession(sessionId: string): void {
    for (const [chatId, activeSessionId] of this.activeSessionsByChat) {
      if (activeSessionId === sessionId) {
        this.activeSessionsByChat.delete(chatId);
      }
    }

    const chatIds = Array.from(this.chatsBySession.get(sessionId) ?? []);
    for (const chatId of chatIds) {
      this.unlinkChatFromSession(chatId, sessionId);
    }

    this.sessionVerbosityBySession.delete(sessionId);
    this.lastCommandBySession.delete(sessionId);
    this.lastAssistantMessageBySession.delete(sessionId);
    this.latestAssistantMessageByRun.delete(sessionId);
    this.clearSessionAttachments(sessionId);
  }

  private getSessionVerbosity(sessionId: string): SessionVerbosity {
    return this.sessionVerbosityBySession.get(sessionId) ?? "quiet";
  }

  private isVerboseSession(sessionId: string): boolean {
    return this.getSessionVerbosity(sessionId) === "verbose";
  }

  private onSessionEvent(event: AsyncSessionManagerEvent): void {
    if (event.type === "session-progress") {
      if (!this.chatsBySession.has(event.sessionId)) {
        return;
      }

      this.handleSessionProgress(event);
      return;
    }

    if (event.type !== "session-state-changed") {
      return;
    }

    if (!this.chatsBySession.has(event.sessionId)) {
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
    state: "started" | "finished" | "failed",
  ): void {
    const stateLabel = {
      started: "run started",
      finished: "run finished",
      failed: "run failed",
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

  private async reactToQueuedMessage(chatId: number, messageId?: number): Promise<void> {
    if (!this.api.setMessageReaction) {
      return;
    }

    if (typeof messageId !== "number" || !Number.isInteger(messageId) || messageId <= 0) {
      return;
    }

    await this.wait(MESSAGE_QUEUED_REACTION_DELAY_MS);
    if (this.abortController.signal.aborted) {
      return;
    }

    try {
      await this.api.setMessageReaction(chatId, messageId);
    } catch (error) {
      this.log("warn", "failed to set telegram message reaction", {
        chatId,
        messageId,
        cause: error instanceof Error ? error.message : String(error),
      });
    }
  }

  private async answerCallbackQuery(callbackQueryId?: string, text?: string): Promise<void> {
    if (!this.api.answerCallbackQuery) {
      return;
    }

    const trimmedCallbackQueryId = callbackQueryId?.trim();
    if (!trimmedCallbackQueryId) {
      return;
    }

    try {
      await this.api.answerCallbackQuery(trimmedCallbackQueryId, text);
    } catch (error) {
      this.log("warn", "failed to answer telegram callback query", {
        callbackQueryId: trimmedCallbackQueryId,
        cause: error instanceof Error ? error.message : String(error),
      });
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

  private async reply(
    chatId: number,
    text: string,
    options?: {
      replyMarkup?: TelegramInlineKeyboardMarkup;
    },
  ): Promise<void> {
    const chunks = splitTelegramMessage(text);

    for (const [index, chunk] of chunks.entries()) {
      try {
        await this.api.sendMessage(chatId, chunk, {
          replyMarkup: index === chunks.length - 1 ? options?.replyMarkup : undefined,
        });
      } catch (error) {
        this.log("warn", "failed to send telegram message", {
          chatId,
          cause: error instanceof Error ? error.message : String(error),
        });
        return;
      }

      if (index < chunks.length - 1) {
        await this.wait(TELEGRAM_MESSAGE_SPLIT_DELAY_MS);
      }
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
  await sweepStaleTelegramAttachmentTempDirs();
  const adapter = new AsyncTelegramAdapterImpl(options);

  return {
    close: () => adapter.close(),
  };
}
