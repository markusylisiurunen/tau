import type { AssistantMessage, Message, ToolResultMessage } from "@earendil-works/pi-ai";
import { TOOL_NAME_EDIT } from "../tools/tool_names.js";
import { buildLineDiff, collapseLongUnchangedDiffRuns } from "./line_diff.js";
import { truncateForTokens } from "./truncate.js";
import { hasToolRecoveryMetadata, stripTauUserMetadata } from "./user_metadata.js";

export const COMPACTION_SUMMARY_HEADER =
  "The conversation history before this point was compacted into the following summary:";
const SUMMARY_OPEN_TAG = "<summary>";
const SUMMARY_CLOSE_TAG = "</summary>";
const LAST_ASSISTANT_OPEN_TAG = "<last-assistant-message-verbatim>";
const LAST_ASSISTANT_CLOSE_TAG = "</last-assistant-message-verbatim>";
const TOOL_EXECUTION_RECORDS_OPEN_TAG = "<tool-execution-records>";
const TOOL_EXECUTION_RECORDS_CLOSE_TAG = "</tool-execution-records>";
const TOOL_RESULT_TEXT_PATTERN = /(<result-text>)([\s\S]*?)(<\/result-text>)/g;
const COMPACTION_TOOL_RESULT_MAX_TOKENS = 2048;
const COMPACTION_EDIT_UNCHANGED_CONTEXT_LINES = 8;

function extractTextFromContent(content: Message["content"]): string {
  if (typeof content === "string") {
    return content.trim();
  }

  const parts: string[] = [];
  for (const block of content) {
    if (typeof block === "string") {
      parts.push(block);
    } else if (block.type === "text") {
      parts.push(block.text ?? "");
    }
  }

  return parts.join("\n").trim();
}

function formatCompactionBlock(marker: string, text: string): string {
  return `${marker}\n${text}`;
}

function escapeXmlText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function unescapeXmlText(text: string): string {
  return text.replace(/&(amp|lt|gt);/g, (_match, entity: string) => {
    if (entity === "amp") return "&";
    if (entity === "lt") return "<";
    return ">";
  });
}

export function truncateToolRecoveryResults(
  text: string,
  maxTokens = COMPACTION_TOOL_RESULT_MAX_TOKENS,
): string {
  let output = "";
  let cursor = 0;

  while (cursor < text.length) {
    const recordsStart = text.indexOf(TOOL_EXECUTION_RECORDS_OPEN_TAG, cursor);
    if (recordsStart < 0) {
      return output + text.slice(cursor);
    }

    const recordsContentStart = recordsStart + TOOL_EXECUTION_RECORDS_OPEN_TAG.length;
    const recordsEnd = text.indexOf(TOOL_EXECUTION_RECORDS_CLOSE_TAG, recordsContentStart);
    if (recordsEnd < 0) {
      return output + text.slice(cursor);
    }

    const records = text
      .slice(recordsContentStart, recordsEnd)
      .replace(
        TOOL_RESULT_TEXT_PATTERN,
        (_match, openTag: string, escapedText: string, closeTag: string) => {
          const content = truncateForTokens(unescapeXmlText(escapedText), {
            maxTokens,
            strategy: "middle",
          }).content;
          return `${openTag}${escapeXmlText(content)}${closeTag}`;
        },
      );
    output += text.slice(cursor, recordsContentStart) + records + TOOL_EXECUTION_RECORDS_CLOSE_TAG;
    cursor = recordsEnd + TOOL_EXECUTION_RECORDS_CLOSE_TAG.length;
  }

  return output;
}

function formatToolCallArguments(argumentsValue: unknown): string {
  if (!argumentsValue || typeof argumentsValue !== "object") {
    return JSON.stringify(argumentsValue) ?? "null";
  }

  return Object.entries(argumentsValue as Record<string, unknown>)
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
    .join(", ");
}

function buildEditCallDiff(argumentsValue: unknown): string {
  if (!argumentsValue || typeof argumentsValue !== "object") {
    return "(diff unavailable)";
  }

  const args = argumentsValue as Record<string, unknown>;
  const oldText = typeof args.oldText === "string" ? args.oldText : "";
  const newText = typeof args.newText === "string" ? args.newText : "";

  const diff = buildLineDiff(oldText, newText);
  if (diff.added === 0 && diff.removed === 0) {
    return "(no textual changes)";
  }

  const collapsed = collapseLongUnchangedDiffRuns({
    diffLines: diff.lines,
    maxUnchangedLines: COMPACTION_EDIT_UNCHANGED_CONTEXT_LINES,
  });

  return collapsed.join("\n").trim() || "(no textual changes)";
}

