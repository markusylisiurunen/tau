import { existsSync } from "node:fs";
import { rm, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { buildAutoCompactionContinuationMessage } from "../dist/core/session/compaction.js";
import { buildToolRunPresentation } from "../dist/core/tools/presentation.js";
import {
  hasAutoCompactionContinuationMetadata,
  prependTauUserMetadata,
  stripTauUserDisplayText,
} from "../dist/core/utils/user_metadata.js";
import {
  applySessionProtocolDelta,
  SESSION_PROTOCOL_VERSION,
} from "../dist/protocol/session_protocol.js";
import { TauSessionProtocolResponseError } from "../dist/transport/errors.js";
import { formatDiffReviewUserMessage } from "../dist/tui/chat_controller/diff_review_user_message.js";
import { copyTextToClipboard } from "../dist/tui/clipboard.js";
import { createTuiClientTools, SessionChatApp } from "../dist/tui/session_chat_app.js";
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

function createSnapshot(historyEntries = []) {
  return createProtocolSnapshot({
    sessionId: "session-1",
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
  return createProtocolSnapshot({
    sessionId: snapshot.sessionId,
    revision: overrides.revision ?? snapshot.revision,
    lifecycle: overrides.lifecycle ?? snapshot.lifecycle,
    goal: "goal" in overrides ? overrides.goal : snapshot.goal,
    costTotal: overrides.costTotal ?? snapshot.costTotal,
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
    stopReason: "toolUse",
    content: toolCalls,
  };
}

function createAgentRun({ status = "running", finalText = "", finishedAt = 2, ...overrides } = {}) {
  return {
    id: "agent-1",
    name: "default",
    title: "Inspect state",
    availability: status === "running" ? "running" : "idle",
    model: { provider: "anthropic", id: "claude-opus-4-8", reasoning: "medium" },
    workingDirectory: "/repo",
    createdAt: 1,
    run:
      status === "running"
        ? {
            revision: 1,
            status,
            startedAt: 1,
            interruptRequested: false,
          }
        : {
            revision: 1,
            status,
            startedAt: 1,
            finishedAt,
            interruptRequested: false,
            response: finalText,
          },
    costTotal: 0.01,
    usage: {
      input: 10,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
      contextWindowUsageTokens: 15,
      contextWindow: 200000,
    },
    ...overrides,
  };
}

function createMessageAppendDelta(sessionId, fromRevision, message, state = "committed") {
  return {
    version: SESSION_PROTOCOL_VERSION,
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
    version: SESSION_PROTOCOL_VERSION,
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
    version: SESSION_PROTOCOL_VERSION,
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
  pendingUserMessagesListeners = new Set();
  pendingUserMessagesValue = { revision: 1, messages: [] };
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
    return {
      userHistoryEntryId: historyEntryId,
      turn: { status: "completed", stopReason: "stop" },
    };
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
    return { turn: { status: "completed", stopReason: "stop" } };
  });
  exec = vi.fn(async (command, options = {}) => {
    const invocation = [command, ...(options.args ?? [])].join(" ");
    let output = "";
    if (invocation.includes("rev-parse") && invocation.includes("--show-toplevel")) {
      output = "/repo\n";
    } else if (invocation.includes("diff") && invocation.includes("--name-status")) {
      output = "M\0src/main.ts\0";
    } else if (invocation.includes("diff")) {
      output = "diff --git a/src/main.ts b/src/main.ts\n";
    }
    return createProtocolExecResult({ output });
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
  queue = vi.fn(async () => ({
    userHistoryEntryId: "queue-1",
    turn: { status: "completed", stopReason: "stop" },
  }));
  steer = vi.fn(async () => ({
    userHistoryEntryId: "steer-1",
    turn: { status: "completed", stopReason: "stop" },
  }));
  cancelPendingMessages = vi.fn(async () => ({ cancelled: [] }));
  interrupt = vi.fn(async () => ({ interrupted: true, isTurnRunning: false }));
  startGoal = vi.fn(async (objective) => {
    this.snapshotValue = updateSnapshot(this.snapshotValue, {
      revision: this.snapshotValue.revision + 1,
      goal: { objective, status: "active" },
    });
    return {
      userHistoryEntryId: "goal-user",
      turn: { status: "completed", stopReason: "stop" },
    };
  });
  resumeGoal = vi.fn(async () => ({
    turn: { status: "completed", stopReason: "stop" },
  }));
  clearGoal = vi.fn(async () => {
    this.snapshotValue = updateSnapshot(this.snapshotValue, {
      revision: this.snapshotValue.revision + 1,
      goal: null,
    });
    return this.snapshotValue;
  });
  setReasoning = vi.fn(async (reasoning) => {
    this.snapshotValue = updateSnapshot(this.snapshotValue, {
      revision: this.snapshotValue.revision + 1,
      settings: { ...this.snapshotValue.settings, reasoning },
    });
    return { revision: this.snapshotValue.revision, settings: this.snapshotValue.settings };
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

  rewindToHistoryEntryId = vi.fn(async (historyEntryId) => {
    const historyEntries = historyEntriesFromSnapshot(this.snapshotValue);
    const historyIndex = historyEntries.findIndex((entry) => entry.id === historyEntryId);
    const entry = historyEntries[historyIndex];
    if (
      historyIndex < 0 ||
      entry.message.role !== "user" ||
      hasAutoCompactionContinuationMetadata(entry.message)
    ) {
      throw new Error("rewind failed");
    }
    const removedEntryIds = historyEntries.slice(historyIndex).map((item) => item.id);
    this.snapshotValue = updateSnapshot(this.snapshotValue, {
      revision: this.snapshotValue.revision + 1,
      historyEntries: historyEntries.slice(0, historyIndex),
    });
    const text =
      typeof entry.message.content === "string"
        ? stripTauUserDisplayText(entry.message.content)
        : stripTauUserDisplayText(
            entry.message.content
              .filter((block) => typeof block === "string" || block.type === "text")
              .map((block) => (typeof block === "string" ? block : block.text))
              .join("\n\n"),
          );
    return {
      snapshot: this.snapshotValue,
      historyEntryId,
      text,
      removedEntryIds,
    };
  });
  interruptSubagent = vi.fn(async (subagentId) => ({
    found: subagentId === "subagent-1",
  }));
  createEphemeralContext = vi.fn(async () => ({ contextId: "ephemeral-1" }));
  submitEphemeralThread = vi.fn(async ({ contextId, threadId, message }) => {
    for (const listener of this.ephemeralListeners) {
      listener({
        version: SESSION_PROTOCOL_VERSION,
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

  pendingUserMessages() {
    return structuredClone(this.pendingUserMessagesValue);
  }

  onPendingUserMessages(listener) {
    this.pendingUserMessagesListeners.add(listener);
    listener({
      version: SESSION_PROTOCOL_VERSION,
      type: "session.pendingUserMessages",
      sessionId: this.id,
      state: structuredClone(this.pendingUserMessagesValue),
    });
    return () => this.pendingUserMessagesListeners.delete(listener);
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
  toolModels = [];
  localToolModels = [];
  rewindPickerShows = [];
  rewindPickerHideCount = 0;
  removeMessagesFromCalls = [];
  status;
  statusUpdates = [];
  editorText = "";
  editorEnabledUpdates = [];
  subagentSelectionCycles = [];
  subagentSnapshots = [];
  selectedSubagentId;
  pendingUserMessages = [];
  terminalNotifications = [];
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
    const existing = this.messages.find((message) => message.id === id);
    if (existing) {
      existing.model = model;
    } else {
      this.messages.push({ id, model });
    }
    return id;
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
  updateLocalToolUi(model) {
    const copy = structuredClone(model);
    this.localToolModels.push(copy);
    this.toolModels = [copy];
  }
  subagentEvents = [];
  handleSubagentEvent(event) {
    this.subagentEvents.push(event);
  }
  resetToolUiSession = vi.fn();
  reconcileToolUiSession = vi.fn((models) => {
    this.toolModels = structuredClone(models);
  });
  reconcileSubagentUiSession(snapshots) {
    this.subagentSnapshots = structuredClone(snapshots);
  }
  resetToolUiSessionPreservingSubagents() {}
  cycleSubagentSelection(direction) {
    this.subagentSelectionCycles.push(direction);
    return undefined;
  }
  getSelectedSubagentId() {
    return this.selectedSubagentId;
  }
  sendTerminalNotification(title) {
    this.terminalNotifications.push(title);
  }
  setPendingUserMessages(messages) {
    this.pendingUserMessages = structuredClone(messages);
  }
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

async function launchInlineDiffTool({ env, uiText = "http://127.0.0.1:4321", returnDelayMs = 0 }) {
  await new Promise((resolve, reject) => {
    const socket = createConnection(env.TAU_DIFF_SOCKET);
    let nextId = 1;
    let buffer = "";
    let stage = "initialize";
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
        if (stage === "initialize") {
          if (uiText) {
            stage = "set-ui";
            request("session.set_ui_text", { text: uiText });
          } else {
            stage = "submit";
            request("thread.submit_message", { message: "explain this diff" });
          }
          continue;
        }
        if (stage === "set-ui") {
          stage = "submit";
          request("thread.submit_message", { message: "explain this diff" });
          continue;
        }
        if (!submitted) {
          submitted = true;
          setTimeout(() => {
            request("session.return_review", {
              review: "returned review from local diff tool",
            });
          }, returnDelayMs);
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
      configuredClientToolNames: ["notify"],
      themeIds: ["gold"],
    });

    controller.start();

    const intro = view.messages.find((message) => message.model.type === "app_intro")?.model;
    expect(intro.title).toContain("tau v");
    expect(intro.title).toContain("1 AGENTS.md");
    expect(intro.title).toContain("1 skills");
    expect(intro.title).toContain("1 client tool");
    expect(intro.title).not.toContain("session");
    expect(intro.body).toContain("skills:\n  alpha (~/.tau/skills)");
    expect(intro.body).toContain("context:\n  ~/repo/AGENTS.md\n\nclient tools:\n  notify");
    expect(intro.body).not.toContain("diff_review");
    expect(intro.body).not.toContain("prefill_input");
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

  it("renders persisted protocol notices in timeline order", async () => {
    const snapshot = createProtocolSnapshot({
      timeline: [
        {
          type: "notice",
          id: "notice-history-unavailable",
          notice: {
            severity: "warn",
            text: "Session history is unavailable. This session will continue.",
            timestamp: 1,
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

    expect(view.messages).toContainEqual({
      id: "notice-history-unavailable",
      model: {
        type: "system",
        kind: "warn",
        text: "Session history is unavailable. This session will continue.",
      },
    });

    const liveNotice = {
      type: "notice",
      id: "notice-live-warning",
      notice: { severity: "warn", text: "A live warning arrived.", timestamp: 2 },
    };
    for (const listener of session.listeners) {
      listener({
        version: SESSION_PROTOCOL_VERSION,
        type: "session.delta",
        sessionId: session.id,
        fromRevision: snapshot.revision,
        toRevision: snapshot.revision + 1,
        reason: "notice",
        delta: { type: "snapshot.patch", changes: [{ type: "timeline.append", item: liveNotice }] },
      });
    }

    expect(view.messages).toContainEqual({
      id: "notice-live-warning",
      model: { type: "system", kind: "warn", text: "A live warning arrived." },
    });
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

    expect(view.status.footer.statusHint).toBe("compacting context...");
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

    expect(session.submit).toHaveBeenCalledWith("hello session");
    expect(view.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "generated-user",
          model: { type: "user", text: "hello session" },
        }),
        expect.objectContaining({
          id: "assistant-1",
          model: expect.objectContaining({ type: "assistant" }),
        }),
      ]),
    );
  });

  it("renders submitted user messages from session deltas", async () => {
    const session = new FakeSession();
    const submitted = deferred();
    session.submit = vi.fn(async () => await submitted.promise);
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

    expect(session.submit).toHaveBeenCalledWith("hello session");
    expect(view.messages.some((message) => message.model.type === "user")).toBe(false);

    const hostUser = {
      id: "host-user",
      state: "committed",
      modelVisible: true,
      message: {
        role: "user",
        content: [{ type: "text", text: "hello session" }],
        timestamp: 1,
      },
    };
    const delta = createMessageAppendDelta(session.id, session.snapshotValue.revision, hostUser);
    session.snapshotValue = applySessionProtocolDelta(session.snapshotValue, delta);
    for (const listener of session.listeners) {
      listener(delta);
    }

    expect(view.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "host-user",
          model: { type: "user", text: "hello session" },
        }),
      ]),
    );

    submitted.resolve({
      userHistoryEntryId: "host-user",
      turn: { status: "completed", stopReason: "stop" },
    });
    await flush();
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
    expect(session.submit).toHaveBeenCalledWith("hello session");
    expect(view.messages.some((message) => message.model.type === "user")).toBe(false);
    expect(view.workingIconStarts).toBe(1);
    expect(view.workingIconStops).toBe(1);
    expect(controller.isStreaming).toBe(false);
    expect(controller.submittedTurnInProgress).toBe(false);
    expect(view.status.footer.statusHint).toBeUndefined();
  });

  it("shows the protocol cause when a submitted turn fails", async () => {
    const session = new FakeSession();
    session.submit = vi.fn(async () => {
      throw new TauSessionProtocolResponseError({
        requestId: "submit-1",
        error: {
          code: "internal_error",
          message: "failed to run session turn",
          data: { cause: "session snapshot is invalid" },
        },
      });
    });
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

    expect(view.systems).toContainEqual(
      expect.objectContaining({
        text: "session turn failed: failed to run session turn: session snapshot is invalid",
        kind: "error",
      }),
    );
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
    expect(view.status.footer.statusHint).toBeUndefined();
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
    expect(session.submit).toHaveBeenCalledWith("hello session");
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

  it("hides raw user-message metadata and hidden system blocks from snapshots", async () => {
    const rawText = prependTauUserMetadata("<system>hidden</system>\n\nvisible", [
      {
        type: "compaction",
        version: 1,
        summary: "summary",
        preservedUserMessages: [],
      },
    ]);
    const session = new FakeSession(
      createSnapshot([
        {
          id: "history-raw",
          message: {
            role: "user",
            content: [{ type: "text", text: rawText }],
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

    expect(view.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "history-raw",
          model: { type: "user", text: "\nvisible" },
        }),
      ]),
    );
  });

  it("restores diff review styling from session history", async () => {
    const rawText = formatDiffReviewUserMessage({
      diffCommand: "git diff",
      reviewedFiles: ["src/main.ts"],
      review: "review feedback",
      historyEntryId: "review-user",
    });
    const session = new FakeSession(
      createSnapshot([
        {
          id: "review-user",
          message: {
            role: "user",
            content: [{ type: "text", text: rawText }],
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

    expect(view.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "review-user",
          model: { type: "user", text: "review feedback", kind: "review" },
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
        timestamp: 1,
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
    expect(view.status.footer.statusHint).toBeUndefined();

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
    expect(view.status.footer.statusHint).toBeUndefined();

    controller.getInputHandlers().onSubmit("queued while response pending");
    await flush();

    expect(delayedSubmit).toHaveBeenCalledTimes(1);
    expect(session.queue).toHaveBeenCalledWith("queued while response pending");
    expect(view.systems).toEqual([]);

    session.submit = vi.fn(async (_text, options = {}) => ({
      userHistoryEntryId: options.historyEntryId ?? "queued-user",
      turn: { status: "completed", stopReason: "stop" },
    }));
    submitted.resolve({
      userHistoryEntryId: "user-delayed-response",
      turn: { status: "completed", stopReason: "stop" },
    });
    await flush();

    expect(view.workingIconStops).toBe(1);
    expect(controller.submittedTurnInProgress).toBe(false);
    expect(session.submit).not.toHaveBeenCalled();
  });

  it("retains editor submissions while manual compaction is active", async () => {
    const session = new FakeSession();
    const view = new FakeView();
    const controller = new SessionChatController({
      view,
      session,
      snapshot: await session.snapshot(),
      targetLabel: "in-process",
    });
    controller.start();
    controller.manualCompactionInProgress = true;

    expect(controller.getInputHandlers().beforeSubmit?.("keep this text")).toBe(false);
    expect(session.queue).not.toHaveBeenCalled();
    expect(session.submit).not.toHaveBeenCalled();
  });

  it("submits directly while local speech playback is active", async () => {
    const session = new FakeSession();
    const view = new FakeView();
    const controller = new SessionChatController({
      view,
      session,
      snapshot: await session.snapshot(),
      targetLabel: "in-process",
    });
    controller.start();
    controller.speakTask = {
      abortController: new AbortController(),
      completion: Promise.resolve(),
    };

    expect(controller.getInputHandlers().beforeSubmit?.("continue working")).toBe(true);
    controller.getInputHandlers().onSubmit("continue working");
    await flush();

    expect(session.submit).toHaveBeenCalledWith("continue working");
    expect(session.queue).not.toHaveBeenCalled();
  });

  it("notifies when a session turn becomes idle", async () => {
    const session = new FakeSession();
    const view = new FakeView();
    const controller = new SessionChatController({
      view,
      session,
      snapshot: await session.snapshot(),
      targetLabel: "in-process",
    });
    controller.start();

    session.emit({ type: "assistant_start", historyEntryId: "assistant-1" });
    session.emit({
      type: "assistant_final",
      historyEntryId: "assistant-1",
      message: createAssistantMessage("done"),
    });

    expect(view.terminalNotifications).toEqual(["tau is waiting for your input"]);
  });

  it("renders pending queue and steering messages from session pending state", async () => {
    const session = new FakeSession();
    const view = new FakeView();
    const controller = new SessionChatController({
      view,
      session,
      snapshot: await session.snapshot(),
      targetLabel: "in-process",
    });
    controller.start();

    const message = {
      version: SESSION_PROTOCOL_VERSION,
      type: "session.pendingUserMessages",
      sessionId: session.id,
      state: {
        revision: 2,
        messages: [
          { id: "steer-1", mode: "steer", text: "change direction" },
          { id: "queue-1", mode: "queue", text: "run tests" },
        ],
      },
    };
    for (const listener of session.pendingUserMessagesListeners) {
      listener(message);
    }

    expect(view.pendingUserMessages).toEqual(message.state.messages);
  });

  it("cancels all pending messages and restores their text to the editor", async () => {
    const session = new FakeSession();
    session.cancelPendingMessages = vi.fn(async () => ({
      cancelled: [
        { id: "steer-1", mode: "steer", text: "change direction" },
        { id: "queue-1", mode: "queue", text: "run tests" },
      ],
    }));
    const view = new FakeView();
    view.editorText = "existing";
    const controller = new SessionChatController({
      view,
      session,
      snapshot: await session.snapshot(),
      targetLabel: "in-process",
    });
    controller.start();

    controller.getInputHandlers().onAltUp?.();
    await flush();

    expect(session.cancelPendingMessages).toHaveBeenCalledOnce();
    expect(view.editorText).toBe("existing\n\n---\n\nchange direction\n\n---\n\nrun tests");
  });

  it("submits steering text as a normal turn while idle", async () => {
    const session = new FakeSession();
    const view = new FakeView();
    const controller = new SessionChatController({
      view,
      session,
      snapshot: await session.snapshot(),
      targetLabel: "in-process",
    });
    controller.start();

    controller.getInputHandlers().onSteerSubmit?.("start a turn");
    await flush();

    expect(session.submit).toHaveBeenCalledWith("start a turn");
    expect(session.steer).not.toHaveBeenCalled();
  });

  it("routes steering through the session protocol while a submitted turn is active", async () => {
    const session = new FakeSession();
    const view = new FakeView();
    const controller = new SessionChatController({
      view,
      session,
      snapshot: await session.snapshot(),
      targetLabel: "in-process",
    });
    controller.start();
    controller.isStreaming = true;
    controller.submittedTurnInProgress = true;

    controller.getInputHandlers().onSteerSubmit?.("change direction");
    await flush();

    expect(session.steer).toHaveBeenCalledWith("change direction");
    expect(view.systems).toEqual([]);
  });

  it("shows protocol causes when queueing and steering fail", async () => {
    const session = new FakeSession();
    session.queue = vi.fn(async () => {
      throw new TauSessionProtocolResponseError({
        requestId: "queue-1",
        error: {
          code: "internal_error",
          message: "failed to drain pending user message",
          data: { cause: "queued commit failed" },
        },
      });
    });
    session.steer = vi.fn(async () => {
      throw new TauSessionProtocolResponseError({
        requestId: "steer-1",
        error: {
          code: "internal_error",
          message: "steering turn failed",
          data: { cause: "session snapshot is invalid" },
        },
      });
    });
    const view = new FakeView();
    const controller = new SessionChatController({
      view,
      session,
      snapshot: await session.snapshot(),
      targetLabel: "in-process",
    });
    controller.start();
    controller.isStreaming = true;
    controller.submittedTurnInProgress = true;

    controller.getInputHandlers().onSubmit("queue this");
    controller.getInputHandlers().onSteerSubmit?.("steer this");
    await flush();

    expect(view.systems).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          text: "queueing failed: failed to drain pending user message: queued commit failed",
          kind: "error",
        }),
        expect.objectContaining({
          text: "steering failed: steering turn failed: session snapshot is invalid",
          kind: "error",
        }),
      ]),
    );
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
    expect(session.submit).toHaveBeenCalledTimes(1);

    controller.getInputHandlers().onSubmit("/help");
    await flush();

    expect(view.systems).toContainEqual(
      expect.objectContaining({
        kind: "warn",
        text: "wait for tau to become idle before running commands",
      }),
    );

    submitted.resolve({
      userHistoryEntryId: "user-pending-command",
      turn: { status: "completed", stopReason: "stop" },
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
            thinking: "checking context",
          },
        }),
      ]),
    );

    controller.getInputHandlers().onSubmit("queued after attach");
    await flush();

    expect(session.submit).not.toHaveBeenCalled();
    expect(session.queue).toHaveBeenCalledWith("queued after attach");
    expect(view.systems).toEqual([]);

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

    expect(session.submit).not.toHaveBeenCalled();
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
      version: SESSION_PROTOCOL_VERSION,
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

  it("preserves hidden thinking from assistant content append deltas", async () => {
    const baseSnapshot = createSnapshot();
    const snapshot = updateSnapshot(baseSnapshot, {
      revision: 3,
      lifecycle: "running",
      messages: [
        ...baseSnapshot.messages,
        {
          id: "assistant-thinking-streaming",
          state: "draft",
          modelVisible: false,
          message: {
            role: "assistant",
            timestamp: 1,
            content: [],
          },
        },
      ],
      timeline: [
        ...baseSnapshot.timeline,
        {
          type: "message",
          id: "timeline-assistant-thinking-streaming",
          messageId: "assistant-thinking-streaming",
        },
      ],
    });
    const session = new FakeSession(snapshot);
    const view = new FakeView();
    const controller = new SessionChatController({
      view,
      session,
      snapshot: await session.snapshot(),
      targetLabel: "local",
      themeIds: ["gold"],
    });

    controller.start();
    const appendDelta = {
      version: SESSION_PROTOCOL_VERSION,
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
            messageId: "assistant-thinking-streaming",
            thinking: "checking context",
            timestamp: 2,
          },
        ],
      },
    };
    session.snapshotValue = applySessionProtocolDelta(session.snapshotValue, appendDelta);

    for (const listener of session.listeners) {
      listener(appendDelta);
    }

    expect(view.messages.find((message) => message.id === "assistant-thinking-streaming")).toEqual(
      expect.objectContaining({
        model: {
          type: "assistant_partial",
          text: "",
          thinking: "checking context",
        },
      }),
    );
    controller.getInputHandlers().onCtrlT();

    expect(view.systems).toContainEqual(
      expect.objectContaining({ kind: "success", text: "thoughts visible" }),
    );
    expect(
      controller.snapshot.messages.find((entry) => entry.id === "assistant-thinking-streaming"),
    ).toEqual(
      expect.objectContaining({
        message: expect.objectContaining({
          content: [{ type: "thinking", thinking: "checking context" }],
        }),
      }),
    );
    await controller.dispose();
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
      version: SESSION_PROTOCOL_VERSION,
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
        {
          id: "assistant-draft",
          state: "draft",
          modelVisible: false,
          message: { role: "assistant", content: [], timestamp: 1 },
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
        "write-call": {
          id: "write-call",
          toolCallId: "write-call",
          toolName: "write",
          status: "streaming",
          origin: { messageId: "assistant-draft", contentIndex: 0 },
          facetIds: ["tool-ui-write-call"],
        },
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
        "tool-ui-write-call": {
          id: "tool-ui-write-call",
          subject: { type: "tool", id: "write-call" },
          kind: "tau.tool-ui-events",
          version: 1,
          data: {
            events: [
              {
                type: "tool_call_streaming",
                toolCallId: "write-call",
                toolName: "write",
                presentation: buildToolRunPresentation({
                  toolName: "write",
                  subject: "write",
                }),
              },
            ],
          },
        },
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
                presentation: buildToolRunPresentation({
                  toolName: "bash",
                  subject: "echo b",
                }),
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
                presentation: buildToolRunPresentation({
                  toolName: "bash",
                  subject: "echo a",
                }),
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

    expect(view.toolModels.map((model) => model.toolCallId)).toEqual([
      "tool-a",
      "tool-b",
      "write-call",
    ]);
    expect(view.toolModels.map((model) => model.status)).toEqual(["queued", "queued", "streaming"]);
    await controller.dispose();
  });

  it("renders tool results through the matching canonical tool card", async () => {
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
                presentation: buildToolRunPresentation({
                  toolName: "bash",
                  subject: "echo a",
                }),
              },
              {
                type: "bash_execution",
                toolCallId: "tool-a",
                command: "echo a",
                presentation: buildToolRunPresentation({
                  toolName: "bash",
                  subject: "echo a",
                  details: [{ text: "a" }],
                  metadata: ["exit 0"],
                }),
                exitCode: 0,
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
    expect(view.toolModels).toEqual([
      expect.objectContaining({
        toolCallId: "tool-a",
        status: "succeeded",
        presentation: expect.objectContaining({
          subject: "echo a",
          details: [{ text: "a", wrap: "word" }],
        }),
      }),
    ]);
    await controller.dispose();
  });

  it("applies tool status and presentation facet deltas independently", async () => {
    const queuedEvent = {
      type: "tool_call_queued",
      toolCallId: "tool-a",
      toolName: "bash",
      presentation: buildToolRunPresentation({ toolName: "bash", subject: "echo a" }),
    };
    const startedEvent = {
      type: "bash_started",
      toolCallId: "tool-a",
      command: "echo a\necho b",
      presentation: buildToolRunPresentation({ toolName: "bash", subject: "echo a\necho b" }),
    };
    const snapshot = updateSnapshot(createSnapshot(), {
      revision: 3,
      costTotal: 0.42,
      historyEntries: [
        {
          id: "assistant-tools",
          message: createAssistantToolCallMessage([
            {
              type: "toolCall",
              id: "tool-a",
              name: "bash",
              arguments: { command: "echo a" },
            },
          ]),
        },
      ],
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
    const delta = {
      version: SESSION_PROTOCOL_VERSION,
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
        ],
      },
    };
    session.snapshotValue = applySessionProtocolDelta(session.snapshotValue, delta);

    for (const listener of session.listeners) {
      listener(delta);
    }

    expect(view.resetToolUiSession).toHaveBeenCalledTimes(resetCount);
    expect(view.toolModels).toEqual([
      expect.objectContaining({
        toolCallId: "tool-a",
        status: "running",
        presentation: expect.objectContaining({ subject: "echo a" }),
      }),
    ]);

    const facetDelta = {
      version: SESSION_PROTOCOL_VERSION,
      type: "session.delta",
      sessionId: session.id,
      fromRevision: 4,
      toRevision: 5,
      reason: "tool-activity",
      delta: {
        type: "snapshot.patch",
        changes: [
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
    session.snapshotValue = applySessionProtocolDelta(session.snapshotValue, facetDelta);
    for (const listener of session.listeners) {
      listener(facetDelta);
    }

    expect(view.resetToolUiSession).toHaveBeenCalledTimes(resetCount);
    expect(view.toolModels).toEqual([
      expect.objectContaining({
        toolCallId: "tool-a",
        status: "running",
        presentation: expect.objectContaining({ subject: "echo a\necho b" }),
      }),
    ]);
    expect(view.status.footer.sessionCost).toBe("$0.42");
    expect(controller.snapshot.tools["tool-a"].status).toBe("running");
    await controller.dispose();
  });

  it("includes tier-priced assistant usage in the session footer cost", async () => {
    const assistantMessage = createAssistantMessage("tiered response");
    assistantMessage.usage = {
      input: 273000,
      output: 1000,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 274000,
      cost: { input: 0.546, output: 0.009, cacheRead: 0, cacheWrite: 0, total: 0.555 },
    };
    const session = new FakeSession(
      updateSnapshot(createSnapshot(), {
        costTotal: 0.555,
        messages: [
          {
            id: "system",
            state: "committed",
            modelVisible: true,
            message: { role: "system", content: "system prompt", timestamp: 0 },
          },
          {
            id: "assistant-tiered",
            state: "committed",
            modelVisible: true,
            message: assistantMessage,
          },
        ],
      }),
    );
    const view = new FakeView();
    const controller = new SessionChatController({
      view,
      session,
      snapshot: await session.snapshot(),
      targetLabel: "local",
    });

    controller.start();

    expect(view.status.footer.sessionCost).toBe("$0.56");
    await controller.dispose();
  });

  it("reconstructs subagent activity from snapshot presentation state", async () => {
    const agent = createAgentRun();
    const session = new FakeSession(
      updateSnapshot(createSnapshot(), {
        agents: {
          [agent.id]: agent,
        },
        facets: {
          "subagent-activity-agent-1": {
            id: "subagent-activity-agent-1",
            subject: { type: "agent", id: agent.id },
            kind: "tau.subagent-activity",
            version: 1,
            data: { text: "reading files" },
          },
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

    expect(view.subagentSnapshots).toEqual([
      {
        state: expect.objectContaining({
          id: "agent-1",
          run: expect.objectContaining({ status: "running" }),
        }),
        activity: "reading files",
      },
    ]);
    await controller.dispose();
  });

  it("reconstructs finished subagents from snapshot agent state", async () => {
    const agent = createAgentRun({
      status: "succeeded",
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

    expect(view.subagentSnapshots).toEqual([
      {
        state: expect.objectContaining({
          id: "agent-1",
          run: expect.objectContaining({ status: "succeeded", response: "all clear" }),
        }),
        activity: undefined,
      },
    ]);
    await controller.dispose();
  });

  it("applies agent activity facets without replaying tool UI state", async () => {
    const initialAgent = createAgentRun();
    const nextAgent = createAgentRun({
      costTotal: 0.02,
      usage: {
        ...initialAgent.usage,
        output: 15,
        contextWindowUsageTokens: 25,
      },
    });
    const initialFacet = {
      id: "subagent-activity-agent-1",
      subject: { type: "agent", id: initialAgent.id },
      kind: "tau.subagent-activity",
      version: 1,
      data: { text: "reading files" },
    };
    const nextFacet = { ...initialFacet, data: { text: "checking protocol" } };
    const session = new FakeSession(
      updateSnapshot(createSnapshot(), {
        revision: 3,
        agents: {
          [initialAgent.id]: initialAgent,
        },
        facets: { [initialFacet.id]: initialFacet },
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
      version: SESSION_PROTOCOL_VERSION,
      type: "session.delta",
      sessionId: session.id,
      fromRevision: 3,
      toRevision: 4,
      reason: "agent-run",
      delta: {
        type: "snapshot.patch",
        changes: [
          { type: "cost.set", costTotal: 0.02 },
          { type: "agent.set", agent: nextAgent },
          { type: "facet.set", facet: nextFacet },
        ],
      },
    };
    session.snapshotValue = applySessionProtocolDelta(session.snapshotValue, delta);

    for (const listener of session.listeners) {
      listener(delta);
    }

    expect(view.resetToolUiSession).toHaveBeenCalledTimes(resetCount);
    expect(view.subagentEvents).toEqual([]);
    expect(view.subagentSnapshots).toEqual([
      expect.objectContaining({
        state: expect.objectContaining({ id: "agent-1", costTotal: 0.02 }),
        activity: "checking protocol",
      }),
    ]);
    expect(controller.snapshot.agents["agent-1"]).not.toHaveProperty("progress");
    await controller.dispose();
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
    expect(view.localToolModels).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: "running",
          presentation: expect.objectContaining({ subject: "pwd" }),
        }),
        expect.objectContaining({
          status: "succeeded",
          presentation: expect.objectContaining({
            subject: "pwd",
            actionByStatus: expect.objectContaining({ succeeded: "you ran" }),
          }),
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
    expect(view.localToolModels).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          status: "succeeded",
          presentation: expect.objectContaining({
            subject: "pwd",
            actionByStatus: expect.objectContaining({ succeeded: "incognito" }),
          }),
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

    controller.getInputHandlers().onSubmit("/compact-keep-last preserve decisions");
    await flush();

    expect(session.compact).toHaveBeenCalledWith("summary-and-last", {
      guidance: "preserve decisions",
    });
    expect(session.submit).not.toHaveBeenCalled();
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
  });

  it("routes goal controls through the session protocol and reflects goal status", async () => {
    const session = new FakeSession();
    const view = new FakeView();
    const controller = new SessionChatController({
      view,
      session,
      snapshot: await session.snapshot(),
      targetLabel: "ssh host tau rpc",
    });
    controller.start();

    controller.getInputHandlers().onSubmit("/goal Ship the feature");
    await flush();

    expect(session.startGoal).toHaveBeenCalledWith("Ship the feature");
    expect(view.status.footer.pursuingGoal).toBe(true);

    controller.isStreaming = true;
    controller.getInputHandlers().onSubmit("/goal");
    await flush();
    expect(view.systems).toContainEqual(
      expect.objectContaining({ text: "goal active: Ship the feature" }),
    );

    controller.getInputHandlers().onSubmit("/goal clear");
    await flush();
    expect(session.clearGoal).toHaveBeenCalledOnce();
    expect(view.status.footer.pursuingGoal).toBe(false);

    controller.getInputHandlers().onSubmit("/goal Start another");
    controller.getInputHandlers().onSubmit("/goal resume");
    await flush();
    expect(session.startGoal).toHaveBeenCalledOnce();
    expect(session.resumeGoal).not.toHaveBeenCalled();
    expect(view.systems).toContainEqual(
      expect.objectContaining({
        kind: "warn",
        text: "wait for tau to become idle before running commands",
      }),
    );
  });

  it("shows manual compaction status until the compact request finishes", async () => {
    const session = new FakeSession();
    const pendingCompact = deferred();
    session.compact = vi.fn(async () => {
      await pendingCompact.promise;
      session.snapshotValue = updateSnapshot(session.snapshotValue, {
        revision: session.snapshotValue.revision + 1,
        historyEntries: [
          {
            id: "summary-entry",
            message: {
              role: "user",
              content: [{ type: "text", text: "compacted summary" }],
            },
          },
        ],
      });
      return {
        snapshot: session.snapshotValue,
        compactionMessage: "compacted summary",
        includedLastAssistant: false,
      };
    });
    const view = new FakeView();
    const controller = new SessionChatController({
      view,
      session,
      snapshot: await session.snapshot(),
      targetLabel: "ssh host tau rpc",
    });
    controller.start();

    controller.getInputHandlers().onSubmit("/compact-all");
    await flush();

    expect(view.status.footer.statusHint).toBe("compacting context...");
    pendingCompact.resolve();
    await flush();

    expect(view.status.footer.statusHint).toBeUndefined();
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

    controller.getInputHandlers().onSubmit("/reload ignored");
    await flush();

    controller.getInputHandlers().onSubmit("/help extra");
    await flush();

    expect(session.reload).toHaveBeenCalledTimes(1);
    expect(session.submit).not.toHaveBeenCalled();
    expect(view.systems.some((message) => message.text.includes("commands:"))).toBe(true);
  });

  it("tracks session editor input modes without command hints", async () => {
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
    expect(view.status.editor.mode).toBe("normal");

    handlers.onChange("/reload");
    expect(view.status.editor.mode).toBe("normal");
    expect(view.status.footer.statusHint).toBeUndefined();
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

  it("changes session reasoning while a turn is running", async () => {
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

    expect(session.setReasoning).toHaveBeenCalledWith("minimal");
    expect(view.status.editor.reasoningLabel).toBe("minimal");
    expect(view.systems).not.toContainEqual({
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

  it("interrupts the selected session subagent with ctrl+g", async () => {
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

    expect(session.interruptSubagent).toHaveBeenCalledWith("subagent-1");
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

    expect(session.interruptSubagent).not.toHaveBeenCalled();
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

    expect(session.interruptSubagent).toHaveBeenCalledWith("missing-subagent");
    expect(view.systems).toContainEqual({
      text: "unknown subagent id: missing-subagent",
      kind: "warn",
      options: undefined,
    });
  });

  it("submits hash-prefixed text as an ordinary user message", async () => {
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

    expect(session.submit).toHaveBeenCalledWith("# remember to run npm test");
    const renderedUser = view.messages.find((message) => message.id === "generated-user");
    expect(renderedUser).toEqual(
      expect.objectContaining({
        model: {
          type: "user",
          text: "# remember to run npm test",
        },
      }),
    );
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
    expect(session.exec).toHaveBeenCalledWith(
      'exec "$0" "$@"',
      expect.objectContaining({ args: ["git", "diff", "--", "src/main.ts"] }),
    );
    expect(session.createEphemeralContext).toHaveBeenCalledWith({
      instructions: expect.stringContaining("src/main.ts"),
      tools: ["bash", "view_image"],
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

  it("keeps a returned diff review uncommitted when session recording fails", async () => {
    const session = new FakeSession();
    session.record = vi.fn(async () => {
      throw new Error("record failed");
    });
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

    expect(view.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          model: expect.objectContaining({
            type: "diff_review",
            status: "failed",
            detail: "record failed",
          }),
        }),
      ]),
    );
    expect(view.messages.some((message) => message.model.type === "user")).toBe(false);
    expect(view.systems).toContainEqual(
      expect.objectContaining({ kind: "error", text: "diff review failed: record failed" }),
    );
    expect(view.systems).not.toContainEqual(
      expect.objectContaining({ kind: "success", text: expect.stringContaining("added") }),
    );
  });

  it("keeps a returned diff review committed when its delta arrives before record rejects", async () => {
    const session = new FakeSession();
    session.record = vi.fn(async (text, options = {}) => {
      const historyEntryId = options.historyEntryId;
      const message = {
        id: historyEntryId,
        state: "committed",
        modelVisible: true,
        message: {
          role: "user",
          content: [{ type: "text", text }],
          timestamp: 1,
        },
      };
      const delta = createMessageAppendDelta(session.id, session.snapshotValue.revision, message);
      session.snapshotValue = applySessionProtocolDelta(session.snapshotValue, delta);
      for (const listener of session.listeners) {
        listener(delta);
      }
      throw new Error("connection closed");
    });
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

    expect(view.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          model: {
            type: "user",
            text: "returned review from local diff tool",
            kind: "review",
          },
        }),
      ]),
    );
    expect(view.messages.some((message) => message.model.status === "failed")).toBe(false);
    expect(view.systems).toContainEqual(
      expect.objectContaining({
        kind: "success",
        text: "diff review added to the conversation. tau did not run yet.",
      }),
    );
    expect(view.systems).not.toContainEqual(
      expect.objectContaining({
        kind: "error",
        text: expect.stringContaining("connection closed"),
      }),
    );
  });

  it("blocks prompts and session replacement until a local diff review is recorded", async () => {
    const session = new FakeSession();
    const nextSession = new FakeSession();
    const createSession = vi.fn(async () => nextSession);
    const recordStarted = deferred();
    const releaseRecord = deferred();
    const record = session.record;
    session.record = vi.fn(async (...args) => {
      recordStarted.resolve();
      await releaseRecord.promise;
      return await record(...args);
    });
    const view = new FakeView();
    const controller = new SessionChatController({
      view,
      session,
      snapshot: await session.snapshot(),
      createSession,
      targetLabel: "ssh host tau rpc",
      defaultDiffTool: { command: "inline-diff-tool" },
      diffToolLauncher: launchInlineDiffTool,
    });
    controller.start();

    const review = controller.onUserInput("/diff -- src/main.ts");
    await recordStarted.promise;

    await controller.onUserInput("start another turn");
    await controller.onUserInput("/new");

    expect(session.submit).not.toHaveBeenCalled();
    expect(session.queue).not.toHaveBeenCalled();
    expect(createSession).not.toHaveBeenCalled();
    expect(view.systems).toContainEqual({
      text: "wait for tau to become idle before submitting input",
      kind: "warn",
      options: undefined,
    });

    releaseRecord.resolve();
    await review;

    expect(session.record).toHaveBeenCalledTimes(1);
    expect(session.closeEphemeralContext).toHaveBeenCalledWith("ephemeral-1");
  });

  it("prefills only an empty TUI editor through the client tool", async () => {
    const session = new FakeSession();
    const view = new FakeView();
    const controller = new SessionChatController({
      view,
      session,
      snapshot: await session.snapshot(),
      targetLabel: "in-process",
    });
    const tools = createTuiClientTools({ enabled: true, getController: () => controller });
    const prefillInput = tools.find((tool) => tool.schema.name === "prefill_input");

    expect(tools.map((tool) => tool.schema.name)).toEqual(["diff_review", "prefill_input"]);
    expect(prefillInput.schema.parameters.properties.text.pattern).toBe("\\S");
    expect(() => prefillInput.execute({ text: " \n\t" })).toThrow(
      "Invalid prefill_input arguments: text: must contain non-whitespace text",
    );
    expect(view.editorText).toBe("");

    expect(prefillInput.execute({ text: "Name: \nDecision: " })).toBe(
      "Prefilled the input editor. The user can review, edit, and submit it.",
    );
    expect(view.editorText).toBe("Name: \nDecision: ");

    expect(() => prefillInput.execute({ text: "replacement" })).toThrow(
      "Cannot prefill input because the editor already contains text.",
    );
    expect(view.editorText).toBe("Name: \nDecision: ");
  });

  it("adds configured command tools to the built-in TUI tools", () => {
    const tools = createTuiClientTools({
      enabled: true,
      getController: () => undefined,
      commandTools: [
        {
          name: "notify",
          description: "Show a local notification.",
          parameters: { type: "object", properties: {}, additionalProperties: false },
          command: "notify",
        },
      ],
    });

    expect(tools.map((tool) => tool.schema.name)).toEqual([
      "diff_review",
      "prefill_input",
      "notify",
    ]);
  });

  it("rejects configured tools that duplicate a built-in TUI tool", () => {
    expect(() =>
      createTuiClientTools({
        enabled: true,
        getController: () => undefined,
        commandTools: [
          {
            name: "prefill_input",
            description: "Replace a built-in tool.",
            parameters: { type: "object", properties: {}, additionalProperties: false },
            command: "replacement",
          },
        ],
      }),
    ).toThrow("duplicate TUI client tool 'prefill_input'");
  });

  it("rejects configured tool collisions before spawning a stdio transport", async () => {
    const markerPath = join(
      tmpdir(),
      `tau-client-tool-transport-marker-${process.pid}-${Date.now()}`,
    );

    try {
      await expect(
        SessionChatApp.connect({
          transport: "stdio",
          command: process.execPath,
          args: [
            "--input-type=module",
            "--eval",
            `import { writeFileSync } from "node:fs"; writeFileSync(${JSON.stringify(markerPath)}, "spawned");`,
          ],
          sessionSelection: { mode: "select" },
          clientToolsEnabled: true,
          config: {
            clientTools: [
              {
                name: "prefill_input",
                defaultEnabled: true,
                description: "Replace a built-in tool.",
                parameters: { type: "object", properties: {}, additionalProperties: false },
                command: "replacement",
              },
            ],
          },
        }),
      ).rejects.toThrow("duplicate TUI client tool 'prefill_input'");

      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(existsSync(markerPath)).toBe(false);
    } finally {
      await rm(markerPath, { force: true });
    }
  });

  it("disables built-in and configured TUI client tools together", () => {
    expect(
      createTuiClientTools({
        enabled: false,
        getController: () => undefined,
        commandTools: [
          {
            name: "notify",
            description: "Show a local notification.",
            parameters: { type: "object", properties: {}, additionalProperties: false },
            command: "notify",
          },
        ],
      }),
    ).toEqual([]);
  });

  it("keeps an active model-launched diff review visible and steerable", async () => {
    const session = new FakeSession();
    const view = new FakeView();
    const controller = new SessionChatController({
      view,
      session,
      snapshot: await session.snapshot(),
      targetLabel: "ssh host tau rpc",
      defaultDiffTool: { command: "inline-diff-tool" },
      diffToolLauncher: (args) => launchInlineDiffTool({ ...args, returnDelayMs: 100 }),
    });
    controller.start();

    const result = controller.runClientDiffReview(
      { source: "git_diff", diffArgs: ["--", "src/main.ts"] },
      new AbortController().signal,
    );

    await waitUntil(() =>
      view.messages.some(
        (message) =>
          message.model.type === "diff_review" &&
          message.model.status === "active" &&
          message.model.uiText === "http://127.0.0.1:4321",
      ),
    );

    controller.isStreaming = true;
    await controller.onUserInput("queue after review");
    controller.getInputHandlers().onSteerSubmit?.("adjust the review");
    await flush();

    expect(session.queue).toHaveBeenCalledWith("queue after review");
    expect(session.steer).toHaveBeenCalledWith("adjust the review");

    await expect(result).resolves.toContain("Diff review completed.");
    await expect(result).resolves.toContain("Reviewed scope: git diff -- src/main.ts");
    await expect(result).resolves.toContain("returned review from local diff tool");
    const diffReviewMessage = view.messages.find((message) => message.model.type === "diff_review");
    expect(diffReviewMessage.model).toMatchObject({
      type: "diff_review",
      status: "returned",
      command: "git diff -- src/main.ts",
    });
    expect(session.record).not.toHaveBeenCalled();
    expect(session.closeEphemeralContext).toHaveBeenCalledWith("ephemeral-1");
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
      .map((status) => status.footer.statusHint)
      .filter((hint) => hint !== undefined);
    expect(speechHints).toEqual(
      expect.arrayContaining([
        "rewriting for speech...",
        "generating speech chunks (0 out of 1 ready)...",
        "generating speech chunks (1 out of 1 ready)...",
        "playing speech (0/1 played, 1/1 ready)...",
      ]),
    );
    expect(view.status.footer.statusHint).toBeUndefined();
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
    session.snapshotValue = {
      ...session.snapshotValue,
      attributes: { source: "telegram", repository: "github.com/example/repo" },
    };
    const nextSession = new FakeSession(createSnapshot([]));
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
      attributes: { source: "tui", repository: "github.com/example/repo" },
      personaId: "persona-1",
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

  it("applies replacement-session deltas buffered during listener installation", async () => {
    const session = new FakeSession(updateSnapshot(createSnapshot(), { revision: 10 }));
    const nextSession = new FakeSession();
    nextSession.id = "session-2";
    nextSession.snapshotValue = {
      ...nextSession.snapshotValue,
      sessionId: "session-2",
    };
    const message = {
      id: "next-session-message",
      state: "committed",
      modelVisible: true,
      message: {
        role: "user",
        content: [{ type: "text", text: "arrived during handoff" }],
        timestamp: 1,
      },
    };
    const delta = createMessageAppendDelta(
      nextSession.id,
      nextSession.snapshotValue.revision,
      message,
    );
    nextSession.onDelta = vi.fn((listener) => {
      nextSession.listeners.add(listener);
      nextSession.snapshotValue = applySessionProtocolDelta(nextSession.snapshotValue, delta);
      listener(delta);
      return () => nextSession.listeners.delete(listener);
    });
    const view = new FakeView();
    const controller = new SessionChatController({
      view,
      session,
      snapshot: await session.snapshot(),
      createSession: vi.fn(async () => nextSession),
      targetLabel: "ssh host tau rpc",
    });
    controller.start();

    await controller.onUserInput("/new");

    const dividerIndex = view.messages.findIndex((entry) => entry.model.type === "session_divider");
    const messageIndex = view.messages.findIndex((entry) => entry.id === message.id);
    expect(dividerIndex).toBeGreaterThanOrEqual(0);
    expect(messageIndex).toBeGreaterThan(dividerIndex);
    expect(view.messages[messageIndex]).toEqual({
      id: message.id,
      model: { type: "user", text: "arrived during handoff" },
    });
  });

  it("serializes concurrent new-session requests", async () => {
    const session = new FakeSession();
    const nextSession = new FakeSession();
    nextSession.id = "session-2";
    nextSession.snapshotValue = {
      ...nextSession.snapshotValue,
      sessionId: "session-2",
    };
    const sessionCreated = deferred();
    const createSession = vi.fn(async () => await sessionCreated.promise);
    const view = new FakeView();
    const controller = new SessionChatController({
      view,
      session,
      snapshot: await session.snapshot(),
      createSession,
      targetLabel: "ssh host tau rpc",
    });
    controller.start();

    const firstNewSession = controller.onUserInput("/new");
    await waitUntil(() => createSession.mock.calls.length === 1);
    await controller.onUserInput("/new");

    expect(createSession).toHaveBeenCalledTimes(1);
    expect(session.unobserve).not.toHaveBeenCalled();
    expect(view.systems).toContainEqual({
      text: "wait for tau to become idle before submitting input",
      kind: "warn",
      options: undefined,
    });

    sessionCreated.resolve(nextSession);
    await firstNewSession;

    expect(session.unobserve).toHaveBeenCalledTimes(1);
    expect(nextSession.listeners.size).toBe(1);
    expect(nextSession.pendingUserMessagesListeners.size).toBe(1);
  });

  it("unobserves a newly created session when its initial snapshot fails", async () => {
    const session = new FakeSession();
    const nextSession = new FakeSession();
    nextSession.snapshot = vi.fn(async () => {
      throw new Error("snapshot unavailable");
    });
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

    await controller.onUserInput("/new");

    expect(nextSession.unobserve).toHaveBeenCalledTimes(1);
    expect(session.unobserve).not.toHaveBeenCalled();
    expect(session.listeners.size).toBe(1);
    expect(view.systems).toContainEqual({
      text: "new session failed: snapshot unavailable",
      kind: "error",
      options: undefined,
    });
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
          id: "history-continuation",
          message: buildAutoCompactionContinuationMessage({
            cutType: "turn-boundary",
            now: 1,
            archive: undefined,
          }),
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
