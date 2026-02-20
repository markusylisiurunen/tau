import { describe, expect, it } from "vitest";
import { TOOL_NAME_BASH, TOOL_NAME_EDIT } from "../dist/core/tools/tool_names.js";
import { SessionMaintenanceService } from "../dist/tui/chat_controller/session_maintenance_service.js";

function createService(options = {}) {
  const history = options.history ?? [];
  const viewMessages = [];
  const toolUiEvents = [];
  const engine = {
    history,
    compact:
      options.compact ??
      (async () => ({ compactionMessage: "summary", includedLastAssistant: false })),
    replaceMessage: (index, message) => {
      history[index] = message;
    },
  };

  const service = new SessionMaintenanceService({
    engine,
    view: {
      addSystemMessage: (text, kind) => {
        viewMessages.push({ text, kind });
      },
      handleToolUiEvent: (event) => {
        toolUiEvents.push(event);
      },
    },
    runStreamingTask:
      options.runStreamingTask ??
      (async (task) => {
        const controller = new AbortController();
        try {
          return { aborted: false, value: await task(controller.signal) };
        } catch (error) {
          return { aborted: false, error };
        }
      }),
    applyCompactedHistoryUi: options.applyCompactedHistoryUi ?? (() => {}),
    requestSmartPruneSelection: options.requestSmartPruneSelection ?? (async () => []),
  });

  return { service, history, viewMessages, toolUiEvents };
}

describe("SessionMaintenanceService", () => {
  it("applies compacted history before streaming task completion", async () => {
    let applied = false;
    const checkpoints = [];
    const { service } = createService({
      applyCompactedHistoryUi: () => {
        applied = true;
      },
      runStreamingTask: async (task) => {
        const controller = new AbortController();
        await task(controller.signal);
        checkpoints.push(applied);
        return { aborted: false };
      },
    });

    await service.compactSummaryOnly();

    expect(checkpoints).toEqual([true]);
  });

  it("suppresses compact failure output on aborted compact", async () => {
    const { service, viewMessages } = createService({
      runStreamingTask: async () => ({ aborted: true, error: new Error("Request was aborted") }),
    });

    await service.compactSummaryOnly();

    expect(viewMessages).toContainEqual({ text: "summarizing session...", kind: "success" });
    expect(viewMessages.some((entry) => entry.text.startsWith("compact failed:"))).toBe(false);
  });

  it("keeps edit payloads untouched when smart prune sampling fails", async () => {
    const oldText = "line before";
    const newText = "line after";
    const history = [
      {
        role: "assistant",
        content: [
          {
            type: "toolCall",
            id: "edit-call-1",
            name: TOOL_NAME_EDIT,
            arguments: {
              path: "src/example.ts",
              oldText,
              newText,
            },
          },
        ],
        timestamp: 1,
      },
      {
        role: "toolResult",
        toolCallId: "edit-call-1",
        toolName: TOOL_NAME_EDIT,
        content: [{ type: "text", text: "successfully edited src/example.ts" }],
        isError: false,
        timestamp: 2,
      },
      {
        role: "toolResult",
        toolCallId: "bash-call-1",
        toolName: TOOL_NAME_BASH,
        content: [{ type: "text", text: "bash output" }],
        isError: false,
        timestamp: 3,
      },
    ];

    const { service, viewMessages, toolUiEvents } = createService({
      history,
      runStreamingTask: async () => ({ aborted: false, error: new Error("sampling failed") }),
    });

    await service.pruneToolResultsSmart();

    const toolCall = history[0].content[0];
    expect(toolCall.arguments.oldText).toBe(oldText);
    expect(toolCall.arguments.newText).toBe(newText);
    expect(viewMessages.at(-1)).toEqual({ text: "prune failed: sampling failed", kind: "error" });
    expect(toolUiEvents).toEqual([]);
  });

  it("handles malformed assistant entries while building smart prune prompts", async () => {
    const history = [
      {
        role: "assistant",
        content: null,
        timestamp: 1,
      },
      {
        role: "toolResult",
        toolCallId: "bash-call-1",
        toolName: TOOL_NAME_BASH,
        content: [{ type: "text", text: "bash output" }],
        isError: false,
        timestamp: 2,
      },
    ];

    const { service, viewMessages } = createService({
      history,
      requestSmartPruneSelection: async () => [],
    });

    await expect(service.pruneToolResultsSmart()).resolves.toBeUndefined();

    expect(viewMessages.at(-1)).toEqual({
      text: "model returned no prune candidates.",
      kind: "warn",
    });
  });
});
