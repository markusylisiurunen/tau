import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { CORE_EVENT_VERSION } from "../dist/core/events/types.js";
import { RPC_METHODS, RPC_PROTOCOL_VERSION } from "../dist/core/modes/rpc_protocol.js";
import {
  createTauSdkClient,
  TauProcessError,
  TauRpcResponseError,
  TauTransportError,
} from "../dist/sdk/index.js";

class FakeChildProcess extends EventEmitter {
  constructor() {
    super();
    this.stdin = new PassThrough();
    this.stdout = new PassThrough();
    this.stderr = new PassThrough();

    this.stdin.setEncoding("utf8");
    this.stdout.setEncoding("utf8");
    this.stderr.setEncoding("utf8");

    this._stdinBuffer = "";
    this._requests = [];
    this.killSignals = [];
    this.exitCode = null;
    this.signalCode = null;
    this.killed = false;

    this.stdin.on("data", (chunk) => {
      this._stdinBuffer += chunk.toString();
      while (true) {
        const newlineIndex = this._stdinBuffer.indexOf("\n");
        if (newlineIndex === -1) {
          break;
        }

        const line = this._stdinBuffer.slice(0, newlineIndex).trim();
        this._stdinBuffer = this._stdinBuffer.slice(newlineIndex + 1);
        if (!line) {
          continue;
        }

        const parsed = JSON.parse(line);
        this._requests.push(parsed);
        this.emit("request", parsed);
      }
    });
  }

  get requests() {
    return [...this._requests];
  }

  send(message) {
    this.stdout.write(`${JSON.stringify(message)}\n`);
  }

  sendRaw(line) {
    this.stdout.write(`${line}\n`);
  }

  writeStderr(text) {
    this.stderr.write(text);
  }

  exit(code = 0, signal = null) {
    if (this.exitCode !== null || this.signalCode !== null) {
      return;
    }

    this.exitCode = code;
    this.signalCode = signal;
    this.emit("exit", code, signal);
    this.emit("close", code, signal);
  }

  kill(signal = "SIGTERM") {
    this.killed = true;
    this.killSignals.push(signal);
    this.exit(null, typeof signal === "string" ? signal : null);
    return true;
  }
}

function createReadyMessage(sessionId = "session-1") {
  return {
    version: RPC_PROTOCOL_VERSION,
    type: "ready",
    sessionId,
    methods: [...RPC_METHODS],
    coreEventVersion: CORE_EVENT_VERSION,
  };
}

function createSuccessResponse(id, result) {
  return {
    version: RPC_PROTOCOL_VERSION,
    type: "response",
    id,
    ok: true,
    result,
  };
}

function createErrorResponse(id, error) {
  return {
    version: RPC_PROTOCOL_VERSION,
    type: "response",
    id,
    ok: false,
    error,
  };
}

function waitForRequest(child, predicate) {
  for (const request of child.requests) {
    if (!predicate || predicate(request)) {
      return Promise.resolve(request);
    }
  }

  return new Promise((resolve) => {
    const onRequest = (request) => {
      if (predicate && !predicate(request)) {
        return;
      }
      child.off("request", onRequest);
      resolve(request);
    };
    child.on("request", onRequest);
  });
}

async function createConnectedClient(child, options = {}) {
  child.on("request", (request) => {
    if (request.method === "initialize") {
      child.send(
        createSuccessResponse(request.id, {
          protocolVersion: RPC_PROTOCOL_VERSION,
          sessionId: "session-1",
          methods: [...RPC_METHODS],
          alreadyInitialized: false,
        }),
      );
    }
  });

  const spawn = vi.fn(() => child);
  const clientPromise = createTauSdkClient({
    spawn,
    scriptPath: "/fake/main.js",
    connectTimeoutMs: 500,
    ...options,
  });

  child.send(createReadyMessage("session-1"));
  const client = await clientPromise;

  return { client, spawn };
}

