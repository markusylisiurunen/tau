import { visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { UiComponent } from "./components/ui_component.js";
import type { Theme } from "./theme/index.js";

export type AppIntroModel = {
  title: string;
  body: (string | { names: string[] })[];
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

function wrapNames(names: string[], width: number): string[] {
  const lines: string[] = [];
  let line = "";
  for (const name of names) {
    const joined = line ? `${line}, ${name}` : name;
    if (visibleWidth(joined) <= width) {
      line = joined;
    } else {
      if (line) lines.push(line);
      const wrapped = wrapTextWithAnsi(name, width);
      lines.push(...wrapped.slice(0, -1));
      line = wrapped.at(-1) ?? "";
    }
  }
  if (line) lines.push(line);
  return lines;
}

export class AppIntroComponent implements UiComponent<AppIntroModel> {
  private theme: Theme;
  private model: AppIntroModel;

  constructor(theme: Theme, model: AppIntroModel) {
    this.theme = theme;
    this.model = model;
  }

  update(model: AppIntroModel): void {
    this.model = model;
  }

  invalidate() {}

  render(width: number): string[] {
    if (width <= 0) return [""];

    const layoutWidth = Math.min(width, 100);
    const margin = layoutWidth > 2 ? 1 : 0;
    const contentWidth = layoutWidth - margin * 2;
    const title = wrapTextWithAnsi(styleTitle(this.model.title, this.theme), contentWidth);
    const body = this.model.body.flatMap((line) => {
      const isList = typeof line !== "string";
      const indented = isList || line.startsWith("  ");
      const indent = indented ? Math.min(2, contentWidth - 1) : 0;
      const lineWidth = contentWidth - indent;
      const wrapped = isList
        ? wrapNames(line.names, lineWidth).map((part) => this.theme.palette.textMuted(part))
        : wrapTextWithAnsi(styleBodyLine(indented ? line.slice(2) : line, this.theme), lineWidth);
      return wrapped.map((part) => " ".repeat(indent) + part);
    });
    return ["", ...title, "", ...body].map((line) => " ".repeat(margin) + line);
  }
}
