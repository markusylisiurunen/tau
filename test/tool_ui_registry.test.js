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

  it("renders queued tool call events", () => {
    const queued = renderEvent(registry, theme, {
      type: "tool_call_queued",
      toolCallId: "q1",
      toolName: "bash",
      headerTarget: "bash",
    });
    expect(queued).toContain("queued");
    expect(queued).toContain("bash");
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

  it("renders diff review tool status with a blank line before review agents", () => {
    const rendered = renderEvent(registry, theme, {
      type: "diff_review_updated",
      toolCallId: "diff-1",
      command: "git diff --staged",
      headerTarget: "git diff --staged",
      reviewedFiles: ["src/a.ts"],
      diffToolUiText: "http://127.0.0.1:4321",
      reviewAgents: [
        {
          threadId: "12345678-90ab-cdef-1234-567890abcdef",
          status: "running",
          costTotal: 0.12,
          usage: {
            input: 1200,
            output: 320,
            cacheRead: 64,
            cacheWrite: 0,
            contextWindowUsageTokens: 1584,
            contextWindow: 200000,
          },
        },
      ],
    });

    const addressIndex = rendered.indexOf("http://127.0.0.1:4321");
    const agentIndex = rendered.indexOf("12345678-90ab-cdef-1234-567890abcdef");
    expect(addressIndex).toBeGreaterThan(-1);
    expect(agentIndex).toBeGreaterThan(addressIndex);
    expect(rendered.slice(addressIndex, agentIndex)).toContain("<textDim>    </textDim>");
  });

  it("renders completed diff review tool cards from final tool output", () => {
    const rendered = renderEvent(registry, theme, {
      type: "diff_review_finished",
      toolCallId: "diff-1",
      command: "git diff --staged",
      headerTarget: "git diff --staged",
      status: "success",
      reviewedFiles: ["src/a.ts"],
      diffToolUiText: "http://127.0.0.1:4321",
      reviewAgents: [
        {
          threadId: "12345678-90ab-cdef-1234-567890abcdef",
          status: "idle",
          costTotal: 0.12,
          usage: {
            input: 1200,
            output: 320,
            cacheRead: 64,
            cacheWrite: 0,
            contextWindowUsageTokens: 1584,
            contextWindow: 200000,
          },
        },
      ],
      uiText: makeUiText(
        "Diff review completed.\nReview:\nLooks good.",
        "success · 1 reviewed file",
        "Diff review completed.\nReview:\nLooks good.",
      ),
    });

    expect(rendered).toContain("Diff review completed.");
    expect(rendered).toContain("Looks good.");
    expect(rendered).not.toContain("http://127.0.0.1:4321");
    expect(rendered).not.toContain("12345678-90ab-cdef-1234-567890abcdef");
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

  it("renders web tool events", () => {
    const searchStarted = renderEvent(registry, theme, {
      type: "web_search_started",
      toolCallId: "w1",
      objective: "latest tau release",
      headerTarget: "latest tau release",
    });
    expect(searchStarted).toContain("web search");

    const searchFinished = renderEvent(registry, theme, {
      type: "web_search_finished",
      toolCallId: "w1",
      objective: "latest tau release",
      headerTarget: "latest tau release",
      status: "success",
    });
    expect(searchFinished).toContain("web search");

    const searchFailed = renderEvent(registry, theme, {
      type: "web_search_finished",
      toolCallId: "w1b",
      objective: "latest tau release",
      headerTarget: "latest tau release",
      status: "error",
      message: "missing Parallel API key.",
    });
    expect(searchFailed).toContain("missing Parallel API key.");

    const fetchStarted = renderEvent(registry, theme, {
      type: "web_fetch_started",
      toolCallId: "w2",
      url: "https://example.com",
      headerTarget: "https://example.com",
    });
    expect(fetchStarted).toContain("web fetch");

    const fetchFinished = renderEvent(registry, theme, {
      type: "web_fetch_finished",
      toolCallId: "w2",
      url: "https://example.com",
      headerTarget: "https://example.com",
      status: "error",
      message: "request failed",
    });
    expect(fetchFinished).toContain("web fetch");
    expect(fetchFinished).toContain("request failed");
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
