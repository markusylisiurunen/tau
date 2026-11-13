import { spawn } from "node:child_process";
import { once } from "node:events";
import { access, chmod, mkdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { splitTauUserText } from "../dist/core/utils/user_metadata.js";
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
  it("excludes another process and recovers ownership after its exit", async () => {
    await withTempStore(async (store, directory) => {
      const child = spawn(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          `
        import { FileSessionStore } from ${JSON.stringify(new URL("../dist/store/file_session_store.js", import.meta.url).href)};
        const store = new FileSessionStore({ directory: process.argv[1] });
        await store.acquireSession("leased");
        process.stdout.write("ready");
        setInterval(() => {}, 1000);
      `,
          directory,
        ],
        { stdio: ["ignore", "pipe", "pipe"] },
      );
      try {
        await once(child.stdout, "data");
        await expect(store.acquireSession("leased")).rejects.toThrow("already in use");
        const exited = once(child, "exit");
        child.kill("SIGKILL");
        await exited;
        const releases = await Promise.allSettled([
          store.acquireSession("leased"),
          new FileSessionStore({ directory }).acquireSession("leased"),
        ]);
        expect(releases.filter((result) => result.status === "fulfilled")).toHaveLength(1);
        for (const result of releases) if (result.status === "fulfilled") await result.value();
        const release = await store.acquireSession("leased");
        await release();
      } finally {
        if (child.exitCode === null && child.signalCode === null) {
          const exited = once(child, "exit");
          child.kill("SIGKILL");
          await exited;
        }
      }
    });
  });

  it.each([true, false])(
    "preserves compacted goal history and unrelated metadata from version 10 (marker: %s)",
    async (withMarker) => {
      await withTempStore(async (store, directory) => {
        const summary = "The earlier objective was shipped using update_goal.";
        const metadata = [
          { type: "compaction", version: 1, summary },
          ...(withMarker ? [{ type: "goal-turn", version: 1 }] : []),
        ];
        const encoded = Buffer.from(JSON.stringify(metadata)).toString("base64url");
        const text = `\u001eTAU_METADATA_V1:${encoded}\u001e${summary}`;
        const snapshot = createSnapshot("old-compacted-goal", text);
        snapshot.goal = null;
        await mkdir(directory, { recursive: true });
        await writeFile(
          join(directory, `${Buffer.from(snapshot.sessionId).toString("base64url")}.json`),
          JSON.stringify({ format: STORED_SESSION_DOCUMENT_FORMAT, version: 10, snapshot }),
        );
        const loaded = await store.loadSession(snapshot.sessionId);
        expect(loaded).not.toHaveProperty("goal");
        const entry = loaded.messages.find((message) => message.id === "entry-1");
        const projected = splitTauUserText(entry.message.content[0].text);
        expect(projected.metadata).toEqual([{ type: "compaction", version: 1, summary }]);
        expect(projected.modelText).toBe(summary);
        const retirement = loaded.messages.at(-1).message;
        expect(retirement.role).toBe("user");
        const instruction = splitTauUserText(retirement.content);
        expect(instruction.hiddenSystemBlocks).toHaveLength(1);
        expect(instruction.displayText).toBe("");
        expect(loaded.messages).toHaveLength(snapshot.messages.length + 1);
        expect(loaded.timeline).toEqual(snapshot.timeline);
      });
    },
  );

  it("normalizes obsolete Fly selection and presentation metadata from version 9", async () => {
    await withTempStore(async (store, directory) => {
      await mkdir(directory, { recursive: true });
      const snapshot = createSnapshot("legacy-fly", "recoverable text");
      snapshot.executionEnvironment = {
        kind: "fly-sprite",
        apiId: "old-api",
        spriteName: "existing",
        cwd: "/repo",
        home: "/home/sprite",
      };
      delete snapshot.catalog.mcpServers;
      snapshot.catalog.prompts = [{ id: "review", description: "old description" }];
      for (const persona of snapshot.catalog.personas) persona.skills = ["old-selection"];
      await writeFile(
        join(directory, `${Buffer.from(snapshot.sessionId).toString("base64url")}.json`),
        JSON.stringify({ format: STORED_SESSION_DOCUMENT_FORMAT, version: 9, snapshot }),
      );
      const loaded = await store.loadSession(snapshot.sessionId);
      expect(loaded.messages).toEqual(snapshot.messages);
      expect(loaded.executionEnvironment).toEqual({
        kind: "fly-sprite",
        spriteName: "existing",
        cwd: "/repo",
        home: "/home/sprite",
      });
      expect(loaded.catalog.prompts).toEqual([{ id: "review", label: "review" }]);
      expect(loaded.catalog.mcp).toEqual({ status: "unavailable", reason: "remote-execution" });
      expect(loaded.catalog.speechVocabulary).toEqual([]);
      for (const persona of loaded.catalog.personas) expect(persona).not.toHaveProperty("skills");
    });
  });

  it("persists, loads, and lists snapshots", async () => {
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

      await expect(store.loadSession("session-two")).resolves.toEqual(
        createSnapshot("session-two", "hi", 2),
      );
    });
  });

  it("migrates retired worker selections without changing conversation messages", async () => {
    await withTempStore(async (store, directory) => {
      const snapshot = createSnapshot("session-1", "retained conversation");
      snapshot.catalog.personas[0].tools = [
        "bash",
        "spawn_agent",
        "list_agents",
        "wait_for_agents",
      ];
      await mkdir(directory, { recursive: true });
      await writeFile(
        join(directory, "c2Vzc2lvbi0x.json"),
        JSON.stringify({ format: STORED_SESSION_DOCUMENT_FORMAT, version: 12, snapshot }),
      );
      const loaded = await store.loadSession("session-1");
      expect(loaded.catalog.personas[0].tools).toEqual(["bash", "agents"]);
      expect(loaded.messages).toEqual(snapshot.messages);
    });
  });

  it("loads version 2 sessions", async () => {
    await withTempStore(async (store, directory) => {
      const snapshot = createSnapshot("session-1", "hello");
      const versionTwoSnapshot = createVersionFiveSnapshot(snapshot);
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
        turns: {
          "entry-1": {
            userHistoryEntryId: "entry-1",
            state: "settled",
            outcome: legacy.messages.find((message) => message.id === "entry-1").turn,
          },
        },
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

      snapshot.turns["entry-1"] = {
        userHistoryEntryId: "entry-1",
        state: "settled",
        outcome: legacy.messages.find((message) => message.id === "entry-1").turn,
      };
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
      await expect(store.loadSession("session-1")).resolves.toEqual(
        createSnapshot("session-1", "updated", 2),
      );
    });
  });

  it("recovers a lock owned by a process that no longer exists", async () => {
    await withTempStore(async (store, directory) => {
      const lockPath = join(directory, "c2Vzc2lvbi0x.json.lock");
      await mkdir(lockPath, { recursive: true });
      await writeFile(
        join(lockPath, "owner.json"),
        JSON.stringify({
          pid: 2_147_483_647,
          processIdentity: "exited-owner",
          token: "stale-owner",
          createdAt: 1,
        }),
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

  it("recovers a session lease whose PID belongs to a different process", async () => {
    await withTempStore(async (store, directory) => {
      const leasePath = join(directory, "c2Vzc2lvbi0x.json.lease");
      await mkdir(leasePath, { recursive: true });
      await writeFile(
        join(leasePath, "owner.json"),
        JSON.stringify({
          pid: process.pid,
          processIdentity: "previous-process",
          token: "stale-owner",
          createdAt: 1,
        }),
      );
      const release = await store.acquireSession("session-1");
      await expect(store.acquireSession("session-1")).rejects.toThrow("already in use");
      await release();
      await expect(access(leasePath)).rejects.toMatchObject({ code: "ENOENT" });
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

  it("cleans store-owned snapshot temporaries on startup and commit", async () => {
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
      const commitTemp = join(
        directory,
        "c2Vzc2lvbi0x.json.100.200.00000000-0000-4000-8000-000000000002.tmp",
      );
      await writeFile(commitTemp, "stale", { mode: 0o600 });

      await store.commitSessionSnapshot(createSnapshot("session-1", "updated", 2));
      await expect(access(commitTemp)).rejects.toMatchObject({ code: "ENOENT" });
    });
  });
});
