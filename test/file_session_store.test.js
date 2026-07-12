import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FileSessionStore } from "../dist/store/file_session_store.js";
import { SessionStoreConflictError } from "../dist/store/session_store.js";
import { createProtocolSnapshot } from "./helpers/session_protocol_fixtures.js";

function createSnapshot(sessionId, text, revision = 1) {
  const message = {
    role: "user",
    content: [{ type: "text", text }],
  };

  return createProtocolSnapshot({
    sessionId,
    revision,
    historyEntries: [{ id: "entry-1", message }],
  });
}

async function withTempStore(test) {
  const directory = join(
    tmpdir(),
    `tau-file-session-store-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2)}`,
  );

  try {
    await test(new FileSessionStore({ directory }), directory);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

describe("FileSessionStore", () => {
  it("persists, loads, lists, and deletes snapshots", async () => {
    await withTempStore(async (store) => {
      await expect(
        store.commitSessionSnapshot(createSnapshot("session/one", "hello")),
      ).resolves.toBeUndefined();
      await expect(
        store.commitSessionSnapshot(createSnapshot("session-two", "hi", 2)),
      ).resolves.toBeUndefined();

      await expect(store.loadSession("session/one")).resolves.toEqual(
        createSnapshot("session/one", "hello"),
      );
      await expect(store.listSessionSnapshots()).resolves.toEqual([
        createSnapshot("session-two", "hi", 2),
        createSnapshot("session/one", "hello"),
      ]);

      await store.deleteSession("session/one");
      await expect(store.loadSession("session/one")).resolves.toBeUndefined();
      await expect(store.listSessionSnapshots()).resolves.toEqual([
        createSnapshot("session-two", "hi", 2),
      ]);

      await expect(store.loadSession("session-two")).resolves.toEqual(
        createSnapshot("session-two", "hi", 2),
      );
    });
  });

  it("rejects corrupt stored snapshots", async () => {
    await withTempStore(async (store, directory) => {
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, "c2Vzc2lvbi0x.json"), "{bad-json", "utf8");

      await expect(store.loadSession("session-1")).rejects.toThrow(
        "stored session snapshot is not valid JSON: session-1",
      );
    });
  });

  it("rejects stored snapshots under the wrong session id", async () => {
    await withTempStore(async (store, directory) => {
      await mkdir(directory, { recursive: true });
      await writeFile(
        join(directory, "c2Vzc2lvbi0x.json"),
        JSON.stringify(createSnapshot("session-2", "wrong")),
        "utf8",
      );

      await expect(store.loadSession("session-1")).rejects.toThrow(
        "stored session snapshot id mismatch: session-1",
      );
    });
  });

  it("rejects stored snapshots with invalid known fields", async () => {
    await withTempStore(async (store, directory) => {
      await mkdir(directory, { recursive: true });
      await writeFile(
        join(directory, "c2Vzc2lvbi0x.json"),
        JSON.stringify({
          ...createSnapshot("session-1", "entry"),
          settings: "invalid",
        }),
        "utf8",
      );

      await expect(store.loadSession("session-1")).rejects.toThrow(
        "stored session snapshot is invalid: session-1",
      );
    });
  });

  it("rejects invalid snapshots before committing them", async () => {
    await withTempStore(async (store) => {
      await expect(
        store.commitSessionSnapshot({
          ...createSnapshot("session-1", "entry"),
          settings: "invalid",
        }),
      ).rejects.toThrow("session snapshot is invalid");

      await expect(store.loadSession("session-1")).resolves.toBeUndefined();
      await expect(store.listSessionSnapshots()).resolves.toEqual([]);
    });
  });

  it("rejects stale expected revisions under the session file lock", async () => {
    await withTempStore(async (store) => {
      await store.commitSessionSnapshot(createSnapshot("session-1", "hello", 1), {
        expectedRevision: 0,
      });
      await store.commitSessionSnapshot(createSnapshot("session-1", "updated", 2), {
        expectedRevision: 1,
      });

      await expect(
        store.commitSessionSnapshot(createSnapshot("session-1", "stale", 3), {
          expectedRevision: 1,
        }),
      ).rejects.toBeInstanceOf(SessionStoreConflictError);
      await expect(
        store.deleteSession("session-1", { expectedRevision: 1 }),
      ).rejects.toBeInstanceOf(SessionStoreConflictError);
      await expect(
        store.deleteSession("session-1", { expectedRevision: 2 }),
      ).resolves.toBeUndefined();
    });
  });
});
