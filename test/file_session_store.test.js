import { access, chmod, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { FileSessionStore } from "../dist/store/file_session_store.js";
import {
  LEGACY_SESSION_MODEL_CONTEXT_KEY,
  STORED_SESSION_DOCUMENT_FORMAT,
  STORED_SESSION_DOCUMENT_VERSION,
} from "../dist/store/session_snapshot_migrations.js";
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

function createVersionFiveSnapshot(snapshot) {
  const legacy = structuredClone(snapshot);
  legacy.timeline = legacy.timeline.items.flatMap((item) => {
    if (item.type !== "message") return [];
    const { sequence: _sequence, createdAt: _createdAt, ...messageItem } = item;
    return [messageItem];
  });
  delete legacy.operations;
  legacy.agentState.contextEpoch = legacy.agentState.modelContextKey;
  delete legacy.agentState.modelContextKey;
  if (legacy.agentState.usageCheckpoint) {
    legacy.agentState.usageCheckpoint.contextEpoch =
      legacy.agentState.usageCheckpoint.modelContextKey;
    delete legacy.agentState.usageCheckpoint.modelContextKey;
  }
  return legacy;
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

  it("writes the current versioned storage document", async () => {
    await withTempStore(async (store, directory) => {
      const snapshot = createSnapshot("session-1", "hello");
      await store.commitSessionSnapshot(snapshot);

      const stored = JSON.parse(await readFile(join(directory, "c2Vzc2lvbi0x.json"), "utf8"));
      expect(stored).toEqual({
        format: STORED_SESSION_DOCUMENT_FORMAT,
        version: STORED_SESSION_DOCUMENT_VERSION,
        snapshot,
      });
    });
  });

  it("loads unversioned snapshots that already have canonical agent state", async () => {
    await withTempStore(async (store, directory) => {
      const snapshot = createSnapshot("session-1", "hello");
      const legacy = createVersionFiveSnapshot(snapshot);
      legacy.agentState.modelContextKey = legacy.agentState.contextEpoch;
      delete legacy.agentState.contextEpoch;
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, "c2Vzc2lvbi0x.json"), JSON.stringify(legacy), "utf8");

      await expect(store.loadSession("session-1")).resolves.toEqual(snapshot);
    });
  });

  it("adds the required null goal when migrating version 2 sessions", async () => {
    await withTempStore(async (store, directory) => {
      const snapshot = createSnapshot("session-1", "hello");
      const { goal: _goal, ...versionTwoSnapshot } = createVersionFiveSnapshot(snapshot);
      await mkdir(directory, { recursive: true });
      await writeFile(
        join(directory, "c2Vzc2lvbi0x.json"),
        JSON.stringify({
          format: STORED_SESSION_DOCUMENT_FORMAT,
          version: 2,
          snapshot: versionTwoSnapshot,
        }),
        "utf8",
      );

      await expect(store.loadSession("session-1")).resolves.toEqual(snapshot);
    });
  });

  it("migrates unversioned snapshots and removes legacy pruning presentation", async () => {
    await withTempStore(async (store, directory) => {
      const toolCall = {
        type: "toolCall",
        id: "tool-1",
        name: "bash",
        arguments: { command: "pwd" },
      };
      const current = createProtocolSnapshot({
        sessionId: "session-1",
        revision: 7,
        historyEntries: [
          {
            id: "assistant-1",
            message: {
              role: "assistant",
              api: "openai-responses",
              provider: "openai",
              model: "gpt-5.5",
              stopReason: "toolUse",
              content: [toolCall],
            },
          },
        ],
        timeline: [
          { type: "message", id: "timeline-assistant-1", messageId: "assistant-1" },
          {
            type: "operation",
            id: "operation-prune",
            operation: { kind: "prune", status: "succeeded", startedAt: 1, finishedAt: 2 },
          },
        ],
        tools: {
          "tool-1": {
            id: "tool-1",
            toolCallId: "tool-1",
            toolName: "bash",
            call: { messageId: "assistant-1", contentIndex: 0 },
            status: "queued",
            facetIds: ["tool-ui-tool-1"],
          },
        },
        facets: {
          "tool-ui-tool-1": {
            id: "tool-ui-tool-1",
            subject: { type: "tool", id: "tool-1" },
            kind: "tau.tool-ui-events",
            version: 1,
            data: {
              events: [{ type: "tool_pruned", toolCallId: "tool-1", content: "pruned" }],
            },
          },
          "operation-prune-facet": {
            id: "operation-prune-facet",
            subject: { type: "operation", id: "operation-prune" },
            kind: "tau.operation",
            version: 1,
            data: {},
          },
        },
      });
      const {
        agentState: _agentState,
        costTotal: _costTotal,
        operations: _operations,
        ...legacy
      } = current;
      legacy.timeline = [
        { type: "message", id: "timeline-assistant-1", messageId: "assistant-1" },
        {
          type: "operation",
          id: "operation-prune",
          operation: { kind: "prune", status: "succeeded", startedAt: 1, finishedAt: 2 },
        },
      ];
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, "c2Vzc2lvbi0x.json"), JSON.stringify(legacy), "utf8");

      await expect(store.loadSession("session-1")).resolves.toEqual({
        ...current,
        agentState: {
          revision: current.revision,
          modelContextKey: LEGACY_SESSION_MODEL_CONTEXT_KEY,
        },
        timeline: {
          epoch: 1,
          sequence: 2,
          items: current.timeline.items.filter((item) => item.type !== "operation"),
        },
        operations: {},
        tools: {
          "tool-1": {
            ...current.tools["tool-1"],
            facetIds: [],
          },
        },
        facets: {},
      });
    });
  });

  it("drops legacy tool presentation that references removed messages", async () => {
    await withTempStore(async (store, directory) => {
      const snapshot = createSnapshot("session-1", "hello");
      const legacy = {
        ...createVersionFiveSnapshot(snapshot),
        tools: {
          "tool-1": {
            id: "tool-1",
            toolCallId: "tool-1",
            toolName: "bash",
            call: { messageId: "removed-assistant", contentIndex: 0 },
            status: "succeeded",
            facetIds: ["tool-facet"],
            resultMessageId: "removed-result",
          },
        },
        facets: {
          "tool-facet": {
            id: "tool-facet",
            subject: { type: "tool", id: "tool-1" },
            kind: "test.tool",
            version: 1,
            data: {},
          },
        },
      };
      await mkdir(directory, { recursive: true });
      await writeFile(join(directory, "c2Vzc2lvbi0x.json"), JSON.stringify(legacy), "utf8");

      await expect(store.loadSession("session-1")).resolves.toEqual({
        ...snapshot,
        tools: {},
        facets: {},
      });
    });
  });

  it("drops unrecoverable legacy subagent presentation during migration", async () => {
    await withTempStore(async (store, directory) => {
      const snapshot = createSnapshot("session-1", "hello");
      const legacy = {
        ...createVersionFiveSnapshot(snapshot),
        agents: {
          "agent-1": {
            id: "agent-1",
            name: "default",
            title: "old run",
            status: "succeeded",
            costTotal: 0.01,
            turns: 1,
            toolCalls: 0,
            usage: {
              input: 1,
              output: 1,
              cacheRead: 0,
              cacheWrite: 0,
              contextWindowUsageTokens: 2,
              contextWindow: 200000,
            },
            startedAt: 1,
            finishedAt: 2,
            abortRequested: false,
            finalText: "stale response",
          },
        },
        facets: {
          "agent-facet": {
            id: "agent-facet",
            subject: { type: "agent", id: "agent-1" },
            kind: "test.agent",
            version: 1,
            data: {},
          },
        },
      };
      await mkdir(directory, { recursive: true });
      await writeFile(
        join(directory, "c2Vzc2lvbi0x.json"),
        JSON.stringify({ format: STORED_SESSION_DOCUMENT_FORMAT, version: 1, snapshot: legacy }),
        "utf8",
      );

      await expect(store.loadSession("session-1")).resolves.toEqual({
        ...snapshot,
        agents: {},
      });
    });
  });

  it("migrates version 5 array timelines and legacy notices", async () => {
    await withTempStore(async (store, directory) => {
      const snapshot = createSnapshot("session-1", "hello");
      const expected = {
        ...snapshot,
        timeline: {
          epoch: 1,
          sequence: 2,
          items: [
            ...snapshot.timeline.items,
            {
              type: "notice",
              id: "legacy-notice",
              sequence: 2,
              createdAt: 2,
              notice: {
                kind: "tau.recovered.notice",
                version: 1,
                severity: "warn",
                subject: { type: "session" },
                presentation: {
                  title: "history unavailable",
                  content: ["the session will continue"],
                },
                data: {},
              },
            },
          ],
        },
      };
      const legacy = createVersionFiveSnapshot(snapshot);
      legacy.timeline.push({
        type: "notice",
        id: "legacy-notice",
        notice: {
          severity: "warn",
          text: "history unavailable\nthe session will continue",
          timestamp: 2,
        },
      });
      await mkdir(directory, { recursive: true });
      await writeFile(
        join(directory, "c2Vzc2lvbi0x.json"),
        JSON.stringify({ format: STORED_SESSION_DOCUMENT_FORMAT, version: 5, snapshot: legacy }),
        "utf8",
      );

      await expect(store.loadSession("session-1")).resolves.toEqual(expected);
    });
  });

  it("drops tool presentation for context-only messages while migrating version 5", async () => {
    await withTempStore(async (store, directory) => {
      const snapshot = createProtocolSnapshot({
        sessionId: "session-1",
        historyEntries: [
          {
            id: "assistant-hidden",
            message: {
              role: "assistant",
              content: [
                {
                  type: "toolCall",
                  id: "tool-hidden",
                  name: "bash",
                  arguments: { command: "pwd" },
                },
              ],
              provider: "openai",
              model: "gpt-5.5",
              stopReason: "toolUse",
            },
          },
        ],
        tools: {
          "tool-hidden": {
            id: "tool-hidden",
            toolCallId: "tool-hidden",
            toolName: "bash",
            status: "succeeded",
            call: { messageId: "assistant-hidden", contentIndex: 0 },
            facetIds: ["tool-hidden-facet"],
          },
        },
        facets: {
          "tool-hidden-facet": {
            id: "tool-hidden-facet",
            subject: { type: "tool", id: "tool-hidden" },
            kind: "tau.tool-ui-events",
            version: 1,
            data: { events: [] },
          },
        },
      });
      snapshot.timeline = { epoch: 1, sequence: 0, items: [] };
      const legacy = createVersionFiveSnapshot(snapshot);
      await mkdir(directory, { recursive: true });
      await writeFile(
        join(directory, "c2Vzc2lvbi0x.json"),
        JSON.stringify({
          format: STORED_SESSION_DOCUMENT_FORMAT,
          version: 5,
          snapshot: legacy,
        }),
        "utf8",
      );

      await expect(store.loadSession("session-1")).resolves.toEqual({
        ...snapshot,
        tools: {},
        facets: {},
      });
    });
  });

  it("bounds notice presentation while migrating version 6", async () => {
    await withTempStore(async (store, directory) => {
      const snapshot = createProtocolSnapshot({
        sessionId: "session-1",
        timeline: {
          epoch: 1,
          sequence: 1,
          items: [
            {
              type: "notice",
              id: "notice-1",
              sequence: 1,
              createdAt: 1,
              notice: {
                kind: "tau.test.notice",
                version: 1,
                severity: "warn",
                subject: { type: "session" },
                presentation: {
                  title: "t".repeat(600),
                  content: Array.from({ length: 20 }, () => "x".repeat(5_000)),
                },
                data: {},
              },
            },
          ],
        },
      });
      await mkdir(directory, { recursive: true });
      await writeFile(
        join(directory, "c2Vzc2lvbi0x.json"),
        JSON.stringify({
          format: STORED_SESSION_DOCUMENT_FORMAT,
          version: 6,
          snapshot,
        }),
        "utf8",
      );

      const recovered = await store.loadSession("session-1");
      const presentation = recovered.timeline.items[0].notice.presentation;
      expect(presentation.title).toHaveLength(512);
      expect(presentation.content).toHaveLength(16);
      expect(presentation.content.every((entry) => entry.length <= 4_096)).toBe(true);
    });
  });

  it("normalizes terminal operation fields while migrating version 5", async () => {
    await withTempStore(async (store, directory) => {
      const snapshot = createSnapshot("session-1", "hello");
      const legacy = createVersionFiveSnapshot(snapshot);
      legacy.timeline.push({
        type: "operation",
        id: "operation-1",
        operation: {
          kind: "manual-compaction",
          status: "cancelled",
          startedAt: 1,
          summary: "legacy summary",
          data: { legacy: true },
        },
      });
      await mkdir(directory, { recursive: true });
      await writeFile(
        join(directory, "c2Vzc2lvbi0x.json"),
        JSON.stringify({
          format: STORED_SESSION_DOCUMENT_FORMAT,
          version: 5,
          snapshot: legacy,
        }),
        "utf8",
      );

      await expect(store.loadSession("session-1")).resolves.toEqual({
        ...snapshot,
        timeline: {
          epoch: 1,
          sequence: 2,
          items: [
            ...snapshot.timeline.items,
            {
              type: "operation",
              id: "operation-1",
              sequence: 2,
              createdAt: 1,
              operationId: "operation-1",
            },
          ],
        },
        operations: {
          "operation-1": {
            id: "operation-1",
            kind: "manual-compaction",
            status: "cancelled",
            startedAt: 1,
            finishedAt: 1,
            reason: "session-recovered",
          },
        },
      });
    });
  });

  it("migrates persisted blocked turn outcomes to ordered notices", async () => {
    await withTempStore(async (store, directory) => {
      const snapshot = createSnapshot("session-1", "hello");
      const legacy = createVersionFiveSnapshot(snapshot);
      legacy.messages.find((message) => message.id === "entry-1").turn = {
        status: "blocked",
        reason: "auto-compaction-failed",
        message: "summary unavailable",
      };
      await mkdir(directory, { recursive: true });
      await writeFile(
        join(directory, "c2Vzc2lvbi0x.json"),
        JSON.stringify({
          format: STORED_SESSION_DOCUMENT_FORMAT,
          version: 5,
          snapshot: legacy,
        }),
        "utf8",
      );

      await expect(store.loadSession("session-1")).resolves.toEqual({
        ...snapshot,
        timeline: {
          epoch: 1,
          sequence: 2,
          items: [
            ...snapshot.timeline.items,
            {
              type: "notice",
              id: "recovered-turn-blocked-entry-1",
              sequence: 2,
              createdAt: 0,
              notice: {
                kind: "tau.turn.blocked",
                version: 1,
                severity: "error",
                subject: { type: "message", id: "entry-1" },
                presentation: {
                  title: "turn blocked",
                  content: ["summary unavailable"],
                },
                data: { reason: "auto-compaction-failed" },
              },
            },
          ],
        },
      });
    });
  });

  it("migrates persisted failed turn outcomes to ordered notices", async () => {
    await withTempStore(async (store, directory) => {
      const snapshot = createSnapshot("session-1", "hello");
      const legacy = createVersionFiveSnapshot(snapshot);
      legacy.messages.find((message) => message.id === "entry-1").turn = {
        status: "failed",
        stopReason: "error",
        errorMessage: "model attempt limit reached",
      };
      await mkdir(directory, { recursive: true });
      await writeFile(
        join(directory, "c2Vzc2lvbi0x.json"),
        JSON.stringify({
          format: STORED_SESSION_DOCUMENT_FORMAT,
          version: 5,
          snapshot: legacy,
        }),
        "utf8",
      );

      await expect(store.loadSession("session-1")).resolves.toMatchObject({
        messages: snapshot.messages,
        timeline: {
          sequence: 2,
          items: [
            snapshot.timeline.items[0],
            {
              type: "notice",
              id: "recovered-turn-failed-entry-1",
              sequence: 2,
              notice: {
                kind: "tau.turn.failed",
                subject: { type: "message", id: "entry-1" },
                presentation: {
                  title: "turn failed",
                  content: ["model attempt limit reached"],
                },
                data: { reason: "recovered-turn-failure" },
              },
            },
          ],
        },
      });
    });
  });

  it("drops persisted completed turn outcomes", async () => {
    await withTempStore(async (store, directory) => {
      const snapshot = createSnapshot("session-1", "hello");
      const legacy = createVersionFiveSnapshot(snapshot);
      legacy.messages.find((message) => message.id === "entry-1").turn = {
        status: "completed",
        stopReason: "stop",
      };
      await mkdir(directory, { recursive: true });
      await writeFile(
        join(directory, "c2Vzc2lvbi0x.json"),
        JSON.stringify({
          format: STORED_SESSION_DOCUMENT_FORMAT,
          version: 5,
          snapshot: legacy,
        }),
        "utf8",
      );

      await expect(store.loadSession("session-1")).resolves.toEqual(snapshot);
    });
  });

  it("does not duplicate persisted failures represented by an assistant error", async () => {
    await withTempStore(async (store, directory) => {
      const snapshot = createProtocolSnapshot({
        sessionId: "session-1",
        historyEntries: [
          {
            id: "entry-1",
            message: { role: "user", content: [{ type: "text", text: "hello" }] },
          },
          {
            id: "entry-2",
            message: {
              role: "assistant",
              content: [],
              provider: "openai",
              model: "gpt-5.5",
              stopReason: "error",
              errorMessage: "provider unavailable",
            },
          },
        ],
      });
      const legacy = createVersionFiveSnapshot(snapshot);
      legacy.messages.find((message) => message.id === "entry-1").turn = {
        status: "failed",
        stopReason: "error",
        errorMessage: "provider unavailable",
      };
      await mkdir(directory, { recursive: true });
      await writeFile(
        join(directory, "c2Vzc2lvbi0x.json"),
        JSON.stringify({
          format: STORED_SESSION_DOCUMENT_FORMAT,
          version: 5,
          snapshot: legacy,
        }),
        "utf8",
      );

      await expect(store.loadSession("session-1")).resolves.toEqual(snapshot);
    });
  });

  it("rejects noncanonical current-version snapshots", async () => {
    await withTempStore(async (store, directory) => {
      const legacy = createVersionFiveSnapshot(createSnapshot("session-1", "hello"));
      await mkdir(directory, { recursive: true });
      await writeFile(
        join(directory, "c2Vzc2lvbi0x.json"),
        JSON.stringify({
          format: STORED_SESSION_DOCUMENT_FORMAT,
          version: STORED_SESSION_DOCUMENT_VERSION,
          snapshot: legacy,
        }),
        "utf8",
      );

      await expect(store.loadSession("session-1")).rejects.toThrow(
        "stored session snapshot is invalid: session-1",
      );
    });
  });

  it("rejects stored sessions written by a newer storage version", async () => {
    await withTempStore(async (store, directory) => {
      await mkdir(directory, { recursive: true });
      await writeFile(
        join(directory, "c2Vzc2lvbi0x.json"),
        JSON.stringify({
          format: STORED_SESSION_DOCUMENT_FORMAT,
          version: STORED_SESSION_DOCUMENT_VERSION + 1,
          snapshot: createSnapshot("session-1", "future"),
        }),
        "utf8",
      );

      await expect(store.loadSession("session-1")).rejects.toThrow(
        "stored session was created by a newer Tau version",
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
        JSON.stringify({
          format: STORED_SESSION_DOCUMENT_FORMAT,
          version: STORED_SESSION_DOCUMENT_VERSION,
          snapshot: createSnapshot("session-2", "wrong"),
        }),
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
          format: STORED_SESSION_DOCUMENT_FORMAT,
          version: STORED_SESSION_DOCUMENT_VERSION,
          snapshot: {
            ...createSnapshot("session-1", "entry"),
            settings: "invalid",
          },
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
      const previousUmask = process.umask(0o777);
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
