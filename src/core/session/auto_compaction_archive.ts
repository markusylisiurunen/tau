import { Buffer } from "node:buffer";
import type {
  AssistantMessage,
  ImageContent,
  Message,
  TextContent,
  ToolCall,
  ToolResultMessage,
  UserMessage,
} from "@earendil-works/pi-ai";
import type { ToolExecutionBackend } from "../tools/execution_backend.js";
import { truncateForTokens } from "../utils/truncate.js";

const ARCHIVE_TEXT_TOOL_RESULT_MAX_TOKENS = 256;
const ARCHIVE_WRITE_TIMEOUT_MS = 30_000;

const AUTO_COMPACTION_ARCHIVE_DOCUMENTATION = [
  "# Tau automatic compaction archives",
  "",
  "This directory contains temporary snapshots of model-visible context immediately before Tau automatic compaction. It is an agent recovery aid, not a durable backup.",
  "",
  "The compaction continuation requires this guide's full contents to be present in model context before work continues, even when no archive lookup is planned.",
  "",
  "## Files",
  "",
  "- `NNNNNN.txt` is a searchable transcript projection. User and assistant content is retained, while large tool results are middle-truncated.",
  "- `NNNNNN.json` is the matching structured snapshot. It retains full archived content, including tool results, but excludes assistant thinking.",
  "- Each numbered pair belongs to one compaction. A later pair contains the context visible at that time, which may include an earlier compaction summary instead of every older record. Inspect earlier pairs when necessary.",
  "",
  "The directory and files are private to the execution-environment user. Cleanup of the execution environment or its temporary directory may remove them.",
  "",
  "## JSON shape",
  "",
  "```json",
  "{",
  '  "version": 1,',
  '  "agentId": "agent-id",',
  '  "sequence": 1,',
  '  "createdAt": 1750000000000,',
  '  "messages": [',
  "    {",
  '      "historyEntryId": "entry-id",',
  '      "role": "user",',
  '      "timestamp": 1750000000000,',
  '      "content": [{ "type": "text", "text": "..." }]',
  "    },",
  "    {",
  '      "historyEntryId": "entry-id",',
  '      "role": "assistant",',
  '      "timestamp": 1750000000001,',
  '      "content": [',
  '        { "type": "text", "text": "..." },',
  '        { "type": "toolCall", "id": "call-id", "name": "bash", "arguments": {} }',
  "      ]",
  "    },",
  "    {",
  '      "historyEntryId": "entry-id",',
  '      "role": "toolResult",',
  '      "timestamp": 1750000000002,',
  '      "toolCallId": "call-id",',
  '      "toolName": "bash",',
  '      "isError": false,',
  '      "content": [{ "type": "text", "text": "..." }]',
  "    }",
  "  ]",
  "}",
  "```",
  "",
  "Content can also contain image records with `type`, `mimeType`, and base64 `data`. Text transcripts omit image data. History entry ids are the stable link between a JSON record and its text marker.",
  "",
  "## Lookup patterns",
  "",
  "Choose a bounded strategy appropriate to the missing detail. Do not dump a complete JSON snapshot when a focused projection or read is sufficient.",
  "",
  "When an exact archive entry id is known:",
  "",
  "```sh",
  "rg -n --fixed-strings 'entry-id' 000001.txt",
  "sed -n '120,180p' 000001.txt",
  "```",
  "",
  "When there is no clear key, a concise chronological overview can reveal where to drill down. The following is only an example; adapt or skip it based on the task:",
  "",
  "```sh",
  "node - 000001.json <<'NODE'",
  'const fs = require("node:fs");',
  'const archive = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));',
  "const flatten = (content) => content.map((part) =>",
  '  part.type === "text" ? part.text : part.type === "toolCall"',
  '    ? "[tool call " + part.name + "] " + JSON.stringify(part.arguments)',
  '    : "[image " + part.mimeType + "]"',
  ').join(" ").replace(/\\s+/g, " ").trim();',
  "const excerpt = (text, max = 256) => {",
  "  const chars = [...text];",
  "  if (chars.length <= max) return text;",
  '  const marker = " ... ";',
  "  const kept = max - marker.length;",
  "  const head = Math.ceil(kept / 2);",
  '  return chars.slice(0, head).join("") + marker + chars.slice(-(kept - head)).join("");',
  "};",
  "for (const message of archive.messages) {",
  '  const label = message.role === "assistant" ? "agent" : message.role === "toolResult"',
  '    ? "tool " + message.toolName : "user";',
  '  console.log("[" + label + " id=" + JSON.stringify("..." + message.historyEntryId.slice(-8)) + "] " + excerpt(flatten(message.content)));',
  "}",
  "NODE",
  "```",
  "",
  "Use promising ids or distinctive evidence from such a projection to inspect bounded text regions or matching JSON records. Prefer these files over Tau's separate `history` tool for current-session pre-compaction recovery; a configured remote history collection may lag or truncate replicated payloads.",
  "",
].join("\n");

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
const documentationPath = path.join(directory, "README.md");
const suffix = ".tmp-" + randomUUID();
const textTemporaryPath = textPath + suffix;
const jsonTemporaryPath = jsonPath + suffix;
const documentationTemporaryPath = documentationPath + suffix;
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
  "This is the archived conversation context immediately before automatic compaction.",
  "Tool results in this text projection are middle-truncated; the JSON pair retains full archived content.",
  "",
  payload.textTranscript,
  "",
].join("\\n");

