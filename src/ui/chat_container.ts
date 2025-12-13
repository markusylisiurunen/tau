import { type Component, Container, Spacer } from "@mariozechner/pi-tui";
import { AssistantMessageComponent } from "./assistant_message.js";

export class ChatContainerComponent extends Container {
  private chatContainer: Container;
  private thoughtsVisible: boolean = false;
  private allMessages: { component: Component; isAssistant: boolean }[] = [];

  constructor(thoughtsVisible = false) {
    super();

    this.thoughtsVisible = thoughtsVisible;

    this.chatContainer = new Container();
    this.addChild(this.chatContainer);
  }

  addMessage(message: Component) {
    const isAssistant = message instanceof AssistantMessageComponent;
    this.allMessages.push({ component: message, isAssistant });

    // Always add immediately (rebuild() will filter later if needed)
    this.addSpacerIfNeeded();
    this.chatContainer.addChild(message);
  }

  setThinkingVisibility(visible: boolean) {
    if (this.thoughtsVisible === visible) return;
    this.thoughtsVisible = visible;
    this.rebuild();
  }

  clear() {
    this.allMessages = [];
    this.chatContainer.clear();
  }

  rebuild() {
    this.chatContainer.clear();

    for (const { component, isAssistant } of this.allMessages) {
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
