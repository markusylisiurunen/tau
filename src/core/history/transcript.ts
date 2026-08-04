import type {
  AssistantMessage,
  ToolCall,
  ToolResultMessage,
  UserMessage,
} from "@earendil-works/pi-ai";
import { stripTauUserMetadataFromMessage } from "../utils/user_metadata.js";
import type { HistoryEntry, HistoryToolEntry } from "./types.js";

export function userHistoryEntry(historyEntryId: string, message: UserMessage): HistoryEntry {
  const stripped = stripTauUserMetadataFromMessage(message) as UserMessage;
  return {
    id: historyEntryId,
    sourceIds: [historyEntryId],
    type: "user",
    timestamp: message.timestamp,
    content: structuredClone(stripped.content),
  };
}

export function assistantHistoryEntries(
  historyEntryId: string,
  message: AssistantMessage,
): HistoryEntry[] {
  return message.content.flatMap((content, contentIndex): HistoryEntry[] => {
    if (content.type !== "text" || content.text.length === 0) return [];
    return [
      {
        id: `${historyEntryId}:text:${contentIndex}`,
        sourceIds: [historyEntryId],
        type: "assistant",
        timestamp: message.timestamp,
        content: content.text,
      },
    ];
  });
}

export function toolHistoryEntry(options: {
  callHistoryEntryId: string;
  resultHistoryEntryId: string;
  call: ToolCall;
  result: ToolResultMessage;
  outcome: HistoryToolEntry["outcome"];
}): HistoryToolEntry {
  return {
    id: options.call.id,
    sourceIds: [options.callHistoryEntryId, options.resultHistoryEntryId],
    type: "tool",
    timestamp: options.result.timestamp,
    name: options.call.name,
    arguments: structuredClone(options.call.arguments),
    result: structuredClone(options.result.content),
    outcome: options.outcome,
  };
}
