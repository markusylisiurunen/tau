import { Container, Markdown } from "@mariozechner/pi-tui";
import { theme } from "./theme.js";

export class UserMessageComponent extends Container {
  constructor(text: string, opts?: { isMemoryMode?: boolean }) {
    super();

    const bgColor = opts?.isMemoryMode ? theme.palette.userMemoryBg : theme.palette.userBg;
    const color = opts?.isMemoryMode ? theme.palette.userMemoryText : theme.palette.userText;

    this.addChild(
      new Markdown(text, 1, 1, theme.markdownTheme, {
        bgColor: (t: string) => bgColor(t),
        color: (t: string) => color(t),
      }),
    );
  }
}
