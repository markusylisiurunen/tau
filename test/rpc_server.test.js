import { PassThrough } from "node:stream";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { RpcServer, runRpcServer } from "../dist/core/modes/rpc_server.js";
import { formatSteeringUserMessage } from "../dist/core/runtime/steering.js";
import {
  EphemeralThreadBusyError,
  SessionExecBusyError,
  SessionRetryUnavailableError,
} from "../dist/host/session_host.js";
import {
  SESSION_PROTOCOL_ERROR_CODES,
  SESSION_PROTOCOL_VERSION,
} from "../dist/protocol/session_protocol.js";
import {
  createProtocolBootstrap,
  createProtocolExecResult,
  createProtocolSnapshot,
} from "./helpers/session_protocol_fixtures.js";

const bootstrap = createProtocolBootstrap();

const localCreateParams = {
  executionEnvironment: { kind: "local", cwd: "/repo" },
  attributes: { source: "test" },
};

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
            id: `notice-${revision}-${text}`,
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

function createAgentDelta(sessionId, revision, event) {
  const agent = {
    id: event.id,
    name: "default",
    title: event.title ?? event.id,
    availability: event.type === "finished" ? "idle" : "running",
    model: { provider: "anthropic", id: "claude-opus-4-8", reasoning: "medium" },
    workingDirectory: "/repo",
    createdAt: revision,
    run:
      event.type === "finished"
        ? {
            revision: 1,
            status: "succeeded",
            startedAt: revision,
            finishedAt: revision + 1,
            interruptRequested: false,
            response: "done",
          }
        : {
            revision: 1,
            status: "running",
            startedAt: revision,
            interruptRequested: false,
          },
    costTotal: event.costTotal ?? 0,
    usage: event.usage ?? {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      contextWindowUsageTokens: 0,
      contextWindow: 200000,
    },
  };
  return {
    version: SESSION_PROTOCOL_VERSION,
    type: "session.delta",
    sessionId,
    fromRevision: revision,
    toRevision: revision + 1,
    cause: { type: "agent-run" },
    delta: {
      type: "snapshot.patch",
      changes: [{ type: "agent.set", agent }],
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
    delta: {
      type: "snapshot.reset",
      snapshot,
    },
  };
}

function request(id, method, params) {
  return JSON.stringify({
    version: SESSION_PROTOCOL_VERSION,
    type: "request",
    id,
    method,
    ...(params !== undefined ? { params } : {}),
  });
}

function createHarness(options = {}) {
  const lines = [];
  const sessions = new Map();
  let nextSessionId = 1;

  const createHostedSession = (recoveredSessionId) => {
    const deltaHandlers = new Set();
    const subagentActivitiesHandlers = new Set();
    const subagentActivitiesByAgent = {};
    let subagentActivitiesRevision = 1;
    const historyEntries = [];
    const snapshotDelays = [...(options.snapshotDelays ?? [])];
    let sessionId = recoveredSessionId ?? `session-${nextSessionId++}`;
    let running = false;
    let nextHistoryId = 1;
    let nextSteeringId = 1;
    let releaseTurn;
    let pendingTurnResult = { status: "completed", stopReason: "stop" };
    let pendingTurn = null;
    let activeTurnSettlement = Promise.resolve();
    const pendingSteering = [];
    let reasoning = bootstrap.persona.settings.reasoning;
    let goal = options.goal ?? null;
    const ephemeralContexts = new Set();
    const activeWorkAbortControllers = new Set();
    const activeWorkPromises = new Set();
    const activeExecAbortControllers = new Map();

    const runActiveWork = async (operation, externalSignal) => {
      const abortController = new AbortController();
      const signal = externalSignal
        ? AbortSignal.any([externalSignal, abortController.signal])
        : abortController.signal;
      activeWorkAbortControllers.add(abortController);
      const promise = operation(signal);
      activeWorkPromises.add(promise);
      try {
        return await promise;
      } finally {
        activeWorkAbortControllers.delete(abortController);
        activeWorkPromises.delete(promise);
      }
    };

    const emitDelta = (delta) => {
      for (const handler of deltaHandlers) {
        handler(delta);
      }
    };

    const record = async (recordOptions) => {
      const userHistoryEntryId = hostedSession.session.addUserText(
        recordOptions.text,
        recordOptions.historyEntryId ? { historyEntryId: recordOptions.historyEntryId } : undefined,
      );
      return {
        snapshot: await hostedSession.snapshot(),
        userHistoryEntryId,
      };
    };

    const hostedSession = {
      get isTurnRunning() {
        return running;
      },
      get canAcceptSteering() {
        return running;
      },
      getGoal() {
        return structuredClone(goal);
      },
      get sessionId() {
        return sessionId;
      },
      onDelta(handler) {
        deltaHandlers.add(handler);
        return () => deltaHandlers.delete(handler);
      },
      onEphemeral() {
        return () => {};
      },
      subagentActivities() {
        return {
          revision: subagentActivitiesRevision,
          agents: structuredClone(subagentActivitiesByAgent),
        };
      },
      onSubagentActivities(handler) {
        subagentActivitiesHandlers.add(handler);
        return () => subagentActivitiesHandlers.delete(handler);
      },
      async snapshot() {
        const snapshotDelay = snapshotDelays.shift() ?? 0;
        if (typeof snapshotDelay === "function") {
          await snapshotDelay();
        } else if (snapshotDelay > 0) {
          await new Promise((resolve) => setTimeout(resolve, snapshotDelay));
        }

        const snapshot = createProtocolSnapshot({
          sessionId,
          revision: historyEntries.length + 1,
          lifecycle: running ? "running" : "idle",
          goal,
          bootstrap: {
            ...bootstrap,
            persona: {
              ...bootstrap.persona,
              settings: { ...bootstrap.persona.settings, reasoning },
            },
          },
          executionEnvironment: { kind: "local", cwd: "/repo", home: "/home/user" },
          historyEntries: historyEntries.map((entry) => ({
            id: entry.id,
            message: entry.message,
          })),
        });
        options.onSnapshot?.(snapshot);
        return snapshot;
      },
      session: {
        addUserText(text, addOptions) {
          const id = addOptions?.historyEntryId ?? `history-${nextHistoryId++}`;
          historyEntries.push({
            id,
            message: {
              role: "user",
              content: [{ type: "text", text }],
              timestamp: Date.now(),
            },
          });
          return id;
        },
        reset() {
          const previousSessionId = sessionId;
          historyEntries.length = 0;
          sessionId = `session-${nextSessionId++}`;
          sessions.delete(previousSessionId);
          sessions.set(sessionId, hostedSession);
        },
        dispose() {},
        get historyEntries() {
          return historyEntries;
        },
        get sessionId() {
          return sessionId;
        },
      },
      async record(recordOptions) {
        if (options.record) {
          return await options.record(recordOptions, record);
        }
        return await record(recordOptions);
      },
      async acceptTurn(recordOptions) {
        if (options.record) {
          return await options.record(recordOptions, record);
        }
        return await record(recordOptions);
      },
      async runAcceptedTurn(userHistoryEntryId) {
        const turn = await hostedSession.runTurn();
        await hostedSession.snapshot();
        return { userHistoryEntryId, turn };
      },
      async runTurn() {
        running = true;
        let settleTurn;
        activeTurnSettlement = new Promise((resolve) => {
          settleTurn = resolve;
        });
        try {
          if (options.runTurn) {
            return await options.runTurn();
          }

          emitDelta(createNoticeDelta(sessionId, historyEntries.length + 1, "streaming"));
          pendingTurn = new Promise((resolve) => {
            releaseTurn = resolve;
          });
          await pendingTurn;
          if (options.afterTurnRelease) {
            await options.afterTurnRelease();
          }
          if (pendingTurnResult.status !== "aborted" && pendingSteering.length > 0) {
            const steering = pendingSteering.splice(0);
            const historyEntryId = hostedSession.session.addUserText(
              formatSteeringUserMessage(steering.map((item) => item.text)),
            );
            for (const item of steering) {
              item.resolveApplied({ userHistoryEntryId: historyEntryId });
            }
            pendingTurn = new Promise((resolve) => {
              releaseTurn = resolve;
            });
            await pendingTurn;
            const result = {
              userHistoryEntryId: historyEntryId,
              turn: { status: "completed", stopReason: "stop" },
            };
            for (const item of steering) item.resolveResult(result);
          }
          emitDelta(createNoticeDelta(sessionId, historyEntries.length + 2, "finished"));
          return pendingTurnResult;
        } finally {
          running = false;
          pendingTurn = null;
          pendingTurnResult = { status: "completed", stopReason: "stop" };
          settleTurn();
        }
      },
      async retryTurn() {
        if (options.retryTurn) {
          return await options.retryTurn();
        }
        return await hostedSession.runTurn();
      },
      requestTurnBoundaryStop: vi.fn(() => running),
      cancelTurnBoundaryStop: vi.fn(() => running),
      steer(text) {
        const id = `steering-${nextSteeringId++}`;
        let resolveApplied;
        let rejectApplied;
        const applied = new Promise((resolve, reject) => {
          resolveApplied = resolve;
          rejectApplied = reject;
        });
        let resolveResult;
        let rejectResult;
        const result = new Promise((resolve, reject) => {
          resolveResult = resolve;
          rejectResult = reject;
        });
        pendingSteering.push({
          id,
          text,
          resolveApplied,
          rejectApplied,
          resolveResult,
          rejectResult,
        });
        return { id, applied, result };
      },
      cancelSteering: vi.fn(() => {
        const cancelled = pendingSteering.splice(0);
        for (const item of cancelled) {
          const error = new Error("steering submission was cancelled");
          item.rejectApplied(error);
          item.rejectResult(error);
        }
        return cancelled.map(({ id, text }) => ({ id, text }));
      }),
      async exec(runOptions) {
        const abortController = new AbortController();
        activeExecAbortControllers.set(runOptions.execId, abortController);
        try {
          return await runActiveWork(
            async (signal) => {
              const result = options.exec
                ? await options.exec({ ...runOptions, signal })
                : createProtocolExecResult({ command: runOptions.command });
              signal.throwIfAborted();
              return result;
            },
            AbortSignal.any([runOptions.signal, abortController.signal]),
          );
        } finally {
          activeExecAbortControllers.delete(runOptions.execId);
        }
      },
      cancelExec(execId) {
        const controller = activeExecAbortControllers.get(execId);
        if (!controller || controller.signal.aborted) return false;
        controller.abort();
        return true;
      },
      async sample(sampleOptions) {
        return await runActiveWork(
          (signal) =>
            options.sample
              ? options.sample({ ...sampleOptions, signal })
              : Promise.resolve({ message: fauxAssistantMessage("sampled") }),
          sampleOptions.signal,
        );
      },
      async clearGoal() {
        if (!goal) throw new Error("no goal exists");
        goal = null;
        return await hostedSession.snapshot();
      },
      async setReasoning(nextReasoning) {
        reasoning = nextReasoning;
        const snapshot = await hostedSession.snapshot();
        const fromRevision = Math.max(1, snapshot.revision - 1);
        emitDelta({
          version: SESSION_PROTOCOL_VERSION,
          type: "session.delta",
          sessionId,
          fromRevision,
          toRevision: snapshot.revision,
          cause: { type: "configuration" },
          delta: {
            type: "snapshot.patch",
            changes: [{ type: "settings.set", settings: snapshot.settings }],
          },
        });
        return { revision: snapshot.revision, settings: snapshot.settings };
      },
      async compact(compactOptions) {
        const compactionMessage = `compacted with ${compactOptions.mode}`;
        historyEntries.splice(0, historyEntries.length, {
          id: `history-${nextHistoryId++}`,
          message: {
            role: "user",
            content: [{ type: "text", text: compactionMessage }],
            timestamp: Date.now(),
          },
        });
        return {
          snapshot: await hostedSession.snapshot(),
          compactionMessage,
          includedLastAssistant: compactOptions.mode === "summary-and-last",
        };
      },
      rewindToHistoryEntryId: vi.fn(async (historyEntryId) => {
        const index = historyEntries.findIndex((entry) => entry.id === historyEntryId);
        if (index < 0) throw new Error("rewind failed");
        const entry = historyEntries[index];
        const removedEntryIds = historyEntries.splice(index).map((item) => item.id);
        return {
          snapshot: await hostedSession.snapshot(),
          historyEntryId,
          text: entry.message.content.map((content) => content.text ?? "").join("\n"),
          removedEntryIds,
        };
      }),
      interruptTurn() {
        if (!running || !releaseTurn) {
          return false;
        }
        pendingTurnResult = { status: "aborted", stopReason: "aborted" };
        releaseTurn();
        return true;
      },
      interruptActiveWork: vi.fn(() => {
        let interrupted = hostedSession.interruptTurn();
        for (const abortController of activeWorkAbortControllers) {
          if (!abortController.signal.aborted) {
            abortController.abort();
            interrupted = true;
          }
        }
        return interrupted;
      }),
      waitForActiveWork: vi.fn(async () => {
        await Promise.allSettled([activeTurnSettlement, ...activeWorkPromises]);
      }),
      interruptSubagent: vi.fn(async () => ({ found: true })),
      createEphemeralContext: vi.fn(async () => {
        const contextId = `context-${ephemeralContexts.size + 1}`;
        ephemeralContexts.add(contextId);
        return { contextId };
      }),
      async submitEphemeralThread(submitOptions) {
        if (options.submitEphemeralThread) {
          return await options.submitEphemeralThread(submitOptions);
        }
        return { threadId: submitOptions.threadId, response: "done" };
      },
      closeEphemeralContext: vi.fn(async (contextId) => ({
        closed: ephemeralContexts.delete(contextId),
      })),
      releaseTurn: () => releaseTurn?.(),
      canReleaseTurn: () => Boolean(releaseTurn),
      emitNotice: (text, revision = historyEntries.length + 1) => {
        emitDelta(createNoticeDelta(sessionId, revision, text));
      },
      emitSubagent: (event) => {
        emitDelta(createAgentDelta(sessionId, historyEntries.length + 1, event));
        if (event.type === "spawned") {
          subagentActivitiesByAgent[event.id] = { runRevision: 1, activities: [] };
        } else if (event.activity) {
          subagentActivitiesByAgent[event.id] = {
            runRevision: 1,
            activities: [event.activity],
          };
        }
        subagentActivitiesRevision += 1;
        const message = {
          version: SESSION_PROTOCOL_VERSION,
          type: "session.subagentActivities",
          sessionId,
          state: hostedSession.subagentActivities(),
        };
        for (const handler of subagentActivitiesHandlers) {
          handler(message);
        }
      },
    };

    sessions.set(sessionId, hostedSession);
    return hostedSession;
  };

  const seededSession = options.precreate === false ? undefined : createHostedSession();
  const hostShutdown = vi.fn(() => {
    sessions.clear();
  });
  const host = {
    async createSession() {
      return createHostedSession();
    },
    async observeSession(sessionId) {
      return sessions.get(sessionId);
    },
    async listSessions() {
      return [...sessions.values()].map((session) => ({
        sessionId: session.sessionId,
        lifecycle: session.isTurnRunning ? "running" : "idle",
      }));
    },
    async shutdown() {
      hostShutdown();
    },
  };

  const server = new RpcServer({
    host,
    send: (line) => lines.push(JSON.parse(line)),
  });

  return {
    lines,
    server,
    host,
    hostShutdown,
    seededSession,
    releaseTurn: () => seededSession?.releaseTurn(),
    emitNotice: (text, revision) => seededSession?.emitNotice(text, revision),
    emitSubagent: (event) => seededSession?.emitSubagent(event),
    recoverSession: () => {
      if (!seededSession) {
        throw new Error("no seeded session to recover");
      }
      sessions.delete(seededSession.sessionId);
      return createHostedSession(seededSession.sessionId);
    },
  };
}

async function waitFor(predicate, timeoutMs = 2000) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitFor timeout");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function parseNdjson(text) {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}

function deltaHasNotice(line, text) {
  return (
    line.type === "session.delta" &&
    line.delta?.type === "snapshot.patch" &&
    line.delta.changes.some(
      (change) =>
        change.type === "timeline.append" && change.item.notice?.presentation.title === text,
    )
  );
}

function deltaHasAgent(line, id) {
  return (
    line.type === "session.delta" &&
    line.delta?.type === "snapshot.patch" &&
    line.delta.changes.some((change) => change.type === "agent.set" && change.agent.id === id)
  );
}

function hasAgentActivity(line, id, text) {
  return (
    line.type === "session.subagentActivities" &&
    line.state.agents[id]?.activities.some(
      (activity) => activity.type === "assistant" && activity.text === text,
    )
  );
}

function snapshotHasUserText(snapshot, text) {
  return snapshot.messages.some(
    (entry) =>
      entry.message.role === "user" &&
      entry.message.content.some((content) => content.type === "text" && content.text === text),
  );
}

describe("rpc_server", () => {
  it("starts without creating an implicit session", async () => {
    const harness = createHarness({ precreate: false });

    expect(harness.lines[0]).toEqual(
      expect.objectContaining({
        type: "ready",
      }),
    );
    expect(harness.lines[0]).not.toHaveProperty("sessionId");

    await harness.server.handleLine(request("list", "session.list", {}));
    const list = harness.lines.find((line) => line.type === "response" && line.id === "list");
    expect(list.result).toEqual({ sessions: [] });
  });

  it("returns busy for concurrent ephemeral thread submissions", async () => {
    const harness = createHarness({
      submitEphemeralThread: async ({ threadId }) => {
        throw new EphemeralThreadBusyError(`thread '${threadId}' already has an active request`);
      },
    });

    await harness.server.handleLine(
      request("ephemeral-busy", "session.ephemeral.submit", {
        sessionId: "session-1",
        contextId: "context-1",
        threadId: "thread-1",
        message: "review",
      }),
    );

    expect(
      harness.lines.find((line) => line.type === "response" && line.id === "ephemeral-busy"),
    ).toEqual(
      expect.objectContaining({
        ok: false,
        error: {
          code: SESSION_PROTOCOL_ERROR_CODES.busy,
          message: "thread 'thread-1' already has an active request",
        },
      }),
    );
  });

  it("does not create ephemeral contexts after closing during session recovery", async () => {
    const harness = createHarness();
    let markObserveStarted;
    let releaseObserve;
    const observeStarted = new Promise((resolve) => {
      markObserveStarted = resolve;
    });
    const observeBlocker = new Promise((resolve) => {
      releaseObserve = resolve;
    });
    const lines = [];
    const server = new RpcServer({
      host: {
        ...harness.host,
        async observeSession(sessionId) {
          markObserveStarted();
          await observeBlocker;
          return await harness.host.observeSession(sessionId);
        },
        shutdown: vi.fn(async () => {}),
      },
      send: (line) => lines.push(JSON.parse(line)),
    });

    const create = server.handleLine(
      request("ephemeral-create", "session.ephemeral.create", {
        sessionId: "session-1",
        instructions: "review this",
        tools: ["bash"],
      }),
    );
    await observeStarted;

    await server.close();
    releaseObserve();
    await create;

    expect(harness.seededSession.createEphemeralContext).not.toHaveBeenCalled();
    expect(lines.some((line) => line.id === "ephemeral-create")).toBe(false);
  });

  it("creates, uses, and closes ephemeral contexts during an active main turn", async () => {
    const harness = createHarness();
    const submit = harness.server.handleLine(
      request("submit", "session.submit", {
        sessionId: "session-1",
        text: "keep the main turn active",
      }),
    );
    await waitFor(() => harness.lines.some((line) => deltaHasNotice(line, "streaming")));

    await harness.server.handleLine(
      request("ephemeral-create", "session.ephemeral.create", {
        sessionId: "session-1",
        instructions: "review this",
        tools: ["bash"],
      }),
    );
    await harness.server.handleLine(
      request("ephemeral-submit", "session.ephemeral.submit", {
        sessionId: "session-1",
        contextId: "context-1",
        threadId: "thread-1",
        message: "review",
      }),
    );
    await harness.server.handleLine(
      request("ephemeral-close", "session.ephemeral.close", {
        sessionId: "session-1",
        contextId: "context-1",
      }),
    );

    expect(harness.seededSession.isTurnRunning).toBe(true);
    expect(harness.lines.find((line) => line.id === "ephemeral-create")).toEqual(
      expect.objectContaining({ ok: true, result: { contextId: "context-1" } }),
    );
    expect(harness.lines.find((line) => line.id === "ephemeral-submit")).toEqual(
      expect.objectContaining({
        ok: true,
        result: { threadId: "thread-1", response: "done" },
      }),
    );
    expect(harness.lines.find((line) => line.id === "ephemeral-close")).toEqual(
      expect.objectContaining({ ok: true, result: { closed: true } }),
    );

    harness.releaseTurn();
    await submit;
  });

  it("creates additional sessions and routes requests by session id", async () => {
    const harness = createHarness();

    await harness.server.handleLine(request("create", "session.create", localCreateParams));
    const created = harness.lines.find((line) => line.type === "response" && line.id === "create");
    expect(created).toEqual(
      expect.objectContaining({
        ok: true,
        result: { sessionId: "session-2" },
      }),
    );

    await harness.server.handleLine(request("list", "session.list", {}));
    const list = harness.lines.find((line) => line.type === "response" && line.id === "list");
    expect(list.result).toEqual({
      sessions: [
        { sessionId: "session-1", lifecycle: "idle" },
        { sessionId: "session-2", lifecycle: "idle" },
      ],
    });

    await harness.server.handleLine(
      request("bash-created", "session.exec", {
        sessionId: "session-2",
        execId: "exec-created",
        command: "pwd",
      }),
    );
    const bash = harness.lines.find(
      (line) => line.type === "response" && line.id === "bash-created",
    );
    expect(bash).toEqual(
      expect.objectContaining({
        ok: true,
        result: createProtocolExecResult({ output: "/repo\n" }),
      }),
    );

    const submit = harness.server.handleLine(
      request("submit-created", "session.submit", {
        sessionId: "session-2",
        text: "created session turn",
      }),
    );
    await waitFor(() =>
      harness.lines.some(
        (line) =>
          line.type === "session.delta" &&
          line.sessionId === "session-2" &&
          line.delta?.changes?.some(
            (change) =>
              change.type === "timeline.append" &&
              change.item.notice?.presentation.title === "streaming",
          ),
      ),
    );
    const createdSubmitEvent = harness.lines.find(
      (line) =>
        line.type === "session.delta" &&
        line.sessionId === "session-2" &&
        line.delta?.changes?.some(
          (change) =>
            change.type === "timeline.append" &&
            change.item.notice?.presentation.title === "streaming",
        ),
    );
    expect(createdSubmitEvent).toEqual(
      expect.objectContaining({
        sessionId: "session-2",
        cause: { type: "notice" },
      }),
    );
    (await harness.host.observeSession("session-2")).releaseTurn();
    await submit;

    await harness.server.handleLine(
      request("compact-created", "session.compact", {
        sessionId: "session-2",
        mode: "summary-and-last",
        guidance: "preserve decisions",
      }),
    );
    const compacted = harness.lines.find(
      (line) => line.type === "response" && line.id === "compact-created",
    );
    expect(compacted).toEqual(
      expect.objectContaining({
        ok: true,
        result: expect.objectContaining({
          compactionMessage: "compacted with summary-and-last",
          includedLastAssistant: true,
          snapshot: expect.objectContaining({
            sessionId: "session-2",
            messages: expect.arrayContaining([
              expect.objectContaining({
                message: expect.objectContaining({
                  role: "user",
                  content: [{ type: "text", text: "compacted with summary-and-last" }],
                }),
              }),
            ]),
          }),
        }),
      }),
    );

    await harness.server.handleLine(
      request("detach-created", "session.unobserve", { sessionId: "session-2" }),
    );
    await harness.server.handleLine(
      request("snapshot-created", "session.snapshot", { sessionId: "session-2" }),
    );
    const unobservedSnapshot = harness.lines.find(
      (line) => line.type === "response" && line.id === "snapshot-created",
    );
    expect(unobservedSnapshot).toEqual(
      expect.objectContaining({
        ok: true,
        result: expect.objectContaining({ sessionId: "session-2" }),
      }),
    );
  });

  it("serializes idle steering startup through user-message recording", async () => {
    let markRecordStarted;
    const recordStarted = new Promise((resolve) => {
      markRecordStarted = resolve;
    });
    let releaseRecord;
    const recordGate = new Promise((resolve) => {
      releaseRecord = resolve;
    });
    const harness = createHarness({
      record: async (options, record) => {
        markRecordStarted();
        await recordGate;
        return await record(options);
      },
    });

    const steering = harness.server.handleLine(
      request("steer-1", "session.steer", {
        sessionId: "session-1",
        text: "start from steering",
      }),
    );
    await recordStarted;
    const overlapping = harness.server.handleLine(
      request("submit-1", "session.submit", {
        sessionId: "session-1",
        text: "must remain uncommitted",
      }),
    );

    expect(harness.seededSession.session.historyEntries).toEqual([]);
    releaseRecord();
    await overlapping;
    expect(harness.lines.find((line) => line.id === "submit-1")).toMatchObject({
      ok: false,
      error: { code: SESSION_PROTOCOL_ERROR_CODES.busy },
    });
    expect(harness.seededSession.session.historyEntries).toEqual([
      expect.objectContaining({
        message: expect.objectContaining({
          content: [{ type: "text", text: "start from steering" }],
        }),
      }),
    ]);

    await waitFor(() => harness.seededSession.canReleaseTurn());
    harness.releaseTurn();
    await steering;
  });

  it("preserves steering mode while handing a request to the post-turn queue", async () => {
    let markFinalSnapshot;
    const finalSnapshotStarted = new Promise((resolve) => {
      markFinalSnapshot = resolve;
    });
    let releaseFinalSnapshot;
    const finalSnapshotGate = new Promise((resolve) => {
      releaseFinalSnapshot = resolve;
    });
    const harness = createHarness({
      snapshotDelays: [
        0,
        async () => {
          markFinalSnapshot();
          await finalSnapshotGate;
        },
      ],
    });

    const firstSubmit = harness.server.handleLine(
      request("submit-1", "session.submit", {
        sessionId: "session-1",
        text: "first turn",
      }),
    );
    await waitFor(() => harness.seededSession.canReleaseTurn());
    harness.releaseTurn();
    await finalSnapshotStarted;

    const steering = harness.server.handleLine(
      request("steer-1", "session.steer", {
        sessionId: "session-1",
        text: "preserve steer mode",
      }),
    );
    await waitFor(() =>
      harness.lines.some(
        (line) => line.type === "session.pendingUserMessages" && line.state.messages.length === 1,
      ),
    );
    expect(
      harness.lines.findLast((line) => line.type === "session.pendingUserMessages").state.messages,
    ).toEqual([expect.objectContaining({ mode: "steer", text: "preserve steer mode" })]);

    await harness.server.handleLine(
      request("cancel-1", "session.cancelPendingMessages", { sessionId: "session-1" }),
    );
    await steering;
    expect(harness.lines.find((line) => line.id === "cancel-1")).toMatchObject({
      ok: true,
      result: {
        cancelled: [expect.objectContaining({ mode: "steer", text: "preserve steer mode" })],
      },
    });

    releaseFinalSnapshot();
    await firstSubmit;
  });

  it("reports goal-controlled retry as an invalid request", async () => {
    const harness = createHarness({
      retryTurn: async () => {
        throw new SessionRetryUnavailableError("goal-controlled turns cannot be retried");
      },
    });

    await harness.server.handleLine(
      request("retry-goal", "session.retry", { sessionId: "session-1" }),
    );

    expect(harness.lines.find((line) => line.id === "retry-goal")).toMatchObject({
      ok: false,
      error: {
        code: SESSION_PROTOCOL_ERROR_CODES.invalidRequest,
        message: "goal-controlled turns cannot be retried",
      },
    });
  });

  it("rejects goal clear without interrupting unrelated active work", async () => {
    const harness = createHarness();
    const submit = harness.server.handleLine(
      request("submit-1", "session.submit", {
        sessionId: "session-1",
        text: "ordinary work",
      }),
    );
    await waitFor(() => harness.seededSession.isTurnRunning);
    const queued = harness.server.handleLine(
      request("queue-1", "session.queue", {
        sessionId: "session-1",
        text: "keep queued",
      }),
    );
    await waitFor(() =>
      harness.lines.some(
        (line) => line.type === "session.pendingUserMessages" && line.state.messages.length === 1,
      ),
    );

    await harness.server.handleLine(
      request("clear-goal", "session.clearGoal", { sessionId: "session-1" }),
    );

    expect(harness.lines.find((line) => line.id === "clear-goal")).toMatchObject({
      ok: false,
      error: { code: SESSION_PROTOCOL_ERROR_CODES.invalidRequest, message: "no goal exists" },
    });
    expect(harness.seededSession.isTurnRunning).toBe(true);
    expect(
      harness.lines.findLast((line) => line.type === "session.pendingUserMessages").state.messages,
    ).toEqual([expect.objectContaining({ mode: "queue", text: "keep queued" })]);

    await harness.server.handleLine(
      request("cancel-queue", "session.cancelPendingMessages", { sessionId: "session-1" }),
    );
    await queued;
    harness.releaseTurn();
    await submit;
  });

  it("streams submit events, forwards subagent events, and rejects overlapping submit with busy", async () => {
    const harness = createHarness();

    const firstSubmit = harness.server.handleLine(
      request("submit-1", "session.submit", {
        sessionId: "session-1",
        text: "first turn",
      }),
    );

    await waitFor(() =>
      harness.lines.some(
        (line) =>
          line.type === "session.delta" &&
          line.delta?.changes?.some(
            (change) =>
              change.type === "timeline.append" &&
              change.item.notice?.presentation.title === "streaming",
          ),
      ),
    );
    harness.emitSubagent({ type: "spawned", id: "agent-1", title: "research" });

    await harness.server.handleLine(
      request("submit-2", "session.submit", {
        sessionId: "session-1",
        text: "second turn",
      }),
    );

    harness.releaseTurn();
    await firstSubmit;

    const ready = harness.lines[0];
    expect(ready).toEqual(
      expect.objectContaining({
        type: "ready",
      }),
    );
    expect(ready).not.toHaveProperty("sessionId");

    const submitEvent = harness.lines.find(
      (line) =>
        line.type === "session.delta" &&
        line.delta?.changes?.some(
          (change) =>
            change.type === "timeline.append" &&
            change.item.notice?.presentation.title === "streaming",
        ),
    );
    expect(submitEvent).toEqual(
      expect.objectContaining({
        type: "session.delta",
        cause: { type: "notice" },
      }),
    );

    const subagentEvent = harness.lines.find(
      (line) => line.type === "session.delta" && line.cause?.type === "agent-run",
    );
    expect(subagentEvent).toEqual(
      expect.objectContaining({
        type: "session.delta",
        cause: { type: "agent-run" },
      }),
    );

    const busy = harness.lines.find((line) => line.type === "response" && line.id === "submit-2");
    expect(busy).toEqual({
      version: SESSION_PROTOCOL_VERSION,
      type: "response",
      id: "submit-2",
      ok: false,
      error: {
        code: SESSION_PROTOCOL_ERROR_CODES.busy,
        message: "a session turn is already running",
      },
    });

    const submitOk = harness.lines.find(
      (line) => line.type === "response" && line.id === "submit-1" && line.result,
    );
    expect(submitOk).toEqual(
      expect.objectContaining({
        type: "response",
        id: "submit-1",
        ok: true,
        result: {
          userHistoryEntryId: "history-1",
          turn: { status: "completed", stopReason: "stop" },
        },
      }),
    );
  });

  it("broadcasts session updates across handlers and stops after detach", async () => {
    const harness = createHarness();
    const observerLines = [];
    const observer = new RpcServer({
      host: harness.host,
      send: (line) => observerLines.push(JSON.parse(line)),
    });

    await observer.handleLine(request("attach", "session.observe", { sessionId: "session-1" }));
    await harness.server.handleLine(
      request("reasoning", "session.setReasoning", {
        sessionId: "session-1",
        reasoning: "high",
      }),
    );

    await waitFor(() =>
      observerLines.some(
        (line) =>
          line.type === "session.delta" &&
          line.sessionId === "session-1" &&
          line.delta?.type === "snapshot.patch" &&
          line.cause?.type === "configuration",
      ),
    );
    expect(observerLines.find((line) => line.type === "session.delta")).toEqual(
      expect.objectContaining({
        sessionId: "session-1",
        toRevision: expect.any(Number),
        cause: { type: "configuration" },
        delta: expect.objectContaining({ type: "snapshot.patch" }),
      }),
    );

    await observer.handleLine(request("detach", "session.unobserve", { sessionId: "session-1" }));
    expect(observerLines.find((line) => line.type === "response" && line.id === "detach")).toEqual(
      expect.objectContaining({
        ok: true,
        result: { unobserved: true },
      }),
    );
    const updateCountAfterDetach = observerLines.filter(
      (line) => line.type === "session.delta",
    ).length;

    await harness.server.handleLine(
      request("reasoning-again", "session.setReasoning", {
        sessionId: "session-1",
        reasoning: "low",
      }),
    );
    await Promise.resolve();

    expect(observerLines.filter((line) => line.type === "session.delta")).toHaveLength(
      updateCountAfterDetach,
    );

    await observer.close();
  });

  it("buffers initial observed deltas until after the observe snapshot response", async () => {
    let harness;
    harness = createHarness({
      snapshotDelays: [
        async () => {
          harness.emitNotice("during observe snapshot", 1);
        },
      ],
    });
    const observerLines = [];
    const observer = new RpcServer({
      host: harness.host,
      send: (line) => observerLines.push(JSON.parse(line)),
    });

    await observer.handleLine(request("attach", "session.observe", { sessionId: "session-1" }));

    const responseIndex = observerLines.findIndex(
      (line) => line.type === "response" && line.id === "attach",
    );
    const deltaIndex = observerLines.findIndex((line) =>
      deltaHasNotice(line, "during observe snapshot"),
    );
    expect(responseIndex).toBeGreaterThanOrEqual(0);
    expect(deltaIndex).toBeGreaterThan(responseIndex);
    expect(observerLines[responseIndex].result).toEqual(
      expect.objectContaining({
        snapshot: expect.objectContaining({
          sessionId: "session-1",
          revision: 1,
        }),
        pendingUserMessages: { revision: 1, messages: [] },
      }),
    );
    expect(observerLines[deltaIndex]).toEqual(
      expect.objectContaining({
        fromRevision: 1,
        toRevision: 2,
      }),
    );

    await observer.close();
  });

  it("buffers deltas while a repeated observe snapshot is pending", async () => {
    let harness;
    harness = createHarness({
      snapshotDelays: [
        0,
        async () => {
          harness.emitNotice("during repeated observe snapshot", 1);
        },
      ],
    });
    const observerLines = [];
    const observer = new RpcServer({
      host: harness.host,
      send: (line) => observerLines.push(JSON.parse(line)),
    });

    await observer.handleLine(request("attach-1", "session.observe", { sessionId: "session-1" }));
    observerLines.splice(0);
    await observer.handleLine(request("attach-2", "session.observe", { sessionId: "session-1" }));

    const responseIndex = observerLines.findIndex(
      (line) => line.type === "response" && line.id === "attach-2",
    );
    const deltaIndex = observerLines.findIndex((line) =>
      deltaHasNotice(line, "during repeated observe snapshot"),
    );
    expect(responseIndex).toBeGreaterThanOrEqual(0);
    expect(deltaIndex).toBeGreaterThanOrEqual(0);
    expect(deltaIndex).toBeGreaterThan(responseIndex);

    await observer.close();
  });

  it("does not keep forwarding deltas after an observe snapshot failure", async () => {
    const harness = createHarness({
      snapshotDelays: [
        async () => {
          throw new Error("snapshot unavailable");
        },
      ],
    });
    const observerLines = [];
    const observer = new RpcServer({
      host: harness.host,
      send: (line) => observerLines.push(JSON.parse(line)),
    });

    await observer.handleLine(request("attach", "session.observe", { sessionId: "session-1" }));
    expect(observerLines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "response",
          id: "attach",
          ok: false,
        }),
      ]),
    );

    harness.emitNotice("after failed observe", 1);
    await Promise.resolve();

    expect(observerLines.some((line) => deltaHasNotice(line, "after failed observe"))).toBe(false);
    await observer.close();
  });

  it("continues forwarding deltas after a repeated observe snapshot failure", async () => {
    let harness;
    harness = createHarness({
      snapshotDelays: [
        0,
        async () => {
          harness.emitNotice("during failed repeated observe", 1);
          throw new Error("snapshot unavailable");
        },
      ],
    });
    const observerLines = [];
    const observer = new RpcServer({
      host: harness.host,
      send: (line) => observerLines.push(JSON.parse(line)),
    });

    await observer.handleLine(request("attach-1", "session.observe", { sessionId: "session-1" }));
    observerLines.splice(0);
    await observer.handleLine(request("attach-2", "session.observe", { sessionId: "session-1" }));

    expect(observerLines).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "response",
          id: "attach-2",
          ok: false,
        }),
      ]),
    );
    expect(
      observerLines.some((line) => deltaHasNotice(line, "during failed repeated observe")),
    ).toBe(true);

    await observer.close();
  });

  it("commits accepted submit input before running the turn and snapshots after turn failure", async () => {
    const snapshots = [];
    let committedBeforeRun = false;
    const harness = createHarness({
      onSnapshot: (snapshot) => snapshots.push(snapshot),
      runTurn: async () => {
        committedBeforeRun = snapshots.some((snapshot) =>
          snapshotHasUserText(snapshot, "durable before model"),
        );
        throw new Error("model failed before streaming");
      },
    });

    await harness.server.handleLine(
      request("submit", "session.submit", {
        sessionId: "session-1",
        text: "durable before model",
      }),
    );

    expect(committedBeforeRun).toBe(true);
    expect(
      snapshots.filter((snapshot) => snapshotHasUserText(snapshot, "durable before model")),
    ).toHaveLength(2);
    expect(harness.lines.find((line) => line.type === "response" && line.id === "submit")).toEqual(
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({
          code: SESSION_PROTOCOL_ERROR_CODES.internalError,
          message: "failed to run session turn",
        }),
      }),
    );
  });

  it("preserves event order across async snapshot commits", async () => {
    const harness = createHarness({ snapshotDelays: [50, 0] });

    const submit = harness.server.handleLine(
      request("submit", "session.submit", {
        sessionId: "session-1",
        text: "ordered events",
      }),
    );

    await waitFor(() => harness.seededSession.canReleaseTurn());
    harness.releaseTurn();
    await submit;
    await waitFor(() => harness.lines.some((line) => deltaHasNotice(line, "finished")));

    const noticeTitles = harness.lines
      .filter((line) => line.type === "session.delta" && line.cause?.type === "notice")
      .flatMap((line) =>
        line.delta.changes
          .filter((change) => change.type === "timeline.append" && change.item.notice)
          .map((change) => change.item.notice.presentation.title),
      );
    expect(noticeTitles).toEqual(["streaming", "finished"]);
  });

  it("waits for interrupted active submits before host shutdown on close", async () => {
    let releaseSubmit;
    const submitBlocker = () =>
      new Promise((resolve) => {
        releaseSubmit = resolve;
      });
    const harness = createHarness({ afterTurnRelease: submitBlocker });

    const submitPromise = harness.server.handleLine(
      request("submit", "session.submit", {
        sessionId: "session-1",
        text: "close while submit is still settling",
      }),
    );
    await waitFor(() => harness.seededSession.canReleaseTurn());

    const closePromise = harness.server.close();
    await Promise.resolve();

    expect(harness.hostShutdown).not.toHaveBeenCalled();
    await waitFor(() => releaseSubmit);
    expect(harness.seededSession.isTurnRunning).toBe(true);
    releaseSubmit();
    await closePromise;
    await submitPromise;

    expect(harness.hostShutdown).toHaveBeenCalledTimes(1);
  });

  it("does not emit protocol output after close", async () => {
    const harness = createHarness();
    await harness.server.close();
    const lineCount = harness.lines.length;

    await harness.server.handleLine("{bad-json");
    await harness.server.handleLine(
      request("snapshot", "session.snapshot", { sessionId: "session-1" }),
    );

    expect(harness.lines).toHaveLength(lineCount);
  });

  it("rejects rewind while an active submit is finishing protocol bookkeeping", async () => {
    let markFinalSnapshotStarted;
    const finalSnapshotStarted = new Promise((resolve) => {
      markFinalSnapshotStarted = resolve;
    });
    let releaseFinalSnapshot;
    const finalSnapshotGate = new Promise((resolve) => {
      releaseFinalSnapshot = resolve;
    });
    const harness = createHarness({
      snapshotDelays: [
        0,
        async () => {
          markFinalSnapshotStarted();
          await finalSnapshotGate;
        },
      ],
    });

    const submit = harness.server.handleLine(
      request("submit", "session.submit", {
        sessionId: "session-1",
        text: "completed but still owned",
      }),
    );
    await waitFor(() => harness.seededSession.canReleaseTurn());
    const historyEntryId = harness.seededSession.session.historyEntries[0].id;
    harness.releaseTurn();
    await finalSnapshotStarted;

    expect(harness.seededSession.isTurnRunning).toBe(false);
    await harness.server.handleLine(
      request("rewind", "session.rewind", { sessionId: "session-1", historyEntryId }),
    );

    expect(harness.seededSession.rewindToHistoryEntryId).not.toHaveBeenCalled();
    expect(harness.lines.find((line) => line.id === "rewind")).toMatchObject({
      ok: false,
      error: {
        code: SESSION_PROTOCOL_ERROR_CODES.busy,
        message: "cannot rewind while session work is active or pending",
      },
    });

    releaseFinalSnapshot();
    await submit;
  });

  it("interrupts a subagent run without interrupting an active foreground turn", async () => {
    const harness = createHarness();

    const submit = harness.server.handleLine(
      request("submit-1", "session.submit", {
        sessionId: "session-1",
        text: "keep this turn running",
      }),
    );
    await waitFor(() => harness.seededSession.canReleaseTurn());

    await harness.server.handleLine(
      request("interrupt-subagent-1", "session.interruptSubagent", {
        sessionId: "session-1",
        subagentId: "agent-1",
      }),
    );

    expect(harness.seededSession.isTurnRunning).toBe(true);
    expect(harness.seededSession.interruptSubagent).toHaveBeenCalledWith("agent-1");
    expect(
      harness.lines.find((line) => line.type === "response" && line.id === "interrupt-subagent-1"),
    ).toMatchObject({ ok: true, result: { found: true } });

    harness.releaseTurn();
    await submit;
  });

  it("changes reasoning during an active turn without interrupting or rejecting queued submits", async () => {
    const harness = createHarness();

    const firstSubmit = harness.server.handleLine(
      request("submit-1", "session.submit", {
        sessionId: "session-1",
        text: "first turn",
      }),
    );
    await waitFor(() => harness.seededSession.canReleaseTurn());

    const queuedSubmit = harness.server.handleLine(
      request("queue-1", "session.queue", {
        sessionId: "session-1",
        text: "queued turn",
      }),
    );
    await harness.server.handleLine(
      request("reasoning-1", "session.setReasoning", {
        sessionId: "session-1",
        reasoning: "high",
      }),
    );

    const reasoningChanged = harness.lines.find(
      (line) => line.type === "response" && line.id === "reasoning-1",
    );
    expect(reasoningChanged).toEqual(
      expect.objectContaining({
        ok: true,
        result: expect.objectContaining({
          settings: expect.objectContaining({ reasoning: "high" }),
        }),
      }),
    );
    expect(harness.seededSession.isTurnRunning).toBe(true);
    expect(
      harness.lines.find((line) => line.type === "response" && line.id === "queue-1"),
    ).toBeUndefined();

    harness.releaseTurn();
    await firstSubmit;
    await waitFor(
      () => harness.lines.filter((line) => deltaHasNotice(line, "streaming")).length === 2,
    );
    harness.releaseTurn();
    await waitFor(() =>
      harness.lines.some((line) => line.type === "response" && line.id === "queue-1"),
    );
    await queuedSubmit;

    const queuedResult = harness.lines.find(
      (line) => line.type === "response" && line.id === "queue-1",
    );
    expect(queuedResult).toEqual(
      expect.objectContaining({
        ok: true,
        result: expect.objectContaining({
          userHistoryEntryId: expect.any(String),
          turn: { status: "completed", stopReason: "stop" },
        }),
      }),
    );
  });

  it("batches steering submits while a turn is running", async () => {
    const harness = createHarness();

    const firstSubmit = harness.server.handleLine(
      request("submit-1", "session.submit", {
        sessionId: "session-1",
        text: "first turn",
      }),
    );

    await waitFor(() => harness.lines.some((line) => deltaHasNotice(line, "streaming")));
    const steerOne = harness.server.handleLine(
      request("steer-1", "session.steer", {
        sessionId: "session-1",
        text: "change direction",
      }),
    );
    const steerTwo = harness.server.handleLine(
      request("steer-2", "session.steer", {
        sessionId: "session-1",
        text: "also check docs",
      }),
    );

    await waitFor(() =>
      harness.lines.some(
        (line) => line.type === "session.pendingUserMessages" && line.state.messages.length === 2,
      ),
    );
    expect(harness.lines.some((line) => line.id === "steer-1" && line.type === "response")).toBe(
      false,
    );

    harness.releaseTurn();
    await waitFor(() =>
      harness.seededSession.session.historyEntries.some((entry) =>
        entry.message.content[0].text.includes("change direction"),
      ),
    );

    const steeringEntry = harness.seededSession.session.historyEntries.find((entry) =>
      entry.message.content[0].text.includes("change direction"),
    );
    await waitFor(() =>
      harness.lines.some(
        (line) => line.type === "session.pendingUserMessages" && line.state.messages.length === 0,
      ),
    );
    expect(harness.lines.some((line) => line.id === "steer-1" && line.type === "response")).toBe(
      false,
    );
    await harness.server.handleLine(
      request("cancel-applied", "session.cancelPendingMessages", { sessionId: "session-1" }),
    );
    expect(harness.lines.find((line) => line.id === "cancel-applied")).toEqual(
      expect.objectContaining({ ok: true, result: { cancelled: [] } }),
    );
    harness.emitSubagent({ type: "spawned", id: "agent-2", title: "research" });
    harness.releaseTurn();
    await Promise.all([firstSubmit, steerOne, steerTwo]);

    expect(steeringEntry.message.content[0].text).toContain("<system>");
    expect(steeringEntry.message.content[0].text).toContain("change direction\n\nalso check docs");

    await waitFor(() => harness.lines.some((line) => deltaHasAgent(line, "agent-2")));
    const steeringSubagentEvent = harness.lines.find((line) => deltaHasAgent(line, "agent-2"));
    expect(steeringSubagentEvent).toBeDefined();

    for (const id of ["steer-1", "steer-2"]) {
      expect(harness.lines.find((line) => line.type === "response" && line.id === id)).toEqual(
        expect.objectContaining({
          ok: true,
          result: expect.objectContaining({
            userHistoryEntryId: steeringEntry.id,
            turn: { status: "completed", stopReason: "stop" },
          }),
        }),
      );
    }
  });

  it("publishes and cancels pending queue and steering state", async () => {
    const harness = createHarness();
    const observerLines = [];
    const observer = new RpcServer({
      host: harness.host,
      send: (line) => observerLines.push(JSON.parse(line)),
    });
    await observer.handleLine(request("attach", "session.observe", { sessionId: "session-1" }));

    const firstSubmit = harness.server.handleLine(
      request("submit-1", "session.submit", {
        sessionId: "session-1",
        text: "first turn",
      }),
    );
    await waitFor(() => harness.lines.some((line) => deltaHasNotice(line, "streaming")));

    const queued = harness.server.handleLine(
      request("queue-1", "session.queue", {
        sessionId: "session-1",
        text: "run tests",
      }),
    );
    const steered = harness.server.handleLine(
      request("steer-1", "session.steer", {
        sessionId: "session-1",
        text: "change direction",
      }),
    );

    await waitFor(() =>
      harness.lines.some(
        (line) => line.type === "session.pendingUserMessages" && line.state.messages.length === 2,
      ),
    );
    const pending = harness.lines.findLast(
      (line) => line.type === "session.pendingUserMessages" && line.state.messages.length === 2,
    );
    expect(pending.state.messages).toEqual([
      expect.objectContaining({ mode: "steer", text: "change direction" }),
      expect.objectContaining({ mode: "queue", text: "run tests" }),
    ]);
    await waitFor(() =>
      observerLines.some(
        (line) => line.type === "session.pendingUserMessages" && line.state.messages.length === 2,
      ),
    );

    await observer.handleLine(request("detach", "session.unobserve", { sessionId: "session-1" }));
    await observer.handleLine(request("reattach", "session.observe", { sessionId: "session-1" }));
    expect(
      observerLines.find((line) => line.id === "reattach" && line.type === "response").result
        .pendingUserMessages.messages,
    ).toEqual([
      expect.objectContaining({ mode: "steer", text: "change direction" }),
      expect.objectContaining({ mode: "queue", text: "run tests" }),
    ]);

    await observer.handleLine(
      request("cancel-1", "session.cancelPendingMessages", { sessionId: "session-1" }),
    );
    await Promise.all([queued, steered]);

    expect(
      observerLines.find((line) => line.id === "cancel-1" && line.type === "response"),
    ).toEqual(
      expect.objectContaining({
        ok: true,
        result: {
          cancelled: [
            expect.objectContaining({ mode: "steer", text: "change direction" }),
            expect.objectContaining({ mode: "queue", text: "run tests" }),
          ],
        },
      }),
    );
    for (const id of ["queue-1", "steer-1"]) {
      expect(harness.lines.find((line) => line.id === id && line.type === "response")).toEqual(
        expect.objectContaining({
          ok: false,
          error: expect.objectContaining({ code: SESSION_PROTOCOL_ERROR_CODES.cancelled }),
        }),
      );
    }
    expect(
      harness.lines.findLast((line) => line.type === "session.pendingUserMessages").state.messages,
    ).toEqual([]);
    expect(harness.seededSession.cancelSteering).toHaveBeenCalled();

    harness.releaseTurn();
    await firstSubmit;
    await observer.close();
  });

  it("isolates pending-message observer failures from shared session work", async () => {
    const harness = createHarness();
    let rejectPendingMessages = false;
    const observer = new RpcServer({
      host: harness.host,
      send: (line) => {
        const message = JSON.parse(line);
        if (rejectPendingMessages && message.type === "session.pendingUserMessages") {
          throw new Error("observer unavailable");
        }
      },
    });
    await observer.handleLine(request("attach", "session.observe", { sessionId: "session-1" }));
    rejectPendingMessages = true;

    const firstSubmit = harness.server.handleLine(
      request("submit-1", "session.submit", {
        sessionId: "session-1",
        text: "first turn",
      }),
    );
    await waitFor(() => harness.lines.some((line) => deltaHasNotice(line, "streaming")));
    const queued = harness.server.handleLine(
      request("queue-1", "session.queue", {
        sessionId: "session-1",
        text: "queued turn",
      }),
    );
    await waitFor(() =>
      harness.lines.some(
        (line) => line.type === "session.pendingUserMessages" && line.state.messages.length === 1,
      ),
    );

    await harness.server.handleLine(
      request("cancel", "session.cancelPendingMessages", { sessionId: "session-1" }),
    );
    await queued;
    expect(harness.lines.find((line) => line.id === "queue-1")).toMatchObject({
      ok: false,
      error: { code: SESSION_PROTOCOL_ERROR_CODES.cancelled },
    });

    harness.releaseTurn();
    await firstSubmit;
    await observer.close();
  });

  it("starts recovered sessions without pending user messages", async () => {
    const harness = createHarness();
    const firstSubmit = harness.server.handleLine(
      request("submit-1", "session.submit", {
        sessionId: "session-1",
        text: "first turn",
      }),
    );
    await waitFor(() => harness.seededSession.isTurnRunning);
    const queued = harness.server.handleLine(
      request("queue-1", "session.queue", {
        sessionId: "session-1",
        text: "must not recover",
      }),
    );
    await waitFor(() =>
      harness.lines.some(
        (line) => line.type === "session.pendingUserMessages" && line.state.messages.length === 1,
      ),
    );

    harness.recoverSession();
    const recoveredLines = [];
    const recovered = new RpcServer({
      host: harness.host,
      send: (line) => recoveredLines.push(JSON.parse(line)),
    });
    await recovered.handleLine(request("recover", "session.observe", { sessionId: "session-1" }));

    expect(
      recoveredLines.find((line) => line.id === "recover" && line.type === "response").result
        .pendingUserMessages,
    ).toEqual({ revision: 1, messages: [] });

    await harness.server.handleLine(
      request("cancel", "session.cancelPendingMessages", { sessionId: "session-1" }),
    );
    await queued;
    harness.releaseTurn();
    await firstSubmit;
    await recovered.close();
  });

  it("rejects steering while an interrupted turn is still unwinding", async () => {
    let releaseUnwind;
    const unwindGate = new Promise((resolve) => {
      releaseUnwind = resolve;
    });
    const harness = createHarness({ afterTurnRelease: async () => await unwindGate });
    const firstSubmit = harness.server.handleLine(
      request("submit-1", "session.submit", {
        sessionId: "session-1",
        text: "first turn",
      }),
    );
    await waitFor(() => harness.lines.some((line) => deltaHasNotice(line, "streaming")));

    await harness.server.handleLine(
      request("interrupt-1", "session.interrupt", { sessionId: "session-1" }),
    );
    await harness.server.handleLine(
      request("steer-1", "session.steer", {
        sessionId: "session-1",
        text: "too late",
      }),
    );

    expect(harness.lines.find((line) => line.id === "steer-1")).toEqual(
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({ code: SESSION_PROTOCOL_ERROR_CODES.busy }),
      }),
    );
    releaseUnwind();
    await firstSubmit;
  });

  it("drops pending steering submits when a turn is interrupted", async () => {
    const harness = createHarness();

    const firstSubmit = harness.server.handleLine(
      request("submit-1", "session.submit", {
        sessionId: "session-1",
        text: "first turn",
      }),
    );

    await waitFor(() => harness.lines.some((line) => deltaHasNotice(line, "streaming")));
    const steer = harness.server.handleLine(
      request("steer-1", "session.steer", {
        sessionId: "session-1",
        text: "change direction",
      }),
    );
    await waitFor(() =>
      harness.lines.some(
        (line) => line.type === "session.pendingUserMessages" && line.state.messages.length === 1,
      ),
    );
    await harness.server.handleLine(
      request("interrupt", "session.interrupt", { sessionId: "session-1" }),
    );
    await Promise.all([firstSubmit, steer]);

    expect(
      harness.seededSession.session.historyEntries.some((entry) =>
        entry.message.content[0].text.includes("change direction"),
      ),
    ).toBe(false);
    expect(harness.lines.find((line) => line.type === "response" && line.id === "steer-1")).toEqual(
      {
        version: SESSION_PROTOCOL_VERSION,
        type: "response",
        id: "steer-1",
        ok: false,
        error: {
          code: SESSION_PROTOCOL_ERROR_CODES.invalidRequest,
          message: "session was interrupted",
        },
      },
    );
  });

  it("broadcasts late subagent events during later submits", async () => {
    const harness = createHarness();

    const firstSubmit = harness.server.handleLine(
      request("submit-1", "session.submit", {
        sessionId: "session-1",
        text: "first turn",
      }),
    );

    await waitFor(() => harness.lines.some((line) => deltaHasNotice(line, "streaming")));
    harness.emitSubagent({ type: "spawned", id: "agent-1", title: "research" });
    harness.releaseTurn();
    await firstSubmit;

    const secondSubmit = harness.server.handleLine(
      request("submit-2", "session.submit", {
        sessionId: "session-1",
        text: "second turn",
      }),
    );

    await waitFor(
      () => harness.lines.filter((line) => deltaHasNotice(line, "streaming")).length >= 2,
    );
    harness.emitSubagent({
      type: "subagent_activity",
      id: "agent-1",
      activity: { type: "assistant", text: "still working" },
      costTotal: 0,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        contextWindowUsageTokens: 0,
        contextWindow: 200000,
      },
    });

    harness.releaseTurn();
    await secondSubmit;

    const lateSubagentEvent = harness.lines.find((line) =>
      hasAgentActivity(line, "agent-1", "still working"),
    );
    expect(lateSubagentEvent).toEqual(
      expect.objectContaining({
        type: "session.subagentActivities",
      }),
    );

    const secondSubmitEvent = harness.lines.find((line) => deltaHasNotice(line, "streaming"));
    expect(secondSubmitEvent).toBeDefined();
  });

  it("cancels active execs through session.interrupt", async () => {
    let execStarted = false;
    const harness = createHarness({
      exec: ({ command, signal }) =>
        new Promise((resolve) => {
          execStarted = true;
          signal.addEventListener("abort", () => resolve(createProtocolExecResult({ command })), {
            once: true,
          });
        }),
    });

    const execution = harness.server.handleLine(
      request("exec", "session.exec", {
        sessionId: "session-1",
        execId: "exec-1",
        command: "sleep forever",
      }),
    );
    await waitFor(() => execStarted);

    await harness.server.handleLine(
      request("interrupt-exec", "session.interrupt", { sessionId: "session-1" }),
    );
    await execution;

    expect(harness.lines.find((line) => line.id === "exec")).toEqual(
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({
          code: SESSION_PROTOCOL_ERROR_CODES.cancelled,
          message: "execution was cancelled",
        }),
      }),
    );
    expect(harness.lines.find((line) => line.id === "interrupt-exec")).toEqual(
      expect.objectContaining({
        ok: true,
        result: { interrupted: true, isTurnRunning: true },
      }),
    );
  });

  it("reports host-wide exec id collisions as busy", async () => {
    const harness = createHarness({
      exec: ({ execId }) => {
        throw new SessionExecBusyError(execId);
      },
    });

    await harness.server.handleLine(
      request("exec", "session.exec", {
        sessionId: "session-1",
        execId: "shared-exec",
        command: "pwd",
      }),
    );

    expect(harness.lines.find((line) => line.id === "exec")).toEqual(
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({
          code: SESSION_PROTOCOL_ERROR_CODES.busy,
          message: "execution 'shared-exec' is already active",
        }),
      }),
    );
  });

  it("cancels one exec without interrupting concurrent session work", async () => {
    const releases = new Map();
    const harness = createHarness({
      exec: ({ command, signal }) =>
        new Promise((resolve) => {
          const finish = () => resolve(createProtocolExecResult({ command }));
          releases.set(command, finish);
          signal.addEventListener("abort", finish, { once: true });
        }),
    });

    const first = harness.server.handleLine(
      request("exec-first", "session.exec", {
        sessionId: "session-1",
        execId: "exec-first",
        command: "first",
      }),
    );
    const second = harness.server.handleLine(
      request("exec-second", "session.exec", {
        sessionId: "session-1",
        execId: "exec-second",
        command: "second",
      }),
    );
    await waitFor(() => releases.size === 2);

    await harness.server.handleLine(
      request("cancel-first", "session.cancelExec", {
        sessionId: "session-1",
        execId: "exec-first",
      }),
    );
    await first;

    expect(harness.lines.find((line) => line.id === "exec-first")).toEqual(
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({ code: SESSION_PROTOCOL_ERROR_CODES.cancelled }),
      }),
    );
    expect(harness.lines.find((line) => line.id === "cancel-first")).toEqual(
      expect.objectContaining({ ok: true, result: { cancelled: true } }),
    );
    expect(harness.lines.some((line) => line.id === "exec-second")).toBe(false);

    releases.get("second")();
    await second;
    expect(harness.lines.find((line) => line.id === "exec-second")).toEqual(
      expect.objectContaining({ ok: true }),
    );
  });

  it("cancels active model samples through session.interrupt", async () => {
    let sampleStarted = false;
    const harness = createHarness({
      sample: ({ signal }) =>
        new Promise((_resolve, reject) => {
          sampleStarted = true;
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
    });

    const sample = harness.server.handleLine(
      request("sample", "session.sample", {
        sessionId: "session-1",
        context: {
          systemPrompt: "Classify the request.",
          messages: [
            {
              role: "user",
              content: [{ type: "text", text: "I cannot log in" }],
              timestamp: 0,
            },
          ],
        },
        options: {},
      }),
    );
    await waitFor(() => sampleStarted);

    await harness.server.handleLine(
      request("interrupt-sample", "session.interrupt", { sessionId: "session-1" }),
    );
    await sample;

    expect(harness.lines.find((line) => line.id === "sample")).toEqual(
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({
          code: SESSION_PROTOCOL_ERROR_CODES.cancelled,
          message: "model sample was cancelled",
        }),
      }),
    );
    expect(harness.lines.find((line) => line.id === "interrupt-sample")).toEqual(
      expect.objectContaining({
        ok: true,
        result: { interrupted: true, isTurnRunning: true },
      }),
    );
  });

  it("handles interrupt, snapshot, unsupported methods, and malformed lines", async () => {
    const harness = createHarness();

    const runningSubmit = harness.server.handleLine(
      request("submit", "session.submit", {
        sessionId: "session-1",
        text: "interrupt me",
      }),
    );
    await waitFor(() => harness.seededSession.canReleaseTurn());

    await harness.server.handleLine(
      request("interrupt", "session.interrupt", { sessionId: "session-1" }),
    );
    await runningSubmit;
    expect(harness.seededSession.interruptActiveWork).toHaveBeenCalledOnce();

    await harness.server.handleLine(request("list", "session.list", {}));
    await harness.server.handleLine(
      request("attach", "session.observe", { sessionId: "session-1" }),
    );
    await harness.server.handleLine(
      request("attach-missing", "session.observe", { sessionId: "missing-session" }),
    );
    await harness.server.handleLine(
      request("snapshot", "session.snapshot", { sessionId: "session-1" }),
    );
    await harness.server.handleLine(
      request("unknown-1", "session.unknownCommand", { sessionId: "session-1" }),
    );
    await harness.server.handleLine(
      request("unknown-2", "session.unrecognizedCommand", { sessionId: "session-1" }),
    );
    await harness.server.handleLine("{bad-json");
    await harness.server.handleLine(
      request("after", "session.snapshot", { sessionId: "session-1" }),
    );

    const interrupt = harness.lines.find(
      (line) => line.type === "response" && line.id === "interrupt",
    );
    expect(interrupt).toEqual(
      expect.objectContaining({
        ok: true,
        result: {
          interrupted: true,
          isTurnRunning: true,
        },
      }),
    );

    const submit = harness.lines.find((line) => line.type === "response" && line.id === "submit");
    expect(submit).toEqual(
      expect.objectContaining({
        ok: true,
        result: {
          userHistoryEntryId: "history-1",
          turn: { status: "aborted", stopReason: "aborted" },
        },
      }),
    );

    const list = harness.lines.find((line) => line.type === "response" && line.id === "list");
    expect(list.result).toEqual({
      sessions: [{ sessionId: "session-1", lifecycle: "idle" }],
    });

    const attach = harness.lines.find((line) => line.type === "response" && line.id === "attach");
    expect(attach.result).toEqual(
      expect.objectContaining({
        snapshot: expect.objectContaining({
          sessionId: "session-1",
          lifecycle: "idle",
        }),
        pendingUserMessages: { revision: 1, messages: [] },
      }),
    );

    const attachMissing = harness.lines.find(
      (line) => line.type === "response" && line.id === "attach-missing",
    );
    expect(attachMissing).toEqual(
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({
          code: SESSION_PROTOCOL_ERROR_CODES.notFound,
          message: "session not found",
          data: { sessionId: "missing-session" },
        }),
      }),
    );

    const snapshot = harness.lines.find(
      (line) => line.type === "response" && line.id === "snapshot",
    );
    expect(snapshot.result).toEqual(
      expect.objectContaining({
        sessionId: "session-1",
        lifecycle: "idle",
      }),
    );

    const unknown1 = harness.lines.find(
      (line) => line.type === "response" && line.id === "unknown-1",
    );
    expect(unknown1).toEqual(
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({
          code: SESSION_PROTOCOL_ERROR_CODES.methodNotFound,
        }),
      }),
    );

    const unknown2 = harness.lines.find(
      (line) => line.type === "response" && line.id === "unknown-2",
    );
    expect(unknown2).toEqual(
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({
          code: SESSION_PROTOCOL_ERROR_CODES.methodNotFound,
        }),
      }),
    );

    const malformed = harness.lines.find(
      (line) =>
        line.type === "response" && line.error?.code === SESSION_PROTOCOL_ERROR_CODES.parseError,
    );
    expect(malformed).toEqual(
      expect.objectContaining({
        ok: false,
      }),
    );

    const afterSnapshot = harness.lines.find(
      (line) => line.type === "response" && line.id === "after",
    );
    expect(afterSnapshot).toEqual(
      expect.objectContaining({
        ok: true,
        result: expect.objectContaining({ sessionId: "session-1" }),
      }),
    );
  });

  it("commits the submit snapshot before responding", async () => {
    let snapshotStarted = false;
    let releaseSnapshot;
    const snapshotBlocker = () =>
      new Promise((resolve) => {
        snapshotStarted = true;
        releaseSnapshot = resolve;
      });
    const harness = createHarness({
      snapshotDelays: [snapshotBlocker],
      runTurn: async () => ({ status: "completed", stopReason: "stop" }),
    });

    const submitPromise = harness.server.handleLine(
      request("submit", "session.submit", {
        sessionId: "session-1",
        text: "commit me",
      }),
    );

    await waitFor(() => snapshotStarted);
    expect(harness.lines.some((line) => line.type === "response" && line.id === "submit")).toBe(
      false,
    );

    releaseSnapshot();
    await submitPromise;

    const submit = harness.lines.find((line) => line.type === "response" && line.id === "submit");
    expect(submit).toEqual(
      expect.objectContaining({
        ok: true,
        result: {
          userHistoryEntryId: "history-1",
          turn: { status: "completed", stopReason: "stop" },
        },
      }),
    );
  });

  it("queues user messages behind an active turn without requesting a turn-boundary stop", async () => {
    const harness = createHarness();

    const firstSubmit = harness.server.handleLine(
      request("submit-1", "session.submit", {
        sessionId: "session-1",
        text: "first turn",
      }),
    );

    await waitFor(() => harness.lines.some((line) => deltaHasNotice(line, "streaming")));
    await harness.server.handleLine(
      request("queue-1", "session.queue", {
        sessionId: "session-1",
        text: "second turn",
      }),
    );

    expect(harness.seededSession.requestTurnBoundaryStop).not.toHaveBeenCalled();
    expect(harness.lines.some((line) => line.type === "response" && line.id === "queue-1")).toBe(
      false,
    );

    harness.releaseTurn();
    await firstSubmit;
    await waitFor(() =>
      harness.seededSession.session.historyEntries.some((entry) =>
        entry.message.content[0].text.includes("second turn"),
      ),
    );

    const queuedEntry = harness.seededSession.session.historyEntries.find((entry) =>
      entry.message.content[0].text.includes("second turn"),
    );
    harness.releaseTurn();
    await waitFor(() =>
      harness.lines.some((line) => line.type === "response" && line.id === "queue-1"),
    );

    const queueResponse = harness.lines.find(
      (line) => line.type === "response" && line.id === "queue-1",
    );
    expect(queueResponse).toEqual(
      expect.objectContaining({
        ok: true,
        result: {
          userHistoryEntryId: queuedEntry.id,
          turn: { status: "completed", stopReason: "stop" },
        },
      }),
    );
  });

  it("runs concurrent execs alongside main-session work", async () => {
    const releaseExecutions = new Map();
    const harness = createHarness({
      exec: ({ command }) =>
        new Promise((resolve) => {
          releaseExecutions.set(command, () => resolve(createProtocolExecResult({ command })));
        }),
    });
    const submit = harness.server.handleLine(
      request("submit", "session.submit", {
        sessionId: "session-1",
        text: "keep the turn active",
      }),
    );
    await waitFor(() => harness.lines.some((line) => deltaHasNotice(line, "streaming")));

    const executions = ["first", "second"].map((command) =>
      harness.server.handleLine(
        request(`exec-${command}`, "session.exec", {
          sessionId: "session-1",
          execId: `exec-${command}`,
          command,
        }),
      ),
    );
    await waitFor(() => releaseExecutions.size === 2);
    await harness.server.handleLine(
      request("reasoning", "session.setReasoning", {
        sessionId: "session-1",
        reasoning: "high",
      }),
    );

    expect(harness.seededSession.isTurnRunning).toBe(true);
    expect(harness.lines.find((line) => line.id === "reasoning")).toEqual(
      expect.objectContaining({ ok: true }),
    );
    for (const release of releaseExecutions.values()) {
      release();
    }
    await Promise.all(executions);
    expect(harness.seededSession.isTurnRunning).toBe(true);
    expect(harness.lines.filter((line) => line.id?.startsWith("exec-") && line.ok)).toHaveLength(2);

    harness.releaseTurn();
    await submit;
  });

  it("responds when a queued user message cannot be committed after the active turn", async () => {
    let recordCount = 0;
    const harness = createHarness({
      record: async (recordOptions, defaultRecord) => {
        recordCount += 1;
        if (recordCount > 1) {
          throw new Error("queued commit failed");
        }
        return await defaultRecord(recordOptions);
      },
    });

    const firstSubmit = harness.server.handleLine(
      request("submit-1", "session.submit", {
        sessionId: "session-1",
        text: "first turn",
      }),
    );

    await waitFor(() => harness.lines.some((line) => deltaHasNotice(line, "streaming")));
    await harness.server.handleLine(
      request("queue-1", "session.queue", {
        sessionId: "session-1",
        text: "second turn",
      }),
    );

    harness.releaseTurn();
    await firstSubmit;
    await waitFor(() =>
      harness.lines.some((line) => line.type === "response" && line.id === "queue-1"),
    );

    const queueResponse = harness.lines.find(
      (line) => line.type === "response" && line.id === "queue-1",
    );
    expect(queueResponse).toEqual(
      expect.objectContaining({
        ok: false,
        error: expect.objectContaining({
          code: SESSION_PROTOCOL_ERROR_CODES.internalError,
          message: "failed to drain pending user message",
          data: { cause: "queued commit failed" },
        }),
      }),
    );
  });

  it("fails remaining queued messages after one cannot be committed", async () => {
    let recordCount = 0;
    const harness = createHarness({
      record: async (recordOptions, defaultRecord) => {
        recordCount += 1;
        if (recordCount === 2) {
          throw new Error("first queued commit failed");
        }
        return await defaultRecord(recordOptions);
      },
    });

    const firstSubmit = harness.server.handleLine(
      request("submit-1", "session.submit", {
        sessionId: "session-1",
        text: "first turn",
      }),
    );
    await waitFor(() => harness.lines.some((line) => deltaHasNotice(line, "streaming")));
    await Promise.all([
      harness.server.handleLine(
        request("queue-1", "session.queue", {
          sessionId: "session-1",
          text: "first queued turn",
        }),
      ),
      harness.server.handleLine(
        request("queue-2", "session.queue", {
          sessionId: "session-1",
          text: "second queued turn",
        }),
      ),
    ]);

    harness.releaseTurn();
    await firstSubmit;
    await waitFor(() =>
      ["queue-1", "queue-2"].every((id) => harness.lines.some((line) => line.id === id)),
    );

    for (const id of ["queue-1", "queue-2"]) {
      expect(harness.lines.find((line) => line.id === id)).toMatchObject({
        ok: false,
        error: {
          code: SESSION_PROTOCOL_ERROR_CODES.internalError,
          message: "failed to drain pending user message",
          data: { cause: "first queued commit failed" },
        },
      });
    }
    expect(recordCount).toBe(2);
    expect(
      harness.seededSession.session.historyEntries.some(
        (entry) => entry.message.content[0].text === "second queued turn",
      ),
    ).toBe(false);
    expect(
      harness.lines.findLast((line) => line.type === "session.pendingUserMessages").state.messages,
    ).toEqual([]);
  });

  it("runRpcServer processes lines concurrently and emits ndjson responses", async () => {
    const harness = createHarness();
    const input = new PassThrough();
    const output = new PassThrough();

    let outputText = "";
    output.setEncoding("utf8");
    output.on("data", (chunk) => {
      outputText += chunk;
    });

    const runPromise = runRpcServer({
      host: harness.host,
      input,
      output,
    });

    input.write(
      `${request("submit-loop", "session.submit", { sessionId: "session-1", text: "hello" })}\n`,
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    input.write(`${request("interrupt-loop", "session.interrupt", { sessionId: "session-1" })}\n`);
    input.end();

    await runPromise;

    const lines = parseNdjson(outputText);
    const interrupt = lines.find(
      (line) => line.type === "response" && line.id === "interrupt-loop",
    );
    expect(interrupt).toEqual(
      expect.objectContaining({
        ok: true,
        result: {
          interrupted: true,
          isTurnRunning: true,
        },
      }),
    );

    const submit = lines.find((line) => line.type === "response" && line.id === "submit-loop");
    expect(submit).toEqual(
      expect.objectContaining({
        ok: true,
        result: expect.objectContaining({
          turn: { status: "aborted", stopReason: "aborted" },
        }),
      }),
    );

    const submitEvent = lines.find((line) => line.type === "session.delta");
    expect(submitEvent).toBeDefined();
    await expect(harness.host.observeSession("session-1")).resolves.toBeUndefined();
  });
});
