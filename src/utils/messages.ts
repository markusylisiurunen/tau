import type { AssistantMessage, ToolCall, ToolResultMessage } from "@mariozechner/pi-ai";

export function extractAssistantText(message: AssistantMessage): string {
  return message.content
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n")
    .trim();
}

export function createToolResult(
  toolCall: ToolCall,
  text: string,
  isError: boolean,
): ToolResultMessage {
  return {
    role: "toolResult",
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    content: [{ type: "text", text }],
    isError: isError,
    timestamp: Date.now(),
  };
}

export function createToolError(toolCall: ToolCall, errorMessage: string): ToolResultMessage {
  return createToolResult(toolCall, errorMessage, true);
}

export function createToolSuccess(toolCall: ToolCall, text: string): ToolResultMessage {
  return createToolResult(toolCall, text, false);
}
