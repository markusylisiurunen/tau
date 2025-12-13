import { Container, Text } from "@mariozechner/pi-tui";

export class SystemMessageComponent extends Container {
  constructor(text: string, styleFn: (t: string) => string) {
    super();
    this.addChild(new Text(styleFn(text), 1, 0));
  }
}
