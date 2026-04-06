import { once } from "node:events";
import { createConnection } from "node:net";
import { createInterface } from "node:readline";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DIFF_REVIEW_PROTOCOL_VERSION } from "../src/core/diff_review/protocol.ts";
import { DiffReviewSession } from "../src/core/diff_review/session.ts";
import { DiffReviewSnapshot } from "../src/core/diff_review/snapshot.ts";
import { personas } from "../src/core/personas.ts";

function request(id, method, params) {
  return JSON.stringify({
    version: DIFF_REVIEW_PROTOCOL_VERSION,
    type: "request",
    id,
    method,
    params,
  });
}

function createEmptyUsage(contextWindow = 200_000) {
  return {
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    contextWindowUsageTokens: 0,
    contextWindow,
  };
}

function createThreadSession(overrides = {}, contextWindow = 200_000) {
  return {
    async submitMessage() {
      return "review reply";
    },
    interrupt() {
      return false;
    },
    createForkSource() {
      return {
        historyEntries: [],
        usageBaseline: createEmptyUsage(contextWindow),
      };
    },
    ...overrides,
  };
}

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

async function connectClient(session) {
  const socket = createConnection(session.launchEnvironment.TAU_DIFF_SOCKET);
  const rl = createInterface({ input: socket, crlfDelay: Number.POSITIVE_INFINITY });
  const pending = new Map();

  rl.on("line", (line) => {
    const message = JSON.parse(line);
    const handler = pending.get(message.id);
    if (handler) {
      pending.delete(message.id);
      handler(message);
    }
  });

  await once(socket, "connect");

  const send = (id, method, params = {}) =>
    new Promise((resolve) => {
      pending.set(id, resolve);
      socket.write(`${request(id, method, params)}\n`);
    });

  return { socket, rl, send };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("diff_review session", () => {
  it("serves snapshot data, threads, and returned reviews over the diff protocol", async () => {
    const threadMessages = new Map();
    const session = new DiffReviewSession({
      snapshot: createSnapshot(),
      persona: personas[0],
      config: {},
      createThread: ({ threadId }) =>
        createThreadSession({
          async submitMessage(message) {
            const messages = threadMessages.get(threadId) ?? [];
            messages.push(message);
            threadMessages.set(threadId, messages);
            return `reply ${threadId} #${messages.length}: ${message}`;
          },
        }),
    });

    await session.start();
    const client = await connectClient(session);

    try {
      const init = await client.send("init", "initialize", {
        token: session.launchEnvironment.TAU_DIFF_TOKEN,
      });
      expect(init).toEqual({
        version: DIFF_REVIEW_PROTOCOL_VERSION,
        type: "response",
        id: "init",
        ok: true,
        result: {
          protocolVersion: DIFF_REVIEW_PROTOCOL_VERSION,
          sessionId: session.sessionId,
          methods: expect.any(Array),
          alreadyInitialized: false,
        },
      });

      const context = await client.send("ctx", "session.get_context", {});
      expect(context.result).toEqual({
        sessionId: session.sessionId,
        repoRoot: "/repo",
        cwd: "/repo/packages/app",
        diffArgs: ["--staged"],
        diffCommand: "git diff --staged",
      });

      const files = await client.send("files", "session.list_files", {});
      expect(files.result).toEqual({
        files: [
          { path: "src/a.ts", status: "modified", newPath: "src/a.ts" },
          { path: "src/b.ts", status: "deleted", oldPath: "src/b.ts" },
        ],
      });

      const wholeDiff = await client.send("diff-all", "session.get_diff", {});
      expect(wholeDiff.result).toEqual({
        scope: "session",
        patch: createSnapshot().patch,
      });

      const fileDiff = await client.send("diff-file", "session.get_diff", { path: "src/a.ts" });
      expect(fileDiff.result).toEqual({
        scope: "file",
        path: "src/a.ts",
        patch: createSnapshot().getFilePatch("src/a.ts"),
      });

      const firstThread = await client.send("thread-1", "thread.submit_message", {
        message: "What changed?",
      });
      expect(firstThread.result.threadId).toMatch(/^[0-9a-f-]{36}$/);
      expect(firstThread.result.response).toBe(
        `reply ${firstThread.result.threadId} #1: What changed?`,
      );

      const secondThread = await client.send("thread-2", "thread.submit_message", {
        threadId: firstThread.result.threadId,
        message: "Any risks?",
      });
      expect(secondThread.result).toEqual({
        threadId: firstThread.result.threadId,
        response: `reply ${firstThread.result.threadId} #2: Any risks?`,
      });

      const review = await client.send("return", "session.return_review", {
        review: "Looks good overall.",
      });
      expect(review.result).toEqual({ status: "returned" });
      await expect(session.result).resolves.toEqual({
        status: "returned",
        review: "Looks good overall.",
      });
    } finally {
      client.rl.close();
      client.socket.destroy();
      await session.close();
    }
  });

  it("forks new threads from existing context", async () => {
    const createdThreads = [];
    const session = new DiffReviewSession({
      snapshot: createSnapshot(),
      persona: personas[0],
      config: {},
      createThread: ({ threadId, forkFrom }) => {
        createdThreads.push({ threadId, forkFrom });
        return createThreadSession({
          async submitMessage(message) {
            return `${forkFrom ? "fork" : "root"} ${threadId}: ${message}`;
          },
        });
      },
    });

    await session.start();
    const client = await connectClient(session);

    try {
      await client.send("init", "initialize", {
        token: session.launchEnvironment.TAU_DIFF_TOKEN,
      });

      const bootstrap = await client.send("bootstrap", "thread.submit_message", {
        message: "build context",
      });
      expect(bootstrap.result).toEqual({
        threadId: expect.stringMatching(/^[0-9a-f-]{36}$/),
        response: `root ${bootstrap.result.threadId}: build context`,
      });
      expect(session.getUiState().reviewAgents).toEqual([
        {
          threadId: bootstrap.result.threadId,
          status: "idle",
          costTotal: 0,
          usage: createEmptyUsage(personas[0].model.contextWindow),
        },
      ]);

      const forked = await client.send("forked", "thread.submit_message", {
        forkFromThreadId: bootstrap.result.threadId,
        message: "review this file",
      });
      expect(forked.result).toEqual({
        threadId: expect.stringMatching(/^[0-9a-f-]{36}$/),
        response: `fork ${forked.result.threadId}: review this file`,
      });
      expect(createdThreads).toHaveLength(2);
      expect(createdThreads[1]).toEqual({
        threadId: forked.result.threadId,
        forkFrom: expect.any(Object),
      });
      expect(session.getUiState().reviewAgents).toEqual([
        {
          threadId: bootstrap.result.threadId,
          status: "idle",
          costTotal: 0,
          usage: createEmptyUsage(personas[0].model.contextWindow),
        },
        {
          threadId: forked.result.threadId,
          status: "idle",
          costTotal: 0,
          usage: createEmptyUsage(personas[0].model.contextWindow),
        },
      ]);

      const invalidFork = await client.send("invalid-fork", "thread.submit_message", {
        forkFromThreadId: "missing-thread",
        message: "review this file",
      });
      expect(invalidFork).toEqual({
        version: DIFF_REVIEW_PROTOCOL_VERSION,
        type: "response",
        id: "invalid-fork",
        ok: false,
        error: {
          code: "invalid_params",
          message: "unknown fork source thread 'missing-thread'",
        },
      });
    } finally {
      client.rl.close();
      client.socket.destroy();
      await session.close();
    }
  });

  it("rejects forks from threads that are still running", async () => {
    let createdThreadId;
    let releaseThreadStarted;
    const threadStarted = new Promise((resolve) => {
      releaseThreadStarted = resolve;
    });
    let continueThread;
    const threadCompletion = new Promise((resolve) => {
      continueThread = resolve;
    });
    const session = new DiffReviewSession({
      snapshot: createSnapshot(),
      persona: personas[0],
      config: {},
      createThread: ({ threadId }) => {
        createdThreadId = threadId;
        return createThreadSession({
          async submitMessage(message) {
            releaseThreadStarted();
            await threadCompletion;
            return `reply ${threadId}: ${message}`;
          },
          interrupt() {
            continueThread();
            return true;
          },
        });
      },
    });

    await session.start();
    const client = await connectClient(session);

    try {
      await client.send("init", "initialize", {
        token: session.launchEnvironment.TAU_DIFF_TOKEN,
      });

      const activePromise = client.send("active", "thread.submit_message", {
        message: "build context",
      });
      await threadStarted;

      await expect(
        client.send("forked", "thread.submit_message", {
          forkFromThreadId: createdThreadId,
          message: "review this file",
        }),
      ).resolves.toEqual({
        version: DIFF_REVIEW_PROTOCOL_VERSION,
        type: "response",
        id: "forked",
        ok: false,
        error: {
          code: "invalid_request",
          message: `thread '${createdThreadId}' already has an active request and cannot be used as a fork source`,
        },
      });

      continueThread();
      await expect(activePromise).resolves.toMatchObject({
        result: {
          threadId: createdThreadId,
          response: `reply ${createdThreadId}: build context`,
        },
      });
    } finally {
      client.rl.close();
      client.socket.destroy();
      await session.close();
    }
  });

  it("does not block session requests behind long-running thread submits", async () => {
    let releaseThreadStarted;
    const threadStarted = new Promise((resolve) => {
      releaseThreadStarted = resolve;
    });
    let continueThread;
    const threadCompletion = new Promise((resolve) => {
      continueThread = resolve;
    });
    const session = new DiffReviewSession({
      snapshot: createSnapshot(),
      persona: personas[0],
      config: {},
      createThread: ({ threadId }) =>
        createThreadSession({
          async submitMessage(message) {
            releaseThreadStarted();
            await threadCompletion;
            return `reply ${threadId}: ${message}`;
          },
          interrupt() {
            continueThread();
            return true;
          },
        }),
    });

    await session.start();
    const client = await connectClient(session);

    try {
      await client.send("init", "initialize", {
        token: session.launchEnvironment.TAU_DIFF_TOKEN,
      });

      const submitPromise = client.send("thread", "thread.submit_message", {
        message: "What changed?",
      });
      await threadStarted;

      const diffPromise = client.send("diff", "session.get_diff", {});
      const diff = await Promise.race([
        diffPromise,
        new Promise((resolve) => setTimeout(() => resolve("timeout"), 50)),
      ]);
      expect(diff).not.toBe("timeout");
      expect(diff.result).toEqual({
        scope: "session",
        patch: createSnapshot().patch,
      });

      continueThread();
      await expect(submitPromise).resolves.toMatchObject({
        result: {
          threadId: expect.stringMatching(/^[0-9a-f-]{36}$/),
          response: expect.stringContaining("What changed?"),
        },
      });
    } finally {
      client.rl.close();
      client.socket.destroy();
      await session.close();
    }
  });

  it("rejects simultaneous submits to the same thread", async () => {
    let releaseThread;
    const threadStarted = new Promise((resolve) => {
      releaseThread = resolve;
    });
    let continueThread;
    const threadCompletion = new Promise((resolve) => {
      continueThread = resolve;
    });
    const session = new DiffReviewSession({
      snapshot: createSnapshot(),
      persona: personas[0],
      config: {},
      createThread: ({ threadId }) =>
        createThreadSession({
          async submitMessage(message) {
            if (message === "create") {
              return `reply ${threadId}: ${message}`;
            }
            releaseThread();
            await threadCompletion;
            return `reply ${threadId}: ${message}`;
          },
          interrupt() {
            continueThread();
            return true;
          },
        }),
    });

    await session.start();
    const client = await connectClient(session);

    try {
      await client.send("init", "initialize", {
        token: session.launchEnvironment.TAU_DIFF_TOKEN,
      });

      const created = await client.send("create", "thread.submit_message", {
        message: "create",
      });
      const threadId = created.result.threadId;

      const activePromise = client.send("active", "thread.submit_message", {
        threadId,
        message: "slow",
      });
      await threadStarted;

      await expect(
        client.send("rejected", "thread.submit_message", {
          threadId,
          message: "second",
        }),
      ).resolves.toEqual({
        version: DIFF_REVIEW_PROTOCOL_VERSION,
        type: "response",
        id: "rejected",
        ok: false,
        error: {
          code: "invalid_request",
          message: `thread '${threadId}' already has an active request`,
        },
      });

      continueThread();
      await expect(activePromise).resolves.toMatchObject({
        result: {
          threadId,
          response: `reply ${threadId}: slow`,
        },
      });
    } finally {
      client.rl.close();
      client.socket.destroy();
      await session.close();
    }
  });

  it("preserves exact file paths when serving per-file diffs", async () => {
    const exactPath = " src/\todd name .ts ";
    const patch = [
      'diff --git "a/ src/\\todd name .ts " "b/ src/\\todd name .ts "',
      '--- "a/ src/\\todd name .ts "',
      '+++ "b/ src/\\todd name .ts "',
      "@@ -1 +1 @@",
      "-export const value = 1;",
      "+export const value = 2;",
    ].join("\n");
    const snapshot = new DiffReviewSnapshot({
      repoRoot: "/repo",
      cwd: "/repo",
      diffArgs: [],
      patch,
      files: [{ path: exactPath, status: "modified", newPath: exactPath }],
      patchByPath: new Map([[exactPath, patch]]),
    });
    const session = new DiffReviewSession({
      snapshot,
      persona: personas[0],
      config: {},
      createThread: () => createThreadSession(),
    });

    await session.start();
    const client = await connectClient(session);

    try {
      await client.send("init", "initialize", {
        token: session.launchEnvironment.TAU_DIFF_TOKEN,
      });

      const fileDiff = await client.send("diff-file", "session.get_diff", { path: exactPath });
      expect(fileDiff.result).toEqual({
        scope: "file",
        path: exactPath,
        patch,
      });

      const trimmedPath = await client.send("diff-file-trimmed", "session.get_diff", {
        path: exactPath.trim(),
      });
      expect(trimmedPath).toEqual({
        version: DIFF_REVIEW_PROTOCOL_VERSION,
        type: "response",
        id: "diff-file-trimmed",
        ok: false,
        error: {
          code: "invalid_params",
          message: `unknown diff file '${exactPath.trim()}'`,
        },
      });
    } finally {
      client.rl.close();
      client.socket.destroy();
      await session.close();
    }
  });

  it("tracks diff tool ui text and active review agents", async () => {
    let releaseThread;
    const threadStarted = new Promise((resolve) => {
      releaseThread = resolve;
    });
    let continueThread;
    const threadCompletion = new Promise((resolve) => {
      continueThread = resolve;
    });
    const stateUpdates = [];

    const session = new DiffReviewSession({
      snapshot: createSnapshot(),
      persona: personas[0],
      config: {},
      createThread: () =>
        createThreadSession({
          async submitMessage() {
            releaseThread();
            await threadCompletion;
            return "review reply";
          },
          interrupt() {
            continueThread();
            return true;
          },
        }),
    });

    const removeUiStateListener = session.onUiStateChange((state) => {
      stateUpdates.push(state);
    });

    await session.start();
    const client = await connectClient(session);

    try {
      await client.send("init", "initialize", {
        token: session.launchEnvironment.TAU_DIFF_TOKEN,
      });

      const uiText = await client.send("ui-text", "session.set_ui_text", {
        text: "http://127.0.0.1:4321",
      });
      expect(uiText.result).toEqual({ status: "updated" });
      expect(session.getUiState()).toEqual({
        diffToolUiText: "http://127.0.0.1:4321",
        reviewAgents: [],
      });

      const threadPromise = client.send("thread", "thread.submit_message", {
        message: "What changed?",
      });
      await threadStarted;

      expect(session.getUiState().reviewAgents).toEqual([
        {
          threadId: expect.stringMatching(/^[0-9a-f-]{36}$/),
          status: "running",
          costTotal: 0,
          usage: createEmptyUsage(personas[0].model.contextWindow),
        },
      ]);

      continueThread();
      const thread = await threadPromise;
      expect(thread.result).toEqual({
        threadId: expect.stringMatching(/^[0-9a-f-]{36}$/),
        response: "review reply",
      });
      expect(session.getUiState()).toEqual({
        diffToolUiText: "http://127.0.0.1:4321",
        reviewAgents: [
          {
            threadId: thread.result.threadId,
            status: "idle",
            costTotal: 0,
            usage: createEmptyUsage(personas[0].model.contextWindow),
          },
        ],
      });
      expect(stateUpdates).toEqual(
        expect.arrayContaining([
          {
            diffToolUiText: "http://127.0.0.1:4321",
            reviewAgents: [],
          },
          {
            diffToolUiText: "http://127.0.0.1:4321",
            reviewAgents: [
              {
                threadId: expect.stringMatching(/^[0-9a-f-]{36}$/),
                status: "running",
                costTotal: 0,
                usage: createEmptyUsage(personas[0].model.contextWindow),
              },
            ],
          },
          {
            diffToolUiText: "http://127.0.0.1:4321",
            reviewAgents: [
              {
                threadId: expect.stringMatching(/^[0-9a-f-]{36}$/),
                status: "idle",
                costTotal: 0,
                usage: createEmptyUsage(personas[0].model.contextWindow),
              },
            ],
          },
        ]),
      );
    } finally {
      removeUiStateListener();
      client.rl.close();
      client.socket.destroy();
      await session.close();
    }
  });

  it("interrupts active review agents before returning a review", async () => {
    let releaseThreadStarted;
    const threadStarted = new Promise((resolve) => {
      releaseThreadStarted = resolve;
    });
    let releaseThreadCompletion;
    const threadCompletion = new Promise((resolve) => {
      releaseThreadCompletion = resolve;
    });
    let interruptCount = 0;
    const session = new DiffReviewSession({
      snapshot: createSnapshot(),
      persona: personas[0],
      config: {},
      createThread: () =>
        createThreadSession({
          async submitMessage() {
            releaseThreadStarted();
            await threadCompletion;
            return "review reply";
          },
          interrupt() {
            interruptCount += 1;
            releaseThreadCompletion();
            return true;
          },
        }),
    });

    await session.start();
    const client = await connectClient(session);

    try {
      await client.send("init", "initialize", {
        token: session.launchEnvironment.TAU_DIFF_TOKEN,
      });

      void client.send("thread", "thread.submit_message", {
        message: "What changed?",
      });
      await threadStarted;

      const review = await client.send("return", "session.return_review", {
        review: "Looks good overall.",
      });
      expect(review.result).toEqual({ status: "returned" });
      await expect(session.result).resolves.toEqual({
        status: "returned",
        review: "Looks good overall.",
      });
      expect(interruptCount).toBe(1);
    } finally {
      client.rl.close();
      client.socket.destroy();
      await session.close();
    }
  });

  it("cancels the review if the diff tool never initializes", async () => {
    vi.useFakeTimers();

    const session = new DiffReviewSession({
      snapshot: createSnapshot(),
      persona: personas[0],
      config: {},
      createThread: () =>
        createThreadSession({
          async submitMessage(message) {
            return message;
          },
          interrupt() {
            return true;
          },
        }),
    });

    await session.start();

    try {
      const resultPromise = session.result;
      await vi.advanceTimersByTimeAsync(60_000);

      await expect(resultPromise).resolves.toEqual({
        status: "cancelled",
        reason: "tool_disconnected",
      });
    } finally {
      await session.close();
    }
  });

  it("cancels the review when the initialized client disconnects", async () => {
    const session = new DiffReviewSession({
      snapshot: createSnapshot(),
      persona: personas[0],
      config: {},
      createThread: () =>
        createThreadSession({
          async submitMessage(message) {
            return message;
          },
          interrupt() {
            return true;
          },
        }),
    });

    await session.start();
    const client = await connectClient(session);

    try {
      await client.send("init", "initialize", {
        token: session.launchEnvironment.TAU_DIFF_TOKEN,
      });
      client.rl.close();
      client.socket.destroy();

      await expect(session.result).resolves.toEqual({
        status: "cancelled",
        reason: "tool_disconnected",
      });
    } finally {
      await session.close();
    }
  });

  it("cancels the review when the initialized client disconnects even if another socket is open", async () => {
    const session = new DiffReviewSession({
      snapshot: createSnapshot(),
      persona: personas[0],
      config: {},
      createThread: () =>
        createThreadSession({
          async submitMessage(message) {
            return message;
          },
          interrupt() {
            return true;
          },
        }),
    });

    await session.start();
    const client = await connectClient(session);
    const extraClient = await connectClient(session);

    try {
      await client.send("init", "initialize", {
        token: session.launchEnvironment.TAU_DIFF_TOKEN,
      });
      client.rl.close();
      client.socket.destroy();

      await expect(session.result).resolves.toEqual({
        status: "cancelled",
        reason: "tool_disconnected",
      });
    } finally {
      extraClient.rl.close();
      extraClient.socket.destroy();
      await session.close();
    }
  });

  it("cancels the review when the only client disconnects before initialize", async () => {
    const session = new DiffReviewSession({
      snapshot: createSnapshot(),
      persona: personas[0],
      config: {},
      createThread: () =>
        createThreadSession({
          async submitMessage(message) {
            return message;
          },
          interrupt() {
            return true;
          },
        }),
    });

    await session.start();
    const client = await connectClient(session);

    try {
      client.rl.close();
      client.socket.destroy();

      await expect(session.result).resolves.toEqual({
        status: "cancelled",
        reason: "tool_disconnected",
      });
    } finally {
      await session.close();
    }
  });
});
