import { describe, expect, it, vi } from "vitest";
import { startAsyncTelegramAdapter } from "../dist/core/async/telegram.js";

function jsonResponse(payload) {
  return new Response(JSON.stringify(payload), {
    status: 200,
    headers: {
      "content-type": "application/json",
    },
  });
}

async function waitFor(predicate, timeoutMs = 2000) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitFor timeout");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function createFetchHarness(updateBatches) {
  const queue = [...updateBatches];
  const sendMessages = [];
  const getUpdatesBodies = [];

  const fetchMock = vi.fn(async (url, init = {}) => {
    const method = new URL(String(url)).pathname.split("/").pop();

    if (method === "getUpdates") {
      const body = init.body ? JSON.parse(init.body) : {};
      getUpdatesBodies.push(body);

      if (queue.length > 0) {
        return jsonResponse({ ok: true, result: queue.shift() });
      }

      return await new Promise((_, reject) => {
        const signal = init.signal;

        const onAbort = () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        };

        if (signal?.aborted) {
          onAbort();
          return;
        }

        signal?.addEventListener("abort", onAbort, { once: true });
      });
    }

    if (method === "sendMessage") {
      const body = init.body ? JSON.parse(init.body) : {};
      sendMessages.push(body);
      return jsonResponse({ ok: true, result: { message_id: sendMessages.length } });
    }

    throw new Error(`unexpected telegram method: ${String(method)}`);
  });

  return {
    fetchMock,
    sendMessages,
    getUpdatesBodies,
  };
}

function createSessionManagerHarness(initialSessions = []) {
  const sessions = new Map(initialSessions.map((session) => [session.id, { ...session }]));
  const listeners = new Set();
  let nextSessionId = 1;

  const manager = {
    createSession: vi.fn(async ({ projectId, prompt }) => {
      const sessionId = `s${nextSessionId++}`;
      const now = "2024-01-01T00:00:00.000Z";
      const session = {
        id: sessionId,
        projectId,
        state: "waiting-input",
        createdAt: now,
        updatedAt: now,
        ...(prompt ? { error: prompt } : {}),
      };
      sessions.set(sessionId, session);
      return { ...session };
    }),
    listSessions: vi.fn(() => Array.from(sessions.values()).map((session) => ({ ...session }))),
    getSession: vi.fn((sessionId) => {
      const session = sessions.get(sessionId);
      return session ? { ...session } : undefined;
    }),
    getLogs: vi.fn(() => []),
    sendMessage: vi.fn(async (sessionId) => {
      const session = sessions.get(sessionId);
      if (!session) {
        throw new Error("missing session");
      }
      session.updatedAt = "2024-01-01T00:01:00.000Z";
      return { ...session };
    }),
    cancelSession: vi.fn(async (sessionId) => {
      const session = sessions.get(sessionId);
      if (!session) {
        throw new Error("missing session");
      }
      session.state = "canceled";
      session.updatedAt = "2024-01-01T00:02:00.000Z";
      return { ...session };
    }),
    onEvent: vi.fn((listener) => {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    }),
    emit: (event) => {
      for (const listener of listeners) {
        listener(event);
      }
    },
  };

  return {
    manager,
    sessions,
  };
}

