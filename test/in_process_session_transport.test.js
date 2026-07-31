import { describe, expect, it, vi } from "vitest";
import { SESSION_PROTOCOL_VERSION } from "../dist/protocol/session_protocol.js";
import {
  createTauSdkClientFromTransport,
  TauSessionProtocolResponseError,
} from "../dist/sdk/index.js";
import { InProcessSessionProtocolTransport } from "../dist/transport/in_process_session_transport.js";
import {
  createProtocolBootstrap,
  createProtocolExecResult,
  createProtocolSnapshot,
} from "./helpers/session_protocol_fixtures.js";

const bootstrap = createProtocolBootstrap();

const localCreateInput = { executionEnvironment: { kind: "local", cwd: "/repo" } };

function createNoticeDelta(sessionId, revision, text) {
  return {
    version: SESSION_PROTOCOL_VERSION,
    type: "session.delta",
    sessionId,
    fromRevision: revision,
    toRevision: revision + 1,
    reason: "notice",
    delta: {
      type: "snapshot.patch",
      changes: [
        {
          type: "timeline.append",
          item: {
            type: "notice",
            id: `notice-${revision}`,
            notice: { severity: "info", text, timestamp: revision },
          },
        },
      ],
    },
  };
}

function createHostedSession(sessionId, sessions, options = {}) {
  const deltaHandlers = new Set();
  const historyEntries = [];
  let nextHistoryEntryId = 1;
  let running = false;
  let releaseTurn;
  let pendingTurnResult = { status: "completed", stopReason: "stop" };
  const pendingSteering = [];

  const hostedSession = {
    get isTurnRunning() {
      return running;
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
    session: {
      addUserText(text, options) {
        const id = options?.historyEntryId ?? `history-${nextHistoryEntryId++}`;
        historyEntries.push({
          id,
          message: {
            role: "user",
            content: [{ type: "text", text }],
          },
        });
        return id;
      },
      reset() {},
      get historyEntries() {
        return historyEntries;
      },
      get sessionId() {
        return sessionId;
      },
    },
    async record(options) {
      const userHistoryEntryId = hostedSession.session.addUserText(
        options.text,
        options.historyEntryId ? { historyEntryId: options.historyEntryId } : undefined,
      );
      return {
        snapshot: await hostedSession.snapshot(),
        userHistoryEntryId,
      };
    },
    async runTurn() {
      running = true;
      let result = { status: "completed", stopReason: "stop" };
      try {
        for (const handler of deltaHandlers) {
          handler(createNoticeDelta(sessionId, historyEntries.length + 1, `running ${sessionId}`));
        }
        if (options.holdTurns) {
          await new Promise((resolve) => {
            releaseTurn = resolve;
          });
        }
        if (pendingTurnResult.status !== "aborted" && pendingSteering.length > 0) {
          const steering = pendingSteering.splice(0);
          const historyEntryId = hostedSession.session.addUserText(
            steering.map((item) => item.text).join("\n"),
          );
          const result = {
            userHistoryEntryId: historyEntryId,
            turn: { status: "completed", stopReason: "stop" },
          };
          for (const item of steering) item.resolve(result);
        }
        result = pendingTurnResult;
        return result;
      } finally {
        running = false;
        releaseTurn = undefined;
        pendingTurnResult = { status: "completed", stopReason: "stop" };
      }
    },
    requestTurnBoundaryStop: vi.fn(() => running),
    cancelTurnBoundaryStop: vi.fn(() => running),
    steer(text) {
      return new Promise((resolve, reject) => {
        pendingSteering.push({ text, resolve, reject });
      });
    },
    cancelSteering() {
      const cancelled = pendingSteering.splice(0);
      for (const item of cancelled) item.reject(new Error("steering submission was cancelled"));
      return cancelled.map((item) => item.text);
    },
    interruptTurn: vi.fn(() => {
      if (!running || !releaseTurn) {
        return false;
      }

      pendingTurnResult = { status: "aborted", stopReason: "aborted" };
      releaseTurn();
      return true;
    }),
    interruptActiveWork: vi.fn(() => hostedSession.interruptTurn()),
    async waitForActiveWork() {},
    async exec() {
      return createProtocolExecResult({
        output: "/repo\n",
      });
    },
    async createEphemeralContext() {
      return { contextId: "ephemeral-1" };
    },
    async submitEphemeralThread() {
      if (options.ephemeralSubmitError) {
        throw options.ephemeralSubmitError;
      }
      return { threadId: "thread-1", response: "ephemeral response" };
    },
    async closeEphemeralContext() {
      return { closed: true };
    },
    async snapshot() {
      return createProtocolSnapshot({
        sessionId,
        revision: historyEntries.length + 1,
        lifecycle: running ? "running" : "idle",
        historyEntries: historyEntries.map((entry) => ({
          id: entry.id,
          message: entry.message,
        })),
      });
    },
    dispose() {
      sessions.delete(sessionId);
    },
  };

  sessions.set(sessionId, hostedSession);
  return hostedSession;
}

function createHost() {
  const sessions = new Map();
  let nextSessionId = 1;
  const createSession = (sessionOptions) =>
    createHostedSession(`session-${nextSessionId++}`, sessions, sessionOptions);

  return {
    createSession,
    sessions,
    host: {
      async createSession() {
        return createSession();
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
        sessions.clear();
      },
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

describe("InProcessSessionProtocolTransport", () => {
  it("drives the sdk session facade directly against a session host", async () => {
    const { host, sessions } = createHost();
    const transport = new InProcessSessionProtocolTransport({ host });
    const client = await createTauSdkClientFromTransport(transport);
    const session = await client.sessions.create(localCreateInput);
    const deltas = [];
    const unsubscribe = session.onDelta((delta) => deltas.push(delta));

    await expect(session.submit("hello")).resolves.toEqual({
      userHistoryEntryId: "history-1",
      turn: { status: "completed", stopReason: "stop" },
    });

    expect(deltas).toEqual([createNoticeDelta("session-1", 2, "running session-1")]);

    await expect(session.snapshot()).resolves.toEqual(
      createProtocolSnapshot({
        sessionId: "session-1",
        revision: 2,
        historyEntries: [
          {
            id: "history-1",
            message: { role: "user", content: [{ type: "text", text: "hello" }] },
          },
        ],
      }),
    );

    await expect(session.retry()).resolves.toEqual({
      turn: { status: "completed", stopReason: "stop" },
    });

    await expect(session.exec("pwd")).resolves.toEqual(
      createProtocolExecResult({ output: "/repo\n" }),
    );

    await expect(session.snapshot()).resolves.toEqual(
      createProtocolSnapshot({
        sessionId: "session-1",
        revision: 2,
        historyEntries: [
          {
            id: "history-1",
            message: { role: "user", content: [{ type: "text", text: "hello" }] },
          },
        ],
      }),
    );

    unsubscribe();
    await client.close();
    expect(sessions.size).toBe(1);

    const reconnectedTransport = new InProcessSessionProtocolTransport({ host });
    const reconnectedClient = await createTauSdkClientFromTransport(reconnectedTransport);
    const reconnectedSession = await reconnectedClient.sessions.observe("session-1");
    await expect(reconnectedSession.snapshot()).resolves.toEqual(
      createProtocolSnapshot({
        sessionId: "session-1",
        revision: 2,
        historyEntries: [
          {
            id: "history-1",
            message: { role: "user", content: [{ type: "text", text: "hello" }] },
          },
        ],
      }),
    );

    await reconnectedSession.unobserve();
    await reconnectedClient.close();
    expect(sessions.size).toBe(1);
  });

  it("shares pending state and cancels pending messages through the sdk", async () => {
    const { host, createSession } = createHost();
    const hostedSession = createSession({ holdTurns: true });
    const transport = new InProcessSessionProtocolTransport({ host });
    const client = await createTauSdkClientFromTransport(transport);
    const session = await client.sessions.observe(hostedSession.sessionId);
    const submit = session.submit("start");
    await waitFor(() => hostedSession.isTurnRunning);

    const queued = session.queue("run tests");
    const steered = session.steer("change direction");
    await waitFor(() => session.pendingUserMessages().messages.length === 2);
    expect(session.pendingUserMessages().messages).toEqual([
      expect.objectContaining({ mode: "steer", text: "change direction" }),
      expect.objectContaining({ mode: "queue", text: "run tests" }),
    ]);

    await expect(session.cancelPendingMessages()).resolves.toEqual({
      cancelled: [
        expect.objectContaining({ mode: "steer", text: "change direction" }),
        expect.objectContaining({ mode: "queue", text: "run tests" }),
      ],
    });
    await expect(queued).rejects.toMatchObject({ code: "cancelled" });
    await expect(steered).rejects.toMatchObject({ code: "cancelled" });
    expect(session.pendingUserMessages().messages).toEqual([]);

    hostedSession.interruptTurn();
    await submit;
    await client.close();
  });

  it("keeps transport event delivery isolated from listener failures", async () => {
    const { host } = createHost();
    const transport = new InProcessSessionProtocolTransport({ host });
    const client = await createTauSdkClientFromTransport(transport);
    const session = await client.sessions.create(localCreateInput);
    const deltas = [];
    session.onDelta(() => {
      throw new Error("listener failed");
    });
    session.onDelta((delta) => deltas.push(delta));

    await expect(session.submit("hello")).resolves.toEqual({
      userHistoryEntryId: "history-1",
      turn: { status: "completed", stopReason: "stop" },
    });

    expect(deltas).toHaveLength(1);
    await client.close();
  });

  it("detaches without interrupting an active hosted turn", async () => {
    const { createSession, host, sessions } = createHost();
    const heldSession = createSession({ holdTurns: true });
    const transport = new InProcessSessionProtocolTransport({ host });
    const client = await createTauSdkClientFromTransport(transport);
    const session = await client.sessions.observe(heldSession.sessionId);

    const submit = session.submit("long turn");
    const submitClosed = expect(submit).rejects.toBeInstanceOf(Error);
    await waitFor(() => heldSession.isTurnRunning);

    await client.close();
    await submitClosed;
    expect(heldSession.isTurnRunning).toBe(true);
    expect(heldSession.interruptTurn).not.toHaveBeenCalled();
    expect(sessions.size).toBe(1);

    const reconnectedTransport = new InProcessSessionProtocolTransport({ host });
    const reconnectedClient = await createTauSdkClientFromTransport(reconnectedTransport);
    const reconnectedSession = await reconnectedClient.sessions.observe("session-1");

    await expect(reconnectedSession.snapshot()).resolves.toEqual(
      createProtocolSnapshot({
        sessionId: "session-1",
        revision: 2,
        lifecycle: "running",
        historyEntries: [
          {
            id: "history-1",
            message: { role: "user", content: [{ type: "text", text: "long turn" }] },
          },
        ],
      }),
    );
    await expect(reconnectedSession.interrupt()).resolves.toEqual({
      interrupted: true,
      isTurnRunning: true,
    });
    await waitFor(() => !heldSession.isTurnRunning);

    await reconnectedSession.unobserve();
    await reconnectedClient.close();
    expect(sessions.size).toBe(1);
  });

  it("returns ephemeral submit failures without handler-level wrapping", async () => {
    const { createSession, host } = createHost();
    const hostedSession = createSession({
      ephemeralSubmitError: new Error("model provider rejected the request"),
    });
    const transport = new InProcessSessionProtocolTransport({ host });
    const client = await createTauSdkClientFromTransport(transport);
    const session = await client.sessions.observe(hostedSession.sessionId);

    await expect(
      session.submitEphemeralThread({
        contextId: "ephemeral-1",
        threadId: "thread-1",
        message: "review this",
      }),
    ).rejects.toMatchObject({
      code: "internal_error",
      message: "model provider rejected the request",
    });

    await client.close();
  });

  it("can shut down an owned host on close", async () => {
    const { host, sessions } = createHost();
    const transport = new InProcessSessionProtocolTransport({ host, closeMode: "shutdown-host" });
    const client = await createTauSdkClientFromTransport(transport);

    await client.sessions.create(localCreateInput);
    expect(sessions.size).toBe(1);

    await client.close();
    expect(sessions.size).toBe(0);
  });

  it("rejects protocol errors from the in-process host", async () => {
    const { host } = createHost();
    const transport = new InProcessSessionProtocolTransport({ host });
    const client = await createTauSdkClientFromTransport(transport);

    await expect(client.sessions.observe("missing")).rejects.toBeInstanceOf(
      TauSessionProtocolResponseError,
    );

    await client.close();
  });

  it("validates request params before dispatching directly to the host", async () => {
    const { host } = createHost();
    const transport = new InProcessSessionProtocolTransport({ host });
    const client = await createTauSdkClientFromTransport(transport);
    const session = await client.sessions.create(localCreateInput);

    await expect(session.submit("hello", { historyEntryId: "" })).rejects.toMatchObject({
      code: "invalid_params",
      message: "session.submit params.historyEntryId must be a non-empty string when provided",
    });

    await client.close();
  });
});
