import { EventEmitter } from "node:events";
import { createServer } from "node:http";
import { describe, expect, it, vi } from "vitest";
import {
  runWebSocketSessionServer,
  WebSocketSessionServer,
} from "../dist/core/modes/websocket_server.js";
import { SESSION_PROTOCOL_VERSION } from "../dist/protocol/session_protocol.js";
import { createTauSdkClientFromTransport } from "../dist/sdk/index.js";
import { WebSocketSessionProtocolTransport } from "../dist/transport/websocket_session_transport.js";
import {
  createProtocolBootstrap,
  createProtocolExecResult,
  createProtocolSnapshot,
} from "./helpers/session_protocol_fixtures.js";

const bootstrap = createProtocolBootstrap();

const localCreateInput = {
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

  const hostedSession = {
    get isTurnRunning() {
      return running;
    },
    get canAcceptSteering() {
      return running;
    },
    getGoal() {
      return null;
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
      try {
        for (const handler of deltaHandlers) {
          handler(createNoticeDelta(sessionId, historyEntries.length + 1, `running ${sessionId}`));
        }
        if (options.holdTurns) {
          await new Promise((resolve) => {
            releaseTurn = resolve;
          });
        }
        return pendingTurnResult;
      } finally {
        running = false;
        releaseTurn = undefined;
        pendingTurnResult = { status: "completed", stopReason: "stop" };
      }
    },
    async retryTurn() {
      return await hostedSession.runTurn();
    },
    requestTurnBoundaryStop: vi.fn(() => running),
    cancelTurnBoundaryStop: vi.fn(() => running),
    cancelSteering: () => [],
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
    async snapshot() {
      return createProtocolSnapshot({
        sessionId,
        revision: historyEntries.length + 1,
        lifecycle: running ? "running" : "idle",
        bootstrap,
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

function createHost(options = {}) {
  const sessions = new Map();
  let nextSessionId = 1;
  const createSession = () =>
    createHostedSession(`session-${nextSessionId++}`, sessions, options.sessionOptions);

  return {
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

async function withServer(options, run) {
  const { host } = createHost({ sessionOptions: options?.sessionOptions });
  const abortController = new AbortController();
  let serverPromise;
  const listening = new Promise((resolve) => {
    serverPromise = runWebSocketSessionServer({
      host,
      hostname: "127.0.0.1",
      port: 0,
      authToken: options?.authToken,
      signal: abortController.signal,
      onListening: resolve,
    });
  });
  const address = await listening;

  try {
    return await run(`ws://${address.hostname}:${address.port}`);
  } finally {
    abortController.abort();
    await serverPromise;
  }
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

function createConnectingSocket() {
  const listeners = new Map();
  const socket = {
    readyState: 0,
    closeCalls: [],
    send: vi.fn(),
    close: vi.fn((code, reason) => {
      socket.closeCalls.push([code, reason]);
      socket.readyState = 2;
      listeners.get("close")?.({ type: "close" });
    }),
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
    removeEventListener(type, listener) {
      if (listeners.get(type) === listener) {
        listeners.delete(type);
      }
    },
  };
  return socket;
}

function createControllableSocket() {
  const listeners = new Map();
  const socket = {
    readyState: 0,
    sent: [],
    send: vi.fn((payload) => {
      socket.sent.push(JSON.parse(payload));
      const request = socket.sent.at(-1);
      if (request.method === "initialize") {
        socket.emitMessage({
          version: SESSION_PROTOCOL_VERSION,
          type: "response",
          id: request.id,
          ok: true,
          result: {
            protocolVersion: SESSION_PROTOCOL_VERSION,
            methods: ["initialize"],
            alreadyInitialized: false,
          },
        });
      }
    }),
    close: vi.fn((code, reason) => {
      void code;
      void reason;
      socket.readyState = 3;
      listeners.get("close")?.({ type: "close" });
    }),
    addEventListener(type, listener) {
      listeners.set(type, listener);
    },
    removeEventListener(type, listener) {
      if (listeners.get(type) === listener) {
        listeners.delete(type);
      }
    },
    emitOpen() {
      socket.readyState = 1;
      listeners.get("open")?.({ type: "open" });
    },
    emitMessage(message) {
      listeners.get("message")?.({ data: JSON.stringify(message) });
    },
  };
  return socket;
}

class FakeServerSocket extends EventEmitter {
  OPEN = 1;
  CLOSED = 3;
  readyState = this.OPEN;
  send = vi.fn();
  close = vi.fn((code, reason) => {
    void code;
    void reason;
    this.readyState = this.CLOSED;
    this.emit("close");
  });
  terminate = vi.fn(() => {
    this.readyState = this.CLOSED;
    this.emit("close");
  });
}

describe("WebSocketSessionProtocolTransport", () => {
  it("drives the sdk session facade over websocket", async () => {
    await withServer(undefined, async (url) => {
      const transport = new WebSocketSessionProtocolTransport({ url });
      const client = await createTauSdkClientFromTransport(transport);
      const session = await client.sessions.create(localCreateInput);
      const deltas = [];
      const unsubscribe = session.onDelta((delta) => deltas.push(delta));

      await expect(session.submit("hello")).resolves.toEqual({
        userHistoryEntryId: "history-1",
        turn: { status: "completed", stopReason: "stop" },
      });
      await expect(session.exec("pwd")).resolves.toEqual(
        createProtocolExecResult({ output: "/repo\n" }),
      );

      expect(deltas).toEqual([createNoticeDelta("session-1", 2, "running session-1")]);

      unsubscribe();
      await client.close();
    });
  });

  it("delivers pending user messages over websocket", async () => {
    await withServer({ sessionOptions: { holdTurns: true } }, async (url) => {
      const transport = new WebSocketSessionProtocolTransport({ url });
      const client = await createTauSdkClientFromTransport(transport);
      const session = await client.sessions.create(localCreateInput);
      const submit = session.submit("start");

      await waitFor(() => session.pendingUserMessages().revision === 1);
      const queued = expect(session.queue("run tests")).rejects.toMatchObject({
        code: "cancelled",
      });
      await waitFor(() => session.pendingUserMessages().messages.length === 1);

      expect(session.pendingUserMessages().messages).toEqual([
        expect.objectContaining({ mode: "queue", text: "run tests" }),
      ]);
      await expect(session.cancelPendingMessages()).resolves.toEqual({
        cancelled: [expect.objectContaining({ mode: "queue", text: "run tests" })],
      });
      await queued;

      await session.interrupt();
      await submit;
      await client.close();
    });
  });

  it("requires the configured websocket auth token", async () => {
    await withServer({ authToken: "secret" }, async (url) => {
      const transport = new WebSocketSessionProtocolTransport({ url, authToken: "wrong" });

      await expect(
        createTauSdkClientFromTransport(transport, { connectTimeoutMs: 200 }),
      ).rejects.toThrow("tau websocket closed unexpectedly");
    });
  });

  it("closes a connecting websocket when transport close races connect", async () => {
    const socket = createConnectingSocket();
    const transport = new WebSocketSessionProtocolTransport({
      url: "ws://localhost:1",
      webSocketFactory: () => socket,
    });

    const connect = transport
      .connect({ client: { name: "test", version: "1" } }, 10_000)
      .catch((error) => error);
    await Promise.resolve();

    await transport.close();

    await expect(connect).resolves.toMatchObject({
      message: "tau websocket transport was closed",
    });
    expect(socket.close).toHaveBeenCalledWith(1000, "client closed");
  });

  it("notifies failure listeners when the websocket closes unexpectedly", async () => {
    const socket = createControllableSocket();
    const transport = new WebSocketSessionProtocolTransport({
      url: "ws://localhost:1",
      webSocketFactory: () => socket,
    });
    const onFailure = vi.fn();
    transport.onFailure(onFailure);

    const connect = transport.connect({ client: { name: "test", version: "1" } }, 500);
    socket.emitOpen();
    socket.emitMessage({
      version: SESSION_PROTOCOL_VERSION,
      type: "ready",
      methods: ["initialize"],
    });
    await connect;

    socket.close();

    expect(onFailure).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "TauTransportError",
        message: "tau websocket closed unexpectedly",
      }),
    );
    await transport.close();
  });

  it("treats websocket send failures as terminal transport failures", async () => {
    const socket = createControllableSocket();
    const transport = new WebSocketSessionProtocolTransport({
      url: "ws://localhost:1",
      webSocketFactory: () => socket,
    });
    const onFailure = vi.fn();
    transport.onFailure(onFailure);

    const connect = transport.connect({ client: { name: "test", version: "1" } }, 500);
    socket.emitOpen();
    socket.emitMessage({
      version: SESSION_PROTOCOL_VERSION,
      type: "ready",
      methods: ["initialize"],
    });
    await connect;
    socket.send.mockImplementation(() => {
      throw new Error("socket write failed");
    });

    await expect(transport.request("session.list", {})).rejects.toMatchObject({
      name: "TauTransportError",
      message: "failed to write request to tau websocket",
    });
    expect(onFailure).toHaveBeenCalledTimes(1);
    await expect(transport.request("session.list", {})).rejects.toMatchObject({
      message: "failed to write request to tau websocket",
    });
    await transport.close();
  });

  it("fails websocket transport on responses for unknown request ids", async () => {
    const socket = createControllableSocket();
    const transport = new WebSocketSessionProtocolTransport({
      url: "ws://localhost:1",
      webSocketFactory: () => socket,
    });

    const connect = transport.connect({ client: { name: "test", version: "1" } }, 500);
    socket.emitOpen();
    socket.emitMessage({
      version: SESSION_PROTOCOL_VERSION,
      type: "ready",
      methods: ["initialize"],
    });
    await connect;

    socket.emitMessage({
      version: SESSION_PROTOCOL_VERSION,
      type: "response",
      id: "unknown-request",
      ok: true,
      result: { sessions: [] },
    });
    await Promise.resolve();

    await expect(transport.request("session.list", {})).rejects.toMatchObject({
      name: "TauTransportError",
      message: "received response for unknown session protocol request 'unknown-request'",
    });

    await transport.close();
  });

  it("fails websocket transport on error responses for unknown request ids", async () => {
    const socket = createControllableSocket();
    const transport = new WebSocketSessionProtocolTransport({
      url: "ws://localhost:1",
      webSocketFactory: () => socket,
    });

    const connect = transport.connect({ client: { name: "test", version: "1" } }, 500);
    socket.emitOpen();
    socket.emitMessage({
      version: SESSION_PROTOCOL_VERSION,
      type: "ready",
      methods: ["initialize"],
    });
    await connect;

    socket.emitMessage({
      version: SESSION_PROTOCOL_VERSION,
      type: "response",
      id: "unknown-request",
      ok: false,
      error: {
        code: "internal_error",
        message: "late failure",
      },
    });
    await Promise.resolve();

    await expect(transport.request("session.list", {})).rejects.toMatchObject({
      name: "TauTransportError",
      message: "received response for unknown session protocol request 'unknown-request'",
    });

    await transport.close();
  });

  it("fails websocket transport on malformed responses for unknown request ids", async () => {
    const socket = createControllableSocket();
    const transport = new WebSocketSessionProtocolTransport({
      url: "ws://localhost:1",
      webSocketFactory: () => socket,
    });

    const connect = transport.connect({ client: { name: "test", version: "1" } }, 500);
    socket.emitOpen();
    socket.emitMessage({
      version: SESSION_PROTOCOL_VERSION,
      type: "ready",
      methods: ["initialize"],
    });
    await connect;

    socket.emitMessage({
      version: SESSION_PROTOCOL_VERSION,
      type: "response",
      id: "unknown-request",
      ok: false,
      error: {
        code: "internal_error",
      },
    });
    await Promise.resolve();

    await expect(transport.request("session.list", {})).rejects.toMatchObject({
      name: "TauTransportError",
      message: "received malformed response for unknown session protocol request 'unknown-request'",
    });

    await transport.close();
  });

  it("shuts down the host when websocket listen fails", async () => {
    const occupied = createServer();
    await new Promise((resolve) => occupied.listen(0, "127.0.0.1", resolve));
    const address = occupied.address();
    if (typeof address !== "object" || address === null) {
      throw new Error("test server did not expose a TCP address");
    }

    const { host } = createHost();
    host.shutdown = vi.fn(host.shutdown);

    try {
      await expect(
        runWebSocketSessionServer({
          host,
          hostname: "127.0.0.1",
          port: address.port,
        }),
      ).rejects.toThrow();
      expect(host.shutdown).toHaveBeenCalledTimes(1);
    } finally {
      await new Promise((resolve, reject) => {
        occupied.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve(undefined);
        });
      });
    }
  });

  it("interrupts active turns before websocket host shutdown", async () => {
    const { host, sessions } = createHost({ sessionOptions: { holdTurns: true } });
    const abortController = new AbortController();
    let serverPromise;
    const listening = new Promise((resolve) => {
      serverPromise = runWebSocketSessionServer({
        host,
        hostname: "127.0.0.1",
        port: 0,
        signal: abortController.signal,
        onListening: resolve,
      });
    });
    const address = await listening;
    const transport = new WebSocketSessionProtocolTransport({
      url: `ws://${address.hostname}:${address.port}`,
    });
    const client = await createTauSdkClientFromTransport(transport);
    const session = await client.sessions.create(localCreateInput);
    const hostedSession = sessions.get("session-1");

    const submitResult = session.submit("long websocket turn").catch((error) => error);
    await waitFor(() => hostedSession.isTurnRunning);

    abortController.abort();
    await serverPromise;

    await expect(submitResult).resolves.toBeInstanceOf(Error);
    expect(hostedSession.interruptTurn).toHaveBeenCalled();
    expect(hostedSession.isTurnRunning).toBe(false);
    expect(sessions.size).toBe(0);
  });

  it("owns websocket send failures at the server boundary", async () => {
    const { host } = createHost();
    const server = new WebSocketSessionServer({ host });
    const socket = new FakeServerSocket();
    let sendCount = 0;
    socket.send = vi.fn(() => {
      sendCount += 1;
      if (sendCount > 1) {
        throw new Error("socket write failed");
      }
    });

    server.accept(socket, undefined);
    socket.emit("message", Buffer.from("{bad json"), false);
    await Promise.resolve();
    await Promise.resolve();

    expect(socket.close).toHaveBeenCalledWith(1011, "session protocol send failed");
    await server.close();
  });
});
