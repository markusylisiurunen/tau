import { existsSync } from "node:fs";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { startAsyncTelegramAdapter } from "../dist/core/async/telegram.js";

async function startAdapter(options) {
  return startAsyncTelegramAdapter({
    botId: "bot-default",
    ...options,
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

function createJsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json",
    },
  });
}

function createApiHarness(updateBatches) {
  const queue = [...updateBatches];
  const sendMessages = [];
  const downloadFileCalls = [];
  const setCommandsCalls = [];
  const setMessageReactions = [];
  const answerCallbackQueryCalls = [];

  const api = {
    getUpdates: vi.fn(async () => {
      if (queue.length > 0) {
        return queue.shift();
      }

      return await new Promise(() => {});
    }),
    sendMessage: vi.fn(async (chatId, text, options) => {
      sendMessages.push({ chatId, text, options });
    }),
    downloadFile: vi.fn(async (fileId) => {
      downloadFileCalls.push(fileId);
      return Buffer.from("telegram audio payload");
    }),
    setCommands: vi.fn(async (commands) => {
      setCommandsCalls.push(commands);
    }),
    setMessageReaction: vi.fn(async (chatId, messageId) => {
      setMessageReactions.push({ chatId, messageId });
    }),
    answerCallbackQuery: vi.fn(async (callbackQueryId, text) => {
      answerCallbackQueryCalls.push({ callbackQueryId, text });
    }),
  };

  return {
    api,
    sendMessages,
    downloadFileCalls,
    setCommandsCalls,
    setMessageReactions,
    answerCallbackQueryCalls,
  };
}

function ownerIdForChat(chatId, botId = "bot-default") {
  return `telegram:${botId}:chat:${chatId}`;
}

