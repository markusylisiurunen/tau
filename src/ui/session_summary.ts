import { Container, Markdown, Text } from "@mariozechner/pi-tui";
import { DynamicBorder } from "./components/dynamic_border.js";
import type { Theme } from "./theme.js";

export class SessionSummaryComponent extends Container {
  constructor(theme: Theme, summary: string) {
    super();
    const { palette, text } = theme;
    const accentColor = (s: string) => palette.accent(s);

    this.addChild(new DynamicBorder(accentColor));

    const content = new Container();
    this.addChild(content);

    const headerText = text.bold("◆ context from previous session");
    content.addChild(new Text(accentColor(headerText), 1, 0));

    content.addChild(
      new Markdown(summary, 1, 1, theme.markdownTheme, {
        color: (t: string) => palette.muted(t),
        italic: true,
      }),
    );

    this.addChild(new DynamicBorder(accentColor));
  }
}
