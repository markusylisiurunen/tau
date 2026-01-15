import { describe, expect, it } from "vitest";
import { createToolUiRegistry } from "../dist/tui/ui/tool_ui_registry.js";
import { renderToolOutput } from "../dist/tui/ui/tool_output.js";
import { createTagTheme, renderText } from "./ui_helpers.js";

function makeUiText(previewText, statusLine, fullText = "") {
  return { previewText, statusLine, fullText };
}

function renderEvent(registry, theme, event, context = {}) {
  const view = registry.render(event, { theme, ...context });
  expect(view).toBeDefined();
  return renderText(renderToolOutput(view, true), 120);
}

describe("ToolUiRegistry", () => {
  const theme = createTagTheme();
  const registry = createToolUiRegistry();

  it("renders bash tool events", () => {
    const truncationInfo = {
      output: "ok",
      rawOutput: "ok",
      model: { truncated: false, totalLines: 1, outputLines: 1, totalBytes: 2, outputBytes: 2 },
      captureTruncated: false,
    };
    const uiText = makeUiText("    ok", "    (exit 0)", "ok");

    const started = renderEvent(registry, theme, {
      type: "bash_started",
      toolCallId: "b1",
      command: "ls",
    });
    expect(started).toContain("ls");

    const execution = renderEvent(registry, theme, {
      type: "bash_execution",
      toolCallId: "b1",
      command: "ls",
      exitCode: 0,
      truncationInfo,
      uiText,
      durationMs: 12,
    });
    expect(execution).toContain("ls");

    const blocked = renderEvent(registry, theme, {
      type: "bash_blocked",
      toolCallId: "b2",
      command: "rm -rf /",
      reason: "restricted",
    });
    expect(blocked).toContain("bash blocked");

    const abortedView = registry.renderBashAborted("sleep 5", "aborted", { theme });
    const aborted = renderText(renderToolOutput(abortedView, true), 120);
    expect(aborted).toContain("aborted");
  });

  it("renders task tool events", () => {
    const started = renderEvent(registry, theme, {
      type: "task_started",
      toolCallId: "t1",
      kind: "task",
      name: "worker",
      title: "do thing",
    });
    expect(started).toContain("task running");

    const progress = renderEvent(registry, theme, {
      type: "task_progress",
      toolCallId: "t1",
      kind: "task",
      name: "worker",
      title: "do thing",
      event: "agent: hello",
      costTotal: 1.25,
      turns: 2,
      toolCalls: 1,
    });
    expect(progress).toContain("task running");

    const finished = renderEvent(registry, theme, {
      type: "task_finished",
      toolCallId: "t1",
      kind: "fork",
      name: "",
      title: "fork job",
      costTotal: 0.5,
      turns: 1,
      toolCalls: 0,
      status: "success",
      finalOutput: "done",
    });
    expect(finished).toContain("fork finished");

    const blocked = renderEvent(registry, theme, {
      type: "task_blocked",
      toolCallId: "t2",
      kind: "task",
      name: "worker",
      title: "do thing",
      reason: "blocked",
    });
    expect(blocked).toContain("task blocked");
  });

  it("renders web tool events", () => {
    const searchStarted = renderEvent(registry, theme, {
      type: "web_search_started",
      toolCallId: "w1",
      objective: "latest tau release",
    });
    expect(searchStarted).toContain("web search");

    const searchFinished = renderEvent(registry, theme, {
      type: "web_search_finished",
      toolCallId: "w1",
      objective: "latest tau release",
      status: "success",
    });
    expect(searchFinished).toContain("web search");

    const fetchStarted = renderEvent(registry, theme, {
      type: "web_fetch_started",
      toolCallId: "w2",
      url: "https://example.com",
    });
    expect(fetchStarted).toContain("web fetch");

    const fetchFinished = renderEvent(registry, theme, {
      type: "web_fetch_finished",
      toolCallId: "w2",
      url: "https://example.com",
      status: "error",
    });
    expect(fetchFinished).toContain("web fetch");
  });

  it("renders file tool events", () => {
    const writeSuccess = renderEvent(registry, theme, {
      type: "write_success",
      path: "notes.txt",
      bytes: 12,
      lines: 1,
      content: "hello world",
      uiText: makeUiText("    hello world", "    (1 line)", "hello world"),
    });
    expect(writeSuccess).toContain("notes.txt");

    const writeBlocked = renderEvent(registry, theme, {
      type: "write_blocked",
      path: "notes.txt",
      reason: "blocked",
    });
    expect(writeBlocked).toContain("write blocked");

    const editSuccess = renderEvent(registry, theme, {
      type: "edit_success",
      path: "notes.txt",
      oldLength: 5,
      newLength: 11,
      oldText: "hello",
      newText: "hello world",
      uiText: makeUiText(
        "    - hello\n    + hello world",
        "    (+1, -1) · replaced 5 -> 11 chars",
        "replaced 5 -> 11 chars\n\n- hello\n+ hello world",
      ),
    });
    expect(editSuccess).toContain("notes.txt");

    const editBlocked = renderEvent(registry, theme, {
      type: "edit_blocked",
      path: "notes.txt",
      reason: "blocked",
    });
    expect(editBlocked).toContain("edit blocked");
  });

  it("renders restricted tool events", () => {
    const readSuccess = renderEvent(registry, theme, {
      type: "read_success",
      path: "README.md",
      startLine: 1,
      endLine: 2,
      content: "hello\nworld",
      modelTruncation: { truncated: false, totalLines: 2, outputLines: 2 },
      uiText: makeUiText("    hello\n    world", "    (2 lines · 1-2)", "hello\nworld"),
    });
    expect(readSuccess).toContain("README.md");

    const readBlocked = renderEvent(registry, theme, {
      type: "read_blocked",
      path: "README.md",
      reason: "blocked",
    });
    expect(readBlocked).toContain("read blocked");

    const listSuccess = renderEvent(registry, theme, {
      type: "list_success",
      path: ".",
      offset: 0,
      limit: 10,
      total: 2,
      returned: 2,
      entries: ["a.txt", "b.txt"],
      uiText: makeUiText(
        "    a.txt\n    b.txt",
        "    (2 of 2 entries · offset 0 · limit 10)",
        "a.txt\nb.txt",
      ),
    });
    expect(listSuccess).toContain("a.txt");

    const listBlocked = renderEvent(registry, theme, {
      type: "list_blocked",
      path: ".",
      reason: "blocked",
    });
    expect(listBlocked).toContain("list blocked");

    const grepStarted = renderEvent(registry, theme, {
      type: "grep_started",
      toolCallId: "g1",
      pattern: "needle",
    });
    expect(grepStarted).toContain("needle");

    const grepFinished = renderEvent(registry, theme, {
      type: "grep_finished",
      toolCallId: "g1",
      pattern: "needle",
      status: "success",
      exitCode: 0,
      stdout: "needle",
      stderr: "",
      captureTruncated: false,
      uiText: makeUiText("    needle", undefined, "needle"),
    });
    expect(grepFinished).toContain("needle");

    const grepBlocked = renderEvent(registry, theme, {
      type: "grep_blocked",
      toolCallId: "g2",
      pattern: "needle",
      reason: "blocked",
    });
    expect(grepBlocked).toContain("grep blocked");
  });
});