function createSessionManagerHarness(initialSessions = [], options = {}) {
  const sessions = new Map(
    initialSessions.map((session) => [
      session.id,
      {
        ...session,
        ...(session.ownerId
          ? {}
          : options.defaultOwnerId
            ? { ownerId: options.defaultOwnerId }
            : {}),
      },
    ]),
  );
  const listeners = new Set();
  let nextSessionId = 1;

  const manager = {
    createSession: vi.fn(async ({ projectId, ownerId }) => {
      const sessionId = `s${nextSessionId++}`;
      const now = "2024-01-01T00:00:00.000Z";
      const session = {
        id: sessionId,
        projectId,
        ...(ownerId ? { ownerId } : {}),
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
    interruptSession: vi.fn(async (sessionId) => {
      const session = sessions.get(sessionId);
      if (!session) {
        throw new Error("missing session");
      }
      const interrupted = session.state === "running";
      if (interrupted) {
        session.state = "waiting-input";
      }
      session.updatedAt = "2024-01-01T00:01:30.000Z";
      return {
        session: { ...session },
        interrupted,
        isTurnRunning: false,
      };
    }),
    closeSession: vi.fn(async (sessionId) => {
      const session = sessions.get(sessionId);
      if (!session) {
        throw new Error("missing session");
      }
      sessions.delete(sessionId);
      return { ...session };
    }),
    closeInactiveSessions: vi.fn(async () => {
      const closed = [];
      for (const [sessionId, session] of sessions) {
        if (session.state === "waiting-input" || session.state === "failed") {
          closed.push({ ...session });
          sessions.delete(sessionId);
        }
      }
      return closed;
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

    const adapter = await startAdapter({
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
        { command: "help", description: "show supported commands" },
        { command: "new", description: "start a new session" },
        { command: "projects", description: "list configured projects" },
        { command: "use", description: "switch active session" },
        { command: "sessions", description: "list sessions" },
        { command: "status", description: "show active session status" },
        { command: "interrupt", description: "interrupt active run" },
        { command: "close", description: "close session(s)" },
        { command: "verbose", description: "stream progress updates" },
        { command: "quiet", description: "only send final assistant message" },
      ]);
    } finally {
      await adapter.close();
    }
  });

  it("sweeps stale telegram attachment temp dirs when the adapter starts", async () => {
    const staleDir = await mkdtemp(join(tmpdir(), "tau-telegram-attachments-"));
    await writeFile(join(staleDir, "stale.txt"), "orphan");

    const apiHarness = createApiHarness([]);
    const managerHarness = createSessionManagerHarness();

    const adapter = await startAdapter({
      botToken: "token",
      projects: { demo: { repo: "git@example.com:demo.git" } },
      sessionManager: managerHarness.manager,
      api: apiHarness.api,
      pollIntervalMs: 1,
      requestTimeoutSeconds: 1,
    });

    try {
      await waitFor(() => !existsSync(staleDir));
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
            text: "/sessions",
          },
        },
        {
          update_id: 2,
          message: {
            chat: { id: 20, type: "private" },
            from: { id: 5 },
            text: "/sessions",
          },
        },
      ],
    ]);

    const managerHarness = createSessionManagerHarness(
      [
        {
          id: "s1",
          projectId: "demo",
          state: "waiting-input",
          createdAt: "2024-01-01T00:00:00.000Z",
          updatedAt: "2024-01-01T00:00:00.000Z",
        },
      ],
      { defaultOwnerId: ownerIdForChat(20) },
    );

    const adapter = await startAdapter({
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

  it("returns session buttons and quick actions for /sessions", async () => {
    const apiHarness = createApiHarness([
      [
        {
          update_id: 1,
          message: {
            chat: { id: 25, type: "private" },
            from: { id: 5 },
            text: "/sessions",
          },
        },
      ],
    ]);

    const managerHarness = createSessionManagerHarness(
      [
        {
          id: "s1",
          projectId: "demo",
          state: "waiting-input",
          createdAt: "2024-01-01T00:00:00.000Z",
          updatedAt: "2024-01-01T00:00:00.000Z",
        },
      ],
      { defaultOwnerId: ownerIdForChat(25) },
    );

    const adapter = await startAdapter({
      botToken: "token",
      projects: { demo: { repo: "git@example.com:demo.git" } },
      sessionManager: managerHarness.manager,
      api: apiHarness.api,
      pollIntervalMs: 1,
      requestTimeoutSeconds: 1,
    });

    try {
      await waitFor(() => apiHarness.sendMessages.length === 1);
      expect(apiHarness.sendMessages[0].options).toEqual({
        replyMarkup: {
          inline_keyboard: [
            [{ text: "1. s1", callback_data: "tau:use:s1" }],
            [
              { text: "/new", callback_data: "tau:action:new" },
              { text: "/sessions", callback_data: "tau:action:sessions" },
              { text: "/status", callback_data: "tau:action:status" },
            ],
            [
              { text: "/interrupt", callback_data: "tau:action:interrupt" },
              { text: "/close", callback_data: "tau:action:close" },
            ],
            [
              { text: "/quiet", callback_data: "tau:action:quiet" },
              { text: "/verbose", callback_data: "tau:action:verbose" },
            ],
          ],
        },
      });
    } finally {
      await adapter.close();
    }
  });

  it("handles callback buttons for session selection and quick actions", async () => {
    const apiHarness = createApiHarness([
      [
        {
          update_id: 1,
          callback_query: {
            id: "cb1",
            from: { id: 7 },
            data: "tau:use:s2",
            message: {
              chat: { id: 260, type: "private" },
            },
          },
        },
        {
          update_id: 2,
          callback_query: {
            id: "cb2",
            from: { id: 7 },
            data: "tau:action:status",
            message: {
              chat: { id: 260, type: "private" },
            },
          },
        },
      ],
    ]);

    const managerHarness = createSessionManagerHarness(
      [
        {
          id: "s2",
          projectId: "demo",
          state: "waiting-input",
          createdAt: "2024-01-01T00:00:00.000Z",
          updatedAt: "2024-01-01T00:00:00.000Z",
        },
      ],
      { defaultOwnerId: ownerIdForChat(260) },
    );

    const adapter = await startAdapter({
      botToken: "token",
      projects: { demo: { repo: "git@example.com:demo.git" } },
      sessionManager: managerHarness.manager,
      api: apiHarness.api,
      pollIntervalMs: 1,
      requestTimeoutSeconds: 1,
    });

    try {
      await waitFor(() => apiHarness.sendMessages.length >= 2);
      expect(
        apiHarness.sendMessages.some((entry) =>
          entry.text.includes("(s2) using session (waiting-input)"),
        ),
      ).toBe(true);
      expect(apiHarness.answerCallbackQueryCalls).toEqual([
        { callbackQueryId: "cb1", text: "done" },
        { callbackQueryId: "cb2", text: "done" },
      ]);
    } finally {
      await adapter.close();
    }
  });

  it("supports /use session prefixes and indexes", async () => {
    const apiHarness = createApiHarness([
      [
        {
          update_id: 1,
          message: {
            chat: { id: 270, type: "private" },
            from: { id: 7 },
            text: "/use 2",
          },
        },
        {
          update_id: 2,
          message: {
            chat: { id: 270, type: "private" },
            from: { id: 7 },
            text: "/use alpha",
          },
        },
      ],
    ]);

    const managerHarness = createSessionManagerHarness(
      [
        {
          id: "alpha-123",
          projectId: "demo",
          state: "waiting-input",
          createdAt: "2024-01-01T00:00:00.000Z",
          updatedAt: "2024-01-01T00:00:00.000Z",
        },
        {
          id: "beta-456",
          projectId: "demo",
          state: "running",
          createdAt: "2024-01-01T00:00:00.000Z",
          updatedAt: "2024-01-01T00:00:00.000Z",
        },
      ],
      { defaultOwnerId: ownerIdForChat(270) },
    );

    const adapter = await startAdapter({
      botToken: "token",
      projects: { demo: { repo: "git@example.com:demo.git" } },
      sessionManager: managerHarness.manager,
      api: apiHarness.api,
      pollIntervalMs: 1,
      requestTimeoutSeconds: 1,
    });

    try {
      await waitFor(() => apiHarness.sendMessages.length >= 2);
      expect(
        apiHarness.sendMessages.some((entry) => entry.text.includes("(beta-456) using session")),
      ).toBe(true);
      expect(
        apiHarness.sendMessages.some((entry) => entry.text.includes("(alpha-123) using session")),
      ).toBe(true);
    } finally {
      await adapter.close();
    }
  });

  it("lists configured projects with /projects", async () => {
    const apiHarness = createApiHarness([
      [
        {
          update_id: 1,
          message: {
            chat: { id: 20, type: "private" },
            from: { id: 5 },
            text: "/projects",
          },
        },
      ],
    ]);

    const managerHarness = createSessionManagerHarness();

    const adapter = await startAdapter({
      botToken: "token",
      projects: {
        demo: { repo: "git@example.com:demo.git", description: "demo project" },
        api: { repo: "git@example.com:demo.git" },
      },
      sessionManager: managerHarness.manager,
      api: apiHarness.api,
      pollIntervalMs: 1,
      requestTimeoutSeconds: 1,
    });

    try {
      await waitFor(() => apiHarness.sendMessages.length === 1);
      expect(apiHarness.sendMessages[0]).toEqual(
        expect.objectContaining({
          chatId: 20,
          text: "projects:\napi\ndemo: demo project",
        }),
      );
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
            text: "/sessions",
          },
        },
        {
          update_id: 2,
          message: {
            chat: { id: 999, type: "private" },
            from: { id: 7 },
            text: "/sessions",
          },
        },
        {
          update_id: 3,
          message: {
            chat: { id: 100, type: "private" },
            from: { id: 7 },
            text: "/sessions",
          },
        },
      ],
    ]);

    const managerHarness = createSessionManagerHarness();

    const adapter = await startAdapter({
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
            message_id: 501,
            chat: { id: 200, type: "private" },
            from: { id: 7 },
            text: "/new",
          },
        },
        {
          update_id: 2,
          message: {
            message_id: 502,
            chat: { id: 200, type: "private" },
            from: { id: 7 },
            text: "follow up",
          },
        },
      ],
    ]);

    const managerHarness = createSessionManagerHarness();

    const adapter = await startAdapter({
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
        ownerId: ownerIdForChat(200),
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
      ).toBe(false);
      await waitFor(() =>
        apiHarness.setMessageReactions.some(
          (entry) => entry.chatId === 200 && entry.messageId === 502,
        ),
      );
    } finally {
      await adapter.close();
    }
  });

  it("isolates sessions per chat when bot id is configured", async () => {
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
            chat: { id: 201, type: "private" },
            from: { id: 8 },
            text: "/sessions",
          },
        },
        {
          update_id: 3,
          message: {
            chat: { id: 201, type: "private" },
            from: { id: 8 },
            text: "/use s1",
          },
        },
        {
          update_id: 4,
          message: {
            chat: { id: 201, type: "private" },
            from: { id: 8 },
            text: "hello",
          },
        },
        {
          update_id: 5,
          message: {
            chat: { id: 201, type: "private" },
            from: { id: 8 },
            text: "/interrupt",
          },
        },
        {
          update_id: 6,
          message: {
            chat: { id: 201, type: "private" },
            from: { id: 8 },
            text: "/close s1",
          },
        },
      ],
    ]);

    const managerHarness = createSessionManagerHarness();

    const adapter = await startAdapter({
      botId: "ops",
      botToken: "token",
      projects: { demo: { repo: "git@example.com:demo.git" } },
      defaultProjectId: "demo",
      sessionManager: managerHarness.manager,
      api: apiHarness.api,
      pollIntervalMs: 1,
      requestTimeoutSeconds: 1,
    });

    try {
      await waitFor(() => apiHarness.sendMessages.length >= 6);
      expect(managerHarness.manager.createSession).toHaveBeenCalledWith({
        projectId: "demo",
        ownerId: "telegram:ops:chat:200",
      });
      expect(managerHarness.manager.sendMessage).not.toHaveBeenCalled();
      expect(managerHarness.manager.interruptSession).not.toHaveBeenCalled();
      expect(managerHarness.manager.closeSession).not.toHaveBeenCalled();
      expect(
        apiHarness.sendMessages.some(
          (entry) => entry.chatId === 201 && entry.text === "no sessions",
        ),
      ).toBe(true);
      expect(
        apiHarness.sendMessages.some(
          (entry) => entry.chatId === 201 && entry.text.includes("session 's1' not found"),
        ),
      ).toBe(true);
      expect(
        apiHarness.sendMessages.some(
          (entry) =>
            entry.chatId === 201 && entry.text.includes("no active session. use /new or /sessions"),
        ),
      ).toBe(true);
    } finally {
      await adapter.close();
    }
  });

  it("queues attachment-only messages and prepends them to the next text turn", async () => {
    const apiHarness = createApiHarness([
      [
        {
          update_id: 1,
          message: {
            chat: { id: 205, type: "private" },
            from: { id: 7 },
            text: "/new",
          },
        },
        {
          update_id: 2,
          message: {
            chat: { id: 205, type: "private" },
            from: { id: 7 },
            caption: "release notes",
            document: {
              file_id: "doc-205",
              file_name: "notes.pdf",
              mime_type: "application/pdf",
              file_size: 256,
            },
          },
        },
        {
          update_id: 3,
          message: {
            message_id: 503,
            chat: { id: 205, type: "private" },
            from: { id: 7 },
            text: "follow up",
          },
        },
      ],
    ]);

    apiHarness.api.downloadFile.mockImplementation(async (fileId) => {
      apiHarness.downloadFileCalls.push(fileId);
      return Buffer.from("pdf-bytes");
    });

    const managerHarness = createSessionManagerHarness();

    const adapter = await startAdapter({
      botToken: "token",
      projects: { demo: { repo: "git@example.com:demo.git" } },
      defaultProjectId: "demo",
      sessionManager: managerHarness.manager,
      api: apiHarness.api,
      pollIntervalMs: 1,
      requestTimeoutSeconds: 1,
    });

    try {
      await waitFor(() => managerHarness.manager.sendMessage.mock.calls.length === 1);

      const sendMessageCall = managerHarness.manager.sendMessage.mock.calls[0];
      expect(sendMessageCall[0]).toBe("s1");
      expect(sendMessageCall[2]).toBe(undefined);
      expect(sendMessageCall[1]).toContain("attachments:");
      expect(sendMessageCall[1]).toContain("mime: application/pdf");
      expect(sendMessageCall[1]).toContain("size_bytes: 9");
      expect(sendMessageCall[1]).toContain('caption: "release notes"');
      expect(sendMessageCall[1]).toContain("\n\nfollow up");

      const attachmentPathMatch = /- path: (.+)/.exec(sendMessageCall[1]);
      expect(attachmentPathMatch).toBeTruthy();
      const attachmentPath = attachmentPathMatch?.[1] ?? "";
      expect(attachmentPath.startsWith(tmpdir())).toBe(true);
      expect(existsSync(attachmentPath)).toBe(true);
      expect(apiHarness.downloadFileCalls).toEqual(["doc-205"]);
      await waitFor(() =>
        apiHarness.setMessageReactions.some(
          (entry) => entry.chatId === 205 && entry.messageId === 503,
        ),
      );
    } finally {
      await adapter.close();
    }
  });

  it("materializes attachments immediately without waiting for a turn trigger", async () => {
    const apiHarness = createApiHarness([
      [
        {
          update_id: 1,
          message: {
            chat: { id: 215, type: "private" },
            from: { id: 7 },
            text: "/new",
          },
        },
        {
          update_id: 2,
          message: {
            chat: { id: 215, type: "private" },
            from: { id: 7 },
            document: {
              file_id: "doc-immediate",
              file_name: "payload.md",
              mime_type: "text/markdown",
              file_size: 12,
            },
          },
        },
      ],
    ]);

    apiHarness.api.downloadFile.mockImplementation(async (fileId) => {
      apiHarness.downloadFileCalls.push(fileId);
      return Buffer.from("# queued");
    });

    const managerHarness = createSessionManagerHarness();

    const adapter = await startAdapter({
      botToken: "token",
      projects: { demo: { repo: "git@example.com:demo.git" } },
      defaultProjectId: "demo",
      sessionManager: managerHarness.manager,
      api: apiHarness.api,
      pollIntervalMs: 1,
      requestTimeoutSeconds: 1,
    });

    try {
      await waitFor(() => apiHarness.downloadFileCalls.length === 1);
      expect(apiHarness.downloadFileCalls).toEqual(["doc-immediate"]);
      expect(managerHarness.manager.sendMessage).not.toHaveBeenCalled();
    } finally {
      await adapter.close();
    }
  });

  it("accepts pdf attachments when Telegram omits mime type", async () => {
    const apiHarness = createApiHarness([
      [
        {
          update_id: 1,
          message: {
            chat: { id: 216, type: "private" },
            from: { id: 7 },
            text: "/new",
          },
        },
        {
          update_id: 2,
          message: {
            chat: { id: 216, type: "private" },
            from: { id: 7 },
            document: {
              file_id: "doc-missing-mime",
              file_name: "manual.pdf",
              file_size: 12,
            },
          },
        },
        {
          update_id: 3,
          message: {
            chat: { id: 216, type: "private" },
            from: { id: 7 },
            text: "continue",
          },
        },
      ],
    ]);

    apiHarness.api.downloadFile.mockImplementation(async (fileId) => {
      apiHarness.downloadFileCalls.push(fileId);
      return Buffer.from("%PDF-1.7");
    });

    const managerHarness = createSessionManagerHarness();

    const adapter = await startAdapter({
      botToken: "token",
      projects: { demo: { repo: "git@example.com:demo.git" } },
      defaultProjectId: "demo",
      sessionManager: managerHarness.manager,
      api: apiHarness.api,
      pollIntervalMs: 1,
      requestTimeoutSeconds: 1,
    });

    try {
      await waitFor(() => managerHarness.manager.sendMessage.mock.calls.length === 1);

      const sendMessageCall = managerHarness.manager.sendMessage.mock.calls[0];
      expect(sendMessageCall[0]).toBe("s1");
      expect(sendMessageCall[1]).toContain("attachments:");
      expect(sendMessageCall[1]).toContain("mime: application/pdf");
      expect(sendMessageCall[1]).toContain("\n\ncontinue");
      expect(apiHarness.downloadFileCalls).toEqual(["doc-missing-mime"]);
      expect(
        apiHarness.sendMessages.some((entry) =>
          String(entry.text).includes("unsupported file type"),
        ),
      ).toBe(false);
    } finally {
      await adapter.close();
    }
  });

  it("skips unsupported document attachments with an immediate warning", async () => {
    const apiHarness = createApiHarness([
      [
        {
          update_id: 1,
          message: {
            chat: { id: 206, type: "private" },
            from: { id: 7 },
            text: "/new",
          },
        },
        {
          update_id: 2,
          message: {
            chat: { id: 206, type: "private" },
            from: { id: 7 },
            document: {
              file_id: "doc-unsupported",
              file_name: "payload.exe",
              mime_type: "application/octet-stream",
              file_size: 123,
            },
          },
        },
        {
          update_id: 3,
          message: {
            chat: { id: 206, type: "private" },
            from: { id: 7 },
            text: "continue",
          },
        },
      ],
    ]);

    const managerHarness = createSessionManagerHarness();

    const adapter = await startAdapter({
      botToken: "token",
      projects: { demo: { repo: "git@example.com:demo.git" } },
      defaultProjectId: "demo",
      sessionManager: managerHarness.manager,
      api: apiHarness.api,
      pollIntervalMs: 1,
      requestTimeoutSeconds: 1,
    });

    try {
      await waitFor(() => managerHarness.manager.sendMessage.mock.calls.length === 1);

      expect(managerHarness.manager.sendMessage).toHaveBeenCalledWith("s1", "continue", undefined);
      expect(
        apiHarness.sendMessages.some((entry) =>
          String(entry.text).includes("unsupported file type"),
        ),
      ).toBe(true);
      expect(apiHarness.downloadFileCalls).toEqual([]);
    } finally {
      await adapter.close();
    }
  });

  it("skips oversized attachments with an immediate warning", async () => {
    const apiHarness = createApiHarness([
      [
        {
          update_id: 1,
          message: {
            chat: { id: 207, type: "private" },
            from: { id: 7 },
            text: "/new",
          },
        },
        {
          update_id: 2,
          message: {
            chat: { id: 207, type: "private" },
            from: { id: 7 },
            document: {
              file_id: "doc-big",
              file_name: "large.pdf",
              mime_type: "application/pdf",
              file_size: 21 * 1024 * 1024,
            },
          },
        },
        {
          update_id: 3,
          message: {
            chat: { id: 207, type: "private" },
            from: { id: 7 },
            text: "continue",
          },
        },
      ],
    ]);

    const managerHarness = createSessionManagerHarness();

    const adapter = await startAdapter({
      botToken: "token",
      projects: { demo: { repo: "git@example.com:demo.git" } },
      defaultProjectId: "demo",
      sessionManager: managerHarness.manager,
      api: apiHarness.api,
      pollIntervalMs: 1,
      requestTimeoutSeconds: 1,
    });

    try {
      await waitFor(() => managerHarness.manager.sendMessage.mock.calls.length === 1);

      expect(managerHarness.manager.sendMessage).toHaveBeenCalledWith("s1", "continue", undefined);
      expect(
        apiHarness.sendMessages.some((entry) => String(entry.text).includes("per-file limit")),
      ).toBe(true);
      expect(apiHarness.downloadFileCalls).toEqual([]);
    } finally {
      await adapter.close();
    }
  });

  it("prepends queued attachments to voice-triggered turns", async () => {
    const apiHarness = createApiHarness([
      [
        {
          update_id: 1,
          message: {
            chat: { id: 211, type: "private" },
            from: { id: 7 },
            text: "/use s31",
          },
        },
        {
          update_id: 2,
          message: {
            message_id: 903,
            chat: { id: 211, type: "private" },
            from: { id: 7 },
            caption: "dataset",
            voice: {
              file_id: "voice-31",
              mime_type: "audio/ogg",
            },
            document: {
              file_id: "doc-31",
              file_name: "data.json",
              mime_type: "application/json",
              file_size: 64,
            },
          },
        },
      ],
    ]);

    apiHarness.api.downloadFile.mockImplementation(async (fileId) => {
      apiHarness.downloadFileCalls.push(fileId);
      if (fileId === "voice-31") {
        return Buffer.from("voice-bytes");
      }
      return Buffer.from('{"ok":true}');
    });

    const managerHarness = createSessionManagerHarness(
      [
        {
          id: "s31",
          projectId: "demo",
          state: "waiting-input",
          createdAt: "2024-01-01T00:00:00.000Z",
          updatedAt: "2024-01-01T00:00:00.000Z",
        },
      ],
      { defaultOwnerId: ownerIdForChat(211) },
    );

    const mistralFetch = vi.fn(async () => createJsonResponse({ text: "transcribed voice" }));

    const adapter = await startAdapter({
      botToken: "token",
      projects: { demo: { repo: "git@example.com:demo.git" } },
      mistralApiKey: "mistral-key",
      sessionManager: managerHarness.manager,
      api: apiHarness.api,
      fetchImpl: mistralFetch,
      pollIntervalMs: 1,
      requestTimeoutSeconds: 1,
    });

    try {
      await waitFor(() => managerHarness.manager.sendMessage.mock.calls.length === 1);

      const sendMessageCall = managerHarness.manager.sendMessage.mock.calls[0];
      expect(sendMessageCall[0]).toBe("s31");
      expect(sendMessageCall[1]).toContain("attachments:");
      expect(sendMessageCall[1]).toContain("mime: application/json");
      expect(sendMessageCall[1]).toContain('caption: "dataset"');
      expect(sendMessageCall[1]).toContain("\n\ntranscribed voice");
      expect(apiHarness.downloadFileCalls).toEqual(["doc-31", "voice-31"]);
      await waitFor(() =>
        apiHarness.setMessageReactions.some(
          (entry) => entry.chatId === 211 && entry.messageId === 903,
        ),
      );
    } finally {
      await adapter.close();
    }
  });

  it("transcribes voice messages and sends the transcript to the active session", async () => {
    const apiHarness = createApiHarness([
      [
        {
          update_id: 1,
          message: {
            chat: { id: 210, type: "private" },
            from: { id: 7 },
            text: "/use s21",
          },
        },
        {
          update_id: 2,
          message: {
            message_id: 902,
            chat: { id: 210, type: "private" },
            from: { id: 7 },
            voice: {
              file_id: "voice-123",
              mime_type: "audio/ogg",
            },
          },
        },
      ],
    ]);

    const managerHarness = createSessionManagerHarness(
      [
        {
          id: "s21",
          projectId: "demo",
          state: "waiting-input",
          createdAt: "2024-01-01T00:00:00.000Z",
          updatedAt: "2024-01-01T00:00:00.000Z",
        },
      ],
      { defaultOwnerId: ownerIdForChat(210) },
    );

    const mistralFetch = vi.fn(async () => createJsonResponse({ text: "ship the fix" }));

    const adapter = await startAdapter({
      botToken: "token",
      projects: { demo: { repo: "git@example.com:demo.git" } },
      mistralApiKey: "mistral-key",
      sessionManager: managerHarness.manager,
      api: apiHarness.api,
      fetchImpl: mistralFetch,
      pollIntervalMs: 1,
      requestTimeoutSeconds: 1,
    });

    try {
      await waitFor(() => managerHarness.manager.sendMessage.mock.calls.length === 1);
      expect(apiHarness.downloadFileCalls).toEqual(["voice-123"]);
      expect(managerHarness.manager.sendMessage).toHaveBeenCalledWith(
        "s21",
        "ship the fix",
        undefined,
      );
      expect(mistralFetch).toHaveBeenCalledTimes(1);
      await waitFor(() =>
        apiHarness.setMessageReactions.some(
          (entry) => entry.chatId === 210 && entry.messageId === 902,
        ),
      );
    } finally {
      await adapter.close();
    }
  });

  it("shows an error for voice messages when mistral api key is missing", async () => {
    const apiHarness = createApiHarness([
      [
        {
          update_id: 1,
          message: {
            chat: { id: 220, type: "private" },
            from: { id: 7 },
            text: "/use s22",
          },
        },
        {
          update_id: 2,
          message: {
            chat: { id: 220, type: "private" },
            from: { id: 7 },
            voice: {
              file_id: "voice-456",
            },
          },
        },
      ],
    ]);

    const managerHarness = createSessionManagerHarness(
      [
        {
          id: "s22",
          projectId: "demo",
          state: "waiting-input",
          createdAt: "2024-01-01T00:00:00.000Z",
          updatedAt: "2024-01-01T00:00:00.000Z",
        },
      ],
      { defaultOwnerId: ownerIdForChat(220) },
    );

    const adapter = await startAdapter({
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
          entry.text.includes(
            "set MISTRAL_API_KEY or apiKeys.mistral to transcribe Telegram audio",
          ),
        ),
      );
      expect(managerHarness.manager.sendMessage).not.toHaveBeenCalled();
      expect(apiHarness.downloadFileCalls).toEqual([]);
    } finally {
      await adapter.close();
    }
  });

  it("shows a transcription error when mistral rejects telegram audio", async () => {
    const apiHarness = createApiHarness([
      [
        {
          update_id: 1,
          message: {
            chat: { id: 230, type: "private" },
            from: { id: 7 },
            text: "/use s23",
          },
        },
        {
          update_id: 2,
          message: {
            chat: { id: 230, type: "private" },
            from: { id: 7 },
            audio: {
              file_id: "audio-789",
              mime_type: "audio/mp3",
              file_name: "voice-note.mp3",
            },
          },
        },
      ],
    ]);

    const managerHarness = createSessionManagerHarness(
      [
        {
          id: "s23",
          projectId: "demo",
          state: "waiting-input",
          createdAt: "2024-01-01T00:00:00.000Z",
          updatedAt: "2024-01-01T00:00:00.000Z",
        },
      ],
      { defaultOwnerId: ownerIdForChat(230) },
    );

    const mistralFetch = vi.fn(async () => createJsonResponse({ message: "bad audio" }, 400));

    const adapter = await startAdapter({
      botToken: "token",
      projects: { demo: { repo: "git@example.com:demo.git" } },
      mistralApiKey: "mistral-key",
      sessionManager: managerHarness.manager,
      api: apiHarness.api,
      fetchImpl: mistralFetch,
      pollIntervalMs: 1,
      requestTimeoutSeconds: 1,
    });

    try {
      await waitFor(() =>
        apiHarness.sendMessages.some((entry) =>
          entry.text.includes("audio transcription failed: bad audio"),
        ),
      );
      expect(managerHarness.manager.sendMessage).not.toHaveBeenCalled();
      expect(apiHarness.downloadFileCalls).toEqual(["audio-789"]);
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

    const adapter = await startAdapter({
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

  it("treats unknown slash commands as unsupported", async () => {
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
            text: "/bogus",
          },
        },
      ],
    ]);

    const managerHarness = createSessionManagerHarness(
      [
        {
          id: "s2",
          projectId: "demo",
          state: "waiting-input",
          createdAt: "2024-01-01T00:00:00.000Z",
          updatedAt: "2024-01-01T00:00:00.000Z",
        },
      ],
      { defaultOwnerId: ownerIdForChat(300) },
    );

    const adapter = await startAdapter({
      botToken: "token",
      projects: { demo: { repo: "git@example.com:demo.git" } },
      sessionManager: managerHarness.manager,
      api: apiHarness.api,
      pollIntervalMs: 1,
      requestTimeoutSeconds: 1,
    });

    try {
      await waitFor(() => apiHarness.sendMessages.length >= 2);
      expect(
        apiHarness.sendMessages.some((entry) =>
          String(entry.text).includes("unsupported command. use /help"),
        ),
      ).toBe(true);
    } finally {
      await adapter.close();
    }
  });

  it("supports /interrupt for active sessions", async () => {
    const apiHarness = createApiHarness([
      [
        {
          update_id: 1,
          message: {
            chat: { id: 305, type: "private" },
            from: { id: 7 },
            text: "/use s2",
          },
        },
        {
          update_id: 2,
          message: {
            chat: { id: 305, type: "private" },
            from: { id: 7 },
            text: "/interrupt",
          },
        },
        {
          update_id: 3,
          message: {
            chat: { id: 305, type: "private" },
            from: { id: 7 },
            text: "continue",
          },
        },
      ],
    ]);

    const managerHarness = createSessionManagerHarness(
      [
        {
          id: "s2",
          projectId: "demo",
          state: "running",
          createdAt: "2024-01-01T00:00:00.000Z",
          updatedAt: "2024-01-01T00:00:00.000Z",
        },
      ],
      { defaultOwnerId: ownerIdForChat(305) },
    );

    const adapter = await startAdapter({
      botToken: "token",
      projects: { demo: { repo: "git@example.com:demo.git" } },
      sessionManager: managerHarness.manager,
      api: apiHarness.api,
      pollIntervalMs: 1,
      requestTimeoutSeconds: 1,
    });

    try {
      await waitFor(() => managerHarness.manager.interruptSession.mock.calls.length === 1);
      expect(managerHarness.manager.interruptSession).toHaveBeenCalledWith("s2");
      expect(
        apiHarness.sendMessages.some((entry) =>
          String(entry.text).includes("(s2) interrupt requested"),
        ),
      ).toBe(true);
      await waitFor(() => managerHarness.manager.sendMessage.mock.calls.length === 1);
      expect(managerHarness.manager.sendMessage).toHaveBeenCalledWith("s2", "continue", undefined);
    } finally {
      await adapter.close();
    }
  });

  it("supports /close for the selected session", async () => {
    const apiHarness = createApiHarness([
      [
        {
          update_id: 1,
          message: {
            chat: { id: 310, type: "private" },
            from: { id: 7 },
            text: "/use s2",
          },
        },
        {
          update_id: 2,
          message: {
            chat: { id: 310, type: "private" },
            from: { id: 7 },
            text: "/close",
          },
        },
      ],
    ]);

    const managerHarness = createSessionManagerHarness(
      [
        {
          id: "s2",
          projectId: "demo",
          state: "waiting-input",
          createdAt: "2024-01-01T00:00:00.000Z",
          updatedAt: "2024-01-01T00:00:00.000Z",
        },
      ],
      { defaultOwnerId: ownerIdForChat(310) },
    );

    const adapter = await startAdapter({
      botToken: "token",
      projects: { demo: { repo: "git@example.com:demo.git" } },
      sessionManager: managerHarness.manager,
      api: apiHarness.api,
      pollIntervalMs: 1,
      requestTimeoutSeconds: 1,
    });

    try {
      await waitFor(() => managerHarness.manager.closeSession.mock.calls.length === 1);
      expect(managerHarness.manager.closeSession).toHaveBeenCalledWith("s2");
      expect(
        apiHarness.sendMessages.some((entry) => String(entry.text).includes("(s2) closed")),
      ).toBe(true);
    } finally {
      await adapter.close();
    }
  });

  it("supports /close <id>", async () => {
    const apiHarness = createApiHarness([
      [
        {
          update_id: 1,
          message: {
            chat: { id: 320, type: "private" },
            from: { id: 7 },
            text: "/close s3",
          },
        },
      ],
    ]);

    const managerHarness = createSessionManagerHarness(
      [
        {
          id: "s3",
          projectId: "demo",
          state: "waiting-input",
          createdAt: "2024-01-01T00:00:00.000Z",
          updatedAt: "2024-01-01T00:00:00.000Z",
        },
      ],
      { defaultOwnerId: ownerIdForChat(320) },
    );

    const adapter = await startAdapter({
      botToken: "token",
      projects: { demo: { repo: "git@example.com:demo.git" } },
      sessionManager: managerHarness.manager,
      api: apiHarness.api,
      pollIntervalMs: 1,
      requestTimeoutSeconds: 1,
    });

    try {
      await waitFor(() => managerHarness.manager.closeSession.mock.calls.length === 1);
      expect(managerHarness.manager.closeSession).toHaveBeenCalledWith("s3");
      expect(
        apiHarness.sendMessages.some((entry) => String(entry.text).includes("(s3) closed")),
      ).toBe(true);
    } finally {
      await adapter.close();
    }
  });

  it("supports /close all for waiting-input and failed sessions", async () => {
    const apiHarness = createApiHarness([
      [
        {
          update_id: 1,
          message: {
            chat: { id: 330, type: "private" },
            from: { id: 7 },
            text: "/close all",
          },
        },
      ],
    ]);

    const managerHarness = createSessionManagerHarness(
      [
        {
          id: "s1",
          projectId: "demo",
          state: "waiting-input",
          createdAt: "2024-01-01T00:00:00.000Z",
          updatedAt: "2024-01-01T00:00:00.000Z",
        },
        {
          id: "s2",
          projectId: "demo",
          state: "running",
          createdAt: "2024-01-01T00:00:00.000Z",
          updatedAt: "2024-01-01T00:00:00.000Z",
        },
        {
          id: "s3",
          projectId: "demo",
          state: "failed",
          createdAt: "2024-01-01T00:00:00.000Z",
          updatedAt: "2024-01-01T00:00:00.000Z",
        },
        {
          id: "s5",
          projectId: "demo",
          state: "queued",
          createdAt: "2024-01-01T00:00:00.000Z",
          updatedAt: "2024-01-01T00:00:00.000Z",
        },
        {
          id: "s6",
          projectId: "demo",
          state: "preparing-workspace",
          createdAt: "2024-01-01T00:00:00.000Z",
          updatedAt: "2024-01-01T00:00:00.000Z",
        },
      ],
      { defaultOwnerId: ownerIdForChat(330) },
    );

    const adapter = await startAdapter({
      botToken: "token",
      projects: { demo: { repo: "git@example.com:demo.git" } },
      sessionManager: managerHarness.manager,
      api: apiHarness.api,
      pollIntervalMs: 1,
      requestTimeoutSeconds: 1,
    });

    try {
      await waitFor(() => managerHarness.manager.closeSession.mock.calls.length === 2);
      expect(managerHarness.manager.closeSession).toHaveBeenCalledWith("s1");
      expect(managerHarness.manager.closeSession).toHaveBeenCalledWith("s3");
      expect(
        apiHarness.sendMessages.some(
          (entry) =>
            entry.text.includes("closed 2 sessions") &&
            entry.text.includes("s1") &&
            entry.text.includes("s3") &&
            !entry.text.includes("s2") &&
            !entry.text.includes("s5") &&
            !entry.text.includes("s6"),
        ),
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

    const managerHarness = createSessionManagerHarness(
      [
        {
          id: "s9",
          projectId: "demo",
          state: "waiting-input",
          createdAt: "2024-01-01T00:00:00.000Z",
          updatedAt: "2024-01-01T00:00:00.000Z",
        },
      ],
      { defaultOwnerId: ownerIdForChat(400) },
    );

    const adapter = await startAdapter({
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
      await waitFor(
        () =>
          apiHarness.sendMessages.some((entry) => entry.text.includes("(s9) run started")) &&
          apiHarness.sendMessages.some((entry) => entry.text.includes("(s9) run finished")) &&
          apiHarness.sendMessages.some((entry) => entry.text.includes("(s9) run failed")),
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

    const managerHarness = createSessionManagerHarness(
      [
        {
          id: "s10",
          projectId: "demo",
          state: "running",
          createdAt: "2024-01-01T00:00:00.000Z",
          updatedAt: "2024-01-01T00:00:00.000Z",
        },
      ],
      { defaultOwnerId: ownerIdForChat(450) },
    );

    const adapter = await startAdapter({
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

    const managerHarness = createSessionManagerHarness(
      [
        {
          id: "s11",
          projectId: "demo",
          state: "waiting-input",
          createdAt: "2024-01-01T00:00:00.000Z",
          updatedAt: "2024-01-01T00:00:00.000Z",
        },
      ],
      { defaultOwnerId: ownerIdForChat(460) },
    );

    const adapter = await startAdapter({
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

  it("keeps forwarding session events after /new switches the selected session", async () => {
    const apiHarness = createApiHarness([
      [
        {
          update_id: 1,
          message: {
            chat: { id: 465, type: "private" },
            from: { id: 7 },
            text: "/new",
          },
        },
        {
          update_id: 2,
          message: {
            chat: { id: 465, type: "private" },
            from: { id: 7 },
            text: "/verbose",
          },
        },
        {
          update_id: 3,
          message: {
            chat: { id: 465, type: "private" },
            from: { id: 7 },
            text: "/new",
          },
        },
      ],
    ]);

    const managerHarness = createSessionManagerHarness();

    const adapter = await startAdapter({
      botToken: "token",
      projects: { demo: { repo: "git@example.com:demo.git" } },
      sessionManager: managerHarness.manager,
      api: apiHarness.api,
      pollIntervalMs: 1,
      requestTimeoutSeconds: 1,
    });

    try {
      await waitFor(() => managerHarness.manager.createSession.mock.calls.length === 2);

      managerHarness.manager.emit({
        type: "session-progress",
        sessionId: "s1",
        projectId: "demo",
        state: "running",
        timestamp: "2024-01-01T00:01:00.000Z",
        progress: {
          type: "assistant-message",
          text: "first session update",
        },
      });

      await waitFor(() =>
        apiHarness.sendMessages.some((entry) => entry.text.includes("(s1) assistant message")),
      );

      expect(
        apiHarness.sendMessages.some((entry) => entry.text.includes("(s1) assistant message")),
      ).toBe(true);
    } finally {
      await adapter.close();
    }
  });

  it("scopes /quiet and /verbose to the selected session while multiplexing", async () => {
    const apiHarness = createApiHarness([
      [
        {
          update_id: 1,
          message: {
            chat: { id: 466, type: "private" },
            from: { id: 7 },
            text: "/use s1",
          },
        },
        {
          update_id: 2,
          message: {
            chat: { id: 466, type: "private" },
            from: { id: 7 },
            text: "/verbose",
          },
        },
        {
          update_id: 3,
          message: {
            chat: { id: 466, type: "private" },
            from: { id: 7 },
            text: "/use s2",
          },
        },
        {
          update_id: 4,
          message: {
            chat: { id: 466, type: "private" },
            from: { id: 7 },
            text: "/quiet",
          },
        },
      ],
    ]);

    const managerHarness = createSessionManagerHarness(
      [
        {
          id: "s1",
          projectId: "demo",
          state: "waiting-input",
          createdAt: "2024-01-01T00:00:00.000Z",
          updatedAt: "2024-01-01T00:00:00.000Z",
        },
        {
          id: "s2",
          projectId: "demo",
          state: "waiting-input",
          createdAt: "2024-01-01T00:00:00.000Z",
          updatedAt: "2024-01-01T00:00:00.000Z",
        },
      ],
      { defaultOwnerId: ownerIdForChat(466) },
    );

    const adapter = await startAdapter({
      botToken: "token",
      projects: { demo: { repo: "git@example.com:demo.git" } },
      sessionManager: managerHarness.manager,
      api: apiHarness.api,
      pollIntervalMs: 1,
      requestTimeoutSeconds: 1,
    });

    try {
      await waitFor(() => apiHarness.sendMessages.length >= 4);

      managerHarness.manager.emit({
        type: "session-progress",
        sessionId: "s1",
        projectId: "demo",
        state: "running",
        timestamp: "2024-01-01T00:01:00.000Z",
        progress: {
          type: "assistant-message",
          text: "update from s1",
        },
      });

      managerHarness.manager.emit({
        type: "session-state-changed",
        sessionId: "s2",
        projectId: "demo",
        previousState: "waiting-input",
        state: "running",
        updatedAt: "2024-01-01T00:02:00.000Z",
      });

      managerHarness.manager.emit({
        type: "session-progress",
        sessionId: "s2",
        projectId: "demo",
        state: "running",
        timestamp: "2024-01-01T00:03:00.000Z",
        progress: {
          type: "assistant-message",
          text: "final from s2",
        },
      });

      managerHarness.manager.emit({
        type: "session-state-changed",
        sessionId: "s2",
        projectId: "demo",
        previousState: "running",
        state: "waiting-input",
        updatedAt: "2024-01-01T00:04:00.000Z",
      });

      await waitFor(
        () =>
          apiHarness.sendMessages.some((entry) => entry.text.includes("(s1) assistant message")) &&
          apiHarness.sendMessages.some((entry) => entry.text === "final from s2"),
      );

      expect(
        apiHarness.sendMessages.some((entry) => entry.text.includes("(s2) assistant message")),
      ).toBe(false);
    } finally {
      await adapter.close();
    }
  });

  it("sends a queued acknowledgement in verbose mode and reacts to user messages", async () => {
    const apiHarness = createApiHarness([
      [
        {
          update_id: 1,
          message: {
            chat: { id: 475, type: "private" },
            from: { id: 7 },
            text: "/use s13",
          },
        },
        {
          update_id: 2,
          message: {
            chat: { id: 475, type: "private" },
            from: { id: 7 },
            text: "/verbose",
          },
        },
        {
          update_id: 3,
          message: {
            message_id: 777,
            chat: { id: 475, type: "private" },
            from: { id: 7 },
            text: "ship it",
          },
        },
      ],
    ]);

    const managerHarness = createSessionManagerHarness(
      [
        {
          id: "s13",
          projectId: "demo",
          state: "waiting-input",
          createdAt: "2024-01-01T00:00:00.000Z",
          updatedAt: "2024-01-01T00:00:00.000Z",
        },
      ],
      { defaultOwnerId: ownerIdForChat(475) },
    );

    const adapter = await startAdapter({
      botToken: "token",
      projects: { demo: { repo: "git@example.com:demo.git" } },
      sessionManager: managerHarness.manager,
      api: apiHarness.api,
      pollIntervalMs: 1,
      requestTimeoutSeconds: 1,
    });

    try {
      await waitFor(() => managerHarness.manager.sendMessage.mock.calls.length === 1);
      expect(managerHarness.manager.sendMessage).toHaveBeenCalledWith("s13", "ship it", undefined);

      await waitFor(() =>
        apiHarness.sendMessages.some((entry) => entry.text.includes("(s13) message queued")),
      );
      await waitFor(() =>
        apiHarness.setMessageReactions.some(
          (entry) => entry.chatId === 475 && entry.messageId === 777,
        ),
      );
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

    const managerHarness = createSessionManagerHarness(
      [
        {
          id: "s12",
          projectId: "demo",
          state: "waiting-input",
          createdAt: "2024-01-01T00:00:00.000Z",
          updatedAt: "2024-01-01T00:00:00.000Z",
        },
      ],
      { defaultOwnerId: ownerIdForChat(470) },
    );

    const adapter = await startAdapter({
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
