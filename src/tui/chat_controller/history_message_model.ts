import type { AssistantMessage, Message, ToolResultMessage } from "@earendil-works/pi-ai";
import { stripTauUserMetadata } from "../../core/utils/user_metadata.js";
import type { ChatMessageModel } from "../ui/chat_message_model.js";

export function buildHistoryMessageModel(message: Message): ChatMessageModel | undefined {
  if (message.role === "user") {
    const text = extractHistoryUserText(message);
    return text ? { type: "user", text } : undefined;
  }

  if (message.role === "assistant") {
    return { type: "assistant", message: message as AssistantMessage };
  }

  if (message.role !== "toolResult") {
    return undefined;
  }

  return {
    type: "system",
    text: formatToolResultNotice(message as ToolResultMessage),
    kind: "muted",
  };
}

export function extractHistoryUserText(message: Message): string {
  if (typeof message.content === "string") {
    return stripTauUserMetadata(message.content).trim();
  }

  const parts: string[] = [];
  for (const block of message.content) {
    if (block.type === "text") {
      parts.push(block.text);
    }
  }
  return stripTauUserMetadata(parts.join("\n")).trim();
}

function formatToolResultNotice(toolResult: ToolResultMessage): string {
  const status = toolResult.isError ? "error" : "ok";
  const icon = toolResult.isError ? "✗" : "✓";
  return `${icon} ${toolResult.toolName} (${status})`;
}
