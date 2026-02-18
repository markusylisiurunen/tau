import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { CORE_EVENT_VERSION } from "../dist/core/events/types.js";
import { RPC_ERROR_CODES, RPC_PROTOCOL_VERSION } from "../dist/core/modes/rpc_protocol.js";
import { RpcServer, runRpcServer } from "../dist/core/modes/rpc_server.js";

function request(id, method, params) {
  return JSON.stringify({
    version: RPC_PROTOCOL_VERSION,
    type: "request",
    id,
    method,
    ...(params !== undefined ? { params } : {}),
  });
}

function createHarness(options = {}) {
  const lines = [];
  const subagentHandlers = new Set();
  const historyEntries = [];
  let sessionId = "session-1";
  let nextSessionId = 2;
  let running = false;
  let nextId = 1;
  let releaseTurn;
  let pendingTurnResult = { aborted: false };
  let pendingTurn = null;

  const runtime = {
    get isTurnRunning() {
      return running;
    },
    session: {
      addUserText(text, addOptions) {
        const id = addOptions?.historyEntryId ?? `history-${nextId++}`;
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
      onSubagentEvent(handler) {
        subagentHandlers.add(handler);
        return () => subagentHandlers.delete(handler);
      },
      reset() {
        historyEntries.length = 0;
        sessionId = `session-${nextSessionId++}`;
      },
      get history() {
        return historyEntries.map((entry) => entry.message);
      },
      get historyEntries() {
        return historyEntries;
      },
      get sessionId() {
        return sessionId;
      },
    },
    async runTurn(onEvent) {
      running = true;
      try {
        if (options.runTurn) {
          return await options.runTurn(onEvent);
        }

        await onEvent({ type: "notice", severity: "info", text: "streaming" });
        pendingTurn = new Promise((resolve) => {
          releaseTurn = resolve;
        });
        await pendingTurn;
        await onEvent({ type: "notice", severity: "info", text: "finished" });
        return pendingTurnResult;
      } finally {
        running = false;
        pendingTurn = null;
        pendingTurnResult = { aborted: false };
      }
    },
    interruptTurn() {
      if (!running || !releaseTurn) {
        return false;
      }
      pendingTurnResult = { aborted: true };
      releaseTurn();
      return true;
    },
  };

  const server = new RpcServer({
    runtime,
    send: (line) => lines.push(JSON.parse(line)),
    emitReadyOnStart: true,
  });

  return {
    lines,
    server,
    runtime,
    releaseTurn: () => releaseTurn?.(),
    emitSubagent: (event) => {
      for (const handler of subagentHandlers) {
        handler({ type: "subagent_ui", event });
      }
    },
  };
}

function parseNdjson(text) {
  return text
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line));
}

