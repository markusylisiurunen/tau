import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import { startTelegramAdapter } from "../dist/core/telegram/adapter.js";

async function startAdapter(options) {
  return startTelegramAdapter({
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

function createApiHarness(updateBatches, options = {}) {
  const queue = [...updateBatches];
  const sendMessages = [];
  const sendRichMessages = [];
  const richMessageDrafts = [];
  const chatActions = [];
  const downloadFileCalls = [];
  const setCommandsCalls = [];
  const setMessageReactions = [];
  const answerCallbackQueryCalls = [];

  const api = {
    getMe: vi.fn(async () => ({ username: options.botUsername ?? "tau_bot" })),
    getUpdates: vi.fn(async () => {
      if (queue.length > 0) {
        return queue.shift();
      }

      return await new Promise(() => {});
    }),
    sendMessage: vi.fn(async (chatId, text, options) => {
      sendMessages.push({ chatId, text, options, sentAt: Date.now() });
    }),
    sendRichMessage: vi.fn(async (chatId, markdown, options) => {
      sendRichMessages.push({ chatId, markdown, options, sentAt: Date.now() });
    }),
    sendRichMessageDraft: vi.fn(async (chatId, draftId, markdown) => {
      richMessageDrafts.push({ chatId, draftId, markdown, sentAt: Date.now() });
    }),
    sendChatAction: vi.fn(async (chatId, action) => {
      chatActions.push({ chatId, action, sentAt: Date.now() });
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
    sendRichMessages,
    richMessageDrafts,
    chatActions,
    downloadFileCalls,
    setCommandsCalls,
    setMessageReactions,
    answerCallbackQueryCalls,
  };
}

function ownerIdForChat(chatId, botId = "bot-default") {
  return `telegram:${botId}:chat:${chatId}`;
}

function createStatusSnapshot(overrides = {}) {
  return {
    sessionId: "tau-session",
    revision: 1,
    lifecycle: "idle",
    settings: {
      personaId: "default",
      reasoning: "medium",
      riskLevel: "read-write",
    },
    bootstrap: {
      model: {
        id: "claude-opus-4-6",
        name: "Claude Opus 4.6",
        api: "messages",
        provider: "anthropic",
        baseUrl: "https://api.anthropic.com",
        reasoning: true,
        input: ["text"],
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
        contextWindow: 200000,
        maxTokens: 32000,
      },
    },
    catalog: { personas: {}, prompts: {}, themes: {}, skills: {}, subagents: {} },
    executionEnvironment: { kind: "local", cwd: "/tmp/project", home: "/tmp" },
    messages: [
      {
        id: "m1",
        state: "committed",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "done" }],
          stopReason: "end_turn",
          usage: {
            input: 1000,
            output: 500,
            cacheRead: 250,
            cacheWrite: 250,
            contextWindowUsageTokens: 12000,
            contextWindow: 200000,
            cost: { total: 0.12345 },
          },
        },
      },
    ],
    timeline: [],
    tools: {},
    agents: {},
    facets: {},
    ...overrides,
  };
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
        ...(options.createSnapshot
          ? { snapshot: options.createSnapshot(sessionId, projectId) }
          : {}),
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
    getSessionSnapshot: vi.fn(async (sessionId) => {
      const session = sessions.get(sessionId);
      return session?.snapshot;
    }),
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

describe("telegram adapter", () => {
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
        { command: "new", description: "start a new session" },
        { command: "status", description: "show active session status" },
        { command: "interrupt", description: "interrupt active run" },
      ]);
    } finally {
      await adapter.close();
    }
  });

  it("reports active session status with model, reasoning, context, and cost", async () => {
    const apiHarness = createApiHarness([
      [
        {
          update_id: 1,
          message: {
            chat: { id: 12, type: "private" },
            from: { id: 7 },
            text: "/new",
          },
        },
        {
          update_id: 2,
          message: {
            chat: { id: 12, type: "private" },
            from: { id: 7 },
            text: "/status",
          },
        },
      ],
    ]);

    const managerHarness = createSessionManagerHarness([], {
      createSnapshot: () => createStatusSnapshot(),
    });

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
        apiHarness.sendMessages.some((entry) => String(entry.text).includes("context usage")),
      );
      expect(apiHarness.sendMessages.map((entry) => entry.text)).toContain(
        "your demo session s1 is waiting-input. it is using Claude Opus 4.6 with medium reasoning. context usage is 6.0% of 200k tokens. cumulative cost is $0.12.",
      );
    } finally {
      await adapter.close();
    }
  });

  it("restores active group routing from persisted session ownership", async () => {
    const chatId = -12;
    const apiHarness = createApiHarness([
      [
        {
          update_id: 1,
          message: {
            chat: { id: chatId, type: "supergroup" },
            from: { id: 7 },
            text: "/status@tau_bot",
          },
        },
        {
          update_id: 2,
          message: {
            chat: { id: chatId, type: "supergroup" },
            from: { id: 7 },
            text: "@tau_bot continue",
          },
        },
      ],
    ]);
    const managerHarness = createSessionManagerHarness([
      {
        id: "restored-session",
        projectId: "demo",
        ownerId: ownerIdForChat(chatId),
        state: "waiting-input",
        createdAt: "2024-01-01T00:00:00.000Z",
        updatedAt: "2024-01-01T00:00:00.000Z",
        snapshot: createStatusSnapshot(),
      },
    ]);

    const adapter = await startAdapter({
      botToken: "token",
      projects: { demo: { repo: "git@example.com:demo.git" } },
      allowedChatIds: [chatId],
      sessionManager: managerHarness.manager,
      api: apiHarness.api,
      pollIntervalMs: 1,
      requestTimeoutSeconds: 1,
    });

    try {
      await waitFor(() =>
        apiHarness.sendMessages.some((entry) => String(entry.text).includes("context usage")),
      );
      expect(managerHarness.manager.getSessionSnapshot).toHaveBeenCalledWith("restored-session");
      await waitFor(() => managerHarness.manager.sendMessage.mock.calls.length === 1);
      expect(managerHarness.manager.sendMessage).toHaveBeenCalledWith(
        "restored-session",
        expect.stringContaining('text: "continue"'),
        { mode: "steer" },
      );
      expect(apiHarness.sendMessages.map((entry) => entry.text)).toContain(
        "your demo session restored-session is waiting-input. it is using Claude Opus 4.6 with medium reasoning. context usage is 6.0% of 200k tokens. cumulative cost is $0.12.",
      );
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
            text: "/new",
          },
        },
        {
          update_id: 2,
          message: {
            chat: { id: 20, type: "private" },
            from: { id: 5 },
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
      await waitFor(() => managerHarness.manager.createSession.mock.calls.length === 1);
      expect(managerHarness.manager.createSession).toHaveBeenCalledWith({
        projectId: "demo",
        ownerId: ownerIdForChat(20),
      });
      expect(apiHarness.sendMessages).toEqual([]);
    } finally {
      await adapter.close();
    }
  });

  it("routes allowed group mentions with sender-attributed pending context", async () => {
    const groupChatId = -1001;
    const apiHarness = createApiHarness([
      [
        {
          update_id: 1,
          message: {
            chat: { id: groupChatId, type: "supergroup" },
            from: { id: 7, first_name: "Ada", username: "ada" },
            text: "we should update docs",
          },
        },
        {
          update_id: 2,
          message: {
            message_id: 602,
            chat: { id: groupChatId, type: "supergroup" },
            from: { id: 8, first_name: "Grace", last_name: "Hopper", username: "grace" },
            text: "@tau_bot please summarize",
          },
        },
      ],
    ]);

    const managerHarness = createSessionManagerHarness(
      [
        {
          id: "s-group",
          projectId: "demo",
          state: "waiting-input",
          createdAt: "2024-01-01T00:00:00.000Z",
          updatedAt: "2024-01-01T00:00:00.000Z",
        },
      ],
      { defaultOwnerId: ownerIdForChat(groupChatId) },
    );

    const adapter = await startAdapter({
      botToken: "token",
      projects: { demo: { repo: "git@example.com:demo.git" } },
      allowedChatIds: [groupChatId],
      sessionManager: managerHarness.manager,
      api: apiHarness.api,
      pollIntervalMs: 1,
      requestTimeoutSeconds: 1,
    });

    try {
      await waitFor(() => managerHarness.manager.sendMessage.mock.calls.length === 1);
      const sendMessageCall = managerHarness.manager.sendMessage.mock.calls[0];
      expect(sendMessageCall[0]).toBe("s-group");
      expect(sendMessageCall[1]).toContain("<system>");
      expect(sendMessageCall[1]).toContain(
        "recent non-triggering group messages, attachments, audio transcripts, and processing errors since the previous bot-triggering turn",
      );
      expect(sendMessageCall[1]).toContain("<telegram-group-context>");
      expect(sendMessageCall[1]).toContain("sender: Ada (@ada, id 7)");
      expect(sendMessageCall[1]).toContain('text: "we should update docs"');
      expect(sendMessageCall[1]).toContain("<telegram-trigger-message>");
      expect(sendMessageCall[1]).toContain("sender: Grace Hopper (@grace, id 8)");
      expect(sendMessageCall[1]).toContain('text: "please summarize"');
      expect(sendMessageCall[2]).toEqual({ mode: "steer" });
      await waitFor(() =>
        apiHarness.setMessageReactions.some(
          (entry) => entry.chatId === groupChatId && entry.messageId === 602,
        ),
      );
    } finally {
      await adapter.close();
    }
  });

  it("includes group attachments and audio transcripts as pending context messages", async () => {
    const groupChatId = -1002;
    const apiHarness = createApiHarness([
      [
        {
          update_id: 1,
          message: {
            chat: { id: groupChatId, type: "group" },
            from: { id: 7, first_name: "Ada", username: "ada" },
            photo: [{ file_id: "photo-1", file_size: 123, width: 100, height: 100 }],
          },
        },
        {
          update_id: 2,
          message: {
            chat: { id: groupChatId, type: "group" },
            from: { id: 8, first_name: "Alan", username: "alan" },
            caption: "second image",
            photo: [{ file_id: "photo-2", file_size: 234, width: 100, height: 100 }],
          },
        },
        {
          update_id: 3,
          message: {
            chat: { id: groupChatId, type: "group" },
            from: { id: 9, first_name: "Katherine", username: "kat" },
            voice: { file_id: "voice-1", mime_type: "audio/ogg" },
          },
        },
        {
          update_id: 4,
          message: {
            chat: { id: groupChatId, type: "group" },
            from: { id: 10, first_name: "Margaret", username: "margaret" },
            text: "normal context",
          },
        },
        {
          update_id: 5,
          message: {
            chat: { id: groupChatId, type: "group" },
            from: { id: 12, first_name: "Edsger", username: "edsger" },
            document: {
              file_id: "exe-1",
              file_name: "tool.exe",
              mime_type: "application/octet-stream",
            },
          },
        },
        {
          update_id: 6,
          message: {
            message_id: 603,
            chat: { id: groupChatId, type: "group" },
            from: { id: 11, first_name: "Grace", username: "grace" },
            text: "@tau_bot summarize",
          },
        },
      ],
    ]);
    apiHarness.api.downloadFile.mockImplementation(async (fileId) => {
      apiHarness.downloadFileCalls.push(fileId);
      return Buffer.from(`${fileId} bytes`);
    });
    const mistralFetch = vi.fn(async () => createJsonResponse({ text: "transcribed audio" }));
    const managerHarness = createSessionManagerHarness(
      [
        {
          id: "s-group",
          projectId: "demo",
          state: "waiting-input",
          createdAt: "2024-01-01T00:00:00.000Z",
          updatedAt: "2024-01-01T00:00:00.000Z",
        },
      ],
      { defaultOwnerId: ownerIdForChat(groupChatId) },
    );

    const adapter = await startAdapter({
      botToken: "token",
      projects: { demo: { repo: "git@example.com:demo.git" } },
      allowedChatIds: [groupChatId],
      mistralApiKey: "mistral-key",
      sessionManager: managerHarness.manager,
      api: apiHarness.api,
      fetchImpl: mistralFetch,
      pollIntervalMs: 1,
      requestTimeoutSeconds: 1,
    });

    try {
      await waitFor(() => managerHarness.manager.sendMessage.mock.calls.length === 1);
      const text = managerHarness.manager.sendMessage.mock.calls[0][1];
      expect(text).toContain("1. sender: Ada (@ada, id 7)");
      expect(text).toContain("   attachments:");
      expect(text).toContain("- path:");
      expect(text).toContain("mime: image/jpeg");
      expect(text).toContain("2. sender: Alan (@alan, id 8)");
      expect(text).toContain('   text: "second image"');
      expect(text).toContain('caption: "second image"');
      expect(text).toContain("3. sender: Katherine (@kat, id 9)");
      expect(text).toContain('   audio_transcript: "transcribed audio"');
      expect(text).toContain("4. sender: Margaret (@margaret, id 10)");
      expect(text).toContain('   text: "normal context"');
      expect(text).toContain("5. sender: Edsger (@edsger, id 12)");
      expect(text).toContain("   errors:");
      expect(text).toContain("- \"skipped attachment 'tool.exe': unsupported file type\"");
      expect(text).toContain("<telegram-trigger-message>");
      expect(text).toContain('text: "summarize"');
      expect(apiHarness.downloadFileCalls).toEqual(["photo-1", "photo-2", "voice-1"]);
      expect(mistralFetch).toHaveBeenCalledTimes(1);
      await waitFor(() => apiHarness.sendMessages.length === 1);
      expect(apiHarness.sendMessages[0].text).toContain(
        "some Telegram group context could not be processed",
      );
      expect(apiHarness.sendMessages[0].text).toContain(
        "skipped attachment 'tool.exe': unsupported file type",
      );
    } finally {
      await adapter.close();
    }
  });

  it("requires allowedChatIds before processing group mentions", async () => {
    const apiHarness = createApiHarness([
      [
        {
          update_id: 1,
          message: {
            chat: { id: -1002, type: "group" },
            from: { id: 7, first_name: "Ada" },
            text: "@tau_bot please respond",
          },
        },
      ],
    ]);
    const managerHarness = createSessionManagerHarness(
      [
        {
          id: "s-group",
          projectId: "demo",
          state: "waiting-input",
          createdAt: "2024-01-01T00:00:00.000Z",
          updatedAt: "2024-01-01T00:00:00.000Z",
        },
      ],
      { defaultOwnerId: ownerIdForChat(-1002) },
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
      await waitFor(() => apiHarness.api.getUpdates.mock.calls.length >= 1);
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(managerHarness.manager.sendMessage).not.toHaveBeenCalled();
      expect(apiHarness.sendMessages).toEqual([]);
    } finally {
      await adapter.close();
    }
  });

  it("caps pending group context at the most recent 50 messages", async () => {
    const groupChatId = -1003;
    const messages = Array.from({ length: 51 }, (_, index) => ({
      update_id: index + 1,
      message: {
        chat: { id: groupChatId, type: "group" },
        from: { id: index + 10, first_name: `User${index + 1}` },
        text: `pending ${index + 1}`,
      },
    }));
    messages.push({
      update_id: 52,
      message: {
        message_id: 620,
        chat: { id: groupChatId, type: "group" },
        from: { id: 99, first_name: "Trigger" },
        text: "@tau_bot go",
      },
    });

    const apiHarness = createApiHarness([messages]);
    const managerHarness = createSessionManagerHarness(
      [
        {
          id: "s-group",
          projectId: "demo",
          state: "waiting-input",
          createdAt: "2024-01-01T00:00:00.000Z",
          updatedAt: "2024-01-01T00:00:00.000Z",
        },
      ],
      { defaultOwnerId: ownerIdForChat(groupChatId) },
    );

    const adapter = await startAdapter({
      botToken: "token",
      projects: { demo: { repo: "git@example.com:demo.git" } },
      allowedChatIds: [groupChatId],
      sessionManager: managerHarness.manager,
      api: apiHarness.api,
      pollIntervalMs: 1,
      requestTimeoutSeconds: 1,
    });

    try {
      await waitFor(() => managerHarness.manager.sendMessage.mock.calls.length === 1);
      const text = managerHarness.manager.sendMessage.mock.calls[0][1];
      expect(text).not.toContain('text: "pending 1"');
      expect(text).toContain('text: "pending 2"');
      expect(text).toContain('text: "pending 51"');
      expect(text).toContain('text: "go"');
    } finally {
      await adapter.close();
    }
  });

  it("requires bot mentions for group commands", async () => {
    const groupChatId = -1004;
    const apiHarness = createApiHarness([
      [
        {
          update_id: 1,
          message: {
            chat: { id: groupChatId, type: "group" },
            from: { id: 7, first_name: "Ada" },
            text: "/new",
          },
        },
        {
          update_id: 2,
          message: {
            chat: { id: groupChatId, type: "group" },
            from: { id: 7, first_name: "Ada" },
            text: "/new@other_bot @tau_bot",
          },
        },
        {
          update_id: 3,
          message: {
            chat: { id: groupChatId, type: "group" },
            from: { id: 7, first_name: "Ada" },
            text: "/new@tau_bot",
          },
        },
        {
          update_id: 4,
          message: {
            chat: { id: groupChatId, type: "group" },
            from: { id: 7, first_name: "Ada" },
            text: "/new @tau_bot",
          },
        },
        {
          update_id: 5,
          message: {
            chat: { id: groupChatId, type: "group" },
            from: { id: 7, first_name: "Ada" },
            text: "@tau_bot /new",
          },
        },
      ],
    ]);
    const managerHarness = createSessionManagerHarness();

    const adapter = await startAdapter({
      botToken: "token",
      projects: { demo: { repo: "git@example.com:demo.git" } },
      allowedChatIds: [groupChatId],
      sessionManager: managerHarness.manager,
      api: apiHarness.api,
      pollIntervalMs: 1,
      requestTimeoutSeconds: 1,
    });

    try {
      await waitFor(() => managerHarness.manager.createSession.mock.calls.length === 3);
      expect(managerHarness.manager.createSession.mock.calls).toEqual([
        [{ projectId: "demo", ownerId: ownerIdForChat(groupChatId) }],
        [{ projectId: "demo", ownerId: ownerIdForChat(groupChatId) }],
        [{ projectId: "demo", ownerId: ownerIdForChat(groupChatId) }],
      ]);
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
        mode: "steer",
        additionalSystemMessage: "telegram guidance",
      });

      await waitFor(() =>
        apiHarness.sendMessages.some(
          (entry) => String(entry.text) === "all set, your demo session s1 is ready.",
        ),
      );

      expect(
        apiHarness.sendMessages.some((entry) =>
          String(entry.text).includes("session is being prepared"),
        ),
      ).toBe(false);
      expect(
        apiHarness.sendMessages.some((entry) => String(entry.text).includes("(s1) message queued")),
      ).toBe(false);
      await waitFor(() =>
        apiHarness.setMessageReactions.some(
          (entry) => entry.chatId === 200 && entry.messageId === 501,
        ),
      );
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
      expect(sendMessageCall[2]).toEqual({ mode: "steer" });
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
      expect(managerHarness.manager.sendMessage).toHaveBeenCalledWith("s21", "ship the fix", {
        mode: "steer",
      });
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

  it("transcribes voice messages with Gemini when configured", async () => {
    const apiHarness = createApiHarness([
      [
        {
          update_id: 1,
          message: {
            chat: { id: 211, type: "private" },
            from: { id: 7 },
            voice: {
              file_id: "voice-456",
              mime_type: "audio/ogg",
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
      { defaultOwnerId: ownerIdForChat(211) },
    );

    const geminiFetch = vi.fn(async () =>
      createJsonResponse({
        candidates: [
          {
            content: {
              parts: [
                {
                  text: JSON.stringify({
                    transcription: "use google transcription",
                  }),
                },
              ],
            },
          },
        ],
      }),
    );

    const adapter = await startAdapter({
      botToken: "token",
      projects: { demo: { repo: "git@example.com:demo.git" } },
      speechToTextProvider: "gemini",
      geminiApiKey: "gemini-key",
      sessionManager: managerHarness.manager,
      api: apiHarness.api,
      fetchImpl: geminiFetch,
      pollIntervalMs: 1,
      requestTimeoutSeconds: 1,
    });

    try {
      await waitFor(() => managerHarness.manager.sendMessage.mock.calls.length === 1);
      expect(apiHarness.downloadFileCalls).toEqual(["voice-456"]);
      expect(managerHarness.manager.sendMessage).toHaveBeenCalledWith(
        "s22",
        "use google transcription",
        { mode: "steer" },
      );
      expect(geminiFetch).toHaveBeenCalledTimes(1);
      const request = JSON.parse(geminiFetch.mock.calls[0][1].body);
      expect(request.generationConfig.responseMimeType).toBe("application/json");
      expect(request.generationConfig.responseSchema.required).toEqual(["transcription"]);
      expect(request.generationConfig.thinkingConfig.thinkingLevel).toBe("minimal");
      expect(request.contents[0].parts[1].inlineData.mimeType).toBe("audio/ogg");
    } finally {
      await adapter.close();
    }
  });

  it("rejects removed session-management commands", async () => {
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
      expect(apiHarness.sendMessages[0].text).toBe(
        "unsupported command. supported commands: /new, /status, /interrupt",
      );
      expect(managerHarness.manager.closeSession).not.toHaveBeenCalled();
    } finally {
      await adapter.close();
    }
  });

  it("sends assistant progress messages in quiet mode", async () => {
    const apiHarness = createApiHarness([
      [
        {
          update_id: 1,
          message: {
            chat: { id: 470, type: "private" },
            from: { id: 7 },
            text: "start",
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
      await waitFor(() => managerHarness.manager.sendMessage.mock.calls.length === 1);

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

      await waitFor(() =>
        apiHarness.sendRichMessages.some((entry) => entry.markdown === "final answer"),
      );

      expect(apiHarness.chatActions).toContainEqual(
        expect.objectContaining({ chatId: 470, action: "typing" }),
      );
      expect(apiHarness.sendRichMessages).toEqual([
        expect.objectContaining({ chatId: 470, markdown: "intermediate" }),
        expect.objectContaining({ chatId: 470, markdown: "final answer" }),
      ]);
      expect(apiHarness.richMessageDrafts).toEqual([]);
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

  it("does not send rich message drafts while a run is active", async () => {
    const apiHarness = createApiHarness([
      [
        {
          update_id: 1,
          message: {
            chat: { id: 471, type: "private" },
            from: { id: 7 },
            text: "start",
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
      { defaultOwnerId: ownerIdForChat(471) },
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

      vi.useFakeTimers();
      managerHarness.manager.emit({
        type: "session-state-changed",
        sessionId: "s13",
        projectId: "demo",
        previousState: "waiting-input",
        state: "running",
        updatedAt: "2024-01-01T00:01:00.000Z",
      });

      expect(apiHarness.richMessageDrafts).toEqual([]);
      await vi.advanceTimersByTimeAsync(20_000);
      expect(apiHarness.richMessageDrafts).toEqual([]);

      managerHarness.manager.emit({
        type: "session-progress",
        sessionId: "s13",
        projectId: "demo",
        state: "running",
        timestamp: "2024-01-01T00:01:10.000Z",
        progress: {
          type: "assistant-message",
          text: "checking the logs",
        },
      });

      await waitFor(() =>
        apiHarness.sendRichMessages.some((entry) => entry.markdown === "checking the logs"),
      );
      expect(apiHarness.richMessageDrafts).toEqual([]);

      managerHarness.manager.emit({
        type: "session-state-changed",
        sessionId: "s13",
        projectId: "demo",
        previousState: "running",
        state: "waiting-input",
        updatedAt: "2024-01-01T00:02:00.000Z",
      });
      await vi.advanceTimersByTimeAsync(20_000);
      expect(apiHarness.richMessageDrafts).toEqual([]);
    } finally {
      vi.useRealTimers();
      await adapter.close();
    }
  });

  it("logs notification send failures from session events", async () => {
    const apiHarness = createApiHarness([
      [{ update_id: 1, message: { chat: { id: 472, type: "private" }, text: "/new" } }],
    ]);
    apiHarness.api.sendRichMessage.mockRejectedValueOnce(new Error("telegram unavailable"));
    const managerHarness = createSessionManagerHarness();
    const logs = [];

    const adapter = await startAdapter({
      botToken: "token",
      projects: { demo: { repo: "git@example.com:demo.git" } },
      sessionManager: managerHarness.manager,
      api: apiHarness.api,
      pollIntervalMs: 1,
      requestTimeoutSeconds: 1,
      onLog: (entry) => logs.push(entry),
    });

    try {
      await waitFor(() => managerHarness.manager.createSession.mock.calls.length === 1);

      managerHarness.manager.emit({
        type: "session-progress",
        sessionId: "s1",
        projectId: "demo",
        state: "running",
        timestamp: "2024-01-01T00:04:00.000Z",
        progress: { type: "assistant-message", text: "final answer" },
      });
      managerHarness.manager.emit({
        type: "session-state-changed",
        sessionId: "s1",
        projectId: "demo",
        previousState: "running",
        state: "waiting-input",
        updatedAt: "2024-01-01T00:05:00.000Z",
      });

      await waitFor(() =>
        logs.some(
          (entry) =>
            entry.level === "warn" &&
            entry.message === "failed to send telegram notification" &&
            entry.data?.cause === "telegram unavailable",
        ),
      );
    } finally {
      await adapter.close();
    }
  });

  it("splits oversized quiet-mode replies into multiple telegram messages", async () => {
    const apiHarness = createApiHarness([
      [
        {
          update_id: 1,
          message: {
            chat: { id: 471, type: "private" },
            from: { id: 7 },
            text: "start",
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
      { defaultOwnerId: ownerIdForChat(471) },
    );

    const adapter = await startAdapter({
      botToken: "token",
      projects: { demo: { repo: "git@example.com:demo.git" } },
      sessionManager: managerHarness.manager,
      api: apiHarness.api,
      pollIntervalMs: 1,
      requestTimeoutSeconds: 1,
    });

    const finalAnswer = "🙂".repeat(9000);

    try {
      await waitFor(() => managerHarness.manager.sendMessage.mock.calls.length === 1);

      managerHarness.manager.emit({
        type: "session-state-changed",
        sessionId: "s13",
        projectId: "demo",
        previousState: "waiting-input",
        state: "running",
        updatedAt: "2024-01-01T00:01:00.000Z",
      });

      managerHarness.manager.emit({
        type: "session-progress",
        sessionId: "s13",
        projectId: "demo",
        state: "running",
        timestamp: "2024-01-01T00:02:00.000Z",
        progress: {
          type: "assistant-message",
          text: finalAnswer,
        },
      });

      managerHarness.manager.emit({
        type: "session-state-changed",
        sessionId: "s13",
        projectId: "demo",
        previousState: "running",
        state: "waiting-input",
        updatedAt: "2024-01-01T00:03:00.000Z",
      });

      await waitFor(
        () =>
          apiHarness.sendRichMessages.filter((entry) => String(entry.markdown).startsWith("🙂"))
            .length === 2,
        4000,
      );

      const chunks = apiHarness.sendRichMessages.filter((entry) =>
        String(entry.markdown).startsWith("🙂"),
      );
      expect(chunks.map((entry) => entry.markdown).join("")).toBe(finalAnswer);
      for (const chunk of chunks) {
        expect(Buffer.byteLength(chunk.markdown, "utf8")).toBeLessThanOrEqual(
          Math.floor(32 * 1024 * 0.95),
        );
      }
      expect(chunks[1].sentAt - chunks[0].sentAt).toBeGreaterThanOrEqual(900);
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
        if (method === "getMe") {
          return createJsonResponse({ ok: true, result: { username: "tau_bot" } });
        }
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
