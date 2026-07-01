import type { AssistantMessage } from "@earendil-works/pi-ai";
import { extractAllFencedCodeBlocks, extractAssistantText } from "../../core/utils/messages.js";
import type { ChatView } from "../chat_view.js";
import { copyTextToClipboard } from "../clipboard.js";

export async function copyAssistantTextToClipboard(options: {
  view: ChatView;
  message: AssistantMessage | undefined;
}): Promise<void> {
  if (!options.message) {
    options.view.addSystemMessage("no assistant message to copy yet.", "warn");
    return;
  }

  const text = extractAssistantText(options.message);
  if (!text.trim()) {
    options.view.addSystemMessage("last assistant message was empty.", "warn");
    return;
  }

  try {
    await copyTextToClipboard(text);
    options.view.addSystemMessage("copied last assistant message to clipboard.", "success");
  } catch (error) {
    options.view.addSystemMessage(`clipboard copy failed: ${(error as Error).message}`, "error");
  }
}

export async function copyAssistantCodeToClipboard(options: {
  view: ChatView;
  message: AssistantMessage | undefined;
}): Promise<void> {
  if (!options.message) {
    options.view.addSystemMessage("no assistant message to copy yet.", "warn");
    return;
  }

  const code = extractAllFencedCodeBlocks(extractAssistantText(options.message));
  if (!code) {
    options.view.addSystemMessage("no code block to copy yet.", "warn");
    return;
  }

  try {
    await copyTextToClipboard(code);
    options.view.addSystemMessage("copied all code blocks to clipboard.", "success");
  } catch (error) {
    options.view.addSystemMessage(`clipboard copy failed: ${(error as Error).message}`, "error");
  }
}
