import { EventEmitter } from "node:events";
import { existsSync, readFileSync } from "node:fs";
import { PassThrough } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import {
  SESSION_PROTOCOL_METHODS,
  SESSION_PROTOCOL_VERSION,
} from "../dist/protocol/session_protocol.js";
import {
  createTauSdkClientFromTransport,
  getTauSdkSessionTurnOutcome,
  TauProcessError,
  TauSessionClientError,
  TauTransportError,
} from "../dist/sdk/index.js";
import { StdioSessionProtocolTransport } from "../dist/transport/stdio_session_transport.js";
import {
  createProtocolBootstrap,
  createProtocolExecResult,
  createProtocolSnapshot,
} from "./helpers/session_protocol_fixtures.js";

class FakeChildProcess extends EventEmitter {
  constructor(options = {}) {
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
    this.autoExitOnKill = options.autoExitOnKill ?? true;

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

  sendChunked(message, chunkSize = 1) {
    const line = `${JSON.stringify(message)}\n`;
    for (let index = 0; index < line.length; index += chunkSize) {
      this.stdout.write(line.slice(index, index + chunkSize));
    }
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
    if (this.autoExitOnKill) {
      this.exit(null, typeof signal === "string" ? signal : null);
    }
    return true;
  }
}

function createReadyMessage() {
  return {
    version: SESSION_PROTOCOL_VERSION,
    type: "ready",
    methods: [...SESSION_PROTOCOL_METHODS],
  };
}

const bootstrap = createProtocolBootstrap();

const localCreateInput = { executionEnvironment: { kind: "local", cwd: "/repo" } };

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
        case "session.terminateSubagent":
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
  clientToolListeners = new Set();
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

