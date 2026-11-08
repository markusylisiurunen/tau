import { EventEmitter } from "node:events";
import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { HistoryManager } from "../dist/core/history/history_manager.js";
import { LocalHistoryStore } from "../dist/core/history/local_history_store.js";
import { resolveModel } from "../dist/core/models/catalog.js";
import { personas } from "../dist/core/personas.js";
import { buildAutoCompactionContinuationMessage } from "../dist/core/session/compaction.js";
import { createLocalToolExecutionBackend } from "../dist/core/tools/execution_backend.js";
import {
  buildToolRunPresentation,
  TOOL_UI_FACET_VERSION,
} from "../dist/core/tools/presentation.js";
import { SPEECH_TO_TEXT_CLIENT_MAX_DURATION_MS } from "../dist/core/utils/speech_to_text.js";
import {
  formatTauUserText,
  hasAutoCompactionContinuationMetadata,
  prependTauUserMetadata,
  splitTauUserText,
  stripTauUserDisplayText,
} from "../dist/core/utils/user_metadata.js";
import { LocalSessionHost } from "../dist/host/local_session_host.js";
import {
  applySessionProtocolDelta,
  SESSION_PROTOCOL_VERSION,
} from "../dist/protocol/session_protocol.js";
import { FileSessionStore } from "../dist/store/file_session_store.js";
import { MemorySessionStore } from "../dist/store/memory_session_store.js";
import * as listenCapture from "../dist/tui/listen_capture.js";
import { SessionChatController } from "../dist/tui/session_chat_controller.js";
import { runSpeechPlaybackTask } from "../dist/tui/speech_playback.js";
import { CustomEditor } from "../dist/tui/ui/custom_editor.js";
import { createUiTheme } from "../dist/tui/ui/theme/index.js";
import {
  createProtocolBootstrap,
  createProtocolExecResult,
  createProtocolSnapshot,
} from "./helpers/session_protocol_fixtures.js";

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
    costTotal: overrides.costTotal ?? snapshot.costTotal,
    catalog: overrides.catalog ?? snapshot.catalog,
    executionEnvironment: snapshot.executionEnvironment,
    historyEntries: overrides.historyEntries ?? historyEntriesFromSnapshot(snapshot),
    settings: overrides.settings ?? snapshot.settings,
    messages: overrides.messages,
    timeline: overrides.timeline,
    tools: overrides.tools ?? snapshot.tools,
    operations: overrides.operations ?? snapshot.operations,
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
    cause: {
      type: message.message.role === "assistant" ? "assistant-message" : "user-message",
    },
    delta: {
      type: "snapshot.patch",
      changes: [
        ...(state === "draft" ? [{ type: "lifecycle.set", lifecycle: "running" }] : []),
        {
          type: "message.append",
          message: { ...message, state },
        },
        {
          type: "timeline.append",
          item: {
            type: "message",
            id: `timeline-${message.id}`,
            sequence: fromRevision + 1,
            createdAt: message.message.timestamp ?? 0,
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
    cause: { type: reason },
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
    cause: typeof reason === "string" ? { type: reason } : reason,
    delta: { type: "snapshot.reset", snapshot },
  };
}

class FakeSession {
  id = "session-1";
  listeners = new Set();
  ephemeralListeners = new Set();
  pendingUserMessagesListeners = new Set();
  pendingUserMessagesValue = { revision: 1, messages: [] };
  subagentActivitiesListeners = new Set();
  subagentActivitiesValue = { revision: 1, agents: {} };
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
        type: "user_message",
        historyEntryId,
        message: { role: "user", content: [{ type: "text", text }], timestamp: 1 },
      });
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
    const previousEpoch = this.snapshotValue.timeline.epoch;
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
    this.snapshotValue.timeline.epoch = previousEpoch + 1;
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

  subagentActivities() {
    return structuredClone(this.subagentActivitiesValue);
  }

  onSubagentActivities(listener) {
    this.subagentActivitiesListeners.add(listener);
    listener({
      version: SESSION_PROTOCOL_VERSION,
      type: "session.subagentActivities",
      sessionId: this.id,
      revision: this.subagentActivitiesValue.revision,
      changes: Object.entries(this.subagentActivitiesValue.agents).map(([agentId, state]) => ({
        type: "agent.set",
        agentId,
        state: structuredClone(state),
      })),
    });
    return () => this.subagentActivitiesListeners.delete(listener);
  }

  async snapshot() {
    return this.snapshotValue;
  }

  emit(event) {
    const fromRevision = this.snapshotValue.revision;
    for (const listener of this.listeners) {
      if (event.type === "user_message") {
        const message = {
          id: event.historyEntryId,
          state: "committed",
          modelVisible: true,
          message: event.message,
        };
        this.snapshotValue = updateSnapshot(this.snapshotValue, {
          revision: fromRevision + 1,
          messages: [...this.snapshotValue.messages, message],
        });
        listener(createMessageAppendDelta(this.id, fromRevision, message));
      }
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
          timeline: {
            ...this.snapshotValue.timeline.items,
            sequence: this.snapshotValue.timeline.sequence + 1,
            items: [
              ...this.snapshotValue.timeline.items,
              {
                type: "message",
                id: `timeline-${event.historyEntryId}`,
                sequence: this.snapshotValue.timeline.sequence + 1,
                createdAt: draftMessage.message.timestamp,
                messageId: event.historyEntryId,
              },
            ],
          },
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
  feedback = [];
  footerNotices = [];
  transcriptNotices = [];
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
  programStatuses = [];
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
    this.toolModels = this.messages.flatMap((message) =>
      message.model.type === "tool" ? [structuredClone(message.model.tool)] : [],
    );
  }
  removeMessagesFrom(id) {
    this.removeMessagesFromCalls.push(id);
  }
  addMessage(model, id = `view-${this.messages.length + 1}`) {
    if (model.type === "tool") {
      const index = this.toolModels.findIndex((tool) => tool.toolCallId === model.tool.toolCallId);
      if (index === -1) {
        this.toolModels.push(structuredClone(model.tool));
      } else {
        this.toolModels[index] = structuredClone(model.tool);
      }
    }
    const existing = this.messages.find((message) => message.id === id);
    if (existing) {
      existing.model = model;
    } else {
      this.messages.push({ id, model });
    }
    return id;
  }
  updateMessage(id, model) {
    if (model.type === "tool") {
      const index = this.toolModels.findIndex((tool) => tool.toolCallId === model.tool.toolCallId);
      if (index === -1) {
        this.toolModels.push(structuredClone(model.tool));
      } else {
        this.toolModels[index] = structuredClone(model.tool);
      }
    }
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
  showFooterNotice(text, tone, durationMs = 3000) {
    this.feedback.push({ text, tone });
    this.footerNotices.push({ text, tone, durationMs });
  }
  addTranscriptNotice(text, tone, content) {
    this.feedback.push({ text, tone, ...(content ? { content } : {}) });
    this.transcriptNotices.push({ text, tone, ...(content ? { content } : {}) });
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
  setProgramStatus(state) {
    this.programStatuses.push(state);
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
  beginEditorTextPreview() {
    const original = this.editorText;
    let active = true;
    return {
      update: (text) => {
        if (active) this.editorText = original + text;
      },
      commit: (text) => {
        if (active) this.editorText = original + text;
        active = false;
      },
      cancel: () => {
        if (active) this.editorText = original;
        active = false;
      },
    };
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
    const protocolVersion = Number(env.TAU_DIFF_PROTOCOL_VERSION);

    const request = (method, params) => {
      const id = String(nextId++);
      socket.write(
        `${JSON.stringify({ version: protocolVersion, type: "request", id, method, params })}\n`,
      );
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
              version: protocolVersion,
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
              outcome: "commented",
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

function createIdleSpeechWebSocketFactory() {
  const socket = new EventEmitter();
  socket.send = vi.fn((_data, callback) => callback?.());
  socket.close = vi.fn();
  socket.terminate = vi.fn();
  return vi.fn(() => socket);
}

function createSpawnResult(overrides = {}) {
  return {
    stdout: "",
    stderr: "",
    output: undefined,
    exitCode: 0,
    captureLimitExceeded: false,
    timedOut: false,
    aborted: false,
    closeSignal: null,
    ...overrides,
  };
}

const EMPTY_CLIENT_CONFIG = { speech: { personalVocabulary: [] } };

async function createControllerHarness({
  session = new FakeSession(),
  view = new FakeView(),
  config,
  ...options
} = {}) {
  const controller = new SessionChatController({
    config: { ...config, speech: { ...EMPTY_CLIENT_CONFIG.speech, ...config?.speech } },
    view,
    session,
    snapshot: await session.snapshot(),
    targetLabel: "ws://host",
    ...options,
  });
  return { session, view, controller };
}

describe("SessionChatController", () => {
  it("orders startup context by specificity and catalog names alphabetically", async () => {
    const session = new FakeSession();
    const paths = [
      "/home/session/AGENTS.md",
      "/home/session/repo/src/AGENTS.md",
      "/home/session/repo/AGENTS.md",
    ];
    session.snapshotValue.messages.find(
      (entry) => entry.message.role === "system",
    ).message.content = paths
      .map((path) => `<file path="${path}">\ninstructions\n</file>`)
      .join("\n");
    session.snapshotValue.catalog.skills = ["zulu", "alpha", "bravo"].map((name) => ({
      name,
      description: name,
      path: `/skills/${name}/SKILL.md`,
    }));
    session.snapshotValue.catalog.mcp = { status: "available", servers: ["z-server", "a-server"] };
    const { controller, view } = await createControllerHarness({
      session,
      configuredClientToolNames: ["review", "browser"],
    });
    controller.start();
    const { body } = view.messages.find((message) => message.model.type === "app_intro").model;
    const contextIndex = body.indexOf("context files:");
    expect(body.slice(contextIndex + 1, contextIndex + 4)).toEqual([
      "  ~/repo/src/AGENTS.md",
      "  ~/repo/AGENTS.md",
      "  ~/AGENTS.md",
    ]);
    expect(body[body.indexOf("skills:") + 1]).toEqual({ names: ["alpha", "bravo", "zulu"] });
    expect(body[body.indexOf("MCP servers:") + 1]).toEqual({ names: ["a-server", "z-server"] });
    expect(body[body.indexOf("client tools:") + 1]).toEqual({ names: ["browser", "review"] });
    await controller.dispose();
  });

  it("keeps unavailable MCP feedback as an indented text entry", async () => {
    const session = new FakeSession();
    session.snapshotValue.catalog.mcp = { status: "unavailable", reason: "remote-execution" };
    const { controller, view } = await createControllerHarness({ session });
    controller.start();
    const { body } = view.messages.find((message) => message.model.type === "app_intro").model;
    const explanation = body[body.indexOf("MCP servers:") + 1];
    expect(typeof explanation).toBe("string");
    expect(explanation.startsWith("  ")).toBe(true);
    expect(explanation.trim().length).toBeGreaterThan(0);
    await controller.dispose();
  });

  it("waits for a failed receipt after idle and never auto-speaks its partial answer", async () => {
    const { session, view, controller } = await createControllerHarness({ deps: createMockDeps() });
    const speak = vi.spyOn(controller, "speakLastAssistantMessage").mockResolvedValue();
    controller.start();
    await controller.onUserInput("/auto-speak on");
    const publish = (changes) => {
      const delta = {
        version: SESSION_PROTOCOL_VERSION,
        type: "session.delta",
        sessionId: session.id,
        fromRevision: session.snapshotValue.revision,
        toRevision: session.snapshotValue.revision + 1,
        cause: { type: "notice" },
        delta: { type: "snapshot.patch", changes },
      };
      session.snapshotValue = applySessionProtocolDelta(session.snapshotValue, delta);
      for (const listener of session.listeners) listener(delta);
    };
    publish([
      { type: "lifecycle.set", lifecycle: "running" },
      { type: "turn.set", turn: { userHistoryEntryId: "turn", state: "running" } },
    ]);
    session.emit({ type: "assistant_start", historyEntryId: "answer" });
    session.emit({
      type: "assistant_final",
      historyEntryId: "answer",
      message: createAssistantMessage("partial answer"),
    });
    expect(view.programStatuses.at(-1)).toBe("working");
    const runningReports = view.programStatuses.length;
    publish([{ type: "lifecycle.set", lifecycle: "idle" }]);
    expect(view.programStatuses).toHaveLength(runningReports);
    expect(speak).not.toHaveBeenCalled();
    publish([
      {
        type: "turn.set",
        turn: {
          userHistoryEntryId: "turn",
          state: "settled",
          outcome: { status: "failed", stopReason: "error", errorMessage: "provider failed" },
        },
      },
    ]);
    expect(view.programStatuses.at(-1)).toBe("error");
    expect(speak).not.toHaveBeenCalled();
    const reports = view.programStatuses.length;
    publish([{ type: "lifecycle.set", lifecycle: "idle" }]);
    expect(view.programStatuses).toHaveLength(reports);
    await controller.dispose();
    expect(view.programStatuses.at(-1)).toBe("clear");
  });

  it("reports settlement replayed during revision-gap recovery", async () => {
    const { session, controller, view } = await createControllerHarness();
    controller.start();
    session.snapshotValue = updateSnapshot(session.snapshotValue, { lifecycle: "running" });
    session.snapshotValue.turns = {
      turn: { userHistoryEntryId: "turn", state: "running" },
    };
    await controller.syncFromSessionSnapshot();
    const running = structuredClone(session.snapshotValue);
    let resolveSnapshot;
    session.snapshot = () =>
      new Promise((resolve) => {
        resolveSnapshot = resolve;
      });
    const recovery = controller.recoverFromRevisionGap();
    const delta = {
      version: SESSION_PROTOCOL_VERSION,
      type: "session.delta",
      sessionId: session.id,
      fromRevision: running.revision,
      toRevision: running.revision + 1,
      cause: { type: "assistant-message" },
      delta: {
        type: "snapshot.patch",
        changes: [
          { type: "lifecycle.set", lifecycle: "idle" },
          {
            type: "turn.set",
            turn: {
              userHistoryEntryId: "turn",
              state: "settled",
              outcome: { status: "completed", stopReason: "stop" },
            },
          },
        ],
      },
    };
    for (const listener of session.listeners) listener(delta);
    resolveSnapshot(running);
    await recovery;
    expect(view.programStatuses).toEqual(["idle", "working", "done"]);
    session.snapshot = async () => controller.snapshot;
    await controller.syncFromSessionSnapshotAfterRevisionGap();
    expect(view.programStatuses).toEqual(["idle", "working", "done"]);
    await controller.dispose();
  });

  it("prevents duplicate exports and aborts on detach", async () => {
    const requests = [];
    const server = createServer((request) => requests.push(request));
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      const session = new FakeSession(
        createSnapshot([{ id: "reply", message: createAssistantMessage("reply") }]),
      );
      const { controller } = await createControllerHarness({
        session,
        config: { markdownExport: { url: `http://127.0.0.1:${server.address().port}/api` } },
      });
      controller.start();
      controller.getInputHandlers().onSubmit("/export-response");
      await vi.waitFor(() => expect(requests).toHaveLength(1));
      controller.getInputHandlers().onSubmit("/export-response");
      await flush();
      const closed = new Promise((resolve) => requests[0].socket.once("close", resolve));
      await controller.dispose();
      await closed;
      expect(requests).toHaveLength(1);
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("merges ephemeral timeline items by sequence and truncates them on rewind", async () => {
    const snapshot = createSnapshot([
      {
        id: "user-1",
        message: { role: "user", content: [{ type: "text", text: "keep" }] },
      },
    ]);
    const session = new FakeSession(snapshot);
    const view = new FakeView();
    const controller = new SessionChatController({
      config: EMPTY_CLIENT_CONFIG,
      view,
      session,
      snapshot,
      targetLabel: "in-process",
    });
    controller.start();

    for (const listener of session.listeners) {
      listener({
        version: SESSION_PROTOCOL_VERSION,
        type: "session.delta",
        sessionId: session.id,
        fromRevision: 1,
        toRevision: 2,
        cause: { type: "notice" },
        delta: {
          type: "snapshot.patch",
          changes: [{ type: "timeline.advance", epoch: 1, sequence: 2 }],
        },
      });
    }
    const ephemeralItem = {
      type: "notice",
      id: "ephemeral-2",
      sequence: 2,
      createdAt: 2,
      notice: {
        kind: "tau.test.ephemeral",
        version: 1,
        severity: "info",
        subject: { type: "session" },
        presentation: { title: "ephemeral second" },
        data: {},
      },
    };
    for (const listener of session.ephemeralListeners) {
      listener({
        version: SESSION_PROTOCOL_VERSION,
        type: "session.ephemeral",
        sessionId: session.id,
        event: { type: "timeline.item", epoch: 1, item: ephemeralItem },
      });
    }
    const durableItem = {
      type: "notice",
      id: "durable-3",
      sequence: 3,
      createdAt: 3,
      notice: {
        kind: "tau.test.durable",
        version: 1,
        severity: "warn",
        subject: { type: "session" },
        presentation: { title: "durable third" },
        data: {},
      },
    };
    for (const listener of session.listeners) {
      listener({
        version: SESSION_PROTOCOL_VERSION,
        type: "session.delta",
        sessionId: session.id,
        fromRevision: 2,
        toRevision: 3,
        cause: { type: "notice" },
        delta: {
          type: "snapshot.patch",
          changes: [{ type: "timeline.append", item: durableItem }],
        },
      });
    }

    expect(view.messages.map((message) => message.id)).toEqual([
      "view-1",
      "user-1",
      "ephemeral-2",
      "durable-3",
    ]);

    const rewoundSnapshot = createProtocolSnapshot({
      ...snapshot,
      revision: 4,
      messages: snapshot.messages,
      timeline: {
        epoch: 1,
        sequence: 3,
        items: snapshot.timeline.items,
      },
    });
    for (const listener of session.listeners) {
      listener(
        createResetDelta(session.id, 3, rewoundSnapshot, {
          type: "rewind",
          epoch: 1,
          cutoffSequence: 1,
        }),
      );
    }

    expect(view.messages.map((message) => message.id)).toEqual(["view-1", "user-1"]);
  });

  it("freezes the old transcript from auto-compaction metadata when the start delta was missed", async () => {
    const retainedEntry = {
      id: "retained-entry",
      message: {
        role: "user",
        content: [{ type: "text", text: "retained before compaction" }],
      },
    };
    const runningSnapshot = createProtocolSnapshot({
      sessionId: "session-1",
      revision: 1,
      historyEntries: [retainedEntry],
      timeline: [
        {
          type: "message",
          id: `timeline-${retainedEntry.id}`,
          messageId: retainedEntry.id,
        },
      ],
    });
    const compactedText = prependTauUserMetadata("compacted summary", [
      {
        type: "auto-compaction",
        version: 1,
        summary: "compacted summary",

        cutType: "turn-boundary",
        retainedMessageCount: 1,
      },
    ]);
    const continuationText = prependTauUserMetadata("", [
      { type: "auto-compaction-continuation", version: 1 },
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
        retainedEntry,
        {
          id: "continuation-entry",
          message: {
            role: "user",
            content: [{ type: "text", text: continuationText }],
          },
        },
      ],
      timeline: [{ type: "message", id: "timeline-summary-entry", messageId: "summary-entry" }],
    });
    compactedSnapshot.timeline.epoch = 2;
    const session = new FakeSession(runningSnapshot);
    const view = new FakeView();
    const { controller } = await createControllerHarness({
      view,
      session,
      targetLabel: "in-process",
    });
    controller.start();

    const compactionDelta = createResetDelta(session.id, 1, compactedSnapshot, {
      type: "compaction",
      previousEpoch: 1,
      epoch: 2,
      kind: "auto",
      cutType: "turn-boundary",
      retainedMessageCount: 1,
    });
    for (const listener of session.listeners) {
      listener(compactionDelta);
      listener(compactionDelta);
    }

    expect(
      view.messages.filter((message) => message.model.type === "session_divider"),
    ).toHaveLength(1);
    expect(view.messages.filter((message) => message.id === "summary-entry")).toHaveLength(1);
    expect(view.messages).toContainEqual(
      expect.objectContaining({
        model: { type: "session_divider", label: "compacted context" },
      }),
    );
    expect(view.messages).toContainEqual({
      id: "summary-entry",
      model: { type: "user", text: "compacted summary" },
    });
    expect(view.messages.filter((message) => message.id === retainedEntry.id)).toEqual([
      {
        id: retainedEntry.id,
        model: { type: "user", text: "retained before compaction" },
      },
    ]);
    expect(view.transcriptNotices).toContainEqual({
      text: "retained 1 recent message",
      tone: "default",
    });

    const attachedSession = new FakeSession(compactedSnapshot);
    const attachedView = new FakeView();
    const attachedController = new SessionChatController({
      config: EMPTY_CLIENT_CONFIG,
      view: attachedView,
      session: attachedSession,
      snapshot: await attachedSession.snapshot(),
      targetLabel: "in-process",
    });
    attachedController.start();
    expect(attachedView.messages.some((message) => message.id === retainedEntry.id)).toBe(false);
    expect(attachedView.messages).toContainEqual({
      id: "summary-entry",
      model: { type: "user", text: "compacted summary" },
    });
    expect(attachedView.messages.some((message) => message.model.type === "session_divider")).toBe(
      false,
    );

    const replacedRetainedEntry = {
      id: retainedEntry.id,
      state: "committed",
      modelVisible: true,
      message: {
        role: "user",
        content: [{ type: "text", text: "updated retained message" }],
        timestamp: 2,
      },
    };
    for (const listener of session.listeners) {
      listener(createMessageReplaceDelta(session.id, 2, replacedRetainedEntry));
    }
    expect(view.messages.find((message) => message.id === retainedEntry.id)?.model).toEqual({
      type: "user",
      text: "retained before compaction",
    });

    const nextEntry = {
      id: "post-compaction-entry",
      state: "committed",
      modelVisible: true,
      message: {
        role: "user",
        content: [{ type: "text", text: "after compaction" }],
        timestamp: 3,
      },
    };
    for (const listener of session.listeners) {
      listener(createMessageAppendDelta(session.id, 3, nextEntry));
    }
    expect(view.messages).toContainEqual({
      id: nextEntry.id,
      model: { type: "user", text: "after compaction" },
    });

    const secondCompactedText = prependTauUserMetadata("second compacted summary", [
      {
        type: "auto-compaction",
        version: 1,
        summary: "second compacted summary",

        cutType: "turn-boundary",
        retainedMessageCount: 1,
      },
    ]);
    const secondCompactedSnapshot = createProtocolSnapshot({
      sessionId: "session-1",
      revision: 5,
      agentState: { revision: 4, modelContextKey: "fixture-context" },
      historyEntries: [
        {
          id: "second-summary-entry",
          message: {
            role: "user",
            content: [{ type: "text", text: secondCompactedText }],
          },
        },
        nextEntry,
        {
          id: "second-continuation-entry",
          message: {
            role: "user",
            content: [{ type: "text", text: continuationText }],
          },
        },
      ],
      timeline: [
        {
          type: "message",
          id: "timeline-second-summary-entry",
          messageId: "second-summary-entry",
        },
      ],
    });
    secondCompactedSnapshot.timeline.epoch = 3;
    for (const listener of session.listeners) {
      listener(
        createResetDelta(session.id, 4, secondCompactedSnapshot, {
          type: "compaction",
          previousEpoch: 2,
          epoch: 3,
          kind: "auto",
          cutType: "turn-boundary",
          retainedMessageCount: 1,
        }),
      );
    }

    expect(
      view.messages.filter((message) => message.model.type === "session_divider"),
    ).toHaveLength(2);
    expect(view.messages.filter((message) => message.id === nextEntry.id)).toEqual([
      {
        id: nextEntry.id,
        model: { type: "user", text: "after compaction" },
      },
    ]);
    expect(view.messages).toContainEqual({
      id: "second-summary-entry",
      model: { type: "user", text: "second compacted summary" },
    });
    await attachedController.dispose();
  });

  it("targets assistant commands from the compacted snapshot instead of frozen UI history", async () => {
    const frozenAssistant = {
      id: "frozen-assistant",
      message: createAssistantMessage("frozen response"),
    };
    const retainedAssistant = {
      id: "retained-assistant",
      message: createAssistantMessage("retained snapshot response"),
    };
    const runningSnapshot = createProtocolSnapshot({
      sessionId: "session-1",
      revision: 1,
      agentState: { revision: 1, modelContextKey: "fixture-context" },
      historyEntries: [frozenAssistant],
      timeline: [
        {
          type: "message",
          id: `timeline-${frozenAssistant.id}`,
          messageId: frozenAssistant.id,
        },
      ],
    });
    const compactedText = prependTauUserMetadata("compacted summary", [
      {
        type: "auto-compaction",
        version: 1,
        summary: "compacted summary",

        cutType: "turn-boundary",
        retainedMessageCount: 1,
      },
    ]);
    const continuationText = prependTauUserMetadata("", [
      { type: "auto-compaction-continuation", version: 1 },
    ]);
    const compactedSnapshot = createProtocolSnapshot({
      sessionId: "session-1",
      revision: 2,
      agentState: { revision: 2, modelContextKey: "fixture-context" },
      historyEntries: [
        {
          id: "summary-entry",
          message: {
            role: "user",
            content: [{ type: "text", text: compactedText }],
          },
        },
        retainedAssistant,
        {
          id: "continuation-entry",
          message: {
            role: "user",
            content: [{ type: "text", text: continuationText }],
          },
        },
      ],
      timeline: [{ type: "message", id: "timeline-summary-entry", messageId: "summary-entry" }],
    });
    compactedSnapshot.timeline.epoch = 2;
    const session = new FakeSession(runningSnapshot);
    const view = new FakeView();
    const { controller } = await createControllerHarness({
      view,
      session,
      targetLabel: "in-process",
    });
    controller.start();

    for (const listener of session.listeners) {
      listener(
        createResetDelta(session.id, 1, compactedSnapshot, {
          type: "compaction",
          previousEpoch: 1,
          epoch: 2,
          kind: "auto",
          cutType: "turn-boundary",
          retainedMessageCount: 1,
        }),
      );
    }
    expect(view.messages).toContainEqual({
      id: frozenAssistant.id,
      model: expect.objectContaining({ type: "assistant" }),
    });
    expect(view.messages.some((message) => message.id === retainedAssistant.id)).toBe(false);

    const bin = await mkdtemp(join(tmpdir(), "tau-clipboard-bin-"));
    const clipboard = join(bin, "clipboard.txt");
    const originalPath = process.env.PATH;
    try {
      for (const provider of ["wl-copy", "xclip", "xsel", "pbcopy"]) {
        await writeFile(join(bin, provider), `#!/bin/sh\nexec /bin/cat > '${clipboard}'\n`);
        await chmod(join(bin, provider), 0o755);
      }
      process.env.PATH = bin;
      controller.getInputHandlers().onSubmit("/copy-text");
      await vi.waitFor(async () =>
        expect(await readFile(clipboard, "utf8")).toBe("retained snapshot response"),
      );
    } finally {
      process.env.PATH = originalPath;
      await rm(bin, { recursive: true, force: true });
    }
  });

  it("stops visible running state when submit fails before snapshot recovery returns", async () => {
    const session = new FakeSession();
    session.rejectSubmit = true;
    const view = new FakeView();
    const { controller } = await createControllerHarness({
      view,
      session,
      themeIds: ["gold"],
    });

    controller.start();
    session.snapshot = vi.fn(async () => await new Promise(() => {}));
    controller.getInputHandlers().onSubmit("hello session");
    await flush();

    expect(view.feedback).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          text: "failed to run assistant turn",
          tone: "error",
          content: ["submit rejected"],
        }),
      ]),
    );
    expect(view.workingIconStarts).toBe(1);
    expect(view.workingIconStops).toBe(1);
    expect(controller.isStreaming).toBe(false);
    expect(view.status.footer.type).toBe("regular");
  });

  it("hides raw user-message metadata and hidden system blocks from snapshots", async () => {
    const rawText = prependTauUserMetadata("<system>hidden</system>\n\nvisible", [
      {
        type: "compaction",
        version: 1,
        summary: "summary",
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
    const { controller } = await createControllerHarness({
      view,
      session,
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
    const { controller } = await createControllerHarness({
      view,
      session,
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

  it("stops visible running state on idle delta before a submitted turn response resolves", async () => {
    const { session, view, controller } = await createControllerHarness({
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
    expect(view.status.footer.type).toBe("regular");

    controller.getInputHandlers().onQueueSubmit("queued while response pending");
    await flush();

    expect(delayedSubmit).toHaveBeenCalledTimes(1);
    expect(session.queue).toHaveBeenCalledWith("queued while response pending");
    expect(view.feedback).toEqual([]);

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
    const { session, controller } = await createControllerHarness({
      targetLabel: "in-process",
    });
    controller.start();
    controller.manualCompactionInProgress = true;

    expect(controller.getInputHandlers().beforeSubmit?.("keep this text")).toBe(false);
    expect(session.queue).not.toHaveBeenCalled();
    expect(session.submit).not.toHaveBeenCalled();
  });

  it("preserves hidden instructions through editor restoration and queued resubmission", async () => {
    const { session, view, controller } = await createControllerHarness({});
    const editor = new CustomEditor(createUiTheme("plain"));
    const handlers = controller.getInputHandlers();
    editor.onChange = handlers.onChange;
    editor.beforeSubmit = handlers.beforeSubmit;
    editor.onSubmit = handlers.onSubmit;
    editor.onQueueSubmit = handlers.onQueueSubmit;
    view.getEditorText = () => editor.getText();
    view.setEditorText = (text) => editor.setText(text);
    const pending = (id, mode, text, hiddenSystemMessages) => ({
      id,
      mode,
      text: formatTauUserText({ text, hiddenSystemMessages }),
    });
    try {
      session.cancelPendingMessages.mockResolvedValueOnce({
        cancelled: [pending("draft", "queue", "existing draft", ["draft guidance"])],
      });
      await controller.cancelPendingMessagesIntoEditor();
      editor.handleInput(" edited");
      session.cancelPendingMessages.mockResolvedValueOnce({
        cancelled: [
          pending("steer", "steer", "change direction", ["A", "B"]),
          pending("queue", "queue", "keep literal <system>C</system> text", ["A"]),
        ],
      });
      await controller.cancelPendingMessagesIntoEditor();
      const visible =
        "existing draft edited\n\n---\n\nchange direction\n\n---\n\nkeep literal <system>C</system> text";
      expect(editor.getText()).toBe(visible);
      controller.isStreaming = true;
      const submit = async (count) => {
        editor.handleInput("\x1b[13;5u");
        await waitUntil(() => session.queue.mock.calls.length === count);
        return session.queue.mock.calls[count - 1][0];
      };
      const first = await submit(1);
      expect(splitTauUserText(first)).toMatchObject({
        displayText: visible,
        hiddenSystemBlocks: ["draft guidance", "A", "B", "A"].map((text) => ({ text })),
      });
      session.cancelPendingMessages.mockResolvedValueOnce({
        cancelled: [{ id: "restored", mode: "queue", text: first }],
      });
      await controller.cancelPendingMessagesIntoEditor();
      expect(editor.getText()).toBe(visible);
      expect(await submit(2)).toBe(first);
      editor.handleInput("unrelated text");
      expect(await submit(3)).toBe("unrelated text");
      session.cancelPendingMessages.mockResolvedValueOnce({
        cancelled: [{ id: "cleared", mode: "queue", text: first }],
      });
      await controller.cancelPendingMessagesIntoEditor();
      editor.setText("");
      editor.handleInput("fresh draft");
      expect(await submit(4)).toBe("fresh draft");
    } finally {
      await controller.dispose();
    }
  });

  it("routes steering through the session protocol while a submitted turn is active", async () => {
    const { session, view, controller } = await createControllerHarness({
      targetLabel: "in-process",
    });
    controller.start();
    controller.isStreaming = true;
    controller.submittedTurnInProgress = true;

    controller.getInputHandlers().onSubmit("change direction");
    await flush();

    expect(session.steer).toHaveBeenCalledWith("change direction");
    expect(view.feedback).toEqual([]);
  });

  it("does not dispatch or queue commands while a submitted turn response is pending", async () => {
    const { session, view, controller } = await createControllerHarness({
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

    expect(view.feedback).toContainEqual(
      expect.objectContaining({
        tone: "default",
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
    const { controller } = await createControllerHarness({
      view,
      session,
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

  it("preserves append order for mixed targeted timeline changes", async () => {
    const snapshot = updateSnapshot(
      createSnapshot([
        {
          id: "history-1",
          message: { role: "user", content: [{ type: "text", text: "first" }] },
        },
      ]),
      { revision: 3 },
    );
    const session = new FakeSession(snapshot);
    const view = new FakeView();
    const controller = new SessionChatController({
      config: EMPTY_CLIENT_CONFIG,
      view,
      session,
      snapshot: await session.snapshot(),
      targetLabel: "local",
    });

    controller.start();
    const addMessageSpy = vi.spyOn(view, "addMessage");
    const nextMessage = {
      id: "history-2",
      state: "committed",
      modelVisible: true,
      message: {
        role: "user",
        content: [{ type: "text", text: "second" }],
        timestamp: 3,
      },
    };
    const delta = {
      version: SESSION_PROTOCOL_VERSION,
      type: "session.delta",
      sessionId: session.id,
      fromRevision: 3,
      toRevision: 4,
      cause: { type: "maintenance" },
      delta: {
        type: "snapshot.patch",
        changes: [
          {
            type: "timeline.append",
            item: {
              type: "notice",
              id: "notice-between",
              sequence: snapshot.timeline.sequence + 1,
              createdAt: 2,
              notice: {
                kind: "tau.test.notice",
                version: 1,
                severity: "info",
                subject: { type: "session" },
                presentation: { title: "between" },
                data: {},
              },
            },
          },
          { type: "message.append", message: nextMessage },
          {
            type: "timeline.append",
            item: {
              type: "message",
              id: "timeline-history-2",
              sequence: snapshot.timeline.sequence + 2,
              createdAt: 3,
              messageId: nextMessage.id,
            },
          },
        ],
      },
    };
    session.snapshotValue = applySessionProtocolDelta(session.snapshotValue, delta);
    for (const listener of session.listeners) {
      listener(delta);
    }

    expect(addMessageSpy.mock.calls).toEqual([
      [{ type: "transcript_notice", title: "between", tone: "default" }, "notice-between"],
      [{ type: "user", text: "second" }, "history-2"],
    ]);
    expect(view.messages.slice(-2).map((message) => message.id)).toEqual([
      "notice-between",
      "history-2",
    ]);
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
      config: EMPTY_CLIENT_CONFIG,
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

  it("opens a filesystem snapshot with an older tool presentation facet", async () => {
    const baseSnapshot = createSnapshot();
    const result = Array.from({ length: 10 }, (_, index) => `result ${index + 1}`).join("\n");
    const snapshot = updateSnapshot(baseSnapshot, {
      messages: [
        ...baseSnapshot.messages,
        {
          id: "assistant-tools",
          state: "committed",
          modelVisible: true,
          message: createAssistantToolCallMessage([
            {
              type: "toolCall",
              id: "tool-a",
              name: "bash",
              arguments: { command: "do-not-render-this-command" },
            },
          ]),
        },
        {
          id: "tool-a-result",
          state: "committed",
          modelVisible: true,
          message: {
            role: "toolResult",
            toolCallId: "tool-a",
            toolName: "bash",
            content: [{ type: "text", text: result }],
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
          id: "timeline-tool-a-result",
          messageId: "tool-a-result",
        },
      ],
      tools: {
        "tool-a": {
          id: "tool-a",
          toolCallId: "tool-a",
          toolName: "bash",
          call: { messageId: "assistant-tools", contentIndex: 0 },
          status: "succeeded",
          resultMessageId: "tool-a-result",
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
                type: "bash_execution",
                toolCallId: "tool-a",
                command: "do-not-render-this-command",
                headerTarget: "do-not-render-this-command",
              },
            ],
          },
        },
      },
    });
    const directory = join(
      tmpdir(),
      `tau-old-tool-presentation-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
    );
    try {
      const store = new FileSessionStore({ directory });
      await store.commitSessionSnapshot(snapshot);
      const storedSnapshot = await store.loadSession(snapshot.sessionId);
      expect(storedSnapshot).toBeDefined();
      if (!storedSnapshot) throw new Error("expected stored session snapshot");

      const session = new FakeSession(storedSnapshot);
      const view = new FakeView();
      const { controller } = await createControllerHarness({
        view,
        session,
      });

      controller.start();

      expect(view.messages.some((message) => message.id === "tool-a-result")).toBe(false);
      expect(view.toolModels).toEqual([
        expect.objectContaining({
          toolCallId: "tool-a",
          status: "succeeded",
          presentation: expect.objectContaining({
            actionByStatus: expect.objectContaining({ succeeded: "completed" }),
            subject: "bash",
            details: [
              { text: "result 1", wrap: "character" },
              { text: "result 2", wrap: "character" },
              { text: "result 3", wrap: "character" },
              { text: "…4 more lines…", wrap: "word" },
              { text: "result 8", wrap: "character" },
              { text: "result 9", wrap: "character" },
              { text: "result 10", wrap: "character" },
            ],
          }),
        }),
      ]);
      expect(JSON.stringify(view.toolModels)).not.toContain("do-not-render-this-command");
      await controller.dispose();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
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
          version: TOOL_UI_FACET_VERSION,
          data: { events: [queuedEvent] },
        },
      },
    });
    const session = new FakeSession(snapshot);
    const view = new FakeView();
    const { controller } = await createControllerHarness({
      view,
      session,
    });

    controller.start();
    const resetCount = view.resetToolUiSession.mock.calls.length;
    const updateMessageSpy = vi.spyOn(view, "updateMessage");
    const updateAssistantMessageSpy = vi.spyOn(view, "updateAssistantMessage");
    const delta = {
      version: SESSION_PROTOCOL_VERSION,
      type: "session.delta",
      sessionId: session.id,
      fromRevision: 3,
      toRevision: 4,
      cause: { type: "tool-run" },
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
    expect(updateMessageSpy).toHaveBeenCalledTimes(1);
    expect(updateMessageSpy.mock.calls[0]?.[1].type).toBe("tool");
    expect(updateAssistantMessageSpy).not.toHaveBeenCalled();
    updateMessageSpy.mockClear();

    const facetDelta = {
      version: SESSION_PROTOCOL_VERSION,
      type: "session.delta",
      sessionId: session.id,
      fromRevision: 4,
      toRevision: 5,
      cause: { type: "tool-run" },
      delta: {
        type: "snapshot.patch",
        changes: [
          {
            type: "facet.set",
            facet: {
              id: "tool-ui-tool-a",
              subject: { type: "tool", id: "tool-a" },
              kind: "tau.tool-ui-events",
              version: TOOL_UI_FACET_VERSION,
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
    expect(updateMessageSpy).toHaveBeenCalledTimes(1);
    expect(updateMessageSpy.mock.calls[0]?.[1].type).toBe("tool");
    expect(updateAssistantMessageSpy).not.toHaveBeenCalled();
    expect(view.status.footer.sessionCost).toBe("$0.42");
    expect(controller.snapshot.tools["tool-a"].status).toBe("running");
    await controller.dispose();
  });

  it("applies typed subagent activities without replaying tool UI state", async () => {
    const initialAgent = createAgentRun();
    const nextAgent = createAgentRun({
      costTotal: 0.02,
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
    session.subagentActivitiesValue = {
      revision: 2,
      agents: {
        [initialAgent.id]: {
          runRevision: 1,
          activities: [{ type: "assistant", text: "reading files" }],
        },
      },
    };
    const view = new FakeView();
    const { controller } = await createControllerHarness({
      view,
      session,
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
      cause: { type: "agent-run" },
      delta: {
        type: "snapshot.patch",
        changes: [
          { type: "cost.set", costTotal: 0.02 },
          { type: "agent.set", agent: nextAgent },
        ],
      },
    };
    session.snapshotValue = applySessionProtocolDelta(session.snapshotValue, delta);

    for (const listener of session.listeners) {
      listener(delta);
    }
    session.subagentActivitiesValue = {
      revision: 3,
      agents: {
        [initialAgent.id]: {
          runRevision: 1,
          activities: [
            { type: "assistant", text: "reading files" },
            { type: "assistant", text: "checking protocol" },
          ],
        },
      },
    };
    for (const listener of session.subagentActivitiesListeners) {
      listener({
        version: SESSION_PROTOCOL_VERSION,
        type: "session.subagentActivities",
        sessionId: session.id,
        revision: session.subagentActivitiesValue.revision,
        changes: [
          {
            type: "agent.set",
            agentId: initialAgent.id,
            state: structuredClone(session.subagentActivitiesValue.agents[initialAgent.id]),
          },
        ],
      });
    }

    expect(view.resetToolUiSession).toHaveBeenCalledTimes(resetCount);
    expect(view.subagentEvents).toEqual([expect.objectContaining({ type: "subagent_updated" })]);
    expect(view.subagentSnapshots).toEqual([
      expect.objectContaining({
        state: expect.objectContaining({ id: "agent-1", costTotal: 0.02 }),
        activities: [
          { type: "assistant", text: "reading files" },
          { type: "assistant", text: "checking protocol" },
        ],
      }),
    ]);
    expect(controller.snapshot.agents["agent-1"]).not.toHaveProperty("progress");
    await controller.dispose();
  });

  it("runs direct shell commands in the session execution environment", async () => {
    const session = new FakeSession();
    const outputLines = Array.from({ length: 40 }, (_, index) => `line ${index + 1}`);
    session.exec.mockResolvedValueOnce(
      createProtocolExecResult({ output: `${outputLines.join("\n")}\n` }),
    );
    const view = new FakeView();
    const { controller } = await createControllerHarness({
      view,
      session,
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
            details: [
              ...outputLines.slice(0, 16).map((text) => ({ text, wrap: "character" })),
              { text: "…8 more lines…", wrap: "word" },
              ...outputLines.slice(-16).map((text) => ({ text, wrap: "character" })),
            ],
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
    const outputLines = Array.from({ length: 40 }, (_, index) => `line ${index + 1}`);
    session.exec.mockResolvedValueOnce(
      createProtocolExecResult({ output: `${outputLines.join("\n")}\n` }),
    );
    const view = new FakeView();
    const { controller } = await createControllerHarness({
      view,
      session,
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
            details: [
              ...outputLines.slice(0, 16).map((text) => ({ text, wrap: "character" })),
              { text: "…8 more lines…", wrap: "word" },
              ...outputLines.slice(-16).map((text) => ({ text, wrap: "character" })),
            ],
          }),
        }),
      ]),
    );
  });

  it("interrupts manual compaction with Escape and allows later compactions to be interrupted", async () => {
    const session = new FakeSession();
    let pendingCompact;
    session.compact = vi.fn(() => {
      pendingCompact = deferred();
      return pendingCompact.promise;
    });
    session.interrupt = vi.fn(async () => {
      pendingCompact.reject(new Error("compaction aborted"));
      return { interrupted: true, isTurnRunning: false };
    });
    const view = new FakeView();
    const { controller } = await createControllerHarness({
      view,
      session,
    });
    controller.start();

    for (const command of ["/compact-all", "/compact-keep-last"]) {
      controller.getInputHandlers().onSubmit(command);
      await flush();
      expect(view.status.footer).toEqual({ type: "activity", label: "compacting context" });

      controller.getInputHandlers().onEscape();
      controller.getInputHandlers().onEscape();
      await flush();
      expect(view.status.footer.type).toBe("regular");
    }
    expect(session.interrupt).toHaveBeenCalledTimes(2);
    controller.getInputHandlers().onEscape();
    await flush();
    expect(session.interrupt).toHaveBeenCalledTimes(2);
  });

  it("keeps a returned diff review uncommitted when session recording fails", async () => {
    const session = new FakeSession();
    session.record = vi.fn(async () => {
      throw new Error("record failed");
    });
    const view = new FakeView();
    const { controller } = await createControllerHarness({
      view,
      session,
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
    expect(view.feedback).toContainEqual(
      expect.objectContaining({
        tone: "error",
        text: "failed to run diff review",
        content: ["record failed"],
      }),
    );
    expect(view.feedback).not.toContainEqual(
      expect.objectContaining({ tone: "default", text: expect.stringContaining("added") }),
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
    const { controller } = await createControllerHarness({
      view,
      session,
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
    expect(view.feedback).toContainEqual(
      expect.objectContaining({
        tone: "default",
        text: "diff review added; no assistant turn started",
      }),
    );
    expect(view.feedback).not.toContainEqual(
      expect.objectContaining({
        tone: "error",
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
      config: EMPTY_CLIENT_CONFIG,
      view,
      session,
      snapshot: await session.snapshot(),
      createSession,
      targetLabel: "ws://host",
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
    expect(view.feedback).toContainEqual({
      text: "wait for tau to become idle before submitting input",
      tone: "default",
    });

    releaseRecord.resolve();
    await review;

    expect(session.record).toHaveBeenCalledTimes(1);
    expect(session.closeEphemeralContext).toHaveBeenCalledWith("ephemeral-1");
  });

  it("waits for pending-message restoration before starting dictation", async () => {
    const session = new FakeSession();
    const view = new FakeView();
    view.editorText = "draft";
    const { controller } = await createControllerHarness({
      view,
      session,
      targetLabel: "in-process",
    });
    const deferred = Promise.withResolvers();
    session.cancelPendingMessages = () => deferred.promise;
    const task = controller.cancelPendingMessagesIntoEditor();
    controller.startListenCapture = vi.fn(async () => {});
    await controller.toggleListenCapture();
    expect(controller.startListenCapture).not.toHaveBeenCalled();
    deferred.resolve({
      text: "loaded",
      cancelled: [],
      snapshot: await session.snapshot(),
      removedEntryIds: [],
    });
    await task;
    await controller.toggleListenCapture();
    expect(controller.startListenCapture).toHaveBeenCalledTimes(1);
    await controller.dispose();
  });

  it.each(["commit", "deadline"])(
    "replaces Scribe previews and unlocks editing on %s",
    async (finalization) => {
      const audioPath = join(tmpdir(), `tau-session-listen-scribe-${Date.now()}.wav`);
      const pcm = Buffer.alloc(6400, 1);
      const socket = new EventEmitter();
      const socketEvents = [];
      const audioSent = Promise.withResolvers();
      socket.send = vi.fn((data, callback) => {
        const event = JSON.parse(data);
        socketEvents.push(event);
        callback?.();
        if (!event.commit) audioSent.resolve();
      });
      socket.close = vi.fn();
      socket.terminate = vi.fn();
      const webSocketFactory = vi.fn(() => {
        queueMicrotask(() =>
          socket.emit("message", JSON.stringify({ message_type: "session_started" })),
        );
        return socket;
      });
      const emitTranscript = (type, text) =>
        socket.emit("message", JSON.stringify({ message_type: `${type}_transcript`, text }));
      const fetchImpl = vi.fn();
      const spawn = vi.fn(async (command, _args, options = {}) => {
        if (command === "mktemp") {
          return createSpawnResult({ stdout: `${audioPath}\n` });
        }
        if (command === "ffmpeg") {
          const stdout = new EventEmitter();
          options.onSpawn({ stdout });
          queueMicrotask(() => stdout.emit("data", pcm));
          return await new Promise((resolve) => {
            options.signal.addEventListener("abort", () => {
              stdout.emit("data", Buffer.from([5, 6]));
              resolve(createSpawnResult({ aborted: true }));
            });
          });
        }
        throw new Error(`unexpected command: ${command}`);
      });
      const session = new FakeSession();
      const view = new FakeView();
      const editor = new CustomEditor(createUiTheme("plain"));
      const prefix = "header\nprefix ";
      const suffix = "suffix\nfooter";
      editor.setText(prefix + suffix);
      editor.handleInput("\x01");
      editor.handleInput("\x1b[A");
      for (let i = 0; i < 7; i++) editor.handleInput("\x1b[C");
      const cursor = editor.getCursor();
      view.beginEditorTextPreview = () => editor.beginTextPreview();
      view.getEditorText = () => editor.getText();
      view.setEditorInputEnabled = (enabled) => {
        view.editorEnabledUpdates.push(enabled);
        editor.setInputEnabled(enabled);
      };
      const { controller } = await createControllerHarness({
        view,
        session,
        deps: createMockDeps(spawn),
        config: {
          apiKeys: { elevenlabs: "eleven-key" },
        },
        speechToTextDeps: { webSocketFactory, fetchImpl },
      });

      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        controller.start();
        await controller.onUserInput("/listen");
        expect(view.status.editor.mode).toBe("recording");
        await writeFile(audioPath, Buffer.alloc(2048, 1));

        await audioSent.promise;
        expect(socketEvents).toHaveLength(1);
        for (const [type, text, preview] of [
          ["partial", "English", "English"],
          ["committed", "English.", "English."],
          ["partial", "Suomeksi myös", "English. Suomeksi myös"],
        ]) {
          emitTranscript(type, text);
          expect(editor.getText()).toBe(prefix + preview + suffix);
          const previewCursor = editor.getCursor();
          for (const key of ["x", "\x1b[D", "\r", "\x7f", "\x1b[200~paste\x1b[201~"])
            editor.handleInput(key);
          expect(editor.getText()).toBe(prefix + preview + suffix);
          expect(editor.getCursor()).toEqual(previewCursor);
        }
        controller.getInputHandlers().onToggleRecording();
        await vi.waitFor(() => expect(socketEvents.at(-1).commit).toBe(true), { timeout: 2000 });
        expect(view.editorEnabledUpdates.at(-1)).toBe(false);
        expect(editor.getText()).toBe(`${prefix}English. Suomeksi myös${suffix}`);
        if (finalization === "commit") {
          emitTranscript("committed", "Suomeksi myös.");
          expect(editor.getText()).toBe(`${prefix}English. Suomeksi myös.${suffix}`);
          expect(view.editorEnabledUpdates.at(-1)).toBe(false);
        } else {
          await vi.advanceTimersByTimeAsync(1000);
          expect(socket.close).not.toHaveBeenCalled();
          expect(view.editorEnabledUpdates.at(-1)).toBe(false);
          emitTranscript("partial", "Suomeksi myös!");
          await vi.advanceTimersByTimeAsync(1000);
        }
        expect(socket.close).toHaveBeenCalledOnce();
        await controller.listenTransition;
        expect(view.editorEnabledUpdates.at(-1)).toBe(true);
      } finally {
        try {
          await controller.dispose();
        } finally {
          try {
            await rm(audioPath, { force: true });
          } finally {
            vi.useRealTimers();
          }
        }
      }

      const finalText =
        finalization === "commit" ? "English. Suomeksi myös." : "English. Suomeksi myös!";
      expect(view.editorEnabledUpdates).toContain(true);
      expect(editor.getText()).toBe(`${prefix}${finalText}${suffix}`);
      expect(editor.getCursor()).toEqual({ line: 1, col: 7 + finalText.length });
      editor.handleInput("\x1b[45;5u");
      expect(editor.getText()).toBe(prefix + suffix);
      expect(editor.getCursor()).toEqual(cursor);
      expect(
        Buffer.concat(
          socketEvents.map(({ audio_base_64 }) => Buffer.from(audio_base_64, "base64")),
        ),
      ).toEqual(Buffer.concat([pcm, Buffer.from([5, 6])]));
      expect(socketEvents.slice(0, -1).every(({ commit }) => !commit)).toBe(true);
      expect(socketEvents.at(-1).commit).toBe(true);
      expect(spawn).toHaveBeenNthCalledWith(
        2,
        "ffmpeg",
        expect.arrayContaining(["-ar", "16000", "-f", "s16le", "pipe:1"]),
        expect.objectContaining({
          detached: true,
          killProcessGroup: true,
          captureOutput: "stderr",
          stdio: ["ignore", "pipe", "pipe"],
        }),
      );
      expect(session.submit).not.toHaveBeenCalled();
      expect(fetchImpl).not.toHaveBeenCalled();
    },
  );

  describe("speech cleanup styles", () => {
    const createRecordingHarness = async (cleanupResponse, cleanupStyle) => {
      const audioPath = join(
        tmpdir(),
        `tau-session-listen-style-${Date.now()}-${Math.random()}.wav`,
      );
      await writeFile(audioPath, Buffer.alloc(2048, 1));
      const spawn = vi.fn(async (command, _args, options = {}) => {
        if (command === "mktemp") return createSpawnResult({ stdout: `${audioPath}\n` });
        if (command === "ffmpeg") {
          const stdout = new EventEmitter();
          options.onSpawn({ stdout });
          queueMicrotask(() => stdout.emit("data", Buffer.from([1, 2])));
          return await new Promise((resolve) => {
            options.signal.addEventListener("abort", () => {
              resolve(createSpawnResult({ aborted: true }));
            });
          });
        }
        throw new Error(`unexpected command: ${command}`);
      });
      const cleanupRequests = [];
      const fetchImpl = vi.fn(async (input, options) => {
        expect(String(input)).toBe("https://api.openai.com/v1/responses");
        const request = { body: JSON.parse(options.body), signal: options.signal };
        cleanupRequests.push(request);
        const aborted = new Promise((_resolve, reject) => {
          options.signal.addEventListener("abort", () => reject(options.signal.reason), {
            once: true,
          });
        });
        return await Promise.race([cleanupResponse(request), aborted]);
      });
      const cleanupSockets = [];
      const webSocketFactory = vi.fn((url) => {
        expect(url).toBe("wss://api.openai.com/v1/responses");
        const socket = new EventEmitter();
        const abortController = new AbortController();
        socket.terminate = vi.fn(() => abortController.abort());
        socket.close = vi.fn();
        socket.send = vi.fn((data) => {
          const body = JSON.parse(data);
          if (body.generate === false) {
            queueMicrotask(() =>
              socket.emit(
                "message",
                JSON.stringify({
                  type: "response.completed",
                  response: { id: "warmup", status: "completed", output: [] },
                }),
              ),
            );
            return;
          }
          const request = { body, signal: abortController.signal };
          cleanupRequests.push(request);
          void cleanupResponse(request).then(async (response) => {
            socket.emit(
              "message",
              JSON.stringify(
                response.ok
                  ? {
                      type: "response.completed",
                      response: await response.json(),
                    }
                  : { type: "error" },
              ),
            );
          });
        });
        cleanupSockets.push(socket);
        queueMicrotask(() => socket.emit("open"));
        return socket;
      });
      const harness = await createControllerHarness({
        deps: createMockDeps(spawn),
        config: {
          apiKeys: { elevenlabs: "eleven-key", openai: "openai-key" },
          speech: { cleanupStyle },
        },
        speechToTextDeps: { fetchImpl, webSocketFactory },
      });
      const editor = new CustomEditor(createUiTheme("plain"));
      const handlers = harness.controller.getInputHandlers();
      editor.onDisabledTab = handlers.onCycleRecordingStyle;
      editor.onDisabledSubmit = handlers.onDisabledSubmit;
      editor.beforeSubmit = handlers.beforeSubmit;
      editor.onChange = handlers.onChange;
      editor.onSubmit = handlers.onSubmit;
      editor.onQueueSubmit = handlers.onQueueSubmit;
      harness.view.beginEditorTextPreview = () => editor.beginTextPreview();
      harness.view.getEditorText = () => editor.getText();
      harness.view.setEditorInputEnabled = (enabled) => {
        harness.view.editorEnabledUpdates.push(enabled);
        editor.setInputEnabled(enabled);
      };
      harness.view.submitEditor = vi.fn((mode) => editor.submit(mode));
      harness.controller.createSpeechTranscription = vi.fn(() => ({
        appendAudio: vi.fn(),
        finish: vi.fn(async () => "um so fix the bug"),
        abort: vi.fn(),
      }));
      return { ...harness, audioPath, editor, cleanupRequests, cleanupSockets };
    };
    const cleanedResponse = (text) =>
      Response.json({
        status: "completed",
        output: [{ type: "message", content: [{ type: "output_text", text }] }],
      });

    it("cycles the style with Tab only while recording and applies it on stop", async () => {
      const cleanup = Promise.withResolvers();
      const { controller, view, session, editor, audioPath, cleanupRequests, cleanupSockets } =
        await createRecordingHarness(() => cleanup.promise);
      try {
        controller.start();
        controller.getInputHandlers().onCycleRecordingStyle();
        expect(view.status.editor).toEqual(expect.objectContaining({ mode: "normal" }));
        expect(view.status.editor).not.toHaveProperty("recordingStyle");
        editor.setText("draft ");
        await controller.onUserInput("/listen");
        expect(view.status.editor).toMatchObject({ mode: "recording", recordingStyle: "off" });
        editor.handleInput("\t");
        expect(view.status.editor.recordingStyle).toBe("default");
        editor.handleInput("\t");
        expect(view.status.editor.recordingStyle).toBe("off");
        editor.handleInput("\t");
        expect(view.status.editor.recordingStyle).toBe("default");
        expect(editor.getText()).toBe("draft ");
        await flush();
        expect(cleanupSockets).toHaveLength(2);
        expect(cleanupSockets[0].terminate).toHaveBeenCalledOnce();
        expect(JSON.parse(cleanupSockets[1].send.mock.calls[0][0])).toMatchObject({
          generate: false,
          input: [],
          store: false,
        });
        expect(cleanupRequests).toEqual([]);
        expect(controller.createSpeechTranscription).toHaveBeenCalledOnce();

        editor.handleInput("\r");
        await waitUntil(() => cleanupRequests.length === 1);
        expect(view.status.editor.mode).toBe("normal");
        expect(view.status.footer).toEqual({ type: "activity", label: expect.any(String) });
        expect(editor.getText()).toBe("draft um so fix the bug");
        expect(view.editorEnabledUpdates.at(-1)).toBe(false);
        editor.handleInput("\t");
        expect(cleanupRequests[0].body.previous_response_id).toBe("warmup");
        expect(cleanupRequests[0].body.model).toBe("gpt-6.1-terra");
        expect(JSON.parse(cleanupRequests[0].body.input).transcript).toBe("um so fix the bug");
        expect(session.submit).not.toHaveBeenCalled();

        cleanup.resolve(cleanedResponse("So, fix the bug."));
        await controller.listenTransition;
        await waitUntil(() => session.submit.mock.calls.length === 1);
        expect(stripTauUserDisplayText(session.submit.mock.calls[0][0])).toBe(
          "draft So, fix the bug.",
        );
        expect(view.status.footer.type).toBe("regular");
        expect(view.transcriptNotices).toEqual([]);

        await controller.toggleListenCapture();
        expect(view.status.editor).toMatchObject({ mode: "recording", recordingStyle: "off" });
        await controller.cancelListenCapture();
      } finally {
        await controller.dispose();
        await rm(audioPath, { force: true });
      }
    });

    it("keeps the transcript and does not submit when cleanup fails", async () => {
      const { controller, view, session, editor, audioPath } = await createRecordingHarness(
        async () => new Response(null, { status: 500 }),
      );
      try {
        await controller.onUserInput("/listen");
        editor.handleInput("\t");
        editor.handleInput("\r");
        await waitUntil(() => controller.listenTransition === undefined);
        expect(editor.getText()).toBe("um so fix the bug");
        expect(view.editorEnabledUpdates.at(-1)).toBe(true);
        expect(view.transcriptNotices).toEqual([
          expect.objectContaining({ text: "failed to clean up speech", tone: "error" }),
        ]);
        expect(controller.retainedListenAudio).toBeUndefined();
        expect(view.submitEditor).not.toHaveBeenCalled();
        expect(session.submit).not.toHaveBeenCalled();
        expect(controller.editorHiddenSystemMessages).toHaveLength(1);
      } finally {
        await controller.dispose();
        await rm(audioPath, { force: true });
      }
    });

    it("drops pending cleanup on disposal without inserting stale text", async () => {
      const cleanup = Promise.withResolvers();
      const { controller, view, session, editor, audioPath, cleanupRequests } =
        await createRecordingHarness(() => cleanup.promise);
      try {
        editor.setText("draft");
        await controller.onUserInput("/listen");
        editor.handleInput("\t");
        controller.getInputHandlers().onToggleRecording();
        await waitUntil(() => cleanupRequests.length === 1);
        await controller.dispose();
        expect(cleanupRequests[0].signal.aborted).toBe(true);
        expect(editor.getText()).toBe("draft");
        cleanup.resolve(cleanedResponse("Stale."));
        await controller.listenTransition;
        await flush();
        expect(editor.getText()).toBe("draft");
        expect(view.editorEnabledUpdates.at(-1)).toBe(true);
        expect(view.transcriptNotices).toEqual([]);
        expect(controller.editorHiddenSystemMessages).toEqual([]);
        expect(session.submit).not.toHaveBeenCalled();
        await expect(readFile(audioPath)).rejects.toMatchObject({ code: "ENOENT" });
      } finally {
        await controller.dispose();
        await rm(audioPath, { force: true });
      }
    });
  });

  it("restores the draft after a failed preview and retries without duplicating it", async () => {
    const audioPath = join(tmpdir(), `tau-preview-retry-${Date.now()}.wav`);
    await writeFile(audioPath, Buffer.alloc(2048, 1));
    const session = new FakeSession();
    const view = new FakeView();
    view.editorText = "draft ";
    const { controller } = await createControllerHarness({
      view,
      session,
    });
    const result = Promise.withResolvers();
    const transcription = { finish: () => result.promise, abort: vi.fn() };
    try {
      controller.beginListenPreview();
      const preview = controller.listenPreview;
      preview.update("provisional");
      const task = controller.transcribeListenAudioFile(
        { audioPath, durationMs: 1000, cleanupStyle: "off" },
        transcription,
      );
      await waitUntil(() => controller.activeListenTranscription === transcription);
      result.reject(new Error("disconnected"));
      await task;
      expect(view.editorText).toBe("draft ");
      expect(view.editorEnabledUpdates.at(-1)).toBe(true);
      preview.update("stale");
      expect(view.editorText).toBe("draft ");
      controller.createSpeechTranscription = () => ({ finish: async () => "final", abort() {} });
      await controller.onUserInput("/listen retry");
      expect(view.editorText).toBe("draft final");
      expect(controller.retainedListenAudio).toBeUndefined();
      expect(session.submit).not.toHaveBeenCalled();
    } finally {
      await controller.dispose();
      await rm(audioPath, { force: true });
    }
  });

  it("rejects retained voice input longer than 20 minutes before provider work", async () => {
    const audioPath = join(tmpdir(), `tau-session-listen-too-long-${Date.now()}.wav`);
    await writeFile(audioPath, Buffer.alloc(2048, 1));
    const { view, controller } = await createControllerHarness({
      targetLabel: "in-process",
      deps: createMockDeps(),
    });
    controller.retainedListenAudio = {
      audioPath,
      durationMs: SPEECH_TO_TEXT_CLIENT_MAX_DURATION_MS + 1,
      cleanupStyle: "off",
    };
    controller.createSpeechTranscription = vi.fn();

    try {
      await controller.onUserInput("/listen retry");
    } finally {
      await rm(audioPath, { force: true });
    }

    expect(controller.createSpeechTranscription).not.toHaveBeenCalled();
    expect(view.transcriptNotices.at(-1)).toMatchObject({
      text: "failed to transcribe speech",
      tone: "error",
      content: [
        "audio is longer than 20 minutes",
        `recording retained at ${audioPath}`,
        "run /listen discard to delete it",
      ],
    });
  });

  it("discards retained voice input only when requested", async () => {
    const audioPath = join(tmpdir(), `tau-session-listen-discard-${Date.now()}.wav`);
    await writeFile(audioPath, Buffer.alloc(2048, 1));
    const { view, controller } = await createControllerHarness({
      targetLabel: "in-process",
      deps: createMockDeps(),
    });
    controller.retainedListenAudio = { audioPath, durationMs: 1_000, cleanupStyle: "off" };

    try {
      await controller.onUserInput("/listen discard");
      await expect(readFile(audioPath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(audioPath, { force: true });
    }

    expect(view.footerNotices.at(-1)).toEqual({
      text: "discarded retained speech recording",
      tone: "default",
      durationMs: 3000,
    });
    expect(controller.retainedListenAudio).toBeUndefined();
  });

  it("keeps the previous recording when microphone startup fails", async () => {
    const retainedPath = join(tmpdir(), `tau-session-listen-failure-retained-${Date.now()}.wav`);
    const nextPath = join(tmpdir(), `tau-session-listen-failure-next-${Date.now()}.wav`);
    await writeFile(retainedPath, Buffer.alloc(2048, 1));
    const spawn = vi.fn(async (command) => {
      if (command === "mktemp") return createSpawnResult({ stdout: `${nextPath}\n` });
      if (command === "ffmpeg") {
        return createSpawnResult({ stderr: "audio device unavailable", exitCode: 1 });
      }
      throw new Error(`unexpected command: ${command}`);
    });
    const { view, controller } = await createControllerHarness({
      targetLabel: "in-process",
      deps: createMockDeps(spawn),
      config: { apiKeys: { elevenlabs: "eleven-key" } },
      speechToTextDeps: { webSocketFactory: createIdleSpeechWebSocketFactory() },
    });
    controller.retainedListenAudio = {
      audioPath: retainedPath,
      durationMs: 1_000,
      cleanupStyle: "off",
    };

    try {
      await controller.onUserInput("/listen");
      await expect(readFile(retainedPath)).resolves.toHaveLength(2048);
      expect(controller.retainedListenAudio).toEqual({
        audioPath: retainedPath,
        durationMs: 1_000,
        cleanupStyle: "off",
      });
      expect(view.transcriptNotices.at(-1).tone).toBe("error");
    } finally {
      await rm(retainedPath, { force: true });
      await rm(nextPath, { force: true });
    }
  });

  it("discards stopped voice input when interrupted during audio reading", async () => {
    const audioPath = join(tmpdir(), `tau-session-listen-stopping-${Date.now()}.wav`);
    const audio = Buffer.alloc(2048, 1);
    await writeFile(audioPath, audio);
    const session = new FakeSession();
    const view = new FakeView();
    view.editorText = "draft ";
    const { controller } = await createControllerHarness({
      view,
      session,
      targetLabel: "in-process",
    });
    const capture = Promise.withResolvers();
    const read = Promise.withResolvers();
    const readSpy = vi.spyOn(listenCapture, "readListenAudio").mockReturnValueOnce(read.promise);
    const transcription = { finish: vi.fn(), abort: vi.fn() };
    const abortController = new AbortController();
    controller.beginListenPreview();
    controller.listenPreview.update("provisional");
    controller.listenRecording = {
      audioPath,
      startedAt: Date.now(),
      stopRequested: false,
      cleanupStyle: "off",
      abortController,
      completion: capture.promise,
      transcription,
    };

    try {
      const stop = controller.runListenTransition(() => controller.stopListenCapture());
      expect(abortController.signal.aborted).toBe(true);
      expect(controller.listenRecording).toBeUndefined();
      capture.resolve();
      await waitUntil(() => readSpy.mock.calls.length > 0);
      const disposal = controller.interrupt();
      expect(view.editorText).toBe("draft ");
      capture.resolve();
      read.resolve(audio);
      await Promise.all([stop, disposal]);

      await expect(readFile(audioPath)).rejects.toMatchObject({ code: "ENOENT" });
      expect(transcription.abort).toHaveBeenCalled();
      expect(transcription.finish).not.toHaveBeenCalled();
      expect(controller.retainedListenAudio).toBeUndefined();
      expect(view.transcriptNotices).toEqual([]);
      expect(view.editorText).toBe("draft ");
      expect(view.editorEnabledUpdates.at(-1)).toBe(true);
      expect(session.submit).not.toHaveBeenCalled();
    } finally {
      capture.resolve();
      read.resolve(audio);
      readSpy.mockRestore();
      await controller.dispose();
      await rm(audioPath, { force: true });
    }
  });

  it("cancels before the microphone starts when temporary file creation is pending", async () => {
    const audioPath = join(tmpdir(), `tau-session-listen-start-cancel-${Date.now()}.wav`);
    await writeFile(audioPath, Buffer.alloc(0));
    const created = Promise.withResolvers();
    const spawn = vi.fn(() => created.promise);
    const { view, controller } = await createControllerHarness({
      deps: createMockDeps(spawn),
      config: { apiKeys: { elevenlabs: "key" } },
    });
    view.editorText = "draft";
    try {
      const start = controller.onUserInput("/listen");
      await waitUntil(() => spawn.mock.calls.length === 1);
      await controller.interrupt();
      await controller.interrupt();
      expect(view.editorText).toBe("draft");
      expect(view.editorEnabledUpdates.at(-1)).toBe(true);
      created.resolve(createSpawnResult({ stdout: `${audioPath}\n` }));
      await start;
      expect(spawn).toHaveBeenCalledOnce();
      expect(view.transcriptNotices).toEqual([]);
      await expect(readFile(audioPath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      created.resolve(createSpawnResult({ stdout: `${audioPath}\n` }));
      await controller.dispose();
      await rm(audioPath, { force: true });
    }
  });

  it("projects real host retry completion into speech and terminal status", async () => {
    const environment = {
      resolveRuntimeContext: async () => ({
        promptBootstrap: {
          promptContext: { cwd: "/repo", home: "/home/user", platform: "linux" },
          agentsFiles: [],
          warnings: [],
          unknownSkills: [],
        },
      }),
      getToolExecutionBackend: () => createLocalToolExecutionBackend(),
      snapshot: () => ({ kind: "local", cwd: "/repo", home: "/home/user" }),
      dispose: async () => {},
    };
    const host = new LocalSessionHost({
      store: new MemorySessionStore(),
      history: new HistoryManager(new LocalHistoryStore(":memory:")),
      defaultBootstrap: {
        persona: personas[0],
        personas: [personas[0]],
        discoveredSkills: [],
        prompts: [],
        modelResolver: resolveModel,
        config: { mcpServers: {}, speechVocabulary: [] },
      },
      environment: { now: () => Date.now() },
      executionEnvironmentResolver: { resolve: async () => environment },
      includeAgentContext: false,
      getRemoteModelCatalog: () => new Map(),
    });
    let controller;
    const view = new FakeView();
    try {
      const hosted = await host.createSession({
        executionEnvironment: { kind: "local", cwd: "/repo" },
        attributes: { source: "test" },
      });
      const session = new FakeSession();
      session.id = hosted.sessionId;
      session.snapshot = () => hosted.snapshot();
      session.onDelta = (listener) => hosted.onDelta(listener);
      ({ controller } = await createControllerHarness({ session, view, deps: createMockDeps() }));
      const speak = vi.spyOn(controller, "speakLastAssistantMessage").mockResolvedValue();
      controller.start();
      await controller.onUserInput("/auto-speak on");
      const responses = [fauxAssistantMessage("first"), fauxAssistantMessage("retry")];
      hosted.runtime.agent.spec.model.stream = () => {
        const response = responses.shift();
        return {
          async *[Symbol.asyncIterator]() {},
          async result() {
            return response;
          },
        };
      };
      const accepted = await hosted.acceptTurn({ text: "question" });
      await hosted.runAcceptedTurn(accepted.userHistoryEntryId);
      expect(speak).toHaveBeenCalledTimes(1);
      expect(view.programStatuses.at(-1)).toBe("done");
      await controller.syncFromSessionSnapshot();
      expect(view.programStatuses.at(-1)).toBe("done");
      const reports = view.programStatuses.length;
      await hosted.retryTurn();
      expect(speak).toHaveBeenCalledTimes(2);
      expect(view.programStatuses.slice(reports)).toEqual(["working", "done"]);
    } finally {
      await controller?.dispose();
      await host.shutdown();
    }
  });

  it("stops speech on auto-speak off and before recording starts", async () => {
    const { controller } = await createControllerHarness({ deps: createMockDeps() });
    controller.start();
    const abortController = new AbortController();
    controller.speakTask = { abortController, completion: Promise.resolve() };
    await controller.onUserInput("/auto-speak off");
    expect(abortController.signal.aborted).toBe(true);
    const recordingAbort = new AbortController();
    controller.speakTask = { abortController: recordingAbort, completion: Promise.resolve() };
    const start = vi.spyOn(controller, "startListenCapture").mockImplementation(async () => {
      expect(recordingAbort.signal.aborted).toBe(true);
    });
    await controller.onUserInput("/listen");
    expect(start).toHaveBeenCalledTimes(1);
    controller.speakTask = undefined;
    await controller.dispose();
  });

  it("waits for ffplay shutdown when speech is cancelled before a write", async () => {
    const abortController = new AbortController();
    const stdin = new EventEmitter();
    stdin.destroyed = false;
    stdin.writableEnded = false;
    stdin.write = vi.fn();
    let releasePlayback;
    const spawn = vi.fn(
      (_command, _args, options) =>
        new Promise((resolve) => {
          options.signal.addEventListener(
            "abort",
            () => {
              releasePlayback = () =>
                resolve(
                  createSpawnResult({ exitCode: null, aborted: true, closeSignal: "SIGTERM" }),
                );
            },
            { once: true },
          );
          options.onSpawn?.({ stdin });
          abortController.abort();
        }),
    );
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            status: "completed",
            output: [
              {
                type: "message",
                status: "completed",
                content: [{ type: "output_text", text: "Spoken version." }],
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(Response.json({ voice_id: "QtY3JBOUKEB5xzrRfOKc" }))
      .mockResolvedValueOnce(
        new Response(Buffer.alloc(24_000, 1), { headers: { "Content-Type": "audio/pcm" } }),
      );
    vi.stubGlobal("fetch", fetchMock);

    try {
      const playback = runSpeechPlaybackTask({
        deps: createMockDeps(spawn),
        openAIApiKey: "openai-key",
        elevenLabsApiKey: "eleven-key",
        sourceText: "Original response.",
        signal: abortController.signal,
        onActivityLabel: vi.fn(),
      });
      let settled = false;
      void playback.then(
        () => {
          settled = true;
        },
        () => {
          settled = true;
        },
      );

      await vi.waitFor(() => expect(releasePlayback).toBeTypeOf("function"));
      await Promise.resolve();
      expect(settled).toBe(false);
      releasePlayback();
      await playback;
    } finally {
      vi.unstubAllGlobals();
    }

    expect(stdin.write).not.toHaveBeenCalled();
  });

  it("aborts speech generation when ffplay exits early", async () => {
    const stdin = new EventEmitter();
    stdin.destroyed = false;
    stdin.writableEnded = false;
    stdin.write = vi.fn((_audio, callback) => {
      callback();
      return true;
    });
    const player = deferred();
    const spawn = vi.fn((_command, _args, options) => {
      options.onSpawn?.({ stdin });
      return player.promise;
    });
    const streamAborted = vi.fn();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            status: "completed",
            output: [
              {
                type: "message",
                status: "completed",
                content: [{ type: "output_text", text: "Spoken version." }],
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(Response.json({ voice_id: "QtY3JBOUKEB5xzrRfOKc" }))
      .mockImplementationOnce(async (_url, init) => {
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(Buffer.alloc(24_000, 1));
              init.signal.addEventListener(
                "abort",
                () => {
                  streamAborted();
                  const error = new Error("aborted");
                  error.name = "AbortError";
                  controller.error(error);
                },
                { once: true },
              );
            },
          }),
          { status: 200, headers: { "Content-Type": "audio/pcm" } },
        );
      });
    vi.stubGlobal("fetch", fetchMock);

    try {
      const playback = runSpeechPlaybackTask({
        deps: createMockDeps(spawn),
        openAIApiKey: "openai-key",
        elevenLabsApiKey: "eleven-key",
        sourceText: "Original response.",
        signal: new AbortController().signal,
        onActivityLabel: vi.fn(),
      });
      const rejection = expect(playback).rejects.toThrow("ffplay failed: audio sink closed");

      await vi.waitFor(() => expect(stdin.write).toHaveBeenCalledOnce());
      player.resolve(createSpawnResult({ stderr: "audio sink closed", exitCode: 1 }));

      await rejection;
    } finally {
      vi.unstubAllGlobals();
    }

    expect(streamAborted).toHaveBeenCalledOnce();
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
      config: EMPTY_CLIENT_CONFIG,
      view,
      session,
      snapshot: await session.snapshot(),
      createSession: vi.fn(async () => nextSession),
      targetLabel: "ws://host",
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
      config: EMPTY_CLIENT_CONFIG,
      view,
      session,
      snapshot: await session.snapshot(),
      createSession,
      targetLabel: "ws://host",
    });
    controller.start();

    const firstNewSession = controller.onUserInput("/new");
    await waitUntil(() => createSession.mock.calls.length === 1);
    await controller.onUserInput("/new");

    expect(createSession).toHaveBeenCalledTimes(1);
    expect(session.unobserve).not.toHaveBeenCalled();
    expect(view.feedback).toContainEqual({
      text: "wait for tau to become idle before submitting input",
      tone: "default",
    });

    sessionCreated.resolve(nextSession);
    await firstNewSession;

    expect(session.unobserve).toHaveBeenCalledTimes(1);
    expect(nextSession.listeners.size).toBe(1);
    expect(nextSession.ephemeralListeners.size).toBe(1);
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
      config: EMPTY_CLIENT_CONFIG,
      view,
      session,
      snapshot: await session.snapshot(),
      createSession,
      targetLabel: "ws://host",
    });
    controller.start();

    await controller.onUserInput("/new");

    expect(nextSession.unobserve).toHaveBeenCalledTimes(1);
    expect(nextSession.ephemeralListeners.size).toBe(0);
    expect(session.unobserve).not.toHaveBeenCalled();
    expect(session.listeners.size).toBe(1);
    expect(view.feedback).toContainEqual({
      text: "failed to create session",
      tone: "error",
      content: ["snapshot unavailable"],
    });
  });

  it("rewinds session history from the selected user message", async () => {
    const now = 10 * 24 * 60 * 60 * 1000;
    const nowSpy = vi.spyOn(Date, "now").mockReturnValue(now);
    const session = new FakeSession(
      createSnapshot([
        {
          id: "history-1",
          message: {
            role: "user",
            content: [{ type: "text", text: "first message" }],
            timestamp: now - 2 * 60_000,
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
            timestamp: now - 30_000,
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
            timestamp: now - 2 * 60 * 60_000,
          },
        },
      ]),
    );
    const view = new FakeView();
    const { controller } = await createControllerHarness({
      view,
      session,
    });
    controller.start();

    controller.getInputHandlers().onSubmit("/rewind");
    await flush();

    expect(view.rewindPickerShows).toHaveLength(1);
    expect(view.rewindPickerShows[0].items).toEqual([
      { id: "history-1", label: "first message", description: "2m ago" },
      { id: "history-2", label: "second message", description: "now" },
      { id: "history-3", label: "third message", description: "2h ago" },
    ]);

    view.rewindPickerShows[0].onSelect("history-2");
    await flush();

    expect(session.rewindToHistoryEntryId).toHaveBeenCalledWith("history-2");
    expect(view.rewindPickerHideCount).toBe(1);
    expect(view.removeMessagesFromCalls).toEqual(["history-2"]);
    expect(view.removed).toEqual(expect.arrayContaining(["history-2", "history-3"]));
    expect(view.editorText).toBe("second message");
    nowSpy.mockRestore();
  });
});
