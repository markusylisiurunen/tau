import { Editor, Key, matchesKey } from "@mariozechner/pi-tui";

export class CustomEditor extends Editor {
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

  getCursor(): { line: number; col: number } {
    return super.getCursor();
  }

  getLines(): string[] {
    return super.getLines();
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
}
