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
  childIndex?: number;
};

export class ChatContainerComponent extends Container {
  private chatContainer: Container;
  private theme: Theme;
  private thoughtsVisible: boolean = false;
  private allMessages: ChatMessageRecord[] = [];
  private idToIndex: Map<string, number> = new Map();
  private cachedRenderWidth?: number;
  private cachedRenderLines: string[] = [];
  private childLineOffsets: number[] = [0];
  private dirtyChildIndex = 0;

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

    const record: ChatMessageRecord = { id: finalId, model };
    this.allMessages.push(record);
    this.idToIndex.set(finalId, this.allMessages.length - 1);

    const rendered = this.renderMessage(record);
    if (this.shouldShowMessage(rendered)) {
      this.addSpacerIfNeeded();
      record.childIndex = this.chatContainer.children.length;
      this.chatContainer.addChild(rendered.component);
    }

    return finalId;
  }

  replaceMessage(id: string, model: ChatMessageModel): boolean {
    const index = this.idToIndex.get(id);
    if (index === undefined) return false;

    this.allMessages[index] = { id, model };
    this.rebuild();
    return true;
  }

  updateMessage(id: string, model: ChatMessageModel): "missing" | "unchanged" | "updated" {
    const index = this.idToIndex.get(id);
    if (index === undefined) return "missing";

    const record = this.allMessages[index];
    if (!record) return "missing";
    const previousModel = record.model;
    record.model = model;

    if (
      !this.thoughtsVisible &&
      previousModel.type === "assistant_partial" &&
      model.type === "assistant_partial" &&
      previousModel.text.trim() === model.text.trim()
    ) {
      return "unchanged";
    }

    const rendered = record.renderedMessage;
    if (rendered?.update) {
      const updated = rendered.update(model, {
        theme: this.theme,
        thoughtsVisible: this.thoughtsVisible,
      });

      if (updated) {
        const shouldShow = this.shouldShowMessage(rendered);
        if ((record.childIndex !== undefined) !== shouldShow) {
          this.syncVisibleMessages();
        } else if (record.childIndex !== undefined) {
          this.dirtyChildIndex = Math.min(this.dirtyChildIndex, record.childIndex);
        }
        return "updated";
      }
    }

    this.rebuild();
    return "updated";
  }

  private syncVisibleMessages(): void {
    this.chatContainer.clear();
    for (const record of this.allMessages) {
      const rendered = record.renderedMessage!;
      record.childIndex = undefined;
      if (this.shouldShowMessage(rendered)) {
        this.addSpacerIfNeeded();
        record.childIndex = this.chatContainer.children.length;
        this.chatContainer.addChild(rendered.component);
      }
    }
    this.invalidateRenderCache();
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
      record.childIndex = undefined;
      const rendered = this.renderMessage(record);
      if (this.shouldShowMessage(rendered)) {
        this.addSpacerIfNeeded();
        record.childIndex = this.chatContainer.children.length;
        this.chatContainer.addChild(rendered.component);
      }
    }
    this.invalidateRenderCache();
  }

  override invalidate(): void {
    this.invalidateRenderCache();
    super.invalidate();
  }

  override render(width: number): string[] {
    if (this.cachedRenderWidth !== width) {
      this.invalidateRenderCache();
      this.cachedRenderWidth = width;
    }

    // The parent Container copies these lines into its own frame buffer.
    const lines = this.cachedRenderLines;
    lines.length = this.childLineOffsets[this.dirtyChildIndex]!;
    this.childLineOffsets.length = this.dirtyChildIndex + 1;
    const children = this.chatContainer.children;
    for (let index = this.dirtyChildIndex; index < children.length; index += 1) {
      const childLines = children[index]!.render(width);
      for (const line of childLines) lines.push(line);
      this.childLineOffsets.push(lines.length);
    }
    this.dirtyChildIndex = children.length;
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
    this.cachedRenderLines = [];
    this.childLineOffsets = [0];
    this.dirtyChildIndex = 0;
  }
}
