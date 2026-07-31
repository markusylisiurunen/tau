import { describe, expect, it } from "vitest";
import { ToolUiRouter } from "../dist/tui/tool_ui_router.js";

function createHarness() {
  const added = [];
  const replaced = [];
  const removed = [];
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
    updateMessage: (id, model) => {
      if (!messageIds.has(id)) {
        return false;
      }
      replaced.push({ id, model });
      return true;
    },
    removeMessages: (ids) => {
      removed.push(...ids);
      for (const id of ids) {
        messageIds.delete(id);
      }
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
    handleSession: (event) => router.handle(event, "session"),
    handleLocal: (event) => router.handle(event, "local"),
    added,
    replaced,
    removed,
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

describe("ToolUiRouter snapshot reconciliation", () => {
  it("rebuilds session cards while preserving local cards", () => {
    const harness = createHarness();
    harness.handleLocal({
      type: "bash_started",
      toolCallId: "local-call",
      command: "pwd",
      headerTarget: "pwd",
    });
    harness.handleSession({
      type: "tool_call_streaming",
      toolCallId: "stale-call",
      toolName: "write",
      headerTarget: "write",
    });
    harness.handleSession({
      type: "tool_call_streaming",
      toolCallId: "current-call",
      toolName: "bash",
      headerTarget: "bash",
    });

    harness.router.reconcileSession(["current-call"]);

    expect(harness.removed).toEqual(["stale-call"]);
    expect([...getLatestEventsMap(harness.router).keys()]).toEqual(["local-call"]);
    expect(getRunningBashMap(harness.router).has("local-call")).toBe(true);

    harness.handleSession({
      type: "tool_call_queued",
      toolCallId: "current-call",
      toolName: "bash",
      headerTarget: "bash",
    });
    harness.handleLocal(bashExecutionEvent("local-call", "pwd"));

    expect(harness.added.filter((entry) => entry.id === "current-call")).toHaveLength(1);
    expect(findLatestReplacedEvent(harness.replaced, "current-call")).toMatchObject({
      type: "tool_call_queued",
    });
    expect(findLatestReplacedEvent(harness.replaced, "local-call")).toMatchObject({
      type: "bash_execution",
    });
    expect(getRunningBashMap(harness.router).has("local-call")).toBe(false);
  });
});

describe("ToolUiRouter lifecycle tracking", () => {
  it("tracks and untracks bash for execution and blocked lifecycles", () => {
    const harness = createHarness();

    harness.handleSession({
      type: "bash_started",
      toolCallId: "bash-exec",
      command: "echo one",
    });
    expect(getRunningBashMap(harness.router).has("bash-exec")).toBe(true);

    harness.handleSession(bashExecutionEvent("bash-exec", "echo one"));
    expect(getRunningBashMap(harness.router).has("bash-exec")).toBe(false);

    harness.handleSession({
      type: "bash_started",
      toolCallId: "bash-blocked",
      command: "echo two",
    });
    expect(getRunningBashMap(harness.router).has("bash-blocked")).toBe(true);

    harness.handleSession({
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
          type: "wait_for_agents_started",
          toolCallId: "wait-finish",
          agentIds: ["agent-1", "agent-2"],
        },
        terminal: {
          type: "wait_for_agents_finished",
          toolCallId: "wait-finish",
          agentIds: ["agent-1", "agent-2"],
          status: "success",
          message: "ready",
        },
        blockedStarted: {
          type: "wait_for_agents_started",
          toolCallId: "wait-blocked",
          agentIds: ["agent-3"],
        },
        blocked: {
          type: "wait_for_agents_blocked",
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
      harness.handleSession(entry.started);
      expect(getRunningSubagentMap(harness.router).has(entry.started.toolCallId)).toBe(true);

      harness.handleSession(entry.terminal);
      expect(getRunningSubagentMap(harness.router).has(entry.started.toolCallId)).toBe(false);

      harness.handleSession(entry.blockedStarted);
      expect(getRunningSubagentMap(harness.router).has(entry.blockedStarted.toolCallId)).toBe(true);

      harness.handleSession(entry.blocked);
      expect(getRunningSubagentMap(harness.router).has(entry.blockedStarted.toolCallId)).toBe(
        false,
      );
    }
  });

  it("finalizes pending bash and subagent entries with aborted reason", () => {
    const harness = createHarness();

    harness.handleSession({
      type: "bash_started",
      toolCallId: "bash-pending",
      command: "echo pending",
    });
    harness.handleSession({
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

    harness.handleSession({
      type: "bash_started",
      toolCallId: "bash-pending-int",
      command: "echo pending int",
    });
    harness.handleSession({
      type: "wait_for_agents_started",
      toolCallId: "wait-pending-int",
      agentIds: ["agent-1", "agent-2"],
    });

    harness.router.finalizePending("interrupted");

    const bashEvent = findLatestReplacedEvent(harness.replaced, "bash-pending-int");
    expect(bashEvent.type).toBe("bash_aborted");
    expect(bashEvent.reason).toBe("interrupted");

    const subagentEvent = findLatestReplacedEvent(harness.replaced, "wait-pending-int");
    expect(subagentEvent.type).toBe("wait_for_agents_finished");
    expect(subagentEvent.status).toBe("error");
    expect(subagentEvent.message).toBe("interrupted");
  });

  it("clears transient maps and resetSession clears all cached tool state", () => {
    const harness = createHarness();

    harness.handleSession({
      type: "bash_started",
      toolCallId: "bash-1",
      command: "echo one",
    });
    harness.handleSession({
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
