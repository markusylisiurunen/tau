import {
  Editor,
  isCtrlC,
  isCtrlO,
  isCtrlT,
  isEnter,
  isEscape,
  isShiftTab,
} from "@mariozechner/pi-tui";
import { isKittyCtrl } from "@mariozechner/pi-tui/dist/keys.js";

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
    if ((isShiftTab(data) || data === "\x1b[1;2Z") && this.onShiftTab) {
      this.onShiftTab();
      return;
    }

    if (isCtrlC(data) && this.onCtrlC) {
      this.onCtrlC();
      return;
    }

    if (isCtrlT(data) && this.onCtrlT) {
      this.onCtrlT();
      return;
    }

    if (isCtrlO(data) && this.onCtrlO && !this.isShowingAutocomplete()) {
      this.onCtrlO();
      return;
    }

    if (
      (data === "\x06" || isKittyCtrl(data, "f")) &&
      this.onCtrlF &&
      !this.isShowingAutocomplete()
    ) {
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

    if (isEnter(data) && this.beforeSubmit && !this.isShowingAutocomplete()) {
      if (!this.beforeSubmit(this.getText())) {
        return;
      }
    }

    if (isEscape(data) && this.onEscape && !this.isShowingAutocomplete()) {
      this.onEscape();
      return;
    }

    super.handleInput(data);
  }
}
