import type { AssistantMessage, Message, ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import { stripTauUserDisplayText } from "./user_metadata.js";

export function extractAssistantText(message: AssistantMessage): string {
  return message.content
    .filter((c) => c.type === "text")
    .map((c) => c.text)
    .join("\n")
    .trim();
}

export function extractUserText(message: Message): string {
  if (message.role !== "user") {
    return "";
  }

  if (typeof message.content === "string") {
    return stripTauUserDisplayText(message.content);
  }

  return stripTauUserDisplayText(
    message.content
      .filter((block) => block.type === "text")
      .map((block) => block.text)
      .join("\n"),
  );
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

export function extractAllFencedCodeBlocks(text: string): string | null {
  // Match all triple-backtick fenced code blocks with optional language specifier
  // Allows optional spaces after opening fence, any language/info string, optional trailing spaces
  // on closing fence, and both LF and CRLF line endings
  const codeBlockRegex = /^```[ \t]*[^\r\n]*\r?\n([\s\S]*?)\r?\n```[ \t]*$/gm;

  const codeBlocks: string[] = [];
  let match = codeBlockRegex.exec(text);

  while (match !== null) {
    codeBlocks.push(match[1] ?? "");
    match = codeBlockRegex.exec(text);
  }

  if (codeBlocks.length === 0) {
    return null;
  }

  const normalizedBlocks = codeBlocks.map((block) =>
    block.replace(/^\r?\n+/, "").replace(/\r?\n+$/, ""),
  );

  return normalizedBlocks.join("\n\n");
}