describe("async telegram adapter", () => {
  it("routes private DM commands and ignores non-private chats", async () => {
    const fetchHarness = createFetchHarness([
      [
        {
          update_id: 1,
          message: {
            chat: { id: 10, type: "group" },
            from: { id: 5 },
            text: "/list",
          },
        },
        {
          update_id: 2,
          message: {
            chat: { id: 20, type: "private" },
            from: { id: 5 },
            text: "/list",
          },
        },
      ],
    ]);

    const managerHarness = createSessionManagerHarness([
      {
        id: "s1",
        projectId: "demo",
        state: "waiting-input",
        createdAt: "2024-01-01T00:00:00.000Z",
        updatedAt: "2024-01-01T00:00:00.000Z",
      },
    ]);

    const adapter = await startAsyncTelegramAdapter({
      botToken: "token",
      projects: { demo: { repo: "git@example.com:demo.git" } },
      sessionManager: managerHarness.manager,
      fetchImpl: fetchHarness.fetchMock,
      pollIntervalMs: 1,
      requestTimeoutSeconds: 1,
    });

    try {
      await waitFor(() => fetchHarness.sendMessages.length === 1);
      expect(managerHarness.manager.listSessions).toHaveBeenCalledTimes(1);
      expect(fetchHarness.sendMessages[0].chat_id).toBe(20);
      expect(fetchHarness.sendMessages[0].text).toContain("s1");
    } finally {
      await adapter.close();
    }
  });

  it("enforces telegram allowlists when configured", async () => {
    const fetchHarness = createFetchHarness([
      [
        {
          update_id: 1,
          message: {
            chat: { id: 100, type: "private" },
            from: { id: 999 },
            text: "/list",
          },
        },
        {
          update_id: 2,
          message: {
            chat: { id: 999, type: "private" },
            from: { id: 7 },
            text: "/list",
          },
        },
        {
          update_id: 3,
          message: {
            chat: { id: 100, type: "private" },
            from: { id: 7 },
            text: "/list",
          },
        },
      ],
    ]);

    const managerHarness = createSessionManagerHarness();

    const adapter = await startAsyncTelegramAdapter({
      botToken: "token",
      projects: { demo: { repo: "git@example.com:demo.git" } },
      sessionManager: managerHarness.manager,
      fetchImpl: fetchHarness.fetchMock,
      allowedUserIds: [7],
      allowedChatIds: [100],
      pollIntervalMs: 1,
      requestTimeoutSeconds: 1,
    });

    try {
      await waitFor(() => fetchHarness.sendMessages.length === 1);
      expect(managerHarness.manager.listSessions).toHaveBeenCalledTimes(1);
      expect(fetchHarness.sendMessages[0].chat_id).toBe(100);
    } finally {
      await adapter.close();
    }
  });

  it("supports /new and routes plain text to the active session", async () => {
    const fetchHarness = createFetchHarness([
      [
        {
          update_id: 1,
          message: {
            chat: { id: 200, type: "private" },
            from: { id: 7 },
            text: "/new hello from telegram",
          },
        },
        {
          update_id: 2,
          message: {
            chat: { id: 200, type: "private" },
            from: { id: 7 },
            text: "follow up",
          },
        },
      ],
    ]);

    const managerHarness = createSessionManagerHarness();

    const adapter = await startAsyncTelegramAdapter({
      botToken: "token",
      projects: {
        demo: { repo: "git@example.com:demo.git" },
        extra: { repo: "git@example.com:extra.git" },
      },
      defaultProjectId: "demo",
      sessionManager: managerHarness.manager,
      fetchImpl: fetchHarness.fetchMock,
      pollIntervalMs: 1,
      requestTimeoutSeconds: 1,
    });

    try {
      await waitFor(() => managerHarness.manager.sendMessage.mock.calls.length === 1);

      expect(managerHarness.manager.createSession).toHaveBeenCalledWith({
        projectId: "demo",
        prompt: "hello from telegram",
      });
      expect(managerHarness.manager.sendMessage).toHaveBeenCalledWith("s1", "follow up");

      expect(
        fetchHarness.sendMessages.some((entry) => String(entry.text).startsWith("accepted:")),
      ).toBe(true);
      expect(
        fetchHarness.sendMessages.some((entry) => String(entry.text).startsWith("queued:")),
      ).toBe(true);
    } finally {
      await adapter.close();
    }
  });

  it("supports /use and /cancel for active sessions", async () => {
    const fetchHarness = createFetchHarness([
      [
        {
          update_id: 1,
          message: {
            chat: { id: 300, type: "private" },
            from: { id: 7 },
            text: "/use s2",
          },
        },
        {
          update_id: 2,
          message: {
            chat: { id: 300, type: "private" },
            from: { id: 7 },
            text: "/cancel",
          },
        },
      ],
    ]);

    const managerHarness = createSessionManagerHarness([
      {
        id: "s2",
        projectId: "demo",
        state: "waiting-input",
        createdAt: "2024-01-01T00:00:00.000Z",
        updatedAt: "2024-01-01T00:00:00.000Z",
      },
    ]);

    const adapter = await startAsyncTelegramAdapter({
      botToken: "token",
      projects: { demo: { repo: "git@example.com:demo.git" } },
      sessionManager: managerHarness.manager,
      fetchImpl: fetchHarness.fetchMock,
      pollIntervalMs: 1,
      requestTimeoutSeconds: 1,
    });

    try {
      await waitFor(() => managerHarness.manager.cancelSession.mock.calls.length === 1);
      expect(managerHarness.manager.cancelSession).toHaveBeenCalledWith("s2");
      expect(
        fetchHarness.sendMessages.some((entry) => String(entry.text).includes("canceled: s2")),
      ).toBe(true);
    } finally {
      await adapter.close();
    }
  });

  it("maps session lifecycle events to telegram notifications", async () => {
    const fetchHarness = createFetchHarness([
      [
        {
          update_id: 1,
          message: {
            chat: { id: 400, type: "private" },
            from: { id: 7 },
            text: "/use s9",
          },
        },
      ],
    ]);

    const managerHarness = createSessionManagerHarness([
      {
        id: "s9",
        projectId: "demo",
        state: "waiting-input",
        createdAt: "2024-01-01T00:00:00.000Z",
        updatedAt: "2024-01-01T00:00:00.000Z",
      },
    ]);

    const adapter = await startAsyncTelegramAdapter({
      botToken: "token",
      projects: { demo: { repo: "git@example.com:demo.git" } },
      sessionManager: managerHarness.manager,
      fetchImpl: fetchHarness.fetchMock,
      pollIntervalMs: 1,
      requestTimeoutSeconds: 1,
    });

    try {
      await waitFor(() => fetchHarness.sendMessages.length >= 1);

      managerHarness.manager.emit({
        type: "session-state-changed",
        sessionId: "s9",
        projectId: "demo",
        previousState: "waiting-input",
        state: "running",
        updatedAt: "2024-01-01T00:01:00.000Z",
      });
      managerHarness.manager.emit({
        type: "session-state-changed",
        sessionId: "s9",
        projectId: "demo",
        previousState: "running",
        state: "waiting-input",
        updatedAt: "2024-01-01T00:02:00.000Z",
      });
      managerHarness.manager.emit({
        type: "session-state-changed",
        sessionId: "s9",
        projectId: "demo",
        previousState: "waiting-input",
        state: "failed",
        updatedAt: "2024-01-01T00:03:00.000Z",
      });
      managerHarness.manager.emit({
        type: "session-state-changed",
        sessionId: "s9",
        projectId: "demo",
        previousState: "failed",
        state: "canceled",
        updatedAt: "2024-01-01T00:04:00.000Z",
      });

      await waitFor(
        () =>
          fetchHarness.sendMessages.some((entry) => entry.text === "started: s9") &&
          fetchHarness.sendMessages.some((entry) => entry.text === "finished: s9") &&
          fetchHarness.sendMessages.some((entry) => entry.text === "failed: s9") &&
          fetchHarness.sendMessages.some((entry) => entry.text === "canceled: s9"),
      );
    } finally {
      await adapter.close();
    }
  });
});
