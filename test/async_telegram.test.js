import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
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

function getRequestUrl(input) {
  if (typeof input === "string") {
    return input;
  }
  if (input instanceof URL) {
    return input.toString();
  }
  return input.url;
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

  const pendingTelegramCall = () => new Promise(() => {});

  function createTelegramFetchStub(handlers) {
    const methodCalls = new Map();
    return vi.fn(async (input, init) => {
      const url = getRequestUrl(input);
      const method = url.slice(url.lastIndexOf("/") + 1);
      const count = (methodCalls.get(method) ?? 0) + 1;
      methodCalls.set(method, count);
      const handler = handlers[method];
      if (!handler) {
        throw new Error(`unexpected telegram method call: ${url}`);
      }
      return handler({ call: count, init });
    });
  }

  it.each([
    {
      name: "setMyCommands returns a malformed ack payload",
      handlers: {
        setMyCommands: async () => createJsonResponse({ ok: true, result: { accepted: true } }),
        getUpdates: async () => pendingTelegramCall(),
      },
      expectWarning: (entry) =>
        entry.level === "warn" &&
        entry.message === "failed to sync telegram commands" &&
        String(entry.data?.cause).includes("telegram setMyCommands returned an invalid result"),
    },
    {
      name: "getUpdates returns a malformed envelope",
      handlers: {
        setMyCommands: async () => createJsonResponse({ ok: true, result: true }),
        getUpdates: async ({ call }) =>
          call === 1 ? createJsonResponse({ ok: true }) : pendingTelegramCall(),
      },
      expectWarning: (entry) =>
        entry.level === "warn" &&
        entry.message === "telegram poll failed" &&
        String(entry.data?.cause).includes("telegram getUpdates returned"),
    },
  ])("logs a clear warning when $name", async ({ handlers, expectWarning }) => {
    const managerHarness = createSessionManagerHarness();
    const logs = [];

    vi.stubGlobal("fetch", createTelegramFetchStub(handlers));

    const adapter = await startAdapter({
      botToken: "token",
      projects: { demo: { repo: "git@example.com:demo.git" } },
      sessionManager: managerHarness.manager,
      pollIntervalMs: 1,
      requestTimeoutSeconds: 1,
      onLog: (entry) => logs.push(entry),
    });

    try {
      await waitFor(() => logs.some(expectWarning));
    } finally {
      await adapter.close();
      vi.unstubAllGlobals();
    }
  });

  it("reports getFile result parsing errors when attachment file paths are malformed", async () => {
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
      { defaultOwnerId: ownerIdForChat(990) },
    );

    const sendMessageTexts = [];

    vi.stubGlobal(
      "fetch",
      createTelegramFetchStub({
        setMyCommands: async () => createJsonResponse({ ok: true, result: true }),
        getUpdates: async ({ call }) =>
          call === 1
            ? createJsonResponse({
                ok: true,
                result: [
                  {
                    update_id: 1,
                    message: {
                      message_id: 11,
                      chat: { id: 990, type: "private" },
                      from: { id: 7 },
                      text: "ship",
                      document: {
                        file_id: "doc-file-1",
                        file_name: "note.txt",
                        mime_type: "text/plain",
                      },
                    },
                  },
                ],
              })
            : pendingTelegramCall(),
        getFile: async () => createJsonResponse({ ok: true, result: {} }),
        sendMessage: async ({ init }) => {
          if (typeof init?.body === "string") {
            sendMessageTexts.push(JSON.parse(init.body).text);
          }
          return createJsonResponse({ ok: true, result: {} });
        },
        setMessageReaction: async () => createJsonResponse({ ok: true, result: true }),
      }),
    );

    const adapter = await startAdapter({
      botToken: "token",
      projects: { demo: { repo: "git@example.com:demo.git" } },
      sessionManager: managerHarness.manager,
      pollIntervalMs: 1,
      requestTimeoutSeconds: 1,
    });

    try {
      await waitFor(() =>
        sendMessageTexts.some(
          (text) =>
            text.includes("failed to download attachment") &&
            text.includes("telegram getFile returned an invalid result"),
        ),
      );
    } finally {
      await adapter.close();
      vi.unstubAllGlobals();
    }
  });
});