function serializeToolCall(name: string, argumentsValue: unknown): string {
  if (name === TOOL_NAME_EDIT) {
    const args =
      argumentsValue && typeof argumentsValue === "object"
        ? (argumentsValue as Record<string, unknown>)
        : undefined;
    const path = typeof args?.path === "string" ? args.path : undefined;
    const header = path ? `${TOOL_NAME_EDIT}(path=${JSON.stringify(path)})` : `${TOOL_NAME_EDIT}()`;
    return `${header}\n${buildEditCallDiff(argumentsValue)}`;
  }

  const args = formatToolCallArguments(argumentsValue);
  return `${name}(${args})`;
}

function serializeAssistantMessage(message: AssistantMessage, historyEntryId?: string): string[] {
  const textParts: string[] = [];
  const toolCalls: string[] = [];

  for (const block of message.content) {
    if (block.type === "text") {
      textParts.push(block.text);
    } else if (block.type === "toolCall") {
      toolCalls.push(serializeToolCall(block.name, block.arguments));
    }
  }

  const lines: string[] = [];
  if (textParts.length > 0) {
    const marker = historyEntryId
      ? `[Assistant id=${JSON.stringify(historyEntryId)}]:`
      : "[Assistant]:";
    lines.push(formatCompactionBlock(marker, textParts.join("\n")));
  }
  if (toolCalls.length > 0) {
    const marker = historyEntryId
      ? `[Assistant tool calls id=${JSON.stringify(historyEntryId)}]:`
      : "[Assistant tool calls]:";
    lines.push(formatCompactionBlock(marker, toolCalls.join("\n\n")));
  }

  return lines;
}

function serializeToolResultMessage(message: ToolResultMessage, historyEntryId?: string): string {
  const outputText = extractTextFromContent(message.content);
  const status = message.isError ? "error" : "ok";

  const content = truncateForTokens(outputText || "(no text output)", {
    maxTokens: COMPACTION_TOOL_RESULT_MAX_TOKENS,
    strategy: "middle",
  }).content;

  const marker = historyEntryId
    ? `[Tool result id=${JSON.stringify(historyEntryId)}]: ${message.toolName} (${status})`
    : `[Tool result]: ${message.toolName} (${status})`;
  return formatCompactionBlock(marker, content);
}

export function formatHistoryForCompaction(
  history: readonly Message[],
  options?: { systemPrompt?: string; historyEntryIds?: ReadonlyMap<Message, string> },
): string {
  const lines: string[] = [];
  const systemPrompt = options?.systemPrompt?.trim();
  if (systemPrompt) {
    lines.push(formatCompactionBlock("[System prompt]:", systemPrompt));
  }

  for (const message of history) {
    if (message.role === "user") {
      const userText = stripTauUserMetadata(extractTextFromContent(message.content));
      const text = hasToolRecoveryMetadata(message)
        ? truncateToolRecoveryResults(userText)
        : userText;
      if (text) {
        const id = options?.historyEntryIds?.get(message);
        const marker = id ? `[User id=${JSON.stringify(id)}]:` : "[User]:";
        lines.push(formatCompactionBlock(marker, text));
      }
      continue;
    }

    if (message.role === "assistant") {
      lines.push(
        ...serializeAssistantMessage(
          message as AssistantMessage,
          options?.historyEntryIds?.get(message),
        ),
      );
      continue;
    }

    if (message.role === "toolResult") {
      lines.push(
        serializeToolResultMessage(
          message as ToolResultMessage,
          options?.historyEntryIds?.get(message),
        ),
      );
    }
  }

  return lines.join("\n\n").trim();
}

export function buildCompactionUserMessage(args: {
  summary: string;
  lastAssistantMessage?: string;
}): string {
  const lines = [
    COMPACTION_SUMMARY_HEADER,
    "",
    SUMMARY_OPEN_TAG,
    args.summary.trim(),
    SUMMARY_CLOSE_TAG,
  ];

  const lastAssistantMessage = args.lastAssistantMessage;
  if (lastAssistantMessage?.trim()) {
    lines.push("", LAST_ASSISTANT_OPEN_TAG, lastAssistantMessage, LAST_ASSISTANT_CLOSE_TAG);
  }

  return lines.join("\n");
}