describe("rpc_server", () => {
  it("streams submit events, forwards subagent events, and rejects overlapping submit with busy", async () => {
    const harness = createHarness();

    const firstSubmit = harness.server.handleLine(
      request("submit-1", "session.submit", { text: "first turn" }),
    );

    await Promise.resolve();
    harness.emitSubagent({ type: "spawned", id: "agent-1", title: "research" });

    await harness.server.handleLine(request("submit-2", "session.submit", { text: "second turn" }));

    harness.releaseTurn();
    await firstSubmit;

    const ready = harness.lines[0];
    expect(ready).toEqual(
      expect.objectContaining({
        type: "ready",
        sessionId: "session-1",
        coreEventVersion: CORE_EVENT_VERSION,
      }),
    );

    const submitEvent = harness.lines.find(
      (line) => line.type === "event" && line.requestId === "submit-1" && line.event?.event,
    );
    expect(submitEvent).toEqual(
      expect.objectContaining({
        type: "event",
        requestId: "submit-1",
        event: expect.objectContaining({
          version: CORE_EVENT_VERSION,
          event: expect.objectContaining({ type: "notice", text: "streaming" }),
        }),
      }),
    );

    const subagentEvent = harness.lines.find(
      (line) => line.type === "event" && line.event?.event?.type === "subagent_ui",
    );
    expect(subagentEvent).toEqual(
      expect.objectContaining({
        type: "event",
        event: {
          version: CORE_EVENT_VERSION,
          event: {
            type: "subagent_ui",
            event: { type: "spawned", id: "agent-1", title: "research" },
          },
        },
      }),
    );
    expect(subagentEvent.requestId).toBeUndefined();

    const busy = harness.lines.find((line) => line.type === "response" && line.id === "submit-2");
    expect(busy).toEqual({
      version: RPC_PROTOCOL_VERSION,
      type: "response",
      id: "submit-2",
      ok: false,
      error: {
        code: RPC_ERROR_CODES.busy,
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
          turn: { aborted: false },
        },
      }),
    );
  });

  it("handles interrupt, snapshot, reset, shutdown, and malformed lines", async () => {
    const harness = createHarness();

    const runningSubmit = harness.server.handleLine(
      request("submit", "session.submit", { text: "interrupt me" }),
    );
    await Promise.resolve();
    await Promise.resolve();

    await harness.server.handleLine(request("interrupt", "session.interrupt", {}));
    await runningSubmit;

    await harness.server.handleLine(request("snapshot", "session.snapshot", {}));
    await harness.server.handleLine(request("reset", "session.reset", {}));
    await harness.server.handleLine(request("shutdown", "session.shutdown", {}));
    await harness.server.handleLine("{bad-json");
    await harness.server.handleLine(request("after", "session.snapshot", {}));

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
          turn: { aborted: true },
        },
      }),
    );

    const snapshot = harness.lines.find(
      (line) => line.type === "response" && line.id === "snapshot",
    );
    expect(snapshot.result).toEqual(
      expect.objectContaining({
        sessionId: "session-1",
        isTurnRunning: false,
        historyLength: 1,
      }),
    );

    const reset = harness.lines.find((line) => line.type === "response" && line.id === "reset");
    expect(reset.result).toEqual({ previousSessionId: "session-1", sessionId: "session-2" });

    const shutdown = harness.lines.find(
      (line) => line.type === "response" && line.id === "shutdown",
    );
    expect(shutdown.result).toEqual({ shutdown: true });

    const malformed = harness.lines.find(
      (line) => line.type === "response" && line.error?.code === RPC_ERROR_CODES.parseError,
    );
    expect(malformed).toEqual(
      expect.objectContaining({
        ok: false,
      }),
    );

    const afterShutdown = harness.lines.find(
      (line) => line.type === "response" && line.id === "after",
    );
    expect(afterShutdown).toEqual({
      version: RPC_PROTOCOL_VERSION,
      type: "response",
      id: "after",
      ok: false,
      error: {
        code: RPC_ERROR_CODES.invalidRequest,
        message: "rpc server is shut down",
      },
    });
  });

  it("serializes concurrent reset requests in arrival order", async () => {
    const harness = createHarness();

    await Promise.all([
      harness.server.handleLine(request("reset-1", "session.reset", {})),
      harness.server.handleLine(request("reset-2", "session.reset", {})),
    ]);

    const resetOne = harness.lines.find(
      (line) => line.type === "response" && line.id === "reset-1",
    );
    expect(resetOne).toEqual(
      expect.objectContaining({
        ok: true,
        result: {
          previousSessionId: "session-1",
          sessionId: "session-2",
        },
      }),
    );

    const resetTwo = harness.lines.find(
      (line) => line.type === "response" && line.id === "reset-2",
    );
    expect(resetTwo).toEqual(
      expect.objectContaining({
        ok: true,
        result: {
          previousSessionId: "session-2",
          sessionId: "session-3",
        },
      }),
    );
  });

  it("serializes reset and shutdown interleavings", async () => {
    const resetThenShutdown = createHarness();

    await Promise.all([
      resetThenShutdown.server.handleLine(request("reset", "session.reset", {})),
      resetThenShutdown.server.handleLine(request("shutdown", "session.shutdown", {})),
    ]);

    const resetThenShutdownReset = resetThenShutdown.lines.find(
      (line) => line.type === "response" && line.id === "reset",
    );
    expect(resetThenShutdownReset).toEqual(
      expect.objectContaining({
        ok: true,
        result: {
          previousSessionId: "session-1",
          sessionId: "session-2",
        },
      }),
    );

    const resetThenShutdownShutdown = resetThenShutdown.lines.find(
      (line) => line.type === "response" && line.id === "shutdown",
    );
    expect(resetThenShutdownShutdown).toEqual(
      expect.objectContaining({
        ok: true,
        result: {
          shutdown: true,
        },
      }),
    );

    const resetThenShutdownResetIndex = resetThenShutdown.lines.findIndex(
      (line) => line.type === "response" && line.id === "reset",
    );
    const resetThenShutdownShutdownIndex = resetThenShutdown.lines.findIndex(
      (line) => line.type === "response" && line.id === "shutdown",
    );
    expect(resetThenShutdownResetIndex).toBeLessThan(resetThenShutdownShutdownIndex);

    const shutdownThenReset = createHarness();

    await Promise.all([
      shutdownThenReset.server.handleLine(request("shutdown", "session.shutdown", {})),
      shutdownThenReset.server.handleLine(request("reset", "session.reset", {})),
    ]);

    const shutdownThenResetShutdown = shutdownThenReset.lines.find(
      (line) => line.type === "response" && line.id === "shutdown",
    );
    expect(shutdownThenResetShutdown).toEqual(
      expect.objectContaining({
        ok: true,
        result: {
          shutdown: true,
        },
      }),
    );

    const shutdownThenResetReset = shutdownThenReset.lines.find(
      (line) => line.type === "response" && line.id === "reset",
    );
    expect(shutdownThenResetReset).toEqual({
      version: RPC_PROTOCOL_VERSION,
      type: "response",
      id: "reset",
      ok: false,
      error: {
        code: RPC_ERROR_CODES.invalidRequest,
        message: "rpc server is shut down",
      },
    });
  });

  it("allows submit to start when it arrives before a mutating request", async () => {
    const harness = createHarness();

    await Promise.all([
      harness.server.handleLine(request("submit", "session.submit", { text: "before reset" })),
      harness.server.handleLine(request("reset", "session.reset", {})),
    ]);

    const submit = harness.lines.find((line) => line.type === "response" && line.id === "submit");
    expect(submit).toEqual(
      expect.objectContaining({
        ok: true,
        result: {
          userHistoryEntryId: "history-1",
          turn: { aborted: true },
        },
      }),
    );

    const reset = harness.lines.find((line) => line.type === "response" && line.id === "reset");
    expect(reset).toEqual(
      expect.objectContaining({
        ok: true,
        result: {
          previousSessionId: "session-1",
          sessionId: "session-2",
        },
      }),
    );
  });

  it("returns busy for submit when a mutating request is in progress", async () => {
    const harness = createHarness();

    await Promise.all([
      harness.server.handleLine(request("reset", "session.reset", {})),
      harness.server.handleLine(request("submit", "session.submit", { text: "after reset" })),
    ]);

    const submitBusy = harness.lines.find(
      (line) => line.type === "response" && line.id === "submit",
    );
    expect(submitBusy).toEqual({
      version: RPC_PROTOCOL_VERSION,
      type: "response",
      id: "submit",
      ok: false,
      error: {
        code: RPC_ERROR_CODES.busy,
        message: "a mutating session request is in progress",
      },
    });
  });

  it("returns success for interrupt while shutdown is in flight", async () => {
    const harness = createHarness();

    const submitPromise = harness.server.handleLine(
      request("submit", "session.submit", { text: "interrupt me while shutting down" }),
    );
    await Promise.resolve();
    await Promise.resolve();

    const shutdownPromise = harness.server.handleLine(request("shutdown", "session.shutdown", {}));
    const interruptPromise = harness.server.handleLine(
      request("interrupt", "session.interrupt", {}),
    );

    await Promise.all([submitPromise, shutdownPromise, interruptPromise]);

    const shutdown = harness.lines.find(
      (line) => line.type === "response" && line.id === "shutdown",
    );
    expect(shutdown).toEqual(
      expect.objectContaining({
        ok: true,
        result: {
          shutdown: true,
        },
      }),
    );

    const interrupt = harness.lines.find(
      (line) => line.type === "response" && line.id === "interrupt",
    );
    expect(interrupt).toEqual(
      expect.objectContaining({
        ok: true,
        result: {
          interrupted: expect.any(Boolean),
          isTurnRunning: expect.any(Boolean),
        },
      }),
    );

    const submit = harness.lines.find((line) => line.type === "response" && line.id === "submit");
    expect(submit).toEqual(
      expect.objectContaining({
        ok: true,
        result: expect.objectContaining({
          turn: { aborted: true },
        }),
      }),
    );
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
      runtime: harness.runtime,
      input,
      output,
    });

    input.write(`${request("submit-loop", "session.submit", { text: "hello" })}\n`);
    await new Promise((resolve) => setTimeout(resolve, 0));
    input.write(`${request("interrupt-loop", "session.interrupt", {})}\n`);
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
          turn: { aborted: true },
        }),
      }),
    );

    const submitEvent = lines.find(
      (line) => line.type === "event" && line.requestId === "submit-loop" && line.event?.event,
    );
    expect(submitEvent).toBeDefined();
  });
});
