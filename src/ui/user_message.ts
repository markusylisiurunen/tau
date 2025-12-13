import { Container, Markdown } from "@mariozechner/pi-tui";
import { theme } from "./theme.js";

export class UserMessageComponent extends Container {
  constructor(text: string) {
    super();

    this.addChild(
      new Markdown(text, 1, 1, theme.markdownTheme, {
        bgColor: (t: string) => theme.palette.userBg(t),
        color: (t: string) => theme.palette.userText(t),
      }),
    );
  }
}
