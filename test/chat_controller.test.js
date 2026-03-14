import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { resolveRuntimePromptBootstrap } from "../dist/core/index.js";
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
  const toolUiEvents = [];
  const editorTextUpdates = [];
  const rewindPickerShows = [];
  const removeMessagesCalls = [];
  const removeMessagesFromCalls = [];
  const finalizeToolUiPendingCalls = [];
  const thinkingVisibilityCalls = [];
  let clearToolUiTransientStateCallCount = 0;
  let rewindPickerHideCount = 0;
  let editorText = "";

  return {
    added,
    updated,
    systemMessages,
    toolUiEvents,
    editorTextUpdates,
    rewindPickerShows,
    removeMessagesCalls,
    removeMessagesFromCalls,
    finalizeToolUiPendingCalls,
    thinkingVisibilityCalls,
    get clearToolUiTransientStateCallCount() {
      return clearToolUiTransientStateCallCount;
    },
    setEditorText: (text) => {
      editorText = text;
    },
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
      setThinkingVisibility: (visible) => {
        thinkingVisibilityCalls.push(visible);
      },
      setCompactToolUi: () => {},
      updateStatus: () => {},
      startWorkingIcon: () => {},
      stopWorkingIcon: () => {},
      handleToolUiEvent: (event) => {
        toolUiEvents.push(event);
      },
      handleSubagentEvent: () => {},
      resetToolUiSession: () => {},
      finalizeToolUiPending: (reason) => {
        finalizeToolUiPendingCalls.push(reason);
      },
      clearToolUiTransientState: () => {
        clearToolUiTransientStateCallCount += 1;
      },
      getToolUiCostTotal: () => 0,
      cycleSubagentSelection: () => undefined,
      getSelectedSubagentId: () => undefined,
      sendTerminalNotification: () => {},
      getEditorText: () => editorText,
      getExpandedEditorText: () => editorText,
      setEditorText: (text) => {
        editorText = text;
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
    personas: options.personas ?? personas,
    prompts: options.prompts ?? [],
    skills: options.skills ?? [],
    bashCommands: options.bashCommands ?? [],
    queuedUserMessages: options.queuedUserMessages ?? [],
    initialPersonaId: options.initialPersonaId,
    config: options.config ?? {},
    sandboxEnabled: options.sandboxEnabled ?? false,
    caffeinated: options.caffeinated ?? false,
    toolBackend: options.toolBackend,
    noAgentContextFiles: options.noAgentContextFiles ?? true,
    deps: options.deps,
  });
}

function createMockDeps(spawn, platform = "darwin") {
  return {
    clock: {
      now: () => Date.now(),
    },
    fs: {
      readFile: () => "",
      writeFile: () => {},
      listDir: () => [],
    },
    spawn,
    env: {
      cwd: () => process.cwd(),
      home: () => process.env.HOME ?? process.cwd(),
      platform: () => platform,
      nodeVersion: () => process.version,
      env: () => process.env,
    },
  };
}

function createProjectContextDeps(home) {
  return {
    clock: {
      now: () => Date.now(),
    },
    fs: {
      readFile: (path) => readFileSync(path, "utf8"),
      writeFile: () => {},
      listDir: () => [],
    },
    spawn: vi.fn(),
    env: {
      cwd: () => process.cwd(),
      home: () => home,
      platform: () => process.platform,
      nodeVersion: () => process.version,
      env: () => process.env,
    },
  };
}

function createSpawnAbortResult() {
  return {
    stdout: "",
    stderr: "",
    output: undefined,
    exitCode: null,
    captureLimitExceeded: false,
    timedOut: false,
    aborted: true,
    closeSignal: "SIGTERM",
  };
}

describe("ChatController persona switching", () => {
  it("resets to the persona default reasoning on /persona switch", async () => {
    const stub = createStubView();
    const controller = createController(stub.view, {
      initialPersonaId: "gpt-5.4-chat",
    });

    expect(controller.currentPersona.settings.reasoning).toBe("medium");

    const handlers = controller.getInputHandlers();
    handlers.onShiftTab?.();
    expect(controller.currentPersona.settings.reasoning).toBe("high");

    await controller.onUserInput("/persona:opus-4.6-chat");
    await controller.onUserInput("/persona:gpt-5.4-chat");

    expect(controller.currentPersona.id).toBe("gpt-5.4-chat");
    expect(controller.currentPersona.settings.reasoning).toBe("medium");
  });
});

