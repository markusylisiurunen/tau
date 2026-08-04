import { describe, expect, it, vi } from "vitest";
import { resolveHistoryRemoteTarget } from "../dist/core/history/config.js";
import { LocalHistoryStore } from "../dist/core/history/local_history_store.js";
import { RemoteHistoryClient } from "../dist/core/history/remote_history_client.js";
import {
  assistantHistoryEntries,
  toolHistoryEntry,
  userHistoryEntry,
} from "../dist/core/history/transcript.js";
import { createHistoryToolDefinition, HISTORY_TOOL } from "../dist/core/tools/history.js";
import {
  applyOperation,
  generateDigest,
  isDigestContextOverflowError,
  projectDigestEntry,
  runAi,
  selectHistoryReadPage,
} from "../dist/history/worker/index.js";
import {
  batchImportOperations,
  buildImportOperations,
  snapshotToHistoryEntries,
} from "../scripts/import-session-snapshots.js";

function createTextEntry(id, type, content, timestamp) {
  return { id, sourceIds: [id], type, content, timestamp };
}

function createBackend() {
  return {
    runNodeScript: vi.fn(),
    runBash: vi.fn(),
    writeFile: vi.fn(),
  };
}

async function runTool(tool, code) {
  return await tool.execute(
    { id: "history-1", name: "history", arguments: { code } },
    {
      agentId: "test-agent",
      turnId: "test-turn",
      assistantMessageId: "test-assistant",
      signal: new AbortController().signal,
      emitActivity: async () => {},
    },
  );
}

function toolText(result) {
  return result.content.find((item) => item.type === "text")?.text ?? "";
}

function createD1Harness() {
  const prepared = [];
  const database = {
    exec: vi.fn(),
    prepare: vi.fn((query) => {
      const statement = {
        query,
        values: [],
        bind(...values) {
          this.values = values;
          return this;
        },
        first: vi.fn(async () => {
          if (query.includes("FROM operations")) return null;
          if (query.includes("SELECT attributes_json")) return null;
          if (query.includes("SELECT 1 AS found FROM sessions")) return { found: 1 };
          if (query.includes("MAX(position)")) return { position: 0 };
          if (query.includes("SELECT 1 AS found FROM entries")) return null;
          if (query.includes("SELECT position FROM entries")) return { position: 1 };
          return null;
        }),
        all: vi.fn(async () => ({ results: [] })),
        run: vi.fn(async () => {
          throw new Error("mutations must execute through batch");
        }),
      };
      prepared.push(statement);
      return statement;
    }),
    batch: vi.fn(async (statements) => statements.map(() => ({ success: true }))),
  };
  return { database, prepared };
}

