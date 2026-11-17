import { describe, expect, it } from "vitest";

import { Editor } from "../dist/tui/ui/components/editor.js";

function createEditor() {
  return new Editor({
    borderColor: (text) => text,
    selectList: {},
  });
}

describe("editor undo", () => {
  it("replaces previews at the original cursor and commits one undo unit", () => {
    const editor = createEditor();
    editor.setText("before after");
    editor.handleInput("\x01");
    for (let i = 0; i < 7; i++) editor.handleInput("\x1b[C");
    const preview = editor.beginTextPreview();
    preview.update("first ");
    preview.update("revised\ntext ");
    expect(editor.getText()).toBe("before revised\ntext after");
    preview.commit("final ");
    expect(editor.getText()).toBe("before final after");
    expect(editor.getCursor()).toEqual({ line: 0, col: 13 });
    preview.update("late");
    preview.cancel();
    expect(editor.getText()).toBe("before final after");
    editor.handleInput("\x1b[45;5u");
    expect(editor.getText()).toBe("before after");
    expect(editor.getCursor()).toEqual({ line: 0, col: 7 });
  });

  it("cancels previews without losing paste contents or the original cursor", () => {
    const editor = createEditor();
    const pasted = "long content ".repeat(200);
    editor.handleInput(`\x1b[200~${pasted}\x1b[201~`);
    const original = editor.getText();
    const cursor = editor.getCursor();
    const preview = editor.beginTextPreview();
    preview.update("provisional");
    preview.update("");
    expect(editor.getText()).toBe(original);
    preview.cancel();
    preview.update("late");
    expect(editor.getExpandedText()).toBe(pasted);
    expect(editor.getCursor()).toEqual(cursor);
  });

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
