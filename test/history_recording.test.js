import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AgentHistoryRecorder } from "../dist/core/history/agent_history_recorder.js";
import { HistoryManager } from "../dist/core/history/history_manager.js";
import { LocalHistoryStore } from "../dist/core/history/local_history_store.js";

const session = { sessionId: "session", attributes: { source: "test" }, createdAt: 1 };
const entry = (id) => ({ id, type: "user", content: id, sourceIds: [id], timestamp: 2 });

async function lockDatabase(path) {
  const child = spawn(
    process.execPath,
    [
      "--input-type=module",
      "-e",
      `
    import { DatabaseSync } from 'node:sqlite';
    const db = new DatabaseSync(process.argv[1]);
    db.exec('PRAGMA busy_timeout=5000; BEGIN IMMEDIATE');
    process.stdout.write('locked');
    process.stdin.once('data', () => { db.exec('COMMIT'); db.close(); });
  `,
      path,
    ],
    { stdio: ["pipe", "pipe", "inherit"] },
  );
  const exited = once(child, "exit");
  await once(child.stdout, "data");
  return async () => {
    child.stdin.end("release");
    await exited;
  };
}

async function waitForEntries(store, ids) {
  await vi.waitFor(
    async () => {
      const result = await store.read({ sessionId: session.sessionId, limit: 100 });
      expect(result.entries.map((item) => item.id)).toEqual(ids);
    },
    { timeout: 8_000, interval: 50 },
  );
}

describe("background history recording", () => {
  it("keeps recording responsive under cross-process contention and preserves rewind order", async () => {
    const directory = mkdtempSync(join(tmpdir(), "tau-history-contention-"));
    const path = join(directory, "history.sqlite");
    const reader = new LocalHistoryStore(path);
    const release = await lockDatabase(path);
    const reportRecording = vi.fn();
    const manager = HistoryManager.open(path, { reportRecording });
    const remote = { endpoint: "https://history.example.com", apiKey: "secret" };
    const replicated = [];
    vi.stubGlobal("fetch", async (_url, init) => {
      const { operations } = JSON.parse(init.body);
      replicated.push(...operations);
      return Response.json({ applied: operations.length });
    });
    let ticks = 0;
    const heartbeat = setInterval(() => {
      ticks += 1;
    }, 20);
    let released = false;
    try {
      const writer = manager.openSession(session, remote);
      writer.append([entry("a"), entry("b"), entry("c")]);
      writer.truncateFromSources(["b", "c"]);
      writer.append([entry("d")]);
      await vi.waitFor(
        () => {
          expect(reportRecording).toHaveBeenCalledWith(
            expect.objectContaining({ status: "delayed" }),
          );
        },
        { timeout: 5_000 },
      );
      expect(ticks).toBeGreaterThan(0);
      await release();
      released = true;
      await waitForEntries(reader, ["a", "d"]);
      expect(reportRecording).toHaveBeenCalledWith(
        expect.objectContaining({ status: "recovered" }),
      );
      writer.append([entry("later")]);
      await waitForEntries(reader, ["a", "d", "later"]);
      await manager.flush();
      expect(replicated.map((operation) => operation.type)).toEqual([
        "create",
        "append",
        "truncate",
        "append",
        "append",
      ]);
      expect(replicated[2].afterEntryId).toBe("a");
      expect(reader.listPendingOperations(remote.endpoint, 10)).toEqual([]);
    } finally {
      clearInterval(heartbeat);
      if (!released) await release();
      manager.close();
      reader.close();
      vi.unstubAllGlobals();
      rmSync(directory, { recursive: true, force: true });
    }
  }, 20_000);

  it("reopens after initialization fails and records later events in the same session", async () => {
    const root = mkdtempSync(join(tmpdir(), "tau-history-open-"));
    const parent = join(root, "blocked");
    writeFileSync(parent, "not a directory");
    const reportRecording = vi.fn();
    const manager = HistoryManager.open(join(parent, "history.sqlite"), { reportRecording });
    try {
      const writer = manager.openSession(session);
      writer.append([entry("lost")]);
      await manager.flush();
      expect(reportRecording).toHaveBeenCalledWith(expect.objectContaining({ status: "dropped" }));
      rmSync(parent);
      writer.append([entry("later")]);
      const result = await manager.query().read({ sessionId: session.sessionId, limit: 10 });
      expect(result.entries.map((item) => item.id)).toEqual(["later"]);
    } finally {
      manager.close();
      rmSync(root, { recursive: true, force: true });
    }
  });

  it("bounds queued bytes without preventing later recording after an overflow", async () => {
    const store = new LocalHistoryStore(":memory:");
    let release;
    const gate = new Promise((resolve) => {
      release = resolve;
    });
    const create = store.createSession.bind(store);
    vi.spyOn(store, "createSession").mockImplementationOnce(async (...args) => {
      await gate;
      create(...args);
    });
    const reportRecording = vi.fn();
    const manager = new HistoryManager(store, { maxPendingBytes: 500, reportRecording });
    try {
      const writer = manager.openSession(session);
      expect(writer.append([entry("x".repeat(500))])).toBeTypeOf("string");
      expect(reportRecording).toHaveBeenCalledWith(expect.objectContaining({ status: "dropped" }));
      release();
      await manager.flush();
      writer.append([entry("later")]);
      await manager.flush();
      expect(
        (await store.read({ sessionId: session.sessionId, limit: 10 })).entries.map((e) => e.id),
      ).toEqual(["later"]);
    } finally {
      manager.close();
    }
  });

  it("does not poison other sessions or subsequent events after a failed write", async () => {
    const store = new LocalHistoryStore(":memory:");
    vi.spyOn(store, "append").mockImplementationOnce(() => {
      throw new Error("disk failure");
    });
    const manager = new HistoryManager(store, {
      reportRecording: () => {
        throw new Error("logger failed");
      },
    });
    try {
      const writer = manager.openSession(session);
      writer.append([entry("lost")]);
      writer.append([entry("later")]);
      const other = manager.openSession({ ...session, sessionId: "other" });
      other.append([entry("other")]);
      await manager.flush();
      expect(
        (await store.read({ sessionId: session.sessionId, limit: 10 })).entries.map((e) => e.id),
      ).toEqual(["later"]);
      expect(
        (await store.read({ sessionId: "other", limit: 10 })).entries.map((e) => e.id),
      ).toEqual(["other"]);
    } finally {
      manager.close();
    }
  });

  it("bounds shutdown flushing while recording remains locked", async () => {
    const store = new LocalHistoryStore(":memory:");
    vi.spyOn(store, "createSession").mockImplementation(() => {
      throw Object.assign(new Error("database is locked"), { errcode: 5 });
    });
    vi.useFakeTimers();
    const manager = new HistoryManager(store);
    try {
      manager.openSession(session);
      let flushed = false;
      const flush = manager.flush().then(() => {
        flushed = true;
      });
      await vi.advanceTimersByTimeAsync(1_999);
      expect(flushed).toBe(false);
      await vi.advanceTimersByTimeAsync(1);
      await flush;
      expect(flushed).toBe(true);
    } finally {
      manager.close();
      vi.useRealTimers();
    }
  });
});

