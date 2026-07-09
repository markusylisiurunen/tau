import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import type { SessionProtocolSnapshot } from "../../protocol/session_protocol.js";
import { extractAssistantText, extractUserText } from "./messages.js";

const MAX_SPEECH_TO_TEXT_CONTEXT_MESSAGES_PER_ROLE = 2;
const MAX_SPEECH_TO_TEXT_CONTEXT_MESSAGE_CHARS = 2_000;

export type SpeechToTextContextMessage = {
  role: "user" | "assistant";
  text: string;
};

export type SpeechToTextContext = {
  messages: SpeechToTextContextMessage[];
};

export function collectSpeechToTextContext(snapshot: SessionProtocolSnapshot): SpeechToTextContext {
  const selected: SpeechToTextContextMessage[] = [];
  let userMessages = 0;
  let assistantMessages = 0;

  for (let index = snapshot.messages.length - 1; index >= 0; index -= 1) {
    const entry = snapshot.messages[index];
    if (entry?.state !== "committed") {
      continue;
    }

    const message = entry.message;
    if (message.role === "user") {
      if (userMessages >= MAX_SPEECH_TO_TEXT_CONTEXT_MESSAGES_PER_ROLE) {
        continue;
      }
      const text = truncateContextMessage(extractUserText(message as Message));
      if (!text) {
        continue;
      }
      selected.push({ role: "user", text });
      userMessages += 1;
      continue;
    }

    if (message.role === "assistant") {
      if (assistantMessages >= MAX_SPEECH_TO_TEXT_CONTEXT_MESSAGES_PER_ROLE) {
        continue;
      }
      const text = truncateContextMessage(extractAssistantText(message as AssistantMessage));
      if (!text) {
        continue;
      }
      selected.push({ role: "assistant", text });
      assistantMessages += 1;
    }
  }

  selected.reverse();
  return { messages: selected };
}

export function formatSpeechToTextContext(context: SpeechToTextContext | undefined): string {
  const messages = context?.messages.filter((message) => message.text.trim()) ?? [];
  if (messages.length === 0) {
    return "";
  }

  return messages
    .map((message, index) => {
      const label = message.role === "user" ? "User" : "Assistant";
      return `${index + 1}. ${label}: ${message.text.trim()}`;
    })
    .join("\n\n");
}

function truncateContextMessage(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length <= MAX_SPEECH_TO_TEXT_CONTEXT_MESSAGE_CHARS) {
    return trimmed;
  }
  return `${trimmed.slice(0, MAX_SPEECH_TO_TEXT_CONTEXT_MESSAGE_CHARS).trimEnd()}…`;
}
