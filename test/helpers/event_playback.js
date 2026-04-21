import { personas } from "../../dist/core/personas.js";
import { ChatController } from "../../dist/tui/chat_controller.js";

export function createPlaybackHarness(options = {}) {
  const calls = {
    added: [],
    updated: [],
    systemMessages: [],
    toolUiEvents: [],
    toolUiFinalize: [],
    thinkingVisibility: [],
    compactToolUi: [],
    status: [],
    working: [],
    renders: 0,
    toolUiReset: 0,
    toolUiCleared: 0,
  };

  const view = {
    start: () => {},
    stop: () => {},
    requestRender: () => {
      calls.renders += 1;
    },
    addMessage: (model, id) => {
      calls.added.push({ model, id });
      return id ?? `msg-${calls.added.length}`;
    },
    updateAssistantMessage: (id, model) => {
      calls.updated.push({ id, model });
    },
    addSystemMessage: (text, kind) => {
      calls.systemMessages.push({ text, kind });
    },
    setThinkingVisibility: (show) => {
      calls.thinkingVisibility.push(show);
    },
    setCompactToolUi: (compact) => {
      calls.compactToolUi.push(compact);
    },
    updateStatus: (status) => {
      calls.status.push(status);
    },
    startWorkingIcon: () => {
      calls.working.push("start");
    },
    stopWorkingIcon: () => {
      calls.working.push("stop");
    },
    handleToolUiEvent: (event) => {
      calls.toolUiEvents.push(event);
    },
    handleSubagentEvent: () => {},
    resetToolUiSession: () => {
      calls.toolUiReset += 1;
    },
    finalizeToolUiPending: (reason) => {
      calls.toolUiFinalize.push(reason);
    },
    clearToolUiTransientState: () => {
      calls.toolUiCleared += 1;
    },
    getToolUiCostTotal: () => 0,
    cycleSubagentSelection: () => undefined,
    getSelectedSubagentId: () => undefined,
    sendTerminalNotification: () => {},
    getEditorText: () => "",
    getExpandedEditorText: () => "",
    setEditorText: () => {},
    removeMessages: () => {},
    removeMessagesFrom: () => {},
    showRewindPicker: () => {},
    hideRewindPicker: () => {},
    getEditorCursor: () => ({ line: 0, col: 0 }),
    getEditorLines: () => [""],
    bindInputHandlers: () => {},
    setAutocompleteProvider: () => {},
    addBashExecutionMessage: () => {},
    updateTheme: () => {},
  };

  const controller = new ChatController({
    view,
    personas,
    prompts: [],
    skills: [],
    bashCommands: [],
    config: {},
    ...options,
  });

  const reset = () => {
    calls.added.length = 0;
    calls.updated.length = 0;
    calls.systemMessages.length = 0;
    calls.toolUiEvents.length = 0;
    calls.toolUiFinalize.length = 0;
    calls.thinkingVisibility.length = 0;
    calls.compactToolUi.length = 0;
    calls.status.length = 0;
    calls.working.length = 0;
    calls.renders = 0;
    calls.toolUiReset = 0;
    calls.toolUiCleared = 0;
  };

  reset();

  const playEvents = (events) => {
    for (const event of events) {
      controller.onEvent(event);
    }
  };

  const playTurn = async (events) => {
    const engine = controller.engine;
    const originalEvents = engine.events;
    engine.events = async function* (signal) {
      for (const event of events) {
        if (signal?.aborted) return;
        controller.onEvent(event);
        yield event;
      }
    };

    try {
      await controller.runAssistantTurn();
    } finally {
      engine.events = originalEvents;
    }
  };

  return { controller, view, calls, playEvents, playTurn, reset };
}
