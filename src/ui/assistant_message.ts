import type { AssistantMessage } from "@mariozechner/pi-ai";
import { Container, Markdown, Spacer, Text } from "@mariozechner/pi-tui";
import { theme } from "./theme.js";

export class AssistantMessageComponent extends Container {
  private contentContainer: Container;
  private hideThinking = false;
  private leadingSpacer = true;
  private lastMessage?: AssistantMessage;

  constructor(message?: AssistantMessage) {
    super();
    this.contentContainer = new Container();
    this.addChild(this.contentContainer);

    if (message) {
      this.updateFromMessage(message);
    }
  }

  setHideThinking(hide: boolean) {
    this.hideThinking = hide;
    if (this.lastMessage) {
      this.updateFromMessage(this.lastMessage);
    }
  }

  setLeadingSpacer(enabled: boolean) {
    this.leadingSpacer = enabled;
  }

  updatePartial(text: string, thinking?: string) {
    const partial: AssistantMessage = {
      role: "assistant",
      api: "openai-responses",
      provider: "openai",
      model: "",
      timestamp: Date.now(),
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      content: [
        ...(thinking?.trim() ? [{ type: "thinking" as const, thinking }] : []),
        { type: "text" as const, text },
      ],
    };
    this.updateFromMessage(partial);
  }

  updateFromMessage(message: AssistantMessage): void {
    this.lastMessage = message;
    this.contentContainer.clear();

    if (
      this.leadingSpacer &&
      message.content.length > 0 &&
      message.content.some(
        (c) => (c.type === "text" && c.text.trim()) || (c.type === "thinking" && c.thinking.trim()),
      )
    ) {
      this.contentContainer.addChild(new Spacer(1));
    }

    for (let i = 0; i < message.content.length; i++) {
      const content = message.content[i]!;
      if (content.type === "text" && content.text.trim()) {
        this.contentContainer.addChild(
          new Markdown(content.text.trim(), 1, 0, theme.markdownTheme),
        );
        continue;
      }

      if (content.type === "thinking" && content.thinking.trim()) {
        if (this.hideThinking) {
          // Thinking is hidden unless toggled on.
          continue;
        }

        const hasTextAfter = message.content
          .slice(i + 1)
          .some((c) => c.type === "text" && c.text.trim());

        const thinkingText = normalizeEscapedNewlines(content.thinking).trim();

        this.contentContainer.addChild(
          new Markdown(thinkingText, 1, 0, theme.markdownTheme, {
            color: (t: string) => theme.palette.muted(t),
            italic: true,
          }),
        );
        if (hasTextAfter) this.contentContainer.addChild(new Spacer(1));
      }
    }

    if (message.stopReason === "aborted") {
      this.contentContainer.addChild(new Text(theme.palette.warn("\nAborted"), 1, 0));
    } else if (message.stopReason === "error") {
      const errorMsg = message.errorMessage || "Unknown error";
      this.contentContainer.addChild(new Spacer(1));
      this.contentContainer.addChild(new Text(theme.palette.error(`Error: ${errorMsg}`), 1, 0));
    }
  }
}

function normalizeEscapedNewlines(text: string): string {
  // Some providers/models occasionally emit "\n" sequences literally instead of actual newlines.
  // Only unescape when there are no real newlines present to avoid breaking legitimate backslashes.
  const hasRealNewlines = text.includes("\n");
  const hasEscapedNewlines = text.includes("\\n");
  if (hasEscapedNewlines && !hasRealNewlines) {
    return text.replaceAll("\\n", "\n");
  }
  return text;
}
