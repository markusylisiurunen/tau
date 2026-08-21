import { once } from "node:events";
import { createServer as createHttpServer } from "node:http";
import { describe, expect, it, vi } from "vitest";
import { DiffReviewBridge } from "../src/core/diff_review/bridge.ts";
import { DiffReviewSnapshot, formatDiffReviewScope } from "../src/core/diff_review/snapshot.ts";
import { personas } from "../src/core/personas.ts";
import {
  DiffReviewProtocolClient,
  DiffToolHttpServer,
  parseDiffToolLaunchEnvironment,
} from "../src/diff_tool/index.ts";

function createSubmitThreadMessage(createThread) {
  const threads = new Map();
  return async ({ threadId, forkFromThreadId, message }) => {
    let thread = threads.get(threadId);
    if (!thread) {
      const forkSource = forkFromThreadId ? threads.get(forkFromThreadId) : undefined;
      thread = createThread({
        threadId,
        ...(forkSource ? { forkFrom: forkSource.createForkSource() } : {}),
      });
      threads.set(threadId, thread);
    }
    return {
      threadId,
      response: await thread.submitMessage(message),
    };
  };
}

function createDiffReviewBridge(options) {
  const { createThread = () => createThreadSession(), contextWindow, ...rest } = options;
  return new DiffReviewBridge({
    contextWindow: contextWindow ?? personas[0].model.contextWindow,
    submitThreadMessage: createSubmitThreadMessage(createThread),
    ...rest,
  });
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
    scopeLabel: formatDiffReviewScope(["--staged"]),
  });
}

function createThreadSession(overrides = {}, contextWindow = 200_000) {
  return {
    async submitMessage() {
      return "review reply";
    },
    interrupt() {
      return false;
    },
    dispose() {},
    createForkSource() {
      return {
        historyEntries: [],
        usageBaseline: {
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          contextWindowUsageTokens: 0,
          contextWindow,
        },
      };
    },
    ...overrides,
  };
}

async function fetchJson(url, init) {
  const response = await fetch(url, init);
  const payload = await response.json();
  expect(response.ok).toBe(true);
  return payload;
}

function createClientStub(overrides = {}) {
  const closeListeners = new Set();
  const sessionCloseListeners = new Set();
  return {
    connect: vi.fn(async () => {}),
    getContext: vi.fn(async () => ({
      sessionId: "session-1",
      repoRoot: "/repo",
      cwd: "/repo",
      diffArgs: [],
      diffCommand: "current working tree",
    })),
    listFiles: vi.fn(async () => ({ files: [] })),
    getDiff: vi.fn(async () => ({ scope: "session", patch: "" })),
    setUiText: vi.fn(async () => ({ status: "updated" })),
    submitThreadMessage: vi.fn(async () => ({
      threadId: "bootstrap-thread",
      response: "bootstrap",
    })),
    close: vi.fn(async () => {
      for (const listener of closeListeners) {
        listener();
      }
    }),
    cancelSession: vi.fn(async () => ({ status: "cancelled" })),
    returnReview: vi.fn(async () => ({ status: "returned" })),
    onClose: vi.fn((listener) => {
      closeListeners.add(listener);
      return () => {
        closeListeners.delete(listener);
      };
    }),
    onSessionClose: vi.fn((listener) => {
      sessionCloseListeners.add(listener);
      return () => {
        sessionCloseListeners.delete(listener);
      };
    }),
    emitClose: () => {
      for (const listener of closeListeners) {
        listener();
      }
    },
    emitSessionClose: async () => {
      for (const listener of sessionCloseListeners) {
        await listener();
      }
      for (const listener of closeListeners) {
        listener();
      }
    },
    ...overrides,
  };
}

