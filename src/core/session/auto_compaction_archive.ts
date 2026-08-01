import { Buffer } from "node:buffer";
import type {
  AssistantMessage,
  ImageContent,
  Message,
  TextContent,
  ThinkingContent,
  ToolCall,
  ToolResultMessage,
  UserMessage,
} from "@earendil-works/pi-ai";
import type { ToolExecutionBackend } from "../tools/execution_backend.js";
import { truncateForTokens } from "../utils/truncate.js";

const ARCHIVE_TEXT_TOOL_RESULT_MAX_TOKENS = 512;
const ARCHIVE_WRITE_TIMEOUT_MS = 30_000;

const WRITE_AUTO_COMPACTION_ARCHIVE_SCRIPT = `
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createHash, randomUUID } = require("node:crypto");

const payload = JSON.parse(fs.readFileSync(0, "utf8"));
const directoryName = "tau-auto-compaction-" + createHash("sha256")
  .update(payload.agentId)
  .digest("hex")
  .slice(0, 32);
const directory = path.join(os.tmpdir(), directoryName);

try {
  fs.mkdirSync(directory, { mode: 0o700 });
} catch (error) {
  if (error.code !== "EEXIST") throw error;
}
const stats = fs.lstatSync(directory);
if (!stats.isDirectory() || stats.isSymbolicLink()) {
  throw new Error("auto-compaction archive path is not a directory");
}
fs.chmodSync(directory, 0o700);

const numberedFiles = new Map();
for (const name of fs.readdirSync(directory)) {
  const match = /^(\\d{6})\\.(json|txt)$/.exec(name);
  if (!match) continue;
  const sequence = Number(match[1]);
  const extensions = numberedFiles.get(sequence) || new Set();
  extensions.add(match[2]);
  numberedFiles.set(sequence, extensions);
}

let latestSequence = 0;
for (const [sequence, extensions] of numberedFiles) {
  if (extensions.has("json") && extensions.has("txt")) {
    latestSequence = Math.max(latestSequence, sequence);
    continue;
  }
  for (const extension of extensions) {
    fs.rmSync(path.join(directory, String(sequence).padStart(6, "0") + "." + extension), {
      force: true,
    });
  }
}
for (const name of fs.readdirSync(directory)) {
  if (name.includes(".tmp-")) {
    fs.rmSync(path.join(directory, name), { force: true });
  }
}

const sequence = latestSequence + 1;
const basename = String(sequence).padStart(6, "0");
const textPath = path.join(directory, basename + ".txt");
const jsonPath = path.join(directory, basename + ".json");
const suffix = ".tmp-" + randomUUID();
const textTemporaryPath = textPath + suffix;
const jsonTemporaryPath = jsonPath + suffix;
const record = {
  version: 1,
  agentId: payload.agentId,
  sequence,
  createdAt: payload.createdAt,
  messages: payload.messages,
};
const text = [
  "Tau automatic compaction context snapshot",
  "Agent: " + payload.agentId,
  "Sequence: " + basename,
  "Created: " + new Date(payload.createdAt).toISOString(),
  "",
  "This is the complete model-visible context immediately before automatic compaction.",
  "Tool results in this text projection are middle-truncated; the JSON pair retains full captured content.",
  "",
  payload.textTranscript,
  "",
].join("\\n");

try {
  fs.writeFileSync(jsonTemporaryPath, JSON.stringify(record, null, 2) + "\\n", {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  fs.writeFileSync(textTemporaryPath, text, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
  fs.renameSync(jsonTemporaryPath, jsonPath);
  fs.renameSync(textTemporaryPath, textPath);
  fs.chmodSync(jsonPath, 0o600);
  fs.chmodSync(textPath, 0o600);
} catch (error) {
  fs.rmSync(jsonTemporaryPath, { force: true });
  fs.rmSync(textTemporaryPath, { force: true });
  fs.rmSync(jsonPath, { force: true });
  fs.rmSync(textPath, { force: true });
  throw error;
}

process.stdout.write(JSON.stringify({ textPath, jsonPath }));
`.trim();

type ArchiveTextContent = Pick<TextContent, "type" | "text">;
type ArchiveImageContent = Pick<ImageContent, "type" | "data" | "mimeType">;
type ArchiveThinkingContent = Pick<ThinkingContent, "type" | "thinking"> & {
  redacted?: boolean;
};
type ArchiveToolCall = Pick<ToolCall, "type" | "id" | "name" | "arguments">;
type ArchiveContent =
  | ArchiveTextContent
  | ArchiveImageContent
  | ArchiveThinkingContent
  | ArchiveToolCall;

type AutoCompactionArchiveMessage =
  | {
      historyEntryId: string;
      role: "user";
      timestamp: number;
      content: Array<ArchiveTextContent | ArchiveImageContent>;
    }
  | {
      historyEntryId: string;
      role: "assistant";
      timestamp: number;
      content: Array<ArchiveTextContent | ArchiveThinkingContent | ArchiveToolCall>;
    }
  | {
      historyEntryId: string;
      role: "toolResult";
      timestamp: number;
      content: Array<ArchiveTextContent | ArchiveImageContent>;
      toolCallId: string;
      toolName: string;
      isError: boolean;
    };

type AutoCompactionArchiveHistoryEntry = {
  id: string;
  message: Message;
};

export type AutoCompactionArchivePaths = {
  textPath: string;
  jsonPath: string;
};

export type AutoCompactionArchiveRequest = {
  agentId: string;
  createdAt: number;
  historyEntries: readonly AutoCompactionArchiveHistoryEntry[];
  signal: AbortSignal;
};