  onClientTool(listener) {
    this.clientToolListeners.add(listener);
    return () => {
      this.clientToolListeners.delete(listener);
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

  emitClientTool(message) {
    for (const listener of this.clientToolListeners) {
      listener(message);
    }
  }
}

function createSuccessResponse(id, result) {
  return {
    version: SESSION_PROTOCOL_VERSION,
    type: "response",
    id,
    ok: true,
    result,
  };
}

function createErrorResponse(id, error) {
  return {
    version: SESSION_PROTOCOL_VERSION,
    type: "response",
    id,
    ok: false,
    error,
  };
}

function createPendingUserMessagesMessage(sessionId, messages = [], revision = 1) {
  return {
    version: SESSION_PROTOCOL_VERSION,
    type: "session.pendingUserMessages",
    sessionId,
    state: { revision, messages },
  };
}

function createObserveResult(sessionId, snapshot = createSnapshot(sessionId)) {
  return {
    snapshot,
    pendingUserMessages: { revision: 1, messages: [] },
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

async function createConnectedClient(child, options = {}) {
  child.on("request", (request) => {
    if (request.method === "initialize") {
      child.send(
        createSuccessResponse(request.id, {
          protocolVersion: SESSION_PROTOCOL_VERSION,
          methods: [...SESSION_PROTOCOL_METHODS],
          alreadyInitialized: false,
        }),
      );
    }
    if (request.method === "session.observe") {
      child.send(createSuccessResponse(request.id, createObserveResult(request.params.sessionId)));
    }
  });

  const transport = new StdioSessionProtocolTransport(child);
  const clientPromise = createTauSdkClientFromTransport(transport, {
    connectTimeoutMs: 500,
    ...options,
  });

  child.send(createReadyMessage());
  const client = await clientPromise;

  return { client, transport };
}

describe("sdk_client", () => {
  it("reads a persisted turn outcome by user history entry id", () => {
    const outcome = {
      status: "failed",
      stopReason: "error",
      errorMessage: "Service Unavailable",
    };
    const snapshot = createProtocolSnapshot({
      messages: [
        {
          id: "user-1",
          state: "committed",
          modelVisible: true,
          message: { role: "user", content: "hello", timestamp: 1 },
          turn: outcome,
        },
      ],
    });

    expect(getTauSdkSessionTurnOutcome(snapshot, "user-1")).toEqual(outcome);
    expect(getTauSdkSessionTurnOutcome(snapshot, "missing")).toBeUndefined();
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
    const stdioTransportDeclaration = readFileSync(
      new URL("../dist/transport/stdio_session_transport.d.ts", import.meta.url),
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
    expect(stdioTransportDeclaration).not.toContain("../core/");
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

    await expect(readySession.terminateSubagent("subagent-1")).resolves.toEqual({ found: true });
    expect(transport.requests.at(-1)).toEqual({
      method: "session.terminateSubagent",
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
    transport.onRequest = (method) => {
      if (method === "session.observe") {
        transport.emitDelta(bufferedDelta);
      }
    };
    const bufferedSession = await client.sessions.observe("session-1");
    transport.onRequest = undefined;

    const bufferedDeltas = [];
    bufferedSession.onDelta((delta) => bufferedDeltas.push(delta));
    expect(bufferedDeltas).toEqual([bufferedDelta]);

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
      expect(context).toMatchObject({ sessionId: "session-1", callId: "call-1" });
      expect(context.signal.aborted).toBe(false);
      return { content: "picked a" };
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
        params: { sessionId: "session-1", callId: "call-1" },
      },
      {
        method: "session.clientTool.result",
        params: { sessionId: "session-1", callId: "call-1", ok: true, content: "picked a" },
      },
    ]);

    await client.close();
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

  it("initializes the stdio transport only once across repeated connect calls", async () => {
    const child = new FakeChildProcess();
    const transport = new StdioSessionProtocolTransport(child);
    const initializeParams = { client: { name: "fixture", version: "1" } };
    const connectOne = transport.connect(initializeParams, 500);
    const connectTwo = transport.connect({ client: { name: "ignored", version: "2" } }, 500);

    child.send(createReadyMessage());
    const initializeRequest = await waitForRequest(
      child,
      (request) => request.method === "initialize",
    );
    child.send(
      createSuccessResponse(initializeRequest.id, {
        protocolVersion: SESSION_PROTOCOL_VERSION,
        methods: [...SESSION_PROTOCOL_METHODS],
        alreadyInitialized: false,
      }),
    );

    await Promise.all([connectOne, connectTwo]);
    expect(child.requests.filter((request) => request.method === "initialize")).toEqual([
      expect.objectContaining({
        params: initializeParams,
      }),
    ]);

    await transport.connect({ client: { name: "ignored-later", version: "3" } }, 500);
    expect(child.requests.filter((request) => request.method === "initialize")).toHaveLength(1);

    await transport.close();
  });

  it("parses stdio protocol lines split across many small chunks", async () => {
    const child = new FakeChildProcess();
    const { client } = await createConnectedClient(child);
    const session = await client.sessions.observe("session-1");

    child.on("request", (request) => {
      if (request.method === "session.snapshot") {
        child.sendChunked(createSuccessResponse(request.id, createSnapshot("session-1")), 1);
      }
    });

    await expect(session.snapshot()).resolves.toEqual(createSnapshot("session-1"));
    await expect(session.snapshot()).resolves.toEqual(createSnapshot("session-1"));

    await client.close();
  });

  it("correlates stdio transport responses by request id and streams events", async () => {
    const child = new FakeChildProcess();
    const submitRequests = [];
    const retryRequests = [];
    const execRequests = [];
    const sampleRequests = [];
    const createdSessionId = "session-2";
    const sampledMessage = {
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
    };

    child.on("request", (request) => {
      if (request.method === "initialize") {
        child.send(
          createSuccessResponse(request.id, {
            protocolVersion: SESSION_PROTOCOL_VERSION,
            methods: [...SESSION_PROTOCOL_METHODS],
            alreadyInitialized: false,
          }),
        );
        return;
      }

      if (request.method === "session.list") {
        child.send(
          createSuccessResponse(request.id, {
            sessions: [{ sessionId: "session-1", lifecycle: "idle" }],
          }),
        );
        return;
      }

      if (request.method === "session.create") {
        child.send(createSuccessResponse(request.id, { sessionId: createdSessionId }));
        return;
      }

      if (request.method === "session.observe") {
        child.send(
          createSuccessResponse(request.id, createObserveResult(request.params.sessionId)),
        );
        return;
      }

      if (request.method === "session.submit") {
        submitRequests.push(request);
        if (submitRequests.length === 2) {
          const [first, second] = submitRequests;

          child.send(createNoticeDelta("session-1", 2, "first-delta"));
          child.send(createNoticeDelta("session-1", 3, "global-delta"));

          child.send(
            createSuccessResponse(second.id, {
              userHistoryEntryId: "history-2",
              turn: { status: "aborted", stopReason: "aborted" },
            }),
          );
          child.send(
            createSuccessResponse(first.id, {
              userHistoryEntryId: "history-1",
              turn: { status: "completed", stopReason: "stop" },
            }),
          );
        }
      }

      if (request.method === "session.retry") {
        retryRequests.push(request);
        child.send(
          createSuccessResponse(request.id, { turn: { status: "completed", stopReason: "stop" } }),
        );
      }

      if (request.method === "session.exec") {
        execRequests.push(request);
        child.send(
          createSuccessResponse(
            request.id,
            createProtocolExecResult({
              output: "/repo\n",
            }),
          ),
        );
      }

      if (request.method === "session.sample") {
        sampleRequests.push(request);
        child.send(createSuccessResponse(request.id, { message: sampledMessage }));
      }
    });

    const transport = new StdioSessionProtocolTransport(child);
    const clientPromise = createTauSdkClientFromTransport(transport, {
      persona: "gpt-5.5-coder",
      noAgentContextFiles: true,
      connectTimeoutMs: 500,
    });

    child.send(createReadyMessage());
    const client = await clientPromise;

    const initializeRequest = child.requests.find((request) => request.method === "initialize");
    expect(initializeRequest?.params).toEqual({
      client: {
        name: "tau-sdk",
        version: "1",
      },
    });

    const sessionDeltas = [];

    await expect(client.sessions.list()).resolves.toEqual([
      { sessionId: "session-1", lifecycle: "idle" },
    ]);
    const session = await client.sessions.observe("session-1");
    expect(session.id).toBe("session-1");
    session.onDelta((delta) => {
      sessionDeltas.push(delta);
    });
    const createdSession = await client.sessions.create(localCreateInput);
    expect(createdSession.id).toBe(createdSessionId);
    await expect(client.sessions.list()).resolves.toEqual([
      { sessionId: "session-1", lifecycle: "idle" },
    ]);

    const firstSubmit = session.submit("first turn");
    const secondSubmit = session.submit("second turn", {
      historyEntryId: "custom-history-id",
    });

    await expect(firstSubmit).resolves.toEqual({
      userHistoryEntryId: "history-1",
      turn: { status: "completed", stopReason: "stop" },
    });
    await expect(secondSubmit).resolves.toEqual({
      userHistoryEntryId: "history-2",
      turn: { status: "aborted", stopReason: "aborted" },
    });
    expect(submitRequests.map((request) => request.params)).toEqual([
      { sessionId: "session-1", text: "first turn" },
      {
        sessionId: "session-1",
        text: "second turn",
        historyEntryId: "custom-history-id",
      },
    ]);

    await expect(session.retry()).resolves.toEqual({
      turn: { status: "completed", stopReason: "stop" },
    });
    expect(retryRequests.map((request) => request.params)).toEqual([{ sessionId: "session-1" }]);

    await expect(session.exec("pwd")).resolves.toEqual(
      createProtocolExecResult({ output: "/repo\n" }),
    );
    expect(execRequests.map((request) => request.params)).toEqual([
      { sessionId: "session-1", execId: expect.any(String), command: "pwd" },
    ]);

    const sampleInput = {
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
      options: { reasoning: "low", maxTokens: 100 },
    };
    await expect(session.sample(sampleInput)).resolves.toEqual({ message: sampledMessage });
    expect(sampleRequests.map((request) => request.params)).toEqual([
      { sessionId: "session-1", ...sampleInput },
    ]);

    expect(sessionDeltas).toEqual([
      createNoticeDelta("session-1", 2, "first-delta"),
      createNoticeDelta("session-1", 3, "global-delta"),
    ]);

    await client.close();
  });

  it("rejects invalid initialize metadata before connecting the transport", async () => {
    const child = new FakeChildProcess();
    const transport = new StdioSessionProtocolTransport(child);

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

    expect(child.requests).toEqual([]);
  });

  it("throws TauSessionProtocolResponseError for session protocol error responses", async () => {
    const child = new FakeChildProcess();
    const { client } = await createConnectedClient(child);
    const session = await client.sessions.observe("session-1");

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

    await expect(session.submit("hello")).rejects.toMatchObject({
      name: "TauSessionProtocolResponseError",
      code: "busy",
      requestId: expect.any(String),
      message: "a session turn is already running",
    });

    await client.close();
  });

  it("rejects malformed session protocol responses via shared outgoing parser", async () => {
    const child = new FakeChildProcess();
    const { client } = await createConnectedClient(child);
    const session = await client.sessions.observe("session-1");

    child.on("request", (request) => {
      if (request.method === "session.submit") {
        child.send({
          version: SESSION_PROTOCOL_VERSION,
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

    await expect(session.submit("hello")).rejects.toMatchObject({
      name: "TauTransportError",
      message: "received malformed session protocol response",
    });

    await expect(session.interrupt()).resolves.toEqual({
      interrupted: false,
      isTurnRunning: false,
    });

    await client.close();
  });

  it("rejects successful session protocol responses with invalid method results", async () => {
    const child = new FakeChildProcess();
    const { client } = await createConnectedClient(child);
    const session = await client.sessions.observe("session-1");
    await expect(session.snapshot()).resolves.toEqual(createSnapshot("session-1"));

    child.on("request", (request) => {
      if (request.method === "session.snapshot") {
        child.send(
          createSuccessResponse(request.id, {
            sessionId: "session-1",
            status: "idle",
            executionEnvironment: { kind: "local", cwd: "/repo", home: "/home/user" },
            historyEntries: [],
          }),
        );
      }
    });

    await expect(session.snapshot()).rejects.toMatchObject({
      name: "TauTransportError",
      message: expect.stringContaining(
        "received invalid session protocol response result: session.snapshot result is invalid",
      ),
    });

    await client.close();
  });

  it("fails transport when outgoing session protocol payload is malformed", async () => {
    const child = new FakeChildProcess();
    const { client } = await createConnectedClient(child);
    const session = await client.sessions.observe("session-1");
    await expect(session.snapshot()).resolves.toEqual(createSnapshot("session-1"));

    child.sendRaw("[]");

    await expect(session.snapshot()).rejects.toMatchObject({
      name: "TauTransportError",
      message:
        "received invalid session protocol payload from tau process: session protocol payload must be a JSON object",
    });

    await client.close();
  });

  it("fails stdio transport on responses for unknown request ids", async () => {
    const child = new FakeChildProcess();
    const { client } = await createConnectedClient(child);

    child.send(
      createSuccessResponse("unknown-request", {
        sessions: [],
      }),
    );
    await Promise.resolve();

    await expect(client.sessions.list()).rejects.toMatchObject({
      name: "TauTransportError",
      message: "received response for unknown session protocol request 'unknown-request'",
    });

    await client.close();
  });

  it("fails stdio transport on error responses for unknown request ids", async () => {
    const child = new FakeChildProcess();
    const { client } = await createConnectedClient(child);

    child.send({
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

    await expect(client.sessions.list()).rejects.toMatchObject({
      name: "TauTransportError",
      message: "received response for unknown session protocol request 'unknown-request'",
    });

    await client.close();
  });

  it("fails stdio transport on malformed responses for unknown request ids", async () => {
    const child = new FakeChildProcess();
    const { client } = await createConnectedClient(child);

    child.send({
      version: SESSION_PROTOCOL_VERSION,
      type: "response",
      id: "unknown-request",
      ok: false,
      error: {
        code: "internal_error",
      },
    });
    await Promise.resolve();

    await expect(client.sessions.list()).rejects.toMatchObject({
      name: "TauTransportError",
      message: "received malformed response for unknown session protocol request 'unknown-request'",
    });

    await client.close();
  });

  it("rejects pending requests when rpc subprocess exits", async () => {
    const child = new FakeChildProcess();
    const { client } = await createConnectedClient(child);
    const session = await client.sessions.observe("session-1");
    await expect(session.snapshot()).resolves.toEqual(createSnapshot("session-1"));

    const snapshotPromise = session.snapshot();
    await waitForRequest(child, (request) => request.method === "session.snapshot");

    child.writeStderr("fatal stderr\n");
    child.exit(9, null);

    await expect(snapshotPromise).rejects.toBeInstanceOf(TauProcessError);
    await expect(snapshotPromise).rejects.toMatchObject({
      exitCode: 9,
      signal: null,
      stderr: "fatal stderr\n",
    });

    await expect(session.interrupt()).rejects.toBeInstanceOf(TauTransportError);
  });

  it("retains a bounded stderr tail when the rpc subprocess exits", async () => {
    const child = new FakeChildProcess();
    const { client } = await createConnectedClient(child);
    const session = await client.sessions.observe("session-1");
    await expect(session.snapshot()).resolves.toEqual(createSnapshot("session-1"));

    const snapshotPromise = session.snapshot();
    await waitForRequest(child, (request) => request.method === "session.snapshot");

    child.writeStderr("discarded-head\n");
    child.writeStderr("é".repeat(35_000));
    child.writeStderr("\nretained-tail\n");
    child.exit(9, null);

    const error = await snapshotPromise.catch((cause) => cause);
    expect(error).toBeInstanceOf(TauProcessError);
    expect(error.stderr.startsWith("[stderr truncated; showing tail]\n")).toBe(true);
    expect(error.stderr.endsWith("\nretained-tail\n")).toBe(true);
    expect(error.stderr).not.toContain("discarded-head");
    expect(error.stderr).not.toContain("�");
    expect(Buffer.byteLength(error.stderr, "utf8")).toBeLessThanOrEqual(64 * 1024);

    await client.close();
  });

  it("close is idempotent", async () => {
    const child = new FakeChildProcess();
    const { client } = await createConnectedClient(child);

    await expect(client.close()).resolves.toBeUndefined();
    await expect(client.close()).resolves.toBeUndefined();
  });

  it("waits for subprocess exit after escalating close to sigkill", async () => {
    vi.useFakeTimers();
    try {
      const child = new FakeChildProcess({ autoExitOnKill: false });
      const transport = new StdioSessionProtocolTransport(child);

      const closePromise = transport.close();
      await vi.advanceTimersByTimeAsync(2_000);
      expect(child.killSignals).toEqual(["SIGTERM", "SIGKILL"]);

      let closed = false;
      closePromise.then(() => {
        closed = true;
      });
      await Promise.resolve();
      expect(closed).toBe(false);

      child.exit(null, "SIGKILL");
      await expect(closePromise).resolves.toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });
});
