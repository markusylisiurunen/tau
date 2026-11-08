import { describe, expect, it } from "vitest";
import { MemorySessionStore } from "../dist/store/memory_session_store.js";
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

describe("MemorySessionStore", () => {
  it("commits, loads, and lists session snapshots", async () => {
    const store = new MemorySessionStore();

    await expect(
      store.commitSessionSnapshot(createSnapshot("session-1", "hello")),
    ).resolves.toBeUndefined();

    await expect(store.listSessionSnapshots()).resolves.toEqual([
      createSnapshot("session-1", "hello"),
    ]);
    await expect(store.loadSession("session-1")).resolves.toEqual(
      createSnapshot("session-1", "hello"),
    );

    await expect(
      store.commitSessionSnapshot(createSnapshot("session-1", "updated", 7)),
    ).resolves.toBeUndefined();
    await expect(store.loadSession("session-1")).resolves.toEqual(
      createSnapshot("session-1", "updated", 7),
    );

    await store.commitSessionSnapshot(createSnapshot("session-2", "hi"));
    await expect(store.listSessionSnapshots()).resolves.toEqual([
      createSnapshot("session-1", "updated", 7),
      createSnapshot("session-2", "hi"),
    ]);
  });

  it("isolates stored snapshots from caller mutation", async () => {
    const store = new MemorySessionStore();
    const snapshot = createSnapshot("session-1", "hello");

    await store.commitSessionSnapshot(snapshot);
    snapshot.messages.push({
      id: "entry-2",
      state: "committed",
      modelVisible: true,
      message: { role: "user", content: [{ type: "text", text: "mutated" }] },
    });

    const loaded = await store.loadSession("session-1");
    expect(loaded?.messages.filter((entry) => entry.id !== "system")).toHaveLength(1);

    loaded?.messages.push({
      id: "entry-3",
      state: "committed",
      modelVisible: true,
      message: { role: "user", content: [{ type: "text", text: "loaded" }] },
    });
    expect(
      (await store.loadSession("session-1"))?.messages.filter((entry) => entry.id !== "system"),
    ).toHaveLength(1);
  });

  it("rejects commits when the expected revision is stale", async () => {
    const store = new MemorySessionStore();
    await store.commitSessionSnapshot(createSnapshot("session-1", "hello", 1), {
      expectedRevision: 0,
    });

    await expect(
      store.commitSessionSnapshot(createSnapshot("session-1", "stale", 3), {
        expectedRevision: 0,
      }),
    ).rejects.toBeInstanceOf(SessionStoreConflictError);
    await expect(
      store.commitSessionSnapshot(createSnapshot("session-1", "updated", 2), {
        expectedRevision: 1,
      }),
    ).resolves.toBeUndefined();
    await expect(store.loadSession("session-1")).resolves.toEqual(
      createSnapshot("session-1", "updated", 2),
    );
  });

  it("rejects invalid snapshots before committing them", async () => {
    const store = new MemorySessionStore();

    await expect(
      store.commitSessionSnapshot({
        ...createSnapshot("session-1", "entry"),
        settings: "invalid",
      }),
    ).rejects.toThrow("session snapshot is invalid");

    await expect(store.loadSession("session-1")).resolves.toBeUndefined();
  });
});