export type AutoCompactionArchiver = (
  request: AutoCompactionArchiveRequest,
) => Promise<AutoCompactionArchivePaths>;

export function createAutoCompactionArchiver(
  backend: ToolExecutionBackend,
): AutoCompactionArchiver {
  return async (request) => {
    const messages = request.historyEntries.map(normalizeArchiveMessage);
    const result = await backend.runNodeScript(WRITE_AUTO_COMPACTION_ARCHIVE_SCRIPT, [], {
      signal: request.signal,
      timeoutMs: ARCHIVE_WRITE_TIMEOUT_MS,
      stdin: Buffer.from(
        JSON.stringify({
          agentId: request.agentId,
          createdAt: request.createdAt,
          messages,
          textTranscript: formatArchiveText(messages),
        }),
      ),
    });
    if (result.aborted) throw new Error("auto-compaction archive write was aborted");
    if (result.timedOut) throw new Error("auto-compaction archive write timed out");
    if (result.exitCode !== 0) {
      throw new Error(result.stderr.trim() || result.output.trim() || "archive write failed");
    }
    if (result.truncated) throw new Error("auto-compaction archive response was truncated");
    return parseArchivePaths(result.stdout);
  };
}

function normalizeArchiveMessage(
  entry: AutoCompactionArchiveHistoryEntry,
): AutoCompactionArchiveMessage {
  const message = entry.message;
  if (message.role === "user") {
    return normalizeUserMessage(entry.id, message);
  }
  if (message.role === "assistant") {
    return normalizeAssistantMessage(entry.id, message);
  }
  return normalizeToolResultMessage(entry.id, message);
}

function normalizeUserMessage(
  historyEntryId: string,
  message: UserMessage,
): AutoCompactionArchiveMessage {
  return {
    historyEntryId,
    role: message.role,
    timestamp: message.timestamp,
    content:
      typeof message.content === "string"
        ? [{ type: "text", text: message.content }]
        : message.content.map(normalizeTextOrImageContent),
  };
}

function normalizeAssistantMessage(
  historyEntryId: string,
  message: AssistantMessage,
): AutoCompactionArchiveMessage {
  return {
    historyEntryId,
    role: message.role,
    timestamp: message.timestamp,
    content: message.content.map((content) => {
      if (content.type === "text") {
        return { type: content.type, text: content.text };
      }
      if (content.type === "thinking") {
        return {
          type: content.type,
          thinking: content.thinking,
          ...(content.redacted === undefined ? {} : { redacted: content.redacted }),
        };
      }
      return {
        type: content.type,
        id: content.id,
        name: content.name,
        arguments: content.arguments,
      };
    }),
  };
}

function normalizeToolResultMessage(
  historyEntryId: string,
  message: ToolResultMessage,
): AutoCompactionArchiveMessage {
  return {
    historyEntryId,
    role: message.role,
    timestamp: message.timestamp,
    content: message.content.map(normalizeTextOrImageContent),
    toolCallId: message.toolCallId,
    toolName: message.toolName,
    isError: message.isError,
  };
}

function normalizeTextOrImageContent(
  content: TextContent | ImageContent,
): ArchiveTextContent | ArchiveImageContent {
  return content.type === "text"
    ? { type: content.type, text: content.text }
    : { type: content.type, data: content.data, mimeType: content.mimeType };
}

function formatArchiveText(messages: readonly AutoCompactionArchiveMessage[]): string {
  return messages.map(formatArchiveMessage).join("\n\n");
}

function formatArchiveMessage(message: AutoCompactionArchiveMessage): string {
  const marker = `id=${JSON.stringify(message.historyEntryId)} timestamp=${message.timestamp}`;
  if (message.role === "toolResult") {
    const content = truncateForTokens(formatArchiveContent(message.content), {
      maxTokens: ARCHIVE_TEXT_TOOL_RESULT_MAX_TOKENS,
      strategy: "middle",
    }).content;
    return `[Tool result ${marker} callId=${JSON.stringify(message.toolCallId)} name=${JSON.stringify(message.toolName)} status=${message.isError ? "error" : "ok"}]\n${content}`;
  }

  const role = message.role === "user" ? "User" : "Assistant";
  return `[${role} ${marker}]\n${formatArchiveContent(message.content)}`;
}

function formatArchiveContent(content: readonly ArchiveContent[]): string {
  return (
    content
      .map((block) => {
        if (block.type === "text") return block.text;
        if (block.type === "image") {
          return `[Image mimeType=${JSON.stringify(block.mimeType)} data omitted from text transcript]`;
        }
        if (block.type === "thinking") {
          return `[Thinking${block.redacted ? " redacted" : ""}]\n${block.thinking}`;
        }
        return `[Tool call id=${JSON.stringify(block.id)} name=${JSON.stringify(block.name)}]\n${JSON.stringify(block.arguments, null, 2)}`;
      })
      .join("\n\n") || "(no content)"
  );
}

function parseArchivePaths(output: string): AutoCompactionArchivePaths {
  let value: unknown;
  try {
    value = JSON.parse(output);
  } catch {
    throw new Error("auto-compaction archive writer returned invalid JSON");
  }
  if (!value || typeof value !== "object") {
    throw new Error("auto-compaction archive writer returned an invalid result");
  }
  const { textPath, jsonPath } = value as Record<string, unknown>;
  if (
    typeof textPath !== "string" ||
    !textPath.endsWith(".txt") ||
    typeof jsonPath !== "string" ||
    !jsonPath.endsWith(".json")
  ) {
    throw new Error("auto-compaction archive writer returned invalid paths");
  }
  return { textPath, jsonPath };
}
