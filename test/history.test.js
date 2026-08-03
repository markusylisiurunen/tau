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
import { runAi } from "../dist/history/worker/index.js";
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

  it("uses explicit remote configuration without exposing its API key to code mode", async () => {
    expect(
      resolveHistoryRemoteTarget(
        { history: { endpoint: "https://history.example.com", apiKeyEnv: "HISTORY_SECRET" } },
        { HISTORY_SECRET: " remote-key " },
      ),
    ).toEqual({ endpoint: "https://history.example.com", apiKey: "remote-key" });

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
