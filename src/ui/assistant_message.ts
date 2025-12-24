import { Container, Markdown, Spacer, Text } from "@mariozechner/pi-tui";
import type { AssistantMessage } from "@markusylisiurunen/iota";
import { theme } from "./theme.js";

export class AssistantMessageComponent extends Container {
  private contentContainer: Container;
  private thoughtsVisible: boolean;
  private currentMessage: AssistantMessage | null = null;

  private _hasVisibleText: boolean = false;

  public get hasVisibleText(): boolean {
    return this._hasVisibleText;
  }

  constructor(message?: AssistantMessage, thoughtsVisible = false) {
    super();

    this.contentContainer = new Container();
    this.thoughtsVisible = thoughtsVisible;

    this.addChild(this.contentContainer);

    if (message) {
      this.updateFromMessage(message);
    }
  }

  setThinkingVisibility(visible: boolean): void {
    this.thoughtsVisible = visible;

    if (this.currentMessage !== null) {
      this.updateFromMessage(this.currentMessage);
    }
  }

  updatePartial(text: string, thinking?: string): void {
    const partial: AssistantMessage = {
      role: "assistant",
      provider: "openai",
      model: "",
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        cacheWriteTokens: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      content: [
        ...(thinking?.trim() ? [{ type: "thinking" as const, text: thinking }] : []),
        { type: "text" as const, text },
      ],
    };
    this.updateFromMessage(partial);
  }

  updateFromMessage(message: AssistantMessage): void {
    const { palette, markdownTheme } = theme;

    this.currentMessage = message;
    this.contentContainer.clear();
    this._hasVisibleText = false;

    for (let i = 0; i < message.content.length; i++) {
      const content = message.content[i]!;

      if (this.thoughtsVisible && content.type === "thinking" && content.text.trim()) {
        this.contentContainer.addChild(
          new Markdown(content.text.trim(), 1, 0, markdownTheme, {
            color: (t: string) => palette.thinking(t),
            italic: true,
          }),
        );
        this._hasVisibleText = true;

        const hasTextAfter = message.content
          .slice(i + 1)
          .some((c) => c.type === "text" && c.text.trim());
        if (hasTextAfter) {
          this.contentContainer.addChild(new Spacer(1));
        }
      }

      if (content.type === "text" && content.text.trim()) {
        this.contentContainer.addChild(new Markdown(content.text.trim(), 1, 0, markdownTheme));
        this._hasVisibleText = true;
      }
    }

    if (message.stopReason === "aborted") {
      this.contentContainer.addChild(new Spacer(1));
      this.contentContainer.addChild(new Text(palette.warn("aborted"), 1, 0));
      this._hasVisibleText = true;
    } else if (message.stopReason === "error") {
      const errorMsg = message.errorMessage || "unknown error";
      this.contentContainer.addChild(new Spacer(1));
      this.contentContainer.addChild(new Text(palette.error(`error: ${errorMsg}`), 1, 0));
      this._hasVisibleText = true;
    }
  }
}
