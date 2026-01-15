import { Markdown } from "@mariozechner/pi-tui";
import { HeaderBox } from "./components/header_box.js";
import type { UiComponent } from "./components/ui_component.js";
import type { Theme } from "./theme/index.js";

export type SessionSummaryModel = {
  summary: string;
};

export class SessionSummaryComponent implements UiComponent<SessionSummaryModel> {
  private theme: Theme;
  private box: HeaderBox;

  constructor(theme: Theme, model: SessionSummaryModel) {
    this.theme = theme;
    this.box = new HeaderBox(new Markdown("", 0, 0, theme.markdownTheme), {
      borderColor: (s: string) => s,
    });
    this.update(model);
  }

  update(model: SessionSummaryModel): void {
    const { palette } = this.theme;
    const borderColor = (s: string) => palette.brandAccent(s);
    const headerText = "context from previous session";
    const content = new Markdown(model.summary, 0, 0, this.theme.markdownTheme, {
      color: (t: string) => palette.textMuted(t),
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
