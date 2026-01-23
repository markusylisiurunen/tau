import { describe, expect, it } from "vitest";
import { renderToolOutput } from "../dist/tui/ui/tool_output.js";
import { createToolUiRegistry } from "../dist/tui/ui/tool_ui_registry.js";
import { createTagTheme, renderText } from "./ui_helpers.js";

function toLines(text) {
  return text ? text.split("\n").map((line) => ({ text: line })) : [];
}

function makeUiText(previewText, statusLine, fullText = "") {
  return {
    previewLines: toLines(previewText),
    statusLine,
    fullLines: toLines(fullText),
  };
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
      reason: "blocked",
    });
    expect(blocked).toContain("bash blocked");

    const aborted = renderEvent(registry, theme, {
      type: "bash_aborted",
      toolCallId: "b3",
      command: "sleep 5",
      reason: "aborted",
    });
    expect(aborted).toContain("aborted");
  });

  it("renders subagent tool events", () => {
    const spawnStarted = renderEvent(registry, theme, {
      type: "spawn_agent_started",
      toolCallId: "s1",
      name: "explore",
      title: "scan repo",
    });
    expect(spawnStarted).toContain("spawning");

    const spawnFinished = renderEvent(registry, theme, {
      type: "spawn_agent_finished",
      toolCallId: "s1",
      name: "explore",
      title: "scan repo",
      status: "success",
      agentId: "agent-1",
      uiText: makeUiText("    investigate repo", "    (agent-1)", "investigate repo"),
    });
    expect(spawnFinished).toContain("spawned");
    expect(spawnFinished).toContain("agent-1");

    const waitStarted = renderEvent(registry, theme, {
      type: "wait_for_agent_started",
      toolCallId: "w1",
      agentIds: ["agent-1", "agent-2"],
    });
    expect(waitStarted).toContain("waiting");

    const waitFinished = renderEvent(registry, theme, {
      type: "wait_for_agent_finished",
      toolCallId: "w1",
      agentIds: ["agent-1", "agent-2"],
      status: "error",
      message: "one failed",
      uiText: makeUiText(
        "    **agent-1**\n    ok",
        "    (cost $0.17 · duration 2m 33s)",
        "**agent-1**\nok",
      ),
    });
    expect(waitFinished).toContain("waited");
    expect(waitFinished).toContain("cost $0.17");

    const terminateFinished = renderEvent(registry, theme, {
      type: "terminate_agent_finished",
      toolCallId: "t1",
      agentId: "agent-1",
      status: "success",
      finalStatus: "aborted",
      uiText: makeUiText("    ok", "    (cost $0.05 · duration 1m 2s)", "ok"),
    });
    expect(terminateFinished).toContain("terminated");
    expect(terminateFinished).toContain("cost $0.05");
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
});
