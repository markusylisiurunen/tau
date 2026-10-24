import { spawn } from "node:child_process";
import { once } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, it, vi } from "vitest";
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
  it("survives a cross-process lock longer than the old timeout and preserves rewind order", async () => {
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
      const start = performance.now();
      expect(manager.registerSession(session, remote)).toBeUndefined();
      manager.append(session.sessionId, [entry("a"), entry("b"), entry("c")], remote);
      manager.truncateFromSources(session.sessionId, ["b", "c"], remote);
      manager.append(session.sessionId, [entry("d")], remote);
      expect(performance.now() - start).toBeLessThan(500);
      await delay(5_300);
      expect(ticks).toBeGreaterThan(50);
      expect(reportRecording).toHaveBeenCalledWith(expect.objectContaining({ status: "delayed" }));
      await release();
      released = true;
      await waitForEntries(reader, ["a", "d"]);
      expect(reportRecording).toHaveBeenCalledWith(
        expect.objectContaining({ status: "recovered" }),
      );
      manager.append(session.sessionId, [entry("later")], remote);
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
      manager.registerSession(session);
      manager.append(session.sessionId, [entry("lost")]);
      await manager.flush();
      expect(reportRecording).toHaveBeenCalledWith(expect.objectContaining({ status: "dropped" }));
      rmSync(parent);
      manager.append(session.sessionId, [entry("later")]);
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
      manager.registerSession(session);
      expect(manager.append(session.sessionId, [entry("x".repeat(500))])).toBeTypeOf("string");
      expect(reportRecording).toHaveBeenCalledWith(expect.objectContaining({ status: "dropped" }));
      release();
      await manager.flush();
      manager.append(session.sessionId, [entry("later")]);
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
      manager.registerSession(session);
      manager.append(session.sessionId, [entry("lost")]);
      manager.append(session.sessionId, [entry("later")]);
      manager.registerSession({ ...session, sessionId: "other" });
      manager.append("other", [entry("other")]);
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
    const manager = new HistoryManager(store);
    manager.registerSession(session);
    const start = performance.now();
    await manager.flush();
    expect(performance.now() - start).toBeLessThan(3_000);
    manager.close();
  });
});
