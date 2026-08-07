import type { AssistantMessage } from "@earendil-works/pi-ai";
import { Container, Markdown, Spacer } from "@earendil-works/pi-tui";
import type { UiComponent } from "./components/ui_component.js";
import type { Theme } from "./theme/index.js";

export type AssistantMessageModel =
  | {
      type: "assistant";
      message: AssistantMessage;
    }
  | {
      type: "assistant_partial";
      text: string;
      thinking?: string;
    };

export class AssistantMessageComponent
  extends Container
  implements UiComponent<AssistantMessageModel>
{
  private theme: Theme;
  private contentContainer: Container;
  private thoughtsVisible: boolean;
  private currentMessage: AssistantMessage | null = null;
  private currentPartial?: { text: string; thinking?: string };

  private _hasVisibleText: boolean = false;

  public get hasVisibleText(): boolean {
    return this._hasVisibleText;
  }

  constructor(theme: Theme, model?: AssistantMessageModel, thoughtsVisible = false) {
    super();

    this.theme = theme;
    this.contentContainer = new Container();
    this.thoughtsVisible = thoughtsVisible;

    this.addChild(this.contentContainer);

    if (model) {
      this.update(model);
    }
  }

  setThinkingVisibility(visible: boolean): void {
    if (this.thoughtsVisible === visible) {
      return;
    }

    this.thoughtsVisible = visible;

    if (this.currentPartial) {
      this.updatePartial(this.currentPartial.text, this.currentPartial.thinking);
      return;
    }
    if (this.currentMessage !== null) {
      this.updateFromMessage(this.currentMessage);
    }
  }

  update(model: AssistantMessageModel): void {
    if (model.type === "assistant") {
      this.currentPartial = undefined;
      this.updateFromMessage(model.message);
    } else {
      this.updatePartial(model.text, model.thinking);
    }
  }

  private updatePartial(text: string, thinking?: string): void {
    const { palette } = this.theme;
    this.currentMessage = null;
    this.currentPartial = { text, ...(thinking !== undefined ? { thinking } : {}) };
    this.contentContainer.clear();
    this._hasVisibleText = false;

    const trimmedThinking = thinking?.trim();
    const trimmedText = text.trim();
    if (this.thoughtsVisible && trimmedThinking) {
      this.contentContainer.addChild(
        new Markdown(trimmedThinking, 1, 0, this.theme.markdownTheme, {
          color: (t: string) => palette.thinkingText(t),
          italic: true,
        }),
      );
      this._hasVisibleText = true;
      if (trimmedText) {
        this.contentContainer.addChild(new Spacer(1));
      }
    }

    if (trimmedText) {
      this.contentContainer.addChild(new Markdown(trimmedText, 1, 0, this.theme.markdownTheme));
      this._hasVisibleText = true;
    }
  }

  private updateFromMessage(message: AssistantMessage): void {
    const { palette, markdownTheme } = this.theme;

    this.currentMessage = message;
    this.contentContainer.clear();
    this._hasVisibleText = false;

    for (let i = 0; i < message.content.length; i++) {
      const content = message.content[i]!;

      if (this.thoughtsVisible && content.type === "thinking" && content.thinking.trim()) {
        this.contentContainer.addChild(
          new Markdown(content.thinking.trim(), 1, 0, markdownTheme, {
            color: (t: string) => palette.thinkingText(t),
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
  }
}