describe("built-in diff tool", () => {
  it("persists review state on the server and returns the composed review to Tau", async () => {
    const threadMessages = new Map();
    const createdThreads = [];
    const bridge = createDiffReviewBridge({
      snapshot: createSnapshot(),
      persona: personas[0],
      config: {},
      createThread: ({ threadId, forkFrom }) => {
        createdThreads.push({ threadId, forkFrom });
        return createThreadSession({
          async submitMessage(message) {
            const messages = threadMessages.get(threadId) ?? [];
            messages.push(message);
            threadMessages.set(threadId, messages);
            return `reply ${threadId} #${messages.length}: ${message}`;
          },
        });
      },
    });

    await bridge.start();
    const client = new DiffReviewProtocolClient(
      parseDiffToolLaunchEnvironment(bridge.launchEnvironment),
    );
    const server = new DiffToolHttpServer({ client });

    try {
      const started = await server.start();
      expect(bridge.getUiState().diffToolUiText).toBe(started.url);

      const bootstrap = await fetchJson(`${started.url}api/bootstrap`);
      expect(bootstrap.context).toEqual({
        sessionId: bridge.sessionId,
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
        overflowMode: "wrap",
        codeTheme: "github-dark-dimmed",
        sidebarOpen: false,
        collapsedFileIds: [],
        viewedFileIds: [],
        threads: [],
        brief: {
          content: "",
          loading: false,
        },
      });

      const wholeDiff = await fetchJson(`${started.url}api/diff`);
      expect(wholeDiff).toEqual({
        scope: "session",
        patch: createSnapshot().patch,
      });

      const fileDiff = await fetchJson(`${started.url}api/diff?path=src%2Fa.ts`);
      expect(fileDiff).toEqual({
        scope: "file",
        path: "src/a.ts",
        patch: createSnapshot().getFilePatch("src/a.ts"),
      });

      const updatedState = await fetchJson(`${started.url}api/state`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          sidebarOpen: true,
          viewedFileIds: ["src/a.ts::0"],
          collapsedFileIds: ["src/a.ts::0"],
          diffStyle: "stacked",
        }),
      });
      expect(updatedState.state).toMatchObject({
        sidebarOpen: true,
        viewedFileIds: ["src/a.ts::0"],
        collapsedFileIds: ["src/a.ts::0"],
        diffStyle: "stacked",
      });

      const createdThread = await fetchJson(`${started.url}api/thread`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          anchor: {
            kind: "line",
            fileId: "src/a.ts::0",
            filePath: "src/a.ts",
            lineNumber: 1,
            side: "additions",
          },
          body: "What changed?",
        }),
      });
      const thread = createdThread.state.threads[0];
      expect(createdThread.threadId).toBe(thread.id);
      expect(thread).toMatchObject({
        anchor: {
          kind: "line",
          fileId: "src/a.ts::0",
          filePath: "src/a.ts",
          lineNumber: 1,
          side: "additions",
        },
        messages: [{ role: "user", text: "What changed?" }],
        loading: false,
      });

      const repliedThread = await fetchJson(`${started.url}api/thread/reply`, {
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

      const askedThread = await fetchJson(`${started.url}api/thread-message`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: thread.id }),
      });
      expect(askedThread.state.threads[0]).toEqual({
        id: thread.id,
        threadId: expect.stringMatching(/^[0-9a-f-]{36}$/),
        anchor: {
          kind: "line",
          fileId: "src/a.ts::0",
          filePath: "src/a.ts",
          lineNumber: 1,
          side: "additions",
        },
        messages: [
          { role: "user", text: "What changed?" },
          { role: "user", text: "Any risks?" },
          {
            role: "assistant",
            text: expect.stringMatching(
              /^reply [0-9a-f-]{36} #1: <system>[\s\S]*\[src\/a\.ts:1 \(new\)\]/,
            ),
          },
        ],
        loading: false,
        resolved: false,
        collapsed: false,
      });
      expect(threadMessages.get(askedThread.state.threads[0].threadId)).toEqual([
        expect.stringMatching(
          /^<system>[\s\S]*<\/system>\n\[src\/a\.ts:1 \(new\)\]\n\nWhat changed\?\n\nAny risks\?$/,
        ),
      ]);

      const createdDetachedThread = await fetchJson(`${started.url}api/thread`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          anchor: { kind: "detached" },
          body: "Anything else worth checking?",
        }),
      });
      const detachedThread = createdDetachedThread.state.threads[1];
      expect(createdDetachedThread.threadId).toBe(detachedThread.id);
      expect(detachedThread).toMatchObject({
        anchor: { kind: "detached" },
        messages: [{ role: "user", text: "Anything else worth checking?" }],
        loading: false,
      });

      const askedDetachedThread = await fetchJson(`${started.url}api/thread-message`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: detachedThread.id }),
      });
      expect(askedDetachedThread.state.threads[1]).toEqual({
        id: detachedThread.id,
        threadId: expect.stringMatching(/^[0-9a-f-]{36}$/),
        anchor: { kind: "detached" },
        messages: [
          { role: "user", text: "Anything else worth checking?" },
          {
            role: "assistant",
            text: expect.stringMatching(
              /^reply [0-9a-f-]{36} #1: <system>[\s\S]*Anything else worth checking\?$/,
            ),
          },
        ],
        loading: false,
        resolved: false,
        collapsed: false,
      });
      expect(threadMessages.get(askedDetachedThread.state.threads[1].threadId)).toEqual([
        expect.stringMatching(/^<system>[\s\S]*<\/system>\nAnything else worth checking\?$/),
      ]);

      expect(createdThreads).toHaveLength(3);
      expect(createdThreads[0].forkFrom).toBeUndefined();
      expect(createdThreads[1]).toEqual({
        threadId: askedThread.state.threads[0].threadId,
        forkFrom: expect.any(Object),
      });
      expect(createdThreads[2]).toEqual({
        threadId: askedDetachedThread.state.threads[1].threadId,
        forkFrom: expect.any(Object),
      });
      expect(bridge.getUiState()).toEqual({
        diffToolUiText: started.url,
        reviewAgents: [
          {
            threadId: createdThreads[0].threadId,
            status: "idle",
            costTotal: 0,
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              contextWindowUsageTokens: 0,
              contextWindow: personas[0].model.contextWindow,
            },
          },
          {
            threadId: askedThread.state.threads[0].threadId,
            status: "idle",
            costTotal: 0,
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              contextWindowUsageTokens: 0,
              contextWindow: personas[0].model.contextWindow,
            },
          },
          {
            threadId: askedDetachedThread.state.threads[1].threadId,
            status: "idle",
            costTotal: 0,
            usage: {
              input: 0,
              output: 0,
              cacheRead: 0,
              cacheWrite: 0,
              contextWindowUsageTokens: 0,
              contextWindow: personas[0].model.contextWindow,
            },
          },
        ],
      });

      const refreshedBootstrap = await fetchJson(`${started.url}api/bootstrap`);
      expect(refreshedBootstrap.state).toEqual(askedDetachedThread.state);

      const reviewResult = await fetchJson(`${started.url}api/review`, {
        method: "POST",
        headers: { "content-type": "application/json" },
      });
      expect(reviewResult).toEqual({ status: "returned" });
      await expect(bridge.result).resolves.toEqual({
        status: "returned",
        review:
          "The notes below include thread transcripts from the review. In those transcripts:\n\n- **user** is a comment written by the reviewer\n- **agent** is a generated reply within that review thread\n\nTreat thread dialogue as supporting review context, not automatically as a final conclusion.\n\n---\n\n## thread 1\n\n`src/a.ts:1 (new)`\n\n**user**\n\nWhat changed?\n\n**user**\n\nAny risks?\n\n**agent**\n\n" +
          askedThread.state.threads[0].messages[2].text +
          "\n\n---\n\n## thread 2\n\n`general discussion`\n\n**user**\n\nAnything else worth checking?\n\n**agent**\n\n" +
          askedDetachedThread.state.threads[1].messages[1].text,
      });
      await server.waitUntilClosed();
    } finally {
      await server.close();
      await bridge.close();
    }
  });

  it("serves assets relative to a slash-terminated mount URL", async () => {
    const server = new DiffToolHttpServer({ client: createClientStub() });

    try {
      const started = await server.start();
      expect(started.url.endsWith("/")).toBe(true);

      const html = await (await fetch(started.url)).text();
      const assetPaths = [...html.matchAll(/(?:src|href)="(\.\/[^"]+)"/g)].map((match) => match[1]);
      expect(assetPaths).toHaveLength(2);

      const mountedUrl = new URL("https://example.test/reviews/review-1/");
      for (const assetPath of assetPaths) {
        expect(new URL(assetPath, mountedUrl).pathname).toMatch(/^\/reviews\/review-1\/assets\//);
      }

      const cssPath = assetPaths.find((path) => path.endsWith(".css"));
      const cssUrl = new URL(cssPath, started.url);
      const css = await (await fetch(cssUrl)).text();
      expect(css).not.toMatch(/url\(\//);
      const fontPath = css.match(/url\((\.\.\/fonts\/[^)]+)/)?.[1];
      expect(fontPath).toBeDefined();
      expect(new URL(fontPath, new URL(cssPath, mountedUrl)).pathname).toMatch(
        /^\/reviews\/review-1\/fonts\//,
      );
      expect((await fetch(new URL(fontPath, cssUrl))).ok).toBe(true);
    } finally {
      await server.close();
    }
  });

  it("persists review state and rehydrates follow-up agent context", async () => {
    let storedDocument;
    const storage = {
      load: vi.fn(async () => storedDocument),
      save: vi.fn(async (document) => {
        storedDocument = structuredClone(document);
      }),
    };
    const firstClient = createClientStub({
      getContext: vi.fn(async () => ({
        sessionId: "session-1",
        repoRoot: "/repo",
        cwd: "/repo",
        diffArgs: ["main...HEAD"],
        diffCommand: "git diff main...HEAD",
      })),
      getDiff: vi.fn(async () => ({ scope: "session", patch: "diff contents" })),
      submitThreadMessage: vi.fn(async ({ forkFromThreadId, message }) => ({
        threadId: forkFromThreadId ? "first-comment-thread" : "first-bootstrap-thread",
        response: forkFromThreadId ? `first reply: ${message}` : "bootstrap",
      })),
    });
    const firstServer = new DiffToolHttpServer({ client: firstClient, storage });

    let threadId;
    try {
      const started = await firstServer.start();
      const created = await fetchJson(`${started.url}api/thread`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          anchor: {
            kind: "line",
            fileId: "src/a.ts::0",
            filePath: "src/a.ts",
            lineNumber: 4,
            side: "additions",
          },
          body: "Why is this safe?",
        }),
      });
      threadId = created.threadId;
      await fetchJson(`${started.url}api/thread-message`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: threadId }),
      });
    } finally {
      await firstServer.close();
    }

    expect(storedDocument.state.threads[0]).not.toHaveProperty("threadId");
    expect(storedDocument.state.threads[0]).not.toHaveProperty("loading");

    const secondClient = createClientStub({
      getContext: firstClient.getContext,
      getDiff: firstClient.getDiff,
      submitThreadMessage: vi.fn(async ({ forkFromThreadId, message }) => ({
        threadId: forkFromThreadId ? "restored-comment-thread" : "second-bootstrap-thread",
        response: forkFromThreadId ? `restored reply: ${message}` : "bootstrap",
      })),
    });
    const secondServer = new DiffToolHttpServer({ client: secondClient, storage });

    try {
      const started = await secondServer.start();
      const bootstrap = await fetchJson(`${started.url}api/bootstrap`);
      expect(bootstrap.state.threads[0]).toMatchObject({
        id: threadId,
        loading: false,
        messages: [
          { role: "user", text: "Why is this safe?" },
          { role: "assistant", text: expect.stringContaining("first reply") },
        ],
      });
      expect(bootstrap.state.threads[0]).not.toHaveProperty("threadId");

      await fetchJson(`${started.url}api/thread/reply`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: threadId, text: "What about retries?" }),
      });
      await fetchJson(`${started.url}api/thread-message`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: threadId }),
      });

      const restoredCall = secondClient.submitThreadMessage.mock.calls
        .map(([options]) => options)
        .find((options) => options.forkFromThreadId);
      expect(restoredCall).toMatchObject({
        forkFromThreadId: "second-bootstrap-thread",
        message: expect.stringContaining("Continue this restored review conversation."),
      });
      expect(restoredCall.message).toContain("Why is this safe?");
      expect(restoredCall.message).toContain("first reply");
      expect(restoredCall.message).toContain("What about retries?");
    } finally {
      await secondServer.close();
    }
  });

  it("accepts at most one concurrent review submission", async () => {
    let markSubmitStarted;
    const submitStarted = new Promise((resolve) => {
      markSubmitStarted = resolve;
    });
    let acceptSubmit;
    const submitAccepted = new Promise((resolve) => {
      acceptSubmit = resolve;
    });
    const onSubmit = vi.fn(async () => {
      markSubmitStarted();
      await submitAccepted;
    });
    const client = createClientStub();
    const server = new DiffToolHttpServer({ client, onSubmit });

    try {
      const started = await server.start();
      const firstSubmission = fetch(`${started.url}api/review`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "Please address this." }),
      });
      await submitStarted;

      const duplicate = await fetch(`${started.url}api/review`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ message: "Duplicate" }),
      });
      expect(duplicate.status).toBe(409);
      await expect(duplicate.json()).resolves.toEqual({
        error: "diff review has already been submitted",
      });

      acceptSubmit();
      const accepted = await firstSubmission;
      expect(accepted.ok).toBe(true);
      expect(onSubmit).toHaveBeenCalledTimes(1);
      expect(onSubmit).toHaveBeenCalledWith({
        review: "Please address this.",
        context: expect.objectContaining({ sessionId: "session-1" }),
        files: [],
      });
      expect(client.returnReview).toHaveBeenCalledTimes(1);
      expect(onSubmit.mock.invocationCallOrder[0]).toBeLessThan(
        client.returnReview.mock.invocationCallOrder[0],
      );
    } finally {
      acceptSubmit?.();
      await server.close();
    }
  });

  it("allows submission retry when durable acceptance fails", async () => {
    const onSubmit = vi
      .fn()
      .mockRejectedValueOnce(new Error("database unavailable"))
      .mockResolvedValueOnce(undefined);
    const client = createClientStub();
    const server = new DiffToolHttpServer({ client, onSubmit });

    try {
      const started = await server.start();
      const failed = await fetch(`${started.url}api/review`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(failed.status).toBe(500);
      await expect(failed.json()).resolves.toEqual({ error: "database unavailable" });

      const accepted = await fetch(`${started.url}api/review`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({}),
      });
      expect(accepted.ok).toBe(true);
      expect(onSubmit).toHaveBeenCalledTimes(2);
      expect(client.returnReview).toHaveBeenCalledTimes(1);
    } finally {
      await server.close();
    }
  });

  it("rolls back review mutations when persistence fails", async () => {
    let saveCount = 0;
    const storage = {
      load: vi.fn(async () => undefined),
      save: vi.fn(async () => {
        saveCount += 1;
        if (saveCount === 2) {
          throw new Error("storage unavailable");
        }
      }),
    };
    const server = new DiffToolHttpServer({ client: createClientStub(), storage });

    try {
      const started = await server.start();
      const failed = await fetch(`${started.url}api/state`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sidebarOpen: true }),
      });
      expect(failed.status).toBe(500);
      await expect(failed.json()).resolves.toEqual({ error: "storage unavailable" });

      const bootstrap = await fetchJson(`${started.url}api/bootstrap`);
      expect(bootstrap.state.sidebarOpen).toBe(false);

      const recovered = await fetchJson(`${started.url}api/state`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sidebarOpen: true }),
      });
      expect(recovered.state.sidebarOpen).toBe(true);
    } finally {
      await server.close();
    }
  });

  it("preserves in-flight loading state when a concurrent persistence write fails", async () => {
    let saveCount = 0;
    const storage = {
      load: vi.fn(async () => undefined),
      save: vi.fn(async () => {
        saveCount += 1;
        if (saveCount === 3) throw new Error("storage unavailable");
      }),
    };
    let markCommentStarted;
    const commentStarted = new Promise((resolve) => {
      markCommentStarted = resolve;
    });
    let finishComment;
    const commentFinished = new Promise((resolve) => {
      finishComment = resolve;
    });
    const client = createClientStub({
      submitThreadMessage: vi.fn(async ({ forkFromThreadId }) => {
        if (!forkFromThreadId) return { threadId: "bootstrap-thread", response: "bootstrap" };
        markCommentStarted();
        await commentFinished;
        return { threadId: "comment-thread", response: "reply" };
      }),
    });
    const server = new DiffToolHttpServer({ client, storage });

    try {
      const started = await server.start();
      const created = await fetchJson(`${started.url}api/thread`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ anchor: { kind: "detached" }, body: "Question" }),
      });
      const pendingReply = fetch(`${started.url}api/thread-message`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: created.threadId }),
      });
      await commentStarted;

      const failedMutation = await fetch(`${started.url}api/state`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sidebarOpen: true }),
      });
      expect(failedMutation.status).toBe(500);

      const duplicateReply = await fetch(`${started.url}api/thread-message`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: created.threadId }),
      });
      expect(duplicateReply.status).toBe(409);

      finishComment();
      expect((await pendingReply).ok).toBe(true);
    } finally {
      finishComment?.();
      await server.close();
    }
  });

  it("publishes only committed state from queued persistence mutations", async () => {
    let saveCount = 0;
    let releaseFirstMutation;
    const firstMutationReleased = new Promise((resolve) => {
      releaseFirstMutation = resolve;
    });
    let markFirstMutationStarted;
    const firstMutationStarted = new Promise((resolve) => {
      markFirstMutationStarted = resolve;
    });
    let releaseSecondMutation;
    const secondMutationReleased = new Promise((resolve) => {
      releaseSecondMutation = resolve;
    });
    let markSecondMutationStarted;
    const secondMutationStarted = new Promise((resolve) => {
      markSecondMutationStarted = resolve;
    });
    const storage = {
      load: vi.fn(async () => undefined),
      save: vi.fn(async () => {
        saveCount += 1;
        if (saveCount === 2) {
          markFirstMutationStarted();
          await firstMutationReleased;
        }
        if (saveCount === 3) {
          markSecondMutationStarted();
          await secondMutationReleased;
          throw new Error("storage unavailable");
        }
      }),
    };
    const server = new DiffToolHttpServer({ client: createClientStub(), storage });

    try {
      const started = await server.start();
      const firstMutation = fetch(`${started.url}api/state`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sidebarOpen: true }),
      });
      await firstMutationStarted;
      const pendingBootstrap = await fetchJson(`${started.url}api/bootstrap`);
      expect(pendingBootstrap.state.sidebarOpen).toBe(false);

      const secondMutation = fetch(`${started.url}api/state`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ diffStyle: "stacked" }),
      });

      releaseFirstMutation();
      await secondMutationStarted;
      const firstResponse = await firstMutation;
      expect(firstResponse.ok).toBe(true);
      await expect(firstResponse.json()).resolves.toMatchObject({
        state: { sidebarOpen: true, diffStyle: "split" },
      });

      releaseSecondMutation();
      expect((await secondMutation).status).toBe(500);
      const bootstrap = await fetchJson(`${started.url}api/bootstrap`);
      expect(bootstrap.state).toMatchObject({ sidebarOpen: true, diffStyle: "split" });
    } finally {
      releaseFirstMutation?.();
      releaseSecondMutation?.();
      await server.close();
    }
  });

  it("validates queued thread mutations after earlier mutations commit", async () => {
    let saveCount = 0;
    let releaseBlockingMutation;
    const blockingMutationReleased = new Promise((resolve) => {
      releaseBlockingMutation = resolve;
    });
    let markBlockingMutationStarted;
    const blockingMutationStarted = new Promise((resolve) => {
      markBlockingMutationStarted = resolve;
    });
    const storage = {
      load: vi.fn(async () => undefined),
      save: vi.fn(async () => {
        saveCount += 1;
        if (saveCount === 3) {
          markBlockingMutationStarted();
          await blockingMutationReleased;
        }
      }),
    };
    const server = new DiffToolHttpServer({ client: createClientStub(), storage });

    try {
      const started = await server.start();
      const created = await fetchJson(`${started.url}api/thread`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ anchor: { kind: "detached" }, body: "Question" }),
      });
      const blockingMutation = fetch(`${started.url}api/state`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ sidebarOpen: true }),
      });
      await blockingMutationStarted;

      const deleted = fetch(`${started.url}api/thread/delete`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: created.threadId }),
      });
      await new Promise((resolve) => setTimeout(resolve, 10));
      const replied = fetch(`${started.url}api/thread/reply`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: created.threadId, text: "Follow-up" }),
      });
      await new Promise((resolve) => setTimeout(resolve, 10));
      const resolved = fetch(`${started.url}api/thread/resolve`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: created.threadId, resolved: true }),
      });
      await new Promise((resolve) => setTimeout(resolve, 10));
      const collapsed = fetch(`${started.url}api/thread/collapse`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ id: created.threadId, collapsed: true }),
      });

      releaseBlockingMutation();
      expect((await blockingMutation).ok).toBe(true);
      expect((await deleted).ok).toBe(true);
      expect((await replied).status).toBe(404);
      expect((await resolved).status).toBe(404);
      expect((await collapsed).status).toBe(404);
    } finally {
      releaseBlockingMutation?.();
      await server.close();
    }
  });

  it("rejects invalid or mismatched stored state", async () => {
    let storedDocument;
    const storage = {
      load: vi.fn(async () => storedDocument),
      save: vi.fn(async (document) => {
        storedDocument = structuredClone(document);
      }),
    };
    const firstServer = new DiffToolHttpServer({ client: createClientStub(), storage });
    await firstServer.start();
    await firstServer.close();

    const invalidServer = new DiffToolHttpServer({
      client: createClientStub(),
      storage: {
        load: vi.fn(async () => ({ ...storedDocument, unexpected: true })),
        save: vi.fn(async () => {}),
      },
    });
    await expect(invalidServer.start()).rejects.toThrow("stored diff review state is invalid");

    const changedClient = createClientStub({
      getDiff: vi.fn(async () => ({ scope: "session", patch: "changed diff" })),
    });
    const changedServer = new DiffToolHttpServer({ client: changedClient, storage });
    await expect(changedServer.start()).rejects.toThrow(
      "stored diff review state belongs to a different diff snapshot",
    );
  });

  it("retries bootstrap after a transient failure", async () => {
    let callCount = 0;
    const client = createClientStub({
      submitThreadMessage: vi.fn(async ({ forkFromThreadId }) => {
        callCount += 1;
        if (callCount === 1) {
          throw new Error("bootstrap failed");
        }
        return {
          threadId: forkFromThreadId ? "brief-thread" : "bootstrap-thread",
          response: forkFromThreadId ? "brief ready" : "bootstrap",
        };
      }),
    });
    const server = new DiffToolHttpServer({ client });

    try {
      const started = await server.start();
      await new Promise((resolve) => setTimeout(resolve, 0));

      const result = await fetchJson(`${started.url}api/brief/generate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
      });
      expect(result.state.brief).toEqual({
        threadId: "brief-thread",
        content: "brief ready",
        loading: false,
      });
      expect(client.submitThreadMessage).toHaveBeenNthCalledWith(1, {
        message: expect.any(String),
      });
      expect(client.submitThreadMessage).toHaveBeenNthCalledWith(2, {
        message: expect.any(String),
      });
      expect(client.submitThreadMessage).toHaveBeenNthCalledWith(3, {
        forkFromThreadId: "bootstrap-thread",
        message: expect.any(String),
      });
    } finally {
      await server.close();
    }
  });

  it("starts bootstrap eagerly without blocking diff fetches", async () => {
    let releaseBootstrapStarted;
    const bootstrapStarted = new Promise((resolve) => {
      releaseBootstrapStarted = resolve;
    });
    let continueBootstrap;
    const bootstrapCompletion = new Promise((resolve) => {
      continueBootstrap = resolve;
    });
    let threadCount = 0;
    const bridge = createDiffReviewBridge({
      snapshot: createSnapshot(),
      persona: personas[0],
      config: {},
      createThread: ({ threadId }) =>
        createThreadSession({
          async submitMessage(message) {
            threadCount += 1;
            releaseBootstrapStarted();
            await bootstrapCompletion;
            return `bootstrap ${threadId}: ${message}`;
          },
          interrupt() {
            continueBootstrap();
            return true;
          },
        }),
    });

    await bridge.start();
    const client = new DiffReviewProtocolClient(
      parseDiffToolLaunchEnvironment(bridge.launchEnvironment),
    );
    const server = new DiffToolHttpServer({ client });

    try {
      const started = await server.start();
      await bootstrapStarted;

      const diff = await Promise.race([
        fetchJson(`${started.url}api/diff`),
        new Promise((resolve) => setTimeout(() => resolve("timeout"), 50)),
      ]);
      expect(diff).not.toBe("timeout");
      expect(diff).toEqual({
        scope: "session",
        patch: createSnapshot().patch,
      });
      expect(threadCount).toBe(1);
      expect(bridge.getUiState().reviewAgents).toEqual([
        {
          threadId: expect.stringMatching(/^[0-9a-f-]{36}$/),
          status: "running",
          costTotal: 0,
          usage: {
            input: 0,
            output: 0,
            cacheRead: 0,
            cacheWrite: 0,
            contextWindowUsageTokens: 0,
            contextWindow: personas[0].model.contextWindow,
          },
        },
      ]);

      continueBootstrap();
      await server.close();
      await bridge.close();
    } finally {
      continueBootstrap?.();
      await server.close();
      await bridge.close();
    }
  });

  it("shuts down the browser demo when Tau cancels the session externally", async () => {
    const bridge = createDiffReviewBridge({
      snapshot: createSnapshot(),
      persona: personas[0],
      config: {},
      createThread: () =>
        createThreadSession({
          async submitMessage(message) {
            return message;
          },
        }),
    });

    await bridge.start();
    const client = new DiffReviewProtocolClient(
      parseDiffToolLaunchEnvironment(bridge.launchEnvironment),
    );
    const server = new DiffToolHttpServer({ client });

    try {
      await server.start();

      await bridge.cancel("controller_cancelled");
      await server.waitUntilClosed();
    } finally {
      await server.close();
      await bridge.close();
    }
  });

  it("acks session.close promptly even with an in-flight browser request", async () => {
    let releaseBootstrapStarted;
    const bootstrapStarted = new Promise((resolve) => {
      releaseBootstrapStarted = resolve;
    });
    let continueBootstrap;
    const bootstrapCompletion = new Promise((resolve) => {
      continueBootstrap = resolve;
    });
    const bridge = createDiffReviewBridge({
      snapshot: createSnapshot(),
      persona: personas[0],
      config: {},
      createThread: () =>
        createThreadSession({
          async submitMessage(message) {
            releaseBootstrapStarted();
            await bootstrapCompletion;
            return message;
          },
          interrupt() {
            continueBootstrap();
            return true;
          },
        }),
    });

    await bridge.start();
    const client = new DiffReviewProtocolClient(
      parseDiffToolLaunchEnvironment(bridge.launchEnvironment),
    );
    const server = new DiffToolHttpServer({ client });

    try {
      const started = await server.start();
      await bootstrapStarted;

      const briefRequest = fetch(`${started.url}api/brief/generate`, {
        method: "POST",
        headers: { "content-type": "application/json" },
      });
      await new Promise((resolve) => setTimeout(resolve, 0));

      await expect(
        Promise.race([
          bridge.cancel("controller_cancelled"),
          new Promise((_, reject) => setTimeout(() => reject(new Error("timeout")), 250)),
        ]),
      ).resolves.toBeUndefined();
      await server.waitUntilClosed();

      const briefResponse = await briefRequest;
      expect(briefResponse.ok).toBe(false);
      await expect(briefResponse.json()).resolves.toEqual({
        error: expect.stringMatching(
          /diff review protocol client closed|diff review session is closing/,
        ),
      });
    } finally {
      continueBootstrap?.();
      await server.close();
      await bridge.close();
    }
  });

  it("waits for Tau's session.close after returning a review", async () => {
    const client = createClientStub();
    const server = new DiffToolHttpServer({ client });

    try {
      const started = await server.start();

      const result = await fetchJson(`${started.url}api/review`, {
        method: "POST",
        headers: { "content-type": "application/json" },
      });
      expect(result).toEqual({ status: "returned" });
      expect(client.returnReview).toHaveBeenCalledTimes(1);
      expect(client.close).not.toHaveBeenCalled();

      const bootstrap = await fetchJson(`${started.url}api/bootstrap`);
      expect(bootstrap.context.sessionId).toBe("session-1");

      await client.emitSessionClose();
      await server.waitUntilClosed();
      expect(client.close).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it("waits for Tau's session.close after tool-initiated cancel", async () => {
    const client = createClientStub();
    const server = new DiffToolHttpServer({ client });

    try {
      const started = await server.start();

      const result = await fetchJson(`${started.url}api/cancel`, {
        method: "POST",
        headers: { "content-type": "application/json" },
      });
      expect(result).toEqual({ status: "cancelled" });
      expect(client.cancelSession).toHaveBeenCalledTimes(1);
      expect(client.close).not.toHaveBeenCalled();

      const bootstrap = await fetchJson(`${started.url}api/bootstrap`);
      expect(bootstrap.context.sessionId).toBe("session-1");

      await client.emitSessionClose();
      await server.waitUntilClosed();
      expect(client.close).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it("waits for Tau's session.close after local process cancellation", async () => {
    const client = createClientStub();
    const server = new DiffToolHttpServer({ client });

    try {
      const started = await server.start();

      await server.cancel();
      expect(client.cancelSession).toHaveBeenCalledTimes(1);
      expect(client.close).not.toHaveBeenCalled();

      const bootstrap = await fetchJson(`${started.url}api/bootstrap`);
      expect(bootstrap.context.sessionId).toBe("session-1");

      await client.emitSessionClose();
      await server.waitUntilClosed();
      expect(client.close).not.toHaveBeenCalled();
    } finally {
      await server.close();
    }
  });

  it("closes locally when process cancellation cannot reach Tau", async () => {
    const client = createClientStub({
      cancelSession: vi.fn(async () => {
        throw new Error("cancel failed");
      }),
    });
    const server = new DiffToolHttpServer({ client });

    await server.start();
    await server.cancel();
    expect(client.cancelSession).toHaveBeenCalledTimes(1);
    expect(client.close).toHaveBeenCalledTimes(1);
    await server.waitUntilClosed();
  });

  it("does not bind after the protocol closes during persisted-state restoration", async () => {
    let releaseLoad;
    const loadReleased = new Promise((resolve) => {
      releaseLoad = resolve;
    });
    let markLoadStarted;
    const loadStarted = new Promise((resolve) => {
      markLoadStarted = resolve;
    });
    const client = createClientStub();
    const storage = {
      load: vi.fn(async () => {
        markLoadStarted();
        await loadReleased;
        return undefined;
      }),
      save: vi.fn(async () => {}),
    };
    const server = new DiffToolHttpServer({ client, storage });
    const start = server.start();
    await loadStarted;

    client.emitClose();
    await server.waitUntilClosed();
    releaseLoad();

    await expect(start).rejects.toThrow("diff tool session closed during startup");
    expect(client.setUiText).not.toHaveBeenCalled();
  });

  it("formats an IPv6 listener as a valid URL", async () => {
    const server = new DiffToolHttpServer({ client: createClientStub(), host: "::1" });

    try {
      const started = await server.start();
      expect(started.url).toMatch(/^http:\/\/\[::1\]:\d+\/$/);
      expect((await fetch(new URL("api/bootstrap", started.url))).ok).toBe(true);
    } finally {
      await server.close();
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
