import { Editor, Key, matchesKey, visibleWidth } from "@mariozechner/pi-tui";
import stripAnsi from "strip-ansi";
import { truncateFromEndByWidth } from "./components/one_line_segments.js";
import type { Theme } from "./theme.js";

export class CustomEditor extends Editor {
  private uiTheme: Theme;
  private headerLeft = "";
  private headerRight = "";
  private headerLeftStyle?: (text: string) => string;
  private headerRightStyle?: (text: string) => string;

  public onCtrlC?: () => void;
  public onCtrlT?: () => void;
  public onCtrlO?: () => void;
  public onEscape?: () => void;
  public onShiftTab?: () => void;
  public onCtrlF?: () => void;
  public onCtrlR?: () => void;
  public onCtrlP?: () => void;
  public onAltUp?: () => void;
  public beforeSubmit?: (text: string) => boolean;

  constructor(theme: Theme) {
    super(theme.editorTheme);
    this.uiTheme = theme;
  }

  setHeader(
    left: string,
    right: string,
    styles?: { leftStyle?: (text: string) => string; rightStyle?: (text: string) => string },
  ): void {
    this.headerLeft = left;
    this.headerRight = right;
    this.headerLeftStyle = styles?.leftStyle;
    this.headerRightStyle = styles?.rightStyle;
  }

  getCursor(): { line: number; col: number } {
    return super.getCursor();
  }

  getLines(): string[] {
    return super.getLines();
  }

  render(width: number): string[] {
    if (width <= 0) return [""];
    if (width === 1) return [this.borderColor("─")];
    if (width === 2) return [this.renderHeaderLine(width)];

    const innerWidth = width - 2;
    const baseLines = super.render(innerWidth);

    if (baseLines.length === 0) {
      return [this.borderColor("─").repeat(width)];
    }

    let bottomIndex = baseLines.length - 1;
    for (let i = baseLines.length - 1; i >= 0; i--) {
      const line = baseLines[i] ?? "";
      if (this.isHorizontalBorder(line, innerWidth)) {
        bottomIndex = i;
        break;
      }
    }

    const contentLines = baseLines.slice(1, Math.max(1, bottomIndex));
    const trailingLines = baseLines.slice(bottomIndex + 1);

    const vertical = this.borderColor("│");
    const rendered: string[] = [];
    rendered.push(this.renderHeaderLine(width));

    if (contentLines.length === 0) {
      rendered.push(`${vertical}${" ".repeat(innerWidth)}${vertical}`);
    } else {
      for (const line of contentLines) {
        rendered.push(`${vertical}${line}${vertical}`);
      }
    }

    rendered.push(this.renderFooterLine(width));

    if (trailingLines.length > 0) {
      for (const line of trailingLines) {
        const padded = this.padToWidth(line, width - 1);
        rendered.push(` ${padded}`);
      }
    }

    return rendered;
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.shift("tab")) && this.onShiftTab) {
      this.onShiftTab();
      return;
    }

    if (matchesKey(data, Key.ctrl("c")) && this.onCtrlC) {
      this.onCtrlC();
      return;
    }

    if (matchesKey(data, Key.ctrl("t")) && this.onCtrlT) {
      this.onCtrlT();
      return;
    }

    if (matchesKey(data, Key.ctrl("o")) && this.onCtrlO && !this.isShowingAutocomplete()) {
      this.onCtrlO();
      return;
    }

    if (matchesKey(data, Key.ctrl("f")) && this.onCtrlF && !this.isShowingAutocomplete()) {
      this.onCtrlF();
      return;
    }

    if (matchesKey(data, Key.ctrl("r")) && this.onCtrlR && !this.isShowingAutocomplete()) {
      this.onCtrlR();
      return;
    }

    if (matchesKey(data, Key.ctrl("p")) && this.onCtrlP && !this.isShowingAutocomplete()) {
      this.onCtrlP();
      return;
    }

    if (matchesKey(data, Key.alt("up")) && this.onAltUp && !this.isShowingAutocomplete()) {
      this.onAltUp();
      return;
    }

    if (matchesKey(data, Key.enter) && this.beforeSubmit && !this.isShowingAutocomplete()) {
      if (!this.beforeSubmit(this.getText())) {
        return;
      }
    }

    if (matchesKey(data, Key.escape) && this.onEscape && !this.isShowingAutocomplete()) {
      this.onEscape();
      return;
    }

    super.handleInput(data);
  }

  private renderHeaderLine(width: number): string {
    if (width <= 1) return this.borderColor("─").repeat(Math.max(0, width));
    if (width === 2) {
      return `${this.borderColor("╭")}${this.borderColor("╮")}`;
    }

    const innerWidth = width - 2;
    const dash = this.borderColor("─");
    const leftCorner = this.borderColor("╭");
    const rightCorner = this.borderColor("╮");

    let left = this.headerLeft.trim();
    let right = this.headerRight.trim();

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
    const leftStyle = this.headerLeftStyle ?? this.uiTheme.palette.dim;
    const rightStyle = this.headerRightStyle ?? this.uiTheme.palette.dim;
    const leftSegment = left ? ` ${leftStyle(left)} ` : "";
    const rightSegment = right ? ` ${rightStyle(right)} ` : "";
    const fill = dash.repeat(fillWidth);

    return `${leftCorner}${dash}${leftSegment}${fill}${rightSegment}${dash}${rightCorner}`;
  }

  private renderFooterLine(width: number): string {
    if (width <= 1) return this.borderColor("─").repeat(Math.max(0, width));
    const innerWidth = Math.max(0, width - 2);
    return `${this.borderColor("╰")}${this.borderColor("─").repeat(innerWidth)}${this.borderColor("╯")}`;
  }

  private isHorizontalBorder(line: string, innerWidth: number): boolean {
    const raw = stripAnsi(line);
    if (raw.length === 0) return false;
    if (raw.replace(/─/g, "").length !== 0) return false;
    return visibleWidth(raw) === innerWidth;
  }

  private padToWidth(line: string, width: number): string {
    const pad = Math.max(0, width - visibleWidth(line));
    return `${line}${" ".repeat(pad)}`;
  }
}
