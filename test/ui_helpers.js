import { createUiTheme } from "../dist/ui/theme.js";

export function createTagTheme() {
  return createUiTheme("tags");
}

export function renderLines(component, width = 120) {
  return component.render(width).map((line) => line.replace(/\s+$/g, ""));
}

export function renderText(component, width = 120) {
  return renderLines(component, width).join("\n");
}
