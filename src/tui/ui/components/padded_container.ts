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
    const safeWidth = Math.max(0, width);
    const padWidth = Math.min(this.paddingLeft, safeWidth);
    const childWidth = Math.max(0, safeWidth - padWidth);

    // If there's no space left for the child, don't render it (avoid child.render(0) producing >0 width).
    if (childWidth === 0) {
      return [" ".repeat(safeWidth)];
    }

    const childLines = this.child.render(childWidth);
    const pad = " ".repeat(padWidth);
    return childLines.map((line) => `${pad}${line}`);
  }
}
