import { type Component, Container, Spacer } from "@mariozechner/pi-tui";

export class ChatContainerComponent extends Container {
  private chatContainer: Container;

  constructor() {
    super();

    this.chatContainer = new Container();
    this.addChild(this.chatContainer);
  }

  addMessage(message: Component) {
    this.addSpacerIfNeeded();
    this.chatContainer.addChild(message);
  }

  clear() {
    this.chatContainer.clear();
  }

  private addSpacerIfNeeded() {
    const isFirst = this.chatContainer.children.length === 0;
    if (isFirst) return;
    this.chatContainer.addChild(new Spacer(1));
  }
}
