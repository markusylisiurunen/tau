import { type Component, visibleWidth } from "@mariozechner/pi-tui";
import { truncateFromEndByWidth } from "./one_line_segments.js";

type HeaderBoxOptions = {
  borderColor: (text: string) => string;
  headerLeft?: string;
  headerRight?: string;
  headerLeftStyle?: (text: string) => string;
  headerRightStyle?: (text: string) => string;
  paddingX?: number;
  paddingY?: number;
};

export class HeaderBox implements Component {
  constructor(
    private child: Component,
    private options: HeaderBoxOptions,
  ) {}

  invalidate() {
    this.child.invalidate();
  }

  render(width: number): string[] {
    if (width <= 0) return [""];
    if (width === 1) return [this.options.borderColor("─")];

    const header = this.renderHeaderLine(width);
    const footer = this.renderFooterLine(width);
    const innerWidth = Math.max(0, width - 2);
    const paddingX = Math.max(0, this.options.paddingX ?? 0);
    const paddingY = Math.max(0, this.options.paddingY ?? 0);
    const contentWidth = Math.max(0, innerWidth - paddingX * 2);

    const contentLines = contentWidth > 0 ? this.child.render(contentWidth) : [""];
    const safeContentLines = contentLines.length > 0 ? contentLines : [""];
    const vertical = this.options.borderColor("│");
    const padLeft = " ".repeat(paddingX);
    const padRight = " ".repeat(paddingX);
    const blankInner = " ".repeat(innerWidth);

    const lines: string[] = [header];
    for (let i = 0; i < paddingY; i++) {
      lines.push(`${vertical}${blankInner}${vertical}`);
    }

    for (const line of safeContentLines) {
      const paddedLine = this.padToWidth(line, contentWidth);
      const innerLine = `${padLeft}${paddedLine}${padRight}`;
      lines.push(`${vertical}${innerLine}${vertical}`);
    }

    for (let i = 0; i < paddingY; i++) {
      lines.push(`${vertical}${blankInner}${vertical}`);
    }

    lines.push(footer);
    return lines;
  }

  private renderHeaderLine(width: number): string {
    if (width <= 1) return this.options.borderColor("─").repeat(Math.max(0, width));
    if (width === 2) {
      return `${this.options.borderColor("╭")}${this.options.borderColor("╮")}`;
    }

    const innerWidth = width - 2;
    const dash = this.options.borderColor("─");
    const leftCorner = this.options.borderColor("╭");
    const rightCorner = this.options.borderColor("╮");

    let left = (this.options.headerLeft ?? "").trim();
    let right = (this.options.headerRight ?? "").trim();

    const measure = () => {
      const leftWidth = left ? visibleWidth(left) : 0;
      const rightWidth = right ? visibleWidth(right) : 0;
      const leftPad = left ? 2 : 0;
      const rightPad = right ? 2 : 0;
      const fixed = 1 + 1 + leftPad + rightPad + leftWidth + rightWidth;
      return { leftWidth, rightWidth, leftPad, rightPad, fixed };
    };

    let metrics = measure();

    if (metrics.fixed > innerWidth && left) {
      const allowed = Math.max(0, innerWidth - (1 + 1 + (right ? visibleWidth(right) + 2 : 0) + 2));
      left = truncateFromEndByWidth(left, allowed);
      if (visibleWidth(left) === 0) left = "";
      metrics = measure();
    }

    if (metrics.fixed > innerWidth && right) {
      const allowed = Math.max(0, innerWidth - (1 + 1 + (left ? visibleWidth(left) + 2 : 0) + 2));
      right = truncateFromEndByWidth(right, allowed);
      if (visibleWidth(right) === 0) right = "";
      metrics = measure();
    }

    if (metrics.fixed > innerWidth) {
      left = "";
      right = "";
      metrics = measure();
    }

    const fillWidth = Math.max(0, innerWidth - metrics.fixed);
    const leftStyle = this.options.headerLeftStyle ?? this.options.borderColor;
    const rightStyle = this.options.headerRightStyle ?? this.options.borderColor;
    const leftSegment = left ? ` ${leftStyle(left)} ` : "";
    const rightSegment = right ? ` ${rightStyle(right)} ` : "";
    const fill = dash.repeat(fillWidth);

    return `${leftCorner}${dash}${leftSegment}${fill}${rightSegment}${dash}${rightCorner}`;
  }

  private renderFooterLine(width: number): string {
    if (width <= 1) return this.options.borderColor("─").repeat(Math.max(0, width));
    const innerWidth = Math.max(0, width - 2);
    const leftCorner = this.options.borderColor("╰");
    const rightCorner = this.options.borderColor("╯");
    const fill = this.options.borderColor("─").repeat(innerWidth);
    return `${leftCorner}${fill}${rightCorner}`;
  }

  private padToWidth(line: string, width: number): string {
    const pad = Math.max(0, width - visibleWidth(line));
    return `${line}${" ".repeat(pad)}`;
  }
}
