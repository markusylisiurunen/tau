import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { HistoryManager } from "../dist/core/history/history_manager.js";
import { LocalHistoryStore } from "../dist/core/history/local_history_store.js";
import { createLocalToolExecutionBackend } from "../dist/core/index.js";
import { resolveModel } from "../dist/core/models/catalog.js";
import { personas } from "../dist/core/personas.js";
import {
  buildToolRunPresentation,
  TOOL_UI_FACET_VERSION,
} from "../dist/core/tools/presentation.js";
import {
  hasGoalTurnMetadata,
  prependTauUserMetadata,
  stripTauUserDisplayText,
} from "../dist/core/utils/user_metadata.js";
import { HostedEphemeralAgentSession } from "../dist/host/hosted_ephemeral_agent_session.js";
import { LocalSessionHost } from "../dist/host/local_session_host.js";
import { EphemeralThreadBusyError } from "../dist/host/session_host.js";
import {
  applySessionProtocolDelta,
  SESSION_PROTOCOL_MAX_SUBAGENT_ASSISTANT_TEXT_BYTES,
  SESSION_PROTOCOL_MAX_SUBAGENT_NOTICE_CONTENT_BYTES,
  SESSION_PROTOCOL_MAX_SUBAGENT_SHORT_TEXT_BYTES,
  SESSION_PROTOCOL_MAX_SUBAGENT_TOOL_DETAILS_BYTES,
  SESSION_PROTOCOL_MAX_SUBAGENT_TOOL_METADATA_BYTES,
  SESSION_PROTOCOL_MAX_SUBAGENT_TOOL_SUBJECT_BYTES,
  SESSION_PROTOCOL_VERSION,
} from "../dist/protocol/session_protocol.js";
import { FileSessionStore } from "../dist/store/file_session_store.js";
import { MemorySessionStore } from "../dist/store/memory_session_store.js";
import {
  LEGACY_SESSION_MODEL_CONTEXT_KEY,
  STORED_SESSION_DOCUMENT_FORMAT,
  STORED_SESSION_DOCUMENT_VERSION,
} from "../dist/store/session_snapshot_migrations.js";
import { createProtocolSnapshot } from "./helpers/session_protocol_fixtures.js";

const localCreateInput = {
  executionEnvironment: { kind: "local", cwd: "/repo" },
  attributes: { source: "test" },
};

function createEnvironment(now = Date.parse("2026-01-01T00:00:00.000Z")) {
  return { now: () => now };
}

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function createTestExecutionEnvironment(
  snapshot = { kind: "local", cwd: "/repo", home: "/home/user" },
  toolBackend = createLocalToolExecutionBackend(),
) {
  return {
    resolveRuntimeConfig: async () => ({
      bootstrap: { modelResolver: { resolveModel } },
      config: {},
      personas: [personas[0]],
      prompts: [],
      skills: [],
      themes: [],
      warnings: [],
    }),
    resolveRuntimeContext: async ({ cwd, includeAgentContext }) => ({
      promptBootstrap: {
        promptContext: {
          cwd,
          home: snapshot.home,
          repoRoot: snapshot.cwd,
          platform: "linux",
          includeAgentContext,
        },
        agentsFiles: [],
        warnings: [],
        unknownSkills: [],
      },
    }),
    getToolExecutionBackend: () => toolBackend,
    snapshot: () => ({ ...snapshot }),
    dispose: async () => {},
  };
}

function createHost(store, options = {}) {
  const executionEnvironmentResolver = options.executionEnvironmentResolver ?? {
    resolve: async () => createTestExecutionEnvironment(),
    canRestore: (snapshot) => snapshot.kind === "local",
    restore: async (snapshot) => createTestExecutionEnvironment(snapshot),
  };

  return new LocalSessionHost({
    store,
    history: options.history ?? new HistoryManager(new LocalHistoryStore(":memory:")),
    ...(options.defaultBootstrap === false
      ? {}
      : {
          defaultBootstrap: {
            persona: options.persona ?? personas[0],
            discoveredSkills: [],
            personas: options.personas ?? [personas[0]],
            prompts: [],
            modelResolver: resolveModel,
            ...(options.config ? { config: options.config } : {}),
          },
        }),
    executionEnvironmentResolver,
    includeAgentContext: false,
    environment: createEnvironment(options.now),
    ...(options.recordUsage ? { recordUsage: options.recordUsage } : {}),
    ...(options.resolveSessionBootstrap
      ? { resolveSessionBootstrap: options.resolveSessionBootstrap }
      : {}),
  });
}

function createHostForEnvironment(store, executionEnvironment, options = {}) {
  return createHost(store, {
    ...options,
    executionEnvironmentResolver: {
      resolve: async () => executionEnvironment,
      canRestore: () => true,
      restore: async () => executionEnvironment,
    },
  });
}

function promptFixture() {
  return {
    environmentTag: "<environment></environment>",
    baseSystemPrompt: "system prompt",
    subagentPrompts: {},
  };
}

function createRunningSubagentState(id = "child-1") {
  return {
    id,
    name: "default",
    title: "long task",
    availability: "running",
    model: {
      provider: personas[0].model.provider,
      id: personas[0].model.id,
      reasoning: "medium",
    },
    workingDirectory: "/repo",
    createdAt: 1,
    run: {
      revision: 1,
      status: "running",
      startedAt: 1,
      interruptRequested: false,
    },
    costTotal: 0,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      contextWindowUsageTokens: 0,
      contextWindow: 100_000,
    },
  };
}

function expectedModel(persona = personas[0]) {
  const thinkingLevelMap = persona.model.thinkingLevelMap
    ? Object.fromEntries(
        Object.entries(persona.model.thinkingLevelMap).filter((entry) => entry[1] !== undefined),
      )
    : undefined;
  return {
    id: persona.model.id,
    name: persona.model.name,
    api: persona.model.api,
    provider: persona.model.provider,
    baseUrl: persona.model.baseUrl,
    reasoning: persona.model.reasoning,
    ...(thinkingLevelMap && Object.keys(thinkingLevelMap).length > 0 ? { thinkingLevelMap } : {}),
    input: [...persona.model.input],
    cost: { ...persona.model.cost },
    contextWindow: persona.model.contextWindow,
    maxTokens: persona.model.maxTokens,
    ...(persona.model.compat !== undefined
      ? { compat: structuredClone(persona.model.compat) }
      : {}),
  };
}

function expectedCatalogPersona(persona = personas[0]) {
  return {
    id: persona.id,
    label: persona.label,
    ...(persona.description !== undefined ? { description: persona.description } : {}),
    ...(persona.allowedReasoningLevels
      ? { allowedReasoningLevels: [...persona.allowedReasoningLevels] }
      : {}),
    ...(persona.subagents ? { subagents: structuredClone(persona.subagents) } : {}),
    ...(persona.tools ? { tools: [...persona.tools] } : {}),
    skills: Array.isArray(persona.skills) ? [...persona.skills] : persona.skills,
    source: persona.source,
  };
}

function expectedCatalog(persona = personas[0]) {
  return {
    personas: [expectedCatalogPersona(persona)],
    prompts: [],
    skills: [],
  };
}

function expectedSettings(persona = personas[0]) {
  return {
    personaId: persona.id,
    ...(persona.settings.reasoning !== undefined ? { reasoning: persona.settings.reasoning } : {}),
    ...(persona.settings.serviceTier !== undefined
      ? { serviceTier: persona.settings.serviceTier }
      : {}),
  };
}

function createStoredSnapshot(overrides = {}) {
  const persona = overrides.persona ?? personas[0];
  const systemPrompt = overrides.systemPrompt ?? "system prompt";
  const historyEntries = overrides.historyEntries ?? [];
  const messages = overrides.messages ?? [
    {
      id: "system",
      state: "committed",
      modelVisible: true,
      message: { role: "system", content: systemPrompt, timestamp: 0 },
    },
    ...historyEntries.map((entry) => ({
      id: entry.id,
      state: "committed",
      modelVisible: true,
      message: {
        timestamp: entry.message.timestamp ?? 0,
        ...entry.message,
      },
    })),
  ];
  return createProtocolSnapshot({
    sessionId: overrides.sessionId ?? "stored-session",
    attributes: overrides.attributes ?? { source: "test" },
    createdAt: overrides.createdAt ?? 0,
    revision: overrides.revision ?? 1,
    agentState: overrides.agentState ?? {
      revision: historyEntries.length,
      modelContextKey: "stored-context",
    },
    lifecycle: overrides.lifecycle ?? "idle",
    goal: overrides.goal ?? null,
    costTotal: overrides.costTotal ?? 0,
    bootstrap: overrides.bootstrap ?? {
      model: expectedModel(persona),
      prompt: {
        environmentTag: promptFixture().environmentTag,
        subagentPrompts: promptFixture().subagentPrompts,
      },
    },
    catalog: overrides.catalog ?? expectedCatalog(persona),
    settings: overrides.settings ?? expectedSettings(persona),
    executionEnvironment: overrides.executionEnvironment ?? {
      kind: "local",
      cwd: "/repo",
      home: "/home/user",
    },
    messages,
    turns: overrides.turns ?? {},
    timeline:
      overrides.timeline ??
      messages
        .filter((message) => message.id !== "system")
        .map((message) => ({
          type: "message",
          id: `timeline-${message.id}`,
          messageId: message.id,
        })),
    tools: overrides.tools ?? {},
    operations: overrides.operations,
    agents: overrides.agents ?? {},
    facets: overrides.facets ?? {},
  });
}

function historyEntriesFromSnapshot(snapshot) {
  return snapshot.messages
    .filter((entry) => entry.id !== "system" && entry.modelVisible)
    .map((entry) => ({ id: entry.id, message: entry.message }));
}

function snapshotUserMessageCount(snapshot) {
  return snapshot.messages.filter((message) => message.message.role === "user").length;
}

function assistantMessageWithToolCalls(toolCalls, costTotal = 0) {
  return {
    role: "assistant",
    api: "anthropic",
    provider: "anthropic",
    model: "claude-opus-4-8-20260115",
    stopReason: "tool_call",
    content: toolCalls,
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: costTotal },
    },
    timestamp: 1,
  };
}

function assistantPartial(text) {
  return {
    text,
    thinking: "",
    toolCalls: [],
    hasTextStarted: Boolean(text),
    hasAnyThinking: false,
  };
}

class BlockingCommitStore extends MemorySessionStore {
  nextCommitGate;

  blockNextCommit() {
    let release;
    let markStarted;
    const gate = {
      started: new Promise((resolve) => {
        markStarted = resolve;
      }),
      released: new Promise((resolve) => {
        release = resolve;
      }),
      markStarted: () => markStarted(),
      release: () => release(),
    };
    this.nextCommitGate = gate;
    return gate;
  }

  async commitSessionSnapshot(snapshot, options = {}) {
    const gate = this.nextCommitGate;
    if (gate) {
      this.nextCommitGate = undefined;
      gate.markStarted();
      await gate.released;
    }
    await super.commitSessionSnapshot(snapshot, options);
  }
}

describe("HostedEphemeralAgentSession", () => {
  it("rejects concurrent thread creation, submission, and forking without mutation", async () => {
    let markCreating;
    let releaseCreation;
    const creating = new Promise((resolve) => {
      markCreating = resolve;
    });
    const creationGate = new Promise((resolve) => {
      releaseCreation = resolve;
    });
    const submittedMessages = [];
    const thread = {
      async submitMessage(message) {
        submittedMessages.push(message);
        return "done";
      },
      createForkSource: () => ({ historyEntries: [], usageBaseline: {} }),
      interrupt: vi.fn(),
      dispose: vi.fn(),
    };
    const session = new HostedEphemeralAgentSession({
      contextId: "context-1",
      sessionId: "session-1",
      sessionStartedAt: 0,
      persona: personas[0],
      config: {},
      discoveredSkills: [],
      includeAgentContext: false,
      executionEnvironment: createTestExecutionEnvironment(),
      instructions: "review",
      tools: [],
      emitUpdate: vi.fn(),
    });
    session.createThread = vi.fn(async () => {
      markCreating();
      await creationGate;
      return thread;
    });

    const first = session.submitThreadMessage({
      contextId: "context-1",
      threadId: "thread-1",
      message: "first",
    });
    await creating;

    await expect(
      session.submitThreadMessage({
        contextId: "context-1",
        threadId: "thread-1",
        message: "duplicate",
      }),
    ).rejects.toBeInstanceOf(EphemeralThreadBusyError);
    await expect(
      session.submitThreadMessage({
        contextId: "context-1",
        threadId: "thread-2",
        forkFromThreadId: "thread-1",
        message: "fork",
      }),
    ).rejects.toBeInstanceOf(EphemeralThreadBusyError);

    releaseCreation();
    await expect(first).resolves.toEqual({ threadId: "thread-1", response: "done" });
    expect(session.createThread).toHaveBeenCalledTimes(1);
    expect(submittedMessages).toEqual(["first"]);
  });
});

