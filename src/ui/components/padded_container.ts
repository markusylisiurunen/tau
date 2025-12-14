import type { Component } from "@mariozechner/pi-tui";

export class PaddedContainer implements Component {
  constructor(
    private child: Component,
    private paddingLeft: number = 0,
  ) {}

  invalidate() {
    this.child.invalidate();
  }

  render(width: number): string[] {
    const childWidth = Math.max(0, width - this.paddingLeft);
    const childLines = this.child.render(childWidth);
    const pad = " ".repeat(this.paddingLeft);
    return childLines.map((line) => `${pad}${line}`);
  }
}
