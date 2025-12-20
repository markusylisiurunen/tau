import { type Component, Container, Spacer } from "@mariozechner/pi-tui";
import { AssistantMessageComponent } from "./assistant_message.js";

type ChatMessageRecord =
  | {
      id: string;
      type: "component";
      component: Component;
      isAssistant: boolean;
    }
  | {
      id: string;
      type: "tool";
      render: (compactToolUi: boolean) => Component;
      isAssistant: boolean;
    };

export class ChatContainerComponent extends Container {
  private chatContainer: Container;
  private thoughtsVisible: boolean = false;
  private compactToolUi: boolean = false;
  private allMessages: ChatMessageRecord[] = [];
  private idToIndex: Map<string, number> = new Map();

  constructor(thoughtsVisible = false) {
    super();

    this.thoughtsVisible = thoughtsVisible;

    this.chatContainer = new Container();
    this.addChild(this.chatContainer);
  }

  addMessage(message: Component): string {
    const id = this.generateId();
    const isAssistant = message instanceof AssistantMessageComponent;
    this.allMessages.push({ id, type: "component", component: message, isAssistant });
    this.idToIndex.set(id, this.allMessages.length - 1);

    // Always add immediately (rebuild() will filter later if needed)
    this.addSpacerIfNeeded();
    this.chatContainer.addChild(message);

    return id;
  }

  replaceMessage(id: string, newComponent: Component): void {
    const index = this.idToIndex.get(id);
    if (index === undefined) return;

    const isAssistant = newComponent instanceof AssistantMessageComponent;
    this.allMessages[index] = { id, type: "component", component: newComponent, isAssistant };

    // Rebuild to update the display
    this.rebuild();
  }

  addToolMessage(render: (compactToolUi: boolean) => Component, id?: string): string {
    const finalId = id ?? this.generateId();
    this.allMessages.push({ id: finalId, type: "tool", render, isAssistant: false });
    this.idToIndex.set(finalId, this.allMessages.length - 1);

    const component = render(this.compactToolUi);
    this.addSpacerIfNeeded();
    this.chatContainer.addChild(component);

    return finalId;
  }

  replaceToolMessage(id: string, render: (compactToolUi: boolean) => Component): void {
    const index = this.idToIndex.get(id);
    if (index === undefined) return;

    this.allMessages[index] = {
      id,
      type: "tool",
      render,
      isAssistant: false,
    };
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
      const component =
        record.type === "component" ? record.component : record.render(this.compactToolUi);
      const isAssistant = record.isAssistant;
      if (this.shouldShowMessage(component, isAssistant)) {
        this.addSpacerIfNeeded();
        this.chatContainer.addChild(component);
      }
    }
  }

  private shouldShowMessage(component: Component, isAssistant: boolean): boolean {
    if (!isAssistant) return true;
    if (this.thoughtsVisible) return true;

    if (component instanceof AssistantMessageComponent) {
      return component.hasVisibleText;
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
