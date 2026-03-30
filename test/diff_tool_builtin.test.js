import { once } from "node:events";
import { createServer as createHttpServer } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { DiffReviewSession } from "../src/core/diff_review/session.ts";
import { DiffReviewSnapshot } from "../src/core/diff_review/snapshot.ts";
import { personas } from "../src/core/personas.ts";
import {
  DiffReviewProtocolClient,
  DiffToolHttpServer,
  parseDiffToolLaunchEnvironment,
} from "../src/diff_tool/index.ts";

function createSnapshot() {
  return new DiffReviewSnapshot({
    repoRoot: "/repo",
    cwd: "/repo/packages/app",
    diffArgs: ["--staged"],
    patch: [
      "diff --git a/src/a.ts b/src/a.ts",
      "--- a/src/a.ts",
      "+++ b/src/a.ts",
      "@@ -1 +1 @@",
      "-export const a = 1;",
      "+export const a = 2;",
      "diff --git a/src/b.ts b/src/b.ts",
      "deleted file mode 100644",
      "--- a/src/b.ts",
      "+++ /dev/null",
    ].join("\n"),
    files: [
      { path: "src/a.ts", status: "modified", newPath: "src/a.ts" },
      { path: "src/b.ts", status: "deleted", oldPath: "src/b.ts" },
    ],
    patchByPath: new Map([
      [
        "src/a.ts",
        [
          "diff --git a/src/a.ts b/src/a.ts",
          "--- a/src/a.ts",
          "+++ b/src/a.ts",
          "@@ -1 +1 @@",
          "-export const a = 1;",
          "+export const a = 2;",
        ].join("\n"),
      ],
      [
        "src/b.ts",
        [
          "diff --git a/src/b.ts b/src/b.ts",
          "deleted file mode 100644",
          "--- a/src/b.ts",
          "+++ /dev/null",
        ].join("\n"),
      ],
    ]),
  });
}

async function fetchJson(url, init) {
  const response = await fetch(url, init);
  const payload = await response.json();
  expect(response.ok).toBe(true);
  return payload;
}

function createClientStub(overrides = {}) {
  const closeListeners = new Set();
  return {
    connect: vi.fn(async () => {}),
    getContext: vi.fn(async () => ({
      sessionId: "session-1",
      repoRoot: "/repo",
      cwd: "/repo",
      diffArgs: [],
      diffCommand: "git diff",
    })),
    listFiles: vi.fn(async () => ({ files: [] })),
    setUiText: vi.fn(async () => ({ status: "updated" })),
    close: vi.fn(async () => {
      for (const listener of closeListeners) {
        listener();
      }
    }),
    cancelSession: vi.fn(async () => ({ status: "cancelled" })),
    onClose: vi.fn((listener) => {
      closeListeners.add(listener);
      return () => {
        closeListeners.delete(listener);
      };
    }),
    ...overrides,
  };
}

