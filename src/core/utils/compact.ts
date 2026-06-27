import type { AssistantMessage, Message, ToolResultMessage } from "@earendil-works/pi-ai";
import { TOOL_NAME_BASH, TOOL_NAME_EDIT } from "../tools/tool_names.js";
import { buildLineDiff, collapseLongUnchangedDiffRuns } from "./line_diff.js";
import { truncateForTokens } from "./truncate.js";
import { stripTauUserMetadata } from "./user_metadata.js";

export const COMPACTION_SUMMARY_HEADER =
  "The conversation history before this point was compacted into the following summary:";
const SUMMARY_OPEN_TAG = "<summary>";
const SUMMARY_CLOSE_TAG = "</summary>";
const LAST_ASSISTANT_OPEN_TAG = "<last-assistant-message-verbatim>";
const LAST_ASSISTANT_CLOSE_TAG = "</last-assistant-message-verbatim>";
const COMPACTION_BASH_TOOL_RESULT_MAX_TOKENS = 4096;
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

function serializeAssistantMessage(message: AssistantMessage): string[] {
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
    lines.push(formatCompactionBlock("[Assistant]:", textParts.join("\n")));
  }
  if (toolCalls.length > 0) {
    lines.push(formatCompactionBlock("[Assistant tool calls]:", toolCalls.join("\n\n")));
  }

  return lines;
}

function serializeToolResultMessage(message: ToolResultMessage): string {
  const outputText = extractTextFromContent(message.content);
  const status = message.isError ? "error" : "ok";

  let content = outputText || "(no text output)";
  if (message.toolName === TOOL_NAME_BASH) {
    content = truncateForTokens(content, {
      maxTokens: COMPACTION_BASH_TOOL_RESULT_MAX_TOKENS,
      strategy: "middle",
    }).content;
  }

  return formatCompactionBlock(`[Tool result]: ${message.toolName} (${status})`, content);
}

export function formatHistoryForCompaction(
  history: readonly Message[],
  options?: { systemPrompt?: string; userMessageIds?: ReadonlyMap<Message, string> },
): string {
  const lines: string[] = [];
  const systemPrompt = options?.systemPrompt?.trim();
  if (systemPrompt) {
    lines.push(formatCompactionBlock("[System prompt]:", systemPrompt));
  }

  for (const message of history) {
    if (message.role === "user") {
      const text = stripTauUserMetadata(extractTextFromContent(message.content));
      if (text) {
        const id = options?.userMessageIds?.get(message);
        const marker = id ? `[User id=${JSON.stringify(id)}]:` : "[User]:";
        lines.push(formatCompactionBlock(marker, text));
      }
      continue;
    }

    if (message.role === "assistant") {
      lines.push(...serializeAssistantMessage(message as AssistantMessage));
      continue;
    }

    if (message.role === "toolResult") {
      lines.push(serializeToolResultMessage(message as ToolResultMessage));
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
