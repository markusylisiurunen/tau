import type { AssistantMessage, Message, ToolCall, ToolResultMessage } from "@mariozechner/pi-ai";

export function formatHistoryForCompression(history: readonly Message[]): string {
  const lines: string[] = [];

  for (const message of history) {
    if (message.role === "user") {
      lines.push("--- USER ---");
      for (const block of message.content) {
        if (typeof block === "string") {
          lines.push(block);
        } else if (block.type === "text") {
          lines.push(block.text);
        }
      }
      lines.push("");
    } else if (message.role === "assistant") {
      lines.push("--- ASSISTANT ---");
      const assistantMsg = message as AssistantMessage;
      for (const block of assistantMsg.content) {
        if (block.type === "text") {
          lines.push(block.text);
        } else if (block.type === "toolCall") {
          const toolCall = block as ToolCall;
          lines.push(`[Tool call: ${toolCall.name}(${JSON.stringify(toolCall.arguments)})]`);
        } else if (block.type === "thinking") {
          // Skip thinking blocks for compression
        }
      }
      lines.push("");
    } else if (message.role === "toolResult") {
      const toolResult = message as ToolResultMessage;
      lines.push(`[Tool output: ${toolResult.toolName} (truncated)]`);
      lines.push("");
    }
  }

  return lines.join("\n").trim();
}