describe("ChatController event handling", () => {
  it("suppresses empty aborted assistant final messages", () => {
    const stub = createStubView();
    const controller = createController(stub.view);

    controller.onEvent({ type: "assistant_start", historyEntryId: "assistant-aborted" });
    controller.onEvent({
      type: "assistant_final",
      historyEntryId: "assistant-aborted",
      message: {
        role: "assistant",
        content: [],
        stopReason: "aborted",
      },
    });

    const assistantAdds = stub.added.filter((m) => m.type === "assistant_partial");
    expect(assistantAdds).toEqual([]);
    expect(stub.updated).toEqual([]);
  });

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

  it("shows the current assistant thinking immediately when thoughts are toggled on", () => {
    const stub = createStubView();
    const controller = createController(stub.view);

    controller.onEvent({ type: "assistant_start", historyEntryId: "assistant-thinking" });
    controller.onEvent({
      type: "assistant_partial",
      historyEntryId: "assistant-thinking",
      snapshot: { text: "", thinking: "hmm", hasTextStarted: false, hasAnyThinking: true },
    });

    expect(stub.added.filter((m) => m.type === "assistant_partial")).toEqual([]);

    const handlers = controller.getInputHandlers();
    handlers.onCtrlT?.();

    const assistantAdds = stub.added.filter((m) => m.type === "assistant_partial");
    expect(stub.thinkingVisibilityCalls.at(-1)).toBe(true);
    expect(assistantAdds).toHaveLength(1);
    expect(assistantAdds[0]).toEqual({
      type: "assistant_partial",
      text: "",
      thinking: "hmm",
    });
  });

  it("maps notice severity to system message kinds", () => {
    const stub = createStubView();
    const controller = createController(stub.view);

    controller.onEvent({ type: "notice", severity: "warn", text: "heads up" });

    expect(stub.systemMessages).toEqual([{ text: "heads up", kind: "warn" }]);
  });
});

describe("ChatController interrupt handling", () => {
  it("stops speak recording instead of interrupting assistant", async () => {
    const stub = createStubView();
    const controller = createController(stub.view);

    controller.speakRecording = {};

    const stopSpeakCaptureSpy = vi
      .spyOn(controller, "stopSpeakCapture")
      .mockImplementation(async () => {});
    const interruptActiveTaskSpy = vi.spyOn(controller, "interruptActiveTask");

    controller.onInterrupt();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(stopSpeakCaptureSpy).toHaveBeenCalledTimes(1);
    expect(interruptActiveTaskSpy).not.toHaveBeenCalled();
  });

  it("interrupts the active assistant turn task once", async () => {
    const stub = createStubView();
    const controller = createController(stub.view);

    let resolveTurn;
    const turnGate = new Promise((resolve) => {
      resolveTurn = resolve;
    });
    const runSpy = vi.spyOn(controller.runtime, "runTurn").mockImplementation(async () => {
      await turnGate;
      return { aborted: true };
    });
    const interruptSpy = vi
      .spyOn(controller.runtime, "interruptTurn")
      .mockImplementation(() => true);

    const turnPromise = controller.runAssistantTurn();
    await new Promise((resolve) => setTimeout(resolve, 0));

    controller.onInterrupt();
    controller.onInterrupt();

    resolveTurn();
    await turnPromise;

    expect(runSpy).toHaveBeenCalledTimes(1);
    expect(interruptSpy).toHaveBeenCalledTimes(1);
    expect(stub.systemMessages).toContainEqual({ text: "interrupted", kind: "error" });
    expect(stub.systemMessages.filter((m) => m.text === "interrupted")).toHaveLength(1);
    expect(stub.finalizeToolUiPendingCalls).toEqual(["interrupted"]);
  });

  it("does not show interrupted when there is no cancellable active task", () => {
    const stub = createStubView();
    const controller = createController(stub.view);

    controller.isStreaming = true;

    controller.onInterrupt();

    expect(stub.systemMessages).toEqual([]);
  });

  it("keeps interrupted turn cleanup parity with runtime-driven aborts", async () => {
    const stub = createStubView();
    const queuedUserMessages = ["queued one", "queued two"];
    const controller = createController(stub.view, { queuedUserMessages });

    const runSpy = vi.spyOn(controller.runtime, "runTurn").mockResolvedValue({ aborted: true });

    await controller.runAssistantTurn();

    expect(runSpy).toHaveBeenCalledTimes(1);
    expect(stub.finalizeToolUiPendingCalls).toEqual(["aborted"]);
    expect(stub.clearToolUiTransientStateCallCount).toBe(1);
    expect(queuedUserMessages).toEqual([]);
    expect(stub.editorTextUpdates.at(-1)).toBe("queued one\n\n---\n\nqueued two");
  });
});

