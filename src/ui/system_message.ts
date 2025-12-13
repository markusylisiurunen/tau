import { Container, Text } from "@mariozechner/pi-tui";
import { theme } from "./theme.js";

export class SystemMessageComponent extends Container {
  constructor(text: string, styleFn: (t: string) => string = theme.palette.systemLabel) {
    super();
    this.addChild(new Text(styleFn(text), 1, 0));
  }
}
