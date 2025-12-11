import { Container, Markdown, Spacer } from "@mariozechner/pi-tui";
import { theme } from "./theme.js";

export class UserMessageComponent extends Container {
  constructor(text: string, isFirst: boolean) {
    super();
    if (!isFirst) {
      this.addChild(new Spacer(1));
    }

    this.addChild(
      new Markdown(text, 1, 1, theme.markdownTheme, {
        bgColor: (t: string) => theme.palette.userBg(t),
        color: (t: string) => theme.palette.userText(t),
      }),
    );
  }
}