describe("ChatController caffeinate", () => {
  it("starts and stops caffeinate around assistant turns when enabled", async () => {
    const stub = createStubView();
    const spawn = vi.fn((_cmd, _args, options = {}) => {
      return new Promise((resolve) => {
        options.signal?.addEventListener(
          "abort",
          () => {
            resolve(createSpawnAbortResult());
          },
          { once: true },
        );
      });
    });
    const controller = createController(stub.view, {
      caffeinated: true,
      noAgentContextFiles: true,
      deps: createMockDeps(spawn),
    });
    vi.spyOn(controller.runtime, "runTurn").mockResolvedValue({ aborted: false });

    await controller.runAssistantTurn();

    expect(spawn).toHaveBeenCalledTimes(1);
    expect(spawn).toHaveBeenCalledWith(
      "/usr/bin/caffeinate",
      ["-i"],
      expect.objectContaining({
        detached: true,
        killProcessGroup: true,
        stdio: ["ignore", "ignore", "ignore"],
      }),
    );
  });

  it("does not start caffeinate when disabled", async () => {
    const stub = createStubView();
    const spawn = vi.fn();
    const controller = createController(stub.view, {
      noAgentContextFiles: true,
      deps: createMockDeps(spawn),
    });
    vi.spyOn(controller.runtime, "runTurn").mockResolvedValue({ aborted: false });

    await controller.runAssistantTurn();

    expect(spawn).not.toHaveBeenCalled();
  });

  it("no-ops caffeinate on Linux", async () => {
    const stub = createStubView();
    const spawn = vi.fn();
    const controller = createController(stub.view, {
      caffeinated: true,
      noAgentContextFiles: true,
      deps: createMockDeps(spawn, "linux"),
    });
    vi.spyOn(controller.runtime, "runTurn").mockResolvedValue({ aborted: false });

    await controller.runAssistantTurn();

    expect(spawn).not.toHaveBeenCalled();
    expect(stub.systemMessages).toEqual([]);
  });

  it("stops active caffeinate during dispose", async () => {
    const stub = createStubView();
    let signal;
    const spawn = vi.fn((_cmd, _args, options = {}) => {
      signal = options.signal;
      return new Promise((resolve) => {
        options.signal?.addEventListener(
          "abort",
          () => {
            resolve(createSpawnAbortResult());
          },
          { once: true },
        );
      });
    });
    const controller = createController(stub.view, {
      caffeinated: true,
      noAgentContextFiles: true,
      deps: createMockDeps(spawn),
    });

    controller.startTurnCaffeinate();
    await controller.dispose();

    expect(spawn).toHaveBeenCalledTimes(1);
    expect(signal.aborted).toBe(true);
    expect(controller.turnCaffeinate).toBeUndefined();
  });
});

