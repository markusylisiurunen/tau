import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { z } from "zod";
import type { SessionProtocolSnapshot } from "../../protocol/session_protocol.js";
import type { SpeechToTextProvider, TelegramProjectConfig } from "../config/schema.js";
import { formatAdaptiveNumber, formatTokenWindow } from "../utils/format.js";
import { transcribeAudio } from "../utils/speech_to_text.js";
import {
  collectSpeechToTextContext,
  type SpeechToTextContext,
} from "../utils/speech_to_text_context.js";
import { formatTauUserText, splitTauUserText } from "../utils/user_metadata.js";
import { formatZodError } from "../utils/zod.js";
import {
  createScopedTelegramSessionManager,
  type TelegramSessionManager,
  TelegramSessionManagerError,
  type TelegramSessionManagerEvent,
  type TelegramSessionRecord,
} from "./session_manager.js";

type TelegramChat = {
  id: number;
  type: string;
};

type TelegramUser = {
  id: number;
  first_name?: string;
  last_name?: string;
  username?: string;
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

type TelegramBotInfo = {
  username: string;
};

type TelegramBotCommand = {
  command: string;
  description: string;
};

export type TelegramApi = {
  getMe(): Promise<TelegramBotInfo>;
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
  sendRichMessage(
    chatId: number,
    markdown: string,
    options?: {
      replyMarkup?: TelegramInlineKeyboardMarkup;
    },
  ): Promise<void>;
  sendChatAction(chatId: number, action: string): Promise<void>;
  downloadFile(fileId: string): Promise<Buffer>;
  setCommands(commands: TelegramBotCommand[]): Promise<void>;
  setMessageReaction(chatId: number, messageId: number): Promise<void>;
  answerCallbackQuery(callbackQueryId: string, text?: string): Promise<void>;
};

export type TelegramLogLevel = "info" | "warn" | "error";

export type TelegramLogEntry = {
  level: TelegramLogLevel;
  message: string;
  data?: unknown;
};

export type TelegramAdapterOptions = {
  botId: string;
  botToken: string;
  projects: Record<string, TelegramProjectConfig>;
  defaultProjectId?: string;
  systemMessage?: string;
  allowedUserIds?: number[];
  allowedChatIds?: number[];
  pollIntervalMs?: number;
  requestTimeoutSeconds?: number;
  speechToTextProvider?: SpeechToTextProvider;
  geminiApiKey?: string;
  mistralApiKey?: string;
  sessionManager: TelegramSessionManager;
  api?: TelegramApi;
  fetchImpl?: typeof fetch;
  onLog?: (entry: TelegramLogEntry) => void;
};

export type TelegramAdapterHandle = {
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

type TelegramAttachmentQueueResult = {
  attachments: TelegramMaterializedAttachment[];
  errors: string[];
};

type TelegramAudioTranscriptionResult = {
  transcript?: string;
  error?: string;
};

type TelegramGroupPendingMessage = {
  sender: string;
  text?: string;
  audioTranscript?: string;
  attachments?: TelegramMaterializedAttachment[];
  errors?: string[];
};

type ResolvedTelegramAdapterOptions = TelegramAdapterOptions & {
  api: TelegramApi;
  botUsername: string;
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
const TELEGRAM_MAX_RICH_MESSAGE_BYTES = 32 * 1024;

const TELEGRAM_MESSAGE_BYTE_BUFFER_RATIO = 0.95;
const TELEGRAM_SAFE_MESSAGE_BYTES = Math.floor(
  TELEGRAM_MAX_MESSAGE_BYTES * TELEGRAM_MESSAGE_BYTE_BUFFER_RATIO,
);
const TELEGRAM_RICH_MESSAGE_SAFE_BYTES = Math.floor(
  TELEGRAM_MAX_RICH_MESSAGE_BYTES * TELEGRAM_MESSAGE_BYTE_BUFFER_RATIO,
);
const TELEGRAM_MESSAGE_SPLIT_DELAY_MS = 1000;
const TELEGRAM_TYPING_REFRESH_MS = 4000;
const ABORTED = Symbol("aborted");
const CALLBACK_ACTION_PREFIX = "tau:action:";
const MAX_TELEGRAM_ATTACHMENTS_PER_TURN = 10;
const MAX_TELEGRAM_ATTACHMENT_FILE_BYTES = 20 * 1024 * 1024;
const MAX_TELEGRAM_ATTACHMENT_TOTAL_BYTES = 50 * 1024 * 1024;
const MAX_TELEGRAM_GROUP_PENDING_MESSAGES = 50;
const TELEGRAM_ATTACHMENT_TEMP_DIR_PREFIX = "tau-telegram-attachments-";
const NO_ACTIVE_SESSION_MESSAGE = "no active session. use /new.";

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

type QuickAction = "new" | "status" | "interrupt";

type TelegramCommandHandler = (
  chatId: number,
  args: string[],
  sourceMessageId?: number,
) => Promise<void>;

type TelegramCommandDefinition = {
  command: `/${string}`;
  description: string;
  usage: string;
  callbackAction?: QuickAction;
  handler: TelegramCommandHandler;
};

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

function normalizeTelegramUsername(username: string): string {
  return username.trim().replace(/^@+/, "").toLowerCase();
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function hasTelegramMention(text: string, username: string): boolean {
  const normalizedUsername = normalizeTelegramUsername(username);
  if (!normalizedUsername) {
    return false;
  }

  const mentionPattern = new RegExp(
    `(^|[^A-Za-z0-9_])@${escapeRegExp(normalizedUsername)}(?=$|[^A-Za-z0-9_])`,
    "i",
  );
  return mentionPattern.test(text);
}

function stripTelegramMention(text: string, username: string): string {
  const normalizedUsername = normalizeTelegramUsername(username);
  if (!normalizedUsername) {
    return text.trim();
  }

  const mentionPattern = new RegExp(
    `(^|[^A-Za-z0-9_])@${escapeRegExp(normalizedUsername)}(?=$|[^A-Za-z0-9_])`,
    "gi",
  );
  return text
    .replace(mentionPattern, (_match, prefix: string) => prefix)
    .replace(/\s+/g, " ")
    .trim();
}

function getCommandMention(command: string): string | undefined {
  if (!command.startsWith("/")) {
    return undefined;
  }

  const mentionIndex = command.indexOf("@");
  if (mentionIndex === -1) {
    return undefined;
  }

  const mention = normalizeTelegramUsername(command.slice(mentionIndex + 1));
  return mention || undefined;
}

function isTelegramMentionToken(part: string, username: string): boolean {
  return normalizeTelegramUsername(part) === username;
}

function getMentionedGroupCommandText(text: string, username: string): string | undefined {
  const parts = splitCommandText(text);
  const first = parts[0];
  if (!first) {
    return undefined;
  }

  if (first.startsWith("/")) {
    const commandMention = getCommandMention(first);
    if (commandMention && commandMention !== username) {
      return undefined;
    }

    const mentionIndex = parts.findIndex((part) => isTelegramMentionToken(part, username));
    if (commandMention === username || mentionIndex !== -1) {
      return parts.filter((_part, index) => index !== mentionIndex).join(" ");
    }

    return undefined;
  }

  if (!isTelegramMentionToken(first, username)) {
    return undefined;
  }

  const command = parts[1];
  if (!command?.startsWith("/")) {
    return undefined;
  }

  const commandMention = getCommandMention(command);
  if (commandMention && commandMention !== username) {
    return undefined;
  }

  return parts.slice(1).join(" ");
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

function splitTelegramTextByBytes(text: string, maxBytes: number): string[] {
  if (Buffer.byteLength(text, "utf8") <= maxBytes) {
    return [text];
  }

  const chunks: string[] = [];
  let currentChunk = "";

  for (const character of text) {
    const nextChunk = `${currentChunk}${character}`;
    if (Buffer.byteLength(nextChunk, "utf8") <= maxBytes) {
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

function splitTelegramMessage(text: string): string[] {
  return splitTelegramTextByBytes(text, TELEGRAM_SAFE_MESSAGE_BYTES);
}

function splitTelegramRichMessage(text: string): string[] {
  return splitTelegramTextByBytes(text, TELEGRAM_RICH_MESSAGE_SAFE_BYTES);
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

function formatTelegramSender(user: TelegramUser | undefined): string {
  if (!user) {
    return "unknown sender";
  }

  const firstName = user.first_name?.trim() ?? "";
  const lastName = user.last_name?.trim() ?? "";
  const fullName = [firstName, lastName].filter(Boolean).join(" ");
  const username = user.username?.trim().replace(/^@+/, "");
  const usernameLabel = username ? `@${username}` : undefined;

  if (fullName && usernameLabel) {
    return `${fullName} (${usernameLabel}, id ${user.id})`;
  }

  if (fullName) {
    return `${fullName} (id ${user.id})`;
  }

  if (usernameLabel) {
    return `${usernameLabel} (id ${user.id})`;
  }

  return `id ${user.id}`;
}

function formatTelegramSessionName(
  session: Pick<TelegramSessionRecord, "id" | "projectId">,
): string {
  return `${session.projectId} session ${session.id}`;
}

function formatSessionStatus(
  session: TelegramSessionRecord,
  snapshot?: SessionProtocolSnapshot,
): string {
  const sessionName = formatTelegramSessionName(session);
  if (session.state === "failed" && session.error) {
    return `your ${sessionName} failed. ${ensureTerminalPunctuation(session.error)}`;
  }

  const status = `your ${sessionName} is ${session.state}.`;
  if (!snapshot) {
    return status;
  }

  const model = snapshot.bootstrap.model.name || snapshot.bootstrap.model.id;
  const reasoning = snapshot.settings.reasoning ?? "none";
  const context = formatTelegramContextUsage(snapshot);
  const cost = formatTelegramSessionCost(getTelegramSessionCostTotal(snapshot));
  return `${status} it is using ${model} with ${reasoning} reasoning. context usage is ${context}. cumulative cost is ${cost}.`;
}

function ensureTerminalPunctuation(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) {
    return ".";
  }

  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

function formatTelegramContextUsage(snapshot: SessionProtocolSnapshot): string {
  const lastAssistantMessage = getLastAssistantMessage(snapshot);
  const usageTokens = getAssistantContextWindowUsage(lastAssistantMessage);
  const windowTokens =
    getAssistantContextWindow(lastAssistantMessage) || snapshot.bootstrap.model.contextWindow;
  const percent = windowTokens > 0 ? (usageTokens / windowTokens) * 100 : 0;
  return `${formatAdaptiveNumber(percent, 1, 3)}% of ${formatTokenWindow(windowTokens)} tokens`;
}

function getTelegramSessionCostTotal(snapshot: SessionProtocolSnapshot): number {
  return snapshot.costTotal;
}

function formatTelegramSessionCost(total: number): string {
  return `$${formatAdaptiveNumber(total, 2, 5)}`;
}

function getLastAssistantMessage(snapshot: SessionProtocolSnapshot): AssistantMessage | undefined {
  for (let index = snapshot.messages.length - 1; index >= 0; index -= 1) {
    const message = snapshot.messages[index];
    if (message?.state === "committed" && isAssistantMessage(message.message)) {
      return message.message;
    }
  }
  return undefined;
}

function getAssistantContextWindowUsage(message: AssistantMessage | undefined): number {
  if (!message?.usage) {
    return 0;
  }

  const usage = message.usage as AssistantMessage["usage"] & {
    contextWindowUsageTokens?: unknown;
  };
  if (
    typeof usage.contextWindowUsageTokens === "number" &&
    Number.isFinite(usage.contextWindowUsageTokens)
  ) {
    return usage.contextWindowUsageTokens;
  }

  return (
    (message.usage.input ?? 0) +
    (message.usage.cacheRead ?? 0) +
    (message.usage.cacheWrite ?? 0) +
    (message.usage.output ?? 0)
  );
}

function getAssistantContextWindow(message: AssistantMessage | undefined): number {
  const usage = message?.usage as
    | (AssistantMessage["usage"] & {
        contextWindow?: unknown;
      })
    | undefined;
  return typeof usage?.contextWindow === "number" && Number.isFinite(usage.contextWindow)
    ? usage.contextWindow
    : 0;
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
const TelegramUserSchema = telegramPartialObject({
  id: z.number(),
  first_name: z.string(),
  last_name: z.string(),
  username: z.string(),
}).required({ id: true });
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
const TelegramGetMeResultSchema = telegramObject({ username: z.string() });
const TelegramAckResultSchema = z.literal(true);

function createTelegramApi(botToken: string): TelegramApi {
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
    async getMe() {
      return callTelegramMethod("getMe", {}, TelegramGetMeResultSchema);
    },
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
    async sendRichMessage(chatId, markdown, options) {
      await callTelegramMethod(
        "sendRichMessage",
        {
          chat_id: chatId,
          rich_message: {
            markdown,
          },
          ...(options?.replyMarkup ? { reply_markup: options.replyMarkup } : {}),
        },
        z.unknown(),
      );
    },
    async sendChatAction(chatId, action) {
      await callTelegramMethod(
        "sendChatAction",
        {
          chat_id: chatId,
          action,
        },
        TelegramAckResultSchema,
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

class TelegramAdapterImpl {
  private readonly projects: Record<string, TelegramProjectConfig>;
  private readonly defaultProjectId?: string;
  private readonly systemMessage?: string;
  private readonly allowedUserIds?: Set<number>;
  private readonly allowedChatIds?: Set<number>;
  private readonly botUsername: string;
  private readonly pollIntervalMs: number;
  private readonly requestTimeoutSeconds: number;
  private readonly speechToTextProvider: SpeechToTextProvider;
  private readonly geminiApiKey?: string;
  private readonly mistralApiKey?: string;
  private readonly sessionManager: TelegramSessionManager;
  private readonly enforceChatOwnership: boolean;
  private readonly botOwnerPrefix: string;
  private readonly allowedProjectIds: string[];
  private readonly api: TelegramApi;
  private readonly fetchImpl?: typeof fetch;
  private readonly onLog?: (entry: TelegramLogEntry) => void;
  private readonly commandDefinitions: TelegramCommandDefinition[];
  private readonly commandHandlers: Map<string, TelegramCommandHandler>;
  private readonly callbackActionHandlers: Map<QuickAction, TelegramCommandHandler>;
  private readonly abortController = new AbortController();
  private readonly activeSessionsByChat = new Map<number, string>();
  private readonly sessionsByChat = new Map<number, Set<string>>();
  private readonly chatsBySession = new Map<string, Set<number>>();
  private readonly chatTypesByChat = new Map<number, string>();
  private readonly typingIntervalsBySessionChat = new Map<string, ReturnType<typeof setInterval>>();
  private readonly lastCommandBySession = new Map<string, string>();
  private readonly pendingAttachmentsBySession = new Map<string, TelegramPendingAttachment[]>();
  private readonly pendingGroupMessagesByChat = new Map<number, TelegramGroupPendingMessage[]>();
  private readonly pendingAttachmentTempDirBySession = new Map<string, string>();
  private readonly attachmentTempDirsBySession = new Map<string, Set<string>>();
  private readonly updateQueueTailByKey = new Map<string, Promise<void>>();
  private readonly inFlightUpdateTasks = new Set<Promise<void>>();

  private readonly unsubscribeSessionEvents: () => void;
  private readonly loopPromise: Promise<void>;

  private nextUpdateOffset = 0;
  private closed = false;

  constructor(options: ResolvedTelegramAdapterOptions) {
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
    this.botUsername = options.botUsername;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.requestTimeoutSeconds = options.requestTimeoutSeconds ?? DEFAULT_REQUEST_TIMEOUT_SECONDS;
    this.speechToTextProvider = options.speechToTextProvider ?? "mistral";
    this.geminiApiKey = options.geminiApiKey?.trim() || undefined;
    this.mistralApiKey = options.mistralApiKey?.trim() || undefined;
    this.sessionManager = options.sessionManager;
    this.enforceChatOwnership = true;
    this.botOwnerPrefix = `telegram:${botId}`;
    this.allowedProjectIds = Object.keys(options.projects);
    this.api = options.api;
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

      for (const sessionId of Array.from(this.chatsBySession.keys())) {
        this.stopTypingIndicators(sessionId);
      }

      for (const sessionId of Array.from(this.attachmentTempDirsBySession.keys())) {
        await this.cleanupSessionAttachmentTempDirs(sessionId);
      }
      this.pendingAttachmentsBySession.clear();
      this.pendingAttachmentTempDirBySession.clear();
    } finally {
      this.log("info", "telegram adapter stopped");
    }
  }

  private log(level: TelegramLogLevel, message: string, data?: unknown): void {
    this.onLog?.({ level, message, ...(data === undefined ? {} : { data }) });
  }

  private createCommandDefinitions(): TelegramCommandDefinition[] {
    return [
      {
        command: "/new",
        description: "start a new session",
        usage: "/new",
        callbackAction: "new",
        handler: async (chatId, args, sourceMessageId) =>
          this.handleNew(chatId, args, sourceMessageId),
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
    ];
  }

  private async syncCommands(): Promise<void> {
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
      await this.handleMessageUpdate(message);
      return;
    }

    const callbackQuery = update.callback_query;
    if (callbackQuery) {
      await this.handleCallbackQueryUpdate(callbackQuery);
    }
  }

  private async handleMessageUpdate(message: TelegramMessage): Promise<void> {
    const chat = message.chat;
    if (!chat) {
      return;
    }

    this.chatTypesByChat.set(chat.id, chat.type);

    if (chat.type === "private") {
      await this.handlePrivateMessage(chat.id, message);
      return;
    }

    if (chat.type === "group" || chat.type === "supergroup") {
      await this.handleGroupMessage(chat.id, message);
    }
  }

  private async handlePrivateMessage(chatId: number, message: TelegramMessage): Promise<void> {
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
        await this.handleCommand(chatId, text, message.message_id);
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
  }

  private async handleGroupMessage(chatId: number, message: TelegramMessage): Promise<void> {
    if (!this.isGroupChatAllowed(chatId)) {
      return;
    }

    const text = typeof message.text === "string" ? message.text.trim() : "";
    const caption = typeof message.caption === "string" ? message.caption.trim() : "";
    const contentText = text || caption;

    const groupCommandText = getMentionedGroupCommandText(text, this.botUsername);
    if (groupCommandText) {
      if (!this.isUserAllowed(message.from?.id)) {
        return;
      }

      await this.handleCommand(chatId, groupCommandText, message.message_id);
      return;
    }

    if (text.startsWith("/")) {
      this.bufferGroupMessage(chatId, message, text);
      return;
    }

    const attachmentResult = await this.queueMessageAttachments(chatId, message, { silent: true });
    const audioMessage = this.parseAudioMessage(message);
    const audioResult: TelegramAudioTranscriptionResult = audioMessage
      ? await this.transcribeTelegramAudio(chatId, audioMessage, { silent: true })
      : {};
    const errors = [...attachmentResult.errors, ...(audioResult.error ? [audioResult.error] : [])];

    if (!contentText && !audioResult.transcript && errors.length === 0) {
      this.bufferGroupMessage(
        chatId,
        message,
        undefined,
        undefined,
        attachmentResult.attachments,
        errors,
      );
      return;
    }

    if (!hasTelegramMention(contentText, this.botUsername)) {
      this.bufferGroupMessage(
        chatId,
        message,
        contentText,
        audioResult.transcript,
        attachmentResult.attachments,
        errors,
      );
      return;
    }

    if (!this.isUserAllowed(message.from?.id)) {
      this.bufferGroupMessage(
        chatId,
        message,
        contentText,
        audioResult.transcript,
        attachmentResult.attachments,
        errors,
      );
      return;
    }

    const triggerText = stripTelegramMention(contentText, this.botUsername);
    await this.handleGroupTriggeredMessage(
      chatId,
      message,
      triggerText,
      message.message_id,
      attachmentResult.attachments,
      audioResult.transcript,
      errors,
    );
  }

  private async handleCallbackQueryUpdate(callbackQuery: TelegramCallbackQuery): Promise<void> {
    const chat = callbackQuery.message?.chat;
    if (!chat) {
      await this.answerCallbackQuery(callbackQuery.id);
      return;
    }

    const isAllowedChat =
      chat.type === "private"
        ? this.isChatAllowed(chat.id)
        : (chat.type === "group" || chat.type === "supergroup") && this.isGroupChatAllowed(chat.id);
    if (!isAllowedChat) {
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

    const callbackHandled = await this.handleCallback(chat.id, callbackData);
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

  private async queueMessageAttachments(
    chatId: number,
    message: TelegramMessage,
    options: { silent?: boolean } = {},
  ): Promise<TelegramAttachmentQueueResult> {
    const result: TelegramAttachmentQueueResult = { attachments: [], errors: [] };
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
        const errorMessage = `skipped attachment ${describeAttachment(fileName, mimeType)}: unsupported file type`;
        if (options.silent) {
          result.errors.push(errorMessage);
        } else {
          await this.reply(chatId, errorMessage);
        }
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
      return result;
    }

    const session = options.silent
      ? this.getActiveOrSingleSession(chatId)
      : await this.requireActiveOrSingleSession(chatId);
    if (!session) {
      if (options.silent) {
        result.errors.push(NO_ACTIVE_SESSION_MESSAGE);
      }
      return result;
    }

    const pending = this.pendingAttachmentsBySession.get(session.id) ?? [];
    let totalSizeBytes = pending.reduce((total, attachment) => {
      return total + (attachment.materialized?.sizeBytes ?? attachment.declaredSizeBytes ?? 0);
    }, 0);

    for (const attachment of parsedAttachments) {
      const attachmentLabel = describeAttachment(attachment.fileName, attachment.mimeType);
      if (pending.length >= MAX_TELEGRAM_ATTACHMENTS_PER_TURN) {
        const reason = `exceeds attachment limit (${MAX_TELEGRAM_ATTACHMENTS_PER_TURN} files per turn)`;
        if (options.silent) {
          result.errors.push(`skipped attachment ${attachmentLabel}: ${reason}`);
        } else {
          await this.replySkippedAttachment(chatId, attachmentLabel, reason);
        }
        continue;
      }

      const declaredFileLimitReason =
        typeof attachment.sizeBytes === "number"
          ? this.getAttachmentPerFileLimitReason(attachment.sizeBytes)
          : undefined;
      if (declaredFileLimitReason) {
        if (options.silent) {
          result.errors.push(`skipped attachment ${attachmentLabel}: ${declaredFileLimitReason}`);
        } else {
          await this.replySkippedAttachment(chatId, attachmentLabel, declaredFileLimitReason);
        }
        continue;
      }

      const declaredTotalLimitReason =
        typeof attachment.sizeBytes === "number"
          ? this.getAttachmentTotalLimitReason(totalSizeBytes, attachment.sizeBytes)
          : undefined;
      if (declaredTotalLimitReason) {
        if (options.silent) {
          result.errors.push(`skipped attachment ${attachmentLabel}: ${declaredTotalLimitReason}`);
        } else {
          await this.replySkippedAttachment(chatId, attachmentLabel, declaredTotalLimitReason);
        }
        continue;
      }

      let bytes: Buffer;
      try {
        bytes = await this.api.downloadFile(attachment.fileId);
      } catch (error) {
        const errorMessage = `failed to download attachment ${attachmentLabel}: ${this.formatManagerError(error)}`;
        if (options.silent) {
          result.errors.push(errorMessage);
        } else {
          await this.reply(chatId, errorMessage);
        }
        continue;
      }

      const sizeBytes = bytes.byteLength;
      const fileLimitReason = this.getAttachmentPerFileLimitReason(sizeBytes);
      if (fileLimitReason) {
        if (options.silent) {
          result.errors.push(`skipped attachment ${attachmentLabel}: ${fileLimitReason}`);
        } else {
          await this.replySkippedAttachment(chatId, attachmentLabel, fileLimitReason);
        }
        continue;
      }

      const totalLimitReason = this.getAttachmentTotalLimitReason(totalSizeBytes, sizeBytes);
      if (totalLimitReason) {
        if (options.silent) {
          result.errors.push(`skipped attachment ${attachmentLabel}: ${totalLimitReason}`);
        } else {
          await this.replySkippedAttachment(chatId, attachmentLabel, totalLimitReason);
        }
        continue;
      }

      const tempDirPath = await this.getOrCreatePendingAttachmentTempDir(session.id);
      const indexedFileName = `${String(pending.length + 1).padStart(2, "0")}-${attachment.fileName}`;
      const filePath = join(tempDirPath, indexedFileName);

      try {
        await writeFile(filePath, bytes);
      } catch (error) {
        const errorMessage = `failed to materialize attachment ${attachmentLabel}: ${this.formatManagerError(error)}`;
        if (options.silent) {
          result.errors.push(errorMessage);
        } else {
          await this.reply(chatId, errorMessage);
        }
        continue;
      }

      const materializedAttachment: TelegramMaterializedAttachment = {
        path: filePath,
        mimeType: attachment.mimeType,
        sizeBytes,
        ...(attachment.caption ? { caption: attachment.caption } : {}),
      };
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
      result.attachments.push(materializedAttachment);

      totalSizeBytes += sizeBytes;
    }

    if (pending.length > 0) {
      this.pendingAttachmentsBySession.set(session.id, pending);
    }

    return result;
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

    const attachmentBlock = this.formatAttachmentBlock(attachments);
    const split = splitTauUserText(text);
    if (split.hiddenSystemBlocks.length > 0 || split.metadata.length > 0) {
      return formatTauUserText({
        text: [attachmentBlock, split.displayText].filter(Boolean).join("\n\n"),
        metadata: split.metadata,
        hiddenSystemMessages: split.hiddenSystemBlocks.map((block) => block.text),
      });
    }

    return [attachmentBlock, text].join("\n\n");
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

  private isGroupChatAllowed(chatId: number): boolean {
    return this.allowedChatIds?.has(chatId) ?? false;
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

  private getSessionManagerForChat(chatId: number): TelegramSessionManager {
    if (!this.enforceChatOwnership) {
      return this.sessionManager;
    }

    return createScopedTelegramSessionManager({
      sessionManager: this.sessionManager,
      ownerId: this.ownerIdForChat(chatId),
      allowedProjectIds: this.allowedProjectIds,
    });
  }

  private async handleCommand(
    chatId: number,
    text: string,
    sourceMessageId?: number,
  ): Promise<void> {
    const parts = splitCommandText(text);
    const command = stripCommandMention(parts[0] ?? "");
    const args = parts.slice(1);
    const handler = this.commandHandlers.get(command);

    if (!handler) {
      await this.reply(
        chatId,
        "unsupported command. supported commands: /new, /status, /interrupt",
      );
      return;
    }

    await handler(chatId, args, sourceMessageId);
  }

  private async handleCallback(chatId: number, callbackData: string): Promise<boolean> {
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

  private resolveNewCommand(args: string[]): NewCommandResolution {
    if (args.length > 0) {
      return { error: "usage: /new" };
    }

    const projectIds = Object.keys(this.projects);
    if (this.defaultProjectId) {
      if (!this.projects[this.defaultProjectId]) {
        return {
          error: `telegram.<botId>.defaultProjectId '${this.defaultProjectId}' is not configured`,
        };
      }
      return { projectId: this.defaultProjectId };
    }

    if (projectIds.length === 1) {
      return { projectId: projectIds[0]! };
    }

    if (projectIds.length === 0) {
      return { error: "no telegram projects configured" };
    }

    return {
      error: "multiple projects configured. set defaultProjectId for this bot before using /new",
    };
  }

  private async handleNew(chatId: number, args: string[], sourceMessageId?: number): Promise<void> {
    const parsed = this.resolveNewCommand(args);
    if ("error" in parsed) {
      await this.reply(chatId, parsed.error);
      return;
    }

    try {
      const sessionManager = this.getSessionManagerForChat(chatId);
      const previousSession = this.getActiveSession(chatId);
      if (previousSession) {
        await sessionManager.closeSession(previousSession.id);
        this.clearClosedSession(previousSession.id);
      }

      const session = await sessionManager.createSession({
        projectId: parsed.projectId,
      });

      this.setActiveSession(chatId, session.id);
      void this.reactToQueuedMessage(chatId, sourceMessageId);
    } catch (error) {
      await this.reply(chatId, this.formatManagerError(error));
    }
  }

  private async handleStatus(chatId: number): Promise<void> {
    const session = await this.requireActiveSession(chatId);
    if (!session) {
      return;
    }

    const sessionManager = this.getSessionManagerForChat(chatId);
    let snapshot: SessionProtocolSnapshot | undefined;
    try {
      snapshot = await sessionManager.getSessionSnapshot(session.id);
    } catch {
      snapshot = undefined;
    }

    await this.reply(chatId, formatSessionStatus(session, snapshot));
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
        await this.reply(
          chatId,
          `nothing is running in ${formatTelegramSessionName(result.session)}.`,
        );
        return;
      }

      await this.reply(chatId, `stopping ${formatTelegramSessionName(result.session)}.`);
    } catch (error) {
      await this.reply(chatId, this.formatManagerError(error));
    }
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

  private async handleGroupTriggeredMessage(
    chatId: number,
    message: TelegramMessage,
    triggerText: string,
    sourceMessageId?: number,
    attachments: TelegramMaterializedAttachment[] = [],
    audioTranscript?: string,
    errors: string[] = [],
  ): Promise<void> {
    const session = await this.requireActiveOrSingleSession(chatId);
    if (!session) {
      return;
    }

    try {
      const text = this.formatGroupTurnText(
        chatId,
        message,
        triggerText,
        attachments,
        audioTranscript,
        errors,
      );
      const processingErrors = this.collectGroupProcessingErrors(chatId, errors);
      await this.submitSessionMessage(chatId, session.id, text, sourceMessageId, {
        includePendingAttachments: false,
      });
      this.pendingGroupMessagesByChat.delete(chatId);
      await this.notifyGroupProcessingErrors(chatId, processingErrors);
    } catch (error) {
      await this.reply(chatId, this.formatManagerError(error));
    }
  }

  private bufferGroupMessage(
    chatId: number,
    message: TelegramMessage,
    text?: string,
    audioTranscript?: string,
    attachments: TelegramMaterializedAttachment[] = [],
    errors: string[] = [],
  ): void {
    const trimmedText = text?.trim();
    const trimmedAudioTranscript = audioTranscript?.trim();
    if (
      !trimmedText &&
      !trimmedAudioTranscript &&
      attachments.length === 0 &&
      errors.length === 0
    ) {
      return;
    }

    const pending = this.pendingGroupMessagesByChat.get(chatId) ?? [];
    pending.push({
      sender: formatTelegramSender(message.from),
      ...(trimmedText ? { text: trimmedText } : {}),
      ...(trimmedAudioTranscript ? { audioTranscript: trimmedAudioTranscript } : {}),
      ...(attachments.length > 0 ? { attachments } : {}),
      ...(errors.length > 0 ? { errors } : {}),
    });

    if (pending.length > MAX_TELEGRAM_GROUP_PENDING_MESSAGES) {
      pending.splice(0, pending.length - MAX_TELEGRAM_GROUP_PENDING_MESSAGES);
    }

    this.pendingGroupMessagesByChat.set(chatId, pending);
  }

  private collectGroupProcessingErrors(chatId: number, triggerErrors: string[]): string[] {
    const pending = this.pendingGroupMessagesByChat.get(chatId) ?? [];
    return [...pending.flatMap((message) => message.errors ?? []), ...triggerErrors];
  }

  private async notifyGroupProcessingErrors(chatId: number, errors: string[]): Promise<void> {
    if (errors.length === 0) {
      return;
    }

    const visibleErrors = errors.slice(0, 5).map((error) => `- ${truncateText(error, 160)}`);
    if (errors.length > visibleErrors.length) {
      visibleErrors.push(`- and ${errors.length - visibleErrors.length} more`);
    }

    await this.reply(
      chatId,
      ["some Telegram group context could not be processed:", ...visibleErrors].join("\n"),
    );
  }

  private formatGroupTurnText(
    chatId: number,
    message: TelegramMessage,
    triggerText: string,
    triggerAttachments: TelegramMaterializedAttachment[] = [],
    triggerAudioTranscript?: string,
    triggerErrors: string[] = [],
  ): string {
    const pending = this.pendingGroupMessagesByChat.get(chatId) ?? [];
    const system =
      pending.length > 0
        ? "This message came from a Telegram group chat. The <telegram-group-context> block contains recent non-triggering group messages, attachments, audio transcripts, and processing errors since the previous bot-triggering turn. Use it as background context only. The <telegram-trigger-message> block is the message that explicitly mentioned the bot and triggered this turn. Respond to the trigger message."
        : "This message came from a Telegram group chat. The <telegram-trigger-message> block is the message that explicitly mentioned the bot and triggered this turn. Respond to the trigger message.";
    const lines: string[] = [];

    if (pending.length > 0) {
      lines.push("<telegram-group-context>");
      for (const [index, pendingMessage] of pending.entries()) {
        lines.push(`${index + 1}. sender: ${pendingMessage.sender}`);
        if (pendingMessage.text) {
          lines.push(`   text: ${JSON.stringify(pendingMessage.text)}`);
        }
        if (pendingMessage.audioTranscript) {
          lines.push(`   audio_transcript: ${JSON.stringify(pendingMessage.audioTranscript)}`);
        }
        this.pushIndentedErrorLines(lines, pendingMessage.errors, "   ");
        this.pushIndentedAttachmentLines(lines, pendingMessage.attachments, "   ");
      }
      lines.push("</telegram-group-context>");
      lines.push("");
    }

    lines.push("<telegram-trigger-message>");
    lines.push(`sender: ${formatTelegramSender(message.from)}`);
    lines.push(`text: ${JSON.stringify(triggerText)}`);
    if (triggerAudioTranscript) {
      lines.push(`audio_transcript: ${JSON.stringify(triggerAudioTranscript)}`);
    }
    this.pushIndentedErrorLines(lines, triggerErrors, "");
    this.pushIndentedAttachmentLines(lines, triggerAttachments, "");
    lines.push("</telegram-trigger-message>");

    return formatTauUserText({ text: lines.join("\n"), hiddenSystemMessages: [system] });
  }

  private pushIndentedErrorLines(
    lines: string[],
    errors: string[] | undefined,
    indent: string,
  ): void {
    if (!errors || errors.length === 0) {
      return;
    }

    lines.push(`${indent}errors:`);
    for (const error of errors) {
      lines.push(`${indent}- ${JSON.stringify(error)}`);
    }
  }

  private pushIndentedAttachmentLines(
    lines: string[],
    attachments: TelegramMaterializedAttachment[] | undefined,
    indent: string,
  ): void {
    if (!attachments || attachments.length === 0) {
      return;
    }

    lines.push(`${indent}attachments:`);
    for (const attachment of attachments) {
      lines.push(`${indent}- path: ${attachment.path}`);
      lines.push(`${indent}  mime: ${attachment.mimeType}`);
      lines.push(`${indent}  size_bytes: ${attachment.sizeBytes}`);
      if (attachment.caption) {
        lines.push(`${indent}  caption: ${JSON.stringify(attachment.caption)}`);
      }
    }
  }

  private async resolveSpeechToTextContext(
    chatId: number,
  ): Promise<SpeechToTextContext | undefined> {
    const session = this.getActiveSession(chatId);
    if (!session) {
      return undefined;
    }

    try {
      const snapshot = await this.getSessionManagerForChat(chatId).getSessionSnapshot(session.id);
      return snapshot ? collectSpeechToTextContext(snapshot) : undefined;
    } catch {
      return undefined;
    }
  }

  private getSpeechToTextApiKey(): string | undefined {
    return this.speechToTextProvider === "gemini" ? this.geminiApiKey : this.mistralApiKey;
  }

  private getSpeechToTextApiKeyErrorMessage(action: string): string {
    return this.speechToTextProvider === "gemini"
      ? `set GEMINI_API_KEY or apiKeys.google to ${action}`
      : `set MISTRAL_API_KEY or apiKeys.mistral to ${action}`;
  }

  private async transcribeTelegramAudio(
    chatId: number,
    message: TelegramAudioMessage,
    options: { silent?: boolean } = {},
  ): Promise<TelegramAudioTranscriptionResult> {
    const apiKey = this.getSpeechToTextApiKey();
    if (!apiKey) {
      const error = this.getSpeechToTextApiKeyErrorMessage("transcribe Telegram audio");
      if (!options.silent) {
        await this.reply(chatId, error);
      }
      return { error };
    }

    let transcript = "";
    try {
      const audio = await this.api.downloadFile(message.fileId);
      transcript = (
        await transcribeAudio({
          provider: this.speechToTextProvider,
          apiKey,
          audio,
          fileName: message.fileName,
          mimeType: message.mimeType,
          context: await this.resolveSpeechToTextContext(chatId),
          fetchImpl: this.fetchImpl,
        })
      ).trim();
    } catch (error) {
      const errorMessage = `audio transcription failed: ${this.formatManagerError(error)}`;
      if (!options.silent) {
        await this.reply(chatId, errorMessage);
      }
      return { error: errorMessage };
    }

    if (!transcript) {
      const error = "audio transcription failed: transcription result was empty";
      if (!options.silent) {
        await this.reply(chatId, error);
      }
      return { error };
    }

    return { transcript };
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

    const result = await this.transcribeTelegramAudio(chatId, message);
    if (!result.transcript) {
      return;
    }

    try {
      await this.submitSessionMessage(chatId, session.id, result.transcript, sourceMessageId);
    } catch (error) {
      await this.reply(chatId, this.formatManagerError(error));
    }
  }

  private async requireActiveSession(chatId: number): Promise<TelegramSessionRecord | undefined> {
    const session = this.getActiveSession(chatId);
    if (!session) {
      await this.reply(chatId, NO_ACTIVE_SESSION_MESSAGE);
      return undefined;
    }

    return session;
  }

  private async requireActiveOrSingleSession(
    chatId: number,
  ): Promise<TelegramSessionRecord | undefined> {
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
    options: { includePendingAttachments?: boolean } = {},
  ): Promise<void> {
    const textWithAttachments =
      options.includePendingAttachments === false
        ? text
        : await this.buildMessageTextWithAttachments(sessionId, text, chatId);
    const sessionManager = this.getSessionManagerForChat(chatId);
    await sessionManager.sendMessage(sessionId, textWithAttachments, {
      mode: "steer",
      ...(this.systemMessage ? { additionalSystemMessage: this.systemMessage } : {}),
    });
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

  private getActiveSession(chatId: number): TelegramSessionRecord | undefined {
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

  private getActiveOrSingleSession(chatId: number): TelegramSessionRecord | undefined {
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
    this.stopTypingIndicators(sessionId);
    for (const [chatId, activeSessionId] of this.activeSessionsByChat) {
      if (activeSessionId === sessionId) {
        this.activeSessionsByChat.delete(chatId);
      }
    }

    const chatIds = Array.from(this.chatsBySession.get(sessionId) ?? []);
    for (const chatId of chatIds) {
      this.unlinkChatFromSession(chatId, sessionId);
    }

    this.lastCommandBySession.delete(sessionId);
    this.clearSessionAttachments(sessionId);
  }

  private isVerboseSession(_sessionId: string): boolean {
    return false;
  }

  private onSessionEvent(event: TelegramSessionManagerEvent): void {
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
      this.startTypingIndicators(event.sessionId);
      if (this.isVerboseSession(event.sessionId)) {
        this.notifyLifecycle(event.sessionId, event.projectId, "started");
      }
      return;
    }

    if (event.state === "failed") {
      this.stopTypingIndicators(event.sessionId);
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
      this.stopTypingIndicators(event.sessionId);
      if (this.isVerboseSession(event.sessionId)) {
        this.notifyLifecycle(event.sessionId, event.projectId, "finished");
      }
    }
  }

  private handleSessionProgress(
    event: Extract<TelegramSessionManagerEvent, { type: "session-progress" }>,
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

    this.notifySession(
      event.sessionId,
      isVerbose
        ? [formatSessionHeadline(event.sessionId, "assistant message"), event.progress.text].join(
            "\n",
          )
        : event.progress.text,
      { rich: true },
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

    if (state === "failed") {
      this.notifySession(sessionId, `something went wrong in ${projectId} session ${sessionId}.`);
      return;
    }

    this.notifySession(
      sessionId,
      [formatSessionHeadline(sessionId, stateLabel), `project: ${projectId}`].join("\n"),
    );
  }

  private notifySession(sessionId: string, text: string, options: { rich?: boolean } = {}): void {
    const chatIds = this.chatsBySession.get(sessionId);
    if (!chatIds || chatIds.size === 0) {
      return;
    }

    for (const chatId of chatIds) {
      void this.reply(chatId, text, { rich: options.rich }).catch((error) => {
        this.log("warn", "failed to send telegram notification", {
          chatId,
          cause: error instanceof Error ? error.message : String(error),
        });
      });
    }
  }

  private startTypingIndicators(sessionId: string): void {
    const chatIds = this.chatsBySession.get(sessionId);
    if (!chatIds) {
      return;
    }

    for (const chatId of chatIds) {
      const key = this.getSessionChatKey(sessionId, chatId);
      if (this.typingIntervalsBySessionChat.has(key)) {
        continue;
      }

      const sendTyping = () => {
        void this.api.sendChatAction(chatId, "typing").catch((error) => {
          this.log("warn", "failed to send telegram typing action", {
            chatId,
            cause: error instanceof Error ? error.message : String(error),
          });
        });
      };

      sendTyping();
      const interval = setInterval(sendTyping, TELEGRAM_TYPING_REFRESH_MS);
      interval.unref?.();
      this.typingIntervalsBySessionChat.set(key, interval);
    }
  }

  private stopTypingIndicators(sessionId: string): void {
    const chatIds = this.chatsBySession.get(sessionId);
    if (!chatIds) {
      return;
    }

    for (const chatId of chatIds) {
      const key = this.getSessionChatKey(sessionId, chatId);
      const interval = this.typingIntervalsBySessionChat.get(key);
      if (interval) {
        clearInterval(interval);
        this.typingIntervalsBySessionChat.delete(key);
      }
    }
  }

  private getSessionChatKey(sessionId: string, chatId: number): string {
    return `${sessionId}:${chatId}`;
  }

  private async reactToQueuedMessage(chatId: number, messageId?: number): Promise<void> {
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

  private formatSessionReady(sessionId: string, projectId: string): string {
    return `all set, your ${projectId} session ${sessionId} is ready.`;
  }

  private formatMessageQueued(sessionId: string): string {
    return formatSessionHeadline(sessionId, "message queued");
  }

  private formatManagerError(error: unknown): string {
    if (error instanceof TelegramSessionManagerError) {
      return error.message;
    }

    return error instanceof Error ? error.message : String(error);
  }

  private async reply(
    chatId: number,
    text: string,
    options?: {
      replyMarkup?: TelegramInlineKeyboardMarkup;
      rich?: boolean;
    },
  ): Promise<void> {
    if (options?.rich === true) {
      await this.replyWithRichMessage(chatId, text, options.replyMarkup);
      return;
    }

    await this.replyWithPlainMessage(chatId, text, options?.replyMarkup);
  }

  private async replyWithRichMessage(
    chatId: number,
    text: string,
    replyMarkup?: TelegramInlineKeyboardMarkup,
  ): Promise<void> {
    const chunks = splitTelegramRichMessage(text);

    for (const [index, chunk] of chunks.entries()) {
      await this.api.sendRichMessage(chatId, chunk, {
        replyMarkup: index === chunks.length - 1 ? replyMarkup : undefined,
      });

      if (index < chunks.length - 1) {
        await this.wait(TELEGRAM_MESSAGE_SPLIT_DELAY_MS);
      }
    }
  }

  private async replyWithPlainMessage(
    chatId: number,
    text: string,
    replyMarkup?: TelegramInlineKeyboardMarkup,
  ): Promise<void> {
    const chunks = splitTelegramMessage(text);

    for (const [index, chunk] of chunks.entries()) {
      await this.api.sendMessage(chatId, chunk, {
        replyMarkup: index === chunks.length - 1 ? replyMarkup : undefined,
      });

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

export async function startTelegramAdapter(
  options: TelegramAdapterOptions,
): Promise<TelegramAdapterHandle> {
  await sweepStaleTelegramAttachmentTempDirs();
  const api = options.api ?? createTelegramApi(options.botToken);
  const botUsername = normalizeTelegramUsername((await api.getMe()).username);
  if (!botUsername) {
    throw new Error("telegram bot username is missing");
  }

  const adapter = new TelegramAdapterImpl({
    ...options,
    api,
    botUsername,
  });

  return {
    close: () => adapter.close(),
  };
}
