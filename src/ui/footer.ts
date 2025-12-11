import { type Component, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { theme } from "./theme.js";

/**
 * Single-line footer that keeps left and right blocks aligned.
 */
export class FooterComponent implements Component {
  private left = "";
  private right = "";

  setLeftRight(left: string, right: string) {
    this.left = left;
    this.right = right;
  }

  invalidate(): void {
    // no cache
  }

  render(width: number): string[] {
    if (width <= 0) return [""];

    const leftWidth = visibleWidth(this.left);
    const rightWidth = visibleWidth(this.right);

    let line: string;

    if (leftWidth + rightWidth + 1 > width) {
      const availableLeft = Math.max(0, width - rightWidth - 1);
      const truncatedLeft = truncateToWidth(this.left, availableLeft);
      line = `${truncatedLeft} ${this.right}`;
    } else {
      const spaces = " ".repeat(Math.max(1, width - leftWidth - rightWidth));
      line = `${this.left}${spaces}${this.right}`;
    }

    return [theme.palette.dim(line)];
  }
}
