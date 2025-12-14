import { type Component, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { palette, theme } from "./theme.js";

function firstLine(text: string): string {
  const idx = text.indexOf("\n");
  if (idx === -1) return text;
  return text.slice(0, idx);
}

export class QueuedMessagesComponent implements Component {
  constructor(private getMessages: () => string[]) {}

  invalidate() {}

  render(width: number): string[] {
    const messages = this.getMessages();
    if (messages.length === 0) return [];

    return messages.map((message, index) => {
      const prefixRaw = `${index + 1}. `;
      const prefix = palette.dim(prefixRaw);
      const prefixWidth = visibleWidth(prefixRaw);

      const line = firstLine(message);
      const available = Math.max(0, width - prefixWidth);
      const truncated = truncateToWidth(line, available, "…");
      const styled = theme.markdownTheme.italic(palette.muted(truncated));
      return `${prefix}${styled}`;
    });
  }
}
