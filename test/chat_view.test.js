import headless from "@xterm/headless";
import { describe, expect, it, vi } from "vitest";
import { TuiChatView } from "../dist/tui/chat_view.js";
import { createAppTerminal } from "../dist/tui/terminal.js";

vi.mock("../dist/tui/terminal.js", async (importOriginal) => ({
  ...(await importOriginal()),
  createAppTerminal: vi.fn(),
}));

function readLines(terminal, start, end) {
  const lines = [];
  for (let index = start; index < end; index += 1) {
    lines.push(terminal.buffer.active.getLine(index)?.translateToString(true) ?? "");
  }
  return lines
    .map((line) => line.trimEnd())
    .filter(Boolean)
    .join("\n");
}

function flushTerminal(terminal) {
  return new Promise((resolve) => terminal.write("", resolve));
}

function createHeadlessView() {
  const terminal = new headless.Terminal({
    cols: 80,
    rows: 24,
    scrollback: 20000,
    allowProposedApi: true,
  });
  let onResize;
  const writes = [];
  createAppTerminal.mockReturnValue({
    start: (_onInput, resize) => {
      onResize = resize;
    },
    stop() {},
    write: (data) => {
      writes.push(data);
      terminal.write(data);
    },
    get columns() {
      return terminal.cols;
    },
    get rows() {
      return terminal.rows;
    },
    hideCursor() {},
    showCursor() {},
    setProgramStatus() {},
    setProgress() {},
  });
  terminal.write("shell output\r\nlaunch tau\r\n");
  const view = new TuiChatView({ showThinking: false, themes: [] });
  return {
    terminal,
    view,
    writes,
    resize: (columns, rows) => {
      terminal.resize(columns, rows);
      onResize();
    },
  };
}

describe("TuiChatView transcript detachment", () => {
  it.each([
    { messages: 0, editorLines: 1 },
    { messages: 1, editorLines: 1 },
    { messages: 1000, editorLines: 1 },
    { messages: 1, editorLines: 40 },
    { messages: 1000, editorLines: 40 },
  ])(
    "preserves scrollback with $messages messages and $editorLines editor lines",
    async ({ messages, editorLines }) => {
      const { terminal, view, writes, resize } = createHeadlessView();
      const editorText = Array.from({ length: editorLines }, (_, index) => `draft-${index}`).join(
        "\n",
      );
      view.setEditorText(editorText);
      const resetSubagents = vi.spyOn(view.subagentPanel, "reset");
      view.start();
      try {
        for (let index = 0; index < messages; index += 1) {
          view.addMessage({ type: "user", text: `old-message-${index}-end` }, `old-${index}`);
        }
        view.ui.renderNow();
        // This message has not reached a frame when compaction arrives.
        view.addMessage({ type: "user", text: "pending-final-message" }, "pending-final");
        view.detachTranscript();
        expect(view.chatContainer.allMessages).toEqual([]);
        expect(view.chatContainer.idToIndex.size).toBe(0);
        expect(view.chatContainer.chatContainer.children).toEqual([]);
        expect(view.chatContainer.cachedRenderLines).toBeUndefined();
        expect(view.ui.captureRenderState().previousLines).toEqual([]);
        expect(view.getEditorText()).toBe(editorText);
        expect(resetSubagents).not.toHaveBeenCalled();
        await flushTerminal(terminal);

        const frozen = readLines(terminal, 0, terminal.buffer.active.baseY);
        expect(frozen).toContain("shell output");
        for (let index = 0; index < messages; index += 1) {
          expect(frozen).toContain(`old-message-${index}-end`);
        }
        expect(frozen).toContain("pending-final-message");

        view.addMessage({ type: "user", text: "active-summary" }, "summary");
        view.ui.renderNow();
        view.setThinkingVisibility(true);
        view.updateTheme("default");
        view.ui.renderNow();
        resize(65, 30);
        view.ui.renderNow();
        await flushTerminal(terminal);
        expect(readLines(terminal, 0, terminal.buffer.active.length)).toContain(frozen);
        expect(writes.join("")).not.toContain("\x1b[3J");
        expect(view.chatContainer.allMessages.map((record) => record.id)).toEqual(["summary"]);
        expect(view.ui.captureRenderState().previousLines.join("\n")).not.toContain("old-message-");

        for (let index = 0; index < 3; index += 1) {
          view.detachTranscript();
          view.addMessage({ type: "user", text: `next-summary-${index}` }, "summary");
          view.ui.renderNow();
          expect(view.chatContainer.allMessages).toHaveLength(1);
        }
        await flushTerminal(terminal);
        expect(readLines(terminal, 0, terminal.buffer.active.length)).toContain(frozen);
      } finally {
        view.stop();
        terminal.dispose();
      }
    },
  );
});

describe("TuiChatView scrollback redraws", () => {
  it.each([false, true])(
    "keeps one copy of each message across theme and height changes (detached: %s)",
    async (detach) => {
      const { terminal, view, writes, resize } = createHeadlessView();
      const messages = [];
      const addMessages = (count) => {
        for (let index = 0; index < count; index += 1) {
          const text = `message-${messages.length}-end`;
          messages.push(text);
          view.addMessage({ type: "user", text }, text);
        }
        view.ui.renderNow();
      };
      const expectSingleCopies = async () => {
        await flushTerminal(terminal);
        const output = readLines(terminal, 0, terminal.buffer.active.length);
        expect(output).toContain("shell output");
        for (const message of messages) {
          expect(output.split(message).length - 1, message).toBe(1);
        }
      };
      view.start();
      try {
        addMessages(30);
        await expectSingleCopies();
        if (detach) {
          view.detachTranscript();
          addMessages(10);
          await expectSingleCopies();
        }
        for (const [columns, rows] of [
          [80, 50],
          [80, 30],
          [80, 18],
          [80, 24],
        ]) {
          view.updateTheme("default");
          view.ui.renderNow(true);
          await expectSingleCopies();
          resize(columns, rows);
          view.ui.renderNow();
          await expectSingleCopies();
          addMessages(12);
          await expectSingleCopies();
        }
        view.detachTranscript();
        addMessages(10);
        await expectSingleCopies();
        expect(writes.join("")).not.toContain("\x1b[2J");
        expect(writes.join("")).not.toContain("\x1b[3J");
      } finally {
        view.stop();
        terminal.dispose();
      }
    },
  );
});
