import { describe, expect, it } from "vitest";
import { ToolUiRouter } from "../dist/tui/tool_ui_router.js";

function createHarness() {
  const added = [];
  const replaced = [];
  let renders = 0;

  const chatContainer = {
    addMessage: (model, id) => {
      added.push({ model, id });
      return id;
    },
    replaceMessage: (id, model) => {
      replaced.push({ id, model });
    },
  };

  const router = new ToolUiRouter({
    chatContainer,
    requestRender: () => {
      renders += 1;
    },
  });

  return {
    router,
    added,
    replaced,
    get renders() {
      return renders;
    },
  };
}

describe("ToolUiRouter prune mutations", () => {
  it("patches existing tool cards by toolCallId and preserves the base event type", () => {
    const harness = createHarness();

    harness.router.handle({
      type: "bash_started",
      toolCallId: "bash-1",
      command: "echo hello",
    });

    harness.router.handle({
      type: "bash_execution",
      toolCallId: "bash-1",
      command: "echo hello",
      exitCode: 0,
      truncationInfo: {
        output: "hello",
        rawOutput: "hello",
        model: {
          truncated: false,
          totalLines: 1,
          outputLines: 1,
          totalBytes: 5,
          outputBytes: 5,
        },
        captureTruncated: false,
      },
      uiText: {
        previewLines: [{ text: "hello" }],
        statusLine: "exit 0",
        fullLines: [{ text: "hello" }],
      },
    });

    const prunedContent =
      "[tool result pruned] bash output removed (12 tokens). re-run the command if needed.";
    harness.router.handle({
      type: "tool_pruned",
      toolCallId: "bash-1",
      content: prunedContent,
    });

    const patched = harness.replaced.at(-1)?.model.event;
    expect(patched.type).toBe("bash_execution");
    expect(patched.command).toBe("echo hello");
    expect(patched.uiText.statusLine).toBe("✂ pruned · exit 0");
    expect(patched.uiText.previewLines).toEqual([{ text: prunedContent }]);
    expect(patched.uiText.fullLines).toEqual([{ text: prunedContent }]);
  });

  it("adds one-shot tool cards with ids and marks pruned diffs with standard tones", () => {
    const harness = createHarness();

    harness.router.handle({
      type: "write_success",
      toolCallId: "write-1",
      path: "notes.txt",
      bytes: 9,
      lines: 1,
      content: "old text",
      uiText: {
        previewLines: [{ text: "old text" }],
        fullLines: [{ text: "old text" }],
      },
    });

    expect(harness.added.at(-1)).toMatchObject({ id: "write-1" });

    harness.router.handle({
      type: "tool_pruned",
      toolCallId: "write-1",
      content: "- old\n+ new",
    });

    const patched = harness.replaced.at(-1)?.model.event;
    expect(patched.type).toBe("write_success");
    expect(patched.path).toBe("notes.txt");
    expect(patched.uiText.statusLine).toBe("✂ pruned");
    expect(patched.uiText.previewLines).toEqual([
      { text: "- old", tone: "diffRemove" },
      { text: "+ new", tone: "diffAdd" },
    ]);
    expect(patched.uiText.fullLines).toEqual([
      { text: "- old", tone: "diffRemove" },
      { text: "+ new", tone: "diffAdd" },
    ]);
  });
});