describe("native agent history projection", () => {
  it("records rejected calls and recovery results, retains pre-compaction entries, and truncates on rewind", async () => {
    const store = new LocalHistoryStore(":memory:");
    const manager = new HistoryManager(store);
    const recorder = new AgentHistoryRecorder(manager.openSession(session));
    const call = { type: "toolCall", id: "call", name: "bash", arguments: { command: "pwd" } };
    const result = {
      role: "toolResult",
      toolCallId: call.id,
      toolName: call.name,
      content: [{ type: "text", text: "blocked" }],
      isError: true,
      timestamp: 3,
    };
    try {
      recorder.record({
        type: "user_message",
        historyEntryId: "user",
        message: { role: "user", content: "task", timestamp: 1 },
      });
      recorder.record({ type: "tool_run_blocked", toolCallId: call.id });
      recorder.record({
        type: "assistant_final",
        historyEntryId: "assistant",
        message: { content: [{ type: "text", text: "answer" }, call], timestamp: 2 },
      });
      expect(
        recorder.record({
          type: "tool_recovery",
          historyEntryId: "recovery",
          toolResults: [result],
        }),
      ).toBeUndefined();
      recorder.record({ type: "compaction_end", outcome: "compacted" });
      await manager.flush();
      const before = await store.read({ sessionId: session.sessionId, limit: 100 });
      expect(before.entries.map((entry) => entry.type)).toEqual(["user", "assistant", "tool"]);
      expect(before.entries[2]).toMatchObject({
        id: "call",
        sourceIds: ["assistant", "recovery"],
        arguments: call.arguments,
        result: result.content,
        outcome: "blocked",
      });
      recorder.record({ type: "history_rewound", removedEntryIds: ["assistant", "recovery"] });
      await manager.flush();
      expect((await store.read({ sessionId: session.sessionId, limit: 100 })).entries).toEqual([
        before.entries[0],
      ]);
    } finally {
      manager.close();
    }
  });
});
