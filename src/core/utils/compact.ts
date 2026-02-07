import type { AssistantMessage, Message, ToolResultMessage } from "@mariozechner/pi-ai";

export const COMPACTION_SUMMARY_HEADER =
  "The conversation history before this point was compacted into the following summary:";
const SUMMARY_OPEN_TAG = "<summary>";
const SUMMARY_CLOSE_TAG = "</summary>";
const LAST_ASSISTANT_OPEN_TAG = "<last_assistant_message_verbatim>";
const LAST_ASSISTANT_CLOSE_TAG = "</last_assistant_message_verbatim>";

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

function formatToolCallArguments(argumentsValue: unknown): string {
  if (!argumentsValue || typeof argumentsValue !== "object") {
    return JSON.stringify(argumentsValue) ?? "null";
  }

  return Object.entries(argumentsValue as Record<string, unknown>)
    .map(([key, value]) => `${key}=${JSON.stringify(value)}`)
    .join(", ");
}

function serializeAssistantMessage(message: AssistantMessage): string[] {
  const textParts: string[] = [];
  const toolCalls: string[] = [];

  for (const block of message.content) {
    if (block.type === "text") {
      textParts.push(block.text);
    } else if (block.type === "toolCall") {
      const args = formatToolCallArguments(block.arguments);
      toolCalls.push(`${block.name}(${args})`);
    }
  }

  const lines: string[] = [];
  if (textParts.length > 0) {
    lines.push(`[Assistant]: ${textParts.join("\n")}`);
  }
  if (toolCalls.length > 0) {
    lines.push(`[Assistant tool calls]: ${toolCalls.join("; ")}`);
  }

  return lines;
}

function serializeToolResultMessage(message: ToolResultMessage): string {
  const outputText = extractTextFromContent(message.content);
  const status = message.isError ? "error" : "ok";
  const content = outputText || "(no text output)";
  return `[Tool result]: ${message.toolName} (${status}) ${content}`;
}

export function formatHistoryForCompaction(history: readonly Message[]): string {
  const lines: string[] = [];

  for (const message of history) {
    if (message.role === "user") {
      const text = extractTextFromContent(message.content);
      if (text) {
        lines.push(`[User]: ${text}`);
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

export function extractCompactionSummaryFromText(text: string): string | undefined {
  if (!text.includes(COMPACTION_SUMMARY_HEADER)) {
    return undefined;
  }

  const summaryStart = text.indexOf(SUMMARY_OPEN_TAG);
  if (summaryStart === -1) {
    return undefined;
  }

  const summaryContentStart = summaryStart + SUMMARY_OPEN_TAG.length;
  const summaryEnd = text.indexOf(SUMMARY_CLOSE_TAG, summaryContentStart);
  if (summaryEnd === -1) {
    return undefined;
  }

  const summary = text.slice(summaryContentStart, summaryEnd).trim();
  return summary || undefined;
}

export function extractCompactionSummaryFromMessage(message: Message): string | undefined {
  if (message.role !== "user") {
    return undefined;
  }

  const text = extractTextFromContent(message.content);
  if (!text) {
    return undefined;
  }

  return extractCompactionSummaryFromText(text);
}

export function partitionHistoryForCompaction(history: readonly Message[]): {
  previousSummary?: string;
  messagesToSummarize: Message[];
} {
  const messagesToSummarize: Message[] = [];
  let previousSummary: string | undefined;

  for (const message of history) {
    const summary = extractCompactionSummaryFromMessage(message);
    if (summary) {
      previousSummary = summary;
      continue;
    }

    messagesToSummarize.push(message);
  }

  return { previousSummary, messagesToSummarize };
}
