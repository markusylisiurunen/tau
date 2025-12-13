import { type Component, type TUI, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { theme } from "./theme.js";

export class FooterComponent implements Component {
  private ui: TUI;

  private idleIcon = "○";
  private iconFrames = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
  private currentIconFrame = 0;
  private iconIntervalId: ReturnType<typeof setInterval> | null = null;

  private left = "";
  private right = "";

  constructor(ui: TUI) {
    this.ui = ui;
  }

  startWorkingIcon() {
    this.ui.requestRender();
    this.iconIntervalId = setInterval(() => {
      this.currentIconFrame = (this.currentIconFrame + 1) % this.iconFrames.length;
      this.ui.requestRender();
    }, 80);
  }

  stop() {
    if (this.iconIntervalId) {
      clearInterval(this.iconIntervalId);
      this.iconIntervalId = null;
    }
    this.currentIconFrame = 0;
    this.ui.requestRender();
  }

  setLeftRight(left: string, right: string) {
    this.left = left;
    this.right = right;
  }

  invalidate() {}

  render(width: number) {
    if (width <= 0) return [""];

    const iconChar = this.iconIntervalId ? this.iconFrames[this.currentIconFrame]! : this.idleIcon;
    const icon = this.iconIntervalId ? theme.palette.accent(iconChar) : theme.palette.dim(iconChar);
    const iconWidth = visibleWidth(iconChar);
    const leftWidth = visibleWidth(this.left);
    const rightWidth = visibleWidth(this.right);

    let line: string;

    const totalContentWidth = 1 + iconWidth + 1 + leftWidth + rightWidth + 1;

    if (totalContentWidth > width) {
      const availableLeft = Math.max(0, width - 1 - iconWidth - 1 - rightWidth - 1);
      const truncatedLeft = truncateToWidth(this.left, availableLeft);
      line = ` ${icon} ${theme.palette.dim(`${truncatedLeft} ${this.right}`)}`;
    } else {
      const spaces = " ".repeat(Math.max(1, width - 1 - iconWidth - 1 - leftWidth - rightWidth));
      line = ` ${icon} ${theme.palette.dim(`${this.left}${spaces}${this.right}`)}`;
    }

    return [line];
  }
}
