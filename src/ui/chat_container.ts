import { type Component, Container, Spacer } from "@mariozechner/pi-tui";
import { AssistantMessageComponent } from "./assistant_message.js";

type ChatMessageRecord =
  | { type: "component"; component: Component; isAssistant: boolean }
  | { type: "tool"; render: (compactToolUi: boolean) => Component; isAssistant: boolean };

export class ChatContainerComponent extends Container {
  private chatContainer: Container;
  private thoughtsVisible: boolean = false;
  private compactToolUi: boolean = false;
  private allMessages: ChatMessageRecord[] = [];

  constructor(thoughtsVisible = false) {
    super();

    this.thoughtsVisible = thoughtsVisible;

    this.chatContainer = new Container();
    this.addChild(this.chatContainer);
  }

  addMessage(message: Component): number {
    const isAssistant = message instanceof AssistantMessageComponent;
    this.allMessages.push({ type: "component", component: message, isAssistant });

    // Always add immediately (rebuild() will filter later if needed)
    this.addSpacerIfNeeded();
    this.chatContainer.addChild(message);

    // Return the index of the added message
    return this.allMessages.length - 1;
  }

  replaceMessageAtIndex(index: number, newComponent: Component): void {
    if (index < 0 || index >= this.allMessages.length) {
      return;
    }

    const isAssistant = newComponent instanceof AssistantMessageComponent;
    this.allMessages[index] = { type: "component", component: newComponent, isAssistant };

    // Rebuild to update the display
    this.rebuild();
  }

  addToolMessage(render: (compactToolUi: boolean) => Component): number {
    this.allMessages.push({ type: "tool", render, isAssistant: false });

    const component = render(this.compactToolUi);
    this.addSpacerIfNeeded();
    this.chatContainer.addChild(component);

    return this.allMessages.length - 1;
  }

  replaceToolMessageAtIndex(index: number, render: (compactToolUi: boolean) => Component): void {
    if (index < 0 || index >= this.allMessages.length) {
      return;
    }

    this.allMessages[index] = { type: "tool", render, isAssistant: false };
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
}
