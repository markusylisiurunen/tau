import { describe, expect, it, vi } from "vitest";
import { startAsyncTelegramAdapter } from "../dist/core/async/telegram.js";

async function waitFor(predicate, timeoutMs = 2000) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error("waitFor timeout");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

function createApiHarness(updateBatches) {
  const queue = [...updateBatches];
  const sendMessages = [];
  const setCommandsCalls = [];

  const api = {
    getUpdates: vi.fn(async () => {
      if (queue.length > 0) {
        return queue.shift();
      }

      return await new Promise(() => {});
    }),
    sendMessage: vi.fn(async (chatId, text) => {
      sendMessages.push({ chatId, text });
    }),
    setCommands: vi.fn(async (commands) => {
      setCommandsCalls.push(commands);
    }),
  };

  return {
    api,
    sendMessages,
    setCommandsCalls,
  };
}

function createSessionManagerHarness(initialSessions = []) {
  const sessions = new Map(initialSessions.map((session) => [session.id, { ...session }]));
  const listeners = new Set();
  let nextSessionId = 1;

  const manager = {
    createSession: vi.fn(async ({ projectId }) => {
      const sessionId = `s${nextSessionId++}`;
      const now = "2024-01-01T00:00:00.000Z";
      const session = {
        id: sessionId,
        projectId,
        state: "waiting-input",
        createdAt: now,
        updatedAt: now,
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
  it("advertises telegram slash commands", async () => {
    const apiHarness = createApiHarness([]);
    const managerHarness = createSessionManagerHarness();

    const adapter = await startAsyncTelegramAdapter({
      botToken: "token",
      projects: { demo: { repo: "git@example.com:demo.git" } },
      sessionManager: managerHarness.manager,
      api: apiHarness.api,
      pollIntervalMs: 1,
      requestTimeoutSeconds: 1,
    });

    try {
      await waitFor(() => apiHarness.setCommandsCalls.length === 1);
      expect(apiHarness.setCommandsCalls[0]).toEqual([
        { command: "new", description: "start a new session" },
        { command: "use", description: "switch active session" },
        { command: "list", description: "list sessions" },
        { command: "status", description: "show active session status" },
        { command: "cancel", description: "cancel active session" },
        { command: "verbose", description: "stream progress updates" },
        { command: "quiet", description: "only send final assistant message" },
      ]);
    } finally {
      await adapter.close();
    }
  });

  it("routes private DM commands and ignores non-private chats", async () => {
    const apiHarness = createApiHarness([
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
      api: apiHarness.api,
      pollIntervalMs: 1,
      requestTimeoutSeconds: 1,
    });

    try {
      await waitFor(() => apiHarness.sendMessages.length === 1);
      expect(managerHarness.manager.listSessions).toHaveBeenCalledTimes(1);
      expect(apiHarness.sendMessages[0].chatId).toBe(20);
      expect(apiHarness.sendMessages[0].text).toContain("s1");
    } finally {
      await adapter.close();
    }
  });

  it("enforces telegram allowlists when configured", async () => {
    const apiHarness = createApiHarness([
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
      api: apiHarness.api,
      allowedUserIds: [7],
      allowedChatIds: [100],
      pollIntervalMs: 1,
      requestTimeoutSeconds: 1,
    });

    try {
      await waitFor(() => apiHarness.sendMessages.length === 1);
      expect(managerHarness.manager.listSessions).toHaveBeenCalledTimes(1);
      expect(apiHarness.sendMessages[0].chatId).toBe(100);
    } finally {
      await adapter.close();
    }
  });

  it("supports /new and routes plain text to the active session", async () => {
    const apiHarness = createApiHarness([
      [
        {
          update_id: 1,
          message: {
            chat: { id: 200, type: "private" },
            from: { id: 7 },
            text: "/new",
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
      systemMessage: "telegram guidance",
      sessionManager: managerHarness.manager,
      api: apiHarness.api,
      pollIntervalMs: 1,
      requestTimeoutSeconds: 1,
    });

    try {
      await waitFor(() => managerHarness.manager.sendMessage.mock.calls.length === 1);

      managerHarness.manager.emit({
        type: "session-state-changed",
        sessionId: "s1",
        projectId: "demo",
        previousState: "preparing-workspace",
        state: "waiting-input",
        updatedAt: "2024-01-01T00:01:00.000Z",
      });

      expect(managerHarness.manager.createSession).toHaveBeenCalledWith({
        projectId: "demo",
      });
      expect(managerHarness.manager.sendMessage).toHaveBeenCalledWith("s1", "follow up", {
        additionalSystemMessage: "telegram guidance",
      });

      await waitFor(
        () =>
          apiHarness.sendMessages.some((entry) =>
            String(entry.text).includes("session is being prepared"),
          ) &&
          apiHarness.sendMessages.some((entry) =>
            String(entry.text).includes("(s1) session is ready"),
          ),
      );

      expect(
        apiHarness.sendMessages.some((entry) => String(entry.text).includes("(s1) message queued")),
      ).toBe(true);
    } finally {
      await adapter.close();
    }
  });

  it("rejects /new commands that include prompt text", async () => {
    const apiHarness = createApiHarness([
      [
        {
          update_id: 1,
          message: {
            chat: { id: 250, type: "private" },
            from: { id: 7 },
            text: "/new demo write tests",
          },
        },
      ],
    ]);

    const managerHarness = createSessionManagerHarness();

    const adapter = await startAsyncTelegramAdapter({
      botToken: "token",
      projects: { demo: { repo: "git@example.com:demo.git" } },
      sessionManager: managerHarness.manager,
      api: apiHarness.api,
      pollIntervalMs: 1,
      requestTimeoutSeconds: 1,
    });

    try {
      await waitFor(() => apiHarness.sendMessages.length === 1);
      expect(managerHarness.manager.createSession).not.toHaveBeenCalled();
      expect(apiHarness.sendMessages[0].text).toContain("usage: /new [projectId]");
    } finally {
      await adapter.close();
    }
  });

  it("supports /use and /cancel for active sessions", async () => {
    const apiHarness = createApiHarness([
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
      api: apiHarness.api,
      pollIntervalMs: 1,
      requestTimeoutSeconds: 1,
    });

    try {
      await waitFor(() => managerHarness.manager.cancelSession.mock.calls.length === 1);
      expect(managerHarness.manager.cancelSession).toHaveBeenCalledWith("s2");
      expect(
        apiHarness.sendMessages.some((entry) => String(entry.text).includes("(s2) canceled")),
      ).toBe(true);
    } finally {
      await adapter.close();
    }
  });

  it("maps session lifecycle events to telegram notifications", async () => {
    const apiHarness = createApiHarness([
      [
        {
          update_id: 1,
          message: {
            chat: { id: 400, type: "private" },
            from: { id: 7 },
            text: "/use s9",
          },
        },
        {
          update_id: 2,
          message: {
            chat: { id: 400, type: "private" },
            from: { id: 7 },
            text: "/verbose",
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
      api: apiHarness.api,
      pollIntervalMs: 1,
      requestTimeoutSeconds: 1,
    });

    try {
      await waitFor(() =>
        apiHarness.sendMessages.some((entry) =>
          entry.text.includes("(s9) verbosity set to verbose"),
        ),
      );

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
          apiHarness.sendMessages.some((entry) => entry.text.includes("(s9) run started")) &&
          apiHarness.sendMessages.some((entry) => entry.text.includes("(s9) run finished")) &&
          apiHarness.sendMessages.some((entry) => entry.text.includes("(s9) run failed")) &&
          apiHarness.sendMessages.some((entry) => entry.text.includes("(s9) run canceled")),
      );
    } finally {
      await adapter.close();
    }
  });

  it("maps session progress events to telegram notifications", async () => {
    const apiHarness = createApiHarness([
      [
        {
          update_id: 1,
          message: {
            chat: { id: 450, type: "private" },
            from: { id: 7 },
            text: "/use s10",
          },
        },
        {
          update_id: 2,
          message: {
            chat: { id: 450, type: "private" },
            from: { id: 7 },
            text: "/verbose",
          },
        },
      ],
    ]);

    const managerHarness = createSessionManagerHarness([
      {
        id: "s10",
        projectId: "demo",
        state: "running",
        createdAt: "2024-01-01T00:00:00.000Z",
        updatedAt: "2024-01-01T00:00:00.000Z",
      },
    ]);

    const adapter = await startAsyncTelegramAdapter({
      botToken: "token",
      projects: { demo: { repo: "git@example.com:demo.git" } },
      sessionManager: managerHarness.manager,
      api: apiHarness.api,
      pollIntervalMs: 1,
      requestTimeoutSeconds: 1,
    });

    try {
      await waitFor(() =>
        apiHarness.sendMessages.some((entry) =>
          entry.text.includes("(s10) verbosity set to verbose"),
        ),
      );

      managerHarness.manager.emit({
        type: "session-progress",
        sessionId: "s10",
        projectId: "demo",
        state: "running",
        timestamp: "2024-01-01T00:01:00.000Z",
        progress: {
          type: "bash-command",
          command: "npm run check",
        },
      });

      managerHarness.manager.emit({
        type: "session-progress",
        sessionId: "s10",
        projectId: "demo",
        state: "running",
        timestamp: "2024-01-01T00:02:00.000Z",
        progress: {
          type: "edited-file",
          path: "src/core/async/telegram.ts",
        },
      });

      managerHarness.manager.emit({
        type: "session-progress",
        sessionId: "s10",
        projectId: "demo",
        state: "running",
        timestamp: "2024-01-01T00:03:00.000Z",
        progress: {
          type: "wrote-file",
          path: "docs/async.md",
        },
      });

      managerHarness.manager.emit({
        type: "session-progress",
        sessionId: "s10",
        projectId: "demo",
        state: "running",
        timestamp: "2024-01-01T00:04:00.000Z",
        progress: {
          type: "assistant-message",
          text: "build succeeded and all tests passed",
        },
      });

      await waitFor(
        () =>
          apiHarness.sendMessages.some((entry) => entry.text.includes("(s10) bash command")) &&
          apiHarness.sendMessages.some((entry) => entry.text.includes("(s10) edited file")) &&
          apiHarness.sendMessages.some((entry) => entry.text.includes("(s10) wrote file")) &&
          apiHarness.sendMessages.some((entry) => entry.text.includes("(s10) assistant message")),
      );
    } finally {
      await adapter.close();
    }
  });

  it("supports /quiet and /verbose per session", async () => {
    const apiHarness = createApiHarness([
      [
        {
          update_id: 1,
          message: {
            chat: { id: 460, type: "private" },
            from: { id: 7 },
            text: "/use s11",
          },
        },
        {
          update_id: 2,
          message: {
            chat: { id: 460, type: "private" },
            from: { id: 7 },
            text: "/quiet",
          },
        },
        {
          update_id: 3,
          message: {
            chat: { id: 460, type: "private" },
            from: { id: 7 },
            text: "/status",
          },
        },
        {
          update_id: 4,
          message: {
            chat: { id: 460, type: "private" },
            from: { id: 7 },
            text: "/verbose",
          },
        },
        {
          update_id: 5,
          message: {
            chat: { id: 460, type: "private" },
            from: { id: 7 },
            text: "/status",
          },
        },
      ],
    ]);

    const managerHarness = createSessionManagerHarness([
      {
        id: "s11",
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
      api: apiHarness.api,
      pollIntervalMs: 1,
      requestTimeoutSeconds: 1,
    });

    try {
      await waitFor(() => apiHarness.sendMessages.length >= 5);
      expect(
        apiHarness.sendMessages.some((entry) =>
          entry.text.includes("(s11) verbosity set to quiet"),
        ),
      ).toBe(true);
      expect(apiHarness.sendMessages.some((entry) => entry.text.includes("verbosity: quiet"))).toBe(
        true,
      );
      expect(
        apiHarness.sendMessages.some((entry) =>
          entry.text.includes("(s11) verbosity set to verbose"),
        ),
      ).toBe(true);
      expect(
        apiHarness.sendMessages.some((entry) => entry.text.includes("verbosity: verbose")),
      ).toBe(true);
    } finally {
      await adapter.close();
    }
  });

  it("only sends the final assistant message in quiet mode", async () => {
    const apiHarness = createApiHarness([
      [
        {
          update_id: 1,
          message: {
            chat: { id: 470, type: "private" },
            from: { id: 7 },
            text: "/use s12",
          },
        },
        {
          update_id: 2,
          message: {
            chat: { id: 470, type: "private" },
            from: { id: 7 },
            text: "/quiet",
          },
        },
      ],
    ]);

    const managerHarness = createSessionManagerHarness([
      {
        id: "s12",
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
      api: apiHarness.api,
      pollIntervalMs: 1,
      requestTimeoutSeconds: 1,
    });

    try {
      await waitFor(() => apiHarness.sendMessages.length >= 2);

      managerHarness.manager.emit({
        type: "session-state-changed",
        sessionId: "s12",
        projectId: "demo",
        previousState: "waiting-input",
        state: "running",
        updatedAt: "2024-01-01T00:01:00.000Z",
      });

      managerHarness.manager.emit({
        type: "session-progress",
        sessionId: "s12",
        projectId: "demo",
        state: "running",
        timestamp: "2024-01-01T00:02:00.000Z",
        progress: {
          type: "bash-command",
          command: "npm test",
        },
      });

      managerHarness.manager.emit({
        type: "session-progress",
        sessionId: "s12",
        projectId: "demo",
        state: "running",
        timestamp: "2024-01-01T00:03:00.000Z",
        progress: {
          type: "assistant-message",
          text: "intermediate",
        },
      });

      managerHarness.manager.emit({
        type: "session-progress",
        sessionId: "s12",
        projectId: "demo",
        state: "running",
        timestamp: "2024-01-01T00:04:00.000Z",
        progress: {
          type: "assistant-message",
          text: "final answer",
        },
      });

      managerHarness.manager.emit({
        type: "session-state-changed",
        sessionId: "s12",
        projectId: "demo",
        previousState: "running",
        state: "waiting-input",
        updatedAt: "2024-01-01T00:05:00.000Z",
      });

      await waitFor(() => apiHarness.sendMessages.some((entry) => entry.text === "final answer"));

      expect(
        apiHarness.sendMessages.some((entry) => entry.text.includes("(s12) run started")),
      ).toBe(false);
      expect(
        apiHarness.sendMessages.some((entry) => entry.text.includes("(s12) run finished")),
      ).toBe(false);
      expect(
        apiHarness.sendMessages.some((entry) => entry.text.includes("(s12) bash command")),
      ).toBe(false);
      expect(
        apiHarness.sendMessages.some((entry) => entry.text.includes("(s12) assistant message")),
      ).toBe(false);
    } finally {
      await adapter.close();
    }
  });
});
