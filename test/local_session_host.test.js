import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { createLocalToolExecutionBackend, ToolCatalog } from "../dist/core/index.js";
import { resolveModel } from "../dist/core/models/catalog.js";
import { personas } from "../dist/core/personas.js";
import { prependTauUserMetadata } from "../dist/core/utils/user_metadata.js";
import { LocalSessionHost } from "../dist/host/local_session_host.js";
import { MemorySessionStore } from "../dist/store/memory_session_store.js";

const localCreateInput = {
  executionEnvironment: { kind: "local", cwd: "/repo" },
};

function createEnvironment(now = Date.parse("2026-01-01T00:00:00.000Z")) {
  return { now: () => now };
}

function createTestExecutionEnvironment(
  snapshot = { kind: "local", cwd: "/repo", home: "/home/user" },
) {
  const toolBackend = createLocalToolExecutionBackend();
  const toolRegistry = ToolCatalog.createRegistry(toolBackend);
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
      toolRegistry,
      promptBootstrap: {
        promptContext: {
          cwd,
          home: snapshot.home,
          repoRoot: snapshot.cwd,
          platform: "linux",
          nodeVersion: "v24.0.0",
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
      message: entry.message,
    })),
  ];
  return {
    sessionId: overrides.sessionId ?? "stored-session",
    revision: overrides.revision ?? 1,
    lifecycle: overrides.lifecycle ?? "idle",
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
    agents: overrides.agents ?? {},
    facets: overrides.facets ?? {},
  };
}

