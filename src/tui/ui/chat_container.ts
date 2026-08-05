import { Container, Spacer } from "@earendil-works/pi-tui";
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
  private allMessages: ChatMessageRecord[] = [];
  private idToIndex: Map<string, number> = new Map();
  private cachedRenderWidth?: number;
  private cachedRenderLines?: string[];

  constructor(theme: Theme, thoughtsVisible = false) {
    super();

    this.theme = theme;
    this.thoughtsVisible = thoughtsVisible;

    this.chatContainer = new Container();
    this.addChild(this.chatContainer);
  }

  setTheme(theme: Theme): void {
    if (this.theme === theme) return;
    this.theme = theme;
    this.rebuild();
  }

  addMessage(model: ChatMessageModel, id?: string): string {
    const finalId = id ?? this.generateId();
    if (this.idToIndex.has(finalId)) {
      this.replaceMessage(finalId, model);
      return finalId;
    }

    const record: ChatMessageRecord = { id: finalId, model, rendered: false };
    this.allMessages.push(record);
    this.idToIndex.set(finalId, this.allMessages.length - 1);

    const rendered = this.renderMessage(record);
    if (this.shouldShowMessage(rendered)) {
      this.addSpacerIfNeeded();
      this.chatContainer.addChild(rendered.component);
      record.rendered = true;
    }
    this.invalidateRenderCache();

    return finalId;
  }

  replaceMessage(id: string, model: ChatMessageModel): boolean {
    const index = this.idToIndex.get(id);
    if (index === undefined) return false;

    this.allMessages[index] = { id, model, rendered: false };
    this.rebuild();
    return true;
  }

  updateMessage(id: string, model: ChatMessageModel): boolean {
    const index = this.idToIndex.get(id);
    if (index === undefined) return false;

    const record = this.allMessages[index];
    if (!record) return false;
    record.model = model;

    const rendered = record.renderedMessage;
    if (rendered?.update) {
      const wasVisible = rendered.hasVisibleText ? rendered.hasVisibleText() : true;
      const updated = rendered.update(model, {
        theme: this.theme,
        thoughtsVisible: this.thoughtsVisible,
      });

      if (updated) {
        const shouldShow = this.shouldShowMessage(rendered);
        const isVisibleNow = rendered.hasVisibleText ? rendered.hasVisibleText() : true;

        if (record.rendered && shouldShow) {
          if (!wasVisible && isVisibleNow) {
            this.rebuild();
          }
          this.invalidateRenderCache();
          return true;
        }

        if (!record.rendered && shouldShow) {
          this.rebuild();
          return true;
        }

        if (record.rendered && !shouldShow) {
          this.rebuild();
        }
        this.invalidateRenderCache();
        return true;
      }
    }

    this.rebuild();
    return true;
  }

  setThinkingVisibility(visible: boolean) {
    if (this.thoughtsVisible === visible) return;
    this.thoughtsVisible = visible;
    this.rebuild();
  }

  clear() {
    this.allMessages = [];
    this.idToIndex.clear();
    this.chatContainer.clear();
    this.invalidateRenderCache();
  }

  removeMessages(ids: readonly string[]): void {
    if (ids.length === 0 || this.allMessages.length === 0) return;

    const idSet = new Set(ids);
    this.allMessages = this.allMessages.filter((record) => !idSet.has(record.id));
    this.idToIndex.clear();
    this.allMessages.forEach((record, index) => {
      this.idToIndex.set(record.id, index);
    });
    this.rebuild();
  }

  removeMessagesFrom(id: string): void {
    const index = this.idToIndex.get(id);
    if (index === undefined) return;

    this.allMessages = this.allMessages.slice(0, index);
    this.idToIndex.clear();
    this.allMessages.forEach((record, messageIndex) => {
      this.idToIndex.set(record.id, messageIndex);
    });
    this.rebuild();
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
    this.invalidateRenderCache();
  }

  override invalidate(): void {
    this.invalidateRenderCache();
    super.invalidate();
  }

  override render(width: number): string[] {
    if (this.cachedRenderLines && this.cachedRenderWidth === width) {
      return this.cachedRenderLines;
    }

    const lines = super.render(width);
    this.cachedRenderWidth = width;
    this.cachedRenderLines = lines;
    return lines;
  }

  private renderMessage(record: ChatMessageRecord): RenderedMessage {
    const rendered = renderChatMessage(record.model, {
      theme: this.theme,
      thoughtsVisible: this.thoughtsVisible,
    });
    record.renderedMessage = rendered;
    return rendered;
  }

  private shouldShowMessage(rendered: RenderedMessage): boolean {
    if (!rendered.isAssistant) return true;
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

  private invalidateRenderCache(): void {
    this.cachedRenderWidth = undefined;
    this.cachedRenderLines = undefined;
  }
}
