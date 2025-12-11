import { Container, Spacer, Text } from "@mariozechner/pi-tui";
import { theme } from "./theme.js";

export class SystemMessageComponent extends Container {
  constructor(
    text: string,
    isFirst: boolean,
    styleFn: (t: string) => string = theme.palette.systemLabel,
  ) {
    super();
    if (!isFirst) {
      this.addChild(new Spacer(1));
    }
    this.addChild(new Text(styleFn(text), 1, 0));
  }
}
