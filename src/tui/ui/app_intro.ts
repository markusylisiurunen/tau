import { Container, Text } from "@mariozechner/pi-tui";
import type { UiComponent } from "./components/ui_component.js";
import type { Theme } from "./theme/index.js";

export type AppIntroModel = {
  title: string;
  body: string;
};

function styleTitle(title: string, theme: Theme): string {
  const { palette } = theme;
  const parts = title.split(" ");
  const appName = parts[0] ?? title;
  const suffix = parts.slice(1).join(" ");
  if (!suffix) {
    return palette.brandAccent(title);
  }
  return `${palette.brandAccent(appName)} ${palette.textMuted(suffix)}`;
}

function styleBodyLine(line: string, theme: Theme): string {
  const { palette } = theme;
  const parts = line.split(/(`[^`]+`)/g);
  return parts
    .filter((part) => part.length > 0)
    .map((part) => {
      if (part.startsWith("`") && part.endsWith("`")) {
        return palette.codeInlineText(part.slice(1, -1));
      }
      return palette.textMuted(part);
    })
    .join("");
}

export class AppIntroComponent extends Container implements UiComponent<AppIntroModel> {
  private theme: Theme;

  constructor(theme: Theme, model: AppIntroModel) {
    super();
    this.theme = theme;
    this.update(model);
  }

  update(model: AppIntroModel): void {
    const title = styleTitle(model.title, this.theme);
    const body = model.body
      .split("\n")
      .map((line) => styleBodyLine(line, this.theme))
      .join("\n");
    const content = `\n${title}\n\n${body}`;

    this.clear();
    this.addChild(new Text(content, 1, 0));
  }
}
