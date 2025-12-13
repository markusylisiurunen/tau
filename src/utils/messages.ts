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

export function extractLastFencedCodeBlock(text: string): string | null {
  // Match all triple-backtick fenced code blocks with optional language specifier
  // Allows optional spaces after opening fence, any language/info string, optional trailing spaces
  // on closing fence, and both LF and CRLF line endings
  const codeBlockRegex = /^```[ \t]*[^\r\n]*\r?\n([\s\S]*?)\r?\n```[ \t]*$/gm;

  let lastMatch: RegExpExecArray | null = null;
  let match = codeBlockRegex.exec(text);

  while (match !== null) {
    lastMatch = match;
    match = codeBlockRegex.exec(text);
  }

  if (!lastMatch) {
    return null;
  }

  // Return the captured group (inner code content)
  return lastMatch[1] ?? null;
}
