import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, extname, join } from "node:path";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { z } from "zod";
import type {
  SessionProtocolReasoningEffort,
  SessionProtocolSnapshot,
} from "../../protocol/session_protocol.js";
import { TauSessionProtocolResponseError } from "../../transport/errors.js";
import type { SpeechToTextProvider, TelegramProjectConfig } from "../config/schema.js";
import { formatAdaptiveNumber, formatTokenWindow } from "../utils/format.js";
import { transcribeAudio } from "../utils/speech_to_text.js";
import {
  collectSpeechToTextContext,
  type SpeechToTextContext,
} from "../utils/speech_to_text_context.js";
import { formatTauUserText, splitTauUserText } from "../utils/user_metadata.js";
import { formatZodError } from "../utils/zod.js";
import type { TelegramProjectPreferenceStore } from "./project_preferences.js";
import {
  createScopedTelegramSessionManager,
  type TelegramSessionManager,
  TelegramSessionManagerError,
  type TelegramSessionManagerEvent,
  type TelegramSessionRecord,
} from "./session_manager.js";
import { type GenerateTelegramVoiceOptions, generateTelegramVoice } from "./tts.js";

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

type TelegramSendOptions = {
  replyMarkup?: TelegramInlineKeyboardMarkup;
  signal: AbortSignal;
};

