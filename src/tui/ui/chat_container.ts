import { Container, Spacer } from "@mariozechner/pi-tui";
import {
  type ChatMessageModel,
  type RenderedMessage,
  renderChatMessage,
} from "./chat_message_model.js";
import type { Theme } from "./theme/index.js";

type ChatMessageRecord = {
  id: string;
  model: ChatMessageModel;
  renderedMessage?: RenderedMessage;
  rendered: boolean;
};

export class ChatContainerComponent extends Container {
  private chatContainer: Container;
  private theme: Theme;
  private thoughtsVisible: boolean = false;
  private compactToolUi: boolean = false;
  private allMessages: ChatMessageRecord[] = [];
  private idToIndex: Map<string, number> = new Map();

  constructor(theme: Theme, thoughtsVisible = false) {
    super();

    this.theme = theme;
    this.thoughtsVisible = thoughtsVisible;

    this.chatContainer = new Container();
    this.addChild(this.chatContainer);
  }

  addMessage(model: ChatMessageModel, id?: string): string {
    const finalId = id ?? this.generateId();
    const record: ChatMessageRecord = { id: finalId, model, rendered: false };
    this.allMessages.push(record);
    this.idToIndex.set(finalId, this.allMessages.length - 1);

    const rendered = this.renderMessage(record);
    if (this.shouldShowMessage(rendered)) {
      this.addSpacerIfNeeded();
      this.chatContainer.addChild(rendered.component);
      record.rendered = true;
    }

    return finalId;
  }

  replaceMessage(id: string, model: ChatMessageModel): void {
    const index = this.idToIndex.get(id);
    if (index === undefined) return;

    this.allMessages[index] = { id, model, rendered: false };
    this.rebuild();
  }

  updateMessage(id: string, model: ChatMessageModel): void {
    const index = this.idToIndex.get(id);
    if (index === undefined) return;

    const record = this.allMessages[index];
    if (!record) return;
    record.model = model;

    const rendered = record.renderedMessage;
    if (rendered?.update) {
      const wasVisible = rendered.hasVisibleText ? rendered.hasVisibleText() : true;
      const updated = rendered.update(model, {
        theme: this.theme,
        thoughtsVisible: this.thoughtsVisible,
        compactToolUi: this.compactToolUi,
      });

      if (updated) {
        const shouldShow = this.shouldShowMessage(rendered);
        const isVisibleNow = rendered.hasVisibleText ? rendered.hasVisibleText() : true;

        if (record.rendered && shouldShow) {
          if (!wasVisible && isVisibleNow) {
            this.rebuild();
          }
          return;
        }

        if (!record.rendered && shouldShow) {
          this.rebuild();
          return;
        }

        if (record.rendered && !shouldShow) {
          this.rebuild();
        }
        return;
      }
    }

    this.rebuild();
  }

  setThinkingVisibility(visible: boolean) {
    if (this.thoughtsVisible === visible) return;
    this.thoughtsVisible = visible;
    this.rebuild();
  }

  setCompactToolUi(compact: boolean): void {
    if (this.compactToolUi === compact) return;
    this.compactToolUi = compact;
    this.rebuild();
  }

  clear() {
    this.allMessages = [];
    this.idToIndex.clear();
    this.chatContainer.clear();
  }

  rebuild() {
    this.chatContainer.clear();

    for (const record of this.allMessages) {
      record.rendered = false;
      const rendered = this.renderMessage(record);
      if (this.shouldShowMessage(rendered)) {
        this.addSpacerIfNeeded();
        this.chatContainer.addChild(rendered.component);
        record.rendered = true;
      }
    }
  }

  private renderMessage(record: ChatMessageRecord): RenderedMessage {
    const rendered = renderChatMessage(record.model, {
      theme: this.theme,
      thoughtsVisible: this.thoughtsVisible,
      compactToolUi: this.compactToolUi,
    });
    record.renderedMessage = rendered;
    return rendered;
  }

  private shouldShowMessage(rendered: RenderedMessage): boolean {
    if (!rendered.isAssistant) return true;
    if (this.thoughtsVisible) return true;

    if (rendered.hasVisibleText) {
      return rendered.hasVisibleText();
    }
    return true;
  }

  private addSpacerIfNeeded() {
    const isFirst = this.chatContainer.children.length === 0;
    if (isFirst) return;
    this.chatContainer.addChild(new Spacer(1));
  }

  private generateId(): string {
    return Math.random().toString(36).slice(2, 11);
  }
}
