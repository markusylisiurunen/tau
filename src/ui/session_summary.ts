import { type Component, Markdown } from "@mariozechner/pi-tui";
import { HeaderBox } from "./components/header_box.js";
import type { Theme } from "./theme.js";

export class SessionSummaryComponent implements Component {
  private box: HeaderBox;

  constructor(theme: Theme, summary: string) {
    const { palette } = theme;
    const borderColor = (s: string) => palette.accent(s);
    const headerText = "context from previous session";
    const content = new Markdown(summary, 0, 0, theme.markdownTheme, {
      color: (t: string) => palette.muted(t),
      italic: true,
    });

    this.box = new HeaderBox(content, {
      borderColor,
      headerLeft: headerText,
      headerLeftStyle: borderColor,
      paddingX: 1,
    });
  }

  invalidate() {
    this.box.invalidate();
  }

  render(width: number): string[] {
    return this.box.render(width);
  }
}
