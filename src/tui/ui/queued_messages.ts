import { type Component, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import type { Theme } from "./theme/index.js";

function firstLine(text: string): string {
  const idx = text.indexOf("\n");
  if (idx === -1) return text;
  return text.slice(0, idx);
}

export class QueuedMessagesComponent implements Component {
  constructor(
    private theme: Theme,
    private messages: string[],
  ) {}

  invalidate() {}

  render(width: number): string[] {
    if (this.messages.length === 0) return [];

    const { palette, markdownTheme } = this.theme;
    const lines: string[] = [];
    const headerRaw = `queued (${this.messages.length}) — alt+up to edit next`;
    const headerPad = " ";
    const headerWidth = Math.max(0, width - visibleWidth(headerPad));
    lines.push(palette.textDim(`${headerPad}${truncateToWidth(headerRaw, headerWidth, "…")}`));

    for (const [index, message] of this.messages.entries()) {
      const prefixRawArrow = `  ${index + 1}› `;
      const prefix = palette.textDim(prefixRawArrow);
      const prefixWidth = visibleWidth(prefixRawArrow);

      const line = firstLine(message);
      const available = Math.max(0, width - prefixWidth);
      const truncated = truncateToWidth(line, available, "…");
      const styled = markdownTheme.italic(palette.textMuted(truncated));
      lines.push(`${prefix}${styled}`);
    }

    return lines;
  }
}
