import { describe, expect, it } from "vitest";
import { ChatController } from "../dist/tui/chat_controller.js";
import { personas } from "../dist/core/personas.js";

function createStubView() {
  const added = [];
  const updated = [];
  const systemMessages = [];

  return {
    added,
    updated,
    systemMessages,
    view: {
      start: () => {},
      stop: () => {},
      requestRender: () => {},
      addMessage: (model) => {
        added.push(model);
        return `msg-${added.length}`;
      },
      updateAssistantMessage: (id, model) => {
        updated.push({ id, model });
      },
      addSystemMessage: (text, kind) => {
        systemMessages.push({ text, kind });
      },
      setThinkingVisibility: () => {},
      setCompactToolUi: () => {},
      updateStatus: () => {},
      startWorkingIcon: () => {},
      stopWorkingIcon: () => {},
      handleToolUiEvent: () => {},
      resetToolUiSession: () => {},
      finalizeToolUiPending: () => {},
      clearToolUiTransientState: () => {},
      getToolUiCostTotal: () => 0,
      sendTerminalNotification: () => {},
      getEditorText: () => "",
      setEditorText: () => {},
      getEditorCursor: () => ({ line: 0, col: 0 }),
      getEditorLines: () => [""],
      bindInputHandlers: () => {},
      setAutocompleteProvider: () => {},
      addBashExecutionMessage: () => {},
    },
  };
}

function createController(view) {
  return new ChatController({
    view,
    personas,
    prompts: [],
    skills: [],
    bashCommands: [],
    config: {},
  });
}

describe("ChatController event handling", () => {
  it("inserts assistant partial only when text starts or thinking is visible", () => {
    const stub = createStubView();
    const controller = createController(stub.view);

    stub.added.length = 0;
    controller.onEvent({ type: "assistant_start" });
    controller.onEvent({
      type: "assistant_partial",
      snapshot: { text: "", thinking: "hmm", hasTextStarted: false, hasAnyThinking: true },
    });

    const assistantAdds = stub.added.filter((m) => m.type === "assistant_partial");
    expect(assistantAdds).toEqual([]);

    const handlers = controller.getInputHandlers();
    handlers.onCtrlT?.();

    stub.added.length = 0;
    controller.onEvent({ type: "assistant_start" });
    controller.onEvent({
      type: "assistant_partial",
      snapshot: { text: "", thinking: "hmm", hasTextStarted: false, hasAnyThinking: true },
    });

    const assistantAddsAfter = stub.added.filter((m) => m.type === "assistant_partial");
    expect(assistantAddsAfter.length).toBe(1);
  });

  it("maps notice severity to system message kinds", () => {
    const stub = createStubView();
    const controller = createController(stub.view);

    controller.onEvent({ type: "notice", severity: "warn", text: "heads up" });

    expect(stub.systemMessages).toEqual([{ text: "heads up", kind: "warn" }]);
  });
});

describe("ChatController queued message draining", () => {
  it("drains queued user messages in order", async () => {
    const stub = createStubView();
    const controller = createController(stub.view);

    const calls = [];
    controller.onUserInput = async (text) => {
      calls.push(text);
    };

    controller.queuedUserMessages.push("first", "second");
    await controller.drainQueuedUserMessages();

    expect(calls).toEqual(["first", "second"]);
    expect(controller.queuedUserMessages.length).toBe(0);
  });
});