describe("LocalSessionHost", () => {
  it("starts with a persistent warning when local history initialization fails", async () => {
    const root = mkdtempSync(join(tmpdir(), "tau-unavailable-history-"));
    const parentFile = join(root, "not-a-directory");
    writeFileSync(parentFile, "file");
    const history = HistoryManager.open(join(parentFile, "history.sqlite"));
    const host = createHost(new MemorySessionStore(), { history });

    try {
      const session = await host.createSession(localCreateInput);
      const snapshot = await session.snapshot();

      expect(snapshot.timeline.items).toContainEqual(
        expect.objectContaining({
          id: "notice-history-unavailable",
          type: "notice",
          notice: expect.objectContaining({
            kind: "tau.history.unavailable",
            severity: "warn",
            presentation: {
              title: "session history is unavailable",
              content: [
                expect.any(String),
                "this session will continue without durable history recording or recall",
              ],
            },
            subject: { type: "session" },
          }),
        }),
      );
      await expect(history.query().search({ limit: 10 })).rejects.toThrow(
        "session history is unavailable",
      );
    } finally {
      await host.shutdown();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("continues turns and warns once when local history projection fails", async () => {
    const historyStore = new LocalHistoryStore(":memory:");
    vi.spyOn(historyStore, "append").mockImplementation(() => {
      throw new Error("history disk failed");
    });
    const host = createHost(new MemorySessionStore(), {
      history: new HistoryManager(historyStore),
    });

    const session = await host.createSession(localCreateInput);
    await expect(session.record({ text: "first" })).resolves.toBeTruthy();
    await expect(session.record({ text: "second" })).resolves.toBeTruthy();

    const snapshot = await session.snapshot();
    expect(
      snapshot.timeline.items.filter((item) => item.id === "notice-history-unavailable"),
    ).toHaveLength(1);
    expect(snapshot.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          message: expect.objectContaining({
            content: [expect.objectContaining({ type: "text", text: "first" })],
          }),
        }),
        expect.objectContaining({
          message: expect.objectContaining({
            content: [expect.objectContaining({ type: "text", text: "second" })],
          }),
        }),
      ]),
    );

    await host.shutdown();
  });

  it("preserves durable notice position across recovery", async () => {
    const store = new MemorySessionStore();
    const originalHost = createHost(store);
    const originalSession = await originalHost.createSession(localCreateInput);
    await originalSession.record({ text: "before notice" });
    await originalSession.recordHistoryFailure("history unavailable");
    await originalSession.record({ text: "after notice" });
    const storedSnapshot = await originalSession.snapshot();

    expect(storedSnapshot.timeline.items.map((item) => item.type)).toEqual([
      "message",
      "notice",
      "message",
    ]);

    const recoveredHost = createHost(store);
    const recoveredSession = await recoveredHost.observeSession(storedSnapshot.sessionId);
    expect(recoveredSession).toBeDefined();
    await expect(recoveredSession?.snapshot()).resolves.toEqual(storedSnapshot);

    await recoveredHost.shutdown();
    await originalHost.shutdown();
  });

  it("captures committed session content and rewinds the active transcript", async () => {
    const historyStore = new LocalHistoryStore(":memory:");
    const history = new HistoryManager(historyStore);
    const host = createHost(new MemorySessionStore(), { history });
    const session = await host.createSession(localCreateInput);

    const recorded = await session.record({ text: "<system>keep this</system>\nhello" });
    await expect(
      historyStore.read({ sessionId: session.sessionId, limit: 10 }),
    ).resolves.toMatchObject({
      session: { attributes: { source: "test" } },
      entries: [
        {
          id: recorded.userHistoryEntryId,
          type: "user",
          content: [{ type: "text", text: "<system>keep this</system>\nhello" }],
        },
      ],
    });

    await session.rewindToHistoryEntryId(recorded.userHistoryEntryId);
    await expect(
      historyStore.read({ sessionId: session.sessionId, limit: 10 }),
    ).resolves.toMatchObject({ entries: [] });
    await host.shutdown();
  });

  it("persists turn acceptance atomically and settles the live outcome", async () => {
    const store = new MemorySessionStore();
    const commits = [];
    const commitSessionSnapshot = store.commitSessionSnapshot.bind(store);
    store.commitSessionSnapshot = vi.fn(async (snapshot, options) => {
      commits.push(structuredClone(snapshot));
      await commitSessionSnapshot(snapshot, options);
    });
    const host = createHost(store);
    const session = await host.createSession(localCreateInput);
    session.runtime.agent.spec.model.stream = () => ({
      async *[Symbol.asyncIterator]() {},
      async result() {
        return fauxAssistantMessage("done");
      },
    });

    const accepted = await session.acceptTurn({
      text: "run durably",
      historyEntryId: "durable-turn",
    });

    const acceptanceCommit = commits.find((snapshot) =>
      snapshot.messages.some((message) => message.id === "durable-turn"),
    );
    expect(acceptanceCommit?.turns["durable-turn"]).toEqual({
      userHistoryEntryId: "durable-turn",
      state: "running",
    });
    expect(accepted.snapshot.turns["durable-turn"]).toEqual(
      acceptanceCommit?.turns["durable-turn"],
    );

    const result = await session.runAcceptedTurn(accepted.userHistoryEntryId);
    expect(result.turn).toEqual({ status: "completed", stopReason: "stop" });
    await expect(session.snapshot()).resolves.toMatchObject({
      turns: {
        "durable-turn": {
          userHistoryEntryId: "durable-turn",
          state: "settled",
          outcome: result.turn,
        },
      },
    });
    await expect(session.runAcceptedTurn(accepted.userHistoryEntryId)).rejects.toThrow(
      "turn 'durable-turn' was already settled",
    );
    await host.shutdown();
  });

  it("rolls back turn acceptance when its atomic snapshot fails to persist", async () => {
    const store = new MemorySessionStore();
    const host = createHost(store);
    const session = await host.createSession(localCreateInput);
    await session.snapshot();
    const commitSessionSnapshot = store.commitSessionSnapshot.bind(store);
    let rejectAcceptance = true;
    store.commitSessionSnapshot = vi.fn(async (snapshot, options) => {
      if (
        rejectAcceptance &&
        snapshot.messages.some((message) => message.id === "failed-acceptance")
      ) {
        rejectAcceptance = false;
        throw new Error("acceptance persistence failed");
      }
      await commitSessionSnapshot(snapshot, options);
    });

    await expect(
      session.acceptTurn({ text: "persist atomically", historyEntryId: "failed-acceptance" }),
    ).rejects.toThrow("acceptance persistence failed");

    expect(
      session.runtime.rawHistoryEntries.some((entry) => entry.id === "failed-acceptance"),
    ).toBe(false);
    await expect(session.snapshot()).resolves.toMatchObject({
      messages: [expect.objectContaining({ id: "system" })],
      turns: {},
    });
    await expect(
      session.acceptTurn({ text: "retry safely", historyEntryId: "failed-acceptance" }),
    ).resolves.toMatchObject({
      userHistoryEntryId: "failed-acceptance",
      snapshot: {
        turns: {
          "failed-acceptance": {
            userHistoryEntryId: "failed-acceptance",
            state: "running",
          },
        },
      },
    });
    await host.shutdown();
  });

  it.each([
    {
      label: "failed",
      runtimeResult: {
        aborted: false,
        limitReached: { reason: "model-subturn-limit", message: "subturn limit reached" },
        terminalResult: {
          aborted: false,
          limitReached: { reason: "model-subturn-limit", message: "subturn limit reached" },
        },
      },
      outcome: { status: "failed", stopReason: "error", errorMessage: "subturn limit reached" },
    },
    {
      label: "blocked",
      runtimeResult: {
        aborted: false,
        blocked: { reason: "auto-compaction-failed", message: "summary unavailable" },
        terminalResult: {
          aborted: false,
          blocked: { reason: "auto-compaction-failed", message: "summary unavailable" },
        },
      },
      outcome: {
        status: "blocked",
        reason: "auto-compaction-failed",
        message: "summary unavailable",
      },
    },
    {
      label: "aborted",
      runtimeResult: {
        aborted: true,
        terminalResult: { aborted: true },
      },
      outcome: { status: "aborted", stopReason: "aborted" },
    },
  ])(
    "settles an accepted $label turn in the durable ledger",
    async ({ runtimeResult, outcome }) => {
      const host = createHost(new MemorySessionStore());
      const session = await host.createSession(localCreateInput);
      session.runtime.runTurn = vi.fn(async () => runtimeResult);

      const accepted = await session.acceptTurn({ text: "settle durably" });
      const result = await session.runAcceptedTurn(accepted.userHistoryEntryId);

      expect(result.turn).toEqual(outcome);
      expect((await session.snapshot()).turns[accepted.userHistoryEntryId]).toEqual({
        userHistoryEntryId: accepted.userHistoryEntryId,
        state: "settled",
        outcome,
      });
      await host.shutdown();
    },
  );

  it("normalizes accepted turn ids before durable compaction and reuse checks", async () => {
    const host = createHost(new MemorySessionStore());
    const session = await host.createSession(localCreateInput);
    const responses = [
      fauxAssistantMessage("completed before compaction"),
      fauxAssistantMessage(
        "compacted summary\n\n<preserved-user-message-ids>\n[]\n</preserved-user-message-ids>",
      ),
    ];
    session.runtime.agent.spec.model.stream = () => {
      const response = responses.shift();
      if (!response) throw new Error("unexpected model call");
      return {
        async *[Symbol.asyncIterator]() {},
        async result() {
          return response;
        },
      };
    };

    const accepted = await session.acceptTurn({
      text: "compact this turn",
      historyEntryId: " compacted-turn ",
    });
    expect(accepted.userHistoryEntryId).toBe("compacted-turn");
    const result = await session.runAcceptedTurn(accepted.userHistoryEntryId);
    const compacted = await session.compact({ mode: "summary-only" });

    expect(compacted.snapshot.messages.some((message) => message.id === "compacted-turn")).toBe(
      false,
    );
    expect(compacted.snapshot.turns["compacted-turn"]).toEqual({
      userHistoryEntryId: "compacted-turn",
      state: "settled",
      outcome: result.turn,
    });
    await expect(
      session.acceptTurn({ text: "repeat work", historyEntryId: " compacted-turn " }),
    ).rejects.toThrow("turn 'compacted-turn' was already accepted");
    await expect(
      session.record({ text: "reuse message id", historyEntryId: " compacted-turn " }),
    ).rejects.toThrow("history entry id 'compacted-turn' belongs to an accepted turn");
    await host.shutdown();
  });

  it("preserves a running root receipt through split-turn compaction", async () => {
    const host = createHost(new MemorySessionStore());
    const session = await host.createSession(localCreateInput);
    const accepted = await session.acceptTurn({
      text: "compact while running",
      historyEntryId: "split-turn-root",
    });
    const previousState = session.runtime.agent.snapshot();
    const summaryText = prependTauUserMetadata("summary", [
      { type: "compaction", version: 1, summary: "summary", preservedUserMessages: [] },
    ]);
    const continuationText = prependTauUserMetadata("", [
      { type: "auto-compaction-continuation", version: 1 },
    ]);
    const revision = previousState.revision + 1;
    session.runtime.agent.restoreState({
      ...previousState,
      revision,
      historyEntries: [
        {
          id: "split-turn-summary",
          message: {
            role: "user",
            content: [{ type: "text", text: summaryText }],
            timestamp: 1,
          },
        },
        {
          id: "split-turn-continuation",
          message: {
            role: "user",
            content: [{ type: "text", text: continuationText }],
            timestamp: 2,
          },
        },
      ],
    });

    await session.enqueueRuntimeEvent({
      type: "compaction_end",
      reason: "threshold",
      outcome: "compacted",
      result: {
        summaryHistoryEntryId: "split-turn-summary",
        continuationHistoryEntryId: "split-turn-continuation",
        compactionMessage: summaryText,
        cutType: "split-turn",
        retainedMessageCount: 0,
      },
      revision,
    });

    const snapshot = await session.snapshot();
    expect(snapshot.messages.some((message) => message.id === accepted.userHistoryEntryId)).toBe(
      false,
    );
    expect(snapshot.turns[accepted.userHistoryEntryId]).toEqual({
      userHistoryEntryId: accepted.userHistoryEntryId,
      state: "running",
    });
    await host.shutdown();
  });

  it("preserves rewound turn receipts and rejects explicit id reuse", async () => {
    const host = createHost(new MemorySessionStore());
    const session = await host.createSession(localCreateInput);
    await session.acceptTurn({ text: "rewind this turn", historyEntryId: "rewound-turn" });

    await session.rewindToHistoryEntryId("rewound-turn");

    await expect(session.snapshot()).resolves.toMatchObject({
      turns: {
        "rewound-turn": {
          userHistoryEntryId: "rewound-turn",
          state: "running",
        },
      },
    });
    await expect(
      session.acceptTurn({ text: "repeat work", historyEntryId: "rewound-turn" }),
    ).rejects.toThrow("turn 'rewound-turn' was already accepted");
    await expect(
      session.record({ text: "reuse message id", historyEntryId: "rewound-turn" }),
    ).rejects.toThrow("history entry id 'rewound-turn' belongs to an accepted turn");
    await host.shutdown();
  });

  it("captures terminal tool results committed through recovery", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "tau-tool-recovery-history-"));
    const historyStore = new LocalHistoryStore(":memory:");
    const history = new HistoryManager(historyStore);
    const executionEnvironment = createTestExecutionEnvironment({
      kind: "local",
      cwd,
      home: cwd,
    });
    const host = createHostForEnvironment(new MemorySessionStore(), executionEnvironment, {
      history,
      recordUsage: vi.fn(),
    });

    try {
      const session = await host.createSession({
        executionEnvironment: { kind: "local", cwd },
        attributes: { source: "test" },
      });
      const toolCall = fauxToolCall(
        "bash",
        { command: "printf recovered" },
        { id: "recovered-tool" },
      );
      const failedMessage = fauxAssistantMessage([toolCall], {
        stopReason: "error",
        errorMessage: "connection reset",
      });
      const recoveredMessage = fauxAssistantMessage("continued after recovery");
      const responses = [failedMessage, recoveredMessage];
      session.runtime.agent.spec.model.stream = () => {
        const response = responses.shift();
        return {
          async *[Symbol.asyncIterator]() {
            if (response !== failedMessage) return;
            yield { type: "toolcall_start", contentIndex: 0, partial: failedMessage };
            yield {
              type: "toolcall_end",
              contentIndex: 0,
              toolCall,
              partial: failedMessage,
            };
          },
          async result() {
            return response;
          },
        };
      };

      await session.record({ text: "run once" });
      await expect(session.runTurn()).resolves.toMatchObject({ status: "completed" });
      await expect(
        historyStore.read({ sessionId: session.sessionId, limit: 10 }),
      ).resolves.toMatchObject({
        entries: [
          { type: "user", content: [{ type: "text", text: "run once" }] },
          {
            id: toolCall.id,
            type: "tool",
            name: "bash",
            arguments: { command: "printf recovered" },
            result: [{ type: "text", text: expect.stringContaining("recovered") }],
            outcome: "succeeded",
          },
          { type: "assistant", content: "continued after recovery" },
        ],
      });
    } finally {
      await host.shutdown();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("continues retry from completed tool results without truncating history", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "tau-retry-tool-history-"));
    const historyStore = new LocalHistoryStore(":memory:");
    const truncateHistory = vi.spyOn(historyStore, "truncateFromSources");
    const toolBackend = createLocalToolExecutionBackend();
    const runBash = vi.spyOn(toolBackend, "runBash");
    const executionEnvironment = createTestExecutionEnvironment(
      { kind: "local", cwd, home: cwd },
      toolBackend,
    );
    const host = createHostForEnvironment(new MemorySessionStore(), executionEnvironment, {
      history: new HistoryManager(historyStore),
    });

    try {
      const session = await host.createSession({
        executionEnvironment: { kind: "local", cwd },
        attributes: { source: "test" },
      });
      const toolCall = fauxToolCall("bash", { command: "printf once" }, { id: "retry-tool" });
      const toolMessage = fauxAssistantMessage([toolCall], { stopReason: "toolUse" });
      const interruptedMessage = fauxAssistantMessage("interrupted", { stopReason: "aborted" });
      const completedMessage = fauxAssistantMessage("continued");
      const secondSubturnStarted = deferred();
      const contexts = [];
      let subturn = 0;
      session.runtime.agent.spec.model.stream = (context, options) => {
        contexts.push(context);
        subturn += 1;
        if (subturn === 1) {
          return {
            async *[Symbol.asyncIterator]() {
              yield { type: "toolcall_start", contentIndex: 0, partial: toolMessage };
              yield {
                type: "toolcall_end",
                contentIndex: 0,
                toolCall,
                partial: toolMessage,
              };
            },
            async result() {
              return toolMessage;
            },
          };
        }
        if (subturn === 2) {
          secondSubturnStarted.resolve();
          return {
            async *[Symbol.asyncIterator]() {
              if (!options.signal.aborted) {
                await new Promise((resolve) =>
                  options.signal.addEventListener("abort", resolve, { once: true }),
                );
              }
            },
            async result() {
              return interruptedMessage;
            },
          };
        }
        return {
          async *[Symbol.asyncIterator]() {},
          async result() {
            return completedMessage;
          },
        };
      };

      await session.record({ text: "run the tool" });
      const firstTurn = session.runTurn();
      await secondSubturnStarted.promise;
      expect(runBash).toHaveBeenCalledOnce();
      expect(session.interruptTurn()).toBe(true);
      await expect(firstTurn).resolves.toMatchObject({ status: "aborted" });

      const snapshotBeforeRetry = await session.snapshot();
      const runtimeIdsBeforeRetry = session.runtime.rawHistoryEntries.map((entry) => entry.id);
      const transcriptBeforeRetry = await historyStore.read({
        sessionId: session.sessionId,
        limit: 10,
      });

      await expect(session.retryTurn()).resolves.toMatchObject({ status: "completed" });

      const snapshotAfterRetry = await session.snapshot();
      const transcriptAfterRetry = await historyStore.read({
        sessionId: session.sessionId,
        limit: 10,
      });
      expect(
        snapshotAfterRetry.messages
          .slice(0, snapshotBeforeRetry.messages.length)
          .map((message) => message.id),
      ).toEqual(snapshotBeforeRetry.messages.map((message) => message.id));
      expect(
        session.runtime.rawHistoryEntries
          .slice(0, runtimeIdsBeforeRetry.length)
          .map((entry) => entry.id),
      ).toEqual(runtimeIdsBeforeRetry);
      expect(transcriptAfterRetry.entries.slice(0, transcriptBeforeRetry.entries.length)).toEqual(
        transcriptBeforeRetry.entries,
      );
      expect(truncateHistory).not.toHaveBeenCalled();
      expect(runBash).toHaveBeenCalledOnce();
      expect(contexts[2].messages.map((message) => message.role)).toEqual([
        "user",
        "assistant",
        "toolResult",
      ]);
      expect(contexts[2].messages[1].content).toContainEqual(
        expect.objectContaining({ type: "toolCall", id: toolCall.id }),
      );
      expect(contexts[2].messages[2]).toMatchObject({
        role: "toolResult",
        toolCallId: toolCall.id,
      });
    } finally {
      await host.shutdown();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("creates, attaches, lists, snapshots, and shuts down local sessions", async () => {
    const store = new MemorySessionStore();
    const host = createHost(store);
    await expect(host.listSessions()).resolves.toEqual([]);
    const hostedSession = await host.createSession(localCreateInput);
    expect(hostedSession.session.sessionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );

    await hostedSession.session.commitUserText("hello");

    await expect(host.observeSession(hostedSession.session.sessionId)).resolves.toBe(hostedSession);
    await expect(host.listSessions()).resolves.toEqual([
      { sessionId: hostedSession.session.sessionId, lifecycle: "idle" },
    ]);
    await expect(hostedSession.snapshot()).resolves.toEqual(
      expect.objectContaining({
        sessionId: hostedSession.session.sessionId,
        revision: 1,
        lifecycle: "idle",
        settings: expectedSettings(),
        bootstrap: {
          model: expectedModel(),
          prompt: {
            environmentTag: hostedSession.runtime.promptComposition.environmentTag,
            subagentPrompts: hostedSession.runtime.promptComposition.subagentPrompts,
          },
        },
        catalog: expectedCatalog(),
        executionEnvironment: {
          kind: "local",
          cwd: "/repo",
          home: "/home/user",
        },
        messages: [
          expect.objectContaining({
            id: "system",
            modelVisible: true,
            message: expect.objectContaining({
              role: "system",
              content: hostedSession.runtime.promptComposition.baseSystemPrompt,
            }),
          }),
          expect.objectContaining({
            id: hostedSession.session.historyEntries[0].id,
            message: hostedSession.session.historyEntries[0].message,
          }),
        ],
        tools: {},
        agents: {},
        facets: {},
      }),
    );
    await expect(hostedSession.snapshot()).resolves.toEqual(
      expect.objectContaining({ revision: 1 }),
    );
    await hostedSession.session.commitUserText("next");
    await expect(hostedSession.snapshot()).resolves.toEqual(
      expect.objectContaining({ revision: 2 }),
    );

    const returnedSnapshot = await hostedSession.snapshot();
    returnedSnapshot.messages[1].message.content[0].text = "mutated outside";
    await expect(hostedSession.snapshot()).resolves.toEqual(
      expect.objectContaining({
        revision: 2,
        messages: expect.arrayContaining([
          expect.objectContaining({
            id: "system",
          }),
          expect.objectContaining({
            id: hostedSession.session.historyEntries[0].id,
            message: expect.objectContaining({
              role: "user",
              content: [{ type: "text", text: "hello" }],
            }),
          }),
          expect.objectContaining({
            message: expect.objectContaining({
              role: "user",
              content: [{ type: "text", text: "next" }],
            }),
          }),
        ]),
      }),
    );

    const previousId = hostedSession.sessionId;
    hostedSession.session.reset();

    await expect(host.observeSession(previousId)).resolves.toBeUndefined();
    await expect(store.loadSession(previousId)).resolves.toBeUndefined();
    await expect(host.observeSession(hostedSession.sessionId)).resolves.toBe(hostedSession);
    await expect(hostedSession.snapshot()).resolves.toEqual(
      expect.objectContaining({
        sessionId: hostedSession.sessionId,
        revision: 1,
      }),
    );
    await expect(host.listSessions()).resolves.toEqual([
      { sessionId: hostedSession.sessionId, lifecycle: "idle" },
    ]);
    await expect(store.loadSession(hostedSession.sessionId)).resolves.toEqual(
      await hostedSession.snapshot(),
    );

    const nextSession = await host.createSession(localCreateInput);
    await expect(host.observeSession(nextSession.sessionId)).resolves.toBe(nextSession);
    expect(nextSession.session.history).toEqual([]);
    await expect(host.listSessions()).resolves.toEqual([
      { sessionId: hostedSession.sessionId, lifecycle: "idle" },
      { sessionId: nextSession.sessionId, lifecycle: "idle" },
    ]);

    await host.shutdown();

    await expect(store.loadSession(hostedSession.sessionId)).resolves.toEqual(
      expect.objectContaining({ sessionId: hostedSession.sessionId }),
    );
    await expect(store.loadSession(nextSession.sessionId)).resolves.toEqual(
      expect.objectContaining({ sessionId: nextSession.sessionId }),
    );

    const recoveredHost = createHost(store);
    await expect(recoveredHost.observeSession(hostedSession.session.sessionId)).resolves.toEqual(
      expect.objectContaining({
        session: expect.objectContaining({
          sessionId: hostedSession.session.sessionId,
        }),
      }),
    );
  });

  it("continues an active goal until the model completes it", async () => {
    const store = new MemorySessionStore();
    const host = createHost(store);
    const hostedSession = await host.createSession(localCreateInput);
    await hostedSession.snapshot();
    const deltas = [];
    hostedSession.onDelta((delta) => deltas.push(delta));
    const completeCall = fauxToolCall(
      "update_goal",
      { status: "complete" },
      { id: "complete-goal" },
    );
    const toolMessage = fauxAssistantMessage([completeCall], { stopReason: "toolUse" });
    const responses = [
      fauxAssistantMessage("I stopped too soon"),
      toolMessage,
      fauxAssistantMessage("Goal complete"),
    ];
    const contexts = [];
    hostedSession.runtime.agent.spec.model.stream = (context) => {
      contexts.push(context);
      const response = responses.shift();
      return {
        async *[Symbol.asyncIterator]() {
          if (response === toolMessage) {
            yield { type: "toolcall_start", contentIndex: 0, partial: toolMessage };
            yield {
              type: "toolcall_end",
              contentIndex: 0,
              toolCall: completeCall,
              partial: toolMessage,
            };
          }
        },
        async result() {
          return response;
        },
      };
    };

    await expect(hostedSession.startGoal("Ship the feature")).resolves.toMatchObject({
      turn: { status: "completed" },
    });

    const snapshot = await hostedSession.snapshot();
    expect(snapshot.goal).toBeNull();
    const startDelta = deltas.find(
      (delta) =>
        delta.cause.type === "user-message" &&
        delta.delta.type === "snapshot.patch" &&
        delta.delta.changes.some((change) => change.type === "goal.set"),
    );
    expect(startDelta?.delta.changes).toEqual(
      expect.arrayContaining([
        { type: "goal.set", goal: { objective: "Ship the feature", status: "active" } },
        expect.objectContaining({ type: "message.append" }),
      ]),
    );
    expect(contexts).toHaveLength(3);
    expect(
      contexts[0].messages.some(
        (message) =>
          message.role === "user" &&
          JSON.stringify(message.content).includes("<goal-objective>\\nShip the feature"),
      ),
    ).toBe(true);
    const hiddenContinuation = snapshot.messages.find(
      (message) =>
        message.message.role === "user" &&
        stripTauUserDisplayText(message.message.content[0].text) === "",
    );
    expect(hiddenContinuation?.modelVisible).toBe(true);
    expect(snapshot.tools[completeCall.id]).toMatchObject({ status: "succeeded" });
    await host.shutdown();
  });

  it("cancels an active goal while the runtime is idle between continuations", async () => {
    const store = new MemorySessionStore();
    const host = createHost(store);
    const hostedSession = await host.createSession(localCreateInput);
    await hostedSession.snapshot();
    const persistenceReached = deferred();
    const releasePersistence = deferred();
    const commitSessionSnapshot = store.commitSessionSnapshot.bind(store);
    let paused = false;
    store.commitSessionSnapshot = vi.fn(async (snapshot, options) => {
      if (!paused && snapshotUserMessageCount(snapshot) >= 2) {
        paused = true;
        persistenceReached.resolve();
        await releasePersistence.promise;
      }
      return await commitSessionSnapshot(snapshot, options);
    });
    const streamModel = vi.fn(() => ({
      async *[Symbol.asyncIterator]() {},
      async result() {
        return fauxAssistantMessage("more work remains");
      },
    }));
    hostedSession.runtime.agent.spec.model.stream = streamModel;

    const run = hostedSession.startGoal("Finish across turns");
    await persistenceReached.promise;

    expect(hostedSession.runtime.isTurnRunning).toBe(false);
    expect(hostedSession.interruptActiveWork()).toBe(true);
    releasePersistence.resolve();

    const result = await run;
    expect(result.turn).toEqual({ status: "aborted", stopReason: "aborted" });
    expect(streamModel).toHaveBeenCalledOnce();
    const snapshot = await hostedSession.snapshot();
    expect(snapshot.goal).toEqual({ objective: "Finish across turns", status: "blocked" });
    await host.shutdown();
  });

  it("cancels goal startup while the objective message is still persisting", async () => {
    const store = new MemorySessionStore();
    const host = createHost(store);
    const hostedSession = await host.createSession(localCreateInput);
    await hostedSession.snapshot();
    const persistenceReached = deferred();
    const releasePersistence = deferred();
    const commitSessionSnapshot = store.commitSessionSnapshot.bind(store);
    let paused = false;
    store.commitSessionSnapshot = vi.fn(async (snapshot, options) => {
      if (
        !paused &&
        snapshot.goal?.status === "active" &&
        snapshot.messages.some((message) => message.message.role === "user")
      ) {
        paused = true;
        persistenceReached.resolve();
        await releasePersistence.promise;
      }
      return await commitSessionSnapshot(snapshot, options);
    });
    const streamModel = vi.fn();
    hostedSession.runtime.agent.spec.model.stream = streamModel;

    const run = hostedSession.startGoal("Start safely");
    await persistenceReached.promise;

    expect(hostedSession.runtime.isTurnRunning).toBe(false);
    expect(hostedSession.interruptActiveWork()).toBe(true);
    releasePersistence.resolve();

    await expect(run).resolves.toMatchObject({ turn: { status: "aborted" } });
    expect(streamModel).not.toHaveBeenCalled();
    await expect(hostedSession.snapshot()).resolves.toMatchObject({
      goal: { objective: "Start safely", status: "blocked" },
    });
    await host.shutdown();
  });

  it("cancels goal resume before recording its continuation", async () => {
    const store = new MemorySessionStore();
    const host = createHost(store);
    const hostedSession = await host.createSession(localCreateInput);
    await hostedSession.snapshot();
    await hostedSession.createGoal("Resume safely");
    await hostedSession.updateGoal({ status: "blocked" });
    const userMessageCount = hostedSession.runtime.rawHistory.filter(
      (message) => message.role === "user",
    ).length;
    const persistenceReached = deferred();
    const releasePersistence = deferred();
    const commitSessionSnapshot = store.commitSessionSnapshot.bind(store);
    let paused = false;
    store.commitSessionSnapshot = vi.fn(async (snapshot, options) => {
      if (!paused && snapshot.goal?.status === "active") {
        paused = true;
        persistenceReached.resolve();
        await releasePersistence.promise;
      }
      return await commitSessionSnapshot(snapshot, options);
    });
    const streamModel = vi.fn();
    hostedSession.runtime.agent.spec.model.stream = streamModel;

    const run = hostedSession.resumeGoal();
    await persistenceReached.promise;

    expect(hostedSession.interruptActiveWork()).toBe(true);
    releasePersistence.resolve();

    await expect(run).resolves.toEqual({
      turn: { status: "aborted", stopReason: "aborted" },
    });
    expect(streamModel).not.toHaveBeenCalled();
    expect(
      hostedSession.runtime.rawHistory.filter((message) => message.role === "user"),
    ).toHaveLength(userMessageCount);
    await expect(hostedSession.snapshot()).resolves.toMatchObject({
      goal: { objective: "Resume safely", status: "blocked" },
    });
    await host.shutdown();
  });

  it("keeps automatic goal continuations within the root turn receipt", async () => {
    const host = createHost(new MemorySessionStore());
    const hostedSession = await host.createSession(localCreateInput);
    const responses = [
      fauxAssistantMessage("more work remains"),
      fauxAssistantMessage("", { stopReason: "aborted" }),
    ];
    hostedSession.runtime.agent.spec.model.stream = () => {
      const response = responses.shift();
      if (!response) throw new Error("unexpected model call");
      return {
        async *[Symbol.asyncIterator]() {},
        async result() {
          return response;
        },
      };
    };

    const result = await hostedSession.startGoal("Continue under one root");
    const snapshot = await hostedSession.snapshot();

    expect(
      hostedSession.runtime.rawHistoryEntries.filter((entry) => entry.message.role === "user"),
    ).toHaveLength(2);
    expect(snapshot.turns).toEqual({
      [result.userHistoryEntryId]: {
        userHistoryEntryId: result.userHistoryEntryId,
        state: "settled",
        outcome: result.turn,
      },
    });
    expect(result.turn).toEqual({ status: "aborted", stopReason: "aborted" });
    await host.shutdown();
  });

  it("applies steering received between active goal continuations", async () => {
    const store = new MemorySessionStore();
    const host = createHost(store);
    const hostedSession = await host.createSession(localCreateInput);
    await hostedSession.snapshot();
    const persistenceReached = deferred();
    const releasePersistence = deferred();
    const commitSessionSnapshot = store.commitSessionSnapshot.bind(store);
    let paused = false;
    store.commitSessionSnapshot = vi.fn(async (snapshot, options) => {
      if (!paused && snapshotUserMessageCount(snapshot) >= 2) {
        paused = true;
        persistenceReached.resolve();
        await releasePersistence.promise;
      }
      return await commitSessionSnapshot(snapshot, options);
    });
    const streamModel = vi
      .fn()
      .mockImplementationOnce(() => ({
        async *[Symbol.asyncIterator]() {},
        async result() {
          return fauxAssistantMessage("more work remains");
        },
      }))
      .mockImplementationOnce(() => ({
        async *[Symbol.asyncIterator]() {},
        async result() {
          return fauxAssistantMessage("", { stopReason: "aborted" });
        },
      }));
    hostedSession.runtime.agent.spec.model.stream = streamModel;

    const run = hostedSession.startGoal("Accept steering");
    await persistenceReached.promise;
    expect(hostedSession.canAcceptSteering).toBe(true);
    const steering = hostedSession.steer("change the implementation");
    releasePersistence.resolve();

    const applied = await steering.applied;
    await expect(steering.result).resolves.toMatchObject({
      userHistoryEntryId: applied.userHistoryEntryId,
      turn: { status: "aborted" },
    });
    await expect(run).resolves.toMatchObject({ turn: { status: "aborted" } });
    expect(streamModel).toHaveBeenCalledTimes(2);
    const steeringMessage = hostedSession.runtime.rawHistoryEntries.find(
      (entry) => entry.id === applied.userHistoryEntryId,
    )?.message;
    expect(steeringMessage?.role).toBe("user");
    expect(hasGoalTurnMetadata(steeringMessage)).toBe(true);
    expect(stripTauUserDisplayText(steeringMessage.content[0].text)).toBe(
      "change the implementation",
    );
    await host.shutdown();
  });

  it("rejects retry for a goal-controlled continuation", async () => {
    const host = createHost(new MemorySessionStore());
    const hostedSession = await host.createSession(localCreateInput);
    const streamModel = vi
      .fn()
      .mockImplementationOnce(() => ({
        async *[Symbol.asyncIterator]() {},
        async result() {
          return fauxAssistantMessage("more work remains");
        },
      }))
      .mockImplementationOnce(() => ({
        async *[Symbol.asyncIterator]() {},
        async result() {
          return fauxAssistantMessage("", { stopReason: "aborted" });
        },
      }));
    hostedSession.runtime.agent.spec.model.stream = streamModel;

    await hostedSession.startGoal("Do not retry stale policy");

    const latestUserMessage = hostedSession.runtime.rawHistory.findLast(
      (message) => message.role === "user",
    );
    expect(hasGoalTurnMetadata(latestUserMessage)).toBe(true);
    await expect(hostedSession.retryTurn()).rejects.toThrow(
      "goal-controlled turns cannot be retried",
    );
    expect(streamModel).toHaveBeenCalledTimes(2);
    await host.shutdown();
  });

  it("uses a steering continuation's terminal outcome for an active goal", async () => {
    const host = createHost(new MemorySessionStore());
    const hostedSession = await host.createSession(localCreateInput);
    const firstRun = deferred();
    const streamModel = vi
      .fn()
      .mockImplementationOnce(() => ({
        async *[Symbol.asyncIterator]() {
          await firstRun.promise;
          yield* [];
        },
        async result() {
          return fauxAssistantMessage("initial response");
        },
      }))
      .mockImplementationOnce(() => ({
        async *[Symbol.asyncIterator]() {},
        async result() {
          return fauxAssistantMessage("", { stopReason: "aborted" });
        },
      }))
      .mockImplementation(() => {
        throw new Error("goal continued after terminal steering outcome");
      });
    hostedSession.runtime.agent.spec.model.stream = streamModel;

    const run = hostedSession.startGoal("Follow steering safely");
    await vi.waitFor(() => expect(hostedSession.runtime.isTurnRunning).toBe(true));
    const steering = hostedSession.steer("change direction");
    firstRun.resolve();

    const steeringResult = await steering.result;
    expect(steeringResult).toMatchObject({
      turn: { status: "aborted" },
    });
    const steeringMessage = hostedSession.runtime.rawHistoryEntries.find(
      (entry) => entry.id === steeringResult.userHistoryEntryId,
    )?.message;
    expect(hasGoalTurnMetadata(steeringMessage)).toBe(true);
    const result = await run;
    expect(result.turn).toEqual({ status: "aborted", stopReason: "aborted" });
    expect(streamModel).toHaveBeenCalledTimes(2);
    const snapshot = await hostedSession.snapshot();
    expect(snapshot.goal).toEqual({ objective: "Follow steering safely", status: "blocked" });
    expect(snapshot.turns[steeringResult.userHistoryEntryId]).toEqual({
      userHistoryEntryId: steeringResult.userHistoryEntryId,
      state: "settled",
      outcome: steeringResult.turn,
    });
    expect(snapshot.turns[result.userHistoryEntryId]).toEqual({
      userHistoryEntryId: result.userHistoryEntryId,
      state: "settled",
      outcome: result.turn,
    });
    await host.shutdown();
  });

  it("persists runtime turn failures at the terminal timeline position", async () => {
    const store = new MemorySessionStore();
    const host = createHost(store);
    const hostedSession = await host.createSession(localCreateInput);
    await hostedSession.snapshot();
    const persistenceReached = deferred();
    const releasePersistence = deferred();
    const finalText = "after steering";
    const commitSessionSnapshot = store.commitSessionSnapshot.bind(store);
    let paused = false;
    let injectedFailure = false;
    store.commitSessionSnapshot = vi.fn(async (snapshot, options) => {
      if (!paused && snapshotUserMessageCount(snapshot) >= 2) {
        paused = true;
        persistenceReached.resolve();
        await releasePersistence.promise;
      }
      const hasFinalMessage = snapshot.messages.some(
        (message) =>
          message.message.role === "assistant" &&
          message.message.content.some(
            (content) => content.type === "text" && content.text === finalText,
          ),
      );
      if (!injectedFailure && hasFinalMessage) {
        injectedFailure = true;
        throw new Error("steering event sink failed");
      }
      await commitSessionSnapshot(snapshot, options);
    });
    hostedSession.runtime.agent.spec.model.stream = vi
      .fn()
      .mockImplementationOnce(() => ({
        async *[Symbol.asyncIterator]() {},
        async result() {
          return fauxAssistantMessage("before steering");
        },
      }))
      .mockImplementationOnce(() => ({
        async *[Symbol.asyncIterator]() {},
        async result() {
          return fauxAssistantMessage(finalText);
        },
      }));

    const run = hostedSession.startGoal("Fail after steering");
    await persistenceReached.promise;
    const steering = hostedSession.steer("change direction");
    releasePersistence.resolve();

    await steering.applied;
    const [runResult, steeringResult] = await Promise.all([run, steering.result]);
    expect(runResult.turn).toEqual({
      status: "failed",
      stopReason: "error",
      errorMessage: "steering event sink failed",
    });
    expect(steeringResult.turn).toEqual(runResult.turn);
    const snapshot = await hostedSession.snapshot();
    expect(snapshot.timeline.items.at(-1)).toMatchObject({
      type: "notice",
      notice: {
        kind: "tau.turn.failed",
        severity: "error",
        presentation: {
          title: "turn failed",
          content: ["steering event sink failed"],
        },
        data: { reason: "runtime-error" },
      },
    });
    await host.shutdown();
  });

  it("rolls back goal mutations when persistence fails", async () => {
    const store = new MemorySessionStore();
    const host = createHost(store);
    const hostedSession = await host.createSession(localCreateInput);
    await hostedSession.snapshot();
    const commitSessionSnapshot = vi.spyOn(store, "commitSessionSnapshot");

    commitSessionSnapshot.mockRejectedValueOnce(new Error("create failed"));
    await expect(hostedSession.createGoal("Persist safely")).rejects.toThrow("create failed");
    expect(hostedSession.getGoal()).toBeNull();

    await expect(hostedSession.createGoal("Persist safely")).resolves.toEqual({
      objective: "Persist safely",
      status: "active",
    });
    commitSessionSnapshot.mockRejectedValueOnce(new Error("update failed"));
    await expect(hostedSession.updateGoal({ objective: "Rejected update" })).rejects.toThrow(
      "update failed",
    );
    expect(hostedSession.getGoal()).toEqual({ objective: "Persist safely", status: "active" });

    commitSessionSnapshot.mockRejectedValueOnce(new Error("clear failed"));
    await expect(hostedSession.updateGoal({ status: "complete" })).rejects.toThrow("clear failed");
    expect(hostedSession.getGoal()).toEqual({ objective: "Persist safely", status: "active" });
    await host.shutdown();
  });

  it("updates goal objectives without weakening completion semantics", async () => {
    const host = createHost(new MemorySessionStore());
    const hostedSession = await host.createSession(localCreateInput);

    await hostedSession.createGoal("Initial objective");
    await expect(
      hostedSession.updateGoal({ objective: "Refined objective", status: "blocked" }),
    ).resolves.toEqual({ objective: "Refined objective", status: "blocked" });
    await expect(
      hostedSession.updateGoal({ objective: "Discarded objective", status: "complete" }),
    ).rejects.toThrow("cannot be updated while completing");
    await expect(hostedSession.snapshot()).resolves.toMatchObject({
      goal: { objective: "Refined objective", status: "blocked" },
    });
    await expect(hostedSession.updateGoal({ status: "complete" })).resolves.toBeNull();
    await expect(hostedSession.snapshot()).resolves.toMatchObject({ goal: null });
    await host.shutdown();
  });

  it("blocks active goals when a turn is interrupted", async () => {
    const host = createHost(new MemorySessionStore());
    const hostedSession = await host.createSession(localCreateInput);
    hostedSession.runtime.agent.spec.model.stream = () => ({
      async *[Symbol.asyncIterator]() {},
      async result() {
        return fauxAssistantMessage("", { stopReason: "aborted" });
      },
    });

    await expect(hostedSession.startGoal("Finish safely")).resolves.toMatchObject({
      turn: { status: "aborted" },
    });
    await expect(hostedSession.snapshot()).resolves.toMatchObject({
      goal: { objective: "Finish safely", status: "blocked" },
    });
    await host.shutdown();
  });

  it("normalizes recovered running operations to cancelled", async () => {
    const store = new MemorySessionStore();
    const snapshot = createStoredSnapshot({
      sessionId: "running-operation",
      timeline: [
        {
          type: "operation",
          id: "operation-1",
          operation: {
            kind: "manual-compaction",
            status: "running",
            startedAt: 1,
          },
        },
      ],
    });
    await store.commitSessionSnapshot(snapshot);
    const host = createHost(store);

    const recovered = await host.observeSession(snapshot.sessionId);

    await expect(recovered?.snapshot()).resolves.toMatchObject({
      operations: {
        "operation-1": {
          status: "cancelled",
          finishedAt: expect.any(Number),
          reason: "session-recovered",
        },
      },
      timeline: {
        items: [expect.objectContaining({ type: "operation", operationId: "operation-1" })],
      },
    });
    await host.shutdown();
  });

  it("normalizes recovered active goals to blocked", async () => {
    const store = new MemorySessionStore();
    const snapshot = createStoredSnapshot({
      goal: { objective: "Resume deliberately", status: "active" },
    });
    await store.commitSessionSnapshot(snapshot);

    const host = createHost(store);
    const recovered = await host.observeSession(snapshot.sessionId);
    await expect(recovered?.snapshot()).resolves.toMatchObject({
      lifecycle: "idle",
      goal: { objective: "Resume deliberately", status: "blocked" },
    });
    await host.shutdown();
  });

  it("attributes main runtime usage exactly once", async () => {
    const recordUsage = vi.fn();
    const host = createHost(new MemorySessionStore(), { recordUsage });
    const hostedSession = await host.createSession(localCreateInput);
    const message = {
      ...assistantMessageWithToolCalls([], 0.25),
      stopReason: "stop",
      content: [{ type: "text", text: "measured" }],
    };
    hostedSession.runtime.agent.spec.model.stream = () => ({
      async *[Symbol.asyncIterator]() {},
      async result() {
        return message;
      },
    });

    await hostedSession.record({ text: "measure usage" });
    await hostedSession.runTurn();

    expect(recordUsage).toHaveBeenCalledOnce();
    expect(recordUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: hostedSession.sessionId,
        personaId: hostedSession.runtime.persona.id,
        agent: { type: "main" },
        cost: { total: 0.25 },
      }),
    );
  });

  it("rejects an exec when the backend resolves after interruption", async () => {
    const store = new MemorySessionStore();
    const toolBackend = createLocalToolExecutionBackend();
    let markExecStarted;
    const execStarted = new Promise((resolve) => {
      markExecStarted = resolve;
    });
    vi.spyOn(toolBackend, "runBash").mockImplementation(
      (_command, options) =>
        new Promise((resolve) => {
          markExecStarted();
          options.signal.addEventListener(
            "abort",
            () =>
              resolve({
                output: "(tau) aborted",
                stdout: "",
                stderr: "(tau) aborted",
                exitCode: 1,
                truncated: false,
              }),
            { once: true },
          );
        }),
    );
    const executionEnvironment = createTestExecutionEnvironment(
      { kind: "local", cwd: "/repo", home: "/home/user" },
      toolBackend,
    );
    const host = createHostForEnvironment(store, executionEnvironment);
    const hostedSession = await host.createSession(localCreateInput);

    try {
      const exec = hostedSession.exec({ command: "sleep forever" });
      await execStarted;

      expect(hostedSession.interruptActiveWork()).toBe(true);
      await expect(exec).rejects.toMatchObject({ name: "AbortError" });
    } finally {
      await host.shutdown();
    }
  });

  it("samples without changing or persisting session state", async () => {
    const store = new MemorySessionStore();
    const originalCommit = store.commitSessionSnapshot.bind(store);
    store.commitSessionSnapshot = vi.fn(originalCommit);
    const host = createHost(store);
    const hostedSession = await host.createSession(localCreateInput);
    const sampledMessage = {
      role: "assistant",
      api: "openai-responses",
      provider: "openai",
      model: "gpt-5.6-sol",
      stopReason: "toolUse",
      content: [fauxToolCall("lookup_ticket", { id: "123" })],
      usage: {
        input: 2,
        output: 3,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 5,
        cost: { input: 0.01, output: 0.02, cacheRead: 0, cacheWrite: 0, total: 0.03 },
      },
      timestamp: 1,
    };
    hostedSession.runtime.agent.spec.model.stream = () => ({
      async *[Symbol.asyncIterator]() {},
      async result() {
        return sampledMessage;
      },
    });
    const deltas = [];
    hostedSession.onDelta((delta) => deltas.push(delta));
    const before = await hostedSession.snapshot();
    const commitsBeforeSample = store.commitSessionSnapshot.mock.calls.length;

    await expect(
      hostedSession.sample({
        context: {
          systemPrompt: "Use tools only when needed.",
          messages: [
            {
              role: "user",
              content: [{ type: "text", text: "Look up ticket 123" }],
              timestamp: 0,
            },
          ],
          tools: [
            {
              name: "lookup_ticket",
              description: "Look up a ticket.",
              parameters: { type: "object", properties: {} },
            },
          ],
        },
        options: {},
      }),
    ).resolves.toEqual({ message: sampledMessage });

    expect(await hostedSession.snapshot()).toEqual(before);
    expect(store.commitSessionSnapshot).toHaveBeenCalledTimes(commitsBeforeSample);
    expect(await store.loadSession(hostedSession.sessionId)).toEqual(before);
    expect(deltas).toEqual([]);
    await host.shutdown();
  });

  it.each([
    ["direct session disposal", ({ hostedSession }) => hostedSession.dispose()],
    ["host shutdown", ({ host }) => host.shutdown()],
  ])("aborts and settles active samples before %s", async (_label, dispose) => {
    const store = new MemorySessionStore();
    const executionEnvironment = createTestExecutionEnvironment();
    let sampleSettled = false;
    executionEnvironment.dispose = vi.fn(async () => {
      expect(sampleSettled).toBe(true);
    });
    const host = createHostForEnvironment(store, executionEnvironment);
    const hostedSession = await host.createSession(localCreateInput);
    let markSampleStarted;
    const sampleStarted = new Promise((resolve) => {
      markSampleStarted = resolve;
    });
    hostedSession.runtime.agent.spec.model.stream = (_context, options) => ({
      async *[Symbol.asyncIterator]() {},
      async result() {
        markSampleStarted();
        await new Promise((resolve) => {
          if (options.signal.aborted) {
            resolve();
            return;
          }
          options.signal.addEventListener("abort", resolve, { once: true });
        });
        sampleSettled = true;
        return fauxAssistantMessage("sampled");
      },
    });

    const sample = hostedSession.sample({
      context: { systemPrompt: "Sample in isolation.", messages: [] },
      options: {},
    });
    const sampleResult = expect(sample).rejects.toMatchObject({ name: "AbortError" });
    await sampleStarted;

    await expect(dispose({ host, hostedSession })).resolves.toBeUndefined();
    await sampleResult;
    expect(executionEnvironment.dispose).toHaveBeenCalledTimes(1);
  });

  it("persists the same provider-failed terminal state published to observers", async () => {
    const store = new MemorySessionStore();
    const host = createHost(store);
    const hostedSession = await host.createSession(localCreateInput);
    let observedSnapshot = await hostedSession.snapshot();
    hostedSession.onDelta((delta) => {
      observedSnapshot = applySessionProtocolDelta(observedSnapshot, delta);
    });
    const providerError = `stream failed ${"x".repeat(3_000)} request-id-89abde88`;
    const streamError = new Error(providerError);
    const partial = fauxAssistantMessage("partial response");
    hostedSession.runtime.agent.spec.model.stream = () => ({
      async *[Symbol.asyncIterator]() {
        yield {
          type: "text_delta",
          contentIndex: 0,
          delta: "partial response",
          partial,
        };
        throw streamError;
      },
      async result() {
        throw streamError;
      },
    });

    await hostedSession.record({ text: "fail after streaming" });
    await expect(hostedSession.runTurn()).resolves.toEqual({
      status: "failed",
      stopReason: "error",
      errorMessage: providerError,
    });

    const persistedSnapshot = await store.loadSession(hostedSession.sessionId);
    const observedAssistant = observedSnapshot.messages.find(
      (message) => message.message.role === "assistant",
    );
    const persistedAssistant = persistedSnapshot?.messages.find(
      (message) => message.message.role === "assistant",
    );
    expect(observedSnapshot.lifecycle).toBe("idle");
    expect(persistedSnapshot?.lifecycle).toBe("idle");
    expect(observedAssistant).toMatchObject({
      state: "committed",
      modelVisible: true,
      message: {
        stopReason: "error",
        errorMessage: providerError,
        content: [{ type: "text", text: "partial response" }],
      },
    });
    expect(persistedAssistant).toEqual(observedAssistant);

    expect(persistedSnapshot?.timeline).toEqual(observedSnapshot.timeline);
    expect(
      observedSnapshot.timeline.items.some(
        (item) => item.type === "notice" && item.notice.subject.type === "message",
      ),
    ).toBe(false);

    await host.shutdown();
  });

  it("persists interrupted assistant state without duplicate timeline feedback", async () => {
    const store = new MemorySessionStore();
    const host = createHost(store);
    const hostedSession = await host.createSession(localCreateInput);
    let observedSnapshot = await hostedSession.snapshot();
    hostedSession.onDelta((delta) => {
      observedSnapshot = applySessionProtocolDelta(observedSnapshot, delta);
    });
    hostedSession.runtime.agent.spec.model.stream = (_context, options) => ({
      async *[Symbol.asyncIterator]() {
        await new Promise((resolve) =>
          options.signal.addEventListener("abort", resolve, { once: true }),
        );
      },
      async result() {
        return fauxAssistantMessage("", { stopReason: "aborted" });
      },
    });

    await hostedSession.record({ text: "wait" });
    const turn = hostedSession.runTurn();
    await vi.waitFor(() => expect(hostedSession.runtime.isTurnRunning).toBe(true));
    expect(hostedSession.interruptTurn()).toBe(true);
    await expect(turn).resolves.toEqual({ status: "aborted", stopReason: "aborted" });

    const persistedSnapshot = await store.loadSession(hostedSession.sessionId);
    expect(persistedSnapshot?.timeline).toEqual(observedSnapshot.timeline);
    expect(observedSnapshot.timeline.items.some((item) => item.type === "notice")).toBe(false);

    await host.shutdown();
  });

  it("omits custom model headers from protocol snapshots", async () => {
    const store = new MemorySessionStore();
    const persona = {
      ...personas[0],
      model: {
        ...personas[0].model,
        headers: { authorization: "Bearer secret", "x-custom": "secret" },
      },
    };
    const host = createHost(store, { persona, personas: [persona] });

    const hostedSession = await host.createSession(localCreateInput);
    const snapshot = await hostedSession.snapshot();

    expect(snapshot.bootstrap.model).toEqual(expectedModel(persona));
    expect(snapshot.bootstrap.model).not.toHaveProperty("headers");
  });

  it("projects manual compaction activity through its operation", async () => {
    const store = new MemorySessionStore();
    const host = createHost(store);
    const hostedSession = await host.createSession(localCreateInput);
    await hostedSession.snapshot();

    const deltas = [];
    const ephemeralMessages = [];
    hostedSession.onDelta((delta) => deltas.push(delta));
    hostedSession.onEphemeral((message) => ephemeralMessages.push(message));

    await hostedSession.enqueueRuntimeEvent({ type: "compaction_start", reason: "manual" });

    expect(deltas.at(-1).delta.changes).toEqual([
      {
        type: "operation.set",
        operation: expect.objectContaining({
          id: expect.stringContaining("manual-compaction"),
          kind: "manual-compaction",
          status: "running",
        }),
      },
      {
        type: "timeline.append",
        item: expect.objectContaining({
          type: "operation",
          operationId: expect.stringContaining("manual-compaction"),
        }),
      },
    ]);
    expect(ephemeralMessages).toEqual([]);
  });

  it("replaces the active epoch after successful manual compaction", async () => {
    const host = createHost(new MemorySessionStore());
    const hostedSession = await host.createSession(localCreateInput);
    const responses = [
      fauxAssistantMessage("first response"),
      fauxAssistantMessage(
        "compacted summary\n\n<preserved-user-message-ids>\n[]\n</preserved-user-message-ids>",
      ),
    ];
    hostedSession.runtime.agent.spec.model.stream = () => {
      const response = responses.shift();
      if (!response) throw new Error("unexpected model call");
      return {
        async *[Symbol.asyncIterator]() {},
        async result() {
          return response;
        },
      };
    };

    await hostedSession.record({ text: "compact me" });
    await expect(hostedSession.runTurn()).resolves.toMatchObject({ status: "completed" });
    await hostedSession.recordHistoryFailure("old epoch warning");
    const previousSnapshot = await hostedSession.snapshot();
    const deltas = [];
    hostedSession.onDelta((delta) => deltas.push(delta));

    const result = await hostedSession.compact({ mode: "summary-only" });

    expect(result.snapshot.timeline).toMatchObject({
      epoch: previousSnapshot.timeline.epoch + 1,
      sequence: 1,
      items: [expect.objectContaining({ type: "message", sequence: 1 })],
    });
    expect(result.snapshot.operations).toEqual({});
    expect(result.snapshot.tools).toEqual({});
    expect(result.snapshot.timeline.items.some((item) => item.type === "notice")).toBe(false);
    expect(result.snapshot.messages).toHaveLength(2);
    expect(deltas.at(-1)).toMatchObject({
      cause: {
        type: "compaction",
        previousEpoch: previousSnapshot.timeline.epoch,
        epoch: previousSnapshot.timeline.epoch + 1,
        kind: "manual",
        retainedMessageCount: 0,
      },
      delta: { type: "snapshot.reset" },
    });

    await host.shutdown();
  });

  it("emits runtime feedback without adding it to the timeline", async () => {
    const host = createHost(new MemorySessionStore());
    const hostedSession = await host.createSession(localCreateInput);
    const ephemeralMessages = [];
    hostedSession.onEphemeral((message) => ephemeralMessages.push(message));

    await hostedSession.enqueueRuntimeEvent({
      type: "feedback",
      tone: "default",
      title: "retrying after transient error",
      presentation: "footer",
      durationMs: 3_000,
    });

    expect(ephemeralMessages.at(-1).event).toEqual({
      type: "feedback.notice",
      tone: "default",
      title: "retrying after transient error",
      presentation: "footer",
      durationMs: 3_000,
    });
    expect((await hostedSession.snapshot()).timeline.items).not.toContainEqual(
      expect.objectContaining({ type: "notice" }),
    );
  });

  it.each([
    {
      outcome: "failed",
      failure: {
        reason: "model-subturn-limit",
        message: "stopped before producing a final response",
      },
      kind: "tau.turn.failed",
      title: "turn failed",
    },
    {
      outcome: "blocked",
      failure: {
        reason: "auto-compaction-failed",
        message: "summary unavailable",
      },
      kind: "tau.turn.blocked",
      title: "turn blocked",
    },
  ])("persists $kind at turn settlement", async ({ outcome, failure, kind, title }) => {
    const host = createHost(new MemorySessionStore());
    const hostedSession = await host.createSession(localCreateInput);
    const historyEntryId = await hostedSession.session.commitUserText("run the turn");

    await hostedSession.enqueueRuntimeEvent({
      type: "turn_finished",
      turnId: "turn-1",
      historyEntryId,
      outcome,
      failure,
    });

    const snapshot = await hostedSession.snapshot();
    expect(snapshot.timeline.items.at(-1)).toMatchObject({
      type: "notice",
      notice: {
        kind,
        version: 1,
        severity: "error",
        subject: { type: "message", id: historyEntryId },
        presentation: { title, content: [failure.message] },
        data: { reason: failure.reason },
      },
    });
    await host.shutdown();
  });

  it("keeps malformed model tool names out of feedback titles", async () => {
    const host = createHost(new MemorySessionStore());
    const hostedSession = await host.createSession(localCreateInput);
    const malformedToolName = "missing\r\ntool";
    const responses = [
      fauxAssistantMessage([fauxToolCall(malformedToolName, {}, { id: "missing-call" })], {
        stopReason: "toolUse",
      }),
      fauxAssistantMessage("continued"),
    ];
    const ephemeralMessages = [];
    hostedSession.onEphemeral((message) => ephemeralMessages.push(message));
    hostedSession.runtime.agent.spec.model.stream = () => {
      const response = responses.shift();
      return {
        async *[Symbol.asyncIterator]() {
          const toolCall = response.content.find((content) => content.type === "toolCall");
          if (toolCall) {
            yield { type: "toolcall_start", contentIndex: 0, partial: response };
            yield {
              type: "toolcall_end",
              contentIndex: 0,
              toolCall,
              partial: response,
            };
          }
        },
        async result() {
          return response;
        },
      };
    };

    await hostedSession.record({ text: "use the missing tool" });
    await expect(hostedSession.runTurn()).resolves.toEqual({
      status: "completed",
      stopReason: "stop",
    });
    expect(ephemeralMessages).toContainEqual(
      expect.objectContaining({
        event: {
          type: "timeline.item",
          epoch: 1,
          item: expect.objectContaining({
            type: "notice",
            notice: expect.objectContaining({
              kind: "tau.runtime.feedback",
              severity: "error",
              presentation: {
                title: "tool is unavailable",
                content: [`tool '${malformedToolName}' is not available for this turn`],
              },
            }),
          }),
        },
      }),
    );

    await host.shutdown();
  });

  it("keeps a skipped auto-compaction in the active epoch", async () => {
    const store = new MemorySessionStore();
    const host = createHost(store);
    const hostedSession = await host.createSession(localCreateInput);
    await hostedSession.snapshot();

    const deltas = [];
    hostedSession.onDelta((delta) => deltas.push(delta));

    await hostedSession.enqueueRuntimeEvent({ type: "compaction_start", reason: "threshold" });
    expect(deltas.at(-1).delta.changes).toEqual([
      {
        type: "operation.set",
        operation: expect.objectContaining({
          id: expect.stringContaining("auto-compaction"),
          kind: "auto-compaction",
          status: "running",
        }),
      },
      {
        type: "timeline.append",
        item: expect.objectContaining({
          type: "operation",
          operationId: expect.stringContaining("auto-compaction"),
        }),
      },
    ]);

    await hostedSession.enqueueRuntimeEvent({
      type: "compaction_end",
      reason: "threshold",
      outcome: "skipped",
    });

    const snapshot = await hostedSession.snapshot();
    expect(snapshot.timeline.epoch).toBe(1);
    expect(Object.values(snapshot.operations)).toContainEqual(
      expect.objectContaining({
        kind: "auto-compaction",
        status: "skipped",
        finishedAt: expect.any(Number),
        reason: "no-eligible-history",
      }),
    );
  });

  it("rejects rewind targets outside the active timeline before mutating history", async () => {
    const store = new MemorySessionStore();
    const historyEntries = [
      {
        id: "summary",
        message: { role: "user", content: [{ type: "text", text: "summary" }], timestamp: 1 },
      },
      {
        id: "retained-user",
        message: { role: "user", content: [{ type: "text", text: "retained" }], timestamp: 2 },
      },
    ];
    await store.commitSessionSnapshot(
      createStoredSnapshot({
        historyEntries,
        timeline: [{ type: "message", id: "timeline-summary", messageId: "summary" }],
      }),
    );
    const host = createHost(store);
    const hostedSession = await host.observeSession("stored-session");
    expect(hostedSession).toBeDefined();
    const originalHistoryIds = hostedSession.session.rawHistoryEntries.map((entry) => entry.id);

    await expect(hostedSession.rewindToHistoryEntryId("retained-user")).rejects.toThrow(
      "rewind failed",
    );
    expect(hostedSession.session.rawHistoryEntries.map((entry) => entry.id)).toEqual(
      originalHistoryIds,
    );

    await host.shutdown();
  });

  it("truncates timeline notices after the rewound message", async () => {
    const host = createHost(new MemorySessionStore());
    const hostedSession = await host.createSession(localCreateInput);
    const historyEntryId = await hostedSession.session.commitUserText("rewind me");
    await hostedSession.snapshot();

    await hostedSession.recordHistoryFailure("keep this notice");
    await hostedSession.rewindToHistoryEntryId(historyEntryId);

    const snapshot = await hostedSession.snapshot();
    expect(snapshot.timeline).toEqual({ epoch: 1, sequence: 2, items: [] });

    await hostedSession.record({ text: "after rewind" });
    const nextSnapshot = await hostedSession.snapshot();
    expect(nextSnapshot.timeline).toMatchObject({
      epoch: 1,
      sequence: 3,
      items: [expect.objectContaining({ type: "message", sequence: 3 })],
    });
  });

  it("streams assistant partials as content appends without persisting every frame", async () => {
    const store = new MemorySessionStore();
    const originalCommit = store.commitSessionSnapshot.bind(store);
    store.commitSessionSnapshot = vi.fn(originalCommit);
    const host = createHost(store);
    const hostedSession = await host.createSession(localCreateInput);
    await hostedSession.snapshot();
    Object.defineProperty(hostedSession.runtime, "isTurnRunning", {
      configurable: true,
      get: () => true,
    });

    const deltas = [];
    hostedSession.onDelta((delta) => deltas.push(delta));

    await hostedSession.enqueueRuntimeEvent({
      type: "assistant_start",
      historyEntryId: "assistant-streaming",
    });
    await hostedSession.enqueueRuntimeEvent({
      type: "assistant_partial",
      historyEntryId: "assistant-streaming",
      snapshot: assistantPartial("hello"),
    });
    await hostedSession.enqueueRuntimeEvent({
      type: "assistant_partial",
      historyEntryId: "assistant-streaming",
      snapshot: assistantPartial("hello world"),
    });
    await hostedSession.enqueueRuntimeEvent({
      type: "assistant_partial",
      historyEntryId: "assistant-streaming",
      snapshot: assistantPartial("hello world"),
    });

    expect(store.commitSessionSnapshot).toHaveBeenCalledTimes(1);
    expect(deltas.map((delta) => delta.delta.changes)).toEqual([
      expect.arrayContaining([
        expect.objectContaining({ type: "message.append" }),
        { type: "lifecycle.set", lifecycle: "running" },
      ]),
      [
        expect.objectContaining({
          type: "message.content.append",
          messageId: "assistant-streaming",
          text: "hello",
        }),
      ],
      [
        expect.objectContaining({
          type: "message.content.append",
          messageId: "assistant-streaming",
          text: " world",
        }),
      ],
    ]);
    const snapshot = await hostedSession.snapshot();
    expect(snapshot).toEqual(
      expect.objectContaining({
        revision: 4,
        messages: expect.arrayContaining([
          expect.objectContaining({
            id: "assistant-streaming",
            message: expect.objectContaining({
              content: [{ type: "text", text: "hello world" }],
            }),
          }),
        ]),
      }),
    );
    expect(store.commitSessionSnapshot).toHaveBeenCalledTimes(2);
  });

  it("serializes durable goal writes with later transient tool projections", async () => {
    const store = new MemorySessionStore();
    const host = createHost(store);
    const hostedSession = await host.createSession(localCreateInput);
    await hostedSession.snapshot();

    const persistenceReached = deferred();
    const releasePersistence = deferred();
    const commitSessionSnapshot = store.commitSessionSnapshot.bind(store);
    store.commitSessionSnapshot = vi.fn(async (snapshot, options) => {
      if (snapshot.goal?.objective === "Persist in order") {
        persistenceReached.resolve();
        await releasePersistence.promise;
      }
      await commitSessionSnapshot(snapshot, options);
    });

    const deltas = [];
    hostedSession.onDelta((delta) => deltas.push(delta));
    const goal = hostedSession.createGoal("Persist in order");
    await persistenceReached.promise;

    const toolCall = fauxToolCall("bash", { command: "pwd" }, { id: "ordered-tool" });
    const assistantStart = hostedSession.enqueueRuntimeEvent({
      type: "assistant_start",
      historyEntryId: "assistant-ordered",
    });
    const assistantPartial = hostedSession.enqueueRuntimeEvent({
      type: "assistant_partial",
      historyEntryId: "assistant-ordered",
      snapshot: {
        text: "",
        thinking: "",
        toolCalls: [toolCall],
        hasTextStarted: false,
        hasAnyThinking: false,
      },
    });

    await Promise.resolve();
    expect(deltas).toEqual([]);
    releasePersistence.resolve();
    await Promise.all([goal, assistantStart, assistantPartial]);

    expect(deltas.map((delta) => [delta.fromRevision, delta.toRevision])).toEqual([
      [1, 2],
      [2, 3],
      [3, 4],
    ]);
    await expect(hostedSession.snapshot()).resolves.toMatchObject({
      goal: { objective: "Persist in order", status: "active" },
      messages: [
        expect.anything(),
        expect.objectContaining({ id: "assistant-ordered", state: "draft" }),
      ],
      tools: {
        [toolCall.id]: expect.objectContaining({
          status: "queued",
          call: { messageId: "assistant-ordered", contentIndex: 0 },
        }),
      },
    });
    await host.shutdown();
  });

  it("reconciles tools, goals, and failure context after a runtime event sink failure", async () => {
    const store = new MemorySessionStore();
    const host = createHost(store);
    const hostedSession = await host.createSession(localCreateInput);
    await hostedSession.snapshot();

    const goalCall = fauxToolCall(
      "create_goal",
      { objective: "Finish safely" },
      { id: "failure-goal" },
    );
    const bashCall = fauxToolCall("bash", { command: "printf never" }, { id: "failure-bash" });
    const toolMessage = fauxAssistantMessage([goalCall, bashCall], {
      stopReason: "toolUse",
    });
    hostedSession.runtime.agent.spec.model.stream = () => ({
      async *[Symbol.asyncIterator]() {
        const goalPartial = { ...toolMessage, content: [goalCall] };
        yield { type: "toolcall_start", contentIndex: 0, partial: goalPartial };
        yield {
          type: "toolcall_end",
          contentIndex: 0,
          toolCall: goalCall,
          partial: goalPartial,
        };
        await vi.waitFor(() =>
          expect(hostedSession.getGoal()).toEqual({
            objective: "Finish safely",
            status: "active",
          }),
        );
        yield { type: "toolcall_start", contentIndex: 1, partial: toolMessage };
        yield {
          type: "toolcall_end",
          contentIndex: 1,
          toolCall: bashCall,
          partial: toolMessage,
        };
      },
      async result() {
        return toolMessage;
      },
    });

    const commitSessionSnapshot = store.commitSessionSnapshot.bind(store);
    let injectedFailure = false;
    store.commitSessionSnapshot = vi.fn(async (snapshot, options) => {
      if (!injectedFailure && snapshot.tools[bashCall.id]?.status === "queued") {
        injectedFailure = true;
        throw new Error("injected lifecycle failure", {
          cause: new Error("store unavailable"),
        });
      }
      await commitSessionSnapshot(snapshot, options);
    });

    const { userHistoryEntryId } = await hostedSession.record({
      text: "run both",
    });
    await expect(hostedSession.runTurn()).resolves.toEqual({
      status: "failed",
      stopReason: "error",
      errorMessage: "injected lifecycle failure: store unavailable",
    });

    const snapshot = await hostedSession.snapshot();
    expect(snapshot.goal).toEqual({
      objective: "Finish safely",
      status: "blocked",
    });
    expect(snapshot.timeline.items.at(-1)).toMatchObject({
      type: "notice",
      notice: {
        kind: "tau.turn.failed",
        subject: { type: "message", id: userHistoryEntryId },
        presentation: {
          title: "turn failed",
          content: ["injected lifecycle failure: store unavailable"],
        },
        data: { reason: "runtime-error" },
      },
    });
    expect(
      [goalCall.id, bashCall.id].every(
        (id) => snapshot.tools[id].status !== "queued" && snapshot.tools[id].status !== "running",
      ),
    ).toBe(true);
    expect(snapshot.tools[bashCall.id]).toMatchObject({
      status: "cancelled",
      error: "Turn failed before tool completion: injected lifecycle failure: store unavailable",
    });
    await host.shutdown();
  });

  it("does not restore a finalized assistant draft after persistence fails", async () => {
    const store = new MemorySessionStore();
    const host = createHost(store);
    const hostedSession = await host.createSession(localCreateInput);
    await hostedSession.snapshot();

    const finalText = "finalized before persistence failed";
    hostedSession.runtime.agent.spec.model.stream = () => ({
      async *[Symbol.asyncIterator]() {},
      async result() {
        return fauxAssistantMessage(finalText);
      },
    });
    const commitSessionSnapshot = store.commitSessionSnapshot.bind(store);
    let injectedFailure = false;
    store.commitSessionSnapshot = vi.fn(async (snapshot, options) => {
      const hasFinalMessage = snapshot.messages.some(
        (message) =>
          message.state === "committed" &&
          message.message.role === "assistant" &&
          message.message.content.some(
            (content) => content.type === "text" && content.text === finalText,
          ),
      );
      if (!injectedFailure && hasFinalMessage) {
        injectedFailure = true;
        throw new Error("assistant final persistence failed");
      }
      await commitSessionSnapshot(snapshot, options);
    });

    const { userHistoryEntryId } = await hostedSession.record({ text: "finish" });
    await expect(hostedSession.runTurn()).resolves.toEqual({
      status: "failed",
      stopReason: "error",
      errorMessage: "assistant final persistence failed",
    });

    const snapshot = await hostedSession.snapshot();
    expect(
      snapshot.messages.filter((message) => message.message.role === "assistant"),
    ).toHaveLength(1);
    expect(snapshot.timeline.items.at(-1)).toMatchObject({
      type: "notice",
      notice: {
        kind: "tau.turn.failed",
        subject: { type: "message", id: userHistoryEntryId },
        presentation: {
          title: "turn failed",
          content: ["assistant final persistence failed"],
        },
      },
    });
    await host.shutdown();
  });

  it("rolls back protocol projection state when a durable mutation fails", async () => {
    const store = new MemorySessionStore();
    const host = createHost(store);
    const hostedSession = await host.createSession(localCreateInput);
    await hostedSession.snapshot();

    const toolCall = fauxToolCall("bash", { command: "pwd" }, { id: "rollback-tool" });
    await hostedSession.enqueueRuntimeEvent({
      type: "assistant_start",
      historyEntryId: "assistant-rollback",
    });
    await hostedSession.enqueueRuntimeEvent({
      type: "assistant_partial",
      historyEntryId: "assistant-rollback",
      snapshot: {
        text: "",
        thinking: "",
        toolCalls: [toolCall],
        hasTextStarted: false,
        hasAnyThinking: false,
      },
    });

    vi.spyOn(store, "commitSessionSnapshot").mockRejectedValueOnce(new Error("store failed"));
    await expect(
      hostedSession.enqueueRuntimeEvent({
        type: "tool_run_started",
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        timestamp: 1,
      }),
    ).rejects.toThrow("store failed");

    await expect(hostedSession.snapshot()).resolves.toMatchObject({
      tools: { [toolCall.id]: expect.objectContaining({ status: "queued" }) },
    });
    await host.shutdown();
  });

  it("projects tool activity without independently persisting it", async () => {
    const store = new MemorySessionStore();
    const originalCommit = store.commitSessionSnapshot.bind(store);
    store.commitSessionSnapshot = vi.fn(originalCommit);
    const host = createHost(store);
    const hostedSession = await host.createSession(localCreateInput);
    await hostedSession.snapshot();

    const toolCall = fauxToolCall("bash", { command: "pwd" }, { id: "bash-activity" });
    await hostedSession.enqueueRuntimeEvent({
      type: "assistant_start",
      historyEntryId: "assistant-activity",
    });
    await hostedSession.enqueueRuntimeEvent({
      type: "assistant_partial",
      historyEntryId: "assistant-activity",
      snapshot: {
        text: "",
        thinking: "",
        toolCalls: [toolCall],
        hasTextStarted: false,
        hasAnyThinking: false,
      },
    });

    const deltas = [];
    hostedSession.onDelta((delta) => deltas.push(delta));
    await hostedSession.enqueueRuntimeEvent({
      type: "tool_activity",
      activity: {
        type: "bash_started",
        toolCallId: toolCall.id,
        command: "pwd",
        presentation: buildToolRunPresentation({ toolName: "bash", subject: "pwd" }),
      },
    });

    expect(store.commitSessionSnapshot).toHaveBeenCalledTimes(1);
    expect(deltas.at(-1).delta.changes).toEqual([
      expect.objectContaining({
        type: "tool.set",
        tool: expect.objectContaining({ id: toolCall.id }),
      }),
      expect.objectContaining({
        type: "facet.set",
        facet: expect.objectContaining({
          subject: { type: "tool", id: toolCall.id },
          data: { events: [expect.objectContaining({ type: "bash_started" })] },
        }),
      }),
    ]);

    await hostedSession.enqueueRuntimeEvent({
      type: "tool_run_queued",
      toolCallId: toolCall.id,
      toolName: toolCall.name,
      timestamp: 1,
    });

    expect(store.commitSessionSnapshot).toHaveBeenCalledTimes(2);
    await expect(store.loadSession(hostedSession.sessionId)).resolves.toMatchObject({
      facets: {
        [`tool-ui-${toolCall.id}`]: {
          data: { events: [expect.objectContaining({ type: "bash_started" })] },
        },
      },
    });
    await host.shutdown();
  });

  it("publishes later streamed tool calls as queued before they execute", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "tau-tool-streaming-"));
    const executionEnvironment = createTestExecutionEnvironment({
      kind: "local",
      cwd,
      home: cwd,
    });
    const host = createHostForEnvironment(new MemorySessionStore(), executionEnvironment);

    try {
      const hostedSession = await host.createSession({
        executionEnvironment: { kind: "local", cwd },
        attributes: { source: "test" },
      });
      const firstCall = fauxToolCall(
        "bash",
        { command: `node -e "setTimeout(() => process.stdout.write('first'), 100)"` },
        { id: "first-call" },
      );
      const secondCall = fauxToolCall("bash", { command: "printf second" }, { id: "second-call" });
      const toolMessage = fauxAssistantMessage(
        [{ type: "text", text: "running commands" }, firstCall, secondCall],
        { stopReason: "toolUse" },
      );
      const finalMessage = fauxAssistantMessage("done");
      const responses = [toolMessage, finalMessage];

      hostedSession.runtime.agent.spec.model.stream = () => {
        const response = responses.shift();
        return {
          async *[Symbol.asyncIterator]() {
            if (response !== toolMessage) {
              return;
            }
            const firstPartial = {
              ...toolMessage,
              content: [toolMessage.content[0], firstCall],
            };
            yield {
              type: "text_delta",
              contentIndex: 0,
              delta: "running commands",
              partial: firstPartial,
            };
            yield { type: "toolcall_start", contentIndex: 1, partial: firstPartial };
            yield {
              type: "toolcall_end",
              contentIndex: 1,
              toolCall: firstCall,
              partial: firstPartial,
            };
            yield { type: "toolcall_start", contentIndex: 2, partial: toolMessage };
            yield {
              type: "toolcall_end",
              contentIndex: 2,
              toolCall: secondCall,
              partial: toolMessage,
            };
          },
          async result() {
            return response;
          },
        };
      };

      const events = [];
      const facetVersions = [];
      let resolveFirstStarted;
      const firstStarted = new Promise((resolve) => {
        resolveFirstStarted = resolve;
      });
      let resolveSecondQueued;
      const secondQueued = new Promise((resolve) => {
        resolveSecondQueued = resolve;
      });
      hostedSession.onDelta((delta) => {
        for (const change of delta.delta.changes ?? []) {
          if (change.type !== "facet.set" || change.facet.kind !== "tau.tool-ui-events") {
            continue;
          }
          const event = change.facet.data.events.at(-1);
          events.push(event);
          facetVersions.push(change.facet.version);
          if (event.type === "bash_started" && event.toolCallId === firstCall.id) {
            resolveFirstStarted();
          } else if (event.type === "tool_call_queued" && event.toolCallId === secondCall.id) {
            resolveSecondQueued();
          }
        }
      });

      await hostedSession.record({ text: "run both" });
      const turn = hostedSession.runTurn();
      await Promise.all([firstStarted, secondQueued]);

      expect(events).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "tool_call_queued", toolCallId: firstCall.id }),
          expect.objectContaining({ type: "bash_started", toolCallId: firstCall.id }),
          expect.objectContaining({ type: "tool_call_queued", toolCallId: secondCall.id }),
        ]),
      );
      expect(events).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "bash_execution", toolCallId: firstCall.id }),
        ]),
      );
      expect(events).not.toEqual(
        expect.arrayContaining([
          expect.objectContaining({ type: "bash_started", toolCallId: secondCall.id }),
        ]),
      );
      expect(facetVersions.every((version) => version === TOOL_UI_FACET_VERSION)).toBe(true);

      await turn;
    } finally {
      await host.shutdown();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("publishes streamed tool identity before arguments complete without starting execution", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "tau-tool-arguments-"));
    const toolBackend = createLocalToolExecutionBackend();
    const writeFile = vi.spyOn(toolBackend, "writeFile");
    const executionEnvironment = createTestExecutionEnvironment(
      { kind: "local", cwd, home: cwd },
      toolBackend,
    );
    const host = createHostForEnvironment(new MemorySessionStore(), executionEnvironment);

    try {
      const hostedSession = await host.createSession({
        executionEnvironment: { kind: "local", cwd },
        attributes: { source: "test" },
      });
      const content = "streamed-content-must-not-leak";
      const path = join(cwd, "notes.txt");
      const toolCall = fauxToolCall("write", { path, content }, { id: "write-call" });
      const toolMessage = fauxAssistantMessage([toolCall], { stopReason: "toolUse" });
      const finalMessage = fauxAssistantMessage("done");
      const responses = [toolMessage, finalMessage];
      let markArgumentsStreaming;
      const argumentsStreaming = new Promise((resolve) => {
        markArgumentsStreaming = resolve;
      });
      let releaseArguments;
      const argumentsReleased = new Promise((resolve) => {
        releaseArguments = resolve;
      });

      hostedSession.runtime.agent.spec.model.stream = () => {
        const response = responses.shift();
        return {
          async *[Symbol.asyncIterator]() {
            if (response !== toolMessage) {
              return;
            }
            const partialCall = { ...toolCall, arguments: {} };
            const partial = { ...toolMessage, content: [partialCall] };
            yield { type: "toolcall_start", contentIndex: 0, partial };
            yield {
              type: "toolcall_delta",
              contentIndex: 0,
              delta: JSON.stringify({ path }),
              partial: {
                ...partial,
                content: [{ ...partialCall, arguments: { path } }],
              },
            };
            markArgumentsStreaming();
            await argumentsReleased;
            yield {
              type: "toolcall_delta",
              contentIndex: 0,
              delta: JSON.stringify({ content }),
              partial: toolMessage,
            };
            yield {
              type: "toolcall_end",
              contentIndex: 0,
              toolCall,
              partial: toolMessage,
            };
          },
          async result() {
            return response;
          },
        };
      };

      const deltas = [];
      hostedSession.onDelta((delta) => deltas.push(delta));
      await hostedSession.record({ text: "write the file" });
      const turn = hostedSession.runTurn();
      await argumentsStreaming;

      const streamingSnapshot = await hostedSession.snapshot();
      expect(streamingSnapshot.tools[toolCall.id]).toEqual({
        id: toolCall.id,
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        status: "streaming",
        origin: { messageId: expect.any(String), contentIndex: 0 },
        facetIds: [`tool-ui-${toolCall.id}`],
      });
      expect(streamingSnapshot.facets[`tool-ui-${toolCall.id}`].data.events).toEqual([
        expect.objectContaining({ type: "tool_call_streaming", toolCallId: toolCall.id }),
      ]);
      expect(
        streamingSnapshot.messages
          .find((message) => message.state === "draft")
          ?.message.content.some((item) => item.type === "toolCall"),
      ).toBe(false);
      expect(writeFile).not.toHaveBeenCalled();
      expect(JSON.stringify(deltas)).not.toContain(content);

      releaseArguments();
      await turn;

      const finalSnapshot = await hostedSession.snapshot();
      expect(finalSnapshot.tools[toolCall.id]).toEqual(
        expect.objectContaining({
          status: "succeeded",
          call: { contentIndex: 0, messageId: expect.any(String) },
        }),
      );
      expect(writeFile).toHaveBeenCalledOnce();
    } finally {
      await host.shutdown();
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  it("replaces a tool-only draft when later text changes the content shape", async () => {
    const host = createHost(new MemorySessionStore());
    const hostedSession = await host.createSession(localCreateInput);
    await hostedSession.snapshot();
    const deltas = [];
    hostedSession.onDelta((delta) => deltas.push(delta));
    const toolCall = {
      type: "toolCall",
      id: "tool-before-text",
      name: "bash",
      arguments: { command: "pwd" },
    };

    await hostedSession.enqueueRuntimeEvent({
      type: "assistant_start",
      historyEntryId: "assistant-tool-before-text",
    });
    await hostedSession.enqueueRuntimeEvent({
      type: "assistant_partial",
      historyEntryId: "assistant-tool-before-text",
      snapshot: {
        ...assistantPartial(""),
        toolCalls: [toolCall],
      },
    });
    await hostedSession.enqueueRuntimeEvent({
      type: "assistant_partial",
      historyEntryId: "assistant-tool-before-text",
      snapshot: {
        ...assistantPartial("after"),
        toolCalls: [toolCall],
      },
    });

    expect(deltas.at(-1).delta.changes).toEqual([
      expect.objectContaining({
        type: "message.replace",
        message: expect.objectContaining({
          message: expect.objectContaining({
            content: [{ type: "text", text: "after" }, toolCall],
          }),
        }),
      }),
      expect.objectContaining({
        type: "tool.set",
        tool: expect.objectContaining({
          call: { messageId: "assistant-tool-before-text", contentIndex: 1 },
        }),
      }),
    ]);
  });

  it("does not persist unchanged live snapshots during refreshes", async () => {
    const store = new MemorySessionStore();
    const originalCommit = store.commitSessionSnapshot.bind(store);
    store.commitSessionSnapshot = vi.fn(originalCommit);
    const host = createHost(store);
    const hostedSession = await host.createSession(localCreateInput);
    await hostedSession.session.commitUserText("hello");

    await expect(hostedSession.snapshot()).resolves.toEqual(
      expect.objectContaining({ revision: 1 }),
    );
    await expect(hostedSession.snapshot()).resolves.toEqual(
      expect.objectContaining({ revision: 1 }),
    );
    await expect(host.observeSession(hostedSession.session.sessionId)).resolves.toBe(hostedSession);
    await expect(host.listSessions()).resolves.toEqual([
      { sessionId: hostedSession.session.sessionId, lifecycle: "idle" },
    ]);
    expect(store.commitSessionSnapshot).toHaveBeenCalledTimes(1);

    await hostedSession.session.commitUserText("next");
    await expect(hostedSession.snapshot()).resolves.toEqual(
      expect.objectContaining({ revision: 2 }),
    );
    expect(store.commitSessionSnapshot).toHaveBeenCalledTimes(2);
  });

  it("observes live sessions without refreshing every live snapshot first", async () => {
    const store = new MemorySessionStore();
    const originalCommit = store.commitSessionSnapshot.bind(store);
    store.commitSessionSnapshot = vi.fn(originalCommit);
    const host = createHost(store);
    const hostedSession = await host.createSession(localCreateInput);
    await hostedSession.session.commitUserText("hello");

    await expect(host.observeSession(hostedSession.session.sessionId)).resolves.toBe(hostedSession);

    expect(store.commitSessionSnapshot).toHaveBeenCalledTimes(1);
  });

  it("does not let delta listener failures fail hosted runtime events", async () => {
    const store = new MemorySessionStore();
    const host = createHost(store);
    const hostedSession = await host.createSession(localCreateInput);
    await hostedSession.snapshot();

    const deltas = [];
    hostedSession.onDelta(() => {
      throw new Error("listener failed");
    });
    hostedSession.onDelta((delta) => deltas.push(delta));

    await expect(
      hostedSession.enqueueRuntimeEvent({
        type: "assistant_start",
        historyEntryId: "assistant-listener-safe",
      }),
    ).resolves.toBeUndefined();
    expect(deltas).toHaveLength(1);
  });

  it("projects each steering outcome before a later steering continuation", async () => {
    const host = createHost(new MemorySessionStore());

    try {
      const hostedSession = await host.createSession(localCreateInput);
      await hostedSession.snapshot();

      const createGate = () => {
        let resolve;
        const promise = new Promise((settle) => {
          resolve = settle;
        });
        return { promise, resolve };
      };
      const modelGates = [createGate(), createGate(), createGate()];
      const modelStarts = [createGate(), createGate(), createGate()];
      let modelCall = 0;
      hostedSession.runtime.agent.spec.model.stream = () => {
        const index = modelCall++;
        const response = fauxAssistantMessage(`response ${index + 1}`);
        return {
          async *[Symbol.asyncIterator]() {
            modelStarts[index].resolve();
            await modelGates[index].promise;
            yield* [];
          },
          async result() {
            return response;
          },
        };
      };

      await hostedSession.record({ text: "original" });
      const turn = hostedSession.runTurn();
      await modelStarts[0].promise;

      const firstSteering = hostedSession.steer("first steer");
      modelGates[0].resolve();
      await firstSteering.applied;
      await modelStarts[1].promise;

      const secondSteering = hostedSession.steer("second steer");
      modelGates[1].resolve();
      const [firstResult, secondApplied] = await Promise.all([
        firstSteering.result,
        secondSteering.applied,
      ]);
      await modelStarts[2].promise;

      modelGates[2].resolve();
      const [secondResult] = await Promise.all([secondSteering.result, turn]);
      const snapshot = await hostedSession.snapshot();

      expect(firstResult.turn).toEqual({ status: "completed", stopReason: "stop" });
      expect(secondResult.turn).toEqual({ status: "completed", stopReason: "stop" });
      expect(secondApplied).toEqual({ userHistoryEntryId: secondResult.userHistoryEntryId });
      expect(
        snapshot.timeline.items.some(
          (item) => item.type === "notice" && item.notice.kind.startsWith("tau.turn."),
        ),
      ).toBe(false);
      expect(modelCall).toBe(3);
    } finally {
      await host.shutdown();
    }
  });

  it("preserves steering receipts submitted during earlier steering persistence", async () => {
    const store = new MemorySessionStore();
    const host = createHost(store);

    try {
      const hostedSession = await host.createSession(localCreateInput);
      await hostedSession.snapshot();
      const persistenceReached = deferred();
      const releasePersistence = deferred();
      const commitSessionSnapshot = store.commitSessionSnapshot.bind(store);
      let paused = false;
      store.commitSessionSnapshot = vi.fn(async (snapshot, options) => {
        if (!paused && snapshotUserMessageCount(snapshot) === 2) {
          paused = true;
          persistenceReached.resolve();
          await releasePersistence.promise;
        }
        await commitSessionSnapshot(snapshot, options);
      });
      const modelGates = [deferred(), deferred(), deferred()];
      const modelStarts = [deferred(), deferred(), deferred()];
      let modelCall = 0;
      hostedSession.runtime.agent.spec.model.stream = () => {
        const index = modelCall++;
        const response = fauxAssistantMessage(`response ${index + 1}`);
        return {
          async *[Symbol.asyncIterator]() {
            modelStarts[index].resolve();
            await modelGates[index].promise;
            yield* [];
          },
          async result() {
            return response;
          },
        };
      };

      await hostedSession.record({ text: "original" });
      const turn = hostedSession.runTurn();
      await modelStarts[0].promise;
      const firstSteering = hostedSession.steer("first steer");
      modelGates[0].resolve();
      await persistenceReached.promise;

      const secondSteering = hostedSession.steer("second steer");
      releasePersistence.resolve();
      const firstApplied = await firstSteering.applied;
      await modelStarts[1].promise;
      modelGates[1].resolve();
      const secondApplied = await secondSteering.applied;
      await modelStarts[2].promise;
      modelGates[2].resolve();

      const [firstResult, secondResult] = await Promise.all([
        firstSteering.result,
        secondSteering.result,
        turn,
      ]);
      const snapshot = await hostedSession.snapshot();
      expect(snapshot.turns[firstApplied.userHistoryEntryId]).toEqual({
        userHistoryEntryId: firstApplied.userHistoryEntryId,
        state: "settled",
        outcome: firstResult.turn,
      });
      expect(snapshot.turns[secondApplied.userHistoryEntryId]).toEqual({
        userHistoryEntryId: secondApplied.userHistoryEntryId,
        state: "settled",
        outcome: secondResult.turn,
      });
    } finally {
      await host.shutdown();
    }
  });

  it("serializes overlapping snapshots from the same live local session", async () => {
    const store = new MemorySessionStore();
    const host = createHost(store);
    const hostedSession = await host.createSession(localCreateInput);

    await hostedSession.session.commitUserText("hello");

    await expect(
      Promise.all([hostedSession.snapshot(), hostedSession.snapshot(), hostedSession.snapshot()]),
    ).resolves.toEqual([
      expect.objectContaining({ revision: 1 }),
      expect.objectContaining({ revision: 1 }),
      expect.objectContaining({ revision: 1 }),
    ]);

    await expect(store.loadSession(hostedSession.session.sessionId)).resolves.toEqual(
      expect.objectContaining({ revision: 1 }),
    );
  });

  it("orders newer streamed state after an in-flight live snapshot write", async () => {
    const store = new BlockingCommitStore();
    const host = createHost(store);
    const hostedSession = await host.createSession(localCreateInput);
    await hostedSession.snapshot();
    Object.defineProperty(hostedSession.runtime, "isTurnRunning", {
      configurable: true,
      get: () => true,
    });

    const deltas = [];
    hostedSession.onDelta((delta) => deltas.push(delta));

    await hostedSession.enqueueRuntimeEvent({
      type: "assistant_start",
      historyEntryId: "assistant-live-race",
    });
    await hostedSession.enqueueRuntimeEvent({
      type: "assistant_partial",
      historyEntryId: "assistant-live-race",
      snapshot: assistantPartial("hello"),
    });

    const gate = store.blockNextCommit();
    const liveSnapshotPromise = hostedSession.snapshot();
    await gate.started;

    const laterPartial = hostedSession.enqueueRuntimeEvent({
      type: "assistant_partial",
      historyEntryId: "assistant-live-race",
      snapshot: assistantPartial("hello world"),
    });

    await Promise.resolve();
    expect(deltas).toHaveLength(2);
    gate.release();

    await expect(liveSnapshotPromise).resolves.toEqual(
      expect.objectContaining({
        revision: 3,
        messages: expect.arrayContaining([
          expect.objectContaining({
            id: "assistant-live-race",
            message: expect.objectContaining({
              content: [{ type: "text", text: "hello" }],
            }),
          }),
        ]),
      }),
    );
    await laterPartial;

    await hostedSession.enqueueRuntimeEvent({
      type: "assistant_partial",
      historyEntryId: "assistant-live-race",
      snapshot: assistantPartial("hello world!"),
    });

    expect(deltas.map((delta) => [delta.fromRevision, delta.toRevision])).toEqual([
      [1, 2],
      [2, 3],
      [3, 4],
      [4, 5],
    ]);
    await expect(hostedSession.snapshot()).resolves.toEqual(
      expect.objectContaining({
        revision: 5,
        messages: expect.arrayContaining([
          expect.objectContaining({
            id: "assistant-live-race",
            message: expect.objectContaining({
              content: [{ type: "text", text: "hello world!" }],
            }),
          }),
        ]),
      }),
    );
  });

  it("persists subagent events without reading an unprojected parent transition", async () => {
    const store = new MemorySessionStore();
    const host = createHost(store);
    const hostedSession = await host.createSession(localCreateInput);
    await hostedSession.snapshot();

    const historyEntryId = "assistant-parent-transition";
    await hostedSession.enqueueRuntimeEvent({ type: "assistant_start", historyEntryId });
    await hostedSession.enqueueRuntimeEvent({
      type: "assistant_partial",
      historyEntryId,
      snapshot: assistantPartial("finishing"),
    });

    let running = true;
    Object.defineProperty(hostedSession.runtime, "isTurnRunning", {
      configurable: true,
      get: () => running,
    });
    const finalMessage = fauxAssistantMessage("finished");
    hostedSession.runtime.agent.addMessage(finalMessage, { historyEntryId });

    await expect(hostedSession.snapshot()).resolves.toMatchObject({
      messages: [
        expect.objectContaining({ id: "system" }),
        expect.objectContaining({ id: historyEntryId, state: "draft" }),
      ],
    });
    running = false;

    vi.spyOn(hostedSession.session, "hasSubagent").mockReturnValue(true);

    await expect(
      hostedSession.recordSubagentEvent({
        type: "subagent_spawned",
        state: {
          id: "child-1",
          name: "default",
          title: "long task",
          availability: "running",
          model: {
            provider: personas[0].model.provider,
            id: personas[0].model.id,
            reasoning: "medium",
          },
          workingDirectory: "/repo",
          createdAt: 1,
          run: {
            revision: 1,
            status: "running",
            startedAt: 1,
            interruptRequested: false,
          },
          costTotal: 0,
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            contextWindowUsageTokens: 0,
            contextWindow: 100_000,
          },
        },
      }),
    ).resolves.toBeUndefined();

    await hostedSession.enqueueRuntimeEvent({
      type: "assistant_final",
      historyEntryId,
      message: finalMessage,
      personaId: personas[0].id,
      reasoningEffort: "medium",
      revision: hostedSession.runtime.agent.snapshot().revision,
    });

    await expect(hostedSession.snapshot()).resolves.toEqual(
      expect.objectContaining({
        messages: expect.arrayContaining([
          expect.objectContaining({ id: historyEntryId, state: "committed" }),
        ]),
        agents: {
          "child-1": expect.objectContaining({
            id: "child-1",
            run: expect.objectContaining({ status: "running" }),
          }),
        },
      }),
    );
  });

  it("owns bounded typed subagent activity state per run", async () => {
    const host = createHost(new MemorySessionStore());
    const hostedSession = await host.createSession(localCreateInput);
    vi.spyOn(hostedSession.session, "hasSubagent").mockReturnValue(true);
    const state = createRunningSubagentState();

    await hostedSession.recordSubagentEvent({ type: "subagent_spawned", state });
    for (let index = 0; index < 65; index += 1) {
      await hostedSession.recordSubagentEvent({
        type: "subagent_activity",
        state,
        activity: { type: "assistant", text: `activity ${index}` },
      });
    }

    expect(hostedSession.subagentActivities()).toMatchObject({
      revision: 67,
      agents: {
        "child-1": {
          runRevision: 1,
          activities: [
            { type: "assistant", text: "activity 1" },
            ...Array.from({ length: 63 }, (_, index) => ({
              type: "assistant",
              text: `activity ${index + 2}`,
            })),
          ],
        },
      },
    });
    expect(
      Object.values((await hostedSession.snapshot()).facets).some(
        (facet) => facet.subject.type === "agent",
      ),
    ).toBe(false);

    await hostedSession.recordSubagentEvent({
      type: "subagent_run_started",
      state: {
        ...state,
        run: { ...state.run, revision: 2 },
      },
    });
    expect(hostedSession.subagentActivities().agents["child-1"]).toEqual({
      runRevision: 2,
      activities: [],
    });
  });

  it("publishes complete activity state only for changed subagents", async () => {
    const host = createHost(new MemorySessionStore());
    const hostedSession = await host.createSession(localCreateInput);
    vi.spyOn(hostedSession.session, "hasSubagent").mockReturnValue(true);
    const first = createRunningSubagentState("child-1");
    const second = createRunningSubagentState("child-2");
    await hostedSession.recordSubagentEvent({ type: "subagent_spawned", state: first });
    await hostedSession.recordSubagentEvent({ type: "subagent_spawned", state: second });
    const messages = [];
    hostedSession.onSubagentActivities((message) => messages.push(message));

    await hostedSession.recordSubagentEvent({
      type: "subagent_activity",
      state: first,
      activity: { type: "assistant", text: "first agent only" },
    });

    expect(messages).toEqual([
      {
        version: SESSION_PROTOCOL_VERSION,
        type: "session.subagentActivities",
        sessionId: hostedSession.sessionId,
        revision: 4,
        changes: [
          {
            type: "agent.set",
            agentId: "child-1",
            state: {
              runRevision: 1,
              activities: [{ type: "assistant", text: "first agent only" }],
            },
          },
        ],
      },
    ]);
    expect(hostedSession.subagentActivities().agents).toHaveProperty("child-2");
  });

  it("bounds every subagent activity field by UTF-8 content size", async () => {
    const host = createHost(new MemorySessionStore());
    const hostedSession = await host.createSession(localCreateInput);
    vi.spyOn(hostedSession.session, "hasSubagent").mockReturnValue(true);
    const state = createRunningSubagentState();
    await hostedSession.recordSubagentEvent({ type: "subagent_spawned", state });

    await hostedSession.recordSubagentEvent({
      type: "subagent_activity",
      state,
      activity: {
        type: "assistant",
        text: `${"a".repeat(SESSION_PROTOCOL_MAX_SUBAGENT_ASSISTANT_TEXT_BYTES)}middle${"z".repeat(SESSION_PROTOCOL_MAX_SUBAGENT_ASSISTANT_TEXT_BYTES)}`,
      },
    });

    const createEditActivity = (details, metadata = [], subject = "src/large.ts") => {
      const { actionByStatus, ...presentation } = buildToolRunPresentation({
        toolName: "edit",
        subject,
        details,
        detailTruncation: false,
        metadata,
      });
      return {
        type: "tool",
        toolName: "edit",
        outcome: "succeeded",
        presentation: { action: actionByStatus.succeeded, ...presentation },
      };
    };
    const malformedToolNameActivity = createEditActivity(
      Array.from({ length: 100 }, (_, index) => ({ text: `+ short line ${index}` })),
    );
    malformedToolNameActivity.toolName = "missing\r\ntool";
    await hostedSession.recordSubagentEvent({
      type: "subagent_activity",
      state,
      activity: malformedToolNameActivity,
    });
    const largeToolActivity = createEditActivity(
      Array.from({ length: 100 }, (_, index) => ({
        text: `+ long line ${index} ${"x".repeat(490)}`,
      })),
      Array.from({ length: 33 }, (_, index) => `metadata ${index} ${"m".repeat(490)}`),
      Array.from({ length: 8 }, () => "s".repeat(512)).join("\n"),
    );
    largeToolActivity.toolName = `${"n".repeat(512)}middle${"z".repeat(512)}`;
    largeToolActivity.presentation.action = `${"a".repeat(512)}middle${"z".repeat(512)}`;
    largeToolActivity.presentation.operation = `${"o".repeat(512)}middle${"z".repeat(512)}`;
    await expect(
      hostedSession.recordSubagentEvent({
        type: "subagent_activity",
        state,
        activity: largeToolActivity,
      }),
    ).resolves.toBeUndefined();

    const diagnostic = `tool call id: ${"x".repeat(5_000)}`;
    await expect(
      hostedSession.recordSubagentEvent({
        type: "subagent_activity",
        state,
        activity: {
          type: "notice",
          severity: "error",
          title: "😀".repeat(513),
          content: [
            diagnostic,
            ...Array.from({ length: 16 }, (_, index) => `entry ${index} ${"n".repeat(3_000)}`),
          ],
        },
      }),
    ).resolves.toBeUndefined();

    const [assistantActivity, shortToolActivity, toolActivity, noticeActivity] =
      hostedSession.subagentActivities().agents["child-1"].activities;
    expect(Buffer.byteLength(assistantActivity.text, "utf8")).toBeLessThanOrEqual(
      SESSION_PROTOCOL_MAX_SUBAGENT_ASSISTANT_TEXT_BYTES,
    );
    expect(assistantActivity.text).toMatch(/^a+…z+$/);
    expect(shortToolActivity.toolName).toBe("missing tool");
    expect(shortToolActivity.presentation.details).toHaveLength(100);
    expect(toolActivity.toolName).toMatch(/^n+…z+$/);
    expect(toolActivity.presentation.action).toMatch(/^a+…z+$/);
    expect(toolActivity.presentation.operation).toMatch(/^o+…z+$/);
    for (const text of [
      toolActivity.toolName,
      toolActivity.presentation.action,
      toolActivity.presentation.operation,
    ]) {
      expect(Buffer.byteLength(text, "utf8")).toBeLessThanOrEqual(
        SESSION_PROTOCOL_MAX_SUBAGENT_SHORT_TEXT_BYTES,
      );
    }
    expect(Buffer.byteLength(toolActivity.presentation.subject, "utf8")).toBeLessThanOrEqual(
      SESSION_PROTOCOL_MAX_SUBAGENT_TOOL_SUBJECT_BYTES,
    );
    expect(toolActivity.presentation.subject).toMatch(/^s[\s\S]*…[\s\S]*s$/);
    expect(toolActivity.presentation.details.length).toBeLessThan(100);
    expect(toolActivity.presentation.details[0].text).toContain("long line 0");
    expect(toolActivity.presentation.details.at(-1).text).toContain("long line 99");
    expect(toolActivity.presentation.details).toContainEqual(
      expect.objectContaining({ text: expect.stringMatching(/^…\d+ more lines…$/) }),
    );
    expect(
      Buffer.byteLength(
        toolActivity.presentation.details.map((detail) => detail.text).join("\n"),
        "utf8",
      ),
    ).toBeLessThanOrEqual(SESSION_PROTOCOL_MAX_SUBAGENT_TOOL_DETAILS_BYTES);
    expect(toolActivity.presentation.metadata[0]).toContain("metadata 0");
    expect(toolActivity.presentation.metadata.at(-1)).toContain("metadata 32");
    expect(toolActivity.presentation.metadata).toContainEqual(
      expect.stringMatching(/^…\d+ more entries…$/),
    );
    expect(
      Buffer.byteLength(toolActivity.presentation.metadata.join("\n"), "utf8"),
    ).toBeLessThanOrEqual(SESSION_PROTOCOL_MAX_SUBAGENT_TOOL_METADATA_BYTES);
    expect(noticeActivity).toMatchObject({
      type: "notice",
      severity: "error",
    });
    expect(noticeActivity.title.startsWith("😀")).toBe(true);
    expect(noticeActivity.title.endsWith("😀")).toBe(true);
    expect(noticeActivity.title).toContain("…");
    expect(Buffer.byteLength(noticeActivity.title, "utf8")).toBeLessThanOrEqual(
      SESSION_PROTOCOL_MAX_SUBAGENT_SHORT_TEXT_BYTES,
    );
    expect(noticeActivity.content[0]).toMatch(/^tool call id: /);
    expect(noticeActivity.content.at(-1)).toContain("entry 15");
    expect(noticeActivity.content).toContainEqual(expect.stringMatching(/^…\d+ more entries…$/));
    expect(Buffer.byteLength(noticeActivity.content.join("\n"), "utf8")).toBeLessThanOrEqual(
      SESSION_PROTOCOL_MAX_SUBAGENT_NOTICE_CONTENT_BYTES,
    );
  });

  it("does not publish subagent activity cleanup when rewind persistence fails", async () => {
    const store = new MemorySessionStore();
    const host = createHost(store);
    const hostedSession = await host.createSession(localCreateInput);
    const historyEntryId = await hostedSession.session.commitUserText("rewind me");
    await hostedSession.snapshot();

    const hasSubagent = vi.spyOn(hostedSession.session, "hasSubagent").mockReturnValue(true);
    const state = createRunningSubagentState();
    await hostedSession.recordSubagentEvent({ type: "subagent_spawned", state });
    await hostedSession.recordSubagentEvent({
      type: "subagent_activity",
      state,
      activity: { type: "assistant", text: "still visible" },
    });
    const activityState = hostedSession.subagentActivities();
    const activityMessages = [];
    hostedSession.onSubagentActivities((message) => activityMessages.push(message));
    hasSubagent.mockReturnValue(false);

    const commitSessionSnapshot = store.commitSessionSnapshot.bind(store);
    let failNextCommit = true;
    store.commitSessionSnapshot = vi.fn(async (snapshot, options) => {
      if (failNextCommit) {
        failNextCommit = false;
        throw new Error("rewind persistence failed");
      }
      await commitSessionSnapshot(snapshot, options);
    });

    await expect(hostedSession.rewindToHistoryEntryId(historyEntryId)).rejects.toThrow(
      "rewind persistence failed",
    );
    expect(hostedSession.subagentActivities()).toEqual(activityState);
    expect(activityMessages).toEqual([]);
  });

  it("does not let a reasoning write replace streamed state at the same revision", async () => {
    const store = new BlockingCommitStore();
    const host = createHost(store);
    const hostedSession = await host.createSession(localCreateInput);
    await hostedSession.snapshot();
    const revisions = [];
    hostedSession.onDelta((delta) => revisions.push([delta.fromRevision, delta.toRevision]));
    Object.defineProperty(hostedSession.runtime, "isTurnRunning", {
      configurable: true,
      get: () => true,
    });

    await hostedSession.enqueueRuntimeEvent({
      type: "assistant_start",
      historyEntryId: "assistant-reasoning-race",
    });
    await hostedSession.enqueueRuntimeEvent({
      type: "assistant_partial",
      historyEntryId: "assistant-reasoning-race",
      snapshot: assistantPartial("hello"),
    });

    const gate = store.blockNextCommit();
    const reasoningPromise = hostedSession.setReasoning("high");
    await gate.started;

    const partialPromise = hostedSession.enqueueRuntimeEvent({
      type: "assistant_partial",
      historyEntryId: "assistant-reasoning-race",
      snapshot: assistantPartial("hello world"),
    });
    gate.release();

    await expect(reasoningPromise).resolves.toEqual(
      expect.objectContaining({
        revision: 4,
        settings: expect.objectContaining({ reasoning: "high" }),
      }),
    );
    await partialPromise;
    await expect(hostedSession.snapshot()).resolves.toEqual(
      expect.objectContaining({
        revision: 5,
        settings: expect.objectContaining({ reasoning: "high" }),
        messages: expect.arrayContaining([
          expect.objectContaining({
            id: "assistant-reasoning-race",
            message: expect.objectContaining({
              content: [{ type: "text", text: "hello world" }],
            }),
          }),
        ]),
      }),
    );
    await expect(store.loadSession(hostedSession.session.sessionId)).resolves.toEqual(
      expect.objectContaining({
        revision: 5,
        settings: expect.objectContaining({ reasoning: "high" }),
        messages: expect.arrayContaining([
          expect.objectContaining({
            id: "assistant-reasoning-race",
            message: expect.objectContaining({
              content: [{ type: "text", text: "hello world" }],
            }),
          }),
        ]),
      }),
    );
    expect(revisions).toEqual([
      [1, 2],
      [2, 3],
      [3, 4],
      [4, 5],
    ]);
  });

  it("applies session.create persona and reasoning overrides before startup", async () => {
    const store = new MemorySessionStore();
    const host = createHost(store, { personas: [personas[0], personas[1]] });
    const hostedSession = await host.createSession({
      executionEnvironment: { kind: "local", cwd: "/repo" },
      attributes: { source: "test" },
      personaId: personas[1].id,
      reasoning: "high",
    });

    expect(hostedSession.runtime.persona.id).toBe(personas[1].id);
    expect(hostedSession.runtime.persona.settings.reasoning).toBe("high");
    await expect(hostedSession.snapshot()).resolves.toEqual(
      expect.objectContaining({
        settings: {
          personaId: personas[1].id,
          reasoning: "high",
        },
        bootstrap: expect.objectContaining({
          model: expectedModel(personas[1]),
        }),
      }),
    );
  });

  it("keeps explicitly recorded history isolated between sessions", async () => {
    const store = new MemorySessionStore();
    const host = createHost(store);
    const session = await host.createSession(localCreateInput);
    await session.session.commitUserText("loaded");

    expect(session.session.history).toEqual([
      expect.objectContaining({
        role: "user",
        content: [{ type: "text", text: "loaded" }],
      }),
    ]);
    expect((await host.createSession(localCreateInput)).session.history).toEqual([]);
  });

  it("switches personas using live execution environment config", async () => {
    const store = new MemorySessionStore();
    const livePersona = {
      ...personas[1],
      label: "live persona",
      systemPrompt: "live persona system prompt",
    };
    const liveModelResolver = vi.fn(resolveModel);
    const resolveRuntimeConfig = vi.fn(async () => ({
      bootstrap: { modelResolver: { resolveModel: liveModelResolver } },
      config: {},
      personas: [livePersona],
      prompts: [],
      skills: [
        {
          name: "live-skill",
          description: "live skill",
          path: "/repo/.tau/skills/live-skill",
        },
      ],
      themes: [],
      warnings: [],
    }));
    const executionEnvironment = {
      resolveRuntimeConfig,
      resolveRuntimeContext: ({ persona, discoveredSkills, includeAgentContext }) => ({
        promptBootstrap: {
          promptContext: {
            cwd: "/repo",
            home: "/home/user",
            repoRoot: "/repo",
            platform: "linux",
            includeAgentContext,
            projectContextBlock: "<project-context>live context</project-context>",
            skillsBlock: `<skills>${persona.id}:${discoveredSkills.length}</skills>`,
          },
          agentsFiles: [],
          warnings: [],
          unknownSkills: [],
        },
      }),
      getToolExecutionBackend: () => createLocalToolExecutionBackend(),
      snapshot: () => ({ kind: "local", cwd: "/repo", home: "/home/user" }),
      dispose: async () => {},
    };
    const host = createHostForEnvironment(store, executionEnvironment);
    const session = await host.createSession(localCreateInput);

    const snapshot = await session.setPersona(livePersona.id);

    expect(resolveRuntimeConfig).toHaveBeenCalledTimes(1);
    expect(session.runtime.agent.spec.model.model).toEqual(livePersona.model);
    expect(session.runtime.persona.label).toBe("live persona");
    expect(snapshot.settings.personaId).toBe(livePersona.id);
    expect(snapshot.catalog.personas).toEqual([expect.objectContaining({ label: "live persona" })]);
    expect(snapshot.catalog.skills).toEqual([
      {
        name: "live-skill",
        description: "live skill",
        path: "/repo/.tau/skills/live-skill",
      },
    ]);
    expect(snapshot.messages[0].message.content).toContain("live persona system prompt");
    expect(snapshot.messages[0].message.content).toContain(
      "<project-context>live context</project-context>",
    );
  });

  it("creates new hosted sessions from resolved per-execution bootstrap", async () => {
    const store = new MemorySessionStore();
    const resolvedPersona = {
      ...personas[0],
      id: "resolved-persona",
      label: "resolved persona",
      settings: { ...personas[0].settings, reasoning: "high" },
    };
    const host = createHost(store, {
      defaultBootstrap: false,
      resolveSessionBootstrap: async ({ executionEnvironment }) => {
        expect(executionEnvironment.snapshot()).toEqual({
          kind: "local",
          cwd: "/repo",
          home: "/home/user",
        });
        return {
          persona: resolvedPersona,
          discoveredSkills: [
            {
              name: "resolved-skill",
              description: "resolved",
              path: "/repo/.tau/skills/x",
            },
          ],
          personas: [resolvedPersona],
          prompts: [],
          modelResolver: resolveModel,
        };
      },
    });

    const session = await host.createSession(localCreateInput);
    const snapshot = await session.snapshot();

    expect(snapshot.settings).toEqual({
      personaId: "resolved-persona",
      reasoning: "high",
    });
    expect(snapshot.catalog.personas).toEqual([
      expect.objectContaining({
        id: "resolved-persona",
        label: "resolved persona",
      }),
    ]);
    expect(session.runtime.persona.id).toBe("resolved-persona");
  });

  it("reloads hosted session content from the execution environment", async () => {
    const store = new MemorySessionStore();
    const reloadedPersona = {
      ...personas[0],
      label: "reloaded persona",
    };
    const resolveRuntimeConfig = vi.fn(async () => ({
      bootstrap: { modelResolver: { resolveModel } },
      config: {},
      personas: [reloadedPersona],
      prompts: [{ id: "reload-prompt", template: "reload prompt" }],
      skills: [
        {
          name: "reload-skill",
          description: "reload skill",
          path: "/repo/skill",
        },
      ],
      themes: [
        {
          id: "reload-theme",
          tokens: {},
          sourcePath: "/repo/.tau/themes/reload-theme.json",
          scope: "project",
        },
      ],
      warnings: ["config warning"],
    }));
    const runNodeScript = vi.fn(async () => ({
      output: JSON.stringify({
        files: [
          {
            path: "/repo/.tau/prompts/reload-prompt.md",
            content: "---\nid: reload-prompt\n---\nreload prompt",
          },
        ],
      }),
      stdout: JSON.stringify({
        files: [
          {
            path: "/repo/.tau/prompts/reload-prompt.md",
            content: "---\nid: reload-prompt\n---\nreload prompt",
          },
        ],
      }),
      stderr: "",
      exitCode: 0,
      truncated: false,
    }));
    const executionEnvironment = {
      resolveRuntimeConfig,
      resolveRuntimeContext: ({ persona, discoveredSkills, includeAgentContext }) => ({
        promptBootstrap: {
          promptContext: {
            cwd: "/repo",
            home: "/home/user",
            repoRoot: "/repo",
            platform: "linux",
            includeAgentContext,
            projectContextBlock: "<project-context>reloaded</project-context>",
            skillsBlock: `<skills>${persona.id}:${discoveredSkills.length}</skills>`,
          },
          agentsFiles: ["/repo/AGENTS.md"],
          warnings: ["agents warning"],
          unknownSkills: ["missing-skill"],
        },
      }),
      getToolExecutionBackend: () => ({ runNodeScript }),
      snapshot: () => ({ kind: "local", cwd: "/repo", home: "/home/user" }),
      dispose: async () => {},
    };

    const host = createHostForEnvironment(store, executionEnvironment);
    const session = await host.createSession(localCreateInput);
    const result = await session.reload();

    expect(result.counts).toEqual({ personas: 1, prompts: 1, skills: 1 });
    expect(result.warnings).toEqual([
      "config warning",
      `unknown skill enabled by persona '${personas[0].id}': missing-skill`,
    ]);
    expect(result.snapshot.catalog.personas[0].label).toBe("reloaded persona");
    expect(result.snapshot.messages[0].message.content).toContain(
      "<project-context>reloaded</project-context>",
    );
    expect(result.snapshot.catalog.prompts).toEqual([{ id: "reload-prompt" }]);
    expect(result.snapshot.catalog.skills).toEqual([
      {
        name: "reload-skill",
        description: "reload skill",
        path: "/repo/skill",
      },
    ]);
    await expect(session.resolvePrompt("reload-prompt")).resolves.toEqual({
      promptId: "reload-prompt",
      text: "reload prompt",
    });
    expect(resolveRuntimeConfig).toHaveBeenCalledTimes(1);
  });

  it("keeps execution-environment context in hosted ephemeral system prompts", async () => {
    const store = new MemorySessionStore();
    const executionEnvironment = createTestExecutionEnvironment();
    const resolveRuntimeContext = executionEnvironment.resolveRuntimeContext;
    executionEnvironment.resolveRuntimeContext = async (options) => {
      const context = await resolveRuntimeContext(options);
      context.promptBootstrap.promptContext.projectContextBlock =
        "### Project context\n\ntarget AGENTS instructions";
      context.promptBootstrap.promptContext.skillsBlock = "### Skills\n\ntarget skill";
      return context;
    };
    const host = createHostForEnvironment(store, executionEnvironment);
    const session = await host.createSession(localCreateInput);
    const { contextId } = await session.createEphemeralContext({
      instructions: "review instructions",
      tools: ["bash"],
    });

    const hostedContext = session.ephemeralAgentSessions.get(contextId);
    const thread = await hostedContext.createThread("thread-1");
    const systemPrompt = thread.runtime.spec.systemPrompt;

    expect(systemPrompt).toContain("target AGENTS instructions");
    expect(systemPrompt).toContain("target skill");
    expect(systemPrompt).toContain("- Current working directory: `/repo`");
    expect(systemPrompt).toContain("review instructions");
  });

  it("resolves prompt bodies from the execution environment each time", async () => {
    const store = new MemorySessionStore();
    let promptText = "first body";
    const resolveRuntimeConfig = vi.fn(async () => ({
      bootstrap: { modelResolver: { resolveModel } },
      config: {},
      personas: [personas[0]],
      prompts: [],
      skills: [],
      themes: [],
      warnings: [],
    }));
    const runNodeScript = vi.fn(async () => ({
      output: JSON.stringify({
        files: [
          {
            path: "/repo/.tau/prompts/live-prompt.md",
            content: `---\nid: live-prompt\n---\n${promptText}`,
          },
        ],
      }),
      stdout: JSON.stringify({
        files: [
          {
            path: "/repo/.tau/prompts/live-prompt.md",
            content: `---\nid: live-prompt\n---\n${promptText}`,
          },
        ],
      }),
      stderr: "",
      exitCode: 0,
      truncated: false,
    }));
    const executionEnvironment = {
      resolveRuntimeConfig,
      resolveRuntimeContext: ({ persona, includeAgentContext }) => ({
        promptBootstrap: {
          promptContext: {
            cwd: "/repo",
            home: "/home/user",
            repoRoot: "/repo",
            platform: "linux",
            includeAgentContext,
            skillsBlock: `<skills>${persona.id}</skills>`,
          },
          agentsFiles: [],
          warnings: [],
          unknownSkills: [],
        },
      }),
      getToolExecutionBackend: () => ({ runNodeScript }),
      snapshot: () => ({ kind: "local", cwd: "/repo", home: "/home/user" }),
      dispose: async () => {},
    };
    const host = createHostForEnvironment(store, executionEnvironment);
    const session = await host.createSession(localCreateInput);

    await expect(session.resolvePrompt("live-prompt")).resolves.toEqual({
      promptId: "live-prompt",
      text: "first body",
    });
    promptText = "second body";
    await expect(session.resolvePrompt("live-prompt")).resolves.toEqual({
      promptId: "live-prompt",
      text: "second body",
    });
    expect(runNodeScript).toHaveBeenCalledTimes(2);
    expect(resolveRuntimeConfig).not.toHaveBeenCalled();
  });

  it("reuses the hosted path autocomplete scan for nearby queries", async () => {
    const store = new MemorySessionStore();
    const autocompleteOutput = "src/main.ts\nsrc/host/local_session_host.ts\nREADME.md\n";
    const runNodeScript = vi.fn(async () => ({
      output: autocompleteOutput,
      stdout: autocompleteOutput,
      stderr: "",
      exitCode: 0,
      truncated: false,
    }));
    const executionEnvironment = {
      resolveRuntimeConfig: async () => ({
        bootstrap: { modelResolver: { resolveModel } },
        config: {},
        personas: [personas[0]],
        prompts: [],
        skills: [],
        themes: [],
        warnings: [],
      }),
      resolveRuntimeContext: ({ persona, discoveredSkills, includeAgentContext }) => ({
        promptBootstrap: {
          promptContext: {
            cwd: "/repo",
            home: "/home/user",
            repoRoot: "/repo",
            platform: "linux",
            includeAgentContext,
            projectContextBlock: "",
            skillsBlock: `<skills>${persona.id}:${discoveredSkills.length}</skills>`,
          },
          agentsFiles: [],
          warnings: [],
          unknownSkills: [],
        },
      }),
      getToolExecutionBackend: () => ({ runNodeScript }),
      snapshot: () => ({ kind: "local", cwd: "/repo", home: "/home/user" }),
      dispose: async () => {},
    };
    const host = createHostForEnvironment(store, executionEnvironment);
    const session = await host.createSession(localCreateInput);

    await expect(session.autocompletePaths({ query: "main", limit: 10 })).resolves.toEqual({
      paths: expect.arrayContaining(["src/main.ts"]),
    });
    await expect(session.autocompletePaths({ query: "host", limit: 10 })).resolves.toEqual({
      paths: expect.arrayContaining(["src/host/local_session_host.ts"]),
    });

    expect(runNodeScript).toHaveBeenCalledTimes(1);
  });

  it("recovers idle stored sessions with their durable session and history ids", async () => {
    const store = new MemorySessionStore();
    const originalHost = createHost(store);
    const originalSession = await originalHost.createSession(localCreateInput);
    const historyEntryId = await originalSession.session.commitUserText("persisted");
    const storedSnapshot = await originalSession.snapshot();

    const recoveredHost = createHost(store);
    const recoveredSession = await recoveredHost.observeSession(storedSnapshot.sessionId);

    expect(recoveredSession).toBeDefined();
    if (!recoveredSession) {
      throw new Error("expected stored session to recover");
    }
    expect(recoveredSession.session.sessionId).toBe(storedSnapshot.sessionId);
    expect(recoveredSession.session.historyEntries).toEqual(
      historyEntriesFromSnapshot(storedSnapshot),
    );
    expect(historyEntriesFromSnapshot(storedSnapshot)[0].id).toBe(historyEntryId);
    await expect(recoveredSession.snapshot()).resolves.toEqual(storedSnapshot);
    expect(recoveredSession.runtime.promptComposition).toEqual({
      baseSystemPrompt: storedSnapshot.messages[0].message.content,
      environmentTag: storedSnapshot.bootstrap.prompt.environmentTag,
      subagentPrompts: storedSnapshot.bootstrap.prompt.subagentPrompts,
    });
  });

  it("discards and persists unrecoverable subagent presentation on every recovery", async () => {
    const store = new MemorySessionStore();
    const storedSnapshot = createStoredSnapshot({
      sessionId: "stored-subagent",
      revision: 4,
      costTotal: 0.03,
      agents: {
        "agent-1": {
          id: "agent-1",
          name: "default",
          title: "stale child",
          availability: "idle",
          model: {
            provider: personas[0].model.provider,
            id: personas[0].model.id,
            reasoning: "medium",
          },
          workingDirectory: "/repo",
          createdAt: 1,
          run: {
            revision: 1,
            status: "succeeded",
            startedAt: 1,
            finishedAt: 2,
            interruptRequested: false,
            response: "stale response",
          },
          costTotal: 0.03,
          usage: {
            input: 1,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            contextWindowUsageTokens: 2,
            contextWindow: personas[0].model.contextWindow,
          },
        },
      },
      facets: {
        "agent-facet": {
          id: "agent-facet",
          subject: { type: "agent", id: "agent-1" },
          kind: "test.agent",
          version: 1,
          data: {},
        },
        "session-facet": {
          id: "session-facet",
          subject: { type: "session" },
          kind: "test.session",
          version: 1,
          data: {},
        },
      },
    });
    await store.commitSessionSnapshot(storedSnapshot);

    const host = createHost(store);
    const recoveredSession = await host.observeSession(storedSnapshot.sessionId);
    if (!recoveredSession) throw new Error("expected stored session to recover");

    const persisted = await store.loadSession(storedSnapshot.sessionId);
    expect(persisted).toEqual({
      ...storedSnapshot,
      revision: 5,
      agentState: {
        ...storedSnapshot.agentState,
        modelContextKey: recoveredSession.runtime.snapshot().modelContextKey,
      },
      agents: {},
      facets: { "session-facet": storedSnapshot.facets["session-facet"] },
    });
    await expect(recoveredSession.snapshot()).resolves.toEqual(persisted);
    expect(recoveredSession.session.hasSubagent("agent-1")).toBe(false);
  });

  it("lists and canonicalizes unversioned sessions before recovery returns", async () => {
    const directory = mkdtempSync(join(tmpdir(), "tau-legacy-session-"));
    const storedSnapshot = createStoredSnapshot({
      sessionId: "legacy-agent-state",
      revision: 7,
      historyEntries: [
        {
          id: "legacy-user",
          message: {
            role: "user",
            content: [{ type: "text", text: "persisted request" }],
          },
        },
      ],
    });
    const {
      agentState: _agentState,
      operations: _operations,
      timeline: _timeline,
      ...legacySnapshot
    } = storedSnapshot;
    legacySnapshot.timeline = storedSnapshot.timeline.items.flatMap((item) => {
      if (item.type !== "message") return [];
      const { sequence: _sequence, createdAt: _createdAt, ...messageItem } = item;
      return [messageItem];
    });
    const path = join(
      directory,
      `${Buffer.from(storedSnapshot.sessionId, "utf8").toString("base64url")}.json`,
    );
    writeFileSync(path, JSON.stringify(legacySnapshot), "utf8");

    const store = new FileSessionStore({ directory });
    const host = createHost(store);
    try {
      await expect(host.listSessions()).resolves.toEqual([
        expect.objectContaining({ sessionId: storedSnapshot.sessionId }),
      ]);
      const recoveredSession = await host.observeSession(storedSnapshot.sessionId);
      if (!recoveredSession) throw new Error("expected stored session to recover");

      const persisted = JSON.parse(readFileSync(path, "utf8"));
      expect(persisted).toMatchObject({
        format: STORED_SESSION_DOCUMENT_FORMAT,
        version: STORED_SESSION_DOCUMENT_VERSION,
        snapshot: {
          revision: 8,
          agentState: {
            revision: storedSnapshot.revision,
            modelContextKey: recoveredSession.runtime.snapshot().modelContextKey,
          },
          messages: expect.arrayContaining([
            expect.objectContaining({ id: "legacy-user", modelVisible: true }),
          ]),
        },
      });
      expect(persisted.snapshot.agentState.modelContextKey).not.toBe(
        LEGACY_SESSION_MODEL_CONTEXT_KEY,
      );
    } finally {
      await host.shutdown();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("repairs and persists dangling tool calls when recovering a stored session", async () => {
    const store = new MemorySessionStore();
    const toolCall = fauxToolCall("bash", { command: "pwd" }, { id: "dangling-tool" });
    const finishedToolCall = fauxToolCall(
      "bash",
      { command: "printf done" },
      { id: "finished-tool" },
    );
    const storedSnapshot = createStoredSnapshot({
      sessionId: "dangling-tool-session",
      historyEntries: [
        {
          id: "user-1",
          message: {
            role: "user",
            content: [{ type: "text", text: "run pwd" }],
          },
        },
        {
          id: "assistant-1",
          message: {
            ...assistantMessageWithToolCalls([toolCall, finishedToolCall]),
            stopReason: "toolUse",
          },
        },
      ],
      agentState: { revision: 2, modelContextKey: "stored-context" },
      tools: {
        [toolCall.id]: {
          id: toolCall.id,
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          status: "running",
          call: { messageId: "assistant-1", contentIndex: 0 },
          startedAt: 1,
          facetIds: [],
        },
        [finishedToolCall.id]: {
          id: finishedToolCall.id,
          toolCallId: finishedToolCall.id,
          toolName: finishedToolCall.name,
          status: "succeeded",
          call: { messageId: "assistant-1", contentIndex: 1 },
          startedAt: 1,
          finishedAt: 2,
          facetIds: [],
        },
      },
    });
    await store.commitSessionSnapshot(storedSnapshot);

    const historyStore = new LocalHistoryStore(":memory:");
    const recoveredHost = createHost(store, {
      history: new HistoryManager(historyStore),
    });
    const recoveredSession = await recoveredHost.observeSession(storedSnapshot.sessionId);
    if (!recoveredSession) throw new Error("expected stored session to recover");
    const recoveredSnapshot = await recoveredSession.snapshot();

    expect(recoveredSnapshot.messages.map((entry) => entry.message.role)).toEqual([
      "system",
      "user",
      "assistant",
      "toolResult",
      "toolResult",
      "user",
    ]);
    expect(recoveredSnapshot.tools[toolCall.id]).toMatchObject({
      status: "cancelled",
      resultMessageId: expect.any(String),
      error: "Tool completion status is unknown after session recovery.",
    });
    expect(recoveredSnapshot.tools[finishedToolCall.id]).toMatchObject({
      status: "succeeded",
      resultMessageId: expect.any(String),
      finishedAt: 2,
    });
    expect(recoveredSnapshot.tools[finishedToolCall.id]).not.toHaveProperty("error");
    await expect(store.loadSession(storedSnapshot.sessionId)).resolves.toEqual(recoveredSnapshot);
    await expect(
      historyStore.read({ sessionId: storedSnapshot.sessionId, limit: 10 }),
    ).resolves.toMatchObject({
      entries: [
        {
          id: toolCall.id,
          type: "tool",
          name: "bash",
          arguments: { command: "pwd" },
          outcome: "cancelled",
        },
        {
          id: finishedToolCall.id,
          type: "tool",
          name: "bash",
          arguments: { command: "printf done" },
          outcome: "succeeded",
        },
      ],
    });

    const contexts = [];
    recoveredSession.runtime.agent.spec.model.stream = (context) => {
      contexts.push(context);
      return {
        async *[Symbol.asyncIterator]() {},
        async result() {
          return {
            ...assistantMessageWithToolCalls([]),
            stopReason: "stop",
            content: [{ type: "text", text: "continued safely" }],
          };
        },
      };
    };
    await recoveredSession.record({ text: "continue" });
    await expect(recoveredSession.runTurn()).resolves.toMatchObject({ status: "completed" });
    expect(contexts[0].messages.map((message) => message.role)).toEqual([
      "user",
      "assistant",
      "toolResult",
      "toolResult",
      "user",
      "user",
    ]);
    await recoveredHost.shutdown();
  });

  it("persists raw user message metadata and hidden system blocks in snapshots", async () => {
    const store = new MemorySessionStore();
    const originalHost = createHost(store);
    const originalSession = await originalHost.createSession(localCreateInput);
    const rawText = prependTauUserMetadata("<system>hidden</system>\nvisible", [
      {
        type: "compaction",
        version: 1,
        summary: "summary",
        preservedUserMessages: [],
      },
    ]);
    const historyEntryId = await originalSession.session.commitUserText(rawText, {
      historyEntryId: "history-raw",
    });

    const storedSnapshot = await originalSession.snapshot();
    const storedMessage = storedSnapshot.messages.find((entry) => entry.id === historyEntryId);
    expect(storedMessage?.message.content[0].text).toBe(rawText);

    const recoveredHost = createHost(store);
    const recoveredSession = await recoveredHost.observeSession(storedSnapshot.sessionId);
    expect(recoveredSession).toBeDefined();
    if (!recoveredSession) {
      throw new Error("expected stored session to recover");
    }
    expect(recoveredSession.session.rawHistoryEntries[0].message.content[0].text).toBe(rawText);
    await expect(recoveredSession.snapshot()).resolves.toEqual(storedSnapshot);
  });

  it("recovers stored sessions with their persisted prompt composition", async () => {
    const store = new MemorySessionStore();
    const originalHost = createHost(store);
    const originalSession = await originalHost.createSession(localCreateInput);
    await originalSession.session.commitUserText("persisted prompt");
    const storedSnapshot = await originalSession.snapshot();

    const recoveredHost = createHost(store, {
      now: Date.parse("2027-01-01T00:00:00.000Z"),
    });
    const recoveredSession = await recoveredHost.observeSession(storedSnapshot.sessionId);

    expect(recoveredSession).toBeDefined();
    if (!recoveredSession) {
      throw new Error("expected stored session to recover");
    }
    expect(recoveredSession.runtime.promptComposition).toEqual({
      baseSystemPrompt: storedSnapshot.messages[0].message.content,
      environmentTag: storedSnapshot.bootstrap.prompt.environmentTag,
      subagentPrompts: storedSnapshot.bootstrap.prompt.subagentPrompts,
    });
    expect(recoveredSession.runtime.promptComposition.baseSystemPrompt).toContain(
      "- Session started at: 2026-01-01T00:00:00.000Z",
    );
  });

  it("resolves runtime config from the execution environment when recovering", async () => {
    const store = new MemorySessionStore();
    const originalHost = createHost(store);
    const originalSession = await originalHost.createSession(localCreateInput);
    await originalSession.session.commitUserText("persisted config owner");
    const storedSnapshot = await originalSession.snapshot();
    await store.commitSessionSnapshot(storedSnapshot, {
      expectedRevision: storedSnapshot.revision,
    });
    const resolveRuntimeConfig = vi.fn(async () => ({
      bootstrap: { modelResolver: { resolveModel } },
      config: { autoCompact: { enabled: false } },
      personas: [personas[0]],
      prompts: [],
      skills: [],
      themes: [],
      warnings: [],
    }));
    const restoredEnvironment = {
      resolveRuntimeConfig,
      resolveRuntimeContext: ({ persona, includeAgentContext }) => ({
        promptBootstrap: {
          promptContext: {
            cwd: "/repo",
            home: "/home/user",
            repoRoot: "/repo",
            platform: "linux",
            includeAgentContext,
            skillsBlock: `<skills>${persona.id}</skills>`,
          },
          agentsFiles: [],
          warnings: [],
          unknownSkills: [],
        },
      }),
      getToolExecutionBackend: () => createLocalToolExecutionBackend(),
      snapshot: () => ({ kind: "local", cwd: "/repo", home: "/home/user" }),
      dispose: async () => {},
    };

    const recoveredHost = createHost(store, {
      config: { autoCompact: { enabled: true } },
      executionEnvironmentResolver: {
        resolve: async () => restoredEnvironment,
        canRestore: () => true,
        restore: async () => restoredEnvironment,
      },
      resolveSessionBootstrap: async ({ executionEnvironment }) => {
        const runtimeConfig = await executionEnvironment.resolveRuntimeConfig(
          executionEnvironment.snapshot().cwd,
        );
        return {
          persona: runtimeConfig.personas[0],
          discoveredSkills: runtimeConfig.skills,
          personas: runtimeConfig.personas,
          prompts: runtimeConfig.prompts,
          modelResolver: runtimeConfig.bootstrap.modelResolver.resolveModel,
          config: runtimeConfig.config,
        };
      },
    });
    const recoveredSession = await recoveredHost.observeSession(storedSnapshot.sessionId);

    expect(recoveredSession).toBeDefined();
    if (!recoveredSession) {
      throw new Error("expected stored session to recover");
    }
    expect(resolveRuntimeConfig).toHaveBeenCalledTimes(1);
    expect(recoveredSession.runtime.agent.spec.compactionPolicy).toMatchObject({
      enabled: false,
    });
  });

  it("restores agent revisions and usage checkpoints for first-turn auto-compaction", async () => {
    const store = new MemorySessionStore();
    const persona = {
      ...personas[0],
      model: { ...personas[0].model, contextWindow: 100 },
    };
    const config = {
      autoCompact: { enabled: true, reserveTokens: 10, keepRecentTokens: 20 },
    };
    const originalHost = createHost(store, { persona, personas: [persona], config });
    const originalSession = await originalHost.createSession(localCreateInput);
    const firstMessage = {
      ...assistantMessageWithToolCalls([]),
      api: persona.model.api,
      provider: persona.model.provider,
      model: persona.model.id,
      stopReason: "stop",
      content: [{ type: "text", text: "near the context limit" }],
      usage: {
        input: 89,
        output: 2,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 91,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
    };
    originalSession.runtime.agent.spec.model.stream = () => ({
      async *[Symbol.asyncIterator]() {},
      async result() {
        return firstMessage;
      },
    });

    await originalSession.record({ text: "first request" });
    await originalSession.runTurn();
    const storedSnapshot = await originalSession.snapshot();
    expect(storedSnapshot.agentState.revision).not.toBe(storedSnapshot.revision);
    expect(storedSnapshot.agentState.usageCheckpoint).toMatchObject({ tokens: 91 });
    await originalHost.shutdown();

    const recoveredHost = createHost(store, { persona, personas: [persona], config });
    const recoveredSession = await recoveredHost.observeSession(storedSnapshot.sessionId);
    if (!recoveredSession) throw new Error("expected stored session to recover");
    expect(recoveredSession.runtime.snapshot()).toMatchObject({
      revision: storedSnapshot.agentState.revision,
      usageCheckpoint: storedSnapshot.agentState.usageCheckpoint,
    });
    const summaryMessage = {
      ...firstMessage,
      content: [
        {
          type: "text",
          text: "summary\n\n<preserved-user-message-ids>\n[]\n</preserved-user-message-ids>",
        },
      ],
      usage: { ...firstMessage.usage, input: 1, output: 1, totalTokens: 2 },
    };
    const finalMessage = {
      ...firstMessage,
      content: [{ type: "text", text: "continued after recovery" }],
      usage: { ...firstMessage.usage, input: 1, output: 1, totalTokens: 2 },
    };
    const streams = [summaryMessage, finalMessage];
    const stream = vi.fn(() => {
      const message = streams.shift();
      return {
        async *[Symbol.asyncIterator]() {},
        async result() {
          return message;
        },
      };
    });
    recoveredSession.runtime.agent.spec.model.stream = stream;

    await recoveredSession.record({ text: "second request" });
    await expect(recoveredSession.runTurn()).resolves.toMatchObject({ status: "completed" });
    expect(stream).toHaveBeenCalledTimes(2);
    expect(
      recoveredSession.runtime.rawHistory.some((message) =>
        JSON.stringify(message).includes("summary"),
      ),
    ).toBe(true);
    await recoveredHost.shutdown();
  });

  it("rejects commits from a stale recovered session after another host commits a newer revision", async () => {
    const store = new MemorySessionStore();
    const originalHost = createHost(store);
    const originalSession = await originalHost.createSession(localCreateInput);
    await originalSession.session.commitUserText("base");
    const storedSnapshot = await originalSession.snapshot();

    const firstHost = createHost(store);
    const secondHost = createHost(store);
    const firstSession = await firstHost.observeSession(storedSnapshot.sessionId);
    const secondSession = await secondHost.observeSession(storedSnapshot.sessionId);
    if (!firstSession || !secondSession) {
      throw new Error("expected both sessions to recover");
    }

    await expect(firstSession.record({ text: "first update" })).resolves.toEqual(
      expect.objectContaining({
        snapshot: expect.objectContaining({
          revision: storedSnapshot.revision + 1,
        }),
      }),
    );
    await expect(secondSession.record({ text: "stale update" })).rejects.toThrow(
      "stored session snapshot revision conflict",
    );
    await expect(store.loadSession(storedSnapshot.sessionId)).resolves.toEqual(
      expect.objectContaining({
        revision: storedSnapshot.revision + 1,
        messages: expect.arrayContaining([
          expect.objectContaining({
            message: expect.objectContaining({
              role: "user",
              content: [{ type: "text", text: "first update" }],
            }),
          }),
        ]),
      }),
    );
  });

  it("coalesces concurrent recovery of the same stored session into one live handle", async () => {
    const store = new MemorySessionStore();
    const storedSnapshot = createStoredSnapshot({
      sessionId: "concurrent-recovery",
      revision: 3,
      historyEntries: [
        {
          id: "entry-1",
          message: {
            role: "user",
            content: [{ type: "text", text: "recover once" }],
          },
        },
      ],
    });
    await store.commitSessionSnapshot(storedSnapshot);

    let releaseRestore;
    let markRestoreStarted;
    const restoreStarted = new Promise((resolve) => {
      markRestoreStarted = resolve;
    });
    const restoreReleased = new Promise((resolve) => {
      releaseRestore = resolve;
    });
    const restore = vi.fn(async () => {
      markRestoreStarted();
      await restoreReleased;
      return createTestExecutionEnvironment();
    });

    const host = createHost(store, {
      executionEnvironmentResolver: {
        resolve: async () => createTestExecutionEnvironment(),
        canRestore: () => true,
        restore,
      },
    });

    const firstRecovery = host.observeSession(storedSnapshot.sessionId);
    await restoreStarted;
    const secondRecovery = host.observeSession(storedSnapshot.sessionId);
    releaseRestore();

    const [firstSession, secondSession] = await Promise.all([firstRecovery, secondRecovery]);

    expect(firstSession).toBeDefined();
    expect(secondSession).toBe(firstSession);
    expect(restore).toHaveBeenCalledTimes(1);
    await expect(host.observeSession(storedSnapshot.sessionId)).resolves.toBe(firstSession);
  });

  it("does not create a recovered live session after shutdown starts", async () => {
    const store = new MemorySessionStore();
    const storedSnapshot = createStoredSnapshot({
      sessionId: "shutdown-recovery",
      revision: 3,
      historyEntries: [
        {
          id: "entry-1",
          message: {
            role: "user",
            content: [{ type: "text", text: "shutdown race" }],
          },
        },
      ],
    });
    await store.commitSessionSnapshot(storedSnapshot);

    let releaseRestore;
    let markRestoreStarted;
    let restoredEnvironment;
    const restoreStarted = new Promise((resolve) => {
      markRestoreStarted = resolve;
    });
    const restoreReleased = new Promise((resolve) => {
      releaseRestore = resolve;
    });
    const restore = vi.fn(async () => {
      markRestoreStarted();
      await restoreReleased;
      restoredEnvironment = createTestExecutionEnvironment();
      restoredEnvironment.dispose = vi.fn(async () => {});
      return restoredEnvironment;
    });

    const host = createHost(store, {
      executionEnvironmentResolver: {
        resolve: async () => createTestExecutionEnvironment(),
        canRestore: () => true,
        restore,
      },
    });

    const recovery = host.observeSession(storedSnapshot.sessionId);
    await restoreStarted;
    const shutdown = host.shutdown();
    releaseRestore();

    await expect(recovery).resolves.toBeUndefined();
    await expect(shutdown).resolves.toBeUndefined();
    expect(restore).toHaveBeenCalledTimes(1);
    expect(restoredEnvironment.dispose).toHaveBeenCalledTimes(1);
    await expect(host.createSession(localCreateInput)).rejects.toThrow(
      "local session host is shut down",
    );
  });

  it("disposes a restored environment when recovered runtime initialization fails", async () => {
    const store = new MemorySessionStore();
    const storedSnapshot = createStoredSnapshot({
      sessionId: "failed-recovery",
      revision: 1,
      historyEntries: [],
    });
    await store.commitSessionSnapshot(storedSnapshot);

    const restoredEnvironment = createTestExecutionEnvironment();
    restoredEnvironment.resolveRuntimeContext = vi.fn(async () => {
      throw new Error("runtime context failed");
    });
    restoredEnvironment.dispose = vi.fn(async () => {});
    const host = createHost(store, {
      executionEnvironmentResolver: {
        resolve: async () => createTestExecutionEnvironment(),
        canRestore: () => true,
        restore: async () => restoredEnvironment,
      },
    });

    await expect(host.observeSession(storedSnapshot.sessionId)).rejects.toThrow(
      "runtime context failed",
    );
    expect(restoredEnvironment.dispose).toHaveBeenCalledTimes(1);
  });

  it("disposes a resolved create-session environment when shutdown wins the resolver race", async () => {
    const store = new MemorySessionStore();
    let releaseResolve;
    let markResolveStarted;
    const resolveStarted = new Promise((resolve) => {
      markResolveStarted = resolve;
    });
    const resolveReleased = new Promise((resolve) => {
      releaseResolve = resolve;
    });
    const resolvedEnvironment = createTestExecutionEnvironment();
    resolvedEnvironment.dispose = vi.fn(async () => {});
    const resolve = vi.fn(async () => {
      markResolveStarted();
      await resolveReleased;
      return resolvedEnvironment;
    });
    const host = createHost(store, {
      executionEnvironmentResolver: {
        resolve,
        canRestore: () => false,
        restore: async () => {
          throw new Error("restore should not be called");
        },
      },
    });

    const create = host.createSession(localCreateInput);
    await resolveStarted;
    const shutdown = host.shutdown();
    releaseResolve();

    await expect(create).rejects.toThrow("local session host is shut down");
    await expect(shutdown).resolves.toBeUndefined();
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolvedEnvironment.dispose).toHaveBeenCalledTimes(1);
  });

  it("disposes the create-session environment when bootstrap resolution fails", async () => {
    const store = new MemorySessionStore();
    const resolvedEnvironment = createTestExecutionEnvironment();
    resolvedEnvironment.dispose = vi.fn(async () => {});
    const resolve = vi.fn(async () => resolvedEnvironment);
    const host = createHost(store, {
      executionEnvironmentResolver: {
        resolve,
        canRestore: () => false,
        restore: async () => {
          throw new Error("restore should not be called");
        },
      },
      resolveSessionBootstrap: async () => {
        throw new Error("bootstrap failed");
      },
    });

    await expect(host.createSession(localCreateInput)).rejects.toThrow("bootstrap failed");
    expect(resolve).toHaveBeenCalledTimes(1);
    expect(resolvedEnvironment.dispose).toHaveBeenCalledTimes(1);
    await expect(host.listSessions()).resolves.toEqual([]);
  });

  it("settles an active turn before disposing its execution environment", async () => {
    const store = new MemorySessionStore();
    const executionEnvironment = createTestExecutionEnvironment();
    let hostedSession;
    executionEnvironment.dispose = vi.fn(async () => {
      expect(hostedSession.isTurnRunning).toBe(false);
    });
    const host = createHostForEnvironment(store, executionEnvironment);
    hostedSession = await host.createSession(localCreateInput);
    await hostedSession.record({ text: "keep running until disposal" });

    let markStreamStarted;
    const streamStarted = new Promise((resolve) => {
      markStreamStarted = resolve;
    });
    hostedSession.runtime.agent.spec.model.stream = (_context, options) => ({
      async *[Symbol.asyncIterator]() {
        markStreamStarted();
        await new Promise((resolve) => {
          options.signal.addEventListener("abort", resolve, { once: true });
        });
      },
      async result() {
        return fauxAssistantMessage("", { stopReason: "aborted" });
      },
    });

    const turn = hostedSession.runTurn();
    await streamStarted;
    const dispose = hostedSession.dispose();
    const lateRecord = hostedSession.record({ text: "do not admit during disposal" });
    await dispose;
    await expect(lateRecord).rejects.toThrow("session is shut down");
    await expect(turn).resolves.toMatchObject({ status: "aborted", stopReason: "aborted" });
    expect(
      hostedSession.session.rawHistoryEntries.some(
        (entry) =>
          entry.message.role === "user" &&
          entry.message.content.some(
            (content) => content.type === "text" && content.text === "do not admit during disposal",
          ),
      ),
    ).toBe(false);
    expect(executionEnvironment.dispose).toHaveBeenCalledTimes(1);
  });

  it("removes directly disposed live handles from host recovery bookkeeping", async () => {
    const store = new MemorySessionStore();
    const host = createHost(store);
    const session = await host.createSession(localCreateInput);
    await session.session.commitUserText("recover after direct dispose");
    const storedSnapshot = await session.snapshot();

    await session.dispose();

    const recoveredSession = await host.observeSession(storedSnapshot.sessionId);
    expect(recoveredSession).toBeDefined();
    expect(recoveredSession).not.toBe(session);
    await expect(recoveredSession.snapshot()).resolves.toEqual(storedSnapshot);
  });

  it("makes live session handles terminal after host shutdown without deleting snapshots", async () => {
    const store = new MemorySessionStore();
    const host = createHost(store);
    const session = await host.createSession(localCreateInput);
    await session.session.commitUserText("delete me");
    const sessionId = session.sessionId;
    await session.snapshot();

    await host.shutdown();

    await expect(session.snapshot()).rejects.toThrow(`session is shut down: ${sessionId}`);
    await expect(session.record({ text: "resurrect" })).rejects.toThrow(
      `session is shut down: ${sessionId}`,
    );
    await expect(store.loadSession(sessionId)).resolves.toEqual(
      expect.objectContaining({ sessionId }),
    );
  });

  it("disposes every live execution environment when shutdown snapshotting fails", async () => {
    const store = new MemorySessionStore();
    store.commitSessionSnapshot = vi.fn(async () => {
      throw new Error("commit failed");
    });
    const firstEnvironment = createTestExecutionEnvironment();
    const secondEnvironment = createTestExecutionEnvironment();
    firstEnvironment.dispose = vi.fn(async () => {});
    secondEnvironment.dispose = vi.fn(async () => {});
    const resolve = vi
      .fn()
      .mockResolvedValueOnce(firstEnvironment)
      .mockResolvedValueOnce(secondEnvironment);
    const host = createHost(store, {
      executionEnvironmentResolver: {
        resolve,
        canRestore: () => true,
        restore: async () => createTestExecutionEnvironment(),
      },
    });

    await host.createSession(localCreateInput);
    await host.createSession(localCreateInput);

    await expect(host.shutdown()).rejects.toThrow("failed to shut down local session host");
    expect(firstEnvironment.dispose).toHaveBeenCalledTimes(1);
    expect(secondEnvironment.dispose).toHaveBeenCalledTimes(1);
  });

  it("aborts a recovered running receipt after its initiating message was removed", async () => {
    const store = new MemorySessionStore();
    const host = createHost(store);
    const continuationText = prependTauUserMetadata("", [
      { type: "auto-compaction-continuation", version: 1 },
    ]);
    await store.commitSessionSnapshot(
      createStoredSnapshot({
        sessionId: "stored-running",
        revision: 4,
        lifecycle: "running",
        historyEntries: [
          {
            id: "continuation",
            message: {
              role: "user",
              content: [{ type: "text", text: continuationText }],
            },
          },
        ],
        turns: {
          "compacted-root": { userHistoryEntryId: "compacted-root", state: "running" },
        },
      }),
    );

    const recoveredSession = await host.observeSession("stored-running");

    expect(recoveredSession).toBeDefined();
    if (!recoveredSession) {
      throw new Error("expected stored session to recover");
    }
    await expect(recoveredSession.snapshot()).resolves.toEqual(
      createStoredSnapshot({
        sessionId: "stored-running",
        revision: 5,
        agentState: {
          revision: 1,
          modelContextKey: recoveredSession.runtime.snapshot().modelContextKey,
        },
        lifecycle: "idle",
        historyEntries: [
          {
            id: "continuation",
            message: {
              role: "user",
              content: [{ type: "text", text: continuationText }],
            },
          },
        ],
        turns: {
          "compacted-root": {
            userHistoryEntryId: "compacted-root",
            state: "settled",
            outcome: { status: "aborted", stopReason: "aborted" },
          },
        },
        systemPrompt: recoveredSession.runtime.promptComposition.baseSystemPrompt,
        bootstrap: {
          model: expectedModel(),
          prompt: {
            environmentTag: recoveredSession.runtime.promptComposition.environmentTag,
            subagentPrompts: recoveredSession.runtime.promptComposition.subagentPrompts,
          },
        },
      }),
    );
  });

  it("recovers stale draft assistants and streaming tool placement when history is unavailable", async () => {
    const store = new MemorySessionStore();
    const storedSnapshot = createStoredSnapshot({
      sessionId: "stored-draft",
      revision: 4,
      lifecycle: "running",
      messages: [
        {
          id: "system",
          state: "committed",
          modelVisible: true,
          message: { role: "system", content: "system prompt", timestamp: 0 },
        },
        {
          id: "assistant-draft",
          state: "draft",
          modelVisible: false,
          message: {
            role: "assistant",
            content: [{ type: "text", text: "streamed before shutdown" }],
            timestamp: 10,
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
      tools: {
        "streaming-tool": {
          id: "streaming-tool",
          toolCallId: "streaming-tool",
          toolName: "write",
          status: "streaming",
          origin: { messageId: "assistant-draft", contentIndex: 1 },
          facetIds: ["tool-ui-streaming-tool"],
        },
      },
      facets: {
        "tool-ui-streaming-tool": {
          id: "tool-ui-streaming-tool",
          subject: { type: "tool", id: "streaming-tool" },
          kind: "tau.tool-ui-events",
          version: 1,
          data: {
            events: [
              {
                type: "tool_call_streaming",
                toolCallId: "streaming-tool",
                toolName: "write",
                presentation: buildToolRunPresentation({ toolName: "write", subject: "write" }),
              },
            ],
          },
        },
      },
    });
    await store.commitSessionSnapshot(storedSnapshot);
    const host = createHost(store, {
      history: new HistoryManager(undefined, "history unavailable"),
    });

    const recoveredSession = await host.observeSession("stored-draft");

    expect(recoveredSession).toBeDefined();
    if (!recoveredSession) {
      throw new Error("expected stored session to recover");
    }
    const snapshot = await recoveredSession.snapshot();
    expect(snapshot.lifecycle).toBe("idle");
    expect(snapshot.tools).toEqual({});
    expect(snapshot.facets).toEqual({});
    expect(snapshot.timeline).toMatchObject({
      sequence: 3,
      items: [
        expect.objectContaining({ type: "message", sequence: 1 }),
        expect.objectContaining({
          type: "notice",
          id: "notice-history-unavailable",
          sequence: 3,
        }),
      ],
    });
    expect(snapshot.timeline.items.some((item) => item.type === "tool")).toBe(false);
    expect(snapshot.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "assistant-draft",
          state: "interrupted",
          modelVisible: true,
          message: expect.objectContaining({
            role: "assistant",
            content: [{ type: "text", text: "streamed before shutdown" }],
            stopReason: "aborted",
          }),
        }),
      ]),
    );
    expect(recoveredSession.session.historyEntries).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "assistant-draft",
          message: expect.objectContaining({ stopReason: "aborted" }),
        }),
      ]),
    );
    await host.shutdown();
  });

  it("lists stale running snapshots as idle stored sessions", async () => {
    const store = new MemorySessionStore();
    const host = createHost(store);
    await store.commitSessionSnapshot(
      createStoredSnapshot({
        sessionId: "stored-running",
        revision: 4,
        lifecycle: "running",
        historyEntries: [
          {
            id: "entry-1",
            message: {
              role: "user",
              content: [{ type: "text", text: "stale turn" }],
            },
          },
        ],
      }),
    );

    await expect(host.listSessions()).resolves.toEqual([
      { sessionId: "stored-running", lifecycle: "idle" },
    ]);
  });

  it("recovers compatible sessions from a different local execution environment", async () => {
    const store = new MemorySessionStore();
    const host = createHost(store);
    await store.commitSessionSnapshot(
      createStoredSnapshot({
        sessionId: "other-env",
        revision: 1,
        executionEnvironment: {
          kind: "local",
          cwd: "/other",
          home: "/home/user",
        },
        historyEntries: [],
      }),
    );

    const recoveredSession = await host.observeSession("other-env");

    expect(recoveredSession).toBeDefined();
    if (!recoveredSession) {
      throw new Error("expected stored session to recover");
    }
    await expect(recoveredSession.snapshot()).resolves.toEqual(
      expect.objectContaining({
        sessionId: "other-env",
        executionEnvironment: {
          kind: "local",
          cwd: "/other",
          home: "/home/user",
        },
      }),
    );
    await expect(host.listSessions()).resolves.toEqual([
      { sessionId: "other-env", lifecycle: "idle" },
    ]);
  });

  it("preserves model-visible messages that are hidden from the default timeline", async () => {
    const store = new MemorySessionStore();
    const host = createHost(store);
    await store.commitSessionSnapshot(
      createStoredSnapshot({
        sessionId: "hidden-message",
        historyEntries: [
          {
            id: "model-only-1",
            message: {
              role: "user",
              content: [{ type: "text", text: "model-only context" }],
            },
          },
        ],
        timeline: [],
      }),
    );

    const recoveredSession = await host.observeSession("hidden-message");

    expect(recoveredSession).toBeDefined();
    if (!recoveredSession) {
      throw new Error("expected stored session to recover");
    }
    const snapshot = await recoveredSession.snapshot();
    expect(snapshot.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "model-only-1",
          modelVisible: true,
          message: expect.objectContaining({ role: "user" }),
        }),
      ]),
    );
    expect(snapshot.timeline).toEqual({ epoch: 1, sequence: 0, items: [] });
  });

  it("recovers local sessions with their persisted execution home", async () => {
    const store = new MemorySessionStore();
    const host = createHost(store);
    await store.commitSessionSnapshot(
      createStoredSnapshot({
        sessionId: "stored-home",
        revision: 1,
        executionEnvironment: {
          kind: "local",
          cwd: "/repo",
          home: "/stored/home",
        },
        historyEntries: [],
      }),
    );

    const recoveredSession = await host.observeSession("stored-home");

    expect(recoveredSession).toBeDefined();
    if (!recoveredSession) {
      throw new Error("expected stored session to recover");
    }
    await expect(recoveredSession.snapshot()).resolves.toEqual(
      expect.objectContaining({
        sessionId: "stored-home",
        executionEnvironment: {
          kind: "local",
          cwd: "/repo",
          home: "/stored/home",
        },
      }),
    );
  });

  it("recovers session settings while resolving persona definitions from the host", async () => {
    const store = new MemorySessionStore();
    const host = createHost(store);
    const differentPersona = {
      ...personas[0],
      model: {
        ...personas[0].model,
        id: "different-model",
        name: "Different Model",
      },
      settings: { ...personas[0].settings, reasoning: "high" },
    };
    await store.commitSessionSnapshot(
      createStoredSnapshot({
        sessionId: "other-bootstrap",
        revision: 1,
        persona: differentPersona,
        historyEntries: [],
      }),
    );

    const recoveredSession = await host.observeSession("other-bootstrap");

    expect(recoveredSession).toBeDefined();
    if (!recoveredSession) {
      throw new Error("expected stored session to recover");
    }
    expect(recoveredSession.runtime.persona.model.id).toBe(personas[0].model.id);
    expect(recoveredSession.runtime.persona.settings.reasoning).toBe("high");
    await expect(recoveredSession.snapshot()).resolves.toEqual(
      expect.objectContaining({
        sessionId: "other-bootstrap",
        settings: expect.objectContaining({
          personaId: differentPersona.id,
          reasoning: "high",
        }),
        bootstrap: expect.objectContaining({
          model: expectedModel(personas[0]),
        }),
      }),
    );
  });

  it("does not list or recover stored sessions for unsupported execution environments", async () => {
    const store = new MemorySessionStore();
    const host = createHost(store);
    await store.commitSessionSnapshot(
      createStoredSnapshot({
        sessionId: "unsupported-env",
        revision: 1,
        executionEnvironment: {
          kind: "cloudflare-sandbox",
          bridgeId: "missing",
          sandboxId: "sandbox-1",
          cwd: "/repo",
          home: "/home/sandbox",
        },
        historyEntries: [],
      }),
    );

    await expect(host.observeSession("unsupported-env")).resolves.toBeUndefined();
    await expect(host.listSessions()).resolves.toEqual([]);
  });
});
