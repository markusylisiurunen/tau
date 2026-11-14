import type { AssistantMessage, UserMessage } from "@earendil-works/pi-ai";
import type { IntermediateSystemMessage } from "../../protocol/system_message.js";
import { stripTauUserMetadataFromMessage } from "../utils/user_metadata.js";
import type { HistoryTextEntry } from "./types.js";

export function systemHistoryEntry(
  historyEntryId: string,
  message: IntermediateSystemMessage,
): HistoryTextEntry {
  return {
    id: historyEntryId,
    sourceIds: [historyEntryId],
    type: "system",
    timestamp: message.timestamp,
    content: message.content,
  };
}

export function userHistoryEntry(historyEntryId: string, message: UserMessage): HistoryTextEntry {
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
): HistoryTextEntry[] {
  return message.content.flatMap((content, contentIndex): HistoryTextEntry[] => {
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
