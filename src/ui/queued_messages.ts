import { type Component, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import type { Theme } from "./theme.js";

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
    return this.messages.map((message, index) => {
      const prefixRaw = `${index + 1}. `;
      const prefix = palette.dim(prefixRaw);
      const prefixWidth = visibleWidth(prefixRaw);

      const line = firstLine(message);
      const available = Math.max(0, width - prefixWidth);
      const truncated = truncateToWidth(line, available, "…");
      const styled = markdownTheme.italic(palette.muted(truncated));
      return `${prefix}${styled}`;
    });
  }
}
