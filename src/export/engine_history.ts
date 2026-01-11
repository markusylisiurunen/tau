import type { AssistantMessage, Message, ToolCall, ToolResultMessage } from "@mariozechner/pi-ai";
import type { ExportEntry, ExportToolCall } from "./types.js";

function extractTextBlocks(content: Array<string | { type: string; text?: string }>): string {
  const parts: string[] = [];
  for (const block of content) {
    if (typeof block === "string") {
      parts.push(block);
    } else if (block.type === "text") {
      parts.push(block.text ?? "");
    }
  }
  return parts.join("\n").replace(/\s+$/, "");
}

function extractToolCalls(message: AssistantMessage): ExportToolCall[] {
  const calls: ExportToolCall[] = [];
  for (const block of message.content) {
    if (block.type === "toolCall") {
      const toolCall = block as ToolCall;
      calls.push({ id: toolCall.id, name: toolCall.name, arguments: toolCall.arguments });
    }
  }
  return calls;
}

export function buildExportEntriesFromHistory(history: readonly Message[]): ExportEntry[] {
  const entries: ExportEntry[] = [];
  const toolCallsById = new Map<string, ExportToolCall>();

  for (const message of history) {
    if (message.role === "user") {
      const text = extractTextBlocks(
        message.content as Array<string | { type: string; text?: string }>,
      );
      entries.push({ kind: "user", text, timestamp: message.timestamp });
      continue;
    }

    if (message.role === "assistant") {
      const assistant = message as AssistantMessage;
      const text = extractTextBlocks(
        assistant.content as Array<string | { type: string; text?: string }>,
      );
      const toolCalls = extractToolCalls(assistant);
      for (const call of toolCalls) {
        toolCallsById.set(call.id, call);
      }
      entries.push({ kind: "assistant", text, toolCalls, timestamp: assistant.timestamp });
      continue;
    }

    if (message.role === "toolResult") {
      const toolResult = message as ToolResultMessage;
      const text = extractTextBlocks(
        toolResult.content as Array<string | { type: string; text?: string }>,
      );
      entries.push({
        kind: "tool",
        toolName: toolResult.toolName,
        text,
        isError: Boolean(toolResult.isError),
        toolCall: toolCallsById.get(toolResult.toolCallId),
        timestamp: toolResult.timestamp,
      });
    }
  }

  return entries;
}
