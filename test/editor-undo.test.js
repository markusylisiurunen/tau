import { describe, expect, it } from "vitest";

import { Editor } from "../dist/tui/ui/components/editor.js";

function createEditor() {
  return new Editor({
    borderColor: (text) => text,
    selectList: {},
  });
}

describe("editor undo", () => {
  it("coalesces consecutive word characters into one undo unit", () => {
    const editor = createEditor();

    editor.handleInput("h");
    editor.handleInput("e");
    editor.handleInput("l");
    editor.handleInput("l");
    editor.handleInput("o");

    expect(editor.getText()).toBe("hello");

    editor.handleInput("\x1b[45;5u");

    expect(editor.getText()).toBe("");
  });

  it("undoes backspace", () => {
    const editor = createEditor();

    editor.setText("hello");
    editor.handleInput("\x7f");

    expect(editor.getText()).toBe("hell");

    editor.handleInput("\x1b[45;5u");

    expect(editor.getText()).toBe("hello");
  });

  it("undoes insertTextAtCursor atomically", () => {
    const editor = createEditor();

    editor.setText("hello");
    editor.insertTextAtCursor(" world");

    expect(editor.getText()).toBe("hello world");

    editor.handleInput("\x1b[45;5u");

    expect(editor.getText()).toBe("hello");
  });

  it("restores the pre-history state on undo", () => {
    const editor = createEditor();

    editor.addToHistory("first");
    editor.addToHistory("second");

    editor.handleInput("\x1b[A");
    expect(editor.getText()).toBe("second");

    editor.handleInput("\x1b[45;5u");
    expect(editor.getText()).toBe("");
  });
});
