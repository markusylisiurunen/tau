import type { AssistantMessage, Message } from "@earendil-works/pi-ai";
import type { SessionProtocolSnapshot } from "../../protocol/session_protocol.js";
import { extractAssistantText, extractUserText } from "./messages.js";
import { truncateForTokens } from "./truncate.js";

const MAX_SPEECH_TO_TEXT_CONTEXT_TURNS = 2;
const MAX_SPEECH_TO_TEXT_CONTEXT_MESSAGE_TOKENS = 4_096;

export type SpeechToTextContextMessage = {
  role: "user" | "assistant";
  text: string;
};

export type SpeechToTextContext = {
  messages: SpeechToTextContextMessage[];
};

export function collectSpeechToTextContext(snapshot: SessionProtocolSnapshot): SpeechToTextContext {
  const startIndex = findContextStartIndex(snapshot);
  if (startIndex === undefined) {
    return { messages: [] };
  }

  const messages: SpeechToTextContextMessage[] = [];
  for (let index = startIndex; index < snapshot.messages.length; index += 1) {
    const entry = snapshot.messages[index];
    if (entry?.state !== "committed") {
      continue;
    }

    const message = entry.message;
    if (message.role === "user") {
      const text = truncateContextMessage(extractUserText(message as Message));
      if (text) {
        messages.push({ role: "user", text });
      }
      continue;
    }

    if (message.role === "assistant" && isAssistantFinalResponse(message as AssistantMessage)) {
      const text = truncateContextMessage(extractAssistantText(message as AssistantMessage));
      if (text) {
        messages.push({ role: "assistant", text });
      }
    }
  }

  return { messages };
}

export function formatSpeechToTextContext(context: SpeechToTextContext | undefined): string {
  const messages = context?.messages.filter((message) => message.text.trim()) ?? [];
  if (messages.length === 0) {
    return "";
  }

  return [
    "<speech-to-text-context>",
    ...messages.flatMap((message, index) => [
      `  <message index="${index + 1}" role="${message.role}">`,
      escapeXml(message.text.trim()),
      "  </message>",
    ]),
    "</speech-to-text-context>",
  ].join("\n");
}

function escapeXml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function findContextStartIndex(snapshot: SessionProtocolSnapshot): number | undefined {
  let turns = 0;

  for (let index = snapshot.messages.length - 1; index >= 0; index -= 1) {
    const entry = snapshot.messages[index];
    if (entry?.state !== "committed" || entry.message.role !== "user") {
      continue;
    }

    turns += 1;
    if (turns >= MAX_SPEECH_TO_TEXT_CONTEXT_TURNS) {
      return index;
    }
  }

  return turns > 0
    ? snapshot.messages.findIndex(
        (entry) => entry.state === "committed" && entry.message.role === "user",
      )
    : undefined;
}

function isAssistantFinalResponse(message: AssistantMessage): boolean {
  return message.content.every((part) => part.type !== "toolCall");
}

function truncateContextMessage(text: string): string {
  return truncateForTokens(text.trim(), {
    maxTokens: MAX_SPEECH_TO_TEXT_CONTEXT_MESSAGE_TOKENS,
    strategy: "middle",
  }).content.trim();
}
