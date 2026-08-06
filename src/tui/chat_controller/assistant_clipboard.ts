import type { AssistantMessage } from "@earendil-works/pi-ai";
import { extractAllFencedCodeBlocks, extractAssistantText } from "../../core/utils/messages.js";
import type { ChatView } from "../chat_view.js";
import { copyTextToClipboard } from "../clipboard.js";

export async function copyAssistantTextToClipboard(options: {
  view: ChatView;
  message: AssistantMessage | undefined;
}): Promise<void> {
  if (!options.message) {
    options.view.showFooterNotice("no assistant message to copy yet.", "default");
    return;
  }

  const text = extractAssistantText(options.message);
  if (!text.trim()) {
    options.view.showFooterNotice("last assistant message was empty.", "default");
    return;
  }

  try {
    await copyTextToClipboard(text);
    options.view.showFooterNotice("copied last assistant message to clipboard.", "default");
  } catch (error) {
    options.view.addTranscriptNotice("failed to copy to clipboard", "error", [
      (error as Error).message,
    ]);
  }
}

export async function copyAssistantCodeToClipboard(options: {
  view: ChatView;
  message: AssistantMessage | undefined;
}): Promise<void> {
  if (!options.message) {
    options.view.showFooterNotice("no assistant message to copy yet.", "default");
    return;
  }

  const code = extractAllFencedCodeBlocks(extractAssistantText(options.message));
  if (!code) {
    options.view.showFooterNotice("no code block to copy yet.", "default");
    return;
  }

  try {
    await copyTextToClipboard(code);
    options.view.showFooterNotice("copied all code blocks to clipboard.", "default");
  } catch (error) {
    options.view.addTranscriptNotice("failed to copy to clipboard", "error", [
      (error as Error).message,
    ]);
  }
}
