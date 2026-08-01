import { describe, expect, it } from "vitest";
import { ToolUiRouter } from "../dist/tui/tool_ui_router.js";

function createHarness() {
  const added = [];
  const updated = [];
  const removed = [];
  const messageIds = new Set();
  let renders = 0;

  const chatContainer = {
    addMessage: (message, id) => {
      added.push({ message, id });
      messageIds.add(id);
      return id;
    },
    updateMessage: (id, message) => {
      if (!messageIds.has(id)) return false;
      updated.push({ id, message });
      return true;
    },
    removeMessages: (ids) => {
      removed.push(...ids);
      for (const id of ids) messageIds.delete(id);
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
    updated,
    removed,
    get renders() {
      return renders;
    },
  };
}

function toolModel(toolCallId, status, overrides = {}) {
  return {
    toolCallId,
    toolName: "write",
    status,
    headerTarget: "file.txt",
    ...overrides,
  };
}

describe("ToolUiRouter", () => {
  it("reconciles complete session tool models while preserving local cards", () => {
    const harness = createHarness();
    harness.router.updateLocal({
      toolCallId: "local-call",
      toolName: "bash",
      status: "running",
      headerTarget: "pwd",
      activity: {
        type: "bash_started",
        toolCallId: "local-call",
        command: "pwd",
        headerTarget: "pwd",
      },
    });
    harness.router.reconcileSession([
      toolModel("stale-call", "queued"),
      toolModel("current-call", "running"),
    ]);

    harness.router.reconcileSession([toolModel("current-call", "succeeded")]);

    expect(harness.removed).toEqual(["stale-call"]);
    expect(harness.added.map((entry) => entry.id)).toEqual([
      "local-call",
      "stale-call",
      "current-call",
    ]);
    expect(harness.updated.findLast((entry) => entry.id === "current-call")?.message.tool).toEqual(
      expect.objectContaining({ status: "succeeded" }),
    );

    harness.router.reconcileSession([]);
    expect(harness.removed).toEqual(["stale-call", "current-call"]);
  });

  it("updates every lifecycle state through the same keyed card", () => {
    const harness = createHarness();
    const statuses = ["streaming", "queued", "running", "succeeded"];

    for (const status of statuses) {
      harness.router.reconcileSession([toolModel("write-call", status)]);
    }

    expect(harness.added).toHaveLength(1);
    expect(harness.updated.map((entry) => entry.message.tool.status)).toEqual([
      "queued",
      "running",
      "succeeded",
    ]);
  });

  it("resets session tracking without removing existing cards", () => {
    const harness = createHarness();
    harness.router.updateLocal({
      toolCallId: "local-call",
      toolName: "client_tool",
      status: "queued",
      headerTarget: "client_tool",
    });
    harness.router.reconcileSession([toolModel("session-call", "running")]);

    harness.router.resetSession();
    harness.router.reconcileSession([]);

    expect(harness.removed).toEqual([]);
  });
});
