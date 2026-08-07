import type { AssistantMessage, Message, ToolResultMessage } from "@earendil-works/pi-ai";
import { extractUserText } from "../../core/utils/messages.js";
import { hasDiffReviewMetadata } from "../../core/utils/user_metadata.js";
import type { ChatMessageModel } from "../ui/chat_message_model.js";

export function buildHistoryMessageModel(message: Message): ChatMessageModel | undefined {
  if (message.role === "user") {
    const text = extractHistoryUserText(message);
    return text.trim()
      ? { type: "user", text, ...(hasDiffReviewMetadata(message) ? { kind: "review" } : {}) }
      : undefined;
  }

  if (message.role === "assistant") {
    return { type: "assistant", message: message as AssistantMessage };
  }

  if (message.role !== "toolResult") {
    return undefined;
  }

  return {
    type: "transcript_notice",
    title: formatToolResultNotice(message as ToolResultMessage),
    tone: "default",
  };
}

export function extractHistoryUserText(message: Message): string {
  return extractUserText(message);
}

function formatToolResultNotice(toolResult: ToolResultMessage): string {
  const status = toolResult.isError ? "error" : "ok";
  const icon = toolResult.isError ? "✗" : "✓";
  return `${icon} ${toolResult.toolName} (${status})`;
}
