import { Editor } from "@mariozechner/pi-tui";

/**
 * Thin wrapper around Editor to intercept a few global keys.
 * Mirrors pi-coding-agent behavior.
 */
export class CustomEditor extends Editor {
  public onCtrlC?: () => void;
  public onCtrlT?: () => void;
  public onShiftTab?: () => void;
  public onEscape?: () => void;

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

    // Ctrl+T to toggle thinking visibility.
    if (data === "\x14" && this.onCtrlT) {
      this.onCtrlT();
      return;
    }

    // Escape to interrupt assistant turn (but let the editor use Esc to cancel autocomplete).
    if (data === "\x1b" && this.onEscape && !this.isShowingAutocomplete()) {
      this.onEscape();
      return;
    }

    super.handleInput(data);
  }
}
