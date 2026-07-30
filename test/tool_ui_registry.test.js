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

  it("renders generic tool call lifecycle events", () => {
    const streaming = renderEvent(registry, theme, {
      type: "tool_call_streaming",
      toolCallId: "q1",
      toolName: "write",
      headerTarget: "write",
    });
    expect(streaming).toContain("preparing");
    expect(streaming).toContain("write");

    const queued = renderEvent(registry, theme, {
      type: "tool_call_queued",
      toolCallId: "q1",
      toolName: "bash",
      headerTarget: "printf hello",
    });
    expect(queued).toContain("queued");
    expect(queued).toContain("printf hello");
    expect(queued).not.toContain("bash");

    const blocked = renderEvent(registry, theme, {
      type: "tool_call_blocked",
      toolCallId: "q1",
      toolName: "write",
      headerTarget: "write",
      reason: "disabled",
    });
    expect(blocked).toContain("tool call blocked");
    expect(blocked).toContain("disabled");
  });

  it("renders client tool completion events", () => {
    const rendered = renderEvent(registry, theme, {
      type: "client_tool_finished",
      toolCallId: "c1",
      toolName: "local_picker",
      headerTarget: "local_picker",
      status: "success",
      uiText: makeUiText("    picked a", "    (success · 1 line · ~1 token · 8 B)", "picked a"),
    });
    expect(rendered).toContain("completed");
    expect(rendered).toContain("local_picker");
    expect(rendered).toContain("picked a");
    expect(rendered).toContain("success · 1 line · ~1 token · 8 B");
  });

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
      headerTarget: "ls",
    });
    expect(started).toContain("ls");

    const execution = renderEvent(registry, theme, {
      type: "bash_execution",
      toolCallId: "b1",
      command: "ls",
      headerTarget: "ls",
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
      headerTarget: "rm -rf /",
      reason: "blocked",
    });
    expect(blocked).toContain("bash blocked");

    const aborted = renderEvent(registry, theme, {
      type: "bash_aborted",
      toolCallId: "b3",
      command: "sleep 5",
      headerTarget: "sleep 5",
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
      headerTarget: "scan repo",
    });
    expect(spawnStarted).toContain("spawning");

    const spawnFinished = renderEvent(registry, theme, {
      type: "spawn_agent_finished",
      toolCallId: "s1",
      name: "explore",
      title: "scan repo",
      headerTarget: "scan repo",
      status: "success",
      agentId: "agent-1",
      uiText: makeUiText("    investigate repo", "    (agent-1)", "investigate repo"),
    });
    expect(spawnFinished).toContain("spawned");
    expect(spawnFinished).toContain("agent-1");

    const sendStarted = renderEvent(registry, theme, {
      type: "send_input_to_agent_started",
      toolCallId: "si1",
      agentId: "agent-1",
      name: "explore",
      title: "scan repo",
      headerTarget: "scan repo",
    });
    expect(sendStarted).toContain("sending");

    const sendFinished = renderEvent(registry, theme, {
      type: "send_input_to_agent_finished",
      toolCallId: "si1",
      agentId: "agent-1",
      name: "explore",
      title: "scan repo",
      headerTarget: "scan repo",
      status: "success",
      uiText: makeUiText("    follow-up", "    (explore · agent-1)", "follow-up"),
    });
    expect(sendFinished).toContain("sent input");
    expect(sendFinished).toContain("agent-1");

    const waitStarted = renderEvent(registry, theme, {
      type: "wait_for_agents_started",
      toolCallId: "w1",
      agentIds: ["agent-1", "agent-2"],
      headerTarget: "agent-1, agent-2",
    });
    expect(waitStarted).toContain("waiting");

    const waitFinished = renderEvent(registry, theme, {
      type: "wait_for_agents_finished",
      toolCallId: "w1",
      agentIds: ["agent-1", "agent-2"],
      headerTarget: "agent-1, agent-2",
      status: "error",
      message: "one failed",
      uiText: makeUiText(
        "    **agent-1**\n    ok",
        "    (cost $0.17 · duration 2m 33s)",
        "**agent-1**\nok",
      ),
    });
    expect(waitFinished).toContain("wait failed");
    expect(waitFinished).toContain("cost $0.17");

    const terminateFinished = renderEvent(registry, theme, {
      type: "terminate_agent_finished",
      toolCallId: "t1",
      agentId: "agent-1",
      headerTarget: "agent-1",
      status: "success",
      finalStatus: "aborted",
      uiText: makeUiText("    ok", "    (cost $0.05 · duration 1m 2s)", "ok"),
    });
    expect(terminateFinished).toContain("terminated");
    expect(terminateFinished).toContain("cost $0.05");
  });

  it("renders fallback subagent error text when uiText is absent", () => {
    const spawnFailed = renderEvent(registry, theme, {
      type: "spawn_agent_finished",
      toolCallId: "s2",
      name: "explore",
      title: "scan repo",
      headerTarget: "scan repo",
      status: "error",
      message: "aborted",
    });
    expect(spawnFailed).toContain("spawn failed");
    expect(spawnFailed).toContain("aborted");

    const terminateFailed = renderEvent(registry, theme, {
      type: "terminate_agent_finished",
      toolCallId: "t2",
      agentId: "agent-2",
      headerTarget: "agent-2",
      status: "error",
      finalStatus: "aborted",
    });
    expect(terminateFailed).toContain("terminate failed");
    expect(terminateFailed).toContain("final status: aborted");
  });

  it("renders code-mode tool events", () => {
    const code = Array.from({ length: 12 }, (_, index) => `code line ${index + 1}`).join("\n");
    const queued = renderEvent(registry, theme, {
      type: "tool_call_queued",
      toolCallId: "w1",
      toolName: "web",
      headerTarget: "code line 1",
      code,
    });
    expect(queued).toContain("<textMuted>queued</textMuted> <brandAccent>web</brandAccent>");
    expect(queued).toContain("code line 10");
    expect(queued).not.toContain("code line 11");
    expect(queued).toContain("2 more lines");

    const started = renderEvent(registry, theme, {
      type: "code_mode_started",
      toolCallId: "w1",
      toolName: "web",
      code,
      headerTarget: "code line 1",
    });
    expect(started).toContain("<textMuted>running</textMuted> <brandAccent>web</brandAccent>");
    expect(started).toContain("code line 10");
    expect(started).toContain("2 more lines");

    const finished = renderEvent(registry, theme, {
      type: "code_mode_finished",
      toolCallId: "w1",
      toolName: "web",
      code,
      headerTarget: "code line 1",
      status: "success",
      uiText: {
        previewLines: [{ text: "formatted result" }],
        statusLine: "exit 0",
        fullLines: [{ text: "formatted result" }],
      },
    });
    expect(finished).toContain("<textMuted>completed</textMuted> <brandAccent>web</brandAccent>");
    expect(finished).toContain("code line 10");
    expect(finished).toContain("2 more lines");
    expect(finished).toContain("formatted result");

    const failed = renderEvent(registry, theme, {
      type: "code_mode_finished",
      toolCallId: "w2",
      toolName: "web",
      code: "throw new Error('failed')",
      headerTarget: "throw new Error('failed')",
      status: "error",
      uiText: {
        previewLines: [{ text: "program failed" }],
        statusLine: "exit 1",
        fullLines: [{ text: "program failed" }],
      },
    });
    expect(failed).toContain("<textMuted>failed</textMuted> <brandAccent>web</brandAccent>");
    expect(failed).toContain("throw new Error('failed')");

    const blocked = renderEvent(registry, theme, {
      type: "code_mode_blocked",
      toolCallId: "w3",
      toolName: "web",
      code: "console.log(docs)",
      headerTarget: "console.log(docs)",
      reason: "Missing Exa API key.",
    });
    expect(blocked).toContain("<textMuted>blocked</textMuted> <brandAccent>web</brandAccent>");
    expect(blocked).toContain("console.log(docs)");
    expect(blocked).toContain("Missing Exa API key.");
  });

  it("renders file tool events", () => {
    const writeSuccess = renderEvent(registry, theme, {
      type: "write_success",
      toolCallId: "write-1",
      path: "notes.txt",
      headerTarget: "notes.txt",
      bytes: 12,
      lines: 1,
      content: "hello world",
      uiText: makeUiText("    hello world", "    (1 line)", "hello world"),
    });
    expect(writeSuccess).toContain("notes.txt");

    const writeBlocked = renderEvent(registry, theme, {
      type: "write_blocked",
      toolCallId: "write-2",
      path: "notes.txt",
      headerTarget: "notes.txt",
      reason: "blocked",
    });
    expect(writeBlocked).toContain("write blocked");

    const editSuccess = renderEvent(registry, theme, {
      type: "edit_success",
      toolCallId: "edit-1",
      path: "notes.txt",
      headerTarget: "notes.txt",
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
      toolCallId: "edit-2",
      path: "notes.txt",
      headerTarget: "notes.txt",
      reason: "blocked",
    });
    expect(editBlocked).toContain("edit blocked");
  });
});
