import type { Component } from "@mariozechner/pi-tui";
import { theme } from "./theme.js";

export class SessionDividerComponent implements Component {
  constructor(private label: string) {}

  invalidate() {}

  render(width: number) {
    const labelWithSpace = ` ${this.label} `;
    const remainingWidth = Math.max(1, width - labelWithSpace.length);
    const dashes = "─".repeat(remainingWidth);
    const dividerText = `${labelWithSpace}${dashes}`;
    return [theme.palette.muted(dividerText)];
  }
}