describe("session history", () => {
  it("stores, searches, reads, and truncates active transcripts", async () => {
    const store = new LocalHistoryStore(":memory:");
    try {
      store.createSession({
        sessionId: "session-1",
        attributes: { source: "test", repository: "github.com/example/repo" },
        createdAt: 100,
      });
      store.createSession({
        sessionId: "session-2",
        attributes: { source: "other" },
        createdAt: 200,
      });
      store.append("session-1", [
        createTextEntry("user-1", "user", "design durable history", 110),
        createTextEntry("assistant-1", "assistant", "use sqlite locally", 120),
        {
          id: "tool-1",
          sourceIds: ["assistant-call", "tool-result"],
          type: "tool",
          timestamp: 130,
          name: "bash",
          arguments: { command: "git status" },
          result: [{ type: "text", text: "clean" }],
          outcome: "succeeded",
        },
      ]);
      store.append("session-2", [createTextEntry("user-2", "user", "unrelated", 210)]);

      await expect(
        store.search({
          query: "sqlite",
          attributes: { repository: "github.com/example/repo" },
          limit: 10,
        }),
      ).resolves.toMatchObject({
        sessions: [
          {
            sessionId: "session-1",
            attributes: { source: "test", repository: "github.com/example/repo" },
          },
        ],
      });
      const firstPage = await store.read({ sessionId: "session-1", limit: 2 });
      expect(firstPage.entries.map((entry) => entry.id)).toEqual(["user-1", "assistant-1"]);
      expect(firstPage.nextCursor).toEqual(expect.any(String));
      await expect(
        store.read({ sessionId: "session-1", limit: 2, cursor: firstPage.nextCursor }),
      ).resolves.toMatchObject({ entries: [{ id: "tool-1", type: "tool" }] });

      store.truncateFromSources("session-1", ["assistant-call"]);
      await expect(store.read({ sessionId: "session-1", limit: 10 })).resolves.toMatchObject({
        entries: [{ id: "user-1" }, { id: "assistant-1" }],
      });
    } finally {
      store.close();
    }
  });

  it("projects committed messages into flat text and completed-tool entries", () => {
    const user = userHistoryEntry("user-1", {
      role: "user",
      content: "<system>instruction</system>\nrequest",
      timestamp: 100,
    });
    expect(user).toMatchObject({
      id: "user-1",
      type: "user",
      content: "<system>instruction</system>\nrequest",
    });

    const assistant = assistantHistoryEntries("assistant-1", {
      role: "assistant",
      content: [
        { type: "thinking", thinking: "hidden" },
        { type: "text", text: "preamble" },
        { type: "toolCall", id: "call-1", name: "bash", arguments: { command: "pwd" } },
      ],
      timestamp: 110,
    });
    expect(assistant).toEqual([
      {
        id: "assistant-1:text:1",
        sourceIds: ["assistant-1"],
        type: "assistant",
        timestamp: 110,
        content: "preamble",
      },
    ]);

    expect(
      toolHistoryEntry({
        callHistoryEntryId: "assistant-1",
        resultHistoryEntryId: "result-1",
        call: { type: "toolCall", id: "call-1", name: "bash", arguments: { command: "pwd" } },
        result: {
          role: "toolResult",
          toolCallId: "call-1",
          toolName: "bash",
          content: [{ type: "text", text: "/repo" }],
          isError: false,
          timestamp: 120,
        },
        outcome: "succeeded",
      }),
    ).toMatchObject({
      id: "call-1",
      sourceIds: ["assistant-1", "result-1"],
      type: "tool",
      result: [{ type: "text", text: "/repo" }],
      outcome: "succeeded",
    });
  });

  it("best-effort snapshot import preserves identities, attributes, and transcript order", () => {
    const snapshot = {
      sessionId: "legacy-session",
      attributes: {},
      createdAt: 100,
      messages: [
        {
          id: "system-1",
          state: "committed",
          message: { role: "system", content: "prompt", timestamp: 100 },
        },
        {
          id: "user-1",
          state: "committed",
          message: { role: "user", content: "request", timestamp: 110 },
        },
        {
          id: "assistant-1",
          state: "committed",
          message: {
            role: "assistant",
            content: [
              { type: "text", text: "working" },
              { type: "toolCall", id: "call-1", name: "bash", arguments: { command: "pwd" } },
            ],
            timestamp: 120,
          },
        },
        {
          id: "result-1",
          state: "committed",
          message: {
            role: "toolResult",
            toolCallId: "call-1",
            toolName: "bash",
            content: [{ type: "text", text: "/repo" }],
            isError: false,
            timestamp: 130,
          },
        },
        {
          id: "discarded-1",
          state: "discarded",
          message: { role: "user", content: "discarded", timestamp: 140 },
        },
      ],
      tools: {
        "call-1": {
          id: "call-1",
          toolCallId: "call-1",
          toolName: "bash",
          facetIds: [],
          status: "succeeded",
          call: { messageId: "assistant-1", contentIndex: 1 },
          resultMessageId: "result-1",
        },
      },
    };

    const entries = snapshotToHistoryEntries(snapshot);
    expect(entries.map((entry) => entry.id)).toEqual(["user-1", "assistant-1:text:0", "call-1"]);
    const extraEntries = Array.from({ length: 24 }, (_, index) => ({
      id: `extra-${index}`,
      sourceIds: [`extra-${index}`],
      type: "user",
      timestamp: 140 + index,
      content: `extra ${index}`,
    }));
    const operations = buildImportOperations(snapshot, [...entries, ...extraEntries]);
    expect(operations).toHaveLength(3);
    expect(operations[0]).toMatchObject({
      id: expect.stringMatching(/^snapshot-import:[0-9a-f]{64}$/),
      type: "create",
      session: { attributes: {} },
    });
    expect(operations.slice(1).map((operation) => operation.entries.length)).toEqual([25, 2]);
    expect(buildImportOperations(snapshot, [...entries, ...extraEntries])).toEqual(operations);
    expect(batchImportOperations(operations)).toEqual([operations]);
  });

  it("keeps immutable attributes and idempotent entry identities", async () => {
    const store = new LocalHistoryStore(":memory:");
    try {
      const session = {
        sessionId: "session-1",
        attributes: { source: "test" },
        createdAt: 100,
      };
      store.createSession(session);
      store.createSession(session);
      const entry = createTextEntry("user-1", "user", "hello", 110);
      store.append("session-1", [entry]);
      store.append("session-1", [entry]);
      await expect(store.read({ sessionId: "session-1", limit: 10 })).resolves.toMatchObject({
        entries: [{ id: "user-1" }],
      });
      expect(() => store.createSession({ ...session, attributes: { source: "changed" } })).toThrow(
        "conflicting immutable data",
      );
    } finally {
      store.close();
    }
  });

  it("keeps full local entries while bounding remote replication by entry and operation bytes", async () => {
    const store = new LocalHistoryStore(":memory:");
    const remote = { endpoint: "https://history.example.com", apiKey: "secret" };
    try {
      store.createSession(
        { sessionId: "session-1", attributes: { source: "test" }, createdAt: 100 },
        remote,
      );
      const fullResult = `start ${"x".repeat(1_500_000)} end`;
      store.append(
        "session-1",
        [
          {
            id: "large-tool",
            sourceIds: ["assistant-1", "result-1"],
            type: "tool",
            timestamp: 110,
            name: "bash",
            arguments: { command: "diagnose" },
            result: [{ type: "text", text: fullResult }],
            outcome: "succeeded",
          },
        ],
        remote,
      );
      store.append(
        "session-1",
        Array.from({ length: 7 }, (_, index) =>
          createTextEntry(
            `large-${index}`,
            "assistant",
            `${index}${"y".repeat(900_000)}`,
            120 + index,
          ),
        ),
        remote,
      );

      const local = await store.read({ sessionId: "session-1", limit: 20 });
      expect(local.entries[0]).toMatchObject({
        id: "large-tool",
        result: [{ type: "text", text: fullResult }],
      });

      const operations = store
        .listPendingOperations(remote.endpoint, 20)
        .map((pending) => pending.operation)
        .filter((operation) => operation.type === "append");
      expect(operations.flatMap((operation) => operation.entries)).toHaveLength(8);
      for (const operation of operations) {
        expect(Buffer.byteLength(JSON.stringify(operation), "utf8")).toBeLessThanOrEqual(
          6 * 1024 * 1024,
        );
        for (const entry of operation.entries) {
          expect(Buffer.byteLength(JSON.stringify(entry), "utf8")).toBeLessThanOrEqual(1024 * 1024);
        }
      }
      const remoteTool = operations
        .flatMap((operation) => operation.entries)
        .find((entry) => entry.id === "large-tool");
      expect(remoteTool).toMatchObject({
        id: "large-tool",
        sourceIds: ["assistant-1", "result-1"],
        type: "tool",
        outcome: "succeeded",
      });
      expect(remoteTool.result).toEqual(expect.stringContaining("start"));
      expect(remoteTool.result).toEqual(expect.stringContaining("end"));
      expect(remoteTool.result).toEqual(expect.stringContaining("middle-truncated"));
    } finally {
      store.close();
    }
  });

  it("paginates remote reads by payload bytes and requested entry count", () => {
    expect(
      selectHistoryReadPage(
        Array.from({ length: 20 }, () => ({ payload_bytes: 1024 * 1024 })),
        20,
      ),
    ).toEqual({ count: 11, hasMore: true });
    expect(
      selectHistoryReadPage(
        Array.from({ length: 101 }, () => ({ payload_bytes: 100 })),
        100,
      ),
    ).toEqual({ count: 100, hasMore: true });
    expect(selectHistoryReadPage([{ payload_bytes: 20 * 1024 * 1024 }], 1)).toEqual({
      count: 1,
      hasMore: false,
    });
  });

  it("commits every remote replication operation through one D1 batch", async () => {
    const operations = [
      {
        id: "create-1",
        sessionId: "session-1",
        type: "create",
        session: {
          sessionId: "session-1",
          attributes: { source: "test" },
          createdAt: 100,
        },
      },
      {
        id: "append-1",
        sessionId: "session-1",
        type: "append",
        entries: [createTextEntry("user-1", "user", "hello", 110)],
      },
      {
        id: "truncate-1",
        sessionId: "session-1",
        type: "truncate",
        afterEntryId: "user-1",
      },
    ];

    for (const operation of operations) {
      const harness = createD1Harness();
      await expect(applyOperation(harness.database, operation)).resolves.toBe(true);
      expect(harness.database.batch).toHaveBeenCalledOnce();
      const batched = harness.database.batch.mock.calls[0][0];
      expect(batched.length).toBeGreaterThan(1);
      expect(batched.at(-1).query).toContain("INSERT INTO operations");
      expect(harness.prepared.every((statement) => statement.run.mock.calls.length === 0)).toBe(
        true,
      );
    }
  });

  it("generates digests with GPT-5.6 Luna at medium reasoning effort", async () => {
    const ai = {
      run: vi.fn(async () => '{"title":"History","summary":"Durable transcript work"}'),
    };

    await expect(runAi(ai, "transcript material")).resolves.toContain("Durable transcript work");
    expect(ai.run).toHaveBeenCalledWith("openai/gpt-5.6-luna", {
      input: "transcript material",
      instructions: "Produce concise, factually grounded Tau session digest material.",
      max_output_tokens: 1_024,
      reasoning: { effort: "medium" },
    });
  });

  it("projects small tool results intact and middle-truncates large results for digests", () => {
    const small = {
      id: "tool-small",
      sourceIds: ["tool-small"],
      type: "tool",
      timestamp: 1,
      name: "bash",
      arguments: { command: "pwd" },
      result: [{ type: "text", text: "short" }],
      outcome: "succeeded",
    };
    expect(projectDigestEntry(small)).toEqual(small);

    const large = {
      ...small,
      id: "tool-large",
      result: `start-${"x".repeat(10_000)}-end`,
    };
    const projected = projectDigestEntry(large);
    expect(projected.result).toContain("start-");
    expect(projected.result).toContain("-end");
    expect(projected.result).toContain("tokens middle-truncated for digest");
    expect(Buffer.byteLength(JSON.stringify(projected.result), "utf8")).toBeLessThanOrEqual(
      512 * 6,
    );
  });

  it("uses one full-transcript digest call when Luna accepts the context", async () => {
    const ai = {
      run: vi.fn(async () => '{"title":"Stable","summary":"Complete"}'),
    };

    await expect(
      generateDigest(ai, "complete transcript", { title: "Old", summary: "Prior wording" }),
    ).resolves.toEqual({ title: "Stable", summary: "Complete" });
    expect(ai.run).toHaveBeenCalledOnce();
    expect(ai.run.mock.calls[0][1].input).toContain("complete transcript");
    expect(ai.run.mock.calls[0][1].input).toContain("Prior wording");
  });

  it("recursively halves context overflow at most three levels before final synthesis", async () => {
    const ai = {
      run: vi.fn(async (_model, request) => {
        const segments = [...new Set(request.input.match(/segment-\d+/g) ?? [])];
        if (request.input.includes("Generate a complete replacement digest")) {
          if (!request.input.includes("leaf-summary:")) {
            throw { code: 3006, status: 413, message: "Request too large" };
          }
          return JSON.stringify({ title: "Split", summary: segments.join(",") });
        }
        if (segments.length > 1) {
          const error = new Error("context window exceeded");
          error.name = "BadInput";
          throw error;
        }
        return `leaf-summary:${segments[0]}`;
      }),
    };
    const transcript = Array.from({ length: 8 }, (_, index) => `segment-${index + 1}`).join("\n");

    await expect(generateDigest(ai, transcript)).resolves.toEqual({
      title: "Split",
      summary: "segment-1,segment-2,segment-3,segment-4,segment-5,segment-6,segment-7,segment-8",
    });
    expect(ai.run).toHaveBeenCalledTimes(16);
  });

  it("recognizes only documented or narrowly identified digest context overflow errors", () => {
    expect(isDigestContextOverflowError({ code: 3006 })).toBe(true);
    expect(isDigestContextOverflowError({ status: 413 })).toBe(true);
    expect(
      isDigestContextOverflowError(Object.assign(new Error("bad input"), { name: "BadInput" })),
    ).toBe(true);
    expect(isDigestContextOverflowError(new Error("maximum input tokens exceeded"))).toBe(true);
    expect(isDigestContextOverflowError("context_length_exceeded")).toBe(true);
    expect(isDigestContextOverflowError({ code: 3007, status: 408, message: "timeout" })).toBe(
      false,
    );
  });

  it("uses explicit remote configuration without exposing its API key to code mode", async () => {
    expect(
      resolveHistoryRemoteTarget(
        { history: { endpoint: "https://history.example.com", apiKeyEnv: "HISTORY_SECRET" } },
        { HISTORY_SECRET: " remote-key " },
      ),
    ).toEqual({ endpoint: "https://history.example.com", apiKey: "remote-key" });
    expect(
      resolveHistoryRemoteTarget(
        { history: { endpoint: "https://history.example.com", apiKeyEnv: "HISTORY_SECRET" } },
        { TAU_HISTORY_API_KEY: "standard-key", HISTORY_SECRET: "custom-key" },
      ),
    ).toEqual({ endpoint: "https://history.example.com", apiKey: "standard-key" });

    const fetchImpl = vi.fn(async (_url, options) => {
      expect(options.headers.authorization).toBe("Bearer remote-key");
      return new Response(JSON.stringify({ sessions: [] }), {
        headers: { "content-type": "application/json" },
      });
    });
    const client = new RemoteHistoryClient(
      { endpoint: "https://history.example.com", apiKey: "remote-key" },
      fetchImpl,
    );
    await expect(client.search({ limit: 10 })).resolves.toEqual({ sessions: [] });
  });

  it("exposes bounded search and read through one read-only code-mode tool", async () => {
    expect(HISTORY_TOOL.description).toContain("read-only");
    const history = {
      search: vi.fn(async () => ({
        sessions: [
          {
            sessionId: "session-1",
            attributes: { source: "test" },
            createdAt: 100,
            updatedAt: 120,
            snippets: [],
          },
        ],
      })),
      read: vi.fn(async () => {
        throw new Error("not used");
      }),
    };
    const tool = createHistoryToolDefinition(createBackend(), history);
    const result = await runTool(
      tool,
      'const page = await history.search({ query: "sqlite" }); console.log(page.sessions[0].sessionId);',
    );

    expect(toolText(result)).toContain("session-1");
    expect(history.search).toHaveBeenCalledWith(
      { query: "sqlite", limit: 10 },
      expect.any(AbortSignal),
    );
  });
});
