import { Editor } from "@mariozechner/pi-tui";

/**
 * Thin wrapper around Editor to intercept a few global keys.
 * Mirrors pi-coding-agent behavior.
 */
export class CustomEditor extends Editor {
  public onCtrlC?: () => void;
  public onShiftTab?: () => void;

  handleInput(data: string): void {
    // Shift+Tab for thinking level cycling.
    if ((data === "\x1b[Z" || data === "\x1b[1;2Z") && this.onShiftTab) {
      this.onShiftTab();
      return;
    }

    // Ctrl+C to exit.
    if (data === "\x03" && this.onCtrlC) {
      this.onCtrlC();
      return;
    }

    super.handleInput(data);
  }
}
