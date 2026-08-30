import { EventEmitter } from "node:events";
import { readFile, rm, writeFile } from "node:fs/promises";
import { createConnection } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { buildAutoCompactionContinuationMessage } from "../dist/core/session/compaction.js";
import {
  buildToolRunPresentation,
  TOOL_UI_FACET_VERSION,
} from "../dist/core/tools/presentation.js";
import { SPEECH_TO_TEXT_CLIENT_MAX_DURATION_MS } from "../dist/core/utils/speech_to_text.js";
import {
  hasAutoCompactionContinuationMetadata,
  prependTauUserMetadata,
  stripTauUserDisplayText,
} from "../dist/core/utils/user_metadata.js";
import {
  applySessionProtocolDelta,
  SESSION_PROTOCOL_VERSION,
} from "../dist/protocol/session_protocol.js";
import { FileSessionStore } from "../dist/store/file_session_store.js";
import { TauSessionProtocolResponseError } from "../dist/transport/errors.js";
import { formatDiffReviewUserMessage } from "../dist/tui/chat_controller/diff_review_user_message.js";
import { formatRewindCandidateAge } from "../dist/tui/chat_controller/history_labels.js";
import { copyTextToClipboard } from "../dist/tui/clipboard.js";
import { LISTEN_CAPTURE_START_TIMEOUT_MS } from "../dist/tui/listen_capture.js";
import { createTuiClientTools, SessionChatApp } from "../dist/tui/session_chat_app.js";
import { SessionChatController } from "../dist/tui/session_chat_controller.js";
import { runSpeechPlaybackTask } from "../dist/tui/speech_playback.js";
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

describe("formatRewindCandidateAge", () => {
  const now = 10 * 24 * 60 * 60 * 1000;

  it("formats compact relative ages", () => {
    expect(formatRewindCandidateAge(now - 30_000, now)).toBe("now");
    expect(formatRewindCandidateAge(now - 2 * 60_000, now)).toBe("2m ago");
    expect(formatRewindCandidateAge(now - 3 * 60 * 60_000, now)).toBe("3h ago");
    expect(formatRewindCandidateAge(now - 4 * 24 * 60 * 60_000, now)).toBe("4d ago");
  });
});

