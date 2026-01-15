import type { Component } from "@mariozechner/pi-tui";
import type { Theme } from "./theme/index.js";

export class SessionDividerComponent implements Component {
  constructor(
    private theme: Theme,
    private label: string,
  ) {}

  invalidate() {}

  render(width: number) {
    const labelWithSpace = ` ${this.label} `;
    const leftDashes = "──";
    const remainingWidth = Math.max(1, width - labelWithSpace.length - leftDashes.length);
    const rightDashes = "─".repeat(remainingWidth);
    const dividerText = `${leftDashes}${labelWithSpace}${rightDashes}`;
    return [this.theme.palette.textMuted(dividerText)];
  }
}
