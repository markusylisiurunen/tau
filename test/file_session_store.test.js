import { access, chmod, mkdir, rm, stat, writeFile } from "node:fs/promises";
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

  it("recovers a lock owned by a process that no longer exists", async () => {
    await withTempStore(async (store, directory) => {
      const lockPath = join(directory, "c2Vzc2lvbi0x.json.lock");
      await mkdir(lockPath, { recursive: true });
      await writeFile(
        join(lockPath, "owner.json"),
        JSON.stringify({ pid: 2_147_483_647, token: "stale-owner", createdAt: 1 }),
        "utf8",
      );

      await expect(
        store.commitSessionSnapshot(createSnapshot("session-1", "recovered")),
      ).resolves.toBeUndefined();
      await expect(access(lockPath)).rejects.toMatchObject({ code: "ENOENT" });
      await expect(store.loadSession("session-1")).resolves.toEqual(
        createSnapshot("session-1", "recovered"),
      );
    });
  });

  it("uses owner-only permissions for snapshot directories and files", async () => {
    await withTempStore(async (store, directory) => {
      const previousUmask = process.umask(0o022);
      try {
        await store.commitSessionSnapshot(createSnapshot("session-1", "private"));
      } finally {
        process.umask(previousUmask);
      }

      expect((await stat(directory)).mode & 0o777).toBe(0o700);
      expect((await stat(join(directory, "c2Vzc2lvbi0x.json"))).mode & 0o777).toBe(0o600);

      await chmod(directory, 0o755);
      await chmod(join(directory, "c2Vzc2lvbi0x.json"), 0o644);
      await store.loadSession("session-1");

      expect((await stat(directory)).mode & 0o777).toBe(0o700);
      expect((await stat(join(directory, "c2Vzc2lvbi0x.json"))).mode & 0o777).toBe(0o600);
    });
  });

  it("cleans store-owned snapshot temporaries on startup and deletion", async () => {
    await withTempStore(async (_store, directory) => {
      await mkdir(directory, { recursive: true });
      const startupTemp = join(
        directory,
        "c2Vzc2lvbi0x.json.100.100.00000000-0000-4000-8000-000000000001.tmp",
      );
      await writeFile(startupTemp, "stale", { mode: 0o600 });

      const store = new FileSessionStore({ directory });
      await store.listSessionSnapshots();
      await expect(access(startupTemp)).rejects.toMatchObject({ code: "ENOENT" });

      await store.commitSessionSnapshot(createSnapshot("session-1", "private"));
      const deletionTemp = join(
        directory,
        "c2Vzc2lvbi0x.json.100.200.00000000-0000-4000-8000-000000000002.tmp",
      );
      await writeFile(deletionTemp, "stale", { mode: 0o600 });

      await store.deleteSession("session-1");
      await expect(access(deletionTemp)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });
});
