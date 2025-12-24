import type { AssistantMessageInput, Message, ToolMessage } from "@markusylisiurunen/iota";

export function formatHistoryForCompression(history: readonly Message[]): string {
  const lines: string[] = [];

  for (const message of history) {
    if (message.role === "user") {
      lines.push("--- USER ---");
      lines.push(message.content);
      lines.push("");
      continue;
    }

    if (message.role === "assistant") {
      lines.push("--- ASSISTANT ---");

      const assistantMsg = message as AssistantMessageInput;
      const parts = Array.isArray(assistantMsg.content)
        ? assistantMsg.content
        : [{ type: "text" as const, text: assistantMsg.content }];

      for (const part of parts) {
        if (part.type === "text") {
          lines.push(part.text);
        } else if (part.type === "tool_call") {
          lines.push(`[Tool call: ${part.name}(${JSON.stringify(part.args)})]`);
        } else if (part.type === "thinking") {
          // Skip thinking blocks for compression
        }
      }

      lines.push("");
      continue;
    }

    if (message.role === "tool") {
      const toolResult = message as ToolMessage;
      lines.push(`[Tool output: ${toolResult.toolName} (truncated)]`);
      lines.push("");
    }
  }

  return lines.join("\n").trim();
}