describe("SessionChatController", () => {
  it("shows delayed history replication through the footer", async () => {
    const session = new FakeSession();
    const view = new FakeView();
    const controller = new SessionChatController({
      view,
      session,
      snapshot: await session.snapshot(),
      targetLabel: "in-process",
    });

    controller.showHistoryReplicationDelayed();

    expect(view.footerNotices).toContainEqual({
      text: "history replication delayed",
      tone: "default",
      durationMs: 3000,
    });
  });

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
      '<file path="/home/session/repo/docs/AI_GUIDE.md">',
      "additional instructions",
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
      targetLabel: "ws://host",
      configuredClientToolNames: ["notify"],
      themeIds: ["gold"],
    });

    controller.start();

    const intro = view.messages.find((message) => message.model.type === "app_intro")?.model;
    expect(intro.title).toContain("tau v");
    expect(intro.title).toContain("2 context files");
    expect(intro.title).toContain("1 skills");
    expect(intro.title).toContain("1 client tool");
    expect(intro.title).not.toContain("session");
    expect(intro.body).toContain("skills:\n  alpha (~/.tau/skills)");
    expect(intro.body).toContain(
      "context:\n  ~/repo/AGENTS.md\n  ~/repo/docs/AI_GUIDE.md\n\nclient tools:\n  notify",
    );
    expect(intro.body).not.toContain("diff_review");
    expect(intro.body).not.toContain("prefill_input");
    expect(intro.body).not.toContain("~/repo/src/AGENTS.md");
    expect(intro.body).toContain("session id: session-1");
    expect(intro.body).not.toContain("ws://host");
    expect(view.status.footer.cwdLabel).toBe("remote · ~/repo");
    expect(view.status.footer.contextUsage).toBe("↑0 ↓0 r0 w0 · 0.0%/128k");

    await controller.onUserInput("/help");
    const help = view.messages.at(-1)?.model;
    expect(help).toMatchObject({ type: "transcript_text" });
    expect(help.text).toContain("context:\n  ~/repo/AGENTS.md\n  ~/repo/docs/AI_GUIDE.md");
    expect(help.text).not.toContain("~/repo/src/AGENTS.md");
    expect(help.text).toContain("skills:\n  alpha (~/.tau/skills)");
  });

  it("renders persisted protocol notices in timeline order", async () => {
    const snapshot = createProtocolSnapshot({
      timeline: [
        {
          type: "notice",
          id: "notice-history-unavailable",
          notice: {
            severity: "warn",
            title: "Session history is unavailable. This session will continue.",
            subject: { type: "session" },
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
        type: "transcript_notice",
        tone: "default",
        title: "Session history is unavailable. This session will continue.",
      },
    });

    const liveNotice = {
      type: "notice",
      id: "notice-live-warning",
      sequence: snapshot.timeline.sequence + 1,
      createdAt: 2,
      notice: {
        kind: "tau.test.notice",
        version: 1,
        severity: "warn",
        subject: { type: "session" },
        presentation: { title: "A live warning arrived." },
        data: {},
      },
    };
    for (const listener of session.listeners) {
      listener({
        version: SESSION_PROTOCOL_VERSION,
        type: "session.delta",
        sessionId: session.id,
        fromRevision: snapshot.revision,
        toRevision: snapshot.revision + 1,
        cause: { type: "notice" },
        delta: { type: "snapshot.patch", changes: [{ type: "timeline.append", item: liveNotice }] },
      });
    }

    expect(view.messages).toContainEqual({
      id: "notice-live-warning",
      model: {
        type: "transcript_notice",
        tone: "default",
        title: "A live warning arrived.",
      },
    });
  });

  it("renders host feedback across a revision gap without adding it to the timeline", async () => {
    const session = new FakeSession();
    const view = new FakeView();
    const controller = new SessionChatController({
      view,
      session,
      snapshot: await session.snapshot(),
      targetLabel: "in-process",
    });
    controller.start();

    const emit = (event) => {
      for (const listener of session.ephemeralListeners) {
        listener({
          version: SESSION_PROTOCOL_VERSION,
          type: "session.ephemeral",
          sessionId: session.id,
          event,
        });
      }
    };

    emit({
      type: "feedback.notice",
      title: "retrying after transient error",
      tone: "default",
      presentation: "footer",
      durationMs: 3_000,
    });
    expect(view.footerNotices.at(-1)).toEqual({
      text: "retrying after transient error",
      tone: "default",
      durationMs: 3_000,
    });

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
          changes: [{ type: "timeline.advance", epoch: 1, sequence: 1 }],
        },
      });
    }
    const timelineEvent = {
      type: "timeline.item",
      epoch: 1,
      item: {
        type: "notice",
        id: "ephemeral-model-failure",
        sequence: 1,
        createdAt: 1,
        notice: {
          kind: "tau.test.feedback",
          version: 1,
          severity: "error",
          subject: { type: "session" },
          presentation: {
            title: "model request failed",
            content: ["provider unavailable"],
          },
          data: {},
        },
      },
    };
    emit(timelineEvent);
    emit(timelineEvent);
    expect(view.messages.filter((message) => message.id === "ephemeral-model-failure")).toEqual([
      {
        id: "ephemeral-model-failure",
        model: {
          type: "transcript_notice",
          title: "model request failed",
          tone: "error",
          content: ["provider unavailable"],
        },
      },
    ]);
    expect(session.snapshotValue.timeline).toEqual({ epoch: 1, sequence: 0, items: [] });
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

  it("discards stale ephemeral timeline items during revision-gap recovery", async () => {
    const snapshot = createSnapshot([
      {
        id: "user-1",
        message: { role: "user", content: [{ type: "text", text: "keep" }] },
      },
    ]);
    const session = new FakeSession(snapshot);
    const view = new FakeView();
    const controller = new SessionChatController({
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
    for (const listener of session.ephemeralListeners) {
      listener({
        version: SESSION_PROTOCOL_VERSION,
        type: "session.ephemeral",
        sessionId: session.id,
        event: {
          type: "timeline.item",
          epoch: 1,
          item: {
            type: "notice",
            id: "stale-ephemeral",
            sequence: 2,
            createdAt: 2,
            notice: {
              kind: "tau.test.ephemeral",
              version: 1,
              severity: "error",
              subject: { type: "session" },
              presentation: { title: "stale failure" },
              data: {},
            },
          },
        },
      });
    }

    const recoveredSnapshot = createProtocolSnapshot({
      ...snapshot,
      revision: 4,
      messages: snapshot.messages,
      timeline: {
        epoch: 1,
        sequence: 3,
        items: snapshot.timeline.items,
      },
    });
    const snapshotResponse = deferred();
    vi.spyOn(session, "snapshot").mockImplementation(async () => await snapshotResponse.promise);
    for (const listener of session.listeners) {
      listener({
        version: SESSION_PROTOCOL_VERSION,
        type: "session.delta",
        sessionId: session.id,
        fromRevision: 3,
        toRevision: 4,
        cause: { type: "notice" },
        delta: {
          type: "snapshot.patch",
          changes: [{ type: "timeline.advance", epoch: 1, sequence: 3 }],
        },
      });
    }

    for (const listener of session.ephemeralListeners) {
      listener({
        version: SESSION_PROTOCOL_VERSION,
        type: "session.ephemeral",
        sessionId: session.id,
        event: {
          type: "timeline.item",
          epoch: 1,
          item: {
            type: "notice",
            id: "fresh-ephemeral",
            sequence: 3,
            createdAt: 3,
            notice: {
              kind: "tau.test.ephemeral",
              version: 1,
              severity: "info",
              subject: { type: "session" },
              presentation: { title: "fresh notice" },
              data: {},
            },
          },
        },
      });
    }
    snapshotResponse.resolve(recoveredSnapshot);
    await flush();

    expect(view.messages.some((message) => message.id === "stale-ephemeral")).toBe(false);
    expect(view.messages).toContainEqual({
      id: "fresh-ephemeral",
      model: { type: "transcript_notice", title: "fresh notice", tone: "default" },
    });
  });

  it("keeps frozen ephemeral notices during revision-gap recovery", async () => {
    const snapshot = createSnapshot([
      {
        id: "user-1",
        message: { role: "user", content: [{ type: "text", text: "before compaction" }] },
      },
    ]);
    const session = new FakeSession(snapshot);
    const view = new FakeView();
    const controller = new SessionChatController({
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
    for (const listener of session.ephemeralListeners) {
      listener({
        version: SESSION_PROTOCOL_VERSION,
        type: "session.ephemeral",
        sessionId: session.id,
        event: {
          type: "timeline.item",
          epoch: 1,
          item: {
            type: "notice",
            id: "frozen-ephemeral",
            sequence: 2,
            createdAt: 2,
            notice: {
              kind: "tau.test.ephemeral",
              version: 1,
              severity: "info",
              subject: { type: "session" },
              presentation: { title: "frozen notice" },
              data: {},
            },
          },
        },
      });
    }

    const compactedSnapshot = createProtocolSnapshot({
      sessionId: session.id,
      revision: 3,
      historyEntries: [
        {
          id: "summary-entry",
          message: { role: "user", content: [{ type: "text", text: "summary" }] },
        },
      ],
    });
    compactedSnapshot.timeline.epoch = 2;
    for (const listener of session.listeners) {
      listener(
        createResetDelta(session.id, 2, compactedSnapshot, {
          type: "compaction",
          previousEpoch: 1,
          epoch: 2,
          kind: "auto",
          cutType: "turn-boundary",
          retainedMessageCount: 0,
        }),
      );
    }

    for (const listener of session.listeners) {
      listener({
        version: SESSION_PROTOCOL_VERSION,
        type: "session.delta",
        sessionId: session.id,
        fromRevision: 3,
        toRevision: 4,
        cause: { type: "notice" },
        delta: {
          type: "snapshot.patch",
          changes: [{ type: "timeline.advance", epoch: 2, sequence: 2 }],
        },
      });
    }
    for (const listener of session.ephemeralListeners) {
      listener({
        version: SESSION_PROTOCOL_VERSION,
        type: "session.ephemeral",
        sessionId: session.id,
        event: {
          type: "timeline.item",
          epoch: 2,
          item: {
            type: "notice",
            id: "active-ephemeral",
            sequence: 2,
            createdAt: 3,
            notice: {
              kind: "tau.test.ephemeral",
              version: 1,
              severity: "info",
              subject: { type: "session" },
              presentation: { title: "active notice" },
              data: {},
            },
          },
        },
      });
    }

    const recoveredSnapshot = createProtocolSnapshot({
      ...compactedSnapshot,
      revision: 6,
      messages: compactedSnapshot.messages,
      timeline: {
        epoch: 2,
        sequence: 2,
        items: compactedSnapshot.timeline.items,
      },
    });
    vi.spyOn(session, "snapshot").mockResolvedValue(recoveredSnapshot);
    for (const listener of session.listeners) {
      listener({
        version: SESSION_PROTOCOL_VERSION,
        type: "session.delta",
        sessionId: session.id,
        fromRevision: 5,
        toRevision: 6,
        cause: { type: "notice" },
        delta: {
          type: "snapshot.patch",
          changes: [{ type: "timeline.advance", epoch: 2, sequence: 2 }],
        },
      });
    }
    await flush();

    expect(view.messages).toContainEqual({
      id: "frozen-ephemeral",
      model: { type: "transcript_notice", title: "frozen notice", tone: "default" },
    });
    expect(view.messages.some((message) => message.id === "active-ephemeral")).toBe(false);
  });

  it("keeps repeated timeline item ids in their respective compacted segments", async () => {
    const notice = {
      type: "notice",
      id: "notice-history-unavailable",
      sequence: 1,
      createdAt: 1,
      notice: {
        kind: "tau.history.unavailable",
        version: 1,
        severity: "warn",
        subject: { type: "session" },
        presentation: { title: "history unavailable before compaction" },
        data: {},
      },
    };
    const snapshot = createProtocolSnapshot({
      timeline: { epoch: 1, sequence: 1, items: [notice] },
    });
    const session = new FakeSession(snapshot);
    const view = new FakeView();
    const controller = new SessionChatController({
      view,
      session,
      snapshot,
      targetLabel: "in-process",
    });
    controller.start();

    const compactedSnapshot = createProtocolSnapshot({
      sessionId: snapshot.sessionId,
      revision: 2,
      timeline: { epoch: 2, sequence: 0, items: [] },
    });
    for (const listener of session.listeners) {
      listener(
        createResetDelta(session.id, 1, compactedSnapshot, {
          type: "compaction",
          previousEpoch: 1,
          epoch: 2,
          kind: "manual",
          cutType: "turn-boundary",
          retainedMessageCount: 0,
        }),
      );
      listener({
        version: SESSION_PROTOCOL_VERSION,
        type: "session.delta",
        sessionId: session.id,
        fromRevision: 2,
        toRevision: 3,
        cause: { type: "notice" },
        delta: {
          type: "snapshot.patch",
          changes: [
            {
              type: "timeline.append",
              item: {
                ...notice,
                sequence: 1,
                createdAt: 2,
                notice: {
                  ...notice.notice,
                  presentation: { title: "history unavailable after compaction" },
                },
              },
            },
          ],
        },
      });
    }

    const notices = view.messages.filter(
      (message) =>
        message.model.type === "transcript_notice" &&
        message.model.title.startsWith("history unavailable"),
    );
    expect(notices).toHaveLength(2);
    expect(notices[0].id).not.toBe(notices[1].id);
    const dividerIndex = view.messages.findIndex(
      (message) =>
        message.model.type === "session_divider" && message.model.label === "compacted context",
    );
    expect(view.messages.indexOf(notices[0])).toBeLessThan(dividerIndex);
    expect(view.messages.indexOf(notices[1])).toBeGreaterThan(dividerIndex);
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

    expect(view.status.footer).toEqual({
      type: "activity",
      label: "compacting context",
    });

    for (const listener of session.listeners) {
      listener({
        version: SESSION_PROTOCOL_VERSION,
        type: "session.delta",
        sessionId: session.id,
        fromRevision: snapshot.revision,
        toRevision: snapshot.revision + 1,
        cause: { type: "maintenance" },
        delta: {
          type: "snapshot.patch",
          changes: [
            {
              type: "operation.set",
              operation: {
                ...snapshot.operations["operation-auto-compaction"],
                status: "cancelled",
                finishedAt: 2,
                reason: "interrupted",
              },
            },
          ],
        },
      });
    }
    expect(view.status.footer.type).toBe("regular");
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
        preservedUserMessages: [],
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
    const controller = new SessionChatController({
      view,
      session,
      snapshot: await session.snapshot(),
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
        preservedUserMessages: [],
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
        preservedUserMessages: [],
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
    const controller = new SessionChatController({
      view,
      session,
      snapshot: await session.snapshot(),
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

    vi.mocked(copyTextToClipboard).mockClear();
    controller.getInputHandlers().onSubmit("/copy-text");
    await flush();

    expect(copyTextToClipboard).toHaveBeenCalledWith("retained snapshot response");
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
      targetLabel: "ws://host",
      themeIds: ["gold"],
    });

    controller.start();
    expect(view.messages.map((message) => message.id)).toContain("history-1");
    expect(view.status.footer.cwdLabel).toBe("remote · /session/repo");

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

  it("projects a provider failure once from canonical assistant state", async () => {
    const failedAssistant = {
      ...createAssistantMessage("partial response"),
      stopReason: "error",
      errorMessage: "Codex request failed with request-id-89abde88",
    };
    const snapshot = createSnapshot([
      { id: "user-failed", message: { role: "user", content: [{ type: "text", text: "try" }] } },
      { id: "assistant-failed", message: failedAssistant },
    ]);
    const session = new FakeSession(snapshot);
    session.emitSubmitEvents = false;
    session.submit = vi.fn(async () => ({
      userHistoryEntryId: "user-failed",
      turn: { status: "failed", stopReason: "error", errorMessage: failedAssistant.errorMessage },
    }));
    const view = new FakeView();
    const controller = new SessionChatController({
      view,
      session,
      snapshot,
      targetLabel: "in-process",
    });

    controller.start();
    controller.getInputHandlers().onSubmit("try");
    await flush();

    expect(view.messages.filter((message) => message.model.type === "transcript_notice")).toEqual([
      {
        id: "presentation:failure:assistant-failed",
        model: {
          type: "transcript_notice",
          title: "model request failed",
          content: [failedAssistant.errorMessage],
          tone: "error",
        },
      },
    ]);
    expect(view.transcriptNotices).toEqual([]);
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
      targetLabel: "ws://host",
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
      targetLabel: "ws://host",
      themeIds: ["gold"],
    });

    controller.start();
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
    expect(session.submit).toHaveBeenCalledWith("hello session");
    expect(view.messages.some((message) => message.model.type === "user")).toBe(false);
    expect(view.workingIconStarts).toBe(1);
    expect(view.workingIconStops).toBe(1);
    expect(controller.isStreaming).toBe(false);
    expect(controller.submittedTurnInProgress).toBe(false);
    expect(view.status.footer.type).toBe("regular");
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
      targetLabel: "ws://host",
    });

    controller.start();
    controller.getInputHandlers().onSubmit("hello session");
    await flush();

    expect(view.feedback).toContainEqual(
      expect.objectContaining({
        text: "failed to run assistant turn",
        tone: "error",
        content: ["failed to run session turn: session snapshot is invalid"],
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
      targetLabel: "ws://host",
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

  it("projects interruption feedback from canonical assistant state", async () => {
    const baseSnapshot = createSnapshot([
      {
        id: "assistant-interrupted",
        message: { ...createAssistantMessage("partial response"), stopReason: "aborted" },
      },
    ]);
    const snapshot = updateSnapshot(baseSnapshot, {
      messages: baseSnapshot.messages.map((message) =>
        message.id === "assistant-interrupted" ? { ...message, state: "interrupted" } : message,
      ),
    });
    const session = new FakeSession(snapshot);
    const view = new FakeView();
    const controller = new SessionChatController({
      view,
      session,
      snapshot,
      targetLabel: "in-process",
    });

    controller.start();

    expect(view.messages).toContainEqual({
      id: "presentation:interruption:assistant-interrupted",
      model: {
        type: "transcript_notice",
        title: "assistant turn interrupted",
        tone: "default",
      },
    });
  });

  it("leaves interrupted-turn feedback to the synchronized session", async () => {
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

    controller.getInputHandlers().onEscape();
    controller.getInputHandlers().onEscape();
    await flush();

    expect(session.interrupt).toHaveBeenCalledTimes(1);
    expect(view.transcriptNotices).toEqual([]);
    expect(view.footerNotices).toEqual([]);
  });

  it("renders the authoritative snapshot when live assistant events were missed", async () => {
    const session = new FakeSession();
    session.emitSubmitEvents = false;
    const view = new FakeView();
    const controller = new SessionChatController({
      view,
      session,
      snapshot: await session.snapshot(),
      targetLabel: "ws://host",
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
      targetLabel: "ws://host",
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
      outcome: "commented",
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
      targetLabel: "ws://host",
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
      targetLabel: "ws://host",
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
      targetLabel: "ws://host",
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
      targetLabel: "ws://host",
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
    expect(view.status.footer.type).toBe("regular");

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
    expect(view.status.footer.type).toBe("regular");

    controller.getInputHandlers().onSubmit("queued while response pending");
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
    expect(view.feedback).toEqual([]);
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

    expect(view.feedback).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          text: "failed to queue message",
          tone: "error",
          content: ["failed to drain pending user message: queued commit failed"],
        }),
        expect.objectContaining({
          text: "failed to steer assistant",
          tone: "error",
          content: ["steering turn failed: session snapshot is invalid"],
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
    const controller = new SessionChatController({
      view,
      session,
      snapshot: await session.snapshot(),
      targetLabel: "ws://host",
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
          ...baseSnapshot.timeline.items,
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
      targetLabel: "ws://host",
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
    expect(view.feedback).toEqual([]);

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
        ...baseSnapshot.timeline.items,
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
      cause: { type: "assistant-stream" },
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
        ...baseSnapshot.timeline.items,
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
      cause: { type: "assistant-stream" },
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

    expect(view.feedback).toContainEqual(
      expect.objectContaining({ tone: "default", text: "thoughts visible" }),
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
      cause: { type: "assistant-stream" },
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
      targetLabel: "ws://host",
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
          version: TOOL_UI_FACET_VERSION,
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
          version: TOOL_UI_FACET_VERSION,
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
          version: TOOL_UI_FACET_VERSION,
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
      targetLabel: "ws://host",
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
          version: TOOL_UI_FACET_VERSION,
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
      targetLabel: "ws://host",
    });

    controller.start();

    expect(view.messages.some((message) => message.id === "timeline-tool-tool-a")).toBe(true);
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
      const controller = new SessionChatController({
        view,
        session,
        snapshot: await session.snapshot(),
        targetLabel: "ws://host",
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
    const controller = new SessionChatController({
      view,
      session,
      snapshot: await session.snapshot(),
      targetLabel: "ws://host",
    });

    controller.start();
    const resetCount = view.resetToolUiSession.mock.calls.length;
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

  it("reconstructs subagent activity from transient session state", async () => {
    const agent = createAgentRun();
    const session = new FakeSession(
      updateSnapshot(createSnapshot(), {
        agents: {
          [agent.id]: agent,
        },
      }),
    );
    session.subagentActivitiesValue = {
      revision: 2,
      agents: {
        [agent.id]: {
          runRevision: 1,
          activities: [{ type: "assistant", text: "reading files" }],
        },
      },
    };
    const view = new FakeView();
    const controller = new SessionChatController({
      view,
      session,
      snapshot: await session.snapshot(),
      targetLabel: "ws://host",
    });

    controller.start();

    expect(view.subagentSnapshots).toEqual([
      {
        state: expect.objectContaining({
          id: "agent-1",
          run: expect.objectContaining({ status: "running" }),
        }),
        activities: [{ type: "assistant", text: "reading files" }],
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
      targetLabel: "ws://host",
    });

    controller.start();

    expect(view.subagentSnapshots).toEqual([
      {
        state: expect.objectContaining({
          id: "agent-1",
          run: expect.objectContaining({ status: "succeeded", response: "all clear" }),
        }),
        activities: [],
      },
    ]);
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
    const controller = new SessionChatController({
      view,
      session,
      snapshot: await session.snapshot(),
      targetLabel: "ws://host",
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
    const controller = new SessionChatController({
      view,
      session,
      snapshot: await session.snapshot(),
      targetLabel: "ws://host",
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
    const controller = new SessionChatController({
      view,
      session,
      snapshot: await session.snapshot(),
      targetLabel: "ws://host",
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
      targetLabel: "ws://host",
    });
    controller.start();

    controller.getInputHandlers().onSubmit("/compact-keep-last preserve decisions");
    await flush();

    expect(session.compact).toHaveBeenCalledWith("summary-and-last", {
      guidance: "preserve decisions",
    });
    expect(session.submit).not.toHaveBeenCalled();
    const dividerIndexes = view.messages.flatMap((message, index) =>
      message.model.type === "session_divider" ? [index] : [],
    );
    const summaryIndex = view.messages.findIndex((message) => message.id === "summary-entry");
    expect(dividerIndexes).toHaveLength(1);
    expect(view.messages[dividerIndexes[0]]?.model).toEqual({
      type: "session_divider",
      label: "compacted context",
    });
    expect(dividerIndexes[0]).toBeLessThan(summaryIndex);
    expect(view.messages[summaryIndex]).toEqual({
      id: "summary-entry",
      model: { type: "user", text: "compacted summary: preserve decisions" },
    });
    expect(view.feedback).toEqual([]);
  });

  it("renders one divider before a manually compacted reset", async () => {
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
    session.compact = vi.fn(async () => {
      const runningSnapshot = updateSnapshot(session.snapshotValue, {
        revision: session.snapshotValue.revision + 1,
        timeline: [
          ...session.snapshotValue.timeline.items,
          {
            type: "operation",
            id: "operation-manual-compaction",
            operation: {
              kind: "manual-compaction",
              status: "running",
              startedAt: 1,
            },
          },
        ],
      });
      for (const listener of session.listeners) {
        listener(
          createResetDelta(
            session.id,
            session.snapshotValue.revision,
            runningSnapshot,
            "maintenance",
          ),
        );
      }

      const compactedSnapshot = createProtocolSnapshot({
        sessionId: session.id,
        revision: runningSnapshot.revision + 1,
        agentState: {
          revision: runningSnapshot.agentState.revision + 1,
          modelContextKey: runningSnapshot.agentState.modelContextKey,
        },
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
      compactedSnapshot.timeline.epoch = runningSnapshot.timeline.epoch + 1;
      session.snapshotValue = compactedSnapshot;
      for (const listener of session.listeners) {
        listener(
          createResetDelta(session.id, runningSnapshot.revision, compactedSnapshot, {
            type: "compaction",
            previousEpoch: runningSnapshot.timeline.epoch,
            epoch: compactedSnapshot.timeline.epoch,
            kind: "manual",
            cutType: "turn-boundary",
            retainedMessageCount: 0,
          }),
        );
      }
      return {
        snapshot: compactedSnapshot,
        compactionMessage: "compacted summary",
        includedLastAssistant: false,
      };
    });
    const view = new FakeView();
    const controller = new SessionChatController({
      view,
      session,
      snapshot: await session.snapshot(),
      targetLabel: "in-process",
    });
    controller.start();

    controller.getInputHandlers().onSubmit("/compact-all");
    await flush();

    const dividerIndexes = view.messages.flatMap((message, index) =>
      message.model.type === "session_divider" ? [index] : [],
    );
    const summaryIndex = view.messages.findIndex((message) => message.id === "summary-entry");
    expect(dividerIndexes).toHaveLength(1);
    expect(view.messages[dividerIndexes[0]]?.model).toEqual({
      type: "session_divider",
      label: "compacted context",
    });
    expect(dividerIndexes[0]).toBeLessThan(summaryIndex);
    expect(dividerIndexes.filter((index) => index > summaryIndex)).toEqual([]);
  });

  it("renders manual compaction failures as transcript errors", async () => {
    const session = new FakeSession();
    session.compact = vi.fn(async () => {
      const runningSnapshot = updateSnapshot(session.snapshotValue, {
        revision: session.snapshotValue.revision + 1,
        timeline: [
          ...session.snapshotValue.timeline.items,
          {
            type: "operation",
            id: "operation-manual-compaction",
            operation: {
              kind: "manual-compaction",
              status: "running",
              startedAt: 1,
            },
          },
        ],
      });
      for (const listener of session.listeners) {
        listener(
          createResetDelta(
            session.id,
            session.snapshotValue.revision,
            runningSnapshot,
            "maintenance",
          ),
        );
      }

      const failedSnapshot = updateSnapshot(runningSnapshot, {
        revision: runningSnapshot.revision + 1,
        timeline: runningSnapshot.timeline.items.filter((item) => item.type !== "operation"),
      });
      session.snapshotValue = failedSnapshot;
      for (const listener of session.listeners) {
        listener(
          createResetDelta(session.id, runningSnapshot.revision, failedSnapshot, "maintenance"),
        );
      }
      throw new Error("no conversation to compact.");
    });
    const view = new FakeView();
    const controller = new SessionChatController({
      view,
      session,
      snapshot: await session.snapshot(),
      targetLabel: "in-process",
    });
    controller.start();

    controller.getInputHandlers().onSubmit("/compact-all");
    await flush();

    expect(view.transcriptNotices).toEqual([
      {
        text: "failed to compact session",
        tone: "error",
        content: ["no conversation to compact."],
      },
    ]);
    expect(view.messages.filter((message) => message.model.type === "session_divider")).toEqual([]);
    expect(view.status.footer.type).toBe("regular");
  });

  it("routes goal controls through the session protocol and reflects goal status", async () => {
    const session = new FakeSession();
    const view = new FakeView();
    const controller = new SessionChatController({
      view,
      session,
      snapshot: await session.snapshot(),
      targetLabel: "ws://host",
    });
    controller.start();

    controller.getInputHandlers().onSubmit("/goal Ship the feature");
    await flush();

    expect(session.startGoal).toHaveBeenCalledWith("Ship the feature");
    expect(view.status.footer.pursuingGoal).toBe(true);

    controller.isStreaming = true;
    controller.getInputHandlers().onSubmit("/goal");
    await flush();
    expect(view.feedback).toContainEqual(
      expect.objectContaining({ text: "goal active", content: ["Ship the feature"] }),
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
    expect(view.feedback).toContainEqual(
      expect.objectContaining({
        tone: "default",
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
      targetLabel: "ws://host",
    });
    controller.start();

    controller.getInputHandlers().onSubmit("/compact-all");
    await flush();

    expect(view.status.footer).toEqual({
      type: "activity",
      label: "compacting context",
    });
    pendingCompact.resolve();
    await flush();

    expect(view.status.footer.type).toBe("regular");
  });

  it("uses the shared slash command parser for session command dispatch", async () => {
    const session = new FakeSession();
    const view = new FakeView();
    const controller = new SessionChatController({
      view,
      session,
      snapshot: await session.snapshot(),
      targetLabel: "ws://host",
    });
    controller.start();

    controller.getInputHandlers().onSubmit("/reload ignored");
    await flush();

    controller.getInputHandlers().onSubmit("/help extra");
    await flush();

    expect(session.reload).toHaveBeenCalledTimes(1);
    expect(session.submit).not.toHaveBeenCalled();
    expect(
      view.messages.some(
        (message) =>
          message.model.type === "transcript_text" && message.model.text.includes("commands:"),
      ),
    ).toBe(true);
  });

  it("tracks session editor input modes without command hints", async () => {
    const session = new FakeSession();
    const view = new FakeView();
    const controller = new SessionChatController({
      view,
      session,
      snapshot: await session.snapshot(),
      targetLabel: "ws://host",
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
    expect(view.status.footer.type).toBe("regular");
  });

  it("switches session personas through the session protocol", async () => {
    const session = new FakeSession();
    const view = new FakeView();
    const controller = new SessionChatController({
      view,
      session,
      snapshot: await session.snapshot(),
      targetLabel: "ws://host",
    });
    controller.start();

    controller.getInputHandlers().onSubmit("/persona:persona-2");
    await flush();

    expect(session.setPersona).toHaveBeenCalledWith("persona-2");
    expect(view.status.editor.personaName).toBe("Persona 2");
    expect(view.feedback).toContainEqual(
      expect.objectContaining({
        tone: "default",
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
      targetLabel: "ws://host",
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
      targetLabel: "ws://host",
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
      targetLabel: "ws://host",
    });
    controller.start();

    controller.isStreaming = true;
    controller.getInputHandlers().onShiftTab();
    await flush();

    expect(session.setReasoning).toHaveBeenCalledWith("minimal");
    expect(view.status.editor.reasoningLabel).toBe("minimal");
    expect(view.feedback).not.toContainEqual({
      text: "cannot change reasoning while a session turn is running",
      tone: "default",
    });
  });

  it("inserts session prompt templates locally in the editor", async () => {
    const session = new FakeSession();
    const view = new FakeView();
    const controller = new SessionChatController({
      view,
      session,
      snapshot: await session.snapshot(),
      targetLabel: "ws://host",
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
      targetLabel: "ws://host",
    });
    controller.start();

    controller.getInputHandlers().onSubmit("/reload");
    await flush();

    expect(session.reload).toHaveBeenCalledTimes(1);
    expect(view.feedback).toContainEqual(
      expect.objectContaining({
        tone: "default",
        text: "configuration warning",
        content: ["reload warning"],
      }),
    );
    expect(view.feedback).toContainEqual(
      expect.objectContaining({
        tone: "default",
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
      targetLabel: "ws://host",
    });
    controller.start();

    controller.getInputHandlers().onCtrlS();
    await flush();

    expect(copyTextToClipboard).toHaveBeenCalledWith("line 1\nline 2");
    expect(view.editorText).toBe("");
    expect(view.feedback).toContainEqual({
      text: "stashed input to clipboard",
      tone: "default",
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
      targetLabel: "ws://host",
    });
    controller.start();

    controller.getInputHandlers().onCtrlS();
    await flush();

    expect(view.feedback).toContainEqual({
      text: "no input to stash yet",
      tone: "default",
    });
  });

  it("cycles session subagent selection with alt+down", async () => {
    const session = new FakeSession();
    const view = new FakeView();
    const controller = new SessionChatController({
      view,
      session,
      snapshot: await session.snapshot(),
      targetLabel: "ws://host",
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
      targetLabel: "ws://host",
    });
    controller.start();

    controller.getInputHandlers().onCtrlG();
    await flush();

    expect(session.interruptSubagent).toHaveBeenCalledWith("subagent-1");
    expect(view.feedback).not.toContainEqual(
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
      targetLabel: "ws://host",
    });
    controller.start();

    controller.getInputHandlers().onCtrlG();
    await flush();

    expect(session.interruptSubagent).not.toHaveBeenCalled();
    expect(view.feedback).toContainEqual({
      text: "no active subagent selected",
      tone: "default",
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
      targetLabel: "ws://host",
    });
    controller.start();

    controller.getInputHandlers().onCtrlG();
    await flush();

    expect(session.interruptSubagent).toHaveBeenCalledWith("missing-subagent");
    expect(view.feedback).toContainEqual({
      text: "unknown subagent id: missing-subagent",
      tone: "default",
    });
  });

  it("submits hash-prefixed text as an ordinary user message", async () => {
    const session = new FakeSession();
    const view = new FakeView();
    const controller = new SessionChatController({
      view,
      session,
      snapshot: await session.snapshot(),
      targetLabel: "ws://host",
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
      targetLabel: "ws://host",
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
    expect(view.feedback).toContainEqual(
      expect.objectContaining({
        tone: "default",
        text: "diff review added; no assistant turn started",
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
      targetLabel: "ws://host",
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
    const controller = new SessionChatController({
      view,
      session,
      snapshot: await session.snapshot(),
      targetLabel: "ws://host",
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
      view,
      session,
      snapshot: await session.snapshot(),
      createSession,
      targetLabel: "ws://host",
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
    expect(view.feedback).toContainEqual({
      text: "wait for tau to become idle before submitting input",
      tone: "default",
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

    expect(prefillInput.execute({ text: "Name: \nDecision: " })).toEqual({
      content: "Prefilled the input editor. The user can review, edit, and submit it.",
      presentation: { subject: "Name: \nDecision: " },
    });
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

  it("waits for terminal color detection before closing after session creation fails", async () => {
    const creationError = new Error("session creation failed");
    let resolveTerminalColors;
    const terminalColors = new Promise((resolve) => {
      resolveTerminalColors = resolve;
    });
    const client = {
      sessions: {
        create: vi.fn(async () => {
          throw creationError;
        }),
      },
      close: vi.fn(async () => {}),
    };

    const opening = SessionChatApp.open({
      client,
      configuredClientToolNames: [],
      targetLabel: "in-process",
      sessionSelection: { mode: "create", input: {} },
      terminalColors,
    });
    const rejection = expect(opening).rejects.toBe(creationError);
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(client.close).not.toHaveBeenCalled();

    resolveTerminalColors({
      foreground: { r: 1, g: 1, b: 1 },
      background: { r: 0, g: 0, b: 0 },
      appearance: "dark",
    });
    await rejection;
    expect(client.close).toHaveBeenCalledOnce();
  });

  it("rejects configured tool collisions before connecting the transport", async () => {
    await expect(
      SessionChatApp.connect({
        transport: "websocket",
        url: "ws://127.0.0.1:1",
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
      targetLabel: "ws://host",
      defaultDiffTool: { command: "inline-diff-tool" },
      diffToolLauncher: (args) => launchInlineDiffTool({ ...args, returnDelayMs: 100 }),
    });
    controller.start();

    const executionEnvironment = {
      exec: vi.fn((command, options) => session.exec(command, options)),
    };
    const result = controller.runClientDiffReview(
      { source: "git_diff", diffArgs: ["--", "src/main.ts"] },
      {
        sessionId: "session-1",
        callId: "diff-review-1",
        signal: new AbortController().signal,
        executionEnvironment,
      },
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
    expect(executionEnvironment.exec).toHaveBeenCalled();
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
      targetLabel: "ws://host",
      deps: createMockDeps(spawn, "linux"),
      config: { apiKeys: { openai: "openai-key" } },
    });
    controller.start();

    controller.getInputHandlers().onSubmit("/listen");
    await flush();

    expect(spawn).not.toHaveBeenCalled();
    expect(view.footerNotices).toContainEqual({
      text: "/listen is currently supported only on macOS.",
      tone: "default",
      durationMs: 3000,
    });
    expect(view.feedback).not.toContainEqual(
      expect.objectContaining({
        text: expect.stringContaining("not supported in protocol attach mode"),
      }),
    );
    expect(session.submit).not.toHaveBeenCalled();
  });

  it("streams Gemini transcription while recording and inserts only the final transcript", async () => {
    const audioPath = join(tmpdir(), `tau-session-listen-gemini-${Date.now()}.wav`);
    const pcm = Buffer.from([1, 2, 3, 4]);
    const socket = new EventEmitter();
    const socketEvents = [];
    socket.send = vi.fn((data, callback) => {
      const event = JSON.parse(data);
      socketEvents.push(event);
      callback?.();
      if (event.setup) {
        queueMicrotask(() => socket.emit("message", JSON.stringify({ setupComplete: {} })));
      }
      if (event.realtimeInput?.activityEnd) {
        queueMicrotask(() =>
          socket.emit(
            "message",
            JSON.stringify({
              serverContent: {
                inputTranscription: { text: "session transcript" },
              },
            }),
          ),
        );
      }
    });
    socket.close = vi.fn();
    socket.terminate = vi.fn();
    const webSocketFactory = vi.fn(() => socket);
    const spawn = vi.fn(async (command, _args, options = {}) => {
      if (command === "mktemp") {
        return {
          stdout: `${audioPath}\n`,
          stderr: "",
          output: undefined,
          exitCode: 0,
          captureLimitExceeded: false,
          timedOut: false,
          aborted: false,
          closeSignal: null,
        };
      }
      if (command === "ffmpeg") {
        const stdout = new EventEmitter();
        options.onSpawn({ stdout });
        queueMicrotask(() => stdout.emit("data", pcm));
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
      throw new Error(`unexpected command: ${command}`);
    });
    const session = new FakeSession();
    const view = new FakeView();
    const controller = new SessionChatController({
      view,
      session,
      snapshot: await session.snapshot(),
      targetLabel: "ws://host",
      deps: createMockDeps(spawn),
      config: {
        speechToText: { provider: "gemini" },
        apiKeys: { google: "gemini-key" },
      },
      speechToTextDeps: { webSocketFactory },
    });

    try {
      controller.start();
      await controller.onUserInput("/listen");
      expect(view.status.editor.mode).toBe("recording");
      await writeFile(audioPath, Buffer.alloc(2048, 1));

      controller.getInputHandlers().onCtrlY();
      socket.emit("open");
      for (let i = 0; i < 50 && view.editorText !== "session transcript"; i += 1) {
        await flush();
        await waitMs(1);
      }
    } finally {
      await controller.dispose();
      await rm(audioPath, { force: true });
    }

    expect(view.editorEnabledUpdates).toContain(true);
    expect(view.editorText).toBe("session transcript");
    expect(socketEvents).toHaveLength(4);
    expect(socketEvents[0].setup.inputAudioTranscription.mode).toBe("SMART");
    expect(socketEvents[2].realtimeInput.audio).toEqual({
      data: pcm.toString("base64"),
      mimeType: "audio/pcm;rate=16000",
    });
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
  });

  it("streams OpenAI transcription while recording and inserts only the final transcript", async () => {
    const audioPath = join(tmpdir(), `tau-session-listen-openai-${Date.now()}.wav`);
    const socket = new EventEmitter();
    const socketEvents = [];
    socket.send = vi.fn((data, callback) => {
      const event = JSON.parse(data);
      socketEvents.push(event);
      callback?.();
      if (event.type === "session.update") {
        queueMicrotask(() => socket.emit("message", JSON.stringify({ type: "session.updated" })));
      }
      if (event.type === "input_audio_buffer.commit") {
        queueMicrotask(() =>
          socket.emit(
            "message",
            JSON.stringify({
              type: "conversation.item.input_audio_transcription.completed",
              transcript: "live transcript",
            }),
          ),
        );
      }
    });
    socket.close = vi.fn();
    socket.terminate = vi.fn();
    const webSocketFactory = vi.fn(() => socket);
    const pcm = Buffer.from([1, 2, 3, 4]);
    const spawn = vi.fn(async (command, _args, options = {}) => {
      if (command === "mktemp") {
        return {
          stdout: `${audioPath}\n`,
          stderr: "",
          output: undefined,
          exitCode: 0,
          captureLimitExceeded: false,
          timedOut: false,
          aborted: false,
          closeSignal: null,
        };
      }
      if (command === "ffmpeg") {
        const stdout = new EventEmitter();
        options.onSpawn({ stdout });
        queueMicrotask(() => stdout.emit("data", pcm));
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
      throw new Error(`unexpected command: ${command}`);
    });
    const session = new FakeSession();
    const view = new FakeView();
    const controller = new SessionChatController({
      view,
      session,
      snapshot: await session.snapshot(),
      targetLabel: "in-process",
      deps: createMockDeps(spawn),
      config: { apiKeys: { openai: "openai-key" } },
      speechToTextDeps: { webSocketFactory },
    });

    try {
      controller.start();
      await controller.onUserInput("/listen");
      expect(view.status.editor.mode).toBe("recording");
      expect(socketEvents).toEqual([]);
      await writeFile(audioPath, Buffer.alloc(2048, 1));

      controller.getInputHandlers().onCtrlY();
      socket.emit("open");
      for (let i = 0; i < 50 && view.editorText !== "live transcript"; i += 1) {
        await flush();
        await waitMs(1);
      }
    } finally {
      await controller.dispose();
      await rm(audioPath, { force: true });
    }

    expect(view.editorText).toBe("live transcript");
    expect(socketEvents.map((event) => event.type)).toEqual([
      "session.update",
      "input_audio_buffer.append",
      "input_audio_buffer.commit",
    ]);
    expect(socketEvents[1].audio).toBe(pcm.toString("base64"));
    expect(spawn).toHaveBeenNthCalledWith(
      2,
      "ffmpeg",
      expect.arrayContaining(["-ar", "24000", "-f", "s16le", "pipe:1"]),
      expect.objectContaining({
        captureOutput: "stderr",
        stdio: ["ignore", "pipe", "pipe"],
      }),
    );
  });

  it("submits voice input automatically at the 20-minute recording limit", async () => {
    const audioPath = join(tmpdir(), `tau-session-listen-limit-${Date.now()}.wav`);
    await writeFile(audioPath, Buffer.alloc(2048, 1));
    const spawn = vi.fn(async (command, _args, options = {}) => {
      if (command === "mktemp") {
        return {
          stdout: `${audioPath}\n`,
          stderr: "",
          output: undefined,
          exitCode: 0,
          captureLimitExceeded: false,
          timedOut: false,
          aborted: false,
          closeSignal: null,
        };
      }
      if (command === "ffmpeg") {
        const stdout = new EventEmitter();
        options.onSpawn({ stdout });
        queueMicrotask(() => stdout.emit("data", Buffer.from([1, 2])));
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
      throw new Error(`unexpected command: ${command}`);
    });
    const transcription = {
      appendAudio: vi.fn(),
      finish: vi.fn(async () => "automatic transcript"),
      abort: vi.fn(),
    };
    const session = new FakeSession();
    const view = new FakeView();
    const controller = new SessionChatController({
      view,
      session,
      snapshot: await session.snapshot(),
      targetLabel: "in-process",
      deps: createMockDeps(spawn),
      config: { apiKeys: { openai: "openai-key" } },
    });
    controller.createSpeechTranscription = vi.fn(() => transcription);

    vi.useFakeTimers();
    try {
      await controller.onUserInput("/listen");
      await vi.advanceTimersByTimeAsync(SPEECH_TO_TEXT_CLIENT_MAX_DURATION_MS);
      await controller.listenTransition;
    } finally {
      vi.useRealTimers();
      await controller.dispose();
      await rm(audioPath, { force: true });
    }

    expect(session.submit).toHaveBeenCalledWith("automatic transcript");
    expect(view.editorText).toBe("");
  });

  it("retries retained OpenAI audio through file transcription", async () => {
    const audioPath = join(tmpdir(), `tau-session-listen-openai-retry-${Date.now()}.wav`);
    await writeFile(audioPath, Buffer.alloc(2048, 1));
    const spawnImpl = vi.fn(async (_command, _args, options) => {
      const stdout = new EventEmitter();
      options.onSpawn({ stdout });
      stdout.emit("data", Buffer.from([1, 2, 3, 4]));
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
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ text: "retried file transcript" })),
    );
    const webSocketFactory = vi.fn();
    const session = new FakeSession();
    const view = new FakeView();
    const controller = new SessionChatController({
      view,
      session,
      snapshot: await session.snapshot(),
      targetLabel: "in-process",
      deps: createMockDeps(),
      config: { apiKeys: { openai: "openai-key" } },
      speechToTextDeps: { fetchImpl, spawnImpl, webSocketFactory },
    });
    controller.retainedListenAudio = { audioPath, durationMs: 1_000 };

    try {
      await controller.onUserInput("/listen retry");
      await expect(readFile(audioPath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(audioPath, { force: true });
    }

    expect(view.editorText).toBe("retried file transcript");
    expect(webSocketFactory).not.toHaveBeenCalled();
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.openai.com/v1/audio/transcriptions",
      expect.objectContaining({ body: expect.any(FormData) }),
    );
  });

  it("rejects retained voice input longer than 20 minutes before provider work", async () => {
    const audioPath = join(tmpdir(), `tau-session-listen-too-long-${Date.now()}.wav`);
    await writeFile(audioPath, Buffer.alloc(2048, 1));
    const session = new FakeSession();
    const view = new FakeView();
    const controller = new SessionChatController({
      view,
      session,
      snapshot: await session.snapshot(),
      targetLabel: "in-process",
      deps: createMockDeps(),
    });
    controller.retainedListenAudio = {
      audioPath,
      durationMs: SPEECH_TO_TEXT_CLIENT_MAX_DURATION_MS + 1,
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

  it("retains failed voice input and retries it into the editor", async () => {
    const audioPath = join(tmpdir(), `tau-session-listen-failure-${Date.now()}.wav`);
    await writeFile(audioPath, Buffer.alloc(2048, 1));
    const fetchMock = vi
      .fn()
      .mockRejectedValueOnce(new Error("service unavailable"))
      .mockResolvedValueOnce(new Response(JSON.stringify({ text: "recovered transcript" })));
    const spawnImpl = vi.fn(async (_command, _args, options) => {
      const stdout = new EventEmitter();
      options.onSpawn({ stdout });
      stdout.emit("data", Buffer.from([1, 2, 3, 4]));
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

    const session = new FakeSession();
    const view = new FakeView();
    const controller = new SessionChatController({
      view,
      session,
      snapshot: await session.snapshot(),
      targetLabel: "in-process",
      deps: createMockDeps(spawnImpl),
      config: { apiKeys: { openai: "openai-key" } },
      speechToTextDeps: { fetchImpl: fetchMock },
    });
    controller.listenRecording = {
      audioPath,
      startedAt: Date.now(),
      stopRequested: false,
      abortController: new AbortController(),
      completion: Promise.resolve(),
    };

    try {
      await controller.stopListenCapture();
      await expect(readFile(audioPath)).resolves.toHaveLength(2048);
      expect(view.transcriptNotices.at(-1)).toEqual({
        text: "failed to transcribe speech",
        tone: "error",
        content: [
          "service unavailable",
          `recording retained at ${audioPath}`,
          "run /listen retry to try again, or /listen discard to delete it",
        ],
      });

      await controller.onUserInput("/listen retry");
      expect(view.editorText).toBe("recovered transcript");
      await expect(readFile(audioPath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      await rm(audioPath, { force: true });
    }

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retains voice input when a provider returns an empty transcript", async () => {
    const audioPath = join(tmpdir(), `tau-session-listen-empty-${Date.now()}.wav`);
    await writeFile(audioPath, Buffer.alloc(2048, 1));
    const fetchImpl = vi.fn(async () => new Response(JSON.stringify({ text: "" })));
    const spawnImpl = vi.fn(async (_command, _args, options) => {
      const stdout = new EventEmitter();
      options.onSpawn({ stdout });
      stdout.emit("data", Buffer.from([1, 2, 3, 4]));
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
    const session = new FakeSession();
    const view = new FakeView();
    const controller = new SessionChatController({
      view,
      session,
      snapshot: await session.snapshot(),
      targetLabel: "in-process",
      deps: createMockDeps(spawnImpl),
      config: { apiKeys: { openai: "openai-key" } },
      speechToTextDeps: { fetchImpl },
    });
    controller.listenRecording = {
      audioPath,
      startedAt: Date.now(),
      stopRequested: false,
      abortController: new AbortController(),
      completion: Promise.resolve(),
    };

    try {
      await controller.stopListenCapture();
      await expect(readFile(audioPath)).resolves.toHaveLength(2048);
    } finally {
      await rm(audioPath, { force: true });
    }

    expect(view.transcriptNotices.at(-1)).toMatchObject({
      text: "failed to transcribe speech",
      content: [
        "transcription result was empty or malformed",
        `recording retained at ${audioPath}`,
        "run /listen retry to try again, or /listen discard to delete it",
      ],
    });
  });

  it("discards retained voice input only when requested", async () => {
    const audioPath = join(tmpdir(), `tau-session-listen-discard-${Date.now()}.wav`);
    await writeFile(audioPath, Buffer.alloc(2048, 1));
    const session = new FakeSession();
    const view = new FakeView();
    const controller = new SessionChatController({
      view,
      session,
      snapshot: await session.snapshot(),
      targetLabel: "in-process",
      deps: createMockDeps(),
    });
    controller.retainedListenAudio = { audioPath, durationMs: 1_000 };

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

  it("deletes retained voice input when a new recording replaces it", async () => {
    const retainedPath = join(tmpdir(), `tau-session-listen-replaced-${Date.now()}.wav`);
    const nextPath = join(tmpdir(), `tau-session-listen-next-${Date.now()}.wav`);
    await writeFile(retainedPath, Buffer.alloc(2048, 1));
    const spawn = vi.fn(async (command, _args, options = {}) => {
      if (command === "mktemp") {
        return {
          stdout: `${nextPath}\n`,
          stderr: "",
          output: undefined,
          exitCode: 0,
          captureLimitExceeded: false,
          timedOut: false,
          aborted: false,
          closeSignal: null,
        };
      }
      if (command === "ffmpeg") {
        const stdout = new EventEmitter();
        options.onSpawn({ stdout });
        queueMicrotask(() => stdout.emit("data", Buffer.from([1, 2, 3, 4])));
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
      throw new Error(`unexpected command: ${command}`);
    });
    const session = new FakeSession();
    const controller = new SessionChatController({
      view: new FakeView(),
      session,
      snapshot: await session.snapshot(),
      targetLabel: "in-process",
      deps: createMockDeps(spawn),
      config: {
        speechToText: { provider: "gemini" },
        apiKeys: { google: "gemini-key" },
      },
      speechToTextDeps: { webSocketFactory: createIdleSpeechWebSocketFactory() },
    });
    controller.retainedListenAudio = { audioPath: retainedPath, durationMs: 1_000 };

    try {
      await controller.onUserInput("/listen");
      await expect(readFile(retainedPath)).rejects.toMatchObject({ code: "ENOENT" });
      expect(controller.listenRecording?.audioPath).toBe(nextPath);
      await controller.dispose();
    } finally {
      await rm(retainedPath, { force: true });
      await rm(nextPath, { force: true });
    }
  });

  it("keeps retained voice input when replacement capture fails to start", async () => {
    const retainedPath = join(tmpdir(), `tau-session-listen-preserved-${Date.now()}.wav`);
    const nextPath = join(tmpdir(), `tau-session-listen-failed-${Date.now()}.wav`);
    await writeFile(retainedPath, Buffer.alloc(2048, 1));
    const spawn = vi.fn(async (command) => {
      if (command === "mktemp") {
        return {
          stdout: `${nextPath}\n`,
          stderr: "",
          output: undefined,
          exitCode: 0,
          captureLimitExceeded: false,
          timedOut: false,
          aborted: false,
          closeSignal: null,
        };
      }
      if (command === "ffmpeg") {
        return {
          stdout: "",
          stderr: "audio device unavailable",
          output: undefined,
          exitCode: 1,
          captureLimitExceeded: false,
          timedOut: false,
          aborted: false,
          closeSignal: null,
        };
      }
      throw new Error(`unexpected command: ${command}`);
    });
    const session = new FakeSession();
    const view = new FakeView();
    const controller = new SessionChatController({
      view,
      session,
      snapshot: await session.snapshot(),
      targetLabel: "in-process",
      deps: createMockDeps(spawn),
      config: {
        speechToText: { provider: "gemini" },
        apiKeys: { google: "gemini-key" },
      },
      speechToTextDeps: { webSocketFactory: createIdleSpeechWebSocketFactory() },
    });
    controller.retainedListenAudio = { audioPath: retainedPath, durationMs: 1_000 };

    try {
      await controller.onUserInput("/listen");
      await expect(readFile(retainedPath)).resolves.toHaveLength(2048);
    } finally {
      await rm(retainedPath, { force: true });
      await rm(nextPath, { force: true });
    }

    expect(controller.retainedListenAudio).toEqual({ audioPath: retainedPath, durationMs: 1_000 });
    expect(view.transcriptNotices.at(-1)).toEqual({
      text: "failed to start recording",
      tone: "error",
      content: ["ffmpeg failed to start recording: audio device unavailable"],
    });
  });

  it("times out stalled recording startup without deleting retained voice input", async () => {
    const retainedPath = join(tmpdir(), `tau-session-listen-timeout-retained-${Date.now()}.wav`);
    const nextPath = join(tmpdir(), `tau-session-listen-timeout-next-${Date.now()}.wav`);
    await writeFile(retainedPath, Buffer.alloc(2048, 1));
    const spawn = vi.fn(async (command, _args, options = {}) => {
      if (command === "mktemp") {
        return {
          stdout: `${nextPath}\n`,
          stderr: "",
          output: undefined,
          exitCode: 0,
          captureLimitExceeded: false,
          timedOut: false,
          aborted: false,
          closeSignal: null,
        };
      }
      if (command === "ffmpeg") {
        options.onSpawn({ stdout: new EventEmitter() });
        return await new Promise((resolve) => {
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
      }
      throw new Error(`unexpected command: ${command}`);
    });
    const session = new FakeSession();
    const view = new FakeView();
    const controller = new SessionChatController({
      view,
      session,
      snapshot: await session.snapshot(),
      targetLabel: "in-process",
      deps: createMockDeps(spawn),
      config: {
        speechToText: { provider: "gemini" },
        apiKeys: { google: "gemini-key" },
      },
      speechToTextDeps: { webSocketFactory: createIdleSpeechWebSocketFactory() },
    });
    controller.retainedListenAudio = { audioPath: retainedPath, durationMs: 1_000 };

    vi.useFakeTimers();
    try {
      const start = controller.onUserInput("/listen");
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(LISTEN_CAPTURE_START_TIMEOUT_MS);
      await start;
      await expect(readFile(retainedPath)).resolves.toHaveLength(2048);
    } finally {
      vi.useRealTimers();
      await rm(retainedPath, { force: true });
      await rm(nextPath, { force: true });
    }

    expect(controller.retainedListenAudio).toEqual({ audioPath: retainedPath, durationMs: 1_000 });
    expect(view.transcriptNotices.at(-1)).toEqual({
      text: "failed to start recording",
      tone: "error",
      content: ["timed out waiting for microphone audio"],
    });
  });

  it("cancels stalled recording startup during shutdown", async () => {
    const retainedPath = join(tmpdir(), `tau-session-listen-cancel-retained-${Date.now()}.wav`);
    const nextPath = join(tmpdir(), `tau-session-listen-cancel-next-${Date.now()}.wav`);
    await writeFile(retainedPath, Buffer.alloc(2048, 1));
    let captureSignal;
    const spawn = vi.fn(async (command, _args, options = {}) => {
      if (command === "mktemp") {
        return {
          stdout: `${nextPath}\n`,
          stderr: "",
          output: undefined,
          exitCode: 0,
          captureLimitExceeded: false,
          timedOut: false,
          aborted: false,
          closeSignal: null,
        };
      }
      if (command === "ffmpeg") {
        captureSignal = options.signal;
        options.onSpawn({ stdout: new EventEmitter() });
        return await new Promise((resolve) => {
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
      }
      throw new Error(`unexpected command: ${command}`);
    });
    const session = new FakeSession();
    const view = new FakeView();
    const controller = new SessionChatController({
      view,
      session,
      snapshot: await session.snapshot(),
      targetLabel: "in-process",
      deps: createMockDeps(spawn),
      config: {
        speechToText: { provider: "gemini" },
        apiKeys: { google: "gemini-key" },
      },
      speechToTextDeps: { webSocketFactory: createIdleSpeechWebSocketFactory() },
    });
    controller.retainedListenAudio = { audioPath: retainedPath, durationMs: 1_000 };

    try {
      const start = controller.onUserInput("/listen");
      await waitUntil(() => captureSignal !== undefined);
      await controller.dispose();
      await start;
      await expect(readFile(retainedPath)).resolves.toHaveLength(2048);
    } finally {
      await rm(retainedPath, { force: true });
      await rm(nextPath, { force: true });
    }

    expect(captureSignal.aborted).toBe(true);
    expect(controller.retainedListenAudio).toEqual({ audioPath: retainedPath, durationMs: 1_000 });
    expect(view.transcriptNotices).not.toContainEqual(
      expect.objectContaining({ text: "failed to start recording" }),
    );
  });

  it("keeps retained voice input on shutdown", async () => {
    const audioPath = join(tmpdir(), `tau-session-listen-shutdown-${Date.now()}.wav`);
    await writeFile(audioPath, Buffer.alloc(2048, 1));
    const session = new FakeSession();
    const controller = new SessionChatController({
      view: new FakeView(),
      session,
      snapshot: await session.snapshot(),
      targetLabel: "in-process",
      deps: createMockDeps(),
    });
    controller.retainedListenAudio = { audioPath, durationMs: 1_000 };

    try {
      await controller.dispose();
      await expect(readFile(audioPath)).resolves.toHaveLength(2048);
    } finally {
      await rm(audioPath, { force: true });
    }
  });

  it("routes /speak as a client-side command in session attach", async () => {
    const session = new FakeSession();
    const view = new FakeView();
    const controller = new SessionChatController({
      view,
      session,
      snapshot: await session.snapshot(),
      targetLabel: "ws://host",
      deps: createMockDeps(),
    });
    controller.start();

    controller.getInputHandlers().onSubmit("/speak");
    await flush();

    expect(view.footerNotices).toContainEqual({
      text: "no assistant message to speak yet.",
      tone: "default",
      durationMs: 3000,
    });
    expect(view.feedback).not.toContainEqual(
      expect.objectContaining({
        text: expect.stringContaining("not supported in protocol attach mode"),
      }),
    );
    expect(session.submit).not.toHaveBeenCalled();
  });

  it("streams the last session assistant message through local playback", async () => {
    const writtenAudio = [];
    const player = deferred();
    const stdin = new EventEmitter();
    stdin.destroyed = false;
    stdin.writableEnded = false;
    stdin.write = vi.fn((audio, callback) => {
      writtenAudio.push(Buffer.from(audio));
      callback();
      return true;
    });
    stdin.end = vi.fn((callback) => {
      stdin.writableEnded = true;
      callback();
      player.resolve({
        stdout: "",
        stderr: "",
        output: undefined,
        exitCode: 0,
        captureLimitExceeded: false,
        timedOut: false,
        aborted: false,
        closeSignal: null,
      });
    });
    const spawn = vi.fn((_cmd, _args, options) => {
      options.onSpawn?.({ stdin });
      return player.promise;
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
      targetLabel: "ws://host",
      deps: createMockDeps(spawn),
      config: { apiKeys: { google: "gemini-key" } },
    });
    const firstAudio = Buffer.alloc(12_000, 1);
    const secondAudio = Buffer.alloc(12_000, 2);
    const streamingBody = [
      {
        candidates: [
          {
            content: {
              parts: [{ inlineData: { data: firstAudio.toString("base64") } }],
            },
          },
        ],
      },
      {
        candidates: [
          {
            finishReason: "STOP",
            content: {
              parts: [{ inlineData: { data: secondAudio.toString("base64") } }],
            },
          },
        ],
      },
    ]
      .map((payload) => `data: ${JSON.stringify(payload)}\n\n`)
      .join("");
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
        new Response(streamingBody, {
          status: 200,
          headers: { "Content-Type": "text/event-stream" },
        }),
      );
    vi.stubGlobal("fetch", fetchMock);

    try {
      controller.start();
      await controller.speakLastAssistantMessage();
    } finally {
      vi.unstubAllGlobals();
    }

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const speechHints = view.statusUpdates
      .map((status) => (status.footer.type === "activity" ? status.footer.label : undefined))
      .filter((hint) => hint !== undefined);
    expect(speechHints).toEqual(
      expect.arrayContaining(["rewriting for speech", "preparing speech", "playing speech"]),
    );
    expect(view.status.footer.type).toBe("regular");
    expect(spawn).toHaveBeenCalledOnce();
    expect(spawn).toHaveBeenCalledWith(
      "ffplay",
      expect.arrayContaining([
        "-f",
        "s16le",
        "-ar",
        "24000",
        "-ch_layout",
        "mono",
        "-af",
        "atempo=1.15",
        "pipe:0",
      ]),
      expect.objectContaining({
        detached: true,
        killProcessGroup: true,
        stdio: ["pipe", "ignore", "pipe"],
        onSpawn: expect.any(Function),
      }),
    );
    expect(writtenAudio).toEqual([Buffer.concat([firstAudio, secondAudio])]);
    expect(stdin.end).toHaveBeenCalledOnce();
    expect(session.submit).not.toHaveBeenCalled();
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
            candidates: [{ content: { parts: [{ text: "Spoken version." }] } }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          `data: ${JSON.stringify({
            candidates: [
              {
                finishReason: "STOP",
                content: {
                  parts: [
                    {
                      inlineData: {
                        data: Buffer.alloc(24_000, 1).toString("base64"),
                      },
                    },
                  ],
                },
              },
            ],
          })}\n\n`,
          { status: 200, headers: { "Content-Type": "text/event-stream" } },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    try {
      const playback = runSpeechPlaybackTask({
        deps: createMockDeps(spawn),
        apiKey: "gemini-key",
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
            candidates: [{ content: { parts: [{ text: "Spoken version." }] } }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      )
      .mockImplementationOnce(async (_url, init) => {
        const encoder = new TextEncoder();
        return new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(
                encoder.encode(
                  `data: ${JSON.stringify({
                    candidates: [
                      {
                        content: {
                          parts: [
                            {
                              inlineData: {
                                data: Buffer.alloc(24_000, 1).toString("base64"),
                              },
                            },
                          ],
                        },
                      },
                    ],
                  })}\n\n`,
                ),
              );
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
          { status: 200, headers: { "Content-Type": "text/event-stream" } },
        );
      });
    vi.stubGlobal("fetch", fetchMock);

    try {
      const playback = runSpeechPlaybackTask({
        deps: createMockDeps(spawn),
        apiKey: "gemini-key",
        sourceText: "Original response.",
        signal: new AbortController().signal,
        onActivityLabel: vi.fn(),
      });
      const rejection = expect(playback).rejects.toThrow("ffplay failed: audio sink closed");

      await vi.waitFor(() => expect(stdin.write).toHaveBeenCalledOnce());
      player.resolve({
        stdout: "",
        stderr: "audio sink closed",
        output: undefined,
        exitCode: 1,
        captureLimitExceeded: false,
        timedOut: false,
        aborted: false,
        closeSignal: null,
      });

      await rejection;
    } finally {
      vi.unstubAllGlobals();
    }

    expect(streamAborted).toHaveBeenCalledOnce();
  });

  it("reports ffplay diagnostics when its stdin closes early", async () => {
    const stdin = new EventEmitter();
    stdin.destroyed = false;
    stdin.writableEnded = false;
    stdin.write = vi.fn((_audio, callback) => {
      const error = new Error("write EPIPE");
      error.code = "EPIPE";
      callback(error);
      return false;
    });
    const spawn = vi.fn(async (_command, _args, options) => {
      options.onSpawn?.({ stdin });
      return {
        stdout: "",
        stderr: "audio open failed",
        output: undefined,
        exitCode: 0,
        captureLimitExceeded: false,
        timedOut: false,
        aborted: false,
        closeSignal: null,
      };
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            candidates: [{ content: { parts: [{ text: "Spoken version." }] } }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          `data: ${JSON.stringify({
            candidates: [
              {
                finishReason: "STOP",
                content: {
                  parts: [{ inlineData: { data: Buffer.from([1, 2]).toString("base64") } }],
                },
              },
            ],
          })}\n\n`,
          { status: 200, headers: { "Content-Type": "text/event-stream" } },
        ),
      );
    vi.stubGlobal("fetch", fetchMock);

    try {
      await expect(
        runSpeechPlaybackTask({
          deps: createMockDeps(spawn),
          apiKey: "gemini-key",
          sourceText: "Original response.",
          signal: new AbortController().signal,
          onActivityLabel: vi.fn(),
        }),
      ).rejects.toThrow("ffplay failed: audio open failed");
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("exposes session catalog data for autocomplete", async () => {
    const session = new FakeSession();
    const view = new FakeView();
    const controller = new SessionChatController({
      view,
      session,
      snapshot: await session.snapshot(),
      targetLabel: "ws://host",
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
      targetLabel: "ws://host",
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
    expect(view.feedback).not.toContainEqual(
      expect.objectContaining({ text: "created new session" }),
    );
    expect(view.messages.length).toBeGreaterThan(messageCountBeforeNew);
    expect(view.messages).toContainEqual(
      expect.objectContaining({
        model: { type: "session_divider", label: "new session" },
      }),
    );
    expect(view.feedback).toContainEqual(
      expect.objectContaining({ text: "session id", tone: "default", content: ["session-2"] }),
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

  it("reconciles replacement-session activities after buffered agent deltas", async () => {
    const session = new FakeSession(updateSnapshot(createSnapshot(), { revision: 10 }));
    const nextSession = new FakeSession();
    nextSession.id = "session-2";
    nextSession.snapshotValue = { ...nextSession.snapshotValue, sessionId: nextSession.id };
    const agent = createAgentRun();
    const delta = {
      version: SESSION_PROTOCOL_VERSION,
      type: "session.delta",
      sessionId: nextSession.id,
      fromRevision: nextSession.snapshotValue.revision,
      toRevision: nextSession.snapshotValue.revision + 1,
      cause: { type: "agent-run" },
      delta: {
        type: "snapshot.patch",
        changes: [
          { type: "cost.set", costTotal: 0 },
          { type: "agent.set", agent },
        ],
      },
    };
    nextSession.subagentActivitiesValue = {
      revision: 2,
      agents: {
        [agent.id]: {
          runRevision: agent.run.revision,
          activities: [{ type: "assistant", text: "arrived during handoff" }],
        },
      },
    };
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
      targetLabel: "local",
    });
    controller.start();

    await controller.onUserInput("/new");

    expect(view.subagentSnapshots).toEqual([
      {
        state: expect.objectContaining({ id: agent.id }),
        activities: [{ type: "assistant", text: "arrived during handoff" }],
      },
    ]);
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
    const controller = new SessionChatController({
      view,
      session,
      snapshot: await session.snapshot(),
      targetLabel: "ws://host",
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

  it("warns when there are no session user messages to rewind", async () => {
    const session = new FakeSession();
    const view = new FakeView();
    const controller = new SessionChatController({
      view,
      session,
      snapshot: await session.snapshot(),
      targetLabel: "ws://host",
    });
    controller.start();

    controller.getInputHandlers().onSubmit("/rewind");
    await flush();

    expect(view.rewindPickerShows).toHaveLength(0);
    expect(view.feedback).toContainEqual({
      text: "no user messages available to rewind.",
      tone: "default",
    });
  });
});