function historyEntriesFromSnapshot(snapshot) {
  return snapshot.messages
    .filter((entry) => entry.id !== "system" && entry.modelVisible)
    .map((entry) => ({ id: entry.id, message: entry.message }));
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

describe("LocalSessionHost", () => {
  it("creates, attaches, lists, snapshots, and shuts down local sessions", async () => {
    const store = new MemorySessionStore();
    const host = createHost(store);
    await expect(host.listSessions()).resolves.toEqual([]);
    const hostedSession = await host.createSession(localCreateInput);
    expect(hostedSession.session.sessionId).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/,
    );

    hostedSession.session.addUserText("hello");

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
    hostedSession.session.addUserText("next");
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

  it("serializes runtime event deltas so tool state revisions stay ordered", async () => {
    const store = new MemorySessionStore();
    const host = createHost(store);
    const hostedSession = await host.createSession(localCreateInput);
    await hostedSession.snapshot();
    Object.defineProperty(hostedSession.runtime, "isTurnRunning", {
      configurable: true,
      get: () => true,
    });

    const deltas = [];
    hostedSession.onDelta((delta) => deltas.push(delta));
    hostedSession.session.addMessage(
      assistantMessageWithToolCalls([
        {
          type: "toolCall",
          id: "tool-a",
          name: "bash",
          arguments: { command: "echo a" },
        },
      ]),
      { historyEntryId: "assistant-tools" },
    );

    await Promise.all([
      hostedSession.enqueueRuntimeEvent({
        type: "assistant_start",
        historyEntryId: "assistant-tools",
      }),
      hostedSession.enqueueRuntimeEvent({
        type: "assistant_final",
        historyEntryId: "assistant-tools",
        message: assistantMessageWithToolCalls([
          {
            type: "toolCall",
            id: "tool-a",
            name: "bash",
            arguments: { command: "echo a" },
          },
        ]),
      }),
      hostedSession.enqueueRuntimeEvent({
        type: "tool_ui",
        uiEvent: {
          type: "tool_call_queued",
          toolCallId: "tool-a",
          toolName: "bash",
          headerTarget: "bash",
        },
      }),
      hostedSession.enqueueRuntimeEvent({
        type: "tool_ui",
        uiEvent: {
          type: "bash_started",
          toolCallId: "tool-a",
          command: "echo a",
          headerTarget: "echo a",
        },
      }),
    ]);

    expect(deltas.map((delta) => [delta.fromRevision, delta.toRevision])).toEqual([
      [1, 2],
      [2, 3],
      [3, 4],
      [4, 5],
    ]);
    await expect(hostedSession.snapshot()).resolves.toEqual(
      expect.objectContaining({
        revision: 5,
        tools: expect.objectContaining({
          "tool-a": expect.objectContaining({ status: "running" }),
        }),
      }),
    );
  });

  it("clears running auto-compaction operations on compaction end", async () => {
    const store = new MemorySessionStore();
    const host = createHost(store);
    const hostedSession = await host.createSession(localCreateInput);
    await hostedSession.snapshot();

    const deltas = [];
    hostedSession.onDelta((delta) => deltas.push(delta));

    await hostedSession.enqueueRuntimeEvent({ type: "compaction_start", reason: "threshold" });
    expect(deltas.at(-1).delta.changes).toEqual([
      expect.objectContaining({
        type: "timeline.append",
        item: expect.objectContaining({
          type: "operation",
          operation: expect.objectContaining({
            kind: "auto-compaction",
            status: "running",
          }),
        }),
      }),
    ]);

    await hostedSession.enqueueRuntimeEvent({
      type: "compaction_end",
      reason: "threshold",
      outcome: "compacted",
      result: {
        summaryHistoryEntryId: "summary-entry",
        continuationHistoryEntryId: "continuation-entry",
        compactionMessage: "compacted summary",
        cutType: "turn-boundary",
        retainedMessageCount: 1,
      },
    });

    const reset = deltas.at(-1);
    expect(reset.delta.type).toBe("snapshot.reset");
    expect(reset.delta.snapshot.timeline).not.toContainEqual(
      expect.objectContaining({
        type: "operation",
        operation: expect.objectContaining({
          kind: "auto-compaction",
          status: "running",
        }),
      }),
    );
  });

  it("preserves timeline notices when rewinding history", async () => {
    const host = createHost(new MemorySessionStore());
    const hostedSession = await host.createSession(localCreateInput);
    const historyEntryId = hostedSession.session.addUserText("rewind me");
    await hostedSession.snapshot();

    await hostedSession.enqueueRuntimeEvent({
      type: "notice",
      severity: "warn",
      text: "keep this notice",
    });
    await hostedSession.rewindToHistoryEntryId(historyEntryId);

    const snapshot = await hostedSession.snapshot();
    expect(snapshot.timeline).toContainEqual(
      expect.objectContaining({
        type: "notice",
        notice: expect.objectContaining({ text: "keep this notice" }),
      }),
    );
  });

  it("accounts for queued subagent progress without restoring a removed projection", async () => {
    const host = createHost(new MemorySessionStore());
    const hostedSession = await host.createSession(localCreateInput);
    hostedSession.session.addUserText("old request", { historyEntryId: "old-user" });
    await hostedSession.snapshot();

    const usage = {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      contextWindowUsageTokens: 0,
      contextWindow: 1000,
    };
    await hostedSession.enqueueRuntimeEvent({
      type: "subagent_ui",
      originHistoryEntryId: "old-user",
      event: {
        type: "subagent_spawned",
        state: {
          id: "agent-1",
          name: "default",
          title: "research",
          status: "running",
          costTotal: 0,
          turns: 0,
          toolCalls: 0,
          usage,
          startedAt: 1,
          abortRequested: false,
        },
      },
    });

    hostedSession.session.restoreState({
      sessionId: hostedSession.session.sessionId,
      historyEntries: [
        {
          id: "compaction-summary",
          message: {
            role: "user",
            content: [{ type: "text", text: "compacted summary" }],
            timestamp: 2,
          },
        },
      ],
    });
    await hostedSession.enqueueRuntimeEvent({
      type: "subagent_ui",
      originHistoryEntryId: "old-user",
      event: {
        type: "subagent_progress",
        id: "agent-1",
        text: "late progress",
        costTotal: 0.5,
        turns: 1,
        toolCalls: 0,
        usage,
      },
    });
    await hostedSession.enqueueRuntimeEvent({
      type: "compaction_end",
      reason: "threshold",
      outcome: "compacted",
      result: {
        summaryHistoryEntryId: "compaction-summary",
        continuationHistoryEntryId: "compaction-continuation",
        compactionMessage: "compacted summary",
        cutType: "turn-boundary",
        retainedMessageCount: 1,
      },
    });

    await expect(hostedSession.snapshot()).resolves.toEqual(
      expect.objectContaining({ costTotal: 0.5, agents: {} }),
    );
  });

  it("preserves cumulative session cost when compaction replaces message history", async () => {
    const store = new MemorySessionStore();
    const host = createHost(store);
    const hostedSession = await host.createSession(localCreateInput);
    await hostedSession.snapshot();

    const message = assistantMessageWithToolCalls([], 0.42);
    hostedSession.session.addMessage(message, { historyEntryId: "assistant-before-compaction" });
    await hostedSession.enqueueRuntimeEvent({
      type: "assistant_final",
      historyEntryId: "assistant-before-compaction",
      message,
    });

    hostedSession.session.restoreState({
      sessionId: hostedSession.session.sessionId,
      historyEntries: [
        {
          id: "compaction-summary",
          message: {
            role: "user",
            content: [{ type: "text", text: "compacted summary" }],
            timestamp: 2,
          },
        },
      ],
    });
    await hostedSession.enqueueRuntimeEvent({
      type: "compaction_end",
      reason: "threshold",
      outcome: "compacted",
      result: {
        summaryHistoryEntryId: "compaction-summary",
        continuationHistoryEntryId: "compaction-continuation",
        compactionMessage: "compacted summary",
        cutType: "turn-boundary",
        retainedMessageCount: 1,
      },
    });

    await expect(hostedSession.snapshot()).resolves.toEqual(
      expect.objectContaining({ costTotal: 0.42 }),
    );
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

  it("publishes streamed tool calls before the assistant message is final", async () => {
    const host = createHost(new MemorySessionStore());
    const hostedSession = await host.createSession(localCreateInput);
    await hostedSession.snapshot();
    const deltas = [];
    hostedSession.onDelta((delta) => deltas.push(delta));
    const toolCall = {
      type: "toolCall",
      id: "streamed-tool-call",
      name: "bash",
      arguments: { command: "pwd" },
    };

    await hostedSession.enqueueRuntimeEvent({
      type: "assistant_start",
      historyEntryId: "assistant-streaming-tool",
    });
    await hostedSession.enqueueRuntimeEvent({
      type: "assistant_partial",
      historyEntryId: "assistant-streaming-tool",
      snapshot: assistantPartial("running a command"),
    });
    await hostedSession.enqueueRuntimeEvent({
      type: "assistant_partial",
      historyEntryId: "assistant-streaming-tool",
      snapshot: {
        ...assistantPartial("running a command"),
        toolCalls: [toolCall],
      },
    });
    expect(deltas.at(-1).delta.changes).toEqual([
      expect.objectContaining({
        type: "message.replace",
        message: expect.objectContaining({
          message: expect.objectContaining({
            content: [{ type: "text", text: "running a command" }, toolCall],
          }),
        }),
      }),
      expect.objectContaining({
        type: "tool.set",
        tool: expect.objectContaining({
          call: { messageId: "assistant-streaming-tool", contentIndex: 1 },
        }),
      }),
    ]);

    const finalMessage = assistantMessageWithToolCalls([toolCall]);
    hostedSession.session.addMessage(finalMessage, {
      historyEntryId: "assistant-streaming-tool",
    });
    await hostedSession.enqueueRuntimeEvent({
      type: "assistant_final",
      historyEntryId: "assistant-streaming-tool",
      message: finalMessage,
    });
    await hostedSession.enqueueRuntimeEvent({
      type: "tool_ui",
      uiEvent: {
        type: "tool_call_queued",
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        headerTarget: toolCall.name,
      },
    });

    const snapshot = await hostedSession.snapshot();
    expect(snapshot.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          id: "assistant-streaming-tool",
          state: "committed",
          message: expect.objectContaining({
            content: [toolCall],
          }),
        }),
      ]),
    );
    expect(snapshot.tools[toolCall.id]).toEqual(
      expect.objectContaining({
        toolCallId: toolCall.id,
        toolName: toolCall.name,
        status: "queued",
        facetIds: [`tool-ui-${toolCall.id}`],
      }),
    );

    await hostedSession.enqueueRuntimeEvent({
      type: "assistant_final",
      historyEntryId: "assistant-streaming-tool",
      message: assistantMessageWithToolCalls([
        toolCall,
        { type: "text", text: "running a command" },
      ]),
    });

    const finalSnapshot = await hostedSession.snapshot();
    expect(finalSnapshot.tools[toolCall.id].call).toEqual({
      messageId: "assistant-streaming-tool",
      contentIndex: 0,
    });
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

      hostedSession.runtime.session.engine.modelRuntime.streamModel = () => {
        const response = responses.shift();
        return {
          async *[Symbol.asyncIterator]() {
            if (response !== toolMessage) {
              return;
            }
            yield { type: "text_delta", contentIndex: 0, delta: "running commands" };
            yield { type: "toolcall_start", contentIndex: 1 };
            yield { type: "toolcall_end", contentIndex: 1, toolCall: firstCall };
            yield { type: "toolcall_start", contentIndex: 2 };
            yield { type: "toolcall_end", contentIndex: 2, toolCall: secondCall };
          },
          async result() {
            return response;
          },
        };
      };

      const events = [];
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

      await turn;
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

  it("records recovered tool results without model-visible tool result messages", async () => {
    const host = createHost(new MemorySessionStore());
    const hostedSession = await host.createSession(localCreateInput);
    await hostedSession.snapshot();
    const toolCall = {
      type: "toolCall",
      id: "recovered-tool-call",
      name: "bash",
      arguments: { command: "pwd" },
    };
    const recoveryMessage = {
      role: "user",
      content: [{ type: "text", text: "<system>tool recovery</system>\n" }],
      timestamp: 3,
    };

    await hostedSession.enqueueRuntimeEvent({
      type: "assistant_start",
      historyEntryId: "assistant-recovery-error",
    });
    await hostedSession.enqueueRuntimeEvent({
      type: "assistant_partial",
      historyEntryId: "assistant-recovery-error",
      snapshot: {
        ...assistantPartial(""),
        toolCalls: [toolCall],
      },
    });
    const errorMessage = {
      ...assistantMessageWithToolCalls([toolCall]),
      stopReason: "error",
      errorMessage: "network error",
    };
    hostedSession.session.addMessage(errorMessage, {
      historyEntryId: "assistant-recovery-error",
    });
    await hostedSession.enqueueRuntimeEvent({
      type: "assistant_final",
      historyEntryId: "assistant-recovery-error",
      message: errorMessage,
    });
    hostedSession.session.addMessage(recoveryMessage, {
      historyEntryId: "tool-recovery-message",
    });
    await hostedSession.enqueueRuntimeEvent({
      type: "tool_recovery",
      historyEntryId: "tool-recovery-message",
      message: recoveryMessage,
      toolResults: [
        {
          role: "toolResult",
          toolCallId: toolCall.id,
          toolName: toolCall.name,
          content: [{ type: "text", text: "done" }],
          isError: false,
          timestamp: 2,
        },
      ],
    });

    const snapshot = await hostedSession.snapshot();
    expect(snapshot.messages).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: "tool-recovery-message", message: recoveryMessage }),
      ]),
    );
    expect(snapshot.messages.some((message) => message.message.role === "toolResult")).toBe(false);
    expect(snapshot.timeline.some((item) => item.messageId === "tool-recovery-message")).toBe(
      false,
    );
    expect(snapshot.tools[toolCall.id]).toEqual(expect.objectContaining({ status: "succeeded" }));
    expect(snapshot.tools[toolCall.id]).not.toHaveProperty("resultMessageId");
  });

  it("does not persist unchanged live snapshots during refreshes", async () => {
    const store = new MemorySessionStore();
    const originalCommit = store.commitSessionSnapshot.bind(store);
    store.commitSessionSnapshot = vi.fn(originalCommit);
    const host = createHost(store);
    const hostedSession = await host.createSession(localCreateInput);
    hostedSession.session.addUserText("hello");

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

    hostedSession.session.addUserText("next");
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
    hostedSession.session.addUserText("hello");

    await expect(host.observeSession(hostedSession.session.sessionId)).resolves.toBe(hostedSession);

    expect(store.commitSessionSnapshot).not.toHaveBeenCalled();
  });

  it("keeps streamed assistant content and idles lifecycle when a turn fails mid-draft", async () => {
    const store = new MemorySessionStore();
    const host = createHost(store);
    const hostedSession = await host.createSession(localCreateInput);
    await hostedSession.snapshot();

    const deltas = [];
    hostedSession.onDelta((delta) => deltas.push(delta));

    let turnRunning = false;
    Object.defineProperty(hostedSession.runtime, "isTurnRunning", {
      configurable: true,
      get: () => turnRunning,
    });
    hostedSession.runtime.runTurn = async (options) => {
      turnRunning = true;
      try {
        await options.onEvent({
          type: "assistant_start",
          historyEntryId: "assistant-failed",
        });
        await options.onEvent({
          type: "assistant_partial",
          historyEntryId: "assistant-failed",
          snapshot: assistantPartial("streamed before failure"),
        });
        throw new Error("model stream failed");
      } finally {
        turnRunning = false;
      }
    };

    await expect(hostedSession.runTurn()).rejects.toThrow("model stream failed");

    expect(deltas.at(-1).delta).toEqual(
      expect.objectContaining({
        type: "snapshot.patch",
        changes: expect.arrayContaining([{ type: "lifecycle.set", lifecycle: "idle" }]),
      }),
    );
    await expect(hostedSession.snapshot()).resolves.toEqual(
      expect.objectContaining({
        lifecycle: "idle",
        messages: expect.arrayContaining([
          expect.objectContaining({
            id: "assistant-failed",
            state: "interrupted",
            modelVisible: true,
            message: expect.objectContaining({
              role: "assistant",
              content: [{ type: "text", text: "streamed before failure" }],
              stopReason: "aborted",
            }),
          }),
        ]),
      }),
    );
  });

  it("idles lifecycle when a turn fails after committing the final assistant message", async () => {
    const store = new MemorySessionStore();
    const host = createHost(store);
    const hostedSession = await host.createSession(localCreateInput);
    await hostedSession.snapshot();

    const deltas = [];
    hostedSession.onDelta((delta) => deltas.push(delta));

    let turnRunning = false;
    Object.defineProperty(hostedSession.runtime, "isTurnRunning", {
      configurable: true,
      get: () => turnRunning,
    });
    hostedSession.runtime.runTurn = async (options) => {
      turnRunning = true;
      try {
        await options.onEvent({
          type: "assistant_start",
          historyEntryId: "assistant-final-then-failed",
        });
        const message = assistantMessageWithToolCalls([]);
        hostedSession.session.addMessage(message, {
          historyEntryId: "assistant-final-then-failed",
        });
        await options.onEvent({
          type: "assistant_final",
          historyEntryId: "assistant-final-then-failed",
          message,
        });
        throw new Error("post-final failure");
      } finally {
        turnRunning = false;
      }
    };

    await expect(hostedSession.runTurn()).rejects.toThrow("post-final failure");

    expect(deltas.at(-1).delta).toEqual(
      expect.objectContaining({
        type: "snapshot.reset",
        snapshot: expect.objectContaining({ lifecycle: "idle" }),
      }),
    );
    await expect(hostedSession.snapshot()).resolves.toEqual(
      expect.objectContaining({
        lifecycle: "idle",
        messages: expect.arrayContaining([
          expect.objectContaining({
            id: "assistant-final-then-failed",
            state: "committed",
            modelVisible: true,
          }),
        ]),
      }),
    );
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

  it("serializes overlapping snapshots from the same live local session", async () => {
    const store = new MemorySessionStore();
    const host = createHost(store);
    const hostedSession = await host.createSession(localCreateInput);

    hostedSession.session.addUserText("hello");

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

  it("serializes live snapshot persistence with persisted runtime deltas", async () => {
    const store = new BlockingCommitStore();
    const host = createHost(store);
    const hostedSession = await host.createSession(localCreateInput);
    await hostedSession.snapshot();
    Object.defineProperty(hostedSession.runtime, "isTurnRunning", {
      configurable: true,
      get: () => true,
    });

    await hostedSession.enqueueRuntimeEvent({
      type: "assistant_start",
      historyEntryId: "assistant-persist-race",
    });
    await hostedSession.enqueueRuntimeEvent({
      type: "assistant_partial",
      historyEntryId: "assistant-persist-race",
      snapshot: assistantPartial("hello"),
    });

    const gate = store.blockNextCommit();
    const liveSnapshotPromise = hostedSession.snapshot();
    await gate.started;

    const message = assistantMessageWithToolCalls([]);
    hostedSession.session.addMessage(message, {
      historyEntryId: "assistant-persist-race",
    });
    const finalEventPromise = hostedSession.enqueueRuntimeEvent({
      type: "assistant_final",
      historyEntryId: "assistant-persist-race",
      message,
    });

    gate.release();

    await expect(liveSnapshotPromise).resolves.toEqual(expect.objectContaining({ revision: 3 }));
    await expect(finalEventPromise).resolves.toBeUndefined();
    await expect(store.loadSession(hostedSession.session.sessionId)).resolves.toEqual(
      expect.objectContaining({
        revision: 4,
        messages: expect.arrayContaining([
          expect.objectContaining({
            id: "assistant-persist-race",
            state: "committed",
            modelVisible: true,
          }),
        ]),
      }),
    );
  });

  it("does not let an older live snapshot write clobber newer streamed state", async () => {
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

    await hostedSession.enqueueRuntimeEvent({
      type: "assistant_partial",
      historyEntryId: "assistant-live-race",
      snapshot: assistantPartial("hello world"),
    });

    gate.release();

    await expect(liveSnapshotPromise).resolves.toEqual(
      expect.objectContaining({
        revision: 4,
        messages: expect.arrayContaining([
          expect.objectContaining({
            id: "assistant-live-race",
            message: expect.objectContaining({
              content: [{ type: "text", text: "hello world" }],
            }),
          }),
        ]),
      }),
    );

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

  it("applies session.create persona and reasoning overrides before startup", async () => {
    const store = new MemorySessionStore();
    const host = createHost(store, { personas: [personas[0], personas[1]] });
    const hostedSession = await host.createSession({
      executionEnvironment: { kind: "local", cwd: "/repo" },
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
    session.session.addMessage({ role: "user", content: [{ type: "text", text: "loaded" }] });

    expect(session.session.history).toEqual([
      { role: "user", content: [{ type: "text", text: "loaded" }] },
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
    const toolRegistry = ToolCatalog.createRegistry(createLocalToolExecutionBackend());
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
        toolRegistry,
        promptBootstrap: {
          promptContext: {
            cwd: "/repo",
            home: "/home/user",
            repoRoot: "/repo",
            platform: "linux",
            nodeVersion: "v24.0.0",
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
    expect(session.runtime.session.engine.modelResolver).toBe(liveModelResolver);
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
    const toolRegistry = ToolCatalog.createRegistry(createLocalToolExecutionBackend());
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
        toolRegistry,
        promptBootstrap: {
          promptContext: {
            cwd: "/repo",
            home: "/home/user",
            repoRoot: "/repo",
            platform: "linux",
            nodeVersion: "v24.0.0",
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
    const systemPrompt = thread.session.engine.systemPrompt;

    expect(systemPrompt).toContain("target AGENTS instructions");
    expect(systemPrompt).toContain("target skill");
    expect(systemPrompt).toContain("<cwd>/repo</cwd>");
    expect(systemPrompt).toContain("review instructions");
  });

  it("resolves prompt bodies from the execution environment each time", async () => {
    const store = new MemorySessionStore();
    const toolRegistry = ToolCatalog.createRegistry(createLocalToolExecutionBackend());
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
        toolRegistry,
        promptBootstrap: {
          promptContext: {
            cwd: "/repo",
            home: "/home/user",
            repoRoot: "/repo",
            platform: "linux",
            nodeVersion: "v24.0.0",
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
    const toolRegistry = ToolCatalog.createRegistry(createLocalToolExecutionBackend());
    const autocompleteOutput = "src/main.ts\nsrc/host/local_session_host.ts\nREADME.md\n";
    const runBash = vi.fn(async () => ({
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
        toolRegistry,
        promptBootstrap: {
          promptContext: {
            cwd: "/repo",
            home: "/home/user",
            repoRoot: "/repo",
            platform: "linux",
            nodeVersion: "v24.0.0",
            includeAgentContext,
            projectContextBlock: "",
            skillsBlock: `<skills>${persona.id}:${discoveredSkills.length}</skills>`,
          },
          agentsFiles: [],
          warnings: [],
          unknownSkills: [],
        },
      }),
      getToolExecutionBackend: () => ({ runBash }),
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

    expect(runBash).toHaveBeenCalledTimes(1);
  });

  it("recovers idle stored sessions with their durable session and history ids", async () => {
    const store = new MemorySessionStore();
    const originalHost = createHost(store);
    const originalSession = await originalHost.createSession(localCreateInput);
    const historyEntryId = originalSession.session.addUserText("persisted");
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
    const historyEntryId = originalSession.session.addMessage(
      {
        role: "user",
        content: [{ type: "text", text: rawText }],
        timestamp: 1,
      },
      { historyEntryId: "history-raw" },
    );

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
    originalSession.session.addUserText("persisted prompt");
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
      "<datetime>2026-01-01T00:00:00.000Z</datetime>",
    );
  });

  it("resolves runtime config from the execution environment when recovering", async () => {
    const store = new MemorySessionStore();
    const originalHost = createHost(store);
    const originalSession = await originalHost.createSession(localCreateInput);
    originalSession.session.addUserText("persisted config owner");
    const storedSnapshot = await originalSession.snapshot();
    await store.commitSessionSnapshot(storedSnapshot, {
      expectedRevision: storedSnapshot.revision,
    });
    const toolRegistry = ToolCatalog.createRegistry(createLocalToolExecutionBackend());
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
        toolRegistry,
        promptBootstrap: {
          promptContext: {
            cwd: "/repo",
            home: "/home/user",
            repoRoot: "/repo",
            platform: "linux",
            nodeVersion: "v24.0.0",
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
    expect(recoveredSession.runtime.session.engine.config).toEqual({
      autoCompact: { enabled: false },
    });
  });

  it("rejects commits from a stale recovered session after another host commits a newer revision", async () => {
    const store = new MemorySessionStore();
    const originalHost = createHost(store);
    const originalSession = await originalHost.createSession(localCreateInput);
    originalSession.session.addUserText("base");
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

  it("removes directly disposed live handles from host recovery bookkeeping", async () => {
    const store = new MemorySessionStore();
    const host = createHost(store);
    const session = await host.createSession(localCreateInput);
    session.session.addUserText("recover after direct dispose");
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
    session.session.addUserText("delete me");
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

  it("recovers stale running snapshots as idle snapshots", async () => {
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

    const recoveredSession = await host.observeSession("stored-running");

    expect(recoveredSession).toBeDefined();
    if (!recoveredSession) {
      throw new Error("expected stored session to recover");
    }
    await expect(recoveredSession.snapshot()).resolves.toEqual(
      createStoredSnapshot({
        sessionId: "stored-running",
        revision: 5,
        lifecycle: "idle",
        historyEntries: [
          {
            id: "entry-1",
            message: {
              role: "user",
              content: [{ type: "text", text: "stale turn" }],
            },
          },
        ],
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

  it("recovers stale draft assistant messages as interrupted model-visible messages", async () => {
    const store = new MemorySessionStore();
    const host = createHost(store);
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
    });
    await store.commitSessionSnapshot(storedSnapshot);

    const recoveredSession = await host.observeSession("stored-draft");

    expect(recoveredSession).toBeDefined();
    if (!recoveredSession) {
      throw new Error("expected stored session to recover");
    }
    const snapshot = await recoveredSession.snapshot();
    expect(snapshot.lifecycle).toBe("idle");
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
    expect(snapshot.timeline).toEqual([]);
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
