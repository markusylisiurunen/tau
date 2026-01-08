import { Container, Markdown } from "@mariozechner/pi-tui";
import type { Theme } from "./theme.js";

export class UserMessageComponent extends Container {
  constructor(theme: Theme, text: string, opts?: { isMemoryMode?: boolean }) {
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
