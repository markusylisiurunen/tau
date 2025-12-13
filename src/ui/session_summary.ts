import { type Component, Container, Markdown, Text } from "@mariozechner/pi-tui";
import { theme } from "./theme.js";

class DynamicBorder implements Component {
  constructor(private color: (s: string) => string) {}

  invalidate() {}

  render(width: number) {
    return [this.color("─".repeat(Math.max(1, width)))];
  }
}

export class SessionSummaryComponent extends Container {
  constructor(summary: string) {
    super();
    const { palette } = theme;
    const accentColor = (s: string) => palette.accent(s);

    this.addChild(new DynamicBorder(accentColor));

    const content = new Container();
    this.addChild(content);

    const headerText = `\u001b[1m◆ Context from previous session\u001b[22m`;
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
