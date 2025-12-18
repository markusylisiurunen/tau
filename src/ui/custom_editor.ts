import { Editor } from "@mariozechner/pi-tui";

export class CustomEditor extends Editor {
  public onCtrlC?: () => void;
  public onCtrlT?: () => void;
  public onCtrlO?: () => void;
  public onEscape?: () => void;
  public onShiftTab?: () => void;
  public onCtrlF?: () => void;
  public onAltUp?: () => void;
  public beforeSubmit?: (text: string) => boolean;

  getCursor(): { line: number; col: number } {
    return super.getCursor();
  }

  getLines(): string[] {
    return super.getLines();
  }

  handleInput(data: string): void {
    if ((data === "\x1b[Z" || data === "\x1b[1;2Z") && this.onShiftTab) {
      this.onShiftTab();
      return;
    }

    if (data === "\x03" && this.onCtrlC) {
      this.onCtrlC();
      return;
    }

    if (data === "\x14" && this.onCtrlT) {
      this.onCtrlT();
      return;
    }

    if (data === "\x0f" && this.onCtrlO && !this.isShowingAutocomplete()) {
      this.onCtrlO();
      return;
    }

    if (data === "\x06" && this.onCtrlF && !this.isShowingAutocomplete()) {
      this.onCtrlF();
      return;
    }

    if (
      (data === "\x1b[1;3A" || data === "\x1b[1;9A") &&
      this.onAltUp &&
      !this.isShowingAutocomplete()
    ) {
      this.onAltUp();
      return;
    }

    if (
      data.charCodeAt(0) === 13 &&
      data.length === 1 &&
      this.beforeSubmit &&
      !this.isShowingAutocomplete()
    ) {
      if (!this.beforeSubmit(this.getText())) {
        return;
      }
    }

    if (data === "\x1b" && this.onEscape && !this.isShowingAutocomplete()) {
      this.onEscape();
      return;
    }

    super.handleInput(data);
  }
}
