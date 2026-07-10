import { type Component, truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { SessionProtocolPendingUserMessage } from "../../protocol/session_protocol.js";
import type { Theme } from "./theme/index.js";

function firstLine(text: string): string {
  const idx = text.indexOf("\n");
  if (idx === -1) return text;
  return text.slice(0, idx);
}

export class PendingMessagesComponent implements Component {
  private messages: SessionProtocolPendingUserMessage[] = [];

  constructor(private theme: Theme) {}

  setTheme(theme: Theme): void {
    this.theme = theme;
  }

  setMessages(messages: SessionProtocolPendingUserMessage[]): void {
    this.messages = messages;
  }

  invalidate() {}

  render(width: number): string[] {
    if (this.messages.length === 0) return [];

    const { palette, markdownTheme } = this.theme;
    const lines: string[] = [];
    const headerRaw = `pending (${this.messages.length}) · alt+up edit all`;
    const headerPad = " ";
    const headerWidth = Math.max(0, width - visibleWidth(headerPad));
    lines.push(palette.textDim(`${headerPad}${truncateToWidth(headerRaw, headerWidth, "…")}`));

    let queueIndex = 0;
    for (const message of this.messages) {
      const prefixRaw = message.mode === "steer" ? "  ↳ " : `  ${++queueIndex}› `;
      const prefix = palette.textDim(prefixRaw);
      const prefixWidth = visibleWidth(prefixRaw);

      const line = firstLine(message.text);
      const available = Math.max(0, width - prefixWidth);
      const truncated = truncateToWidth(line, available, "…");
      const styled = markdownTheme.italic(palette.textMuted(truncated));
      lines.push(`${prefix}${styled}`);
    }

    return lines;
  }
}