describe("sdk_client", () => {
  it("spawns rpc process, correlates responses by request id, and streams events", async () => {
    const child = new FakeChildProcess();
    const submitRequests = [];

    child.on("request", (request) => {
      if (request.method === "initialize") {
        child.send(
          createSuccessResponse(request.id, {
            protocolVersion: RPC_PROTOCOL_VERSION,
            sessionId: "session-1",
            methods: [...RPC_METHODS],
            alreadyInitialized: false,
          }),
        );
        return;
      }

      if (request.method === "session.submit") {
        submitRequests.push(request);
        if (submitRequests.length === 2) {
          const [first, second] = submitRequests;

          child.send({
            version: RPC_PROTOCOL_VERSION,
            type: "event",
            requestId: first.id,
            event: {
              version: CORE_EVENT_VERSION,
              event: {
                type: "notice",
                severity: "info",
                text: "first-event",
              },
            },
          });

          child.send({
            version: RPC_PROTOCOL_VERSION,
            type: "event",
            event: {
              version: CORE_EVENT_VERSION,
              event: {
                type: "notice",
                severity: "info",
                text: "global-event",
              },
            },
          });

          child.send(
            createSuccessResponse(second.id, {
              userHistoryEntryId: "history-2",
              turn: { aborted: true },
            }),
          );
          child.send(
            createSuccessResponse(first.id, {
              userHistoryEntryId: "history-1",
              turn: { aborted: false },
            }),
          );
        }
      }
    });

    const spawn = vi.fn(() => child);
    const clientPromise = createTauSdkClient({
      spawn,
      persona: "gpt-5.2-coder",
      riskLevel: "read-only",
      noAgentContextFiles: true,
      connectTimeoutMs: 500,
    });

    child.send(createReadyMessage("session-1"));
    const client = await clientPromise;

    expect(spawn).toHaveBeenCalledTimes(1);
    const [command, args] = spawn.mock.calls[0];
    expect(command).toBe(process.execPath);
    expect(args).toContain("rpc");
    expect(args).toContain("--persona");
    expect(args).toContain("gpt-5.2-coder");
    expect(args).toContain("--risk");
    expect(args).toContain("read-only");
    expect(args).toContain("--no-agent-context-files");

    const events = [];
    client.onEvent((event) => {
      events.push(event);
    });

    const firstSubmit = client.submit("first turn");
    const secondSubmit = client.submit("second turn", { historyEntryId: "custom-history-id" });

    await expect(firstSubmit).resolves.toEqual({
      userHistoryEntryId: "history-1",
      turn: { aborted: false },
    });
    await expect(secondSubmit).resolves.toEqual({
      userHistoryEntryId: "history-2",
      turn: { aborted: true },
    });

    expect(events).toEqual([
      expect.objectContaining({ type: "event", requestId: expect.any(Number) }),
      expect.objectContaining({ type: "event" }),
    ]);

    await client.close();
  });

  it("throws TauRpcResponseError for rpc error responses", async () => {
    const child = new FakeChildProcess();
    const { client } = await createConnectedClient(child);

    child.on("request", (request) => {
      if (request.method === "session.submit") {
        child.send(
          createErrorResponse(request.id, {
            code: "busy",
            message: "a session turn is already running",
          }),
        );
      }
    });

    await expect(client.submit("hello")).rejects.toMatchObject({
      name: "TauRpcResponseError",
      code: "busy",
      requestId: expect.any(Number),
      message: "a session turn is already running",
    });
    await expect(client.submit("hello")).rejects.toBeInstanceOf(TauRpcResponseError);

    await client.close();
  });

  it("rejects malformed rpc responses via shared outgoing parser", async () => {
    const child = new FakeChildProcess();
    const { client } = await createConnectedClient(child);

    child.on("request", (request) => {
      if (request.method === "session.submit") {
        child.send({
          version: RPC_PROTOCOL_VERSION,
          type: "response",
          id: request.id,
          ok: false,
          error: {
            code: "busy",
          },
        });
      }

      if (request.method === "session.interrupt") {
        child.send(
          createSuccessResponse(request.id, {
            interrupted: false,
            isTurnRunning: false,
          }),
        );
      }
    });

    await expect(client.submit("hello")).rejects.toMatchObject({
      name: "TauTransportError",
      message: "received malformed rpc response",
    });

    await expect(client.interrupt()).resolves.toEqual({
      interrupted: false,
      isTurnRunning: false,
    });

    await client.close();
  });

  it("fails transport when outgoing rpc payload is malformed", async () => {
    const child = new FakeChildProcess();
    const { client } = await createConnectedClient(child);

    child.sendRaw("[]");

    await expect(client.snapshot()).rejects.toMatchObject({
      name: "TauTransportError",
      message: "received invalid rpc payload from tau process: rpc payload must be a JSON object",
    });

    await client.close();
  });

  it("rejects pending requests when rpc subprocess exits", async () => {
    const child = new FakeChildProcess();
    const { client } = await createConnectedClient(child);

    const snapshotPromise = client.snapshot();
    await waitForRequest(child, (request) => request.method === "session.snapshot");

    child.writeStderr("fatal stderr\n");
    child.exit(9, null);

    await expect(snapshotPromise).rejects.toBeInstanceOf(TauProcessError);
    await expect(snapshotPromise).rejects.toMatchObject({
      exitCode: 9,
      signal: null,
      stderr: "fatal stderr\n",
    });

    await expect(client.interrupt()).rejects.toBeInstanceOf(TauTransportError);
  });

  it("close and shutdown are idempotent", async () => {
    const child = new FakeChildProcess();
    const { client } = await createConnectedClient(child);

    let shutdownRequests = 0;
    child.on("request", (request) => {
      if (request.method === "session.shutdown") {
        shutdownRequests += 1;
        child.send(createSuccessResponse(request.id, { shutdown: true }));
      }
    });

    const firstShutdown = await client.shutdown();
    const secondShutdown = await client.shutdown();
    expect(firstShutdown).toEqual({ shutdown: true });
    expect(secondShutdown).toEqual({ shutdown: true });
    expect(shutdownRequests).toBe(1);

    await expect(client.close()).resolves.toBeUndefined();
    await expect(client.close()).resolves.toBeUndefined();
  });
});