describe("ChatController queued message draining", () => {
  it("drains queued user messages in order", async () => {
    const stub = createStubView();
    const queuedUserMessages = ["first", "second"];
    const controller = createController(stub.view, { queuedUserMessages });

    const calls = [];
    controller.onUserInput = async (text) => {
      calls.push(text);
    };

    await controller.drainQueuedUserMessages();

    expect(calls).toEqual(["first", "second"]);
    expect(queuedUserMessages.length).toBe(0);
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

describe("ChatController speak capture", () => {
  it("ignores concurrent toggle requests while speak transition is running", async () => {
    const stub = createStubView();
    const controller = createController(stub.view);

    let resolveStart;
    const startPromise = new Promise((resolve) => {
      resolveStart = resolve;
    });

    const startSpy = vi.spyOn(controller, "startSpeakCapture").mockImplementation(async () => {
      await startPromise;
    });

    const first = controller.toggleSpeakCapture();
    const second = controller.toggleSpeakCapture();

    expect(startSpy).toHaveBeenCalledTimes(1);

    resolveStart();
    await Promise.all([first, second]);

    expect(stub.systemMessages).toContainEqual({
      text: "speech recording state change already in progress",
      kind: "warn",
    });
  });

  it("shows a warning and skips recording on Linux", async () => {
    const stub = createStubView();
    const spawn = vi.fn();
    const controller = createController(stub.view, {
      deps: createMockDeps(spawn, "linux"),
    });

    await controller.toggleSpeakCapture();

    expect(spawn).not.toHaveBeenCalled();
    expect(stub.systemMessages).toContainEqual({
      text: "/speak is currently supported only on macOS.",
      kind: "warn",
    });
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

    const initialPrompt = controller.runtime.promptComposition.baseSystemPrompt;
    const initialEnvironment = controller.runtime.promptComposition.environmentTag;
    const initialSubagentPrompt = controller.runtime.promptComposition.subagentPrompts.default;
    expect(initialSubagentPrompt).toBeTruthy();

    const userMessages = [];
    controller.engine.addUserText = (text) => {
      userMessages.push(text);
    };
    controller.runAssistantTurn = async () => {};

    controller.setRiskLevel("read-write", { silent: true });

    expect(controller.runtime.promptComposition.baseSystemPrompt).toBe(initialPrompt);
    expect(controller.runtime.promptComposition.environmentTag).toBe(initialEnvironment);
    expect(controller.runtime.promptComposition.subagentPrompts.default).not.toBe(
      initialSubagentPrompt,
    );
    expect(controller.runtime.promptComposition.subagentPrompts.default).toContain(
      'level="read-write"',
    );

    await controller.onUserInput("hello");

    expect(userMessages[0]).toContain("<system>Risk level changed by user");
  });
});

describe("ChatController startup bootstrap", () => {
  it("matches RPC prompt bootstrap context for identical inputs", async () => {
    const home = await mkdtemp(join(tmpdir(), "tau-bootstrap-home-"));
    const repo = join(home, "repo");
    await mkdir(repo, { recursive: true });
    await writeFile(join(repo, "AGENTS.md"), "# repo\n\nshared project context\n");

    const persona = {
      id: "bootstrap-persona",
      label: "bootstrap persona",
      model: personas[0].model,
      systemPrompt: "persona prompt",
      settings: {},
      source: "project",
      skills: ["alpha", "missing"],
    };
    const discoveredSkills = [
      {
        name: "alpha",
        description: "alpha skill",
        path: join(repo, "skills", "alpha", "SKILL.md"),
      },
    ];

    const deps = {
      clock: {
        now: () => Date.now(),
      },
      fs: {
        readFile: (path) => readFileSync(path, "utf8"),
        writeFile: () => {},
        listDir: () => [],
      },
      spawn: vi.fn(),
      env: {
        cwd: () => repo,
        home: () => home,
        platform: () => process.platform,
        nodeVersion: () => process.version,
        env: () => process.env,
      },
    };

    const expected = resolveRuntimePromptBootstrap({
      persona,
      discoveredSkills,
      cwd: repo,
      home,
      includeAgentContext: true,
      sandboxEnabled: false,
      readFile: (path) => readFileSync(path, "utf8"),
    });

    const stub = createStubView();
    const controller = createController(stub.view, {
      personas: [persona],
      initialPersonaId: persona.id,
      skills: discoveredSkills,
      noAgentContextFiles: false,
      deps,
    });

    try {
      expect(controller.runtime.promptContext).toEqual(expected.promptContext);
      expect(controller.runtime.promptContext.skillsBlock).toContain("<name>alpha</name>");
      expect(controller.runtime.promptContext.skillsBlock).not.toContain("missing");
    } finally {
      await controller.dispose();
      await rm(home, { recursive: true, force: true });
    }
  });
});

describe("ChatController /cd project context notices", () => {
  it("injects updated project context into the next user message after /cd", async () => {
    const originalCwd = process.cwd();
    const home = await mkdtemp(join(tmpdir(), "tau-cd-context-"));
    const dirA = join(home, "dir-a");
    const dirB = join(home, "dir-b");
    await mkdir(dirA, { recursive: true });
    await mkdir(dirB, { recursive: true });
    await writeFile(join(dirA, "AGENTS.md"), "# A\n\ncontext from dir-a\n");
    await writeFile(join(dirB, "AGENTS.md"), "# B\n\ncontext from dir-b\n");

    let controller;
    try {
      process.chdir(dirA);

      const stub = createStubView();
      controller = createController(stub.view, {
        noAgentContextFiles: false,
        deps: createProjectContextDeps(home),
      });
      const userMessages = [];
      controller.engine.addUserText = (text) => {
        userMessages.push(text);
        return "user-1";
      };
      controller.runAssistantTurn = async () => {};

      await controller.onUserInput(`/cd ${dirB}`);
      await controller.onUserInput("hello");

      expect(userMessages[0]).toContain("Project context changed by user after '/cd'.");
      expect(userMessages[0]).toContain("<project-context-update>");
      expect(userMessages[0]).toContain("dir-b/AGENTS.md");
      expect(userMessages[0]).toContain("context from dir-b");
      expect(userMessages[0]).not.toContain("context from dir-a");
    } finally {
      await controller?.dispose();
      process.chdir(originalCwd);
      await rm(home, { recursive: true, force: true });
    }
  });

  it("does not inject project-context notice when AGENTS context is unchanged", async () => {
    const originalCwd = process.cwd();
    const home = await mkdtemp(join(tmpdir(), "tau-cd-context-"));
    const dirA = join(home, "dir-a");
    const dirB = join(home, "dir-b");
    await mkdir(dirA, { recursive: true });
    await mkdir(dirB, { recursive: true });
    await writeFile(join(home, "AGENTS.md"), "# shared\n\nshared context\n");

    let controller;
    try {
      process.chdir(dirA);

      const stub = createStubView();
      controller = createController(stub.view, {
        noAgentContextFiles: false,
        deps: createProjectContextDeps(home),
      });
      const userMessages = [];
      controller.engine.addUserText = (text) => {
        userMessages.push(text);
        return "user-1";
      };
      controller.runAssistantTurn = async () => {};

      await controller.onUserInput(`/cd ${dirB}`);
      await controller.onUserInput("hello");

      expect(userMessages[0]).toContain("Working directory changed by user");
      expect(userMessages[0]).not.toContain("Project context changed by user after '/cd'.");
      expect(userMessages[0]).not.toContain("<project-context-update>");
    } finally {
      await controller?.dispose();
      process.chdir(originalCwd);
      await rm(home, { recursive: true, force: true });
    }
  });

  it("collapses multiple /cd updates to the latest pending project context", async () => {
    const originalCwd = process.cwd();
    const home = await mkdtemp(join(tmpdir(), "tau-cd-context-"));
    const dirA = join(home, "dir-a");
    const dirB = join(home, "dir-b");
    const dirC = join(home, "dir-c");
    await mkdir(dirA, { recursive: true });
    await mkdir(dirB, { recursive: true });
    await mkdir(dirC, { recursive: true });
    await writeFile(join(dirA, "AGENTS.md"), "# A\n\ncontext from dir-a\n");
    await writeFile(join(dirB, "AGENTS.md"), "# B\n\ncontext from dir-b\n");
    await writeFile(join(dirC, "AGENTS.md"), "# C\n\ncontext from dir-c\n");

    let controller;
    try {
      process.chdir(dirA);

      const stub = createStubView();
      controller = createController(stub.view, {
        noAgentContextFiles: false,
        deps: createProjectContextDeps(home),
      });
      const userMessages = [];
      controller.engine.addUserText = (text) => {
        userMessages.push(text);
        return "user-1";
      };
      controller.runAssistantTurn = async () => {};

      await controller.onUserInput(`/cd ${dirB}`);
      await controller.onUserInput(`/cd ${dirC}`);
      await controller.onUserInput("hello");

      const projectNoticeMatches =
        userMessages[0].match(/Project context changed by user after '\/cd'\./g) ?? [];
      expect(projectNoticeMatches).toHaveLength(1);
      expect(userMessages[0]).toContain("dir-c/AGENTS.md");
      expect(userMessages[0]).toContain("context from dir-c");
      expect(userMessages[0]).not.toContain("context from dir-b");
    } finally {
      await controller?.dispose();
      process.chdir(originalCwd);
      await rm(home, { recursive: true, force: true });
    }
  });

  it("clears pending risk/cwd/project notices on /new", async () => {
    const originalCwd = process.cwd();
    const home = await mkdtemp(join(tmpdir(), "tau-cd-context-"));
    const dirA = join(home, "dir-a");
    const dirB = join(home, "dir-b");
    await mkdir(dirA, { recursive: true });
    await mkdir(dirB, { recursive: true });
    await writeFile(join(dirA, "AGENTS.md"), "# A\n\ncontext from dir-a\n");
    await writeFile(join(dirB, "AGENTS.md"), "# B\n\ncontext from dir-b\n");

    let controller;
    try {
      process.chdir(dirA);

      const stub = createStubView();
      controller = createController(stub.view, {
        noAgentContextFiles: false,
        deps: createProjectContextDeps(home),
      });
      const userMessages = [];
      controller.engine.addUserText = (text) => {
        userMessages.push(text);
        return "user-1";
      };
      controller.runAssistantTurn = async () => {};

      await controller.onUserInput("/risk:read-write");
      await controller.onUserInput(`/cd ${dirB}`);
      await controller.onUserInput("/new");
      await controller.onUserInput("hello");

      expect(userMessages[0]).not.toContain("Risk level changed by user");
      expect(userMessages[0]).not.toContain("Working directory changed by user");
      expect(userMessages[0]).not.toContain("Project context changed by user after '/cd'.");
      expect(userMessages[0]).toBe("hello");
    } finally {
      await controller?.dispose();
      process.chdir(originalCwd);
      await rm(home, { recursive: true, force: true });
    }
  });
});

describe("ChatController maintenance interrupt handling", () => {
  it("aborts compaction without showing a failure message", async () => {
    const stub = createStubView();
    const controller = createController(stub.view);

    let compactStarted;
    const compactStartedPromise = new Promise((resolve) => {
      compactStarted = resolve;
    });

    vi.spyOn(controller.engine, "compact").mockImplementation(async ({ signal }) => {
      compactStarted();
      await new Promise((resolve) => {
        if (signal?.aborted) {
          resolve();
          return;
        }
        signal?.addEventListener("abort", resolve, { once: true });
      });
      throw new Error("Request was aborted");
    });

    const compactPromise = controller.onUserInput("/compact:summary-only");
    await compactStartedPromise;

    controller.onInterrupt();
    await compactPromise;

    expect(stub.systemMessages).toContainEqual({ text: "interrupted", kind: "error" });
    expect(stub.systemMessages.some((entry) => entry.text.startsWith("compact failed:"))).toBe(
      false,
    );
  });

  it("aborts smart prune sampling without showing a failure message", async () => {
    const stub = createStubView();
    const controller = createController(stub.view);

    controller.engine.addMessage({
      role: "toolResult",
      toolCallId: "bash-call-abort",
      toolName: TOOL_NAME_BASH,
      content: [{ type: "text", text: "bash output" }],
      isError: false,
      timestamp: 1,
    });

    let pruneStarted;
    const pruneStartedPromise = new Promise((resolve) => {
      pruneStarted = resolve;
    });

    controller.requestSmartPruneSelection = async (_prompt, signal) => {
      pruneStarted();
      await new Promise((resolve) => {
        if (signal?.aborted) {
          resolve();
          return;
        }
        signal?.addEventListener("abort", resolve, { once: true });
      });
      throw new Error("Request was aborted");
    };

    const prunePromise = controller.onUserInput("/prune:smart 1");
    await pruneStartedPromise;

    controller.onInterrupt();
    await prunePromise;

    expect(stub.systemMessages).toContainEqual({ text: "interrupted", kind: "error" });
    expect(stub.systemMessages.some((entry) => entry.text.startsWith("prune failed:"))).toBe(false);
  });

  it("reports maintenance failures before draining queued user input", async () => {
    const stub = createStubView();
    const queuedUserMessages = ["next message"];
    const controller = createController(stub.view, { queuedUserMessages });
    const events = [];

    const addSystemMessage = stub.view.addSystemMessage;
    stub.view.addSystemMessage = (text, kind) => {
      events.push(`message:${text}`);
      addSystemMessage(text, kind);
    };
    controller.onUserInput = async (text) => {
      events.push(`drain:${text}`);
    };

    vi.spyOn(controller.engine, "compact").mockRejectedValue(new Error("boom"));

    await controller.compactSessionSummaryOnly();

    const failureIndex = events.indexOf("message:compact failed: boom");
    const drainIndex = events.indexOf("drain:next message");
    expect(failureIndex).toBeGreaterThanOrEqual(0);
    expect(drainIndex).toBeGreaterThanOrEqual(0);
    expect(failureIndex).toBeLessThan(drainIndex);
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

    await controller.onUserInput("/prune:earliest");

    const history = controller.engine.history;
    const assistant = history.find((message) => message.role === "assistant");
    const toolCall = assistant.content.find((block) => block.type === "toolCall");
    expect(toolCall.arguments.oldText).toBe("[Content pruned]");
    expect(toolCall.arguments.newText).toBe("[Content pruned]");

    const toolResult = history.find((message) => message.role === "toolResult");
    const text = toolResult.content[0].text;
    expect(text).toContain("[Tool result pruned] Edit diff");
    expect(text).toContain("… 6 unchanged line(s) omitted …");
    expect(text).toContain("  pre 6");
    expect(text).not.toContain("  pre 0");
    expect(text).toContain("- before");
    expect(text).toContain("+ after");
    expect(text).toContain("  post 3");
    expect(text).not.toContain("  post 9");

    expect(stub.toolUiEvents).toContainEqual({
      type: "tool_pruned",
      toolCallId: "edit-call-1",
      content: text,
    });

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

    await controller.onUserInput("/prune:earliest 0");

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

  it("emits prune ui mutations for pruned bash results", async () => {
    const stub = createStubView();
    const controller = createController(stub.view);

    seedBashResult(controller, "bash output");

    await controller.onUserInput("/prune:earliest 1");

    const history = controller.engine.history;
    const toolResult = history.find((message) => message.role === "toolResult");
    const text = toolResult.content[0].text;

    expect(text).toContain("[Tool result pruned] bash output removed");
    expect(stub.toolUiEvents).toContainEqual({
      type: "tool_pruned",
      toolCallId: "bash-call-1",
      content: text,
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

    await controller.onUserInput("/prune:earliest");

    const history = controller.engine.history;
    const toolResult = history.find((message) => message.role === "toolResult");
    expect(toolResult.content[0].text).toBe("oldText not found in file.");
    expect(toolResult.isError).toBe(true);
  });

  it("emits prune ui mutations for smart pruning", async () => {
    const stub = createStubView();
    const controller = createController(stub.view);

    seedBashResult(controller, "bash output");

    controller.requestSmartPruneSelection = async () => ["bash-call-1"];

    await controller.onUserInput("/prune:smart 1");

    const history = controller.engine.history;
    const toolResult = history.find((message) => message.role === "toolResult");
    const text = toolResult.content[0].text;

    expect(text).toContain("[Tool result pruned] bash output removed");
    expect(stub.toolUiEvents).toContainEqual({
      type: "tool_pruned",
      toolCallId: "bash-call-1",
      content: text,
    });
  });

  it("does not prune edit payloads when smart prune sampling fails", async () => {
    const stub = createStubView();
    const controller = createController(stub.view);

    const oldText = "line before";
    const newText = "line after";
    seedEditHistory(controller, oldText, newText);
    seedBashResult(controller, "bash output");

    controller.requestSmartPruneSelection = async () => {
      throw new Error("sampling failed");
    };

    await controller.onUserInput("/prune:smart");

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
    expect(stub.toolUiEvents).toEqual([]);
  });
});

describe("ChatController mention expansion", () => {
  it("expands @<file> and @@skill:<name> mentions and ignores @@agent:<name>", async () => {
    const stub = createStubView();
    stub.setEditorText("@src/main.ts @@skill:alpha @@agent:default @src/main.ts");
    const controller = createController(stub.view, {
      skills: [{ name: "alpha", description: "alpha skill", path: "skills/alpha/SKILL.md" }],
    });

    controller.projectFiles = ["src/main.ts"];

    const commands = [];
    controller.runBashCommand = async (command) => {
      commands.push(command);
      return false;
    };

    await controller.expandFileMentions();

    expect(commands).toHaveLength(2);
    expect(commands[0]).toContain("cat -- 'src/main.ts'");
    expect(commands[1]).toContain("cat -- 'skills/alpha/SKILL.md'");
  });

  it("does not expand removed legacy mention syntax", async () => {
    const stub = createStubView();
    stub.setEditorText("@file:src/main.ts @skill:alpha @agent:default");
    const controller = createController(stub.view, {
      skills: [{ name: "alpha", description: "alpha skill", path: "skills/alpha/SKILL.md" }],
    });

    controller.projectFiles = ["src/main.ts"];

    const commands = [];
    controller.runBashCommand = async (command) => {
      commands.push(command);
      return false;
    };

    await controller.expandFileMentions();

    expect(commands).toEqual([]);
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
