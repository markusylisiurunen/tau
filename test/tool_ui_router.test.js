import { describe, expect, it } from "vitest";
import { ToolUiRouter } from "../dist/tui/tool_ui_router.js";

function createHarness() {
  const added = [];
  const replaced = [];
  const messageIds = new Set();
  let renders = 0;

  const chatContainer = {
    addMessage: (model, id) => {
      added.push({ model, id });
      messageIds.add(id);
      return id;
    },
    replaceMessage: (id, model) => {
      if (!messageIds.has(id)) {
        return false;
      }
      replaced.push({ id, model });
      return true;
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
    removeMessage: (id) => {
      messageIds.delete(id);
    },
    get renders() {
      return renders;
    },
  };
}

function getRunningBashMap(router) {
  return router.runningBashComponents;
}

function getRunningSubagentMap(router) {
  return router.runningSubagentTools;
}

function getLatestEventsMap(router) {
  return router.latestToolEventsById;
}

function findLatestReplacedEvent(replaced, id) {
  return replaced.findLast((entry) => entry.id === id)?.model.event;
}

function bashExecutionEvent(toolCallId, command) {
  return {
    type: "bash_execution",
    toolCallId,
    command,
    exitCode: 0,
    truncationInfo: {
      output: "ok",
      rawOutput: "ok",
      model: {
        truncated: false,
        totalLines: 1,
        outputLines: 1,
        totalBytes: 2,
        outputBytes: 2,
      },
      captureTruncated: false,
    },
    uiText: {
      previewLines: [{ text: "ok" }],
      statusLine: "exit 0",
      fullLines: [{ text: "ok" }],
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
      "[Tool result pruned] bash output removed (12 tokens). Re-run the command if needed.";
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

  it("adds one-shot tool cards with ids and renders pruned content without tones", () => {
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
    expect(patched.uiText.previewLines).toEqual([{ text: "- old" }, { text: "+ new" }]);
    expect(patched.uiText.fullLines).toEqual([{ text: "- old" }, { text: "+ new" }]);
  });

  it("patches blocked events that do not expose uiText", () => {
    const harness = createHarness();

    harness.router.handle({
      type: "bash_blocked",
      toolCallId: "bash-2",
      command: "echo hi",
      reason: "blocked",
    });

    const prunedContent =
      "[Tool result pruned] bash output removed (20 tokens). Re-run the command if needed.";
    harness.router.handle({
      type: "tool_pruned",
      toolCallId: "bash-2",
      content: prunedContent,
    });

    const patched = harness.replaced.at(-1)?.model.event;
    expect(patched.type).toBe("bash_blocked");
    expect(patched.command).toBe("echo hi");
    expect(patched.reason).toBe(prunedContent);
  });

  it("falls back to adding when cached tool ids are no longer present", () => {
    const harness = createHarness();

    harness.router.handle({
      type: "write_success",
      toolCallId: "write-1",
      path: "notes.txt",
      bytes: 9,
      lines: 1,
      content: "first",
      uiText: {
        previewLines: [{ text: "first" }],
        fullLines: [{ text: "first" }],
      },
    });

    harness.removeMessage("write-1");

    harness.router.handle({
      type: "write_success",
      toolCallId: "write-1",
      path: "notes.txt",
      bytes: 10,
      lines: 1,
      content: "second",
      uiText: {
        previewLines: [{ text: "second" }],
        fullLines: [{ text: "second" }],
      },
    });

    expect(harness.added).toHaveLength(2);
    expect(harness.added.at(-1)).toMatchObject({ id: "write-1" });
    expect(harness.replaced).toHaveLength(0);
  });
});

describe("ToolUiRouter lifecycle tracking", () => {
  it("tracks and untracks bash for execution and blocked lifecycles", () => {
    const harness = createHarness();

    harness.router.handle({
      type: "bash_started",
      toolCallId: "bash-exec",
      command: "echo one",
    });
    expect(getRunningBashMap(harness.router).has("bash-exec")).toBe(true);

    harness.router.handle(bashExecutionEvent("bash-exec", "echo one"));
    expect(getRunningBashMap(harness.router).has("bash-exec")).toBe(false);

    harness.router.handle({
      type: "bash_started",
      toolCallId: "bash-blocked",
      command: "echo two",
    });
    expect(getRunningBashMap(harness.router).has("bash-blocked")).toBe(true);

    harness.router.handle({
      type: "bash_blocked",
      toolCallId: "bash-blocked",
      command: "echo two",
      reason: "blocked",
    });
    expect(getRunningBashMap(harness.router).has("bash-blocked")).toBe(false);
    expect(harness.renders).toBe(4);
  });

  it("tracks subagent lifecycle transitions for start, finish, and blocked events", () => {
    const harness = createHarness();

    const cases = [
      {
        started: {
          type: "spawn_agent_started",
          toolCallId: "spawn-finish",
          name: "default",
          title: "spawn default",
        },
        terminal: {
          type: "spawn_agent_finished",
          toolCallId: "spawn-finish",
          name: "default",
          title: "spawn default",
          status: "success",
          message: "done",
        },
        blockedStarted: {
          type: "spawn_agent_started",
          toolCallId: "spawn-blocked",
          name: "default",
          title: "spawn blocked",
        },
        blocked: {
          type: "spawn_agent_blocked",
          toolCallId: "spawn-blocked",
          title: "spawn blocked",
          reason: "blocked",
        },
      },
      {
        started: {
          type: "send_input_to_agent_started",
          toolCallId: "send-finish",
          agentId: "agent-1",
          name: "default",
          title: "send input",
        },
        terminal: {
          type: "send_input_to_agent_finished",
          toolCallId: "send-finish",
          agentId: "agent-1",
          name: "default",
          title: "send input",
          status: "success",
          message: "sent",
        },
        blockedStarted: {
          type: "send_input_to_agent_started",
          toolCallId: "send-blocked",
          agentId: "agent-1",
          name: "default",
          title: "send blocked",
        },
        blocked: {
          type: "send_input_to_agent_blocked",
          toolCallId: "send-blocked",
          title: "send blocked",
          reason: "blocked",
        },
      },
      {
        started: {
          type: "wait_for_agent_started",
          toolCallId: "wait-finish",
          agentIds: ["agent-1", "agent-2"],
        },
        terminal: {
          type: "wait_for_agent_finished",
          toolCallId: "wait-finish",
          agentIds: ["agent-1", "agent-2"],
          status: "success",
          message: "ready",
        },
        blockedStarted: {
          type: "wait_for_agent_started",
          toolCallId: "wait-blocked",
          agentIds: ["agent-3"],
        },
        blocked: {
          type: "wait_for_agent_blocked",
          toolCallId: "wait-blocked",
          reason: "blocked",
        },
      },
      {
        started: {
          type: "terminate_agent_started",
          toolCallId: "terminate-finish",
          agentId: "agent-4",
        },
        terminal: {
          type: "terminate_agent_finished",
          toolCallId: "terminate-finish",
          agentId: "agent-4",
          status: "success",
          message: "terminated",
        },
        blockedStarted: {
          type: "terminate_agent_started",
          toolCallId: "terminate-blocked",
          agentId: "agent-5",
        },
        blocked: {
          type: "terminate_agent_blocked",
          toolCallId: "terminate-blocked",
          reason: "blocked",
        },
      },
    ];

    for (const entry of cases) {
      harness.router.handle(entry.started);
      expect(getRunningSubagentMap(harness.router).has(entry.started.toolCallId)).toBe(true);

      harness.router.handle(entry.terminal);
      expect(getRunningSubagentMap(harness.router).has(entry.started.toolCallId)).toBe(false);

      harness.router.handle(entry.blockedStarted);
      expect(getRunningSubagentMap(harness.router).has(entry.blockedStarted.toolCallId)).toBe(true);

      harness.router.handle(entry.blocked);
      expect(getRunningSubagentMap(harness.router).has(entry.blockedStarted.toolCallId)).toBe(
        false,
      );
    }
  });

  it("finalizes pending bash and subagent entries with aborted reason", () => {
    const harness = createHarness();

    harness.router.handle({
      type: "bash_started",
      toolCallId: "bash-pending",
      command: "echo pending",
    });
    harness.router.handle({
      type: "spawn_agent_started",
      toolCallId: "spawn-pending",
      name: "default",
      title: "spawn pending",
    });

    harness.router.finalizePending("aborted");

    const bashEvent = findLatestReplacedEvent(harness.replaced, "bash-pending");
    expect(bashEvent.type).toBe("bash_aborted");
    expect(bashEvent.reason).toBe("aborted");

    const subagentEvent = findLatestReplacedEvent(harness.replaced, "spawn-pending");
    expect(subagentEvent.type).toBe("spawn_agent_finished");
    expect(subagentEvent.status).toBe("error");
    expect(subagentEvent.message).toBe("aborted");
  });

  it("finalizes pending bash and subagent entries with interrupted reason", () => {
    const harness = createHarness();

    harness.router.handle({
      type: "bash_started",
      toolCallId: "bash-pending-int",
      command: "echo pending int",
    });
    harness.router.handle({
      type: "wait_for_agent_started",
      toolCallId: "wait-pending-int",
      agentIds: ["agent-1", "agent-2"],
    });

    harness.router.finalizePending("interrupted");

    const bashEvent = findLatestReplacedEvent(harness.replaced, "bash-pending-int");
    expect(bashEvent.type).toBe("bash_aborted");
    expect(bashEvent.reason).toBe("interrupted");

    const subagentEvent = findLatestReplacedEvent(harness.replaced, "wait-pending-int");
    expect(subagentEvent.type).toBe("wait_for_agent_finished");
    expect(subagentEvent.status).toBe("error");
    expect(subagentEvent.message).toBe("interrupted");
  });

  it("clears transient maps and resetSession clears all cached tool state", () => {
    const harness = createHarness();

    harness.router.handle({
      type: "bash_started",
      toolCallId: "bash-1",
      command: "echo one",
    });
    harness.router.handle({
      type: "send_input_to_agent_started",
      toolCallId: "send-1",
      agentId: "agent-1",
      name: "default",
      title: "send one",
    });

    expect(getRunningBashMap(harness.router).size).toBe(1);
    expect(getRunningSubagentMap(harness.router).size).toBe(1);
    expect(getLatestEventsMap(harness.router).size).toBe(2);

    harness.router.clearTransientState();

    expect(getRunningBashMap(harness.router).size).toBe(0);
    expect(getRunningSubagentMap(harness.router).size).toBe(0);
    expect(getLatestEventsMap(harness.router).size).toBe(2);

    harness.router.resetSession();

    expect(getRunningBashMap(harness.router).size).toBe(0);
    expect(getRunningSubagentMap(harness.router).size).toBe(0);
    expect(getLatestEventsMap(harness.router).size).toBe(0);
  });
});
