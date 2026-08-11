import { existsSync, readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import {
  SESSION_PROTOCOL_METHODS,
  SESSION_PROTOCOL_VERSION,
} from "../dist/protocol/session_protocol.js";
import {
  buildTauClientToolPresentation,
  createTauSdkClientFromTransport,
  getTauSdkSessionTurnOutcome,
  getTauSdkSessionTurnRecord,
  TauSessionClientError,
  TauTransportError,
  truncateTauClientToolSubject,
} from "../dist/sdk/index.js";
import {
  createProtocolBootstrap,
  createProtocolExecResult,
  createProtocolSnapshot,
} from "./helpers/session_protocol_fixtures.js";

function createReadyMessage() {
  return {
    version: SESSION_PROTOCOL_VERSION,
    type: "ready",
    methods: [...SESSION_PROTOCOL_METHODS],
  };
}

const bootstrap = createProtocolBootstrap();

function describeClientTool(toolName, subject = toolName) {
  return buildTauClientToolPresentation({ toolName, subject });
}

const localCreateInput = {
  executionEnvironment: { kind: "local", cwd: "/repo" },
  attributes: { source: "test" },
};

function createSnapshot(sessionId) {
  return createProtocolSnapshot({
    sessionId,
    bootstrap,
  });
}

function createNoticeDelta(sessionId, revision, text) {
  return {
    version: SESSION_PROTOCOL_VERSION,
    type: "session.delta",
    sessionId,
    fromRevision: revision,
    toRevision: revision + 1,
    cause: { type: "notice" },
    delta: {
      type: "snapshot.patch",
      changes: [
        {
          type: "timeline.append",
          item: {
            type: "notice",
            id: `notice-${revision}`,
            sequence: revision,
            createdAt: revision,
            notice: {
              kind: "tau.test.notice",
              version: 1,
              severity: "info",
              subject: { type: "session" },
              presentation: { title: text },
              data: {},
            },
          },
        },
      ],
    },
  };
}

class FakeSessionProtocolTransport {
  constructor() {
    this.ready = createReadyMessage();
    this.connect = vi.fn(async (initializeParams, timeoutMs) => {
      this.initializeParams = initializeParams;
      this.connectTimeoutMs = timeoutMs;
    });
    this.request = vi.fn(async (method, params) => {
      this.requests.push({ method, params });
      const overrideResult = await this.onRequest?.(method, params);
      if (overrideResult !== undefined) {
        return overrideResult;
      }
      switch (method) {
        case "session.create":
          return { sessionId: "session-2" };
        case "session.observe":
          return createObserveResult(params.sessionId);
        case "session.snapshot":
          return createSnapshot(params.sessionId);
        case "session.startGoal":
          return {
            userHistoryEntryId: "goal-user",
            turn: { status: "completed", stopReason: "stop" },
          };
        case "session.resumeGoal":
          return { turn: { status: "completed", stopReason: "stop" } };
        case "session.clearGoal":
          return createProtocolSnapshot({ sessionId: params.sessionId, revision: 3 });
        case "session.setReasoning":
          return {
            revision: 2,
            settings: {
              personaId: bootstrap.persona.id,
              reasoning: params.reasoning,
            },
          };
        case "session.resolvePrompt":
          return { promptId: params.promptId, text: `prompt body for ${params.promptId}` };
        case "session.reload":
          return {
            snapshot: {
              ...createSnapshot(params.sessionId),
              revision: 4,
            },
            warnings: [],
            counts: { personas: 1, prompts: 1, skills: 0 },
          };
        case "session.compact":
          return {
            snapshot: createProtocolSnapshot({
              sessionId: params.sessionId,
              revision: 2,
              historyEntries: [
                {
                  id: "summary-entry",
                  message: {
                    role: "user",
                    content: [{ type: "text", text: "compacted summary" }],
                  },
                },
              ],
            }),
            compactionMessage: "compacted summary",
            includedLastAssistant: params.mode === "summary-and-last",
          };
        case "session.rewind":
          return {
            snapshot: createProtocolSnapshot({
              sessionId: params.sessionId,
              revision: 5,
              historyEntries: [],
            }),
            historyEntryId: params.historyEntryId,
            text: "rewound text",
            removedEntryIds: [params.historyEntryId, "assistant-1"],
          };
        case "session.interruptSubagent":
          return { found: params.subagentId === "subagent-1" };
        case "session.list":
          return { sessions: [{ sessionId: "session-1", lifecycle: "idle" }] };
        case "session.submit":
        case "session.queue":
        case "session.steer":
          return {
            userHistoryEntryId: params.historyEntryId ?? "entry-1",
            turn: { status: "completed", stopReason: "stop" },
          };
        case "session.cancelPendingMessages":
          return { cancelled: [] };
        case "session.retry":
          return { turn: { status: "completed", stopReason: "stop" } };
        case "session.exec":
          return createProtocolExecResult({ output: "raw output" });
        case "session.cancelExec":
          return { cancelled: true };
        case "session.sample":
          return {
            message: {
              role: "assistant",
              content: [{ type: "text", text: "sampled" }],
              api: "openai-responses",
              provider: "openai",
              model: "gpt-5.6-sol",
              stopReason: "stop",
              usage: {
                input: 1,
                output: 1,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 2,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
              },
              timestamp: 1,
            },
          };
        case "session.record":
          return {
            snapshot: createProtocolSnapshot({
              sessionId: params.sessionId,
              revision: 6,
              historyEntries: [
                {
                  id: params.historyEntryId ?? "added-user",
                  message: { role: "user", content: [{ type: "text", text: params.text }] },
                },
              ],
            }),
            userHistoryEntryId: params.historyEntryId ?? "added-user",
          };
        case "session.interrupt":
          return { interrupted: true, isTurnRunning: false };
        case "session.unobserve":
          return { unobserved: true };
        case "session.clientTool.ack":
        case "session.clientTool.result":
          return { accepted: true };
        default:
          throw new Error(`unexpected method ${method}`);
      }
    });
    this.close = vi.fn(async () => {
      this.closed = true;
    });
  }

  requests = [];
  listeners = new Set();
  pendingUserMessagesListeners = new Set();
  subagentActivitiesListeners = new Set();
  clientToolListeners = new Set();
  failureListeners = new Set();
  initializeParams;
  connectTimeoutMs;
  closed = false;
  onRequest;

  onDelta(listener) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  onEphemeral() {
    return () => {};
  }

  onPendingUserMessages(listener) {
    this.pendingUserMessagesListeners.add(listener);
    return () => {
      this.pendingUserMessagesListeners.delete(listener);
    };
  }

  onSubagentActivities(listener) {
    this.subagentActivitiesListeners.add(listener);
    return () => {
      this.subagentActivitiesListeners.delete(listener);
    };
  }

  onClientTool(listener) {
    this.clientToolListeners.add(listener);
    return () => {
      this.clientToolListeners.delete(listener);
    };
  }

  onFailure(listener) {
    this.failureListeners.add(listener);
    return () => {
      this.failureListeners.delete(listener);
    };
  }

  emitDelta(delta) {
    for (const listener of this.listeners) {
      listener(delta);
    }
  }

  emitPendingUserMessages(message) {
    for (const listener of this.pendingUserMessagesListeners) {
      listener(message);
    }
  }

  emitSubagentActivities(message) {
    for (const listener of this.subagentActivitiesListeners) {
      listener(message);
    }
  }

  emitClientTool(message) {
    for (const listener of this.clientToolListeners) {
      listener(message);
    }
  }

  emitFailure(error) {
    for (const listener of this.failureListeners) {
      listener(error);
    }
  }
}

function createPendingUserMessagesMessage(sessionId, messages = [], revision = 1) {
  return {
    version: SESSION_PROTOCOL_VERSION,
    type: "session.pendingUserMessages",
    sessionId,
    state: { revision, messages },
  };
}

function createSubagentActivitiesMessage(sessionId, revision, changes) {
  return {
    version: SESSION_PROTOCOL_VERSION,
    type: "session.subagentActivities",
    sessionId,
    revision,
    changes,
  };
}

function createObserveResult(sessionId, snapshot = createSnapshot(sessionId)) {
  return {
    snapshot,
    pendingUserMessages: { revision: 1, messages: [] },
    subagentActivities: { revision: 1, agents: {} },
  };
}

async function waitForFakeRequest(transport, predicate, timeoutMs = 2000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const request = transport.requests.find(predicate);
    if (request) {
      return request;
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error("timed out waiting for fake transport request");
}

describe("sdk_client", () => {
  it("exports bounded client tool subject truncation", () => {
    expect(
      truncateTauClientToolSubject("one\ntwo\nthree\nfour", {
        maxLines: 3,
        maxLineChars: 5,
        strategy: "head",
      }),
    ).toBe("one\ntwo\n…2 m…");
    expect(() => truncateTauClientToolSubject("subject", { maxLines: 9 })).toThrow(
      "subject maxLines must be between 1 and 8",
    );
  });
  it("reads running and settled turns from the canonical snapshot ledger", () => {
    const running = { userHistoryEntryId: "running-turn", state: "running" };
    const outcome = { status: "completed", stopReason: "stop" };
    const settled = { userHistoryEntryId: "settled-turn", state: "settled", outcome };
    const snapshot = createProtocolSnapshot({
      turns: { "running-turn": running, "settled-turn": settled },
    });

    expect(getTauSdkSessionTurnRecord(snapshot, "running-turn")).toEqual(running);
    expect(getTauSdkSessionTurnOutcome(snapshot, "running-turn")).toBeUndefined();
    expect(getTauSdkSessionTurnRecord(snapshot, "settled-turn")).toEqual(settled);
    expect(getTauSdkSessionTurnOutcome(snapshot, "settled-turn")).toEqual(outcome);
    for (const unknownId of ["missing-turn", "__proto__", "constructor", "toString"]) {
      expect(getTauSdkSessionTurnRecord(snapshot, unknownId)).toBeUndefined();
      expect(getTauSdkSessionTurnOutcome(snapshot, unknownId)).toBeUndefined();
    }

    const prototypeTurn = { userHistoryEntryId: "__proto__", state: "settled", outcome };
    const prototypeSnapshot = createProtocolSnapshot({
      turns: Object.fromEntries([["__proto__", prototypeTurn]]),
    });
    expect(getTauSdkSessionTurnRecord(prototypeSnapshot, "__proto__")).toEqual(prototypeTurn);
    expect(getTauSdkSessionTurnOutcome(prototypeSnapshot, "__proto__")).toEqual(outcome);
  });

  it("keeps published sdk declarations free of core type imports", () => {
    const indexDeclaration = readFileSync(
      new URL("../dist/sdk/index.d.ts", import.meta.url),
      "utf8",
    );
    const typesDeclaration = readFileSync(
      new URL("../dist/sdk/types.d.ts", import.meta.url),
      "utf8",
    );
    const sessionDeclaration = readFileSync(
      new URL("../dist/sdk/session.d.ts", import.meta.url),
      "utf8",
    );
    const transportErrorsDeclaration = readFileSync(
      new URL("../dist/transport/errors.d.ts", import.meta.url),
      "utf8",
    );
    const transportDeclaration = readFileSync(
      new URL("../dist/transport/session_transport.d.ts", import.meta.url),
      "utf8",
    );
    const websocketTransportDeclaration = readFileSync(
      new URL("../dist/transport/websocket_session_transport.d.ts", import.meta.url),
      "utf8",
    );
    const protocolDeclaration = readFileSync(
      new URL("../dist/protocol/session_protocol.d.ts", import.meta.url),
      "utf8",
    );

    expect(
      existsSync(new URL("../dist/transport/in_process_session_transport.d.ts", import.meta.url)),
    ).toBe(false);
    expect(indexDeclaration).not.toContain("../core/");
    expect(typesDeclaration).not.toContain("../core/");
    expect(sessionDeclaration).not.toContain("../core/");
    expect(transportErrorsDeclaration).not.toContain("../core/");
    expect(transportDeclaration).not.toContain("../core/");
    expect(websocketTransportDeclaration).not.toContain("../core/");
    expect(protocolDeclaration).not.toContain("../core/");
  });

  it("creates the same sdk session facade from an arbitrary session protocol transport", async () => {
    const transport = new FakeSessionProtocolTransport();
    const client = await createTauSdkClientFromTransport(transport, {
      connectTimeoutMs: 42,
      initialize: { client: { name: " custom-client ", version: " 2 " } },
    });

    expect(transport.connect).toHaveBeenCalledTimes(1);
    expect(transport.initializeParams).toEqual({
      client: { name: " custom-client ", version: " 2 " },
    });
    expect(transport.connectTimeoutMs).toBe(42);

    const readySession = await client.sessions.observe("session-1");
    expect(readySession.pendingUserMessages()).toEqual({ revision: 1, messages: [] });
    const pendingUserMessageStates = [];
    readySession.onPendingUserMessages((message) => pendingUserMessageStates.push(message.state));
    transport.emitPendingUserMessages(
      createPendingUserMessagesMessage(
        "session-1",
        [{ id: "queue-1", mode: "queue", text: "queued" }],
        2,
      ),
    );
    expect(readySession.pendingUserMessages()).toEqual({
      revision: 2,
      messages: [{ id: "queue-1", mode: "queue", text: "queued" }],
    });
    expect(pendingUserMessageStates.at(-1)).toEqual(readySession.pendingUserMessages());

    expect(readySession.subagentActivities()).toEqual({ revision: 1, agents: {} });
    const subagentActivityMessages = [];
    readySession.onSubagentActivities((message) => subagentActivityMessages.push(message));
    const agentState = {
      runRevision: 1,
      activities: [{ type: "assistant", text: "working" }],
    };
    const agentSet = { type: "agent.set", agentId: "agent-1", state: agentState };
    transport.emitSubagentActivities(createSubagentActivitiesMessage("session-1", 2, [agentSet]));
    expect(readySession.subagentActivities()).toEqual({
      revision: 2,
      agents: { "agent-1": agentState },
    });
    expect(subagentActivityMessages.at(-1)).toEqual(
      createSubagentActivitiesMessage("session-1", 2, [agentSet]),
    );

    transport.emitSubagentActivities(
      createSubagentActivitiesMessage("session-1", 3, [
        { type: "agent.remove", agentId: "agent-1" },
      ]),
    );
    expect(readySession.subagentActivities()).toEqual({ revision: 3, agents: {} });

    await expect(readySession.submit("hello", { historyEntryId: "entry-custom" })).resolves.toEqual(
      {
        userHistoryEntryId: "entry-custom",
        turn: { status: "completed", stopReason: "stop" },
      },
    );
    expect(transport.requests.at(-1)).toEqual({
      method: "session.submit",
      params: {
        sessionId: "session-1",
        text: "hello",
        historyEntryId: "entry-custom",
      },
    });

    await expect(readySession.queue("queued")).resolves.toEqual({
      userHistoryEntryId: "entry-1",
      turn: { status: "completed", stopReason: "stop" },
    });
    expect(transport.requests.at(-1)).toEqual({
      method: "session.queue",
      params: { sessionId: "session-1", text: "queued" },
    });

    await expect(readySession.steer("steer")).resolves.toEqual({
      userHistoryEntryId: "entry-1",
      turn: { status: "completed", stopReason: "stop" },
    });
    expect(transport.requests.at(-1)).toEqual({
      method: "session.steer",
      params: { sessionId: "session-1", text: "steer" },
    });

    await expect(readySession.cancelPendingMessages()).resolves.toEqual({ cancelled: [] });
    expect(transport.requests.at(-1)).toEqual({
      method: "session.cancelPendingMessages",
      params: { sessionId: "session-1" },
    });

    await expect(readySession.retry()).resolves.toEqual({
      turn: { status: "completed", stopReason: "stop" },
    });
    expect(transport.requests.at(-1)).toEqual({
      method: "session.retry",
      params: { sessionId: "session-1" },
    });

    await expect(readySession.exec("pwd")).resolves.toEqual(
      createProtocolExecResult({ output: "raw output" }),
    );
    expect(transport.requests.at(-1)).toEqual({
      method: "session.exec",
      params: {
        sessionId: "session-1",
        execId: expect.any(String),
        command: "pwd",
      },
    });

    await expect(
      readySession.exec("git diff", {
        args: ["one", "two"],
        env: { GIT_OPTIONAL_LOCKS: "0" },
        stdin: Buffer.from("input"),
        cwd: "/repo",
        timeoutMs: 30000,
        maxCaptureBytes: 2 * 1024 * 1024,
      }),
    ).resolves.toEqual(createProtocolExecResult({ output: "raw output" }));
    expect(transport.requests.at(-1)).toEqual({
      method: "session.exec",
      params: {
        sessionId: "session-1",
        execId: expect.any(String),
        command: "git diff",
        args: ["one", "two"],
        env: { GIT_OPTIONAL_LOCKS: "0" },
        stdinBase64: Buffer.from("input").toString("base64"),
        cwd: "/repo",
        timeoutMs: 30000,
        maxCaptureBytes: 2 * 1024 * 1024,
      },
    });

    await expect(readySession.record("review", { historyEntryId: "review-1" })).resolves.toEqual({
      snapshot: expect.objectContaining({
        sessionId: "session-1",
        revision: 6,
        messages: expect.arrayContaining([
          expect.objectContaining({
            id: "review-1",
            message: expect.objectContaining({
              role: "user",
              content: [{ type: "text", text: "review" }],
            }),
          }),
        ]),
      }),
      userHistoryEntryId: "review-1",
    });
    expect(transport.requests.at(-1)).toEqual({
      method: "session.record",
      params: { sessionId: "session-1", text: "review", historyEntryId: "review-1" },
    });
    await expect(readySession.startGoal("Ship the feature")).resolves.toEqual({
      userHistoryEntryId: "goal-user",
      turn: { status: "completed", stopReason: "stop" },
    });
    expect(transport.requests.at(-1)).toEqual({
      method: "session.startGoal",
      params: { sessionId: "session-1", objective: "Ship the feature" },
    });
    await expect(readySession.resumeGoal()).resolves.toEqual({
      turn: { status: "completed", stopReason: "stop" },
    });
    expect(transport.requests.at(-1)).toEqual({
      method: "session.resumeGoal",
      params: { sessionId: "session-1" },
    });
    await expect(readySession.clearGoal()).resolves.toMatchObject({
      sessionId: "session-1",
      goal: null,
    });
    expect(transport.requests.at(-1)).toEqual({
      method: "session.clearGoal",
      params: { sessionId: "session-1" },
    });

    await expect(readySession.setReasoning("high")).resolves.toEqual(
      expect.objectContaining({
        settings: expect.objectContaining({ reasoning: "high" }),
      }),
    );
    expect(transport.requests.at(-1)).toEqual({
      method: "session.setReasoning",
      params: { sessionId: "session-1", reasoning: "high" },
    });

    await expect(readySession.resolvePrompt("fix")).resolves.toEqual({
      promptId: "fix",
      text: "prompt body for fix",
    });
    expect(transport.requests.at(-1)).toEqual({
      method: "session.resolvePrompt",
      params: { sessionId: "session-1", promptId: "fix" },
    });

    await expect(
      readySession.compact("summary-and-last", { guidance: "preserve decisions" }),
    ).resolves.toEqual({
      snapshot: expect.objectContaining({
        sessionId: "session-1",
        revision: 2,
      }),
      compactionMessage: "compacted summary",
      includedLastAssistant: true,
    });
    expect(transport.requests.at(-1)).toEqual({
      method: "session.compact",
      params: {
        sessionId: "session-1",
        mode: "summary-and-last",
        guidance: "preserve decisions",
      },
    });

    await expect(readySession.rewindToHistoryEntryId("history-1")).resolves.toEqual({
      snapshot: expect.objectContaining({
        sessionId: "session-1",
        revision: 5,
        messages: [
          expect.objectContaining({
            id: "system",
            message: expect.objectContaining({ role: "system" }),
          }),
        ],
      }),
      historyEntryId: "history-1",
      text: "rewound text",
      removedEntryIds: ["history-1", "assistant-1"],
    });
    expect(transport.requests.at(-1)).toEqual({
      method: "session.rewind",
      params: { sessionId: "session-1", historyEntryId: "history-1" },
    });

    await expect(readySession.interruptSubagent("subagent-1")).resolves.toEqual({ found: true });
    expect(transport.requests.at(-1)).toEqual({
      method: "session.interruptSubagent",
      params: { sessionId: "session-1", subagentId: "subagent-1" },
    });

    const unobservedSession = await client.sessions.observe("session-1");
    await expect(unobservedSession.unobserve()).resolves.toEqual({ unobserved: true });
    expect(transport.requests.at(-1)).toEqual({
      method: "session.unobserve",
      params: { sessionId: "session-1" },
    });
    await expect(unobservedSession.snapshot()).rejects.toMatchObject({
      message: "tau sdk session is unobserved",
    });

    const createdSession = await client.sessions.create(localCreateInput);
    const receivedDeltas = [];
    const unsubscribe = createdSession.onDelta((delta) => receivedDeltas.push(delta));
    const matchingDelta = createNoticeDelta("session-2", 1, "hi");

    transport.emitDelta({
      ...matchingDelta,
      sessionId: "session-2",
    });
    transport.emitDelta({
      ...matchingDelta,
      sessionId: "session-1",
    });

    expect(createdSession.id).toBe("session-2");
    expect(receivedDeltas).toEqual([matchingDelta]);

    await expect(createdSession.unobserve()).resolves.toEqual({ unobserved: true });
    await expect(createdSession.snapshot()).rejects.toBeInstanceOf(TauSessionClientError);
    await expect(createdSession.snapshot()).rejects.toMatchObject({
      message: "tau sdk session is unobserved",
    });

    transport.emitDelta(matchingDelta);
    expect(receivedDeltas).toEqual([matchingDelta]);
    unsubscribe();

    const bufferedDelta = createNoticeDelta("session-1", 7, "buffered before listener");
    const bufferedActivityState = {
      runRevision: 1,
      activities: [{ type: "assistant", text: "buffered activity" }],
    };
    transport.onRequest = (method) => {
      if (method === "session.observe") {
        transport.emitDelta(bufferedDelta);
        transport.emitSubagentActivities(
          createSubagentActivitiesMessage("session-1", 2, [
            { type: "agent.set", agentId: "agent-buffered", state: bufferedActivityState },
          ]),
        );
      }
    };
    const bufferedSession = await client.sessions.observe("session-1");
    transport.onRequest = undefined;

    const bufferedDeltas = [];
    bufferedSession.onDelta((delta) => bufferedDeltas.push(delta));
    expect(bufferedDeltas).toEqual([bufferedDelta]);
    expect(bufferedSession.subagentActivities()).toEqual({
      revision: 2,
      agents: { "agent-buffered": bufferedActivityState },
    });

    const afterListenerDelta = createNoticeDelta("session-1", 8, "after listener");
    transport.emitDelta(afterListenerDelta);
    expect(bufferedDeltas).toEqual([bufferedDelta, afterListenerDelta]);

    await client.close();
    expect(transport.closed).toBe(true);
  });

  it("cancels only the in-flight exec whose abort signal fires", async () => {
    const transport = new FakeSessionProtocolTransport();
    let finishExec;
    transport.onRequest = async (method) => {
      if (method === "session.exec") {
        return await new Promise((resolve) => {
          finishExec = resolve;
        });
      }
      if (method === "session.cancelExec") {
        finishExec(createProtocolExecResult({ output: "cancelled", aborted: true }));
        return { cancelled: true };
      }
      return undefined;
    };
    const client = await createTauSdkClientFromTransport(transport);
    const session = await client.sessions.observe("session-1");
    const abortController = new AbortController();

    const execution = session.exec("sleep 60", { signal: abortController.signal });
    await vi.waitFor(() => {
      expect(transport.requests).toContainEqual({
        method: "session.exec",
        params: {
          sessionId: "session-1",
          execId: expect.any(String),
          command: "sleep 60",
        },
      });
    });
    const execId = transport.requests.find((request) => request.method === "session.exec").params
      .execId;
    abortController.abort();

    await expect(execution).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => {
      expect(transport.requests).toContainEqual({
        method: "session.cancelExec",
        params: { sessionId: "session-1", execId },
      });
    });
    expect(transport.requests.some((request) => request.method === "session.interrupt")).toBe(
      false,
    );
    await client.close();
  });

  it("consumes failures from abort-triggered targeted cancellation", async () => {
    const transport = new FakeSessionProtocolTransport();
    let finishExec;
    transport.onRequest = async (method) => {
      if (method === "session.exec") {
        return await new Promise((resolve) => {
          finishExec = resolve;
        });
      }
      if (method === "session.cancelExec") {
        throw new Error("transport closed");
      }
      return undefined;
    };
    const client = await createTauSdkClientFromTransport(transport);
    const session = await client.sessions.observe("session-1");
    const abortController = new AbortController();

    const execution = session.exec("sleep 60", { signal: abortController.signal });
    await vi.waitFor(() => {
      expect(transport.requests).toContainEqual({
        method: "session.exec",
        params: {
          sessionId: "session-1",
          execId: expect.any(String),
          command: "sleep 60",
        },
      });
    });
    abortController.abort();
    await expect(execution).rejects.toMatchObject({ name: "AbortError" });
    await vi.waitFor(() => {
      expect(transport.requests.some((request) => request.method === "session.cancelExec")).toBe(
        true,
      );
    });
    finishExec(createProtocolExecResult({ output: "finished" }));
    await client.close();
  });

  it("keeps pending user message updates newer than the observe bootstrap", async () => {
    const transport = new FakeSessionProtocolTransport();
    transport.onRequest = (method, params) => {
      if (method !== "session.observe") {
        return undefined;
      }
      transport.emitPendingUserMessages(
        createPendingUserMessagesMessage(
          params.sessionId,
          [{ id: "queue-1", mode: "queue", text: "queued during bootstrap" }],
          2,
        ),
      );
      return createObserveResult(params.sessionId);
    };
    const client = await createTauSdkClientFromTransport(transport);

    const session = await client.sessions.observe("session-1");

    expect(session.pendingUserMessages()).toEqual({
      revision: 2,
      messages: [{ id: "queue-1", mode: "queue", text: "queued during bootstrap" }],
    });
    await client.close();
  });

  it("advertises and executes client-provided tools", async () => {
    const transport = new FakeSessionProtocolTransport();
    const execute = vi.fn(async (args, context) => {
      expect(args).toEqual({ choice: "a" });
      expect(context).toMatchObject({
        sessionId: "session-1",
        agentId: "agent-1",
        callId: "call-1",
      });
      expect(context.signal.aborted).toBe(false);
      const execution = await context.executionEnvironment.exec("printf workspace", {
        cwd: "/repo",
      });
      return { content: `picked a from ${execution.output}` };
    });
    const client = await createTauSdkClientFromTransport(transport, {
      clientTools: [
        {
          schema: {
            name: "local_picker",
            description: "Pick a local item.",
            parameters: {
              type: "object",
              properties: {},
              additionalProperties: false,
            },
            executionTimeoutMs: 60_000,
          },
          describe: (args) => describeClientTool("local_picker", args.choice ?? "local_picker"),
          execute,
        },
      ],
    });

    expect(transport.initializeParams).toEqual({
      client: {
        name: "tau-sdk",
        version: "1",
        tools: [
          {
            name: "local_picker",
            description: "Pick a local item.",
            parameters: {
              type: "object",
              properties: {},
              additionalProperties: false,
            },
            executionTimeoutMs: 60_000,
          },
        ],
      },
    });

    transport.emitClientTool({
      version: SESSION_PROTOCOL_VERSION,
      type: "session.clientTool.call",
      sessionId: "session-1",
      agentId: "agent-1",
      callId: "call-1",
      toolName: "local_picker",
      arguments: { choice: "a" },
      ackDeadlineMs: 5000,
      executionDeadlineMs: 60_000,
    });

    await waitForFakeRequest(
      transport,
      (request) =>
        request.method === "session.clientTool.result" && request.params.callId === "call-1",
    );
    expect(execute).toHaveBeenCalledTimes(1);
    expect(transport.requests).toEqual([
      {
        method: "session.clientTool.ack",
        params: {
          sessionId: "session-1",
          callId: "call-1",
          presentation: describeClientTool("local_picker", "a"),
        },
      },
      {
        method: "session.exec",
        params: {
          sessionId: "session-1",
          execId: expect.any(String),
          command: "printf workspace",
          cwd: "/repo",
        },
      },
      {
        method: "session.clientTool.result",
        params: {
          sessionId: "session-1",
          callId: "call-1",
          ok: true,
          content: "picked a from raw output",
        },
      },
    ]);

    await client.close();
  });

  it("cancels execution-environment commands with their client tool", async () => {
    const transport = new FakeSessionProtocolTransport();
    transport.onRequest = async (method) => {
      if (method === "session.exec") {
        return await new Promise(() => {});
      }
      return undefined;
    };
    const client = await createTauSdkClientFromTransport(transport, {
      clientTools: [
        {
          schema: {
            name: "workspace_wait",
            description: "Wait in the workspace.",
            parameters: { type: "object", properties: {}, additionalProperties: false },
          },
          describe: () => describeClientTool("workspace_wait"),
          execute: (_args, context) => context.executionEnvironment.exec("sleep 60"),
        },
      ],
    });

    transport.emitClientTool({
      version: SESSION_PROTOCOL_VERSION,
      type: "session.clientTool.call",
      sessionId: "session-1",
      agentId: "agent-1",
      callId: "call-1",
      toolName: "workspace_wait",
      arguments: {},
      ackDeadlineMs: 5000,
      executionDeadlineMs: 60_000,
    });
    await waitForFakeRequest(transport, (request) => request.method === "session.exec");
    const execId = transport.requests.find((request) => request.method === "session.exec").params
      .execId;

    transport.emitClientTool({
      version: SESSION_PROTOCOL_VERSION,
      type: "session.clientTool.cancel",
      sessionId: "session-1",
      callId: "call-1",
      reason: "aborted",
    });
    await waitForFakeRequest(
      transport,
      (request) => request.method === "session.cancelExec" && request.params.execId === execId,
    );
    expect(
      transport.requests.some((request) => request.method === "session.clientTool.result"),
    ).toBe(false);

    await client.close();
  });

  it("aborts and awaits active client tools before closing", async () => {
    const transport = new FakeSessionProtocolTransport();
    let toolSignal;
    let finishTool;
    const execute = vi.fn(
      (_args, context) =>
        new Promise((resolve) => {
          toolSignal = context.signal;
          finishTool = () => resolve({ content: "cancelled" });
        }),
    );
    const client = await createTauSdkClientFromTransport(transport, {
      clientTools: [
        {
          schema: {
            name: "local_picker",
            description: "Pick a local item.",
            parameters: { type: "object", properties: {}, additionalProperties: false },
          },
          describe: () => describeClientTool("local_picker"),
          execute,
        },
      ],
    });

    transport.emitClientTool({
      version: SESSION_PROTOCOL_VERSION,
      type: "session.clientTool.call",
      sessionId: "session-1",
      agentId: "agent-1",
      callId: "call-1",
      toolName: "local_picker",
      arguments: {},
      ackDeadlineMs: 5000,
      executionDeadlineMs: 60_000,
    });
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1));

    let closeSettled = false;
    const closePromise = client.close().then(() => {
      closeSettled = true;
    });
    await vi.waitFor(() => expect(toolSignal?.aborted).toBe(true));
    expect(transport.close).toHaveBeenCalledTimes(1);
    expect(closeSettled).toBe(false);

    finishTool();
    await closePromise;

    expect(closeSettled).toBe(true);
    expect(
      transport.requests.some((request) => request.method === "session.clientTool.result"),
    ).toBe(false);
  });

  it("awaits active client tools before propagating transport close failures", async () => {
    const transport = new FakeSessionProtocolTransport();
    const closeError = new Error("transport close failed");
    transport.close.mockRejectedValueOnce(closeError);
    let toolSignal;
    let finishTool;
    const execute = vi.fn(
      (_args, context) =>
        new Promise((resolve) => {
          toolSignal = context.signal;
          finishTool = () => resolve({ content: "cancelled" });
        }),
    );
    const client = await createTauSdkClientFromTransport(transport, {
      clientTools: [
        {
          schema: {
            name: "local_picker",
            description: "Pick a local item.",
            parameters: { type: "object", properties: {}, additionalProperties: false },
          },
          describe: () => describeClientTool("local_picker"),
          execute,
        },
      ],
    });

    transport.emitClientTool({
      version: SESSION_PROTOCOL_VERSION,
      type: "session.clientTool.call",
      sessionId: "session-1",
      agentId: "agent-1",
      callId: "call-1",
      toolName: "local_picker",
      arguments: {},
      ackDeadlineMs: 5000,
      executionDeadlineMs: 60_000,
    });
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1));

    let closeSettled = false;
    const closeOutcome = client.close().then(
      () => {
        closeSettled = true;
      },
      (error) => {
        closeSettled = true;
        return error;
      },
    );
    await vi.waitFor(() => expect(toolSignal?.aborted).toBe(true));
    expect(closeSettled).toBe(false);

    finishTool();
    await expect(closeOutcome).resolves.toBe(closeError);
    expect(closeSettled).toBe(true);
  });

  it("aborts active client tools when the transport fails", async () => {
    const transport = new FakeSessionProtocolTransport();
    let toolSignal;
    let finishTool;
    const execute = vi.fn(
      (_args, context) =>
        new Promise((resolve) => {
          toolSignal = context.signal;
          finishTool = () => resolve({ content: "cancelled" });
        }),
    );
    const client = await createTauSdkClientFromTransport(transport, {
      clientTools: [
        {
          schema: {
            name: "local_picker",
            description: "Pick a local item.",
            parameters: { type: "object", properties: {}, additionalProperties: false },
          },
          describe: () => describeClientTool("local_picker"),
          execute,
        },
      ],
    });

    transport.emitClientTool({
      version: SESSION_PROTOCOL_VERSION,
      type: "session.clientTool.call",
      sessionId: "session-1",
      agentId: "agent-1",
      callId: "call-1",
      toolName: "local_picker",
      arguments: {},
      ackDeadlineMs: 5000,
      executionDeadlineMs: 60_000,
    });
    await vi.waitFor(() => expect(execute).toHaveBeenCalledTimes(1));

    transport.emitFailure(new TauTransportError("transport lost"));
    await vi.waitFor(() => expect(toolSignal?.aborted).toBe(true));

    finishTool();
    await client.close();
    expect(
      transport.requests.some((request) => request.method === "session.clientTool.result"),
    ).toBe(false);
  });

  it("reuses create and observe snapshots for the first sdk snapshot call", async () => {
    const transport = new FakeSessionProtocolTransport();
    const client = await createTauSdkClientFromTransport(transport);

    const createdSession = await client.sessions.create(localCreateInput);
    await expect(createdSession.snapshot()).resolves.toEqual(createSnapshot("session-2"));

    const observedSession = await client.sessions.observe("session-1");
    await expect(observedSession.snapshot()).resolves.toEqual(createSnapshot("session-1"));

    expect(transport.requests).toEqual([
      { method: "session.create", params: localCreateInput },
      { method: "session.observe", params: { sessionId: "session-2" } },
      { method: "session.observe", params: { sessionId: "session-1" } },
    ]);

    await client.close();
  });

  it("drops buffered deltas already covered by the cached sdk snapshot", async () => {
    const transport = new FakeSessionProtocolTransport();
    transport.onRequest = (method, params) => {
      if (method === "session.observe") {
        return createObserveResult(params.sessionId, {
          ...createSnapshot(params.sessionId),
          revision: 3,
        });
      }
      return undefined;
    };
    const client = await createTauSdkClientFromTransport(transport);
    const session = await client.sessions.observe("session-1");
    const coveredDelta = createNoticeDelta("session-1", 2, "already in cached snapshot");
    transport.emitDelta(coveredDelta);

    await expect(session.snapshot()).resolves.toMatchObject({
      sessionId: "session-1",
      revision: 3,
    });
    const deltas = [];
    session.onDelta((delta) => deltas.push(delta));

    expect(deltas).toEqual([]);
    expect(transport.requests).toEqual([
      { method: "session.observe", params: { sessionId: "session-1" } },
    ]);

    await client.close();
  });

  it("fetches a fresh sdk snapshot when buffered deltas make the initial snapshot stale", async () => {
    const transport = new FakeSessionProtocolTransport();
    const client = await createTauSdkClientFromTransport(transport);
    const session = await client.sessions.observe("session-1");
    const bufferedDelta = createNoticeDelta("session-1", 1, "arrived before first snapshot");
    transport.emitDelta(bufferedDelta);

    transport.onRequest = (method, params) => {
      if (method === "session.snapshot") {
        return {
          ...createSnapshot(params.sessionId),
          revision: bufferedDelta.toRevision,
        };
      }
      return undefined;
    };

    await expect(session.snapshot()).resolves.toMatchObject({
      sessionId: "session-1",
      revision: bufferedDelta.toRevision,
    });
    expect(transport.requests.at(-1)).toEqual({
      method: "session.snapshot",
      params: { sessionId: "session-1" },
    });

    await client.close();
  });

  it("invalidates the initial sdk snapshot when delivered deltas advance the revision", async () => {
    const transport = new FakeSessionProtocolTransport();
    const client = await createTauSdkClientFromTransport(transport);
    const session = await client.sessions.create(localCreateInput);
    const deliveredDeltas = [];
    session.onDelta((delta) => deliveredDeltas.push(delta));
    const deliveredDelta = createNoticeDelta("session-2", 1, "delivered before first snapshot");
    transport.emitDelta(deliveredDelta);

    transport.onRequest = (method, params) => {
      if (method === "session.snapshot") {
        return {
          ...createSnapshot(params.sessionId),
          revision: deliveredDelta.toRevision,
        };
      }
      return undefined;
    };

    await expect(session.snapshot()).resolves.toMatchObject({
      sessionId: "session-2",
      revision: deliveredDelta.toRevision,
    });
    expect(deliveredDeltas).toEqual([deliveredDelta]);
    expect(transport.requests.at(-1)).toEqual({
      method: "session.snapshot",
      params: { sessionId: "session-2" },
    });

    await client.close();
  });

  it("closes transport when transport-backed sdk initialization fails", async () => {
    const transport = new FakeSessionProtocolTransport();
    const error = new TauTransportError("connect failed");
    transport.connect.mockRejectedValueOnce(error);

    await expect(createTauSdkClientFromTransport(transport)).rejects.toBe(error);
    expect(transport.close).toHaveBeenCalledTimes(1);
  });

  it("rejects invalid initialize metadata before connecting the transport", async () => {
    const transport = new FakeSessionProtocolTransport();

    await expect(
      createTauSdkClientFromTransport(transport, {
        initialize: {
          client: {
            name: "",
            version: "1",
          },
        },
      }),
    ).rejects.toMatchObject({
      name: "TauTransportError",
      message: "initialize.client.name must be a non-empty string",
    });

    expect(transport.connect).not.toHaveBeenCalled();
  });
});
