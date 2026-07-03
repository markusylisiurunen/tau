import { rm, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { prependTauUserMetadata } from "../dist/core/utils/user_metadata.js";
import { applySessionProtocolDelta } from "../dist/protocol/session_protocol.js";
import { copyTextToClipboard } from "../dist/tui/clipboard.js";
import { SessionChatController } from "../dist/tui/session_chat_controller.js";
import {
  createProtocolBootstrap,
  createProtocolExecResult,
  createProtocolSnapshot,
} from "./helpers/session_protocol_fixtures.js";

vi.mock("../dist/tui/clipboard.js", () => ({
  copyTextToClipboard: vi.fn(async () => {}),
}));

const bootstrap = createProtocolBootstrap();
const altBootstrap = createProtocolBootstrap({
  persona: {
    ...bootstrap.persona,
    id: "persona-2",
    label: "Persona 2",
  },
});

function createSnapshot(historyEntries = [], riskLevel = "read-only") {
  return createProtocolSnapshot({
    sessionId: "session-1",
    bootstrap: { ...bootstrap, riskLevel },
    catalog: {
      personas: [bootstrap.persona, altBootstrap.persona],
      prompts: [{ id: "fix", label: "Fix", template: "fix the bug" }],
      themes: [{ id: "gold" }],
      skills: [
        {
          name: "alpha",
          description: "alpha skill",
          path: "/session/skills/alpha/SKILL.md",
        },
      ],
    },
    executionEnvironment: {
      kind: "local",
      cwd: "/session/repo",
      home: "/home/session",
    },
    historyEntries,
  });
}

function historyEntriesFromSnapshot(snapshot) {
  return snapshot.messages
    .filter((entry) => entry.id !== "system" && entry.modelVisible)
    .map((entry) => ({ id: entry.id, message: entry.message }));
}

function updateSnapshot(snapshot, overrides = {}) {
  const riskLevel = overrides.riskLevel ?? snapshot.settings.riskLevel;
  return createProtocolSnapshot({
    sessionId: snapshot.sessionId,
    revision: overrides.revision ?? snapshot.revision,
    lifecycle: overrides.lifecycle ?? snapshot.lifecycle,
    bootstrap: { ...bootstrap, riskLevel },
    catalog: overrides.catalog ?? snapshot.catalog,
    executionEnvironment: snapshot.executionEnvironment,
    historyEntries: overrides.historyEntries ?? historyEntriesFromSnapshot(snapshot),
    settings: overrides.settings ?? snapshot.settings,
    messages: overrides.messages,
    timeline: overrides.timeline,
    tools: overrides.tools ?? snapshot.tools,
    agents: overrides.agents ?? snapshot.agents,
    facets: overrides.facets ?? snapshot.facets,
  });
}

function createAssistantMessage(text) {
  return {
    role: "assistant",
    api: "openai-responses",
    provider: "openai",
    model: "gpt-5.5",
    stopReason: "stop",
    content: [{ type: "text", text }],
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    timestamp: 1,
  };
}

function createAssistantToolCallMessage(toolCalls) {
  return {
    ...createAssistantMessage(""),
    stopReason: "tool_call",
    content: toolCalls,
  };
}

function createAgentRun(overrides = {}) {
  return {
    id: "agent-1",
    name: "default",
    title: "Inspect state",
    status: "running",
    originMessageId: "assistant-1",
    costTotal: 0.01,
    turns: 1,
    toolCalls: 0,
    usage: {
      input: 10,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
      contextWindowUsageTokens: 15,
      contextWindow: 200000,
    },
    startedAt: 1,
    abortRequested: false,
    ...overrides,
  };
}

function createMessageAppendDelta(sessionId, fromRevision, message, state = "committed") {
  return {
    version: 1,
    type: "session.delta",
    sessionId,
    fromRevision,
    toRevision: fromRevision + 1,
    reason: message.message.role === "assistant" ? "assistant-message" : "user-message",
    delta: {
      type: "snapshot.patch",
      changes: [
        ...(state === "draft" ? [{ type: "lifecycle.set", lifecycle: "running" }] : []),
        {
          type: "message.append",
          message: { ...message, state },
          timelineItem: {
            type: "message",
            id: `timeline-${message.id}`,
            messageId: message.id,
          },
        },
      ],
    },
  };
}

function createMessageReplaceDelta(sessionId, fromRevision, message, reason = "assistant-message") {
  return {
    version: 1,
    type: "session.delta",
    sessionId,
    fromRevision,
    toRevision: fromRevision + 1,
    reason,
    delta: {
      type: "snapshot.patch",
      changes: [
        {
          type: "message.replace",
          message,
        },
        { type: "lifecycle.set", lifecycle: "idle" },
      ],
    },
  };
}

function createResetDelta(sessionId, fromRevision, snapshot, reason = "configuration") {
  return {
    version: 1,
    type: "session.delta",
    sessionId,
    fromRevision,
    toRevision: snapshot.revision,
    reason,
    delta: { type: "snapshot.reset", snapshot },
  };
}

class FakeSession {
  id = "session-1";
  listeners = new Set();
  ephemeralListeners = new Set();
  operationLog = [];
  emitSubmitEvents = true;
  rejectSubmit = false;
  submit = vi.fn(async (text, options = {}) => {
    if (this.rejectSubmit) {
      throw new Error("submit rejected");
    }
    const historyEntryId = options.historyEntryId ?? "generated-user";
    if (this.emitSubmitEvents) {
      this.emit({
        type: "assistant_start",
        historyEntryId: "assistant-1",
      });
      this.emit({
        type: "assistant_final",
        historyEntryId: "assistant-1",
        message: {
          ...createAssistantMessage(`session reply to ${text}`),
        },
      });
    }
    this.snapshotValue = createSnapshot([
      {
        id: historyEntryId,
        message: { role: "user", content: [{ type: "text", text }] },
      },
      {
        id: "assistant-1",
        message: createAssistantMessage(`session reply to ${text}`),
      },
    ]);
    return { userHistoryEntryId: historyEntryId, turn: { aborted: false } };
  });
  retry = vi.fn(async () => {
    const historyEntryId = "assistant-retry";
    const message = {
      ...createAssistantMessage("session retry reply"),
    };
    if (this.emitSubmitEvents) {
      this.emit({
        type: "assistant_start",
        historyEntryId,
      });
      this.emit({
        type: "assistant_final",
        historyEntryId,
        message,
      });
    }
    this.snapshotValue = updateSnapshot(this.snapshotValue, {
      revision: this.snapshotValue.revision + 1,
      historyEntries: [
        ...historyEntriesFromSnapshot(this.snapshotValue),
        { id: historyEntryId, message },
      ],
    });
    return { turn: { aborted: false } };
  });
  exec = vi.fn(async (command) => {
    if (command.includes("rev-parse --show-toplevel")) {
      return createProtocolExecResult({ output: "/repo\n" });
    }
    if (command.includes("diff --name-status")) {
      return createProtocolExecResult({ output: "M\0src/main.ts\0" });
    }
    if (command.includes("diff")) {
      return createProtocolExecResult({
        output: "diff --git a/src/main.ts b/src/main.ts\n",
      });
    }
    return createProtocolExecResult({ output: "" });
  });
  record = vi.fn(async (text, options = {}) => {
    this.operationLog.push("record");
    const historyEntryId = options.historyEntryId ?? "added-user";
    this.snapshotValue = updateSnapshot(this.snapshotValue, {
      revision: this.snapshotValue.revision + 1,
      historyEntries: [
        ...historyEntriesFromSnapshot(this.snapshotValue),
        {
          id: historyEntryId,
          message: { role: "user", content: [{ type: "text", text }] },
        },
      ],
    });
    return { snapshot: this.snapshotValue, userHistoryEntryId: historyEntryId };
  });
  steer = vi.fn(async () => ({
    userHistoryEntryId: "steer-1",
    turn: { aborted: false },
  }));
  interrupt = vi.fn(async () => ({ interrupted: true, isTurnRunning: false }));
  setRiskLevel = vi.fn(async (riskLevel) => {
    this.snapshotValue = updateSnapshot(this.snapshotValue, {
      revision: this.snapshotValue.revision + 1,
      riskLevel,
      settings: { ...this.snapshotValue.settings, riskLevel },
    });
    return this.snapshotValue;
  });
  setReasoning = vi.fn(async (reasoning) => {
    this.snapshotValue = updateSnapshot(this.snapshotValue, {
      revision: this.snapshotValue.revision + 1,
      settings: { ...this.snapshotValue.settings, reasoning },
    });
    return this.snapshotValue;
  });
  setPersona = vi.fn(async (personaId) => {
    this.snapshotValue = updateSnapshot(this.snapshotValue, {
      revision: this.snapshotValue.revision + 1,
      settings: { ...this.snapshotValue.settings, personaId },
    });
    return this.snapshotValue;
  });
  reload = vi.fn(async () => {
    this.snapshotValue = updateSnapshot(this.snapshotValue, {
      revision: this.snapshotValue.revision + 1,
      catalog: {
        ...this.snapshotValue.catalog,
        prompts: [...this.snapshotValue.catalog.prompts, { id: "reloaded", label: "Reloaded" }],
      },
    });
    return {
      snapshot: this.snapshotValue,
      warnings: ["reload warning"],
      counts: {
        personas: this.snapshotValue.catalog.personas.length,
        prompts: this.snapshotValue.catalog.prompts.length,
        skills: this.snapshotValue.catalog.skills.length,
      },
    };
  });
  resolvePrompt = vi.fn(async (promptId) => {
    if (promptId === "fix") {
      return { promptId, text: "fix the bug" };
    }
    if (promptId === "reloaded") {
      return { promptId, text: "reloaded prompt" };
    }
    throw new Error(`unknown prompt '${promptId}'`);
  });
  autocompletePaths = vi.fn(async ({ query, limit }) => ({
    paths: ["src/main.ts", "src/tui/session_chat_app.ts"]
      .filter((path) => path.includes(query))
      .slice(0, limit),
  }));
  compact = vi.fn(async (mode, options = {}) => {
    const compactionMessage = options.guidance
      ? `compacted summary: ${options.guidance}`
      : "compacted summary";
    this.snapshotValue = updateSnapshot(this.snapshotValue, {
      revision: this.snapshotValue.revision + 1,
      historyEntries: [
        {
          id: "summary-entry",
          message: {
            role: "user",
            content: [{ type: "text", text: compactionMessage }],
          },
        },
      ],
    });
    return {
      snapshot: this.snapshotValue,
      compactionMessage,
      includedLastAssistant: mode === "summary-and-last",
    };
  });
  pruneToolResults = vi.fn(async (strategy, options) => {
    this.snapshotValue = updateSnapshot(this.snapshotValue, {
      revision: this.snapshotValue.revision + 1,
    });
    return {
      snapshot: this.snapshotValue,
      message: `pruned ${strategy} at ${options.fraction}`,
      noop: false,
      bashResultsPruned: 1,
      editCallsPruned: 0,
      editResultsPruned: 0,
      bytesPruned: 512,
    };
  });
  rewindToHistoryEntryId = vi.fn(async (historyEntryId) => {
    const historyEntries = historyEntriesFromSnapshot(this.snapshotValue);
    const historyIndex = historyEntries.findIndex((entry) => entry.id === historyEntryId);
    if (historyIndex < 0 || historyEntries[historyIndex].message.role !== "user") {
      throw new Error("rewind failed");
    }
    const entry = historyEntries[historyIndex];
    const removedEntryIds = historyEntries.slice(historyIndex).map((item) => item.id);
    this.snapshotValue = updateSnapshot(this.snapshotValue, {
      revision: this.snapshotValue.revision + 1,
      historyEntries: historyEntries.slice(0, historyIndex),
    });
    const text =
      typeof entry.message.content === "string"
        ? entry.message.content
        : entry.message.content
            .filter((block) => block.type === "text")
            .map((block) => block.text)
            .join("\n");
    return {
      snapshot: this.snapshotValue,
      historyEntryId,
      text,
      removedEntryIds,
    };
  });
  terminateSubagent = vi.fn(async (subagentId) => ({
    found: subagentId === "subagent-1",
  }));
  createEphemeralContext = vi.fn(async () => ({ contextId: "ephemeral-1" }));
  submitEphemeralThread = vi.fn(async ({ contextId, threadId, message }) => {
    for (const listener of this.ephemeralListeners) {
      listener({
        version: 1,
        type: "session.ephemeral",
        sessionId: this.id,
        event: {
          type: "ephemeral-agent.thread-update",
          contextId,
          threadId,
          update: {
            costTotal: 0,
            usage: {
              input: 1,
              output: 2,
              cacheRead: 0,
              cacheWrite: 0,
              contextWindowUsageTokens: 3,
              contextWindow: 400000,
            },
            lastActivityText: "reviewing diff",
          },
        },
      });
    }
    return { threadId, response: `review response: ${message}` };
  });
  closeEphemeralContext = vi.fn(async () => {
    this.operationLog.push("close-ephemeral");
    return { closed: true };
  });
  unobserve = vi.fn(async () => ({ unobserved: true }));

  constructor(snapshot = createSnapshot()) {
    this.snapshotValue = snapshot;
  }

  onDelta(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  onEphemeral(listener) {
    this.ephemeralListeners.add(listener);
    return () => this.ephemeralListeners.delete(listener);
  }

  async snapshot() {
    return this.snapshotValue;
  }

  emit(event) {
    const fromRevision = this.snapshotValue.revision;
    for (const listener of this.listeners) {
      if (event.type === "assistant_start") {
        const draftMessage = {
          id: event.historyEntryId,
          state: "draft",
          modelVisible: false,
          message: { role: "assistant", timestamp: 1, content: [] },
        };
        this.snapshotValue = updateSnapshot(this.snapshotValue, {
          revision: fromRevision + 1,
          lifecycle: "running",
          messages: [...this.snapshotValue.messages, draftMessage],
          timeline: [
            ...this.snapshotValue.timeline,
            {
              type: "message",
              id: `timeline-${event.historyEntryId}`,
              messageId: event.historyEntryId,
            },
          ],
        });
        listener(createMessageAppendDelta(this.id, fromRevision, draftMessage, "draft"));
      }
      if (event.type === "assistant_final") {
        const finalMessage = {
          id: event.historyEntryId,
          state: "committed",
          modelVisible: true,
          message: event.message,
        };
        this.snapshotValue = updateSnapshot(this.snapshotValue, {
          revision: this.snapshotValue.revision + 1,
          lifecycle: "idle",
          messages: this.snapshotValue.messages.some(
            (message) => message.id === event.historyEntryId,
          )
            ? this.snapshotValue.messages.map((message) =>
                message.id === event.historyEntryId ? finalMessage : message,
              )
            : [...this.snapshotValue.messages, finalMessage],
        });
        listener(createMessageReplaceDelta(this.id, this.snapshotValue.revision - 1, finalMessage));
      }
    }
  }

  emitUpdate(_update, sessionRevision = this.snapshotValue.revision) {
    for (const listener of this.listeners) {
      listener(createResetDelta(this.id, sessionRevision, this.snapshotValue, "maintenance"));
    }
  }
}

class FakeView {
  messages = [];
  removed = [];
  systems = [];
  toolEvents = [];
  rewindPickerShows = [];
  rewindPickerHideCount = 0;
  removeMessagesFromCalls = [];
  status;
  statusUpdates = [];
  editorText = "";
  editorEnabledUpdates = [];
  toolCost = 0;
  subagentSelectionCycles = [];
  selectedSubagentId;
  renderRequests = 0;
  workingIconStarts = 0;
  workingIconStops = 0;

  start() {}
  stop() {}
  requestRender() {
    this.renderRequests += 1;
  }
  removeMessages(ids) {
    this.removed.push(...ids);
    this.messages = this.messages.filter((message) => !ids.includes(message.id));
  }
  removeMessagesFrom(id) {
    this.removeMessagesFromCalls.push(id);
  }
  addMessage(model, id = `view-${this.messages.length + 1}`) {
    this.messages.push({ id, model });
    return id;
  }
  replaceMessage(id, model) {
    this.updateMessage(id, model);
  }
  updateMessage(id, model) {
    const message = this.messages.find((item) => item.id === id);
    if (message) {
      message.model = model;
    } else {
      this.messages.push({ id, model });
    }
  }
  updateAssistantMessage(id, model) {
    this.updateMessage(id, model);
  }
  addSystemMessage(text, kind, options) {
    this.systems.push({ text, kind, options });
  }
  setThinkingVisibility() {}
  setCompactToolUi() {}
  updateStatus(status) {
    this.status = status;
    this.statusUpdates.push(status);
  }
  startWorkingIcon() {
    this.workingIconStarts += 1;
  }
  stopWorkingIcon() {
    this.workingIconStops += 1;
  }
  handleToolUiEvent(event) {
    this.toolEvents.push(event);
  }
  subagentEvents = [];
  handleSubagentEvent(event) {
    this.subagentEvents.push(event);
  }
  resetToolUiSession = vi.fn();
  resetToolUiSessionPreservingSubagents() {}
  finalizeToolUiPending() {}
  clearToolUiTransientState() {}
  getToolUiCostTotal() {
    return this.toolCost;
  }
  cycleSubagentSelection(direction) {
    this.subagentSelectionCycles.push(direction);
    return undefined;
  }
  getSelectedSubagentId() {
    return this.selectedSubagentId;
  }
  sendTerminalNotification() {}
  getEditorText() {
    return this.editorText;
  }
  getExpandedEditorText() {
    return this.editorText;
  }
  setEditorText(text) {
    this.editorText = text;
  }
  insertEditorTextAtCursor(text) {
    this.editorText += text;
  }
  setEditorInputEnabled(enabled) {
    this.editorEnabledUpdates.push(enabled);
  }
  showRewindPicker(options) {
    this.rewindPickerShows.push(options);
  }
  hideRewindPicker() {
    this.rewindPickerHideCount += 1;
  }
  getEditorCursor() {
    return { line: 0, col: 0 };
  }
  getEditorLines() {
    return [this.editorText];
  }
  bindInputHandlers() {}
  setAutocompleteProvider() {}
  addBashExecutionMessage() {}
  updateTheme = vi.fn();
}

async function flush() {
  await new Promise((resolve) => setImmediate(resolve));
  await new Promise((resolve) => setImmediate(resolve));
}

async function waitMs(ms) {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

async function waitUntil(predicate, timeoutMs = 2000) {
  const startedAt = Date.now();
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("timed out waiting for condition");
    }
    await waitMs(10);
  }
}

async function launchInlineDiffTool({ env }) {
  await new Promise((resolve, reject) => {
    const socket = createConnection(env.TAU_DIFF_SOCKET);
    let nextId = 1;
    let buffer = "";
    let initialized = false;
    let submitted = false;
    let connected = false;

    const request = (method, params) => {
      const id = String(nextId++);
      socket.write(`${JSON.stringify({ version: 1, type: "request", id, method, params })}\n`);
    };

    socket.once("connect", () => {
      connected = true;
      resolve();
      request("initialize", { token: env.TAU_DIFF_TOKEN });
    });
    socket.once("error", (error) => {
      if (!connected) {
        reject(error);
      }
    });
    socket.on("data", (chunk) => {
      buffer += chunk.toString("utf8");
      while (buffer.includes("\n")) {
        const index = buffer.indexOf("\n");
        const line = buffer.slice(0, index).trim();
        buffer = buffer.slice(index + 1);
        if (!line) continue;

        const message = JSON.parse(line);
        if (message.type === "request" && message.method === "session.close") {
          socket.write(
            `${JSON.stringify({
              version: 1,
              type: "response",
              id: message.id,
              ok: true,
              result: { status: "closed" },
            })}\n`,
          );
          socket.end();
          continue;
        }

        if (message.type !== "response" || !message.ok) continue;
        if (!initialized) {
          initialized = true;
          request("thread.submit_message", { message: "explain this diff" });
          continue;
        }
        if (!submitted) {
          submitted = true;
          request("session.return_review", {
            review: "returned review from local diff tool",
          });
        }
      }
    });
  });
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
}

function createMockDeps(spawn = vi.fn(), platform = "darwin") {
  return {
    env: {
      platform: () => platform,
      env: () => ({}),
    },
    spawn,
  };
}

describe("SessionChatController", () => {
  it("renders the main-style startup intro and compact remote cwd label", async () => {
    const systemPrompt = [
      "system prompt",
      "",
      "### Project context",
      "",
      '<file path="/home/session/repo/AGENTS.md">',
      "project instructions",
      "</file>",
      "",
      "Nested AGENTS.md files under the current working directory (paths only):",
      "",
      "<nested-agents-files>",
      '  <file path="/home/session/repo/src/AGENTS.md" />',
      "</nested-agents-files>",
    ].join("\n");
    const snapshot = createProtocolSnapshot({
      bootstrap: {
        ...bootstrap,
        prompt: { ...bootstrap.prompt, baseSystemPrompt: systemPrompt },
      },
      catalog: {
        personas: [bootstrap.persona],
        prompts: [{ id: "fix", label: "Fix", template: "fix the bug" }],
        themes: [{ id: "gold" }],
        skills: [
          {
            name: "alpha",
            description: "alpha skill",
            path: "/home/session/.tau/skills/alpha/SKILL.md",
          },
        ],
      },
      executionEnvironment: {
        kind: "local",
        cwd: "/home/session/repo",
        home: "/home/session",
      },
    });
    const session = new FakeSession(snapshot);
    const view = new FakeView();
    const controller = new SessionChatController({
      view,
      session,
      snapshot: await session.snapshot(),
      targetLabel: "ssh host tau rpc",
      themeIds: ["gold"],
    });

    controller.start();

    const intro = view.messages.find((message) => message.model.type === "app_intro")?.model;
    expect(intro.title).toContain("tau v");
    expect(intro.title).toContain("1 AGENTS.md");
    expect(intro.title).toContain("1 skills");
    expect(intro.title).not.toContain("session");
    expect(intro.body).toContain("skills:\n  alpha (~/.tau/skills)");
    expect(intro.body).toContain("context:\n  ~/repo/AGENTS.md");
    expect(intro.body).not.toContain("~/repo/src/AGENTS.md");
    expect(intro.body).toContain("session id: session-1");
    expect(intro.body).not.toContain("ssh host tau rpc");
    expect(view.status.editor.cwdLabel).toBe("remote · ~/repo");
    expect(view.status.footer.contextUsage).toBe("↑0 ↓0 (r0 w0) · 0.0%/128k");

    await controller.onUserInput("/help");
    expect(view.systems.at(-1)?.text).toContain("context:\n  ~/repo/AGENTS.md");
    expect(view.systems.at(-1)?.text).not.toContain("~/repo/src/AGENTS.md");
    expect(view.systems.at(-1)?.text).toContain("skills:\n  alpha (~/.tau/skills)");
  });

  it("shows auto-compaction operation status in the footer", async () => {
    const snapshot = createProtocolSnapshot({
      timeline: [
        {
          type: "operation",
          id: "operation-auto-compaction",
          operation: {
            kind: "auto-compaction",
            status: "running",
            startedAt: 1,
          },
        },
      ],
    });
    const session = new FakeSession(snapshot);
    const view = new FakeView();
    const controller = new SessionChatController({
      view,
      session,
      snapshot: await session.snapshot(),
      targetLabel: "in-process",
    });

    controller.start();

    expect(view.status.footer.commandHint).toBe("compacting context...");
  });

  it("renders auto-compaction resets with the main-style divider and retained notice", async () => {
    const runningSnapshot = createProtocolSnapshot({
      sessionId: "session-1",
      revision: 1,
      timeline: [
        {
          type: "operation",
          id: "operation-auto-compaction",
          operation: {
            kind: "auto-compaction",
            status: "running",
            startedAt: 1,
          },
        },
      ],
    });
    const compactedText = prependTauUserMetadata("compacted summary", [
      {
        type: "auto-compaction",
        version: 1,
        summary: "compacted summary",
        preservedUserMessages: [],
        cutType: "turn-boundary",
        retainedMessageCount: 3,
      },
    ]);
    const compactedSnapshot = createProtocolSnapshot({
      sessionId: "session-1",
      revision: 2,
      historyEntries: [
        {
          id: "summary-entry",
          message: {
            role: "user",
            content: [{ type: "text", text: compactedText }],
          },
        },
      ],
    });
    const session = new FakeSession(runningSnapshot);
    const view = new FakeView();
    const controller = new SessionChatController({
      view,
      session,
      snapshot: await session.snapshot(),
      targetLabel: "in-process",
    });
    controller.start();

    for (const listener of session.listeners) {
      listener(createResetDelta(session.id, 1, compactedSnapshot, "maintenance"));
    }

    expect(view.messages).toContainEqual(
      expect.objectContaining({
        model: { type: "session_divider", label: "new session" },
      }),
    );
    expect(view.messages).toContainEqual(
      expect.objectContaining({
        model: { type: "user", text: "compacted summary" },
      }),
    );
    expect(view.messages).toContainEqual(
      expect.objectContaining({
        model: {
          type: "system",
          text: "retained 3 recent messages",
          kind: "muted",
        },
      }),
    );
  });

  it("hydrates a session snapshot and submits through the observed session", async () => {
    const session = new FakeSession(
      createSnapshot([
        {
          id: "history-1",
          message: {
            role: "user",
            content: [{ type: "text", text: "persisted" }],
          },
        },
      ]),
    );
    const view = new FakeView();
    const controller = new SessionChatController({
      view,
      session,
      snapshot: await session.snapshot(),
      targetLabel: "ssh host tau rpc",
      themeIds: ["gold"],
    });

    controller.start();
    expect(view.messages.map((message) => message.id)).toContain("history-1");
    expect(view.status.editor.cwdLabel).toBe("remote · /session/repo");

    controller.getInputHandlers().onSubmit("hello session");
    await flush();

    expect(session.submit).toHaveBeenCalledWith(
      "hello session",
      expect.objectContaining({
        historyEntryId: expect.stringMatching(/^session-user-/),
      }),
    );
    const userEntryId = session.submit.mock.calls[0][1].historyEntryId;
    expect(view.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: userEntryId,
          model: { type: "user", text: "hello session" },
        }),
        expect.objectContaining({
          id: "assistant-1",
          model: expect.objectContaining({ type: "assistant" }),
        }),
      ]),
    );
  });

  it("clears submitted turn state when submit fails", async () => {
    const session = new FakeSession();
    session.rejectSubmit = true;
    const view = new FakeView();
    const controller = new SessionChatController({
      view,
      session,
      snapshot: await session.snapshot(),
      targetLabel: "ssh host tau rpc",
      themeIds: ["gold"],
    });

    controller.start();
    controller.getInputHandlers().onSubmit("hello session");
    await flush();

    expect(view.systems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          text: "session turn failed: submit rejected",
          kind: "error",
        }),
      ]),
    );
    expect(view.workingIconStarts).toBe(1);
    expect(view.workingIconStops).toBe(1);
    expect(controller.isStreaming).toBe(false);
    expect(controller.submittedTurnInProgress).toBe(false);
    expect(view.status.footer.commandHint).toBeUndefined();
  });

  it("stops visible running state when submit fails before snapshot recovery returns", async () => {
    const session = new FakeSession();
    session.rejectSubmit = true;
    const view = new FakeView();
    const controller = new SessionChatController({
      view,
      session,
      snapshot: await session.snapshot(),
      targetLabel: "ssh host tau rpc",
      themeIds: ["gold"],
    });

    controller.start();
    session.snapshot = vi.fn(async () => await new Promise(() => {}));
    controller.getInputHandlers().onSubmit("hello session");
    await flush();

    expect(view.systems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          text: "session turn failed: submit rejected",
          kind: "error",
        }),
      ]),
    );
    expect(view.workingIconStarts).toBe(1);
    expect(view.workingIconStops).toBe(1);
    expect(controller.isStreaming).toBe(false);
    expect(view.status.footer.commandHint).toBeUndefined();
  });

  it("starts and stops caffeinate around submitted session turns when enabled", async () => {
    const spawn = vi.fn((_command, _args, options = {}) => {
      return new Promise((resolve) => {
        options.signal.addEventListener("abort", () => {
          resolve({
            stdout: "",
            stderr: "",
            output: undefined,
            exitCode: null,
            captureLimitExceeded: false,
            timedOut: false,
            aborted: true,
            closeSignal: "SIGTERM",
          });
        });
      });
    });
    const session = new FakeSession();
    const view = new FakeView();
    const controller = new SessionChatController({
      view,
      session,
      snapshot: await session.snapshot(),
      targetLabel: "in-process",
      deps: createMockDeps(spawn),
      caffeinated: true,
    });
    controller.start();

    controller.getInputHandlers().onSubmit("hello session");
    await flush();

    expect(spawn).toHaveBeenCalledWith(
      "/usr/bin/caffeinate",
      ["-i"],
      expect.objectContaining({
        detached: true,
        killProcessGroup: true,
        stdio: ["ignore", "ignore", "ignore"],
      }),
    );
    expect(session.submit).toHaveBeenCalledWith(
      "hello session",
      expect.objectContaining({
        historyEntryId: expect.stringMatching(/^session-user-/),
      }),
    );
  });

  it("does not start caffeinate on Linux", async () => {
    const spawn = vi.fn();
    const session = new FakeSession();
    const view = new FakeView();
    const controller = new SessionChatController({
      view,
      session,
      snapshot: await session.snapshot(),
      targetLabel: "in-process",
      deps: createMockDeps(spawn, "linux"),
      caffeinated: true,
    });
    controller.start();

    controller.getInputHandlers().onSubmit("hello session");
    await flush();

    expect(spawn).not.toHaveBeenCalled();
    expect(session.submit).toHaveBeenCalled();
  });

  it("renders the authoritative snapshot when live assistant events were missed", async () => {
    const session = new FakeSession();
    session.emitSubmitEvents = false;
    const view = new FakeView();
    const controller = new SessionChatController({
      view,
      session,
      snapshot: await session.snapshot(),
      targetLabel: "ssh host tau rpc",
    });
    controller.start();

    controller.getInputHandlers().onSubmit("hello session");
    await flush();

    expect(view.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "assistant-1",
          model: expect.objectContaining({ type: "assistant" }),
        }),
      ]),
    );
  });

  it("syncs rendered history when a session update arrives from another client", async () => {
    const session = new FakeSession();
    const view = new FakeView();
    const controller = new SessionChatController({
      view,
      session,
      snapshot: await session.snapshot(),
      targetLabel: "ssh host tau rpc",
    });
    controller.start();

    session.snapshotValue = updateSnapshot(session.snapshotValue, {
      revision: session.snapshotValue.revision + 1,
      riskLevel: "read-write",
      settings: { ...session.snapshotValue.settings, riskLevel: "read-write" },
      historyEntries: [
        {
          id: "other-user",
          message: {
            role: "user",
            content: [{ type: "text", text: "from other client" }],
          },
        },
      ],
    });
    session.emitUpdate(
      { type: "snapshot_changed", reason: "risk_changed" },
      session.snapshotValue.revision,
    );
    await flush();

    expect(view.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "other-user",
          model: { type: "user", text: "from other client" },
        }),
      ]),
    );
    expect(view.status.footer.riskLevel).toBe("read-write");
  });

  it("ignores stale snapshot reset deltas", async () => {
    const currentSnapshot = updateSnapshot(createSnapshot(), {
      revision: 5,
      historyEntries: [
        {
          id: "current-user",
          message: {
            role: "user",
            content: [{ type: "text", text: "current state" }],
          },
        },
      ],
    });
    const staleSnapshot = updateSnapshot(createSnapshot(), {
      revision: 4,
      historyEntries: [
        {
          id: "stale-user",
          message: {
            role: "user",
            content: [{ type: "text", text: "stale state" }],
          },
        },
      ],
    });
    const session = new FakeSession(currentSnapshot);
    const view = new FakeView();
    const controller = new SessionChatController({
      view,
      session,
      snapshot: await session.snapshot(),
      targetLabel: "ssh host tau rpc",
    });
    controller.start();

    for (const listener of session.listeners) {
      listener(createResetDelta(session.id, 3, staleSnapshot, "maintenance"));
    }
    await flush();

    expect(controller.snapshot.revision).toBe(5);
    expect(view.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "current-user",
          model: { type: "user", text: "current state" },
        }),
      ]),
    );
    expect(view.messages).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "stale-user" })]),
    );
  });

  it("tracks and syncs turns started by another observed client", async () => {
    const session = new FakeSession();
    session.snapshot = vi.fn(async () => session.snapshotValue);
    const view = new FakeView();
    const controller = new SessionChatController({
      view,
      session,
      snapshot: await session.snapshot(),
      targetLabel: "ssh host tau rpc",
    });
    controller.start();

    const observedUser = {
      id: "observed-user",
      state: "committed",
      modelVisible: true,
      message: {
        role: "user",
        content: [{ type: "text", text: "started elsewhere" }],
      },
    };
    const observedUserDelta = createMessageAppendDelta(
      session.id,
      session.snapshotValue.revision,
      observedUser,
    );
    session.snapshotValue = applySessionProtocolDelta(session.snapshotValue, observedUserDelta);
    for (const listener of session.listeners) {
      listener(observedUserDelta);
    }
    session.emit({
      type: "assistant_start",
      historyEntryId: "observed-assistant",
    });

    expect(view.workingIconStarts).toBe(1);
    expect(view.status.footer.commandHint).toBeUndefined();

    const assistantMessage = createAssistantMessage("observed reply");
    session.emit({
      type: "assistant_final",
      historyEntryId: "observed-assistant",
      message: assistantMessage,
    });
    await flush();

    expect(view.workingIconStops).toBe(1);
    expect(view.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "observed-user",
          model: { type: "user", text: "started elsewhere" },
        }),
        expect.objectContaining({
          id: "observed-assistant",
          model: expect.objectContaining({ type: "assistant" }),
        }),
      ]),
    );
    expect(session.snapshot).toHaveBeenCalledTimes(1);
  });

  it("stops visible running state on idle delta before a submitted turn response resolves", async () => {
    const session = new FakeSession();
    const view = new FakeView();
    const controller = new SessionChatController({
      view,
      session,
      snapshot: await session.snapshot(),
      targetLabel: "in-process",
    });
    controller.start();

    const submitted = deferred();
    const delayedSubmit = vi.fn(async (text, options = {}) => {
      session.emit({
        type: "assistant_start",
        historyEntryId: "assistant-delayed-response",
      });
      session.emit({
        type: "assistant_final",
        historyEntryId: "assistant-delayed-response",
        message: createAssistantMessage(`session reply to ${text}`),
      });
      const result = await submitted.promise;
      const historyEntryId = options.historyEntryId ?? "generated-user";
      session.snapshotValue = createSnapshot([
        {
          id: historyEntryId,
          message: { role: "user", content: [{ type: "text", text }] },
        },
        {
          id: "assistant-delayed-response",
          message: createAssistantMessage(`session reply to ${text}`),
        },
      ]);
      return result;
    });
    session.submit = delayedSubmit;

    controller.getInputHandlers().onSubmit("hello session");
    await flush();

    expect(view.workingIconStarts).toBe(1);
    expect(view.workingIconStops).toBe(1);
    expect(controller.isStreaming).toBe(false);
    expect(controller.submittedTurnInProgress).toBe(true);
    expect(view.status.footer.commandHint).toBeUndefined();

    controller.getInputHandlers().onSubmit("queued while response pending");
    await flush();

    expect(delayedSubmit).toHaveBeenCalledTimes(1);
    expect(view.systems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          text: "message queued",
          kind: "success",
          options: { persist: false },
        }),
      ]),
    );

    session.submit = vi.fn(async (_text, options = {}) => ({
      userHistoryEntryId: options.historyEntryId ?? "queued-user",
      turn: { aborted: false },
    }));
    submitted.resolve({
      userHistoryEntryId: "user-delayed-response",
      turn: { aborted: false },
    });
    await flush();

    expect(view.workingIconStops).toBe(2);
    expect(controller.submittedTurnInProgress).toBe(false);
    expect(session.submit).toHaveBeenCalledWith(
      "queued while response pending",
      expect.objectContaining({
        historyEntryId: expect.stringMatching(/^session-user-/),
      }),
    );
  });

  it("keeps queued messages unchanged when flushing as steering while idle", async () => {
    const queuedUserMessages = ["first queued", "second queued"];
    const session = new FakeSession();
    const view = new FakeView();
    const controller = new SessionChatController({
      view,
      session,
      snapshot: await session.snapshot(),
      targetLabel: "in-process",
      queuedUserMessages,
    });
    controller.start();

    controller.getInputHandlers().onFlushQueueAsSteer?.();

    expect(queuedUserMessages).toEqual(["first queued", "second queued"]);
    expect(session.steer).not.toHaveBeenCalled();
    expect(view.systems).toContainEqual({
      text: "current task cannot be steered; queued messages unchanged",
      kind: "warn",
      options: undefined,
    });
  });

  it("uses main-style steering queue messages while a submitted turn is active", async () => {
    const queuedUserMessages = ["first queued", "second queued"];
    const session = new FakeSession();
    const view = new FakeView();
    const controller = new SessionChatController({
      view,
      session,
      snapshot: await session.snapshot(),
      targetLabel: "in-process",
      queuedUserMessages,
    });
    controller.start();
    controller.isStreaming = true;
    controller.submittedTurnInProgress = true;

    controller.getInputHandlers().onSteerSubmit?.("change direction");
    await flush();

    expect(session.steer).toHaveBeenCalledWith(
      "change direction",
      expect.objectContaining({
        historyEntryId: expect.stringMatching(/^session-steer-/),
      }),
    );
    expect(view.systems).toContainEqual({
      text: "steering queued for next turn boundary",
      kind: "success",
      options: undefined,
    });

    controller.getInputHandlers().onFlushQueueAsSteer?.();
    await flush();

    expect(queuedUserMessages).toEqual([]);
    expect(session.steer).toHaveBeenCalledWith(
      "first queued\n\nsecond queued",
      expect.objectContaining({
        historyEntryId: expect.stringMatching(/^session-steer-/),
      }),
    );
    expect(view.systems).toContainEqual({
      text: "queued messages will steer at the next turn boundary",
      kind: "success",
      options: undefined,
    });
  });

  it("does not dispatch or queue commands while a submitted turn response is pending", async () => {
    const session = new FakeSession();
    const view = new FakeView();
    const controller = new SessionChatController({
      view,
      session,
      snapshot: await session.snapshot(),
      targetLabel: "in-process",
    });
    controller.start();

    const submitted = deferred();
    session.submit = vi.fn(async (text, options = {}) => {
      session.emit({
        type: "assistant_start",
        historyEntryId: "assistant-pending-command",
      });
      session.emit({
        type: "assistant_final",
        historyEntryId: "assistant-pending-command",
        message: createAssistantMessage(`session reply to ${text}`),
      });
      const result = await submitted.promise;
      const historyEntryId = options.historyEntryId ?? "generated-user";
      session.snapshotValue = createSnapshot([
        {
          id: historyEntryId,
          message: { role: "user", content: [{ type: "text", text }] },
        },
        {
          id: "assistant-pending-command",
          message: createAssistantMessage(`session reply to ${text}`),
        },
      ]);
      return result;
    });

    controller.getInputHandlers().onSubmit("hello session");
    await flush();

    expect(controller.isStreaming).toBe(false);
    expect(controller.submittedTurnInProgress).toBe(true);
    expect(controller.getInputHandlers().beforeSubmit?.("/risk:read-write")).toBe(false);

    controller.getInputHandlers().onSubmit("/risk:read-write");
    await flush();

    expect(session.setRiskLevel).not.toHaveBeenCalled();
    expect(session.submit).toHaveBeenCalledTimes(1);
    expect(view.systems).toContainEqual(
      expect.objectContaining({
        kind: "warn",
        text: "wait for tau to become idle before running commands",
      }),
    );

    submitted.resolve({
      userHistoryEntryId: "user-pending-command",
      turn: { aborted: false },
    });
    await flush();

    expect(session.submit).toHaveBeenCalledTimes(1);
  });

  it("retries the previous session turn on double empty submit without adding continue", async () => {
    const now = vi.spyOn(Date, "now");
    now.mockReturnValue(1_000);
    const session = new FakeSession(
      createSnapshot([
        {
          id: "history-1",
          message: {
            role: "user",
            content: [{ type: "text", text: "existing request" }],
          },
        },
      ]),
    );
    const view = new FakeView();
    const controller = new SessionChatController({
      view,
      session,
      snapshot: await session.snapshot(),
      targetLabel: "ssh host tau rpc",
    });
    controller.start();

    controller.getInputHandlers().onSubmit("");
    await flush();
    now.mockReturnValue(1_100);
    controller.getInputHandlers().onSubmit("");
    await flush();

    expect(session.retry).toHaveBeenCalledTimes(1);
    expect(session.submit).not.toHaveBeenCalled();
    expect(view.messages).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          model: { type: "user", text: "continue" },
        }),
      ]),
    );

    now.mockRestore();
  });

  it("hydrates an active assistant partial from the initial session snapshot", async () => {
    const finalAssistantMessage = createAssistantMessage("final reply");
    const baseSnapshot = createSnapshot([
      {
        id: "history-1",
        message: {
          role: "user",
          content: [{ type: "text", text: "persisted" }],
        },
      },
    ]);
    const session = new FakeSession(
      updateSnapshot(baseSnapshot, {
        lifecycle: "running",
        messages: [
          ...baseSnapshot.messages,
          {
            id: "assistant-active",
            state: "draft",
            modelVisible: false,
            message: {
              role: "assistant",
              timestamp: 1,
              content: [
                { type: "thinking", thinking: "checking context" },
                { type: "text", text: "partial reply" },
              ],
            },
          },
        ],
        timeline: [
          ...baseSnapshot.timeline,
          {
            type: "message",
            id: "timeline-assistant-active",
            messageId: "assistant-active",
          },
        ],
      }),
    );
    const view = new FakeView();
    const controller = new SessionChatController({
      view,
      session,
      snapshot: await session.snapshot(),
      targetLabel: "ssh host tau rpc",
      themeIds: ["gold"],
    });

    controller.start();

    expect(view.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "assistant-active",
          model: {
            type: "assistant_partial",
            text: "partial reply",
            thinking: "",
          },
        }),
      ]),
    );

    controller.getInputHandlers().onSubmit("queued after attach");
    await flush();

    expect(session.submit).not.toHaveBeenCalled();
    expect(view.systems).toContainEqual(
      expect.objectContaining({ kind: "success", text: "message queued" }),
    );

    session.snapshotValue = createSnapshot([
      {
        id: "history-1",
        message: {
          role: "user",
          content: [{ type: "text", text: "persisted" }],
        },
      },
      { id: "assistant-active", message: finalAssistantMessage },
    ]);
    session.emit({
      type: "assistant_final",
      historyEntryId: "assistant-active",
      message: finalAssistantMessage,
    });
    await flush();

    expect(session.submit).toHaveBeenCalledWith(
      "queued after attach",
      expect.objectContaining({
        historyEntryId: expect.stringMatching(/^session-user-/),
      }),
    );
  });

  it("applies assistant content append deltas without full snapshot reconciliation", async () => {
    const baseSnapshot = createSnapshot();
    const snapshot = updateSnapshot(baseSnapshot, {
      revision: 3,
      lifecycle: "running",
      messages: [
        ...baseSnapshot.messages,
        {
          id: "assistant-streaming",
          state: "draft",
          modelVisible: false,
          message: {
            role: "assistant",
            timestamp: 1,
            content: [{ type: "text", text: "hello" }],
          },
        },
      ],
      timeline: [
        ...baseSnapshot.timeline,
        {
          type: "message",
          id: "timeline-assistant-streaming",
          messageId: "assistant-streaming",
        },
      ],
    });
    const session = new FakeSession(snapshot);
    const snapshotSpy = vi.spyOn(session, "snapshot");
    const view = new FakeView();
    const controller = new SessionChatController({
      view,
      session,
      snapshot: await session.snapshot(),
      targetLabel: "local",
      themeIds: ["gold"],
    });

    controller.start();
    const snapshotCallsBefore = snapshotSpy.mock.calls.length;
    const appendDelta = {
      version: 1,
      type: "session.delta",
      sessionId: session.id,
      fromRevision: 3,
      toRevision: 4,
      reason: "assistant-stream",
      delta: {
        type: "snapshot.patch",
        changes: [
          {
            type: "message.content.append",
            messageId: "assistant-streaming",
            text: " world",
            timestamp: 2,
          },
        ],
      },
    };
    session.snapshotValue = applySessionProtocolDelta(session.snapshotValue, appendDelta);

    for (const listener of session.listeners) {
      listener(appendDelta);
    }

    expect(snapshotSpy).toHaveBeenCalledTimes(snapshotCallsBefore);
    expect(view.messages.find((message) => message.id === "assistant-streaming")).toEqual(
      expect.objectContaining({
        model: {
          type: "assistant_partial",
          text: "hello world",
          thinking: "",
        },
      }),
    );
  });

  it("replays deltas delivered while revision-gap recovery is pending", async () => {
    const baseSnapshot = createSnapshot();
    const gapMessage = {
      id: "gap-user",
      state: "committed",
      modelVisible: true,
      message: {
        role: "user",
        content: [{ type: "text", text: "included in recovery snapshot" }],
        timestamp: 1,
      },
    };
    const recoveredSnapshot = updateSnapshot(baseSnapshot, {
      revision: 3,
      historyEntries: [{ id: gapMessage.id, message: gapMessage.message }],
    });
    const postRecoveryMessage = {
      id: "post-recovery-user",
      state: "committed",
      modelVisible: true,
      message: {
        role: "user",
        content: [{ type: "text", text: "arrived after snapshot response" }],
        timestamp: 2,
      },
    };
    const session = new FakeSession(baseSnapshot);
    const gapDelta = createMessageAppendDelta(session.id, 2, gapMessage);
    const postRecoveryDelta = createMessageAppendDelta(session.id, 3, postRecoveryMessage);
    const view = new FakeView();
    const controller = new SessionChatController({
      view,
      session,
      snapshot: baseSnapshot,
      targetLabel: "local",
    });
    let emittedPostRecoveryDelta = false;
    vi.spyOn(session, "snapshot").mockImplementation(() =>
      Promise.resolve(recoveredSnapshot).then((snapshot) => {
        if (!emittedPostRecoveryDelta) {
          emittedPostRecoveryDelta = true;
          session.snapshotValue = applySessionProtocolDelta(snapshot, postRecoveryDelta);
          for (const listener of session.listeners) {
            listener(postRecoveryDelta);
          }
        }
        return snapshot;
      }),
    );

    controller.start();
    for (const listener of session.listeners) {
      listener(gapDelta);
    }
    await flush();

    expect(view.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "gap-user",
          model: expect.objectContaining({
            text: "included in recovery snapshot",
          }),
        }),
        expect.objectContaining({
          id: "post-recovery-user",
          model: expect.objectContaining({
            text: "arrived after snapshot response",
          }),
        }),
      ]),
    );
    expect(controller.snapshot.revision).toBe(4);
    await controller.dispose();
  });

  it("does not render content append deltas for messages hidden from the timeline", async () => {
    const baseSnapshot = createSnapshot();
    const snapshot = updateSnapshot(baseSnapshot, {
      revision: 3,
      lifecycle: "running",
      messages: [
        ...baseSnapshot.messages,
        {
          id: "assistant-hidden-streaming",
          state: "draft",
          modelVisible: true,
          message: {
            role: "assistant",
            timestamp: 1,
            content: [{ type: "text", text: "hidden" }],
          },
        },
      ],
      timeline: baseSnapshot.timeline,
    });
    const session = new FakeSession(snapshot);
    const view = new FakeView();
    const controller = new SessionChatController({
      view,
      session,
      snapshot: await session.snapshot(),
      targetLabel: "local",
    });

    controller.start();
    const appendDelta = {
      version: 1,
      type: "session.delta",
      sessionId: session.id,
      fromRevision: 3,
      toRevision: 4,
      reason: "assistant-stream",
      delta: {
        type: "snapshot.patch",
        changes: [
          {
            type: "message.content.append",
            messageId: "assistant-hidden-streaming",
            text: " but synced",
            timestamp: 2,
          },
        ],
      },
    };
    session.snapshotValue = applySessionProtocolDelta(session.snapshotValue, appendDelta);

    for (const listener of session.listeners) {
      listener(appendDelta);
    }

    expect(view.messages).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: "assistant-hidden-streaming" })]),
    );
    expect(
      controller.snapshot.messages.find((entry) => entry.id === "assistant-hidden-streaming")
        .message.content[0].text,
    ).toBe("hidden but synced");
    await controller.dispose();
  });

  it("renders running assistant state from draft snapshot messages", async () => {
    const baseSnapshot = createSnapshot();
    const snapshot = updateSnapshot(baseSnapshot, {
      lifecycle: "running",
      messages: [
        ...baseSnapshot.messages,
        {
          id: "assistant-draft",
          state: "draft",
          modelVisible: true,
          message: {
            role: "assistant",
            content: [{ type: "text", text: "visible draft" }],
            timestamp: 1,
          },
        },
      ],
      timeline: [
        {
          type: "message",
          id: "timeline-assistant-draft",
          messageId: "assistant-draft",
        },
      ],
    });
    const session = new FakeSession(snapshot);
    const view = new FakeView();
    const controller = new SessionChatController({
      view,
      session,
      snapshot: await session.snapshot(),
      targetLabel: "ssh host tau rpc",
    });

    controller.start();

    expect(view.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "assistant-draft",
          model: expect.objectContaining({
            text: "visible draft",
            type: "assistant_partial",
          }),
        }),
      ]),
    );

    await controller.dispose();
  });

  it("replays snapshot tool UI facets in assistant tool-call order", async () => {
    const assistantMessage = createAssistantToolCallMessage([
      {
        type: "toolCall",
        id: "tool-a",
        name: "bash",
        arguments: { command: "echo a" },
      },
      {
        type: "toolCall",
        id: "tool-b",
        name: "bash",
        arguments: { command: "echo b" },
      },
    ]);
    const snapshot = updateSnapshot(createSnapshot(), {
      messages: [
        ...createSnapshot().messages,
        {
          id: "assistant-tools",
          state: "committed",
          modelVisible: true,
          message: assistantMessage,
        },
      ],
      timeline: [
        {
          type: "message",
          id: "timeline-assistant-tools",
          messageId: "assistant-tools",
        },
      ],
      tools: {
        "tool-b": {
          id: "tool-b",
          toolCallId: "tool-b",
          toolName: "bash",
          call: { messageId: "assistant-tools", contentIndex: 1 },
          status: "queued",
          facetIds: ["tool-ui-tool-b"],
        },
        "tool-a": {
          id: "tool-a",
          toolCallId: "tool-a",
          toolName: "bash",
          call: { messageId: "assistant-tools", contentIndex: 0 },
          status: "queued",
          facetIds: ["tool-ui-tool-a"],
        },
      },
      facets: {
        "tool-ui-tool-b": {
          id: "tool-ui-tool-b",
          subject: { type: "tool", id: "tool-b" },
          kind: "tau.tool-ui-events",
          version: 1,
          data: {
            events: [
              {
                type: "tool_call_queued",
                toolCallId: "tool-b",
                toolName: "bash",
                headerTarget: "bash",
              },
            ],
          },
        },
        "tool-ui-tool-a": {
          id: "tool-ui-tool-a",
          subject: { type: "tool", id: "tool-a" },
          kind: "tau.tool-ui-events",
          version: 1,
          data: {
            events: [
              {
                type: "tool_call_queued",
                toolCallId: "tool-a",
                toolName: "bash",
                headerTarget: "bash",
              },
            ],
          },
        },
      },
    });
    const session = new FakeSession(snapshot);
    const view = new FakeView();
    const controller = new SessionChatController({
      view,
      session,
      snapshot: await session.snapshot(),
      targetLabel: "ssh host tau rpc",
    });

    controller.start();

    expect(view.toolEvents.map((event) => event.toolCallId)).toEqual(["tool-a", "tool-b"]);
    await controller.dispose();
  });

  it("does not render tool-result transcript messages when a matching tool UI facet exists", async () => {
    const baseSnapshot = createSnapshot();
    const assistantMessage = createAssistantToolCallMessage([
      {
        type: "toolCall",
        id: "tool-a",
        name: "bash",
        arguments: { command: "echo a" },
      },
    ]);
    const snapshot = updateSnapshot(baseSnapshot, {
      messages: [
        ...baseSnapshot.messages,
        {
          id: "assistant-tools",
          state: "committed",
          modelVisible: true,
          message: assistantMessage,
        },
        {
          id: "tool-a",
          state: "committed",
          modelVisible: true,
          message: {
            role: "toolResult",
            toolCallId: "tool-a",
            toolName: "bash",
            content: [{ type: "text", text: "a\n" }],
            isError: false,
            timestamp: 2,
          },
        },
      ],
      timeline: [
        {
          type: "message",
          id: "timeline-assistant-tools",
          messageId: "assistant-tools",
        },
        {
          type: "message",
          id: "timeline-tool-a",
          messageId: "tool-a",
        },
      ],
      tools: {
        "tool-a": {
          id: "tool-a",
          toolCallId: "tool-a",
          toolName: "bash",
          call: { messageId: "assistant-tools", contentIndex: 0 },
          status: "succeeded",
          resultMessageId: "tool-a",
          facetIds: ["tool-ui-tool-a"],
        },
      },
      facets: {
        "tool-ui-tool-a": {
          id: "tool-ui-tool-a",
          subject: { type: "tool", id: "tool-a" },
          kind: "tau.tool-ui-events",
          version: 1,
          data: {
            events: [
              {
                type: "tool_call_queued",
                toolCallId: "tool-a",
                toolName: "bash",
                headerTarget: "bash",
              },
              {
                type: "bash_execution",
                toolCallId: "tool-a",
                command: "echo a",
                headerTarget: "echo a",
                exitCode: 0,
                truncationInfo: {
                  output: "a\n",
                  model: {
                    content: "a\n",
                    truncated: false,
                    truncatedBy: null,
                    totalLines: 2,
                    totalBytes: 2,
                    outputLines: 2,
                    outputBytes: 2,
                    maxLines: 2,
                    maxTokens: 8192,
                  },
                  captureTruncated: false,
                },
                uiText: {
                  previewLines: [{ text: "a" }],
                  statusLine: "exit 0",
                  fullLines: [{ text: "a" }],
                },
              },
            ],
          },
        },
      },
    });
    const session = new FakeSession(snapshot);
    const view = new FakeView();
    const controller = new SessionChatController({
      view,
      session,
      snapshot: await session.snapshot(),
      targetLabel: "ssh host tau rpc",
    });

    controller.start();

    expect(view.messages.some((message) => message.id === "tool-a")).toBe(false);
    expect(view.toolEvents.map((event) => event.type)).toEqual([
      "tool_call_queued",
      "bash_execution",
    ]);
    await controller.dispose();
  });

  it("applies appended tool UI facet deltas without replaying all tool facets", async () => {
    const queuedEvent = {
      type: "tool_call_queued",
      toolCallId: "tool-a",
      toolName: "bash",
      headerTarget: "bash",
    };
    const startedEvent = {
      type: "bash_started",
      toolCallId: "tool-a",
      command: "echo a",
      headerTarget: "echo a",
    };
    const snapshot = updateSnapshot(createSnapshot(), {
      revision: 3,
      tools: {
        "tool-a": {
          id: "tool-a",
          toolCallId: "tool-a",
          toolName: "bash",
          call: { messageId: "assistant-tools", contentIndex: 0 },
          status: "queued",
          facetIds: ["tool-ui-tool-a"],
        },
      },
      facets: {
        "tool-ui-tool-a": {
          id: "tool-ui-tool-a",
          subject: { type: "tool", id: "tool-a" },
          kind: "tau.tool-ui-events",
          version: 1,
          data: { events: [queuedEvent] },
        },
      },
    });
    const session = new FakeSession(snapshot);
    const view = new FakeView();
    const controller = new SessionChatController({
      view,
      session,
      snapshot: await session.snapshot(),
      targetLabel: "ssh host tau rpc",
    });

    controller.start();
    const resetCount = view.resetToolUiSession.mock.calls.length;
    view.toolCost = 0.42;
    const delta = {
      version: 1,
      type: "session.delta",
      sessionId: session.id,
      fromRevision: 3,
      toRevision: 4,
      reason: "tool-run",
      delta: {
        type: "snapshot.patch",
        changes: [
          {
            type: "tool.set",
            tool: {
              id: "tool-a",
              toolCallId: "tool-a",
              toolName: "bash",
              call: { messageId: "assistant-tools", contentIndex: 0 },
              status: "running",
              facetIds: ["tool-ui-tool-a"],
            },
          },
          {
            type: "facet.set",
            facet: {
              id: "tool-ui-tool-a",
              subject: { type: "tool", id: "tool-a" },
              kind: "tau.tool-ui-events",
              version: 1,
              data: { events: [queuedEvent, startedEvent] },
            },
          },
        ],
      },
    };
    session.snapshotValue = applySessionProtocolDelta(session.snapshotValue, delta);

    for (const listener of session.listeners) {
      listener(delta);
    }

    expect(view.resetToolUiSession).toHaveBeenCalledTimes(resetCount);
    expect(view.toolEvents).toEqual([queuedEvent, startedEvent]);
    expect(view.status.footer.sessionCost).toBe("$0.42");
    expect(controller.snapshot.tools["tool-a"].status).toBe("running");
    await controller.dispose();
  });

  it("reconstructs subagent progress from snapshot agent state", async () => {
    const agent = createAgentRun({ progress: "reading files" });
    const session = new FakeSession(
      updateSnapshot(createSnapshot(), {
        agents: {
          [agent.id]: agent,
        },
      }),
    );
    const view = new FakeView();
    const controller = new SessionChatController({
      view,
      session,
      snapshot: await session.snapshot(),
      targetLabel: "ssh host tau rpc",
    });

    controller.start();

    expect(view.subagentEvents).toEqual([
      expect.objectContaining({
        type: "subagent_spawned",
        state: expect.objectContaining({ id: "agent-1", status: "running" }),
      }),
      expect.objectContaining({
        type: "subagent_progress",
        id: "agent-1",
        text: "reading files",
      }),
    ]);
    await controller.dispose();
  });

  it("reconstructs finished subagents from snapshot agent state", async () => {
    const agent = createAgentRun({
      status: "succeeded",
      progress: "finished checks",
      finalText: "all clear",
      finishedAt: 2,
    });
    const session = new FakeSession(
      updateSnapshot(createSnapshot(), {
        agents: {
          [agent.id]: agent,
        },
      }),
    );
    const view = new FakeView();
    const controller = new SessionChatController({
      view,
      session,
      snapshot: await session.snapshot(),
      targetLabel: "ssh host tau rpc",
    });

    controller.start();

    expect(view.subagentEvents).toEqual([
      expect.objectContaining({
        type: "subagent_spawned",
        state: expect.objectContaining({ id: "agent-1", status: "success" }),
      }),
      expect.objectContaining({
        type: "subagent_progress",
        id: "agent-1",
        text: "finished checks",
      }),
      expect.objectContaining({
        type: "subagent_finished",
        state: expect.objectContaining({
          id: "agent-1",
          status: "success",
          finalText: "all clear",
        }),
      }),
    ]);
    await controller.dispose();
  });

  it("applies agent progress deltas without replaying tool UI state", async () => {
    const initialAgent = createAgentRun({ progress: "reading files" });
    const nextAgent = createAgentRun({
      progress: "checking protocol",
      costTotal: 0.02,
      turns: 2,
      usage: {
        ...initialAgent.usage,
        output: 15,
        contextWindowUsageTokens: 25,
      },
    });
    const session = new FakeSession(
      updateSnapshot(createSnapshot(), {
        revision: 3,
        agents: {
          [initialAgent.id]: initialAgent,
        },
      }),
    );
    const view = new FakeView();
    const controller = new SessionChatController({
      view,
      session,
      snapshot: await session.snapshot(),
      targetLabel: "ssh host tau rpc",
    });

    controller.start();
    const resetCount = view.resetToolUiSession.mock.calls.length;
    view.subagentEvents.splice(0);
    const delta = {
      version: 1,
      type: "session.delta",
      sessionId: session.id,
      fromRevision: 3,
      toRevision: 4,
      reason: "agent-run",
      delta: {
        type: "snapshot.patch",
        changes: [{ type: "agent.set", agent: nextAgent }],
      },
    };
    session.snapshotValue = applySessionProtocolDelta(session.snapshotValue, delta);

    for (const listener of session.listeners) {
      listener(delta);
    }

    expect(view.resetToolUiSession).toHaveBeenCalledTimes(resetCount);
    expect(view.subagentEvents).toEqual([
      expect.objectContaining({
        type: "subagent_progress",
        id: "agent-1",
        text: "checking protocol",
        costTotal: 0.02,
        turns: 2,
      }),
    ]);
    expect(controller.snapshot.agents["agent-1"].progress).toBe("checking protocol");
    await controller.dispose();
  });

  it("removes an optimistic user message when session submit fails before commit", async () => {
    const session = new FakeSession();
    session.rejectSubmit = true;
    const view = new FakeView();
    const controller = new SessionChatController({
      view,
      session,
      snapshot: await session.snapshot(),
      targetLabel: "ssh host tau rpc",
    });
    controller.start();

    controller.getInputHandlers().onSubmit("hello session");
    await flush();

    const userEntryId = session.submit.mock.calls[0][1].historyEntryId;
    expect(view.removed).toContain(userEntryId);
    expect(view.messages).not.toEqual(
      expect.arrayContaining([expect.objectContaining({ id: userEntryId })]),
    );
  });

  it("runs direct shell commands in the session execution environment", async () => {
    const session = new FakeSession();
    const view = new FakeView();
    const controller = new SessionChatController({
      view,
      session,
      snapshot: await session.snapshot(),
      targetLabel: "ssh host tau rpc",
    });
    controller.start();

    controller.getInputHandlers().onSubmit("!pwd");
    await flush();

    expect(session.exec).toHaveBeenCalledWith("pwd", {
      cwd: "/session/repo",
      timeoutMs: 60000,
    });
    expect(session.record).toHaveBeenCalledWith(
      expect.stringContaining("Bash command output:"),
      expect.objectContaining({
        historyEntryId: expect.stringMatching(/^bash-user-/),
      }),
    );
    expect(session.submit).not.toHaveBeenCalled();
    expect(view.toolEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "bash_started", command: "pwd" }),
        expect.objectContaining({
          type: "bash_execution",
          command: "pwd",
          labelOverride: "you ran",
        }),
      ]),
    );
    expect(view.messages).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "bash-history-1",
          model: expect.objectContaining({ type: "user" }),
        }),
      ]),
    );
  });

  it("runs incognito direct shell commands without adding session context", async () => {
    const session = new FakeSession();
    const view = new FakeView();
    const controller = new SessionChatController({
      view,
      session,
      snapshot: await session.snapshot(),
      targetLabel: "ssh host tau rpc",
    });
    controller.start();

    controller.getInputHandlers().onSubmit("!!pwd");
    await flush();

    expect(session.exec).toHaveBeenCalledWith("pwd", {
      cwd: "/session/repo",
      timeoutMs: 60000,
    });
    expect(session.record).not.toHaveBeenCalled();
    expect(view.toolEvents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "bash_execution",
          command: "pwd",
          labelOverride: "incognito",
        }),
      ]),
    );
  });

  it("routes session maintenance commands through the session protocol", async () => {
    const session = new FakeSession(
      createSnapshot([
        {
          id: "history-1",
          message: {
            role: "user",
            content: [{ type: "text", text: "persisted" }],
          },
        },
      ]),
    );
    const view = new FakeView();
    const controller = new SessionChatController({
      view,
      session,
      snapshot: await session.snapshot(),
      targetLabel: "ssh host tau rpc",
    });
    controller.start();

    controller.getInputHandlers().onSubmit("/risk:read-write");
    await flush();

    controller.getInputHandlers().onSubmit("/compact:summary-and-last preserve decisions");
    await flush();

    controller.getInputHandlers().onSubmit("/prune:smart 0.5 keep errors");
    await flush();

    expect(session.setRiskLevel).toHaveBeenCalledWith("read-write");
    expect(session.compact).toHaveBeenCalledWith("summary-and-last", {
      guidance: "preserve decisions",
    });
    expect(session.pruneToolResults).toHaveBeenCalledWith("smart", {
      fraction: 0.5,
      guidance: "keep errors",
    });
    expect(session.submit).not.toHaveBeenCalled();
    expect(view.status.footer.riskLevel).toBe("read-write");
    expect(view.messages).toContainEqual({
      id: "summary-entry",
      model: { type: "user", text: "compacted summary: preserve decisions" },
    });
    expect(view.systems).toContainEqual(
      expect.objectContaining({
        kind: "success",
        text: "session compacted. previous context and last assistant message have been included.",
      }),
    );
    expect(view.systems).toContainEqual(
      expect.objectContaining({
        kind: "success",
        text: "risk level set to read-write (all tools)",
      }),
    );
    expect(view.systems).toContainEqual(
      expect.objectContaining({ kind: "success", text: "pruned smart at 0.5" }),
    );
  });

  it("uses the shared slash command parser for session command dispatch", async () => {
    const session = new FakeSession();
    const view = new FakeView();
    const controller = new SessionChatController({
      view,
      session,
      snapshot: await session.snapshot(),
      targetLabel: "ssh host tau rpc",
    });
    controller.start();

    controller.getInputHandlers().onSubmit("/risk:read-write trailing words");
    await flush();

    controller.getInputHandlers().onSubmit("/reload ignored");
    await flush();

    controller.getInputHandlers().onSubmit("/help extra");
    await flush();

    expect(session.setRiskLevel).toHaveBeenCalledWith("read-write");
    expect(session.reload).toHaveBeenCalledTimes(1);
    expect(session.submit).not.toHaveBeenCalled();
    expect(view.systems.some((message) => message.text.includes("commands:"))).toBe(true);
  });

  it("tracks session editor input modes and command hints while typing", async () => {
    const session = new FakeSession();
    const view = new FakeView();
    const controller = new SessionChatController({
      view,
      session,
      snapshot: await session.snapshot(),
      targetLabel: "ssh host tau rpc",
    });
    controller.start();
    const handlers = controller.getInputHandlers();

    handlers.onChange("! pwd");
    expect(view.status.editor.mode).toBe("bash");

    handlers.onChange("!! pwd");
    expect(view.status.editor.mode).toBe("bash_incognito");

    handlers.onChange("# remember this");
    expect(view.status.editor.mode).toBe("memory");

    handlers.onChange("/reload");
    expect(view.status.editor.mode).toBe("normal");
    expect(view.status.footer.commandHint).toContain("reload prompts");
  });

  it("switches session personas through the session protocol", async () => {
    const session = new FakeSession();
    const view = new FakeView();
    const controller = new SessionChatController({
      view,
      session,
      snapshot: await session.snapshot(),
      targetLabel: "ssh host tau rpc",
    });
    controller.start();

    controller.getInputHandlers().onSubmit("/persona:persona-2");
    await flush();

    expect(session.setPersona).toHaveBeenCalledWith("persona-2");
    expect(view.status.editor.personaName).toBe("Persona 2");
    expect(view.systems).toContainEqual(
      expect.objectContaining({
        kind: "success",
        text: "switched to Persona 2 (gpt-5.5)",
      }),
    );
  });

  it("cycles session personas with ctrl+p", async () => {
    const session = new FakeSession();
    const view = new FakeView();
    const controller = new SessionChatController({
      view,
      session,
      snapshot: await session.snapshot(),
      targetLabel: "ssh host tau rpc",
    });
    controller.start();

    controller.getInputHandlers().onCtrlP();
    await flush();

    expect(session.setPersona).toHaveBeenCalledWith("persona-2");
    expect(view.status.editor.personaName).toBe("Persona 2");
  });

  it("cycles session reasoning with shift+tab", async () => {
    const session = new FakeSession();
    const view = new FakeView();
    const controller = new SessionChatController({
      view,
      session,
      snapshot: await session.snapshot(),
      targetLabel: "ssh host tau rpc",
    });
    controller.start();

    controller.getInputHandlers().onShiftTab();
    await flush();

    expect(session.setReasoning).toHaveBeenCalledWith("minimal");
    expect(view.status.editor.reasoningLabel).toBe("minimal");
    expect(view.status.editor.reasoning).toBe("minimal");
  });

  it("does not change session reasoning while a turn is running", async () => {
    const session = new FakeSession();
    const view = new FakeView();
    const controller = new SessionChatController({
      view,
      session,
      snapshot: await session.snapshot(),
      targetLabel: "ssh host tau rpc",
    });
    controller.start();

    controller.isStreaming = true;
    controller.getInputHandlers().onShiftTab();
    await flush();

    expect(session.setReasoning).not.toHaveBeenCalled();
    expect(view.systems).toContainEqual({
      text: "cannot change reasoning while a session turn is running",
      kind: "warn",
      options: undefined,
    });
  });

  it("inserts session prompt templates locally in the editor", async () => {
    const session = new FakeSession();
    const view = new FakeView();
    const controller = new SessionChatController({
      view,
      session,
      snapshot: await session.snapshot(),
      targetLabel: "ssh host tau rpc",
    });
    controller.start();

    controller.getInputHandlers().onSubmit("/prompt:fix");
    await flush();

    expect(session.resolvePrompt).toHaveBeenCalledWith("fix");
    expect(view.editorText).toBe("fix the bug");
    expect(session.submit).not.toHaveBeenCalled();
  });

  it("reloads session content through the session protocol", async () => {
    const session = new FakeSession();
    const view = new FakeView();
    const controller = new SessionChatController({
      view,
      session,
      snapshot: await session.snapshot(),
      targetLabel: "ssh host tau rpc",
    });
    controller.start();

    controller.getInputHandlers().onSubmit("/reload");
    await flush();

    expect(session.reload).toHaveBeenCalledTimes(1);
    expect(view.systems).toContainEqual(
      expect.objectContaining({ kind: "warn", text: "reload warning" }),
    );
    expect(view.systems).toContainEqual(
      expect.objectContaining({
        kind: "success",
        text: "reloaded: 2 personas, 2 prompts, 1 skills.",
      }),
    );

    controller.getInputHandlers().onSubmit("/prompt:reloaded");
    await flush();

    expect(session.resolvePrompt).toHaveBeenCalledWith("reloaded");
    expect(view.editorText).toBe("reloaded prompt");
  });

  it("stashes session editor input to the local clipboard with ctrl+s", async () => {
    const session = new FakeSession();
    const view = new FakeView();
    view.editorText = "[paste #1 +12 lines]";
    view.getExpandedEditorText = () => "line 1\nline 2";
    const controller = new SessionChatController({
      view,
      session,
      snapshot: await session.snapshot(),
      targetLabel: "ssh host tau rpc",
    });
    controller.start();

    controller.getInputHandlers().onCtrlS();
    await flush();

    expect(copyTextToClipboard).toHaveBeenCalledWith("line 1\nline 2");
    expect(view.editorText).toBe("");
    expect(view.systems).toContainEqual({
      text: "stashed input to clipboard",
      kind: "success",
      options: undefined,
    });
  });

  it("warns when stashing empty session editor input", async () => {
    const session = new FakeSession();
    const view = new FakeView();
    view.editorText = "   ";
    const controller = new SessionChatController({
      view,
      session,
      snapshot: await session.snapshot(),
      targetLabel: "ssh host tau rpc",
    });
    controller.start();

    controller.getInputHandlers().onCtrlS();
    await flush();

    expect(view.systems).toContainEqual({
      text: "no input to stash yet",
      kind: "warn",
      options: undefined,
    });
  });

  it("cycles session subagent selection with alt+down", async () => {
    const session = new FakeSession();
    const view = new FakeView();
    const controller = new SessionChatController({
      view,
      session,
      snapshot: await session.snapshot(),
      targetLabel: "ssh host tau rpc",
    });
    controller.start();

    controller.getInputHandlers().onAltDown();

    expect(view.subagentSelectionCycles).toEqual([1]);
    expect(view.renderRequests).toBeGreaterThan(0);
  });

  it("terminates the selected session subagent with ctrl+g", async () => {
    const session = new FakeSession();
    const view = new FakeView();
    view.selectedSubagentId = "subagent-1";
    const controller = new SessionChatController({
      view,
      session,
      snapshot: await session.snapshot(),
      targetLabel: "ssh host tau rpc",
    });
    controller.start();

    controller.getInputHandlers().onCtrlG();
    await flush();

    expect(session.terminateSubagent).toHaveBeenCalledWith("subagent-1");
    expect(view.systems).not.toContainEqual(
      expect.objectContaining({
        text: expect.stringContaining("unknown subagent id"),
      }),
    );
  });

  it("warns when ctrl+g has no selected session subagent", async () => {
    const session = new FakeSession();
    const view = new FakeView();
    const controller = new SessionChatController({
      view,
      session,
      snapshot: await session.snapshot(),
      targetLabel: "ssh host tau rpc",
    });
    controller.start();

    controller.getInputHandlers().onCtrlG();
    await flush();

    expect(session.terminateSubagent).not.toHaveBeenCalled();
    expect(view.systems).toContainEqual({
      text: "no active subagent selected",
      kind: "warn",
      options: undefined,
    });
  });

  it("warns when ctrl+g targets an unknown session subagent", async () => {
    const session = new FakeSession();
    const view = new FakeView();
    view.selectedSubagentId = "missing-subagent";
    const controller = new SessionChatController({
      view,
      session,
      snapshot: await session.snapshot(),
      targetLabel: "ssh host tau rpc",
    });
    controller.start();

    controller.getInputHandlers().onCtrlG();
    await flush();

    expect(session.terminateSubagent).toHaveBeenCalledWith("missing-subagent");
    expect(view.systems).toContainEqual({
      text: "unknown subagent id: missing-subagent",
      kind: "warn",
      options: undefined,
    });
  });

  it("submits session memory-mode requests with update instructions", async () => {
    const session = new FakeSession();
    const view = new FakeView();
    const controller = new SessionChatController({
      view,
      session,
      snapshot: await session.snapshot(),
      targetLabel: "ssh host tau rpc",
    });
    controller.start();

    controller.getInputHandlers().onSubmit("# remember to run npm test");
    await flush();

    const submittedText = session.submit.mock.calls[0][0];
    expect(submittedText).toContain("Memory mode: update the project guidelines file at:");
    expect(submittedText).toContain("/session/repo/AGENTS.md");
    expect(submittedText).toContain("remember to run npm test");
    const userEntryId = session.submit.mock.calls[0][1].historyEntryId;
    const renderedUser = view.messages.find((message) => message.id === userEntryId);
    expect(renderedUser).toEqual(
      expect.objectContaining({
        model: expect.objectContaining({
          type: "user",
          text: expect.stringContaining("remember to run npm test"),
        }),
      }),
    );
  });

  it("warns on empty session memory-mode requests", async () => {
    const session = new FakeSession();
    const view = new FakeView();
    const controller = new SessionChatController({
      view,
      session,
      snapshot: await session.snapshot(),
      targetLabel: "ssh host tau rpc",
    });
    controller.start();

    controller.getInputHandlers().onSubmit("#   ");
    await flush();

    expect(view.systems).toContainEqual({
      text: "memory mode request was empty.",
      kind: "warn",
      options: undefined,
    });
    expect(session.submit).not.toHaveBeenCalled();
  });

  it("runs /diff locally while delegating review work through the session protocol", async () => {
    const session = new FakeSession();
    const view = new FakeView();
    const controller = new SessionChatController({
      view,
      session,
      snapshot: await session.snapshot(),
      targetLabel: "ssh host tau rpc",
      defaultDiffTool: { command: "inline-diff-tool" },
      diffToolLauncher: launchInlineDiffTool,
    });
    controller.start();

    await controller.onUserInput("/diff -- src/main.ts");
    await waitUntil(() => session.createEphemeralContext.mock.calls.length > 0);
    await waitUntil(() => session.record.mock.calls.length > 0);

    expect(session.submit).not.toHaveBeenCalled();
    expect(session.exec).toHaveBeenCalledWith(expect.stringContaining("diff"), expect.any(Object));
    expect(session.createEphemeralContext).toHaveBeenCalledWith({
      instructions: expect.stringContaining("src/main.ts"),
      tools: ["bash", "view_image"],
      riskLevel: "read-only",
    });
    expect(session.submitEphemeralThread).toHaveBeenCalledWith({
      contextId: "ephemeral-1",
      threadId: expect.any(String),
      message: "explain this diff",
    });
    expect(session.closeEphemeralContext).toHaveBeenCalledWith("ephemeral-1");
    expect(session.record.mock.calls[0][0]).toContain("returned review from local diff tool");
    expect(session.operationLog.slice(-2)).toEqual(["close-ephemeral", "record"]);
    expect(view.systems).toContainEqual(
      expect.objectContaining({
        kind: "success",
        text: "diff review added to the conversation. tau did not run yet.",
      }),
    );
  });

  it("routes /listen as a client-side command in session attach", async () => {
    const spawn = vi.fn();
    const session = new FakeSession();
    const view = new FakeView();
    const controller = new SessionChatController({
      view,
      session,
      snapshot: await session.snapshot(),
      targetLabel: "ssh host tau rpc",
      deps: createMockDeps(spawn, "linux"),
      config: { apiKeys: { mistral: "mistral-key" } },
    });
    controller.start();

    controller.getInputHandlers().onSubmit("/listen");
    await flush();

    expect(spawn).not.toHaveBeenCalled();
    expect(view.systems).toContainEqual({
      text: "/listen is currently supported only on macOS.",
      kind: "warn",
      options: undefined,
    });
    expect(view.systems).not.toContainEqual(
      expect.objectContaining({
        text: expect.stringContaining("not supported in protocol attach mode"),
      }),
    );
    expect(session.submit).not.toHaveBeenCalled();
  });

  it("records local microphone input and transcribes it into the session editor", async () => {
    const mktempPath = join(tmpdir(), `tau-session-listen-test-${Date.now()}.wav`);
    const spawn = vi.fn(async (cmd, _args, options = {}) => {
      if (cmd === "mktemp") {
        return {
          stdout: `${mktempPath}\n`,
          stderr: "",
          output: undefined,
          exitCode: 0,
          captureLimitExceeded: false,
          timedOut: false,
          aborted: false,
          closeSignal: null,
        };
      }

      if (cmd === "ffmpeg") {
        return await new Promise((resolve) => {
          options.signal.addEventListener("abort", () => {
            resolve({
              stdout: "",
              stderr: "",
              output: undefined,
              exitCode: 0,
              captureLimitExceeded: false,
              timedOut: false,
              aborted: true,
              closeSignal: null,
            });
          });
        });
      }

      throw new Error(`unexpected command: ${cmd}`);
    });
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ text: "session transcript" })),
    );
    vi.stubGlobal("fetch", fetchMock);

    const session = new FakeSession();
    const view = new FakeView();
    const controller = new SessionChatController({
      view,
      session,
      snapshot: await session.snapshot(),
      targetLabel: "ssh host tau rpc",
      deps: createMockDeps(spawn),
      config: { apiKeys: { mistral: "mistral-key" } },
    });

    try {
      controller.start();
      controller.getInputHandlers().onSubmit("/listen");
      await flush();

      expect(view.status.editor.mode).toBe("recording");
      expect(view.editorEnabledUpdates).toContain(false);
      await writeFile(mktempPath, Buffer.alloc(2048, 1));

      controller.getInputHandlers().onCtrlY();
      for (let i = 0; i < 50 && view.editorText !== "session transcript"; i += 1) {
        await flush();
        await waitMs(1);
      }
    } finally {
      vi.unstubAllGlobals();
      await rm(mktempPath, { force: true });
    }

    expect(view.editorEnabledUpdates).toContain(true);
    expect(view.editorText).toBe("session transcript");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(spawn).toHaveBeenNthCalledWith(1, "mktemp", ["/tmp/tau-listen.XXXXXX"]);
    expect(spawn).toHaveBeenNthCalledWith(
      2,
      "ffmpeg",
      expect.arrayContaining(["-f", "avfoundation", "-i", ":0"]),
      expect.objectContaining({
        detached: true,
        killProcessGroup: true,
        stdio: ["ignore", "ignore", "ignore"],
      }),
    );
    expect(session.submit).not.toHaveBeenCalled();
  });

  it("routes /speak as a client-side command in session attach", async () => {
    const session = new FakeSession();
    const view = new FakeView();
    const controller = new SessionChatController({
      view,
      session,
      snapshot: await session.snapshot(),
      targetLabel: "ssh host tau rpc",
      deps: createMockDeps(),
    });
    controller.start();

    controller.getInputHandlers().onSubmit("/speak");
    await flush();

    expect(view.systems).toContainEqual({
      text: "no assistant message to speak yet.",
      kind: "warn",
      options: undefined,
    });
    expect(view.systems).not.toContainEqual(
      expect.objectContaining({
        text: expect.stringContaining("not supported in protocol attach mode"),
      }),
    );
    expect(session.submit).not.toHaveBeenCalled();
  });

  it("speaks the last session assistant message using local playback", async () => {
    const mktempPath = join(tmpdir(), `tau-session-speak-test-${Date.now()}.wav`);
    const spawn = vi.fn(async (cmd) => {
      if (cmd === "mktemp") {
        return {
          stdout: `${mktempPath}\n`,
          stderr: "",
          output: undefined,
          exitCode: 0,
          captureLimitExceeded: false,
          timedOut: false,
          aborted: false,
          closeSignal: null,
        };
      }

      return {
        stdout: "",
        stderr: "",
        output: undefined,
        exitCode: 0,
        captureLimitExceeded: false,
        timedOut: false,
        aborted: false,
        closeSignal: null,
      };
    });
    const session = new FakeSession(
      createSnapshot([
        {
          id: "assistant-history-1",
          message: {
            role: "assistant",
            provider: "openai",
            model: "gpt-5.5",
            stopReason: "stop",
            content: [{ type: "text", text: "Use src/app.ts:42 for the fix." }],
          },
        },
      ]),
    );
    const view = new FakeView();
    const controller = new SessionChatController({
      view,
      session,
      snapshot: await session.snapshot(),
      targetLabel: "ssh host tau rpc",
      deps: createMockDeps(spawn),
      config: { apiKeys: { google: "gemini-key" } },
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [
                    {
                      text: "Use src slash app dot t s, line 42, for the fix.",
                    },
                  ],
                },
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [
                    {
                      inlineData: {
                        data: Buffer.from([1, 2, 3, 4]).toString("base64"),
                      },
                    },
                  ],
                },
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    try {
      controller.start();
      await controller.speakLastAssistantMessage();
    } finally {
      vi.unstubAllGlobals();
      await rm(mktempPath, { force: true });
    }

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const speechHints = view.statusUpdates
      .map((status) => status.footer.commandHint)
      .filter((hint) => hint !== undefined);
    expect(speechHints).toEqual(
      expect.arrayContaining([
        "rewriting for speech...",
        "generating speech chunks (0 out of 1 ready)...",
        "generating speech chunks (1 out of 1 ready)...",
        "playing speech (0/1 played, 1/1 ready)...",
      ]),
    );
    expect(view.status.footer.commandHint).toBeUndefined();
    expect(spawn).toHaveBeenNthCalledWith(1, "mktemp", ["/tmp/tau-speak.XXXXXX"]);
    expect(spawn).toHaveBeenNthCalledWith(
      2,
      "afplay",
      ["-r", "1.4", mktempPath],
      expect.objectContaining({
        detached: true,
        killProcessGroup: true,
        stdio: ["ignore", "ignore", "ignore"],
      }),
    );
    expect(session.submit).not.toHaveBeenCalled();
  });

  it("exposes session catalog data for autocomplete", async () => {
    const session = new FakeSession();
    const view = new FakeView();
    const controller = new SessionChatController({
      view,
      session,
      snapshot: await session.snapshot(),
      targetLabel: "ssh host tau rpc",
      themeIds: ["gold"],
    });

    const sources = controller.getAutocompleteSources();

    expect(sources.personas()).toEqual([
      { id: "persona-1", label: "Persona 1" },
      { id: "persona-2", label: "Persona 2" },
    ]);
    expect(sources.prompts()).toEqual([{ id: "fix", label: "Fix" }]);
    expect(sources.themes()).toEqual([{ id: "gold" }]);
    await expect(sources.autocompletePaths("main", 25)).resolves.toEqual(["src/main.ts"]);
    expect(session.autocompletePaths).toHaveBeenCalledWith({
      query: "main",
      limit: 25,
    });
    expect(sources.skills()).toEqual(["alpha"]);
  });

  it("creates a new session and keeps previous transcript above the divider", async () => {
    const session = new FakeSession(
      createSnapshot([
        {
          id: "history-1",
          message: {
            role: "user",
            content: [{ type: "text", text: "persisted" }],
          },
        },
      ]),
    );
    const nextSession = new FakeSession(createSnapshot([], "read-write"));
    nextSession.id = "session-2";
    nextSession.snapshotValue = {
      ...nextSession.snapshotValue,
      sessionId: "session-2",
    };
    const createSession = vi.fn(async () => nextSession);
    const view = new FakeView();
    const controller = new SessionChatController({
      view,
      session,
      snapshot: await session.snapshot(),
      createSession,
      targetLabel: "ssh host tau rpc",
    });
    controller.start();
    const resetCountBeforeNew = view.resetToolUiSession.mock.calls.length;
    const messageCountBeforeNew = view.messages.length;

    controller.getInputHandlers().onSubmit("/new");
    await flush();

    expect(createSession).toHaveBeenCalledWith({
      executionEnvironment: { kind: "local", cwd: "/session/repo" },
      personaId: "persona-1",
      riskLevel: "read-only",
      reasoning: "none",
    });
    expect(session.unobserve).toHaveBeenCalledTimes(1);
    expect(view.removed).not.toContain("history-1");
    expect(view.messages).toContainEqual({
      id: "history-1",
      model: { type: "user", text: "persisted" },
    });
    expect(view.resetToolUiSession.mock.calls.length).toBeGreaterThan(resetCountBeforeNew);
    expect(view.systems).not.toContainEqual(
      expect.objectContaining({ text: "created new session" }),
    );
    expect(view.messages.length).toBeGreaterThan(messageCountBeforeNew);
    expect(view.messages).toContainEqual(
      expect.objectContaining({
        model: { type: "session_divider", label: "new session" },
      }),
    );
    expect(view.systems).toContainEqual(
      expect.objectContaining({ text: "session id: session-2", kind: "muted" }),
    );
  });

  it("rewinds session history from the selected user message", async () => {
    const session = new FakeSession(
      createSnapshot([
        {
          id: "history-1",
          message: {
            role: "user",
            content: [{ type: "text", text: "first message" }],
          },
        },
        {
          id: "assistant-1",
          message: {
            role: "assistant",
            provider: "openai",
            model: "gpt-5.5",
            stopReason: "stop",
            content: [{ type: "text", text: "first reply" }],
          },
        },
        {
          id: "history-2",
          message: {
            role: "user",
            content: [{ type: "text", text: "second message" }],
          },
        },
        {
          id: "history-3",
          message: {
            role: "user",
            content: [{ type: "text", text: "third message" }],
          },
        },
      ]),
    );
    const view = new FakeView();
    const controller = new SessionChatController({
      view,
      session,
      snapshot: await session.snapshot(),
      targetLabel: "ssh host tau rpc",
    });
    controller.start();

    controller.getInputHandlers().onSubmit("/rewind");
    await flush();

    expect(view.rewindPickerShows).toHaveLength(1);
    expect(view.rewindPickerShows[0].items.map((item) => item.label)).toEqual([
      "first message",
      "second message",
      "third message",
    ]);

    view.rewindPickerShows[0].onSelect("history-2");
    await flush();

    expect(session.rewindToHistoryEntryId).toHaveBeenCalledWith("history-2");
    expect(view.rewindPickerHideCount).toBe(1);
    expect(view.removeMessagesFromCalls).toEqual(["history-2"]);
    expect(view.removed).toEqual(expect.arrayContaining(["history-2", "history-3"]));
    expect(view.editorText).toBe("second message");
  });

  it("warns when there are no session user messages to rewind", async () => {
    const session = new FakeSession();
    const view = new FakeView();
    const controller = new SessionChatController({
      view,
      session,
      snapshot: await session.snapshot(),
      targetLabel: "ssh host tau rpc",
    });
    controller.start();

    controller.getInputHandlers().onSubmit("/rewind");
    await flush();

    expect(view.rewindPickerShows).toHaveLength(0);
    expect(view.systems).toContainEqual({
      text: "no user messages available to rewind.",
      kind: "warn",
      options: undefined,
    });
  });
});
