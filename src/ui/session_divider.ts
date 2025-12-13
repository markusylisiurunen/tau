import type { Component } from "@mariozechner/pi-tui";
import { theme } from "./theme.js";

export class SessionDividerComponent implements Component {
  constructor(private label: string) {}

  invalidate() {}

  render(width: number) {
    const labelWithSpace = ` ${this.label} `;
    const leftDashes = "───";
    const remainingWidth = Math.max(1, width - labelWithSpace.length - leftDashes.length);
    const rightDashes = "─".repeat(remainingWidth);
    const dividerText = `${leftDashes}${labelWithSpace}${rightDashes}`;
    return ["", theme.palette.muted(dividerText)];
  }
}