describe("built-in diff tool", () => {
  it("persists review state on the server and returns the composed review to Tau", async () => {
    const threadMessages = new Map();
    const session = new DiffReviewSession({
      snapshot: createSnapshot(),
      persona: personas[0],
      config: {},
      createThread: (threadId) => ({
        async submitMessage(message) {
          const messages = threadMessages.get(threadId) ?? [];
          messages.push(message);
          threadMessages.set(threadId, messages);
          return `reply ${threadId} #${messages.length}: ${message}`;
        },
        interrupt() {
          return false;
        },
      }),
    });

    await session.start();
    const client = new DiffReviewProtocolClient(
      parseDiffToolLaunchEnvironment(session.launchEnvironment),
    );
    const server = new DiffToolHttpServer({ client });

    try {
      const started = await server.start();
      expect(session.getUiState()).toEqual({
        diffToolUiText: `browser diff tool: ${started.url}`,
        reviewAgent: { status: "idle" },
      });

      const bootstrap = await fetchJson(`${started.url}/api/bootstrap`);
      expect(bootstrap.context).toEqual({
        sessionId: session.sessionId,
        repoRoot: "/repo",
        cwd: "/repo/packages/app",
        diffArgs: ["--staged"],
        diffCommand: "git diff --staged",
      });
      expect(bootstrap.files).toEqual([
        { path: "src/a.ts", status: "modified", newPath: "src/a.ts" },
        { path: "src/b.ts", status: "deleted", oldPath: "src/b.ts" },
      ]);
      expect(bootstrap.state).toEqual({
        diffStyle: "split",
        sidebarOpen: false,
        collapsedFileIds: [],
        viewedFileIds: [],
        threads: [],
      });

      const wholeDiff = await fetchJson(`${started.url}/api/diff`);
      expect(wholeDiff).toEqual({
        scope: "session",
        patch: createSnapshot().patch,
      });

      const fileDiff = await fetchJson(`${started.url}/api/diff?path=src%2Fa.ts`);
      expect(fileDiff).toEqual({
        scope: "file",
        path: "src/a.ts",
        patch: createSnapshot().getFilePatch("src/a.ts"),
      });

      const updatedState = await fetchJson(`${started.url}/api/state`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sidebarOpen: true,
          viewedFileIds: ["src/a.ts::0"],
          collapsedFileIds: ["src/a.ts::0"],
          diffStyle: "unified",
        }),
      });
      expect(updatedState.state).toMatchObject({
        sidebarOpen: true,
        viewedFileIds: ["src/a.ts::0"],
        collapsedFileIds: ["src/a.ts::0"],
        diffStyle: "unified",
      });

      const createdThread = await fetchJson(`${started.url}/api/thread`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          fileId: "src/a.ts::0",
          filePath: "src/a.ts",
          lineNumber: 1,
          side: "additions",
          body: "What changed?",
        }),
      });
      const thread = createdThread.state.threads[0];
      expect(thread).toMatchObject({
        fileId: "src/a.ts::0",
        filePath: "src/a.ts",
        lineNumber: 1,
        side: "additions",
        messages: [{ role: "user", text: "What changed?" }],
        loading: false,
      });

      const repliedThread = await fetchJson(`${started.url}/api/thread/reply`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          id: thread.id,
          text: "Any risks?",
        }),
      });
      expect(repliedThread.state.threads[0].messages).toEqual([
        { role: "user", text: "What changed?" },
        { role: "user", text: "Any risks?" },
      ]);

      const askedThread = await fetchJson(`${started.url}/api/thread-message`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: thread.id }),
      });
      expect(askedThread.state.threads[0]).toEqual({
        id: thread.id,
        threadId: expect.stringMatching(/^thread-/),
        fileId: "src/a.ts::0",
        filePath: "src/a.ts",
        lineNumber: 1,
        side: "additions",
        messages: [
          { role: "user", text: "What changed?" },
          { role: "user", text: "Any risks?" },
          {
            role: "assistant",
            text: expect.stringMatching(/^reply thread-.* #1: \[src\/a\.ts:1 \(new\)\]/),
          },
        ],
        loading: false,
      });
      expect(threadMessages.get(askedThread.state.threads[0].threadId)).toEqual([
        "[src/a.ts:1 (new)]\n\nWhat changed?\n\nAny risks?",
      ]);

      const refreshedBootstrap = await fetchJson(`${started.url}/api/bootstrap`);
      expect(refreshedBootstrap.state).toEqual(askedThread.state);

      const reviewResult = await fetchJson(`${started.url}/api/review`, {
        method: "POST",
        headers: { "content-type": "application/json" },
      });
      expect(reviewResult).toEqual({ status: "returned" });
      await expect(session.result).resolves.toEqual({
        status: "returned",
        review:
          "## thread 1\n\n`src/a.ts:1 (new)`\n\n**user**\n\nWhat changed?\n\n**user**\n\nAny risks?\n\n**agent**\n\n" +
          askedThread.state.threads[0].messages[2].text,
      });
      await server.waitUntilClosed();
    } finally {
      await server.close();
      await session.close();
    }
  });

  it("shuts down the browser demo when Tau cancels the session externally", async () => {
    const session = new DiffReviewSession({
      snapshot: createSnapshot(),
      persona: personas[0],
      config: {},
      createThread: () => ({
        async submitMessage(message) {
          return message;
        },
        interrupt() {
          return false;
        },
      }),
    });

    await session.start();
    const client = new DiffReviewProtocolClient(
      parseDiffToolLaunchEnvironment(session.launchEnvironment),
    );
    const server = new DiffToolHttpServer({ client });

    try {
      await server.start();

      await session.cancel("controller_cancelled");
      await server.waitUntilClosed();
    } finally {
      await server.close();
      await session.close();
    }
  });

  it("closes the protocol client when startup fails after the protocol connection is open", async () => {
    const client = createClientStub({
      setUiText: vi.fn(async () => {
        throw new Error("ui text failed");
      }),
    });
    const server = new DiffToolHttpServer({ client });

    await expect(server.start()).rejects.toThrow("ui text failed");
    expect(client.connect).toHaveBeenCalledTimes(1);
    expect(client.getContext).toHaveBeenCalledTimes(1);
    expect(client.listFiles).toHaveBeenCalledTimes(1);
    expect(client.setUiText).toHaveBeenCalledTimes(1);
    expect(client.close).toHaveBeenCalledTimes(1);
    await server.waitUntilClosed();
  });

  it("tears down partial startup state when the http server fails to bind", async () => {
    const occupied = createHttpServer(() => {});
    occupied.listen(0, "127.0.0.1");
    await once(occupied, "listening");
    const address = occupied.address();
    if (!address || typeof address === "string") {
      throw new Error("failed to resolve occupied test port");
    }

    const client = createClientStub();
    const server = new DiffToolHttpServer({ client, host: "127.0.0.1", port: address.port });

    try {
      await expect(server.start()).rejects.toThrow();
      expect(client.connect).toHaveBeenCalledTimes(1);
      expect(client.getContext).toHaveBeenCalledTimes(1);
      expect(client.listFiles).toHaveBeenCalledTimes(1);
      expect(client.setUiText).not.toHaveBeenCalled();
      expect(client.close).toHaveBeenCalledTimes(1);
      await server.waitUntilClosed();
    } finally {
      await new Promise((resolve, reject) => {
        occupied.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve(undefined);
        });
      });
    }
  });
});
