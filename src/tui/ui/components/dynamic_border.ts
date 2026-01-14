import type { Component } from "@mariozechner/pi-tui";

export class DynamicBorder implements Component {
  constructor(private color: (s: string) => string) {}

  invalidate() {}

  render(width: number) {
    return [this.color("─".repeat(Math.max(1, width)))];
  }
}
