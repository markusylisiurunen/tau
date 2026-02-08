import { describe, expect, it, vi } from "vitest";
import { personas } from "../dist/core/personas.js";
import { TOOL_NAME_BASH, TOOL_NAME_EDIT } from "../dist/core/tools/tool_names.js";
import { ChatController } from "../dist/tui/chat_controller.js";
import { copyTextToClipboard } from "../dist/tui/clipboard.js";
import { DOUBLE_PRESS_WINDOW_MS } from "../dist/tui/constants.js";

vi.mock("../dist/tui/clipboard.js", () => ({
  copyTextToClipboard: vi.fn(async () => {}),
}));

function createStubView() {
  const added = [];
  const updated = [];
  const systemMessages = [];
  const editorTextUpdates = [];
  const rewindPickerShows = [];
  const removeMessagesCalls = [];
  const removeMessagesFromCalls = [];
  let rewindPickerHideCount = 0;

  return {
    added,
    updated,
    systemMessages,
    editorTextUpdates,
    rewindPickerShows,
    removeMessagesCalls,
    removeMessagesFromCalls,
    get rewindPickerHideCount() {
      return rewindPickerHideCount;
    },
    view: {
      start: () => {},
      stop: () => {},
      requestRender: () => {},
      removeMessages: (ids) => {
        removeMessagesCalls.push(ids);
      },
      removeMessagesFrom: (id) => {
        removeMessagesFromCalls.push(id);
      },
      addMessage: (model, id) => {
        added.push(model);
        return id ?? `msg-${added.length}`;
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
      handleSubagentEvent: () => {},
      resetToolUiSession: () => {},
      finalizeToolUiPending: () => {},
      clearToolUiTransientState: () => {},
      getToolUiCostTotal: () => 0,
      cycleSubagentSelection: () => undefined,
      getSelectedSubagentId: () => undefined,
      sendTerminalNotification: () => {},
      getEditorText: () => "",
      getExpandedEditorText: () => "",
      setEditorText: (text) => {
        editorTextUpdates.push(text);
      },
      showRewindPicker: (options) => {
        rewindPickerShows.push(options);
      },
      hideRewindPicker: () => {
        rewindPickerHideCount += 1;
      },
      getEditorCursor: () => ({ line: 0, col: 0 }),
      getEditorLines: () => [""],
      bindInputHandlers: () => {},
      setAutocompleteProvider: () => {},
      addBashExecutionMessage: () => {},
      updateTheme: () => {},
    },
  };
}

function createController(view, options = {}) {
  return new ChatController({
    view,
    personas,
    prompts: options.prompts ?? [],
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
    controller.onEvent({ type: "assistant_start", historyEntryId: "assistant-1" });
    controller.onEvent({
      type: "assistant_partial",
      historyEntryId: "assistant-1",
      snapshot: { text: "", thinking: "hmm", hasTextStarted: false, hasAnyThinking: true },
    });

    const assistantAdds = stub.added.filter((m) => m.type === "assistant_partial");
    expect(assistantAdds).toEqual([]);

    const handlers = controller.getInputHandlers();
    handlers.onCtrlT?.();

    stub.added.length = 0;
    controller.onEvent({ type: "assistant_start", historyEntryId: "assistant-2" });
    controller.onEvent({
      type: "assistant_partial",
      historyEntryId: "assistant-2",
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

describe("ChatController streaming command handling", () => {
  it("allows prompt command while streaming", async () => {
    const stub = createStubView();
    const controller = createController(stub.view, {
      prompts: [{ id: "intro", template: "hello there" }],
    });

    controller.isStreaming = true;
    await controller.onUserInput("/prompt:intro");

    expect(stub.editorTextUpdates).toEqual(["hello there"]);
  });

  it("permits streaming prompt submission via beforeSubmit", async () => {
    const stub = createStubView();
    const controller = createController(stub.view, {
      prompts: [{ id: "intro", template: "hello there" }],
    });

    controller.isStreaming = true;
    const handlers = controller.getInputHandlers();

    expect(handlers.beforeSubmit?.("/prompt:intro")).toBe(true);
    expect(handlers.beforeSubmit?.("/reload")).toBe(false);

    handlers.onSubmit?.("/prompt:intro");
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(stub.editorTextUpdates).toEqual(["hello there"]);
  });
});

describe("ChatController rewind flow", () => {
  it("shows a warning when there are no user messages to rewind", async () => {
    const stub = createStubView();
    const controller = createController(stub.view);

    await controller.onUserInput("/rewind");

    expect(stub.rewindPickerShows).toHaveLength(0);
    expect(stub.systemMessages).toContainEqual({
      text: "no user messages available to rewind.",
      kind: "warn",
    });
  });

  it("opens the picker with user messages in chat order", async () => {
    const stub = createStubView();
    const controller = createController(stub.view);

    controller.engine.addUserText("first message");
    controller.engine.addUserText("second message");
    controller.engine.addUserText("third message");

    await controller.onUserInput("/rewind");

    expect(stub.rewindPickerShows).toHaveLength(1);
    expect(stub.rewindPickerShows[0].items.map((item) => item.label)).toEqual([
      "first message",
      "second message",
      "third message",
    ]);
  });

  it("strips leading system notices from rewind labels and prefill text", async () => {
    const stub = createStubView();
    const controller = createController(stub.view);

    controller.engine.addUserText(
      "<system>notice one</system>\n\n<system>notice two</system>\n\nuser text",
    );

    await controller.onUserInput("/rewind");

    expect(stub.rewindPickerShows).toHaveLength(1);
    expect(stub.rewindPickerShows[0].items.map((item) => item.label)).toEqual(["user text"]);

    const picker = stub.rewindPickerShows[0];
    picker.onSelect(picker.items[0].id);
    expect(stub.editorTextUpdates.at(-1)).toBe("user text");
  });

  it("shows only the first line of each rewind label", async () => {
    const stub = createStubView();
    const controller = createController(stub.view);

    const longLine = "x".repeat(130);
    controller.engine.addUserText("first line\nsecond line");
    controller.engine.addUserText(`${longLine}\nextra`);

    await controller.onUserInput("/rewind");

    expect(stub.rewindPickerShows).toHaveLength(1);
    expect(stub.rewindPickerShows[0].items.map((item) => item.label)).toEqual([
      "first line",
      longLine,
    ]);
  });

  it("rewinds history from the selected user message and prefills the editor", async () => {
    const stub = createStubView();
    const controller = createController(stub.view);

    controller.engine.addUserText("first message");
    controller.engine.addUserText("second message");
    controller.engine.addUserText("third message");

    await controller.onUserInput("/rewind");
    const picker = stub.rewindPickerShows[0];
    const selectedId = picker.items[1].id;
    picker.onSelect(selectedId);

    expect(controller.engine.history).toHaveLength(1);
    expect(controller.engine.history[0].role).toBe("user");
    expect(controller.engine.history[0].content[0].text).toBe("first message");
    expect(stub.removeMessagesFromCalls).toEqual([picker.items[1].id]);
    expect(stub.removeMessagesCalls).toEqual([[picker.items[1].id, picker.items[2].id]]);
    expect(stub.editorTextUpdates.at(-1)).toBe("second message");
    expect(stub.rewindPickerHideCount).toBe(1);
  });

  it("removes from the selected message so non-history rows are dropped", async () => {
    const stub = createStubView();
    const controller = createController(stub.view);

    controller.runAssistantTurn = async () => {};

    await controller.onUserInput("first message");
    await controller.onUserInput("second message");
    await controller.onUserInput("third message");

    controller.onEvent({ type: "notice", severity: "warn", text: "ephemeral warning" });
    controller.onEvent({ type: "assistant_start", historyEntryId: "assistant-stale" });
    controller.onEvent({
      type: "assistant_partial",
      historyEntryId: "assistant-stale",
      snapshot: { text: "partial", thinking: "", hasTextStarted: true, hasAnyThinking: false },
    });

    await controller.onUserInput("/rewind");
    const picker = stub.rewindPickerShows[0];
    picker.onSelect(picker.items[1].id);

    expect(stub.removeMessagesFromCalls).toEqual([picker.items[1].id]);
    expect(stub.removeMessagesCalls).toEqual([[picker.items[1].id, picker.items[2].id]]);
    expect(stub.editorTextUpdates.at(-1)).toBe("second message");
  });

  it("cancels rewind on escape without mutating history", async () => {
    const stub = createStubView();
    const controller = createController(stub.view);

    controller.engine.addUserText("first message");
    controller.engine.addUserText("second message");

    await controller.onUserInput("/rewind");
    const historyBefore = [...controller.engine.history];
    const picker = stub.rewindPickerShows[0];
    picker.onCancel();

    expect(controller.engine.history).toEqual(historyBefore);
    expect(stub.editorTextUpdates).toEqual([]);
    expect(stub.rewindPickerHideCount).toBe(1);
  });
});

describe("ChatController clipboard stashing", () => {
  it("copies expanded editor text instead of paste markers", async () => {
    const stub = createStubView();
    stub.view.getEditorText = () => "[paste #1 +12 lines]";
    stub.view.getExpandedEditorText = () => "line 1\nline 2";

    const controller = createController(stub.view);
    await controller.getInputHandlers().onCtrlS?.();

    expect(copyTextToClipboard).toHaveBeenCalledWith("line 1\nline 2");
    expect(stub.editorTextUpdates).toEqual([""]);
    expect(stub.systemMessages).toContainEqual({
      text: "stashed input to clipboard",
      kind: "success",
    });
  });
});

describe("ChatController risk level changes", () => {
  it("does not update the main system prompt and injects a system notice", async () => {
    const stub = createStubView();
    const controller = createController(stub.view);

    const initialPrompt = controller.baseSystemPrompt;
    const initialEnvironment = controller.environmentTag;
    const initialSubagentPrompt = controller.subagentPrompts.default;
    expect(initialSubagentPrompt).toBeTruthy();

    const userMessages = [];
    controller.engine.addUserText = (text) => {
      userMessages.push(text);
    };
    controller.runAssistantTurn = async () => {};

    controller.setRiskLevel("read-write", { silent: true });

    expect(controller.baseSystemPrompt).toBe(initialPrompt);
    expect(controller.environmentTag).toBe(initialEnvironment);
    expect(controller.subagentPrompts.default).not.toBe(initialSubagentPrompt);
    expect(controller.subagentPrompts.default).toContain('level="read-write"');

    await controller.onUserInput("hello");

    expect(userMessages[0]).toContain("<system>Risk level changed by user");
  });
});

describe("ChatController prune handling", () => {
  function seedEditHistory(controller, oldText, newText) {
    controller.engine.addMessage({
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
    });

    controller.engine.addMessage({
      role: "toolResult",
      toolCallId: "edit-call-1",
      toolName: TOOL_NAME_EDIT,
      content: [{ type: "text", text: "successfully edited src/example.ts" }],
      isError: false,
      timestamp: 2,
    });
  }

  function seedBashResult(controller, text) {
    controller.engine.addMessage({
      role: "toolResult",
      toolCallId: "bash-call-1",
      toolName: TOOL_NAME_BASH,
      content: [{ type: "text", text }],
      isError: false,
      timestamp: 3,
    });
  }

  it("prunes edit call arguments and rewrites edit result diff with 4-line unchanged context", async () => {
    const stub = createStubView();
    const controller = createController(stub.view);

    const prefix = Array.from({ length: 10 }, (_, i) => `pre ${i}`);
    const suffix = Array.from({ length: 10 }, (_, i) => `post ${i}`);
    const oldText = [...prefix, "before", ...suffix].join("\n");
    const newText = [...prefix, "after", ...suffix].join("\n");

    seedEditHistory(controller, oldText, newText);

    await controller.onUserInput("/prune:earliest-first");

    const history = controller.engine.history;
    const assistant = history.find((message) => message.role === "assistant");
    const toolCall = assistant.content.find((block) => block.type === "toolCall");
    expect(toolCall.arguments.oldText).toBe("[content pruned]");
    expect(toolCall.arguments.newText).toBe("[content pruned]");

    const toolResult = history.find((message) => message.role === "toolResult");
    const text = toolResult.content[0].text;
    expect(text).toContain(`[tool result pruned] ${TOOL_NAME_EDIT} diff`);
    expect(text).toContain("… 6 unchanged line(s) omitted …");
    expect(text).toContain("  pre 6");
    expect(text).not.toContain("  pre 0");
    expect(text).toContain("- before");
    expect(text).toContain("+ after");
    expect(text).toContain("  post 3");
    expect(text).not.toContain("  post 9");

    expect(stub.systemMessages).toContainEqual(
      expect.objectContaining({
        kind: "success",
        text: expect.stringContaining(`${TOOL_NAME_EDIT} tool call`),
      }),
    );
    expect(stub.systemMessages).not.toContainEqual(
      expect.objectContaining({ text: "no bash tool results to prune." }),
    );
  });

  it("keeps prune fraction 0 as a no-op for edit payloads", async () => {
    const stub = createStubView();
    const controller = createController(stub.view);

    const oldText = "line before";
    const newText = "line after";
    seedEditHistory(controller, oldText, newText);

    await controller.onUserInput("/prune:earliest-first 0");

    const history = controller.engine.history;
    const assistant = history.find((message) => message.role === "assistant");
    const toolCall = assistant.content.find((block) => block.type === "toolCall");
    expect(toolCall.arguments.oldText).toBe(oldText);
    expect(toolCall.arguments.newText).toBe(newText);

    const toolResult = history.find((message) => message.role === "toolResult");
    expect(toolResult.content[0].text).toBe("successfully edited src/example.ts");
    expect(stub.systemMessages.at(-1)).toEqual({
      text: "prune fraction is 0, nothing to prune.",
      kind: "warn",
    });
  });

  it("keeps failed edit tool results intact", async () => {
    const stub = createStubView();
    const controller = createController(stub.view);

    const oldText = "before";
    const newText = "after";
    seedEditHistory(controller, oldText, newText);

    controller.engine.replaceMessage(1, {
      role: "toolResult",
      toolCallId: "edit-call-1",
      toolName: TOOL_NAME_EDIT,
      content: [{ type: "text", text: "oldText not found in file." }],
      isError: true,
      timestamp: 2,
    });

    await controller.onUserInput("/prune:earliest-first");

    const history = controller.engine.history;
    const toolResult = history.find((message) => message.role === "toolResult");
    expect(toolResult.content[0].text).toBe("oldText not found in file.");
    expect(toolResult.isError).toBe(true);
  });

  it("does not prune edit payloads when least-important sampling fails", async () => {
    const stub = createStubView();
    const controller = createController(stub.view);

    const oldText = "line before";
    const newText = "line after";
    seedEditHistory(controller, oldText, newText);
    seedBashResult(controller, "bash output");

    controller.requestLeastImportantPruneSelection = async () => {
      throw new Error("sampling failed");
    };

    await controller.onUserInput("/prune:least-important");

    const history = controller.engine.history;
    const assistant = history.find((message) => message.role === "assistant");
    const toolCall = assistant.content.find((block) => block.type === "toolCall");
    expect(toolCall.arguments.oldText).toBe(oldText);
    expect(toolCall.arguments.newText).toBe(newText);

    const editResult = history.find(
      (message) => message.role === "toolResult" && message.toolName === TOOL_NAME_EDIT,
    );
    expect(editResult.content[0].text).toBe("successfully edited src/example.ts");

    expect(stub.systemMessages.at(-1)).toEqual({
      text: "prune failed: sampling failed",
      kind: "error",
    });
  });
});

describe("ChatController manual retry", () => {
  it("retries on double empty submit within window", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);

    try {
      const stub = createStubView();
      const controller = createController(stub.view);
      const calls = [];

      controller.runAssistantTurn = async () => {
        calls.push("retry");
      };

      await controller.onUserInput("");
      expect(calls).toEqual([]);

      vi.advanceTimersByTime(DOUBLE_PRESS_WINDOW_MS - 1);
      await controller.onUserInput("");

      expect(calls).toEqual(["retry"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores empty submit while streaming", async () => {
    const stub = createStubView();
    const controller = createController(stub.view);
    const calls = [];

    controller.runAssistantTurn = async () => {
      calls.push("retry");
    };

    controller.isStreaming = true;
    await controller.onUserInput("");

    expect(calls).toEqual([]);
  });
});