try {
  fs.writeFileSync(documentationTemporaryPath, payload.documentation, {
    encoding: "utf8",
    flag: "wx",
    mode: 0o600,
  });
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
  fs.renameSync(documentationTemporaryPath, documentationPath);
  fs.renameSync(jsonTemporaryPath, jsonPath);
  fs.renameSync(textTemporaryPath, textPath);
  fs.chmodSync(documentationPath, 0o600);
  fs.chmodSync(jsonPath, 0o600);
  fs.chmodSync(textPath, 0o600);
} catch (error) {
  fs.rmSync(documentationTemporaryPath, { force: true });
  fs.rmSync(jsonTemporaryPath, { force: true });
  fs.rmSync(textTemporaryPath, { force: true });
  fs.rmSync(jsonPath, { force: true });
  fs.rmSync(textPath, { force: true });
  throw error;
}

process.stdout.write(JSON.stringify({ textPath, jsonPath, documentationPath }));
`.trim();

type ArchiveTextContent = Pick<TextContent, "type" | "text">;
type ArchiveImageContent = Pick<ImageContent, "type" | "data" | "mimeType">;
type ArchiveToolCall = Pick<ToolCall, "type" | "id" | "name" | "arguments">;
type ArchiveContent = ArchiveTextContent | ArchiveImageContent | ArchiveToolCall;

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
      content: Array<ArchiveTextContent | ArchiveToolCall>;
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
  documentationPath: string;
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
          documentation: AUTO_COMPACTION_ARCHIVE_DOCUMENTATION,
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
    content: message.content.flatMap<ArchiveTextContent | ArchiveToolCall>((content) => {
      if (content.type === "thinking") return [];
      if (content.type === "text") {
        return [{ type: content.type, text: content.text }];
      }
      return [
        {
          type: content.type,
          id: content.id,
          name: content.name,
          arguments: content.arguments,
        },
      ];
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
        return `[Tool call id=${JSON.stringify(block.id)} name=${JSON.stringify(block.name)}]\n${JSON.stringify(block.arguments)}`;
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
  const { textPath, jsonPath, documentationPath } = value as Record<string, unknown>;
  if (
    typeof textPath !== "string" ||
    !textPath.endsWith(".txt") ||
    typeof jsonPath !== "string" ||
    !jsonPath.endsWith(".json") ||
    typeof documentationPath !== "string" ||
    !documentationPath.endsWith("README.md")
  ) {
    throw new Error("auto-compaction archive writer returned invalid paths");
  }
  return { textPath, jsonPath, documentationPath };
}