export type TelegramApi = {
  getMe(): Promise<TelegramBotInfo>;
  getUpdates(args: {
    offset: number;
    timeoutSeconds: number;
    allowedUpdates: TelegramAllowedUpdates;
  }): Promise<TelegramUpdate[]>;
  sendMessage(chatId: number, text: string, options: TelegramSendOptions): Promise<void>;
  sendRichMessage(chatId: number, markdown: string, options: TelegramSendOptions): Promise<void>;
  sendVoice(chatId: number, voice: Buffer, options: TelegramSendOptions): Promise<void>;
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
  projectPreferences: TelegramProjectPreferenceStore;
  api?: TelegramApi;
  fetchImpl?: typeof fetch;
  generateVoice?: (options: GenerateTelegramVoiceOptions) => Promise<Buffer>;
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

type TelegramNotificationOptions = { rich?: false } | { rich: true; messageId: string };

const DEFAULT_POLL_INTERVAL_MS = 1000;
const DEFAULT_REQUEST_TIMEOUT_SECONDS = 30;
const MAX_COMMAND_PREVIEW_CHARS = 128;
const MAX_PROVISION_DIAGNOSTIC_CHARS = 2_000;
const DEFAULT_TELEGRAM_VOICE_MIME_TYPE = "audio/ogg";
const DEFAULT_TELEGRAM_VOICE_FILE_NAME = "voice.ogg";
const DEFAULT_TELEGRAM_AUDIO_MIME_TYPE = "audio/mpeg";
const DEFAULT_TELEGRAM_AUDIO_FILE_NAME = "audio.mp3";
const DEFAULT_TELEGRAM_PHOTO_MIME_TYPE = "image/jpeg";
const DEFAULT_TELEGRAM_DOCUMENT_MIME_TYPE = "application/octet-stream";
const MESSAGE_ACKNOWLEDGMENT_REACTION_EMOJI = "👀";
const MESSAGE_ACKNOWLEDGMENT_DELAY_MS = 1000;
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
const TELEGRAM_DELIVERY_ATTEMPT_TIMEOUT_MS = 30_000;
const TELEGRAM_DELIVERY_RETRY_DELAYS_MS = [1000, 5000] as const;
const TELEGRAM_TYPING_REFRESH_MS = 4000;
const ABORTED = Symbol("aborted");
const TIMED_OUT = Symbol("timed-out");
const CALLBACK_ACTION_PREFIX = "tau:action:";
const MAX_TELEGRAM_ATTACHMENTS_PER_TURN = 10;
const MAX_TELEGRAM_ATTACHMENT_FILE_BYTES = 20 * 1024 * 1024;
const MAX_TELEGRAM_ATTACHMENT_TOTAL_BYTES = 50 * 1024 * 1024;
const MAX_TELEGRAM_VOICE_BYTES = 50 * 1024 * 1024;
const TELEGRAM_TTS_JOB_TIMEOUT_MS = 5 * 60_000;
const MAX_TELEGRAM_GROUP_PENDING_MESSAGES = 50;
const TELEGRAM_ATTACHMENT_TEMP_DIR_PREFIX = "tau-telegram-attachments-";
const TELEGRAM_REASONING_EFFORTS = [
  "low",
  "medium",
  "high",
  "xhigh",
] as const satisfies readonly SessionProtocolReasoningEffort[];
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

function hasTelegramMention(text: string, username: string): boolean {
  const normalizedUsername = normalizeTelegramUsername(username);
  if (!normalizedUsername) {
    return false;
  }

  const mentionPattern = new RegExp(
    `(^|[^A-Za-z0-9_])@${RegExp.escape(normalizedUsername)}(?=$|[^A-Za-z0-9_])`,
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
    `(^|[^A-Za-z0-9_])@${RegExp.escape(normalizedUsername)}(?=$|[^A-Za-z0-9_])`,
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

function formatTelegramSessionName(sessionId: string, projectLabel: string): string {
  return `${projectLabel} session ${sessionId}`;
}

function formatProjectLabel(projectId: string, project: TelegramProjectConfig): string {
  return "projectIds" in project ? `${projectId} (${project.projectIds.join(", ")})` : projectId;
}

function formatSessionStatus(
  session: TelegramSessionRecord,
  project: TelegramProjectConfig,
  snapshot: SessionProtocolSnapshot | undefined,
  preferredProjectId: string | undefined,
): string {
  const sessionName = formatTelegramSessionName(
    session.id,
    formatProjectLabel(session.projectId, project),
  );
  const preferenceStatus =
    preferredProjectId && preferredProjectId !== session.projectId
      ? ` new chats will use ${preferredProjectId}.`
      : "";
  if (session.state === "failed") {
    const errorStatus = session.error ? ` ${ensureTerminalPunctuation(session.error)}` : "";
    return `your ${sessionName} failed.${errorStatus}${preferenceStatus}`;
  }

  const state = {
    queued: "queued",
    "preparing-workspace": "preparing its workspace",
    running: "running",
    "waiting-input": "waiting for input",
  }[session.state];
  const status = `your ${sessionName} is ${state}.`;
  if (!snapshot) {
    return `${status}${preferenceStatus}`;
  }

  const goalStatus = snapshot.goal
    ? snapshot.goal.status === "active"
      ? " it is pursuing a goal."
      : " its goal is blocked."
    : "";
  const model = snapshot.bootstrap.model.name || snapshot.bootstrap.model.id;
  const reasoning = snapshot.settings.reasoning ?? "none";
  const context = formatTelegramContextUsage(snapshot);
  const cost = formatTelegramSessionCost(getTelegramSessionCostTotal(snapshot));
  return `${status}${goalStatus} it is using ${model} with ${reasoning} reasoning. context usage is ${context}. cumulative cost is ${cost}.${preferenceStatus}`;
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

function supportsReasoningEffort(
  snapshot: SessionProtocolSnapshot,
  reasoning: SessionProtocolReasoningEffort,
): boolean {
  if (!snapshot.bootstrap.model.reasoning) {
    return false;
  }

  const persona = snapshot.catalog.personas.find(
    (candidate) => candidate.id === snapshot.settings.personaId,
  );
  if (!persona) {
    return false;
  }

  const allowed = persona.allowedReasoningLevels;
  return !allowed || allowed.length === 0 || allowed.includes(reasoning);
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

const telegramObject = <Shape extends z.ZodRawShape>(shape: Shape) => z.object(shape).strip();

const telegramPartialObject = <Shape extends z.ZodRawShape>(shape: Shape) =>
  telegramObject(shape).partial();

function parseOrThrow<Result>(schema: z.ZodType<Result>, raw: unknown, message: string): Result {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new Error(`${message}: ${formatZodError(parsed.error)}`);
  }
  return parsed.data;
}

const TelegramFailureEnvelopeSchema = z.object({
  ok: z.literal(false),
  error_code: z.number().int(),
  description: z.string(),
  parameters: z
    .object({
      retry_after: z.number().int().nonnegative().optional(),
    })
    .optional(),
});

const TelegramEnvelopeSchema = z.discriminatedUnion("ok", [
  z.object({
    ok: z.literal(true),
    description: z.string().optional(),
    result: z.unknown(),
  }),
  TelegramFailureEnvelopeSchema,
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
const MAX_TELEGRAM_ERROR_DETAIL_LENGTH = 500;

type TelegramRequestErrorOptions = {
  retryable: boolean;
  retryAfterMs?: number;
  cause?: unknown;
};

export class TelegramRequestError extends Error {
  readonly retryable: boolean;
  readonly retryAfterMs?: number;

  constructor(message: string, options: TelegramRequestErrorOptions) {
    super(message, { cause: options.cause });
    this.name = "TelegramRequestError";
    this.retryable = options.retryable;
    this.retryAfterMs = options.retryAfterMs;
  }
}

class TelegramDeliveryError extends Error {
  readonly attempts: number;
  readonly retryable: boolean;

  constructor(cause: unknown, attempts: number, retryable: boolean) {
    super(cause instanceof Error ? cause.message : String(cause), { cause });
    this.name = "TelegramDeliveryError";
    this.attempts = attempts;
    this.retryable = retryable;
  }
}

function getErrorCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null || !("code" in error)) {
    return undefined;
  }

  return typeof error.code === "string" ? error.code : undefined;
}

function formatTelegramNetworkError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const cause = error instanceof Error ? error.cause : undefined;
  const causeMessage = cause instanceof Error ? cause.message : undefined;
  const codes = Array.from(
    new Set([getErrorCode(error), getErrorCode(cause)].filter((code) => code !== undefined)),
  );
  const detail = causeMessage && causeMessage !== message ? `${message}: ${causeMessage}` : message;
  return `${detail}${codes.length > 0 ? ` (${codes.join(", ")})` : ""}`;
}

function truncateTelegramErrorDetail(detail: string): string {
  if (detail.length <= MAX_TELEGRAM_ERROR_DETAIL_LENGTH) {
    return detail;
  }

  return `${detail.slice(0, MAX_TELEGRAM_ERROR_DETAIL_LENGTH)}…`;
}

function isRetryableTelegramErrorCode(errorCode: number): boolean {
  return errorCode === 408 || errorCode === 429 || (errorCode >= 500 && errorCode <= 599);
}

function getTelegramRetryAfterMs(
  envelope: z.infer<typeof TelegramFailureEnvelopeSchema>,
): number | undefined {
  const retryAfterSeconds = envelope.parameters?.retry_after;
  return retryAfterSeconds === undefined ? undefined : retryAfterSeconds * 1000;
}

function parseTelegramHttpError(responseText: string): {
  detail: string;
  errorCode?: number;
  retryAfterMs?: number;
} {
  const trimmedResponseText = responseText.trim();
  if (!trimmedResponseText) {
    return { detail: "" };
  }

  try {
    const parsed = TelegramFailureEnvelopeSchema.safeParse(JSON.parse(trimmedResponseText));
    if (parsed.success) {
      return {
        detail: truncateTelegramErrorDetail(parsed.data.description.trim()),
        errorCode: parsed.data.error_code,
        retryAfterMs: getTelegramRetryAfterMs(parsed.data),
      };
    }
  } catch {}

  return { detail: truncateTelegramErrorDetail(trimmedResponseText) };
}

function asPermanentTelegramRequestError(error: unknown): TelegramRequestError {
  const message = error instanceof Error ? error.message : String(error);
  return new TelegramRequestError(message, { retryable: false, cause: error });
}

type TelegramUpload = {
  field: string;
  fileName: string;
  mimeType: string;
  data: Buffer;
};

function createTelegramApi(botToken: string): TelegramApi {
  const apiUrl = `https://api.telegram.org/bot${botToken}`;

  async function callTelegramMethod<Result>(
    method: string,
    payload: Record<string, unknown>,
    resultSchema: z.ZodType<Result>,
    signal?: AbortSignal,
    upload?: TelegramUpload,
  ): Promise<Result> {
    const body = upload ? new FormData() : JSON.stringify(payload);
    if (body instanceof FormData && upload) {
      for (const [key, value] of Object.entries(payload)) {
        body.append(key, typeof value === "string" ? value : JSON.stringify(value));
      }
      body.append(
        upload.field,
        new Blob([Uint8Array.from(upload.data)], { type: upload.mimeType }),
        upload.fileName,
      );
    }

    let response: Response;
    try {
      response = await fetch(`${apiUrl}/${method}`, {
        method: "POST",
        ...(upload ? {} : { headers: { "content-type": "application/json" } }),
        body,
        signal,
      });
    } catch (error) {
      throw new TelegramRequestError(
        `telegram ${method} network request failed: ${formatTelegramNetworkError(error)}`,
        { retryable: true, cause: error },
      );
    }

    if (!response.ok) {
      let responseText: string;
      try {
        responseText = await response.text();
      } catch (error) {
        throw new TelegramRequestError(
          `telegram ${method} failed: HTTP ${response.status}: response body read failed: ${formatTelegramNetworkError(error)}`,
          {
            retryable: isRetryableTelegramErrorCode(response.status),
            cause: error,
          },
        );
      }

      const { detail, errorCode, retryAfterMs } = parseTelegramHttpError(responseText);
      throw new TelegramRequestError(
        `telegram ${method} failed: HTTP ${response.status}${detail ? `: ${detail}` : ""}`,
        {
          retryable:
            isRetryableTelegramErrorCode(response.status) ||
            (errorCode !== undefined && isRetryableTelegramErrorCode(errorCode)),
          ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
        },
      );
    }

    let responseText: string;
    try {
      responseText = await response.text();
    } catch (error) {
      throw new TelegramRequestError(
        `telegram ${method} response body read failed: ${formatTelegramNetworkError(error)}`,
        { retryable: true, cause: error },
      );
    }

    let raw: unknown;
    try {
      raw = JSON.parse(responseText);
    } catch (error) {
      throw new TelegramRequestError(`telegram ${method} returned invalid JSON`, {
        retryable: false,
        cause: error,
      });
    }

    let envelope: z.infer<typeof TelegramEnvelopeSchema>;
    try {
      envelope = parseOrThrow(
        TelegramEnvelopeSchema,
        raw,
        `telegram ${method} returned an invalid response payload`,
      );
    } catch (error) {
      throw asPermanentTelegramRequestError(error);
    }

    if (!envelope.ok) {
      const detail = envelope.description.trim();
      const retryAfterMs = getTelegramRetryAfterMs(envelope);
      throw new TelegramRequestError(
        `telegram ${method} request failed${detail ? `: ${detail}` : ""}`,
        {
          retryable: isRetryableTelegramErrorCode(envelope.error_code),
          ...(retryAfterMs === undefined ? {} : { retryAfterMs }),
        },
      );
    }

    try {
      return parseOrThrow(
        resultSchema,
        envelope.result,
        `telegram ${method} returned an invalid result`,
      );
    } catch (error) {
      throw asPermanentTelegramRequestError(error);
    }
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
        options.signal,
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
        options.signal,
      );
    },
    async sendVoice(chatId, voice, options) {
      await callTelegramMethod("sendVoice", { chat_id: chatId }, z.unknown(), options.signal, {
        field: "voice",
        fileName: "response.ogg",
        mimeType: "audio/ogg",
        data: voice,
      });
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
          reaction: [{ type: "emoji", emoji: MESSAGE_ACKNOWLEDGMENT_REACTION_EMOJI }],
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
  private readonly projectPreferences: TelegramProjectPreferenceStore;
  private readonly enforceChatOwnership: boolean;
  private readonly botOwnerPrefix: string;
  private readonly allowedProjectIds: string[];
  private readonly api: TelegramApi;
  private readonly fetchImpl?: typeof fetch;
  private readonly generateVoice: (options: GenerateTelegramVoiceOptions) => Promise<Buffer>;
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
  private readonly notificationQueueTailByChat = new Map<number, Promise<void>>();
  private readonly inFlightNotificationTasks = new Set<Promise<void>>();
  private readonly ttsQueueTailBySession = new Map<string, Promise<void>>();
  private readonly inFlightTtsTasks = new Set<Promise<void>>();

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
    this.projectPreferences = options.projectPreferences;
    this.enforceChatOwnership = true;
    this.botOwnerPrefix = `telegram:${botId}`;
    this.allowedProjectIds = Object.keys(options.projects);
    this.api = options.api;
    this.fetchImpl = options.fetchImpl;
    this.generateVoice = options.generateVoice ?? generateTelegramVoice;
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

    this.restoreSessionMappings();
    this.unsubscribeSessionEvents = this.sessionManager.onEvent((event) => {
      this.onSessionEvent(event);
    });
    for (const sessionId of this.chatsBySession.keys()) {
      for (const failure of this.sessionManager.getProvisionFailures(sessionId)) {
        this.onSessionEvent(failure);
      }
      for (const notification of this.sessionManager.getPendingTurnNotifications(sessionId)) {
        this.onSessionEvent(notification);
      }
    }

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
      await Promise.allSettled(Array.from(this.inFlightTtsTasks));
      this.ttsQueueTailBySession.clear();
      await Promise.allSettled(Array.from(this.inFlightNotificationTasks));

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
    const definitions: TelegramCommandDefinition[] = [
      {
        command: "/new",
        description: "start a new session",
        callbackAction: "new",
        handler: async (chatId, args, sourceMessageId) =>
          this.handleNew(chatId, args, sourceMessageId),
      },
      {
        command: "/status",
        description: "show active session status",
        callbackAction: "status",
        handler: async (chatId) => this.handleStatus(chatId),
      },
      {
        command: "/compact",
        description: "compact session context",
        handler: async (chatId, args) => this.handleCompact(chatId, args),
      },
      {
        command: "/interrupt",
        description: "interrupt active run",
        callbackAction: "interrupt",
        handler: async (chatId) => this.handleInterrupt(chatId),
      },
      {
        command: "/tts_on",
        description: "enable voice responses",
        handler: async (chatId, args) => this.handleTtsPreference(chatId, true, args),
      },
      {
        command: "/tts_off",
        description: "disable voice responses",
        handler: async (chatId, args) => this.handleTtsPreference(chatId, false, args),
      },
    ];

    for (const reasoning of TELEGRAM_REASONING_EFFORTS) {
      definitions.push({
        command: `/effort_${reasoning}`,
        description: `set reasoning effort to ${reasoning}`,
        handler: async (chatId, args) => this.handleSetReasoning(chatId, reasoning, args),
      });
    }

    for (const projectId of this.allowedProjectIds) {
      definitions.push({
        command: `/use_${projectId}`,
        description: `use ${projectId} for new sessions`,
        handler: async (chatId, args) => this.handleUseProject(chatId, projectId, args),
      });
    }

    return definitions;
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

    if (updates === ABORTED) {
      return [];
    }

    return updates;
  }

  private async raceWithAbort<T>(promise: Promise<T>): Promise<T | typeof ABORTED> {
    if (this.abortController.signal.aborted) {
      return ABORTED;
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
      return ABORTED;
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

  private restoreSessionMappings(): void {
    const ownerPrefix = `${this.botOwnerPrefix}:chat:`;
    const sessions = this.sessionManager
      .listSessions()
      .filter(
        (session) =>
          this.allowedProjectIds.includes(session.projectId) &&
          session.ownerId?.startsWith(ownerPrefix),
      )
      .sort((left, right) => left.updatedAt.localeCompare(right.updatedAt));

    for (const session of sessions) {
      const ownerId = session.ownerId;
      if (!ownerId) {
        continue;
      }
      const chatIdText = ownerId.slice(ownerPrefix.length);
      const chatId = Number(chatIdText);
      if (Number.isSafeInteger(chatId) && String(chatId) === chatIdText) {
        this.setActiveSession(chatId, session.id);
      }
    }
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
        `unsupported command. supported commands: ${this.commandDefinitions.map((definition) => definition.command).join(", ")}`,
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

  private getPreferredProjectId(chatId: number): string | undefined {
    const storedProjectId = this.projectPreferences.get(this.ownerIdForChat(chatId));
    if (storedProjectId && this.projects[storedProjectId]) {
      return storedProjectId;
    }
    if (this.defaultProjectId) {
      return this.defaultProjectId;
    }

    const projectIds = Object.keys(this.projects);
    return projectIds.length === 1 ? projectIds[0] : undefined;
  }

  private resolveNewCommand(chatId: number, args: string[]): NewCommandResolution {
    if (args.length > 0) {
      return { error: "usage: /new" };
    }

    const projectId = this.getPreferredProjectId(chatId);
    if (projectId) {
      return { projectId };
    }
    if (this.allowedProjectIds.length === 0) {
      return { error: "no telegram projects configured" };
    }

    return { error: "select a project with /use_<project> before using /new" };
  }

  private async handleUseProject(chatId: number, projectId: string, args: string[]): Promise<void> {
    if (args.length > 0) {
      await this.reply(chatId, `usage: /use_${projectId}`);
      return;
    }

    try {
      await this.projectPreferences.set(this.ownerIdForChat(chatId), projectId);
      await this.reply(chatId, `new chats will use ${projectId}.`);
    } catch (error) {
      await this.reply(
        chatId,
        `failed to save project preference: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async handleTtsPreference(
    chatId: number,
    enabled: boolean,
    args: string[],
  ): Promise<void> {
    const command = enabled ? "/tts_on" : "/tts_off";
    if (args.length > 0) {
      await this.reply(chatId, `usage: ${command}`);
      return;
    }
    if (enabled && !this.geminiApiKey) {
      await this.reply(chatId, "set GEMINI_API_KEY or apiKeys.google to enable voice responses.");
      return;
    }

    try {
      await this.projectPreferences.setTtsEnabled(this.ownerIdForChat(chatId), enabled);
      await this.reply(chatId, `voice responses ${enabled ? "enabled" : "disabled"}.`);
    } catch (error) {
      await this.reply(
        chatId,
        `failed to save voice response preference: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private async handleSetReasoning(
    chatId: number,
    reasoning: (typeof TELEGRAM_REASONING_EFFORTS)[number],
    args: string[],
  ): Promise<void> {
    if (args.length > 0) {
      await this.reply(chatId, `usage: /effort_${reasoning}`);
      return;
    }

    const session = await this.requireActiveSession(chatId);
    if (!session) {
      return;
    }

    try {
      const sessionManager = this.getSessionManagerForChat(chatId);
      const snapshot = await sessionManager.getSessionSnapshot(session.id);
      if (!snapshot) {
        throw new TelegramSessionManagerError("not_ready", "session is still preparing");
      }
      if (!supportsReasoningEffort(snapshot, reasoning)) {
        await this.reply(chatId, `reasoning effort ${reasoning} is not supported by this session.`);
        return;
      }

      await sessionManager.setReasoning(session.id, reasoning);
      await this.reply(chatId, `reasoning effort set to ${reasoning}.`);
    } catch (error) {
      await this.reply(chatId, this.formatManagerError(error));
    }
  }

  private async handleNew(chatId: number, args: string[], sourceMessageId?: number): Promise<void> {
    const parsed = this.resolveNewCommand(chatId, args);
    if ("error" in parsed) {
      await this.reply(chatId, parsed.error);
      return;
    }

    void this.acknowledgeMessageAfterDelay(chatId, sourceMessageId);

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
    } catch (error) {
      await this.reply(chatId, this.formatManagerError(error));
    }
  }

  private async handleStatus(chatId: number): Promise<void> {
    const preferredProjectId = this.getPreferredProjectId(chatId);
    const session = this.getActiveSession(chatId);
    if (!session) {
      await this.reply(
        chatId,
        preferredProjectId
          ? `new chats will use ${preferredProjectId}.`
          : "no active session. select a project with /use_<project>.",
      );
      return;
    }

    const sessionManager = this.getSessionManagerForChat(chatId);
    let snapshot: SessionProtocolSnapshot | undefined;
    try {
      snapshot = await sessionManager.getSessionSnapshot(session.id);
    } catch {
      snapshot = undefined;
    }

    await this.reply(
      chatId,
      formatSessionStatus(session, this.projects[session.projectId]!, snapshot, preferredProjectId),
    );
  }

  private async handleCompact(chatId: number, args: string[]): Promise<void> {
    if (args.length > 0) {
      await this.reply(chatId, "usage: /compact");
      return;
    }
    const session = await this.requireActiveSession(chatId);
    if (!session) return;

    await this.reply(chatId, "compacting session...");
    this.startTypingIndicators(session.id);
    try {
      const sessionManager = this.getSessionManagerForChat(chatId);
      await sessionManager.compactSession(session.id);
      await this.reply(chatId, "session compacted. previous context has been summarized.");
    } catch (error) {
      this.log("error", "telegram session compaction failed", {
        sessionId: session.id,
        cause: this.formatManagerDiagnostic(error),
      });
      await this.reply(chatId, "session compaction failed. please try again.");
    } finally {
      this.stopTypingIndicators(session.id);
    }
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
          `nothing is running in ${formatTelegramSessionName(result.session.id, result.session.projectId)}.`,
        );
        return;
      }

      await this.reply(
        chatId,
        `stopping ${formatTelegramSessionName(result.session.id, result.session.projectId)}.`,
      );
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
      if (audioTranscript) {
        await this.reply(chatId, `transcribed: ${audioTranscript}`);
      }
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
      await this.reply(chatId, `transcribed: ${result.transcript}`);
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
      mode: "auto",
      ...(this.systemMessage ? { additionalSystemMessage: this.systemMessage } : {}),
    });
    this.resetPendingAttachmentQueue(sessionId);
    await this.acknowledgeMessageAfterDelay(chatId, sourceMessageId);
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
    if (event.type === "session-provision-failed") {
      if (!this.chatsBySession.has(event.sessionId)) {
        return;
      }

      this.notifySession(
        event.sessionId,
        [
          `provisioning ${event.targetProjectId} failed in your ${formatTelegramSessionName(event.sessionId, event.projectId)}.`,
          truncateText(event.diagnostic, MAX_PROVISION_DIAGNOSTIC_CHARS),
          "the session remains available.",
        ].join("\n"),
      );
      return;
    }

    if (event.type === "session-notice") {
      if (!this.chatsBySession.has(event.sessionId)) {
        return;
      }

      this.notifySession(event.sessionId, event.text);
      return;
    }

    if (event.type === "session-progress") {
      if (!this.chatsBySession.has(event.sessionId)) {
        return;
      }

      this.handleSessionProgress(event);
      return;
    }

    if (event.type === "session-response-completed") {
      if (this.chatsBySession.has(event.sessionId)) {
        this.startTtsNotification(event.sessionId, event.text);
      }
      return;
    }

    if (event.type === "session-turn-failed" || event.type === "session-turn-rejected") {
      if (!this.chatsBySession.has(event.sessionId)) {
        return;
      }

      this.log(
        event.type === "session-turn-failed" ? "error" : "warn",
        event.type === "session-turn-failed"
          ? "telegram session turn failed"
          : "telegram session turn rejected",
        {
          sessionId: event.sessionId,
          projectId: event.projectId,
          ...(event.type === "session-turn-failed" ? { failure: event.failure } : {}),
        },
      );
      const text =
        event.type === "session-turn-failed"
          ? "turn failed. please try again."
          : "your previous message was not submitted. please send it again.";
      void this.notifySession(event.sessionId, text)
        .then(async (delivered) => {
          if (delivered) {
            await this.sessionManager.acknowledgeTurnNotification(
              event.sessionId,
              event.historyEntryId,
            );
          }
        })
        .catch((error) => {
          this.log("error", "failed to acknowledge turn notification", {
            sessionId: event.sessionId,
            historyEntryId: event.historyEntryId,
            cause: error instanceof Error ? error.message : String(error),
          });
        });
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
      { rich: true, messageId: event.progress.messageId },
    );
  }

  private startTtsNotification(sessionId: string, sourceText: string): void {
    const chatIds = this.chatsBySession.get(sessionId);
    if (
      !this.geminiApiKey ||
      !chatIds ||
      ![...chatIds].some((chatId) =>
        this.projectPreferences.isTtsEnabled(this.ownerIdForChat(chatId)),
      )
    ) {
      return;
    }

    const previousTask = this.ttsQueueTailBySession.get(sessionId) ?? Promise.resolve();
    const task = previousTask
      .then(async () => {
        if (!this.abortController.signal.aborted) {
          await this.generateAndSendTtsNotification(sessionId, sourceText);
        }
      })
      .finally(() => {
        this.inFlightTtsTasks.delete(task);
        if (this.ttsQueueTailBySession.get(sessionId) === task) {
          this.ttsQueueTailBySession.delete(sessionId);
        }
      });
    this.ttsQueueTailBySession.set(sessionId, task);
    this.inFlightTtsTasks.add(task);
    void task;
  }

  private async generateAndSendTtsNotification(
    sessionId: string,
    sourceText: string,
  ): Promise<void> {
    let timedOut = false;
    const timeoutController = new AbortController();
    const timeout = setTimeout(() => {
      timedOut = true;
      timeoutController.abort();
    }, TELEGRAM_TTS_JOB_TIMEOUT_MS);
    timeout.unref?.();

    try {
      const voice = await this.generateVoice({
        apiKey: this.geminiApiKey!,
        sourceText,
        fetchImpl: this.fetchImpl,
        signal: AbortSignal.any([this.abortController.signal, timeoutController.signal]),
      });
      if (voice.length > MAX_TELEGRAM_VOICE_BYTES) {
        throw new Error("generated voice response exceeds Telegram's 50 MB limit");
      }

      const chatIds = this.chatsBySession.get(sessionId);
      if (!chatIds) {
        return;
      }
      await Promise.all(
        [...chatIds]
          .filter((chatId) => this.projectPreferences.isTtsEnabled(this.ownerIdForChat(chatId)))
          .map(async (chatId) => {
            const result = await this.enqueueVoiceNotification(
              sessionId,
              chatId,
              voice,
              timeoutController.signal,
            );
            if (result === "timed-out") {
              this.log("error", "Telegram voice response job timed out", {
                sessionId,
                chatId,
                cause: "voice response job timed out after 5 minutes",
              });
            }
            if (result === "failed" || result === "timed-out") {
              await this.enqueueTtsFailureNotification(sessionId, chatId);
            }
          }),
      );
    } catch (error) {
      if (this.abortController.signal.aborted) {
        return;
      }
      this.log("error", "failed to generate Telegram voice response", {
        sessionId,
        cause: timedOut
          ? "voice generation timed out after 5 minutes"
          : error instanceof Error
            ? error.message
            : String(error),
      });
      await this.notifyTtsFailure(sessionId);
    } finally {
      clearTimeout(timeout);
    }
  }

  private async notifyTtsFailure(sessionId: string): Promise<void> {
    const chatIds = this.chatsBySession.get(sessionId);
    if (!chatIds) {
      return;
    }
    await Promise.all(
      [...chatIds]
        .filter((chatId) => this.projectPreferences.isTtsEnabled(this.ownerIdForChat(chatId)))
        .map(async (chatId) => await this.enqueueTtsFailureNotification(sessionId, chatId)),
    );
  }

  private async enqueueTtsFailureNotification(sessionId: string, chatId: number): Promise<void> {
    if (
      this.abortController.signal.aborted ||
      !this.projectPreferences.isTtsEnabled(this.ownerIdForChat(chatId))
    ) {
      return;
    }
    await this.enqueueNotification(
      sessionId,
      chatId,
      "voice response failed. please try again.",
      {},
    );
  }

  private notifyLifecycle(
    sessionId: string,
    projectId: string,
    state: "started" | "finished" | "failed",
  ): void {
    const sessionName = formatTelegramSessionName(sessionId, projectId);
    if (state === "failed") {
      this.notifySession(sessionId, `something went wrong in your ${sessionName}.`);
      return;
    }

    const stateLabel = {
      started: "started a run",
      finished: "finished its run",
    }[state];
    this.notifySession(sessionId, `your ${sessionName} ${stateLabel}.`);
  }

  private async notifySession(
    sessionId: string,
    text: string,
    options: TelegramNotificationOptions = {},
  ): Promise<boolean> {
    const chatIds = this.chatsBySession.get(sessionId);
    if (!chatIds || chatIds.size === 0) {
      return false;
    }

    const deliveries = await Promise.all(
      [...chatIds].map(
        async (chatId) => await this.enqueueNotification(sessionId, chatId, text, options),
      ),
    );
    return deliveries.every(Boolean);
  }

  private enqueueNotification(
    sessionId: string,
    chatId: number,
    text: string,
    options: TelegramNotificationOptions,
  ): Promise<boolean> {
    const previousTask = this.notificationQueueTailByChat.get(chatId) ?? Promise.resolve();
    const deliveryTask = previousTask
      .then(async () => {
        if (this.abortController.signal.aborted) {
          return false;
        }

        await this.reply(chatId, text, { rich: options.rich });
        return true;
      })
      .catch((error) => {
        if (this.abortController.signal.aborted) {
          return false;
        }

        const deliveryError =
          error instanceof TelegramDeliveryError
            ? error
            : new TelegramDeliveryError(error, 1, false);
        this.log(
          "error",
          deliveryError.retryable
            ? "telegram notification delivery retries exhausted"
            : "failed to send telegram notification",
          {
            sessionId,
            chatId,
            ...(options.rich === true ? { messageId: options.messageId } : {}),
            attempts: deliveryError.attempts,
            cause: deliveryError.message,
          },
        );
        return false;
      });

    const trackedTask = deliveryTask
      .then(() => undefined)
      .finally(() => {
        this.inFlightNotificationTasks.delete(trackedTask);
        if (this.notificationQueueTailByChat.get(chatId) === trackedTask) {
          this.notificationQueueTailByChat.delete(chatId);
        }
      });

    this.notificationQueueTailByChat.set(chatId, trackedTask);
    this.inFlightNotificationTasks.add(trackedTask);
    return deliveryTask;
  }

  private enqueueVoiceNotification(
    sessionId: string,
    chatId: number,
    voice: Buffer,
    jobSignal: AbortSignal,
  ): Promise<"sent" | "skipped" | "failed" | "timed-out"> {
    const previousTask = this.notificationQueueTailByChat.get(chatId) ?? Promise.resolve();
    const deliveryTask = previousTask
      .then(async () => {
        if (
          this.abortController.signal.aborted ||
          !this.projectPreferences.isTtsEnabled(this.ownerIdForChat(chatId))
        ) {
          return "skipped" as const;
        }
        if (jobSignal.aborted) {
          return "timed-out" as const;
        }

        const result = await this.sendWithRetry(
          async (signal) => await this.api.sendVoice(chatId, voice, { signal }),
          jobSignal,
        );
        if (result === ABORTED) {
          return jobSignal.aborted && !this.abortController.signal.aborted
            ? ("timed-out" as const)
            : ("skipped" as const);
        }
        return "sent" as const;
      })
      .catch((error) => {
        if (this.abortController.signal.aborted) {
          return "skipped" as const;
        }

        const deliveryError =
          error instanceof TelegramDeliveryError
            ? error
            : new TelegramDeliveryError(error, 1, false);
        this.log(
          "error",
          deliveryError.retryable
            ? "telegram voice response delivery retries exhausted"
            : "failed to send Telegram voice response",
          {
            sessionId,
            chatId,
            attempts: deliveryError.attempts,
            cause: deliveryError.message,
          },
        );
        return "failed" as const;
      });

    const trackedTask = deliveryTask
      .then(() => undefined)
      .finally(() => {
        this.inFlightNotificationTasks.delete(trackedTask);
        if (this.notificationQueueTailByChat.get(chatId) === trackedTask) {
          this.notificationQueueTailByChat.delete(chatId);
        }
      });

    this.notificationQueueTailByChat.set(chatId, trackedTask);
    this.inFlightNotificationTasks.add(trackedTask);
    return deliveryTask;
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

  private async acknowledgeMessageAfterDelay(chatId: number, messageId?: number): Promise<void> {
    if (typeof messageId !== "number" || !Number.isInteger(messageId) || messageId <= 0) {
      return;
    }

    await this.wait(MESSAGE_ACKNOWLEDGMENT_DELAY_MS);
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
    return `all set, your ${formatTelegramSessionName(sessionId, projectId)} is ready.`;
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

  private formatManagerDiagnostic(error: unknown): string {
    const message = this.formatManagerError(error);
    if (!(error instanceof TauSessionProtocolResponseError)) {
      return message;
    }

    const data = error.data;
    const cause =
      typeof data === "object" &&
      data !== null &&
      "cause" in data &&
      typeof data.cause === "string" &&
      data.cause.trim()
        ? data.cause.trim()
        : undefined;
    return cause && cause !== message ? `${message}: ${cause}` : message;
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
      const result = await this.sendWithRetry((signal) =>
        this.api.sendRichMessage(chatId, chunk, {
          replyMarkup: index === chunks.length - 1 ? replyMarkup : undefined,
          signal,
        }),
      );
      if (result === ABORTED) {
        return;
      }

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
      const result = await this.sendWithRetry((signal) =>
        this.api.sendMessage(chatId, chunk, {
          replyMarkup: index === chunks.length - 1 ? replyMarkup : undefined,
          signal,
        }),
      );
      if (result === ABORTED) {
        return;
      }

      if (index < chunks.length - 1) {
        await this.wait(TELEGRAM_MESSAGE_SPLIT_DELAY_MS);
      }
    }
  }

  private async sendWithRetry(
    send: (signal: AbortSignal) => Promise<void>,
    externalSignal?: AbortSignal,
  ): Promise<typeof ABORTED | undefined> {
    for (let attempt = 1; ; attempt += 1) {
      try {
        const result = await this.runDeliveryAttempt(send, externalSignal);
        if (result === ABORTED) {
          return ABORTED;
        }
        return;
      } catch (error) {
        if (this.abortController.signal.aborted || externalSignal?.aborted) {
          return ABORTED;
        }

        const retryDelayMs = TELEGRAM_DELIVERY_RETRY_DELAYS_MS[attempt - 1];
        const retryable = error instanceof TelegramRequestError && error.retryable;
        if (!retryable || retryDelayMs === undefined) {
          throw new TelegramDeliveryError(error, attempt, retryable);
        }

        await this.wait(Math.max(retryDelayMs, error.retryAfterMs ?? 0), externalSignal);
        if (this.abortController.signal.aborted || externalSignal?.aborted) {
          return ABORTED;
        }
      }
    }
  }

  private async runDeliveryAttempt(
    send: (signal: AbortSignal) => Promise<void>,
    externalSignal?: AbortSignal,
  ): Promise<typeof ABORTED | undefined> {
    const deliverySignal = externalSignal
      ? AbortSignal.any([this.abortController.signal, externalSignal])
      : this.abortController.signal;
    if (deliverySignal.aborted) {
      return ABORTED;
    }

    const attemptController = new AbortController();
    let abortListener: (() => void) | undefined;
    const abortPromise = new Promise<typeof ABORTED>((resolve) => {
      abortListener = () => {
        resolve(ABORTED);
        attemptController.abort();
      };
      deliverySignal.addEventListener("abort", abortListener, { once: true });
    });

    let timeout: ReturnType<typeof setTimeout> | undefined;
    const timeoutPromise = new Promise<typeof TIMED_OUT>((resolve) => {
      timeout = setTimeout(() => {
        resolve(TIMED_OUT);
        attemptController.abort();
      }, TELEGRAM_DELIVERY_ATTEMPT_TIMEOUT_MS);
      timeout.unref?.();
    });

    let sendPromise: Promise<void>;
    try {
      sendPromise = send(attemptController.signal);
    } catch (error) {
      sendPromise = Promise.reject(error);
    }
    const settled = sendPromise.then(
      () => ({ ok: true as const }),
      (error) => ({ ok: false as const, error }),
    );

    const raceResult = await Promise.race([settled, abortPromise, timeoutPromise]);

    if (timeout) {
      clearTimeout(timeout);
    }
    if (abortListener) {
      deliverySignal.removeEventListener("abort", abortListener);
    }

    if (raceResult === ABORTED) {
      return ABORTED;
    }
    if (raceResult === TIMED_OUT) {
      throw new TelegramRequestError(
        `telegram delivery attempt timed out after ${TELEGRAM_DELIVERY_ATTEMPT_TIMEOUT_MS / 1000} seconds`,
        { retryable: true },
      );
    }
    if (!raceResult.ok) {
      throw raceResult.error;
    }
  }

  private async wait(durationMs: number, externalSignal?: AbortSignal): Promise<void> {
    const waitSignal = externalSignal
      ? AbortSignal.any([this.abortController.signal, externalSignal])
      : this.abortController.signal;
    if (durationMs <= 0 || waitSignal.aborted) {
      return;
    }

    await new Promise<void>((resolve) => {
      const timeout = setTimeout(() => {
        waitSignal.removeEventListener("abort", onAbort);
        resolve();
      }, durationMs);
      timeout.unref?.();

      const onAbort = () => {
        clearTimeout(timeout);
        resolve();
      };

      waitSignal.addEventListener("abort", onAbort, { once: true });
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
