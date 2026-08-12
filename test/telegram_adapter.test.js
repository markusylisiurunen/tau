import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { describe, expect, it, vi } from "vitest";
import { startTelegramAdapter, TelegramRequestError } from "../dist/core/telegram/adapter.js";
import { TauSessionProtocolResponseError } from "../dist/transport/errors.js";

async function startAdapter(options) {
  const preferences = new Map();
  const ttsPreferences = new Map();
  const projectPreferences = options.projectPreferences ?? {
    initialize: vi.fn(async () => {}),
    get: vi.fn((ownerId) => preferences.get(ownerId)),
    set: vi.fn(async (ownerId, projectId) => {
      preferences.set(ownerId, projectId);
    }),
    isTtsEnabled: vi.fn((ownerId) => ttsPreferences.get(ownerId) ?? false),
    setTtsEnabled: vi.fn(async (ownerId, enabled) => {
      ttsPreferences.set(ownerId, enabled);
    }),
  };
  await projectPreferences.initialize();
  return startTelegramAdapter({
    botId: "bot-default",
    ...options,
    projectPreferences,
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

function deferred() {
  let resolve;
  const promise = new Promise((res) => {
    resolve = res;
  });
  return { promise, resolve };
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
  const sendVoices = [];
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
    sendVoice: vi.fn(async (chatId, voice, options) => {
      sendVoices.push({ chatId, voice, options, sentAt: Date.now() });
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
    sendVoices,
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
    goal: null,
    costTotal: 0.12345,
    settings: {
      personaId: "default",
      reasoning: "medium",
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
    catalog: {
      personas: [
        {
          id: "default",
          label: "Default",
          allowedReasoningLevels: ["low", "medium", "high", "xhigh"],
          skills: "*",
          source: "builtin",
        },
      ],
      prompts: [],
      skills: [],
    },
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
    timeline: { epoch: 1, sequence: 0, items: [] },
    tools: {},
    operations: {},
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
    getProvisionFailures: vi.fn((sessionId) =>
      (options.provisionFailures ?? [])
        .filter((failure) => failure.sessionId === sessionId)
        .map((failure) => ({ ...failure })),
    ),
    getPendingTurnNotifications: vi.fn((sessionId) =>
      (options.turnNotifications ?? [])
        .filter((notification) => notification.sessionId === sessionId)
        .map((notification) => structuredClone(notification)),
    ),
    acknowledgeTurnNotification: vi.fn(async () => {}),
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
    compactSession: vi.fn(async (sessionId) => {
      const session = sessions.get(sessionId);
      if (!session) throw new Error("missing session");
      return {
        snapshot: session.snapshot,
        compactionMessage: "summary",
        includedLastAssistant: false,
      };
    }),
    setReasoning: vi.fn(async (sessionId, reasoning) => {
      const session = sessions.get(sessionId);
      if (!session) throw new Error("missing session");
      return {
        revision: 2,
        settings: { personaId: "default", reasoning },
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

async function startNotificationTestAdapter({ chatId, apiHarness, onLog, snapshot }) {
  const managerHarness = createSessionManagerHarness([
    {
      id: "s1",
      projectId: "demo",
      ownerId: ownerIdForChat(chatId),
      state: "running",
      createdAt: "2024-01-01T00:00:00.000Z",
      updatedAt: "2024-01-01T00:00:00.000Z",
      ...(snapshot ? { snapshot } : {}),
    },
  ]);
  const adapter = await startAdapter({
    botToken: "token",
    projects: { demo: { repo: "git@example.com:demo.git" } },
    sessionManager: managerHarness.manager,
    api: apiHarness.api,
    pollIntervalMs: 1,
    requestTimeoutSeconds: 1,
    onLog,
  });
  return { adapter, manager: managerHarness.manager };
}

function emitAssistantProgress(manager, messageId, text) {
  manager.emit({
    type: "session-progress",
    sessionId: "s1",
    projectId: "demo",
    state: "running",
    timestamp: "2024-01-01T00:04:00.000Z",
    progress: { type: "assistant-message", messageId, text },
  });
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
        { command: "compact", description: "compact session context" },
        { command: "interrupt", description: "interrupt active run" },
        { command: "tts_on", description: "enable voice responses" },
        { command: "tts_off", description: "disable voice responses" },
        { command: "effort_low", description: "set reasoning effort to low" },
        { command: "effort_medium", description: "set reasoning effort to medium" },
        { command: "effort_high", description: "set reasoning effort to high" },
        { command: "effort_xhigh", description: "set reasoning effort to xhigh" },
        { command: "use_demo", description: "use demo for new sessions" },
      ]);
    } finally {
      await adapter.close();
    }
  });

  it("persists TTS enablement and sends the final response as a voice note", async () => {
    const chatId = 13;
    const ownerId = ownerIdForChat(chatId);
    const ttsPreferences = new Map();
    const projectPreferences = {
      initialize: vi.fn(async () => {}),
      get: vi.fn(() => undefined),
      set: vi.fn(async () => {}),
      isTtsEnabled: vi.fn((id) => ttsPreferences.get(id) ?? false),
      setTtsEnabled: vi.fn(async (id, enabled) => {
        ttsPreferences.set(id, enabled);
      }),
    };
    const apiHarness = createApiHarness([
      [
        {
          update_id: 1,
          message: {
            chat: { id: chatId, type: "private" },
            from: { id: 7 },
            text: "/tts_on",
          },
        },
      ],
    ]);
    const managerHarness = createSessionManagerHarness([
      {
        id: "s-tts",
        projectId: "demo",
        ownerId,
        state: "running",
        createdAt: "2024-01-01T00:00:00.000Z",
        updatedAt: "2024-01-01T00:00:00.000Z",
      },
    ]);
    const generateVoice = vi.fn(async () => Buffer.from("ogg voice"));
    const adapter = await startAdapter({
      botToken: "token",
      projects: { demo: { repo: "git@example.com:demo.git" } },
      sessionManager: managerHarness.manager,
      projectPreferences,
      api: apiHarness.api,
      geminiApiKey: "gemini-key",
      generateVoice,
      pollIntervalMs: 1,
      requestTimeoutSeconds: 1,
    });

    try {
      await waitFor(() => apiHarness.sendMessages.length === 1);
      expect(apiHarness.sendMessages[0].text).toBe("voice responses enabled.");
      expect(projectPreferences.setTtsEnabled).toHaveBeenCalledWith(ownerId, true);

      managerHarness.manager.emit({
        type: "session-progress",
        sessionId: "s-tts",
        projectId: "demo",
        state: "running",
        timestamp: "2024-01-01T00:01:00.000Z",
        progress: {
          type: "assistant-message",
          messageId: "assistant-intermediate",
          text: "working on it",
        },
      });
      managerHarness.manager.emit({
        type: "session-progress",
        sessionId: "s-tts",
        projectId: "demo",
        state: "running",
        timestamp: "2024-01-01T00:02:00.000Z",
        progress: {
          type: "assistant-message",
          messageId: "assistant-final",
          text: "final answer",
        },
      });
      managerHarness.manager.emit({
        type: "session-response-completed",
        sessionId: "s-tts",
        projectId: "demo",
        timestamp: "2024-01-01T00:02:30.000Z",
        messageId: "assistant-final",
        text: "final answer",
      });
      managerHarness.manager.emit({
        type: "session-state-changed",
        sessionId: "s-tts",
        projectId: "demo",
        previousState: "running",
        state: "waiting-input",
        updatedAt: "2024-01-01T00:03:00.000Z",
      });

      await waitFor(() => apiHarness.sendVoices.length === 1);
      expect(generateVoice).toHaveBeenCalledWith({
        apiKey: "gemini-key",
        sourceText: "final answer",
        fetchImpl: undefined,
        signal: expect.any(AbortSignal),
      });
      expect(apiHarness.sendVoices[0]).toEqual(
        expect.objectContaining({ chatId, voice: Buffer.from("ogg voice") }),
      );
      expect(apiHarness.sendRichMessages.map((message) => message.markdown)).toEqual([
        "working on it",
        "final answer",
      ]);
      expect(apiHarness.sendVoices[0].sentAt).toBeGreaterThanOrEqual(
        apiHarness.sendRichMessages[1].sentAt,
      );
    } finally {
      await adapter.close();
    }
  });

  it("serializes voice generation for responses from the same session", async () => {
    const chatId = 15;
    const ownerId = ownerIdForChat(chatId);
    const apiHarness = createApiHarness([]);
    const managerHarness = createSessionManagerHarness([
      {
        id: "s-tts-order",
        projectId: "demo",
        ownerId,
        state: "waiting-input",
        createdAt: "2024-01-01T00:00:00.000Z",
        updatedAt: "2024-01-01T00:00:00.000Z",
      },
    ]);
    const firstVoice = deferred();
    const generateVoice = vi
      .fn()
      .mockImplementationOnce(async () => await firstVoice.promise)
      .mockResolvedValueOnce(Buffer.from("voice B"));
    const adapter = await startAdapter({
      botToken: "token",
      projects: { demo: { repo: "git@example.com:demo.git" } },
      sessionManager: managerHarness.manager,
      projectPreferences: {
        initialize: vi.fn(async () => {}),
        get: vi.fn(() => undefined),
        set: vi.fn(async () => {}),
        isTtsEnabled: vi.fn((id) => id === ownerId),
        setTtsEnabled: vi.fn(async () => {}),
      },
      api: apiHarness.api,
      geminiApiKey: "gemini-key",
      generateVoice,
      pollIntervalMs: 1,
      requestTimeoutSeconds: 1,
    });

    try {
      managerHarness.manager.emit({
        type: "session-response-completed",
        sessionId: "s-tts-order",
        projectId: "demo",
        timestamp: "2024-01-01T00:01:00.000Z",
        messageId: "assistant-a",
        text: "response A",
      });
      managerHarness.manager.emit({
        type: "session-response-completed",
        sessionId: "s-tts-order",
        projectId: "demo",
        timestamp: "2024-01-01T00:02:00.000Z",
        messageId: "assistant-b",
        text: "response B",
      });

      await waitFor(() => generateVoice.mock.calls.length === 1);
      expect(generateVoice.mock.calls[0][0].sourceText).toBe("response A");
      firstVoice.resolve(Buffer.from("voice A"));
      await waitFor(() => apiHarness.sendVoices.length === 2);

      expect(generateVoice.mock.calls.map(([options]) => options.sourceText)).toEqual([
        "response A",
        "response B",
      ]);
      expect(apiHarness.sendVoices.map(({ voice }) => voice.toString())).toEqual([
        "voice A",
        "voice B",
      ]);
    } finally {
      await adapter.close();
    }
  });

  it("aborts a Telegram voice job after five minutes and continues the session queue", async () => {
    vi.useFakeTimers();
    const chatId = 16;
    const ownerId = ownerIdForChat(chatId);
    const apiHarness = createApiHarness([]);
    const managerHarness = createSessionManagerHarness([
      {
        id: "s-tts-timeout",
        projectId: "demo",
        ownerId,
        state: "waiting-input",
        createdAt: "2024-01-01T00:00:00.000Z",
        updatedAt: "2024-01-01T00:00:00.000Z",
      },
    ]);
    const logs = [];
    const generateVoice = vi
      .fn()
      .mockImplementationOnce(
        async ({ signal }) =>
          await new Promise((_, reject) => {
            signal.addEventListener(
              "abort",
              () => {
                const error = new Error("aborted");
                error.name = "AbortError";
                reject(error);
              },
              { once: true },
            );
          }),
      )
      .mockResolvedValueOnce(Buffer.from("voice B"));
    const adapter = await startAdapter({
      botToken: "token",
      projects: { demo: { repo: "git@example.com:demo.git" } },
      sessionManager: managerHarness.manager,
      projectPreferences: {
        initialize: vi.fn(async () => {}),
        get: vi.fn(() => undefined),
        set: vi.fn(async () => {}),
        isTtsEnabled: vi.fn((id) => id === ownerId),
        setTtsEnabled: vi.fn(async () => {}),
      },
      api: apiHarness.api,
      geminiApiKey: "gemini-key",
      generateVoice,
      pollIntervalMs: 1,
      requestTimeoutSeconds: 1,
      onLog: (entry) => logs.push(entry),
    });

    try {
      for (const [messageId, text] of [
        ["assistant-a", "response A"],
        ["assistant-b", "response B"],
      ]) {
        managerHarness.manager.emit({
          type: "session-response-completed",
          sessionId: "s-tts-timeout",
          projectId: "demo",
          timestamp: "2024-01-01T00:01:00.000Z",
          messageId,
          text,
        });
      }

      await vi.advanceTimersByTimeAsync(5 * 60_000);
      await vi.advanceTimersByTimeAsync(0);
      expect(generateVoice.mock.calls.map(([options]) => options.sourceText)).toEqual([
        "response A",
        "response B",
      ]);
      expect(apiHarness.sendVoices.map(({ voice }) => voice.toString())).toEqual(["voice B"]);
      expect(apiHarness.sendMessages.map(({ text }) => text)).toEqual([
        "voice response failed. please try again.",
      ]);
      expect(logs).toContainEqual(
        expect.objectContaining({
          level: "error",
          message: "failed to generate Telegram voice response",
          data: expect.objectContaining({ cause: "voice generation timed out after 5 minutes" }),
        }),
      );
    } finally {
      vi.useRealTimers();
      await adapter.close();
    }
  });

  it("aborts voice delivery retries at the complete job deadline", async () => {
    vi.useFakeTimers();
    const chatId = 19;
    const ownerId = ownerIdForChat(chatId);
    const apiHarness = createApiHarness([]);
    apiHarness.api.sendVoice.mockRejectedValue(
      new TelegramRequestError("telegram rate limited voice", {
        retryable: true,
        retryAfterMs: 10 * 60_000,
      }),
    );
    const managerHarness = createSessionManagerHarness([
      {
        id: "s-tts-upload-timeout",
        projectId: "demo",
        ownerId,
        state: "waiting-input",
        createdAt: "2024-01-01T00:00:00.000Z",
        updatedAt: "2024-01-01T00:00:00.000Z",
      },
    ]);
    const logs = [];
    const adapter = await startAdapter({
      botToken: "token",
      projects: { demo: { repo: "git@example.com:demo.git" } },
      sessionManager: managerHarness.manager,
      projectPreferences: {
        initialize: vi.fn(async () => {}),
        get: vi.fn(() => undefined),
        set: vi.fn(async () => {}),
        isTtsEnabled: vi.fn((id) => id === ownerId),
        setTtsEnabled: vi.fn(async () => {}),
      },
      api: apiHarness.api,
      geminiApiKey: "gemini-key",
      generateVoice: vi.fn(async () => Buffer.from("voice")),
      pollIntervalMs: 1,
      requestTimeoutSeconds: 1,
      onLog: (entry) => logs.push(entry),
    });

    try {
      managerHarness.manager.emit({
        type: "session-response-completed",
        sessionId: "s-tts-upload-timeout",
        projectId: "demo",
        timestamp: "2024-01-01T00:01:00.000Z",
        messageId: "assistant-final",
        text: "final answer",
      });

      await vi.advanceTimersByTimeAsync(5 * 60_000);
      await vi.advanceTimersByTimeAsync(0);
      expect(apiHarness.api.sendVoice).toHaveBeenCalledTimes(1);
      expect(apiHarness.sendMessages.map(({ text }) => text)).toEqual([
        "voice response failed. please try again.",
      ]);
      expect(logs).toContainEqual({
        level: "error",
        message: "Telegram voice response job timed out",
        data: {
          sessionId: "s-tts-upload-timeout",
          chatId,
          cause: "voice response job timed out after 5 minutes",
        },
      });
    } finally {
      vi.useRealTimers();
      await adapter.close();
    }
  });

  it("notifies the user after voice delivery fails", async () => {
    const chatId = 17;
    const ownerId = ownerIdForChat(chatId);
    const apiHarness = createApiHarness([]);
    apiHarness.api.sendVoice.mockRejectedValue(
      new TelegramRequestError("telegram rejected voice", { retryable: false }),
    );
    const managerHarness = createSessionManagerHarness([
      {
        id: "s-tts-delivery-failure",
        projectId: "demo",
        ownerId,
        state: "waiting-input",
        createdAt: "2024-01-01T00:00:00.000Z",
        updatedAt: "2024-01-01T00:00:00.000Z",
      },
    ]);
    const logs = [];
    const adapter = await startAdapter({
      botToken: "token",
      projects: { demo: { repo: "git@example.com:demo.git" } },
      sessionManager: managerHarness.manager,
      projectPreferences: {
        initialize: vi.fn(async () => {}),
        get: vi.fn(() => undefined),
        set: vi.fn(async () => {}),
        isTtsEnabled: vi.fn((id) => id === ownerId),
        setTtsEnabled: vi.fn(async () => {}),
      },
      api: apiHarness.api,
      geminiApiKey: "gemini-key",
      generateVoice: vi.fn(async () => Buffer.from("voice")),
      pollIntervalMs: 1,
      requestTimeoutSeconds: 1,
      onLog: (entry) => logs.push(entry),
    });

    try {
      managerHarness.manager.emit({
        type: "session-response-completed",
        sessionId: "s-tts-delivery-failure",
        projectId: "demo",
        timestamp: "2024-01-01T00:01:00.000Z",
        messageId: "assistant-final",
        text: "final answer",
      });

      await waitFor(() => apiHarness.sendMessages.length === 1);
      expect(apiHarness.sendMessages[0].text).toBe("voice response failed. please try again.");
      expect(logs).toContainEqual({
        level: "error",
        message: "failed to send Telegram voice response",
        data: {
          sessionId: "s-tts-delivery-failure",
          chatId,
          attempts: 1,
          cause: "telegram rejected voice",
        },
      });
    } finally {
      await adapter.close();
    }
  });

  it("does not report a voice failure after TTS is disabled before delivery", async () => {
    const chatId = 18;
    const ownerId = ownerIdForChat(chatId);
    let enabled = true;
    const apiHarness = createApiHarness([]);
    const managerHarness = createSessionManagerHarness([
      {
        id: "s-tts-disabled",
        projectId: "demo",
        ownerId,
        state: "waiting-input",
        createdAt: "2024-01-01T00:00:00.000Z",
        updatedAt: "2024-01-01T00:00:00.000Z",
      },
    ]);
    const voice = deferred();
    const adapter = await startAdapter({
      botToken: "token",
      projects: { demo: { repo: "git@example.com:demo.git" } },
      sessionManager: managerHarness.manager,
      projectPreferences: {
        initialize: vi.fn(async () => {}),
        get: vi.fn(() => undefined),
        set: vi.fn(async () => {}),
        isTtsEnabled: vi.fn((id) => id === ownerId && enabled),
        setTtsEnabled: vi.fn(async () => {}),
      },
      api: apiHarness.api,
      geminiApiKey: "gemini-key",
      generateVoice: vi.fn(async () => await voice.promise),
      pollIntervalMs: 1,
      requestTimeoutSeconds: 1,
    });

    try {
      managerHarness.manager.emit({
        type: "session-response-completed",
        sessionId: "s-tts-disabled",
        projectId: "demo",
        timestamp: "2024-01-01T00:01:00.000Z",
        messageId: "assistant-final",
        text: "final answer",
      });
      enabled = false;
      voice.resolve(Buffer.from("voice"));
      await new Promise((resolve) => setTimeout(resolve, 20));

      expect(apiHarness.sendVoices).toHaveLength(0);
      expect(apiHarness.sendMessages).toHaveLength(0);
    } finally {
      await adapter.close();
    }
  });

  it("disables persisted voice responses with /tts_off", async () => {
    const chatId = 14;
    const ownerId = ownerIdForChat(chatId);
    const ttsPreferences = new Map([[ownerId, true]]);
    const projectPreferences = {
      initialize: vi.fn(async () => {}),
      get: vi.fn(() => undefined),
      set: vi.fn(async () => {}),
      isTtsEnabled: vi.fn((id) => ttsPreferences.get(id) ?? false),
      setTtsEnabled: vi.fn(async (id, enabled) => {
        ttsPreferences.set(id, enabled);
      }),
    };
    const apiHarness = createApiHarness([
      [
        {
          update_id: 1,
          message: {
            chat: { id: chatId, type: "private" },
            from: { id: 7 },
            text: "/tts_off",
          },
        },
      ],
    ]);
    const managerHarness = createSessionManagerHarness();
    const adapter = await startAdapter({
      botToken: "token",
      projects: { demo: { repo: "git@example.com:demo.git" } },
      sessionManager: managerHarness.manager,
      projectPreferences,
      api: apiHarness.api,
      pollIntervalMs: 1,
      requestTimeoutSeconds: 1,
    });

    try {
      await waitFor(() => apiHarness.sendMessages.length === 1);
      expect(apiHarness.sendMessages[0].text).toBe("voice responses disabled.");
      expect(projectPreferences.setTtsEnabled).toHaveBeenCalledWith(ownerId, false);
      expect(projectPreferences.isTtsEnabled(ownerId)).toBe(false);
    } finally {
      await adapter.close();
    }
  });

  it("reports composite project status, active goal state, and provision failures", async () => {
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
      createSnapshot: () =>
        createStatusSnapshot({
          goal: {
            objective: "A very long goal objective that must not appear in Telegram status output",
            status: "active",
          },
        }),
    });

    const adapter = await startAdapter({
      botToken: "token",
      projects: {
        alpha: { repo: "owner/alpha" },
        beta: { repo: "owner/beta" },
        platform: {
          projectIds: ["alpha", "beta"],
          persona: "gpt-5.6-sol-coder:high",
        },
      },
      defaultProjectId: "platform",
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
        "your platform (alpha, beta) session s1 is waiting for input. it is pursuing a goal. it is using Claude Opus 4.6 with medium reasoning. context usage is 6.0% of 200k tokens. cumulative cost is $0.12.",
      );

      managerHarness.manager.emit({
        type: "session-provision-failed",
        sessionId: "s1",
        projectId: "platform",
        targetProjectId: "alpha",
        diagnostic: "provision exited with code 17\ndependencies failed",
      });
      await waitFor(() =>
        apiHarness.sendMessages.some(
          (entry) =>
            entry.text ===
            "provisioning alpha failed in your platform session s1.\nprovision exited with code 17\ndependencies failed\nthe session remains available.",
        ),
      );
    } finally {
      await adapter.close();
    }
  });

  it("preserves detailed status when there is no goal", async () => {
    const chatId = 13;
    const apiHarness = createApiHarness([
      [
        {
          update_id: 1,
          message: {
            chat: { id: chatId, type: "private" },
            from: { id: 7 },
            text: "/status",
          },
        },
      ],
    ]);
    const managerHarness = createSessionManagerHarness([
      {
        id: "s1",
        projectId: "platform",
        ownerId: ownerIdForChat(chatId),
        state: "waiting-input",
        createdAt: "2024-01-01T00:00:00.000Z",
        updatedAt: "2024-01-01T00:00:00.000Z",
        snapshot: createStatusSnapshot(),
      },
    ]);

    const adapter = await startAdapter({
      botToken: "token",
      projects: {
        alpha: { repo: "owner/alpha" },
        beta: { repo: "owner/beta" },
        platform: {
          projectIds: ["alpha", "beta"],
          persona: "gpt-5.6-sol-coder:high",
        },
      },
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
        "your platform (alpha, beta) session s1 is waiting for input. it is using Claude Opus 4.6 with medium reasoning. context usage is 6.0% of 200k tokens. cumulative cost is $0.12.",
      );
    } finally {
      await adapter.close();
    }
  });

  it("uses project selectors only for future sessions", async () => {
    const apiHarness = createApiHarness([
      [
        {
          update_id: 1,
          message: {
            chat: { id: 18, type: "private" },
            from: { id: 7 },
            text: "/new",
          },
        },
        {
          update_id: 2,
          message: {
            chat: { id: 18, type: "private" },
            from: { id: 7 },
            text: "/use_beta",
          },
        },
        {
          update_id: 3,
          message: {
            chat: { id: 18, type: "private" },
            from: { id: 7 },
            text: "/status",
          },
        },
        {
          update_id: 4,
          message: {
            chat: { id: 18, type: "private" },
            from: { id: 7 },
            text: "/new",
          },
        },
      ],
    ]);
    const managerHarness = createSessionManagerHarness();

    const adapter = await startAdapter({
      botToken: "token",
      projects: {
        alpha: { repo: "owner/alpha" },
        beta: { repo: "owner/beta" },
      },
      defaultProjectId: "alpha",
      sessionManager: managerHarness.manager,
      api: apiHarness.api,
      pollIntervalMs: 1,
      requestTimeoutSeconds: 1,
    });

    try {
      await waitFor(() => managerHarness.manager.createSession.mock.calls.length === 2);
      expect(managerHarness.manager.createSession.mock.calls).toEqual([
        [
          {
            projectId: "alpha",
            ownerId: ownerIdForChat(18),
          },
        ],
        [
          {
            projectId: "beta",
            ownerId: ownerIdForChat(18),
          },
        ],
      ]);
      expect(managerHarness.manager.closeSession).toHaveBeenCalledTimes(1);
      expect(apiHarness.sendMessages.map((entry) => entry.text)).toEqual([
        "new chats will use beta.",
        "your alpha session s1 is waiting for input. new chats will use beta.",
      ]);
    } finally {
      await adapter.close();
    }
  });

  it("sets each supported reasoning effort on the active session", async () => {
    const chatId = 20;
    const apiHarness = createApiHarness([
      [
        ...["low", "medium", "high", "xhigh"].map((reasoning, index) => ({
          update_id: index + 1,
          message: {
            chat: { id: chatId, type: "private" },
            from: { id: 7 },
            text: `/effort_${reasoning}`,
          },
        })),
      ],
    ]);
    const managerHarness = createSessionManagerHarness(
      [
        {
          id: "reasoning-session",
          projectId: "demo",
          ownerId: ownerIdForChat(chatId),
          state: "running",
          createdAt: "2024-01-01T00:00:00.000Z",
          updatedAt: "2024-01-01T00:00:00.000Z",
          snapshot: createStatusSnapshot(),
        },
      ],
      { defaultOwnerId: ownerIdForChat(chatId) },
    );

    const adapter = await startAdapter({
      botToken: "token",
      projects: { demo: { repo: "owner/demo" } },
      sessionManager: managerHarness.manager,
      api: apiHarness.api,
      pollIntervalMs: 1,
      requestTimeoutSeconds: 1,
    });

    try {
      await waitFor(() => managerHarness.manager.setReasoning.mock.calls.length === 4);
      expect(managerHarness.manager.setReasoning.mock.calls).toEqual([
        ["reasoning-session", "low"],
        ["reasoning-session", "medium"],
        ["reasoning-session", "high"],
        ["reasoning-session", "xhigh"],
      ]);
      expect(apiHarness.sendMessages.map((entry) => entry.text)).toEqual([
        "reasoning effort set to low.",
        "reasoning effort set to medium.",
        "reasoning effort set to high.",
        "reasoning effort set to xhigh.",
      ]);
    } finally {
      await adapter.close();
    }
  });

  it("rejects reasoning efforts unsupported by the active persona or model", async () => {
    const personaChatId = 21;
    const modelChatId = 22;
    const apiHarness = createApiHarness([
      [
        {
          update_id: 1,
          message: {
            chat: { id: personaChatId, type: "private" },
            from: { id: 7 },
            text: "/effort_xhigh",
          },
        },
        {
          update_id: 2,
          message: {
            chat: { id: modelChatId, type: "private" },
            from: { id: 7 },
            text: "/effort_low",
          },
        },
      ],
    ]);
    const managerHarness = createSessionManagerHarness([
      {
        id: "limited-persona-session",
        projectId: "demo",
        ownerId: ownerIdForChat(personaChatId),
        state: "waiting-input",
        createdAt: "2024-01-01T00:00:00.000Z",
        updatedAt: "2024-01-01T00:00:00.000Z",
        snapshot: createStatusSnapshot({
          catalog: {
            personas: [
              {
                id: "default",
                label: "Default",
                allowedReasoningLevels: ["low", "medium", "high"],
                skills: "*",
                source: "builtin",
              },
            ],
            prompts: [],
            skills: [],
          },
        }),
      },
      {
        id: "non-reasoning-session",
        projectId: "demo",
        ownerId: ownerIdForChat(modelChatId),
        state: "waiting-input",
        createdAt: "2024-01-01T00:00:00.000Z",
        updatedAt: "2024-01-01T00:00:00.000Z",
        snapshot: createStatusSnapshot({
          bootstrap: {
            model: {
              ...createStatusSnapshot().bootstrap.model,
              reasoning: false,
            },
          },
        }),
      },
    ]);

    const adapter = await startAdapter({
      botToken: "token",
      projects: { demo: { repo: "owner/demo" } },
      sessionManager: managerHarness.manager,
      api: apiHarness.api,
      pollIntervalMs: 1,
      requestTimeoutSeconds: 1,
    });

    try {
      await waitFor(() => apiHarness.sendMessages.length === 2);
      expect(apiHarness.sendMessages.map((entry) => entry.text)).toEqual([
        "reasoning effort xhigh is not supported by this session.",
        "reasoning effort low is not supported by this session.",
      ]);
      expect(managerHarness.manager.setReasoning).not.toHaveBeenCalled();
    } finally {
      await adapter.close();
    }
  });

  it("requires an active session and rejects arguments for effort selectors", async () => {
    const activeChatId = 21;
    const inactiveChatId = 22;
    const apiHarness = createApiHarness([
      [
        {
          update_id: 1,
          message: {
            chat: { id: inactiveChatId, type: "private" },
            from: { id: 7 },
            text: "/effort_low",
          },
        },
        {
          update_id: 2,
          message: {
            chat: { id: activeChatId, type: "private" },
            from: { id: 7 },
            text: "/effort_high now",
          },
        },
      ],
    ]);
    const managerHarness = createSessionManagerHarness([
      {
        id: "reasoning-session",
        projectId: "demo",
        ownerId: ownerIdForChat(activeChatId),
        state: "waiting-input",
        createdAt: "2024-01-01T00:00:00.000Z",
        updatedAt: "2024-01-01T00:00:00.000Z",
      },
    ]);

    const adapter = await startAdapter({
      botToken: "token",
      projects: { demo: { repo: "owner/demo" } },
      sessionManager: managerHarness.manager,
      api: apiHarness.api,
      pollIntervalMs: 1,
      requestTimeoutSeconds: 1,
    });

    try {
      await waitFor(() => apiHarness.sendMessages.length === 2);
      expect(apiHarness.sendMessages.map((entry) => entry.text)).toEqual(
        expect.arrayContaining(["no active session. use /new.", "usage: /effort_high"]),
      );
      expect(managerHarness.manager.setReasoning).not.toHaveBeenCalled();
    } finally {
      await adapter.close();
    }
  });

  it("reports the preferred project when there is no active session", async () => {
    const apiHarness = createApiHarness([
      [
        {
          update_id: 1,
          message: {
            chat: { id: 19, type: "private" },
            from: { id: 7 },
            text: "/status",
          },
        },
      ],
    ]);
    const managerHarness = createSessionManagerHarness();

    const adapter = await startAdapter({
      botToken: "token",
      projects: { alpha: { repo: "owner/alpha" }, beta: { repo: "owner/beta" } },
      defaultProjectId: "alpha",
      sessionManager: managerHarness.manager,
      api: apiHarness.api,
      pollIntervalMs: 1,
      requestTimeoutSeconds: 1,
    });

    try {
      await waitFor(() => apiHarness.sendMessages.length === 1);
      expect(apiHarness.sendMessages[0].text).toBe("new chats will use alpha.");
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
    const managerHarness = createSessionManagerHarness(
      [
        {
          id: "restored-session",
          projectId: "demo",
          ownerId: ownerIdForChat(chatId),
          state: "waiting-input",
          createdAt: "2024-01-01T00:00:00.000Z",
          updatedAt: "2024-01-01T00:00:00.000Z",
          snapshot: createStatusSnapshot({
            goal: {
              objective: "A blocked goal objective that must not appear in Telegram status output",
              status: "blocked",
            },
          }),
        },
      ],
      {
        provisionFailures: [
          {
            type: "session-provision-failed",
            sessionId: "restored-session",
            projectId: "demo",
            targetProjectId: "demo",
            diagnostic: "provision exited with code 17\ndependencies failed",
          },
        ],
      },
    );

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
        { mode: "auto" },
      );
      expect(apiHarness.sendMessages.map((entry) => entry.text)).toContain(
        "your demo session restored-session is waiting for input. its goal is blocked. it is using Claude Opus 4.6 with medium reasoning. context usage is 6.0% of 200k tokens. cumulative cost is $0.12.",
      );
      expect(apiHarness.sendMessages).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            chatId,
            text: expect.stringContaining("dependencies failed"),
          }),
        ]),
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
      expect(sendMessageCall[2]).toEqual({ mode: "auto" });
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

  it("starts the delayed /new acknowledgment before closing the previous session", async () => {
    const chatId = 199;
    const apiHarness = createApiHarness([
      [
        {
          update_id: 1,
          message: {
            message_id: 500,
            chat: { id: chatId, type: "private" },
            from: { id: 7 },
            text: "/new",
          },
        },
      ],
    ]);
    const managerHarness = createSessionManagerHarness(
      [
        {
          id: "old-session",
          projectId: "demo",
          state: "waiting-input",
          createdAt: "2024-01-01T00:00:00.000Z",
          updatedAt: "2024-01-01T00:00:00.000Z",
        },
      ],
      { defaultOwnerId: ownerIdForChat(chatId) },
    );
    const closeSession = deferred();
    managerHarness.manager.closeSession.mockImplementation(async (sessionId) => {
      const session = managerHarness.sessions.get(sessionId);
      if (!session) {
        throw new Error("missing session");
      }
      await closeSession.promise;
      managerHarness.sessions.delete(sessionId);
      return { ...session };
    });

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
      await waitFor(() => managerHarness.manager.closeSession.mock.calls.length === 1);
      await waitFor(() =>
        apiHarness.setMessageReactions.some(
          (entry) => entry.chatId === chatId && entry.messageId === 500,
        ),
      );
      expect(managerHarness.manager.createSession).not.toHaveBeenCalled();

      closeSession.resolve();
      await waitFor(() => managerHarness.manager.createSession.mock.calls.length === 1);
    } finally {
      closeSession.resolve();
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
        mode: "auto",
        additionalSystemMessage: "telegram guidance",
      });

      await waitFor(() =>
        apiHarness.sendMessages.some(
          (entry) => String(entry.text) === "all set, your demo session s1 is ready.",
        ),
      );

      managerHarness.manager.emit({
        type: "session-provision-failed",
        sessionId: "s1",
        projectId: "demo",
        targetProjectId: "demo",
        diagnostic: "provision exited with code 17\ndependencies failed",
      });
      await waitFor(() =>
        apiHarness.sendMessages.some(
          (entry) =>
            entry.text ===
            "provisioning demo failed in your demo session s1.\nprovision exited with code 17\ndependencies failed\nthe session remains available.",
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
            message_id: 504,
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
      expect(sendMessageCall[2]).toEqual({ mode: "auto" });
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
      expect(apiHarness.setMessageReactions).not.toContainEqual({ chatId: 205, messageId: 504 });
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
        mode: "auto",
      });
      expect(apiHarness.sendMessages).toEqual([
        expect.objectContaining({ chatId: 210, text: "transcribed: ship the fix" }),
      ]);
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
        { mode: "auto" },
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

  it("compacts the active session", async () => {
    const apiHarness = createApiHarness([
      [
        {
          update_id: 1,
          message: { chat: { id: 329, type: "private" }, from: { id: 7 }, text: "/new" },
        },
        {
          update_id: 2,
          message: { chat: { id: 329, type: "private" }, from: { id: 7 }, text: "/compact" },
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
      await waitFor(() => apiHarness.sendMessages.length === 2);
      expect(managerHarness.manager.compactSession).toHaveBeenCalledWith("s1");
      expect(apiHarness.sendMessages.map((message) => message.text)).toEqual([
        "compacting session...",
        "session compacted. previous context has been summarized.",
      ]);
      expect(apiHarness.chatActions).toContainEqual(
        expect.objectContaining({ chatId: 329, action: "typing" }),
      );
    } finally {
      await adapter.close();
    }
  });

  it("keeps session compaction failures out of Telegram messages", async () => {
    const apiHarness = createApiHarness([
      [
        {
          update_id: 1,
          message: { chat: { id: 329, type: "private" }, from: { id: 7 }, text: "/new" },
        },
        {
          update_id: 2,
          message: { chat: { id: 329, type: "private" }, from: { id: 7 }, text: "/compact" },
        },
      ],
    ]);
    const managerHarness = createSessionManagerHarness();
    managerHarness.manager.compactSession.mockRejectedValueOnce(
      new TauSessionProtocolResponseError({
        requestId: "compact-1",
        error: {
          code: "internal_error",
          message: "session protocol request failed",
          data: { cause: "provider returned an oversized internal diagnostic" },
        },
      }),
    );
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
      await waitFor(() => apiHarness.sendMessages.length === 2);
      expect(apiHarness.sendMessages.map((message) => message.text)).toEqual([
        "compacting session...",
        "session compaction failed. please try again.",
      ]);
      expect(logs).toContainEqual({
        level: "error",
        message: "telegram session compaction failed",
        data: {
          sessionId: "s1",
          cause:
            "session protocol request failed: provider returned an oversized internal diagnostic",
        },
      });
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
        "unsupported command. supported commands: /new, /status, /compact, /interrupt, /tts_on, /tts_off, /effort_low, /effort_medium, /effort_high, /effort_xhigh, /use_demo",
      );
      expect(managerHarness.manager.closeSession).not.toHaveBeenCalled();
    } finally {
      await adapter.close();
    }
  });

  it("does not replay recovered timeline items after subscribing", async () => {
    const chatId = 470;
    const apiHarness = createApiHarness([]);
    const snapshot = createStatusSnapshot({
      timeline: {
        epoch: 1,
        sequence: 2,
        items: [
          {
            type: "notice",
            id: "notice-history-unavailable",
            sequence: 1,
            createdAt: 1,
            notice: {
              kind: "tau.history.unavailable",
              version: 1,
              severity: "warn",
              subject: { type: "session" },
              presentation: {
                title: "Recovered history warning.",
                content: ["Internal recovery details must stay out of Telegram."],
              },
              data: {},
            },
          },
          {
            type: "notice",
            id: "notice-turn-failed",
            sequence: 2,
            createdAt: 2,
            notice: {
              kind: "tau.turn.failed",
              version: 1,
              severity: "error",
              subject: { type: "session" },
              presentation: { title: "Recovered turn failed." },
              data: { reason: "runtime-error" },
            },
          },
        ],
      },
    });
    const { adapter, manager } = await startNotificationTestAdapter({
      chatId,
      apiHarness,
      snapshot,
    });

    try {
      expect(manager.getSessionSnapshot).not.toHaveBeenCalled();
      expect(apiHarness.sendMessages).toEqual([]);
    } finally {
      await adapter.close();
    }
  });

  it("delivers session warning notices through the ordered notification queue", async () => {
    const chatId = 470;
    const apiHarness = createApiHarness([]);
    const { adapter, manager } = await startNotificationTestAdapter({ chatId, apiHarness });

    try {
      manager.emit({
        type: "session-notice",
        sessionId: "s1",
        projectId: "demo",
        timestamp: "2024-01-01T00:01:00.000Z",
        severity: "warn",
        text: "Session history is unavailable. This session will continue.",
      });

      await waitFor(() =>
        apiHarness.sendMessages.some(
          (message) =>
            message.text === "Session history is unavailable. This session will continue.",
        ),
      );
    } finally {
      await adapter.close();
    }
  });

  it("delivers turn failures recovered before the adapter subscribed", async () => {
    const chatId = 469;
    const nextUpdate = deferred();
    const apiHarness = createApiHarness([nextUpdate.promise]);
    const managerHarness = createSessionManagerHarness(
      [
        {
          id: "s-recovered-failure",
          projectId: "demo",
          state: "waiting-input",
          createdAt: "2024-01-01T00:00:00.000Z",
          updatedAt: "2024-01-01T00:00:00.000Z",
        },
      ],
      {
        defaultOwnerId: ownerIdForChat(chatId),
        turnNotifications: [
          {
            type: "session-turn-failed",
            sessionId: "s-recovered-failure",
            projectId: "demo",
            timestamp: "2024-01-01T00:01:00.000Z",
            historyEntryId: "telegram-turn-recovered",
            failure: {
              status: "failed",
              stopReason: "error",
              errorMessage: "connection lost after settlement",
            },
          },
        ],
      },
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
        apiHarness.sendMessages.some(
          (message) => message.text === "turn failed. please try again.",
        ),
      );
      await waitFor(() => managerHarness.manager.acknowledgeTurnNotification.mock.calls.length > 0);
      expect(managerHarness.manager.acknowledgeTurnNotification).toHaveBeenCalledWith(
        "s-recovered-failure",
        "telegram-turn-recovered",
      );
    } finally {
      nextUpdate.resolve([]);
      await adapter.close();
    }
  });

  it("keeps rejected-turn notifications pending when Telegram delivery fails", async () => {
    const chatId = 469;
    const nextUpdate = deferred();
    const apiHarness = createApiHarness([nextUpdate.promise]);
    apiHarness.api.sendMessage.mockRejectedValue(
      new TelegramRequestError("telegram unavailable", { retryable: false }),
    );
    const managerHarness = createSessionManagerHarness(
      [
        {
          id: "s-rejected-turn",
          projectId: "demo",
          state: "waiting-input",
          createdAt: "2024-01-01T00:00:00.000Z",
          updatedAt: "2024-01-01T00:00:00.000Z",
        },
      ],
      {
        defaultOwnerId: ownerIdForChat(chatId),
        turnNotifications: [
          {
            type: "session-turn-rejected",
            sessionId: "s-rejected-turn",
            projectId: "demo",
            timestamp: "2024-01-01T00:01:00.000Z",
            historyEntryId: "telegram-turn-rejected",
          },
        ],
      },
    );
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
      await waitFor(() =>
        logs.some((entry) => entry.message === "failed to send telegram notification"),
      );
      expect(managerHarness.manager.acknowledgeTurnNotification).not.toHaveBeenCalled();
    } finally {
      nextUpdate.resolve([]);
      await adapter.close();
    }
  });

  it("reports a failed turn and keeps routing messages to the same session", async () => {
    const logs = [];
    const nextUpdate = deferred();
    const apiHarness = createApiHarness([
      [
        {
          update_id: 1,
          message: {
            message_id: 700,
            chat: { id: 470, type: "private" },
            from: { id: 7 },
            text: "first",
          },
        },
      ],
      nextUpdate.promise,
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
      onLog: (entry) => logs.push(entry),
    });

    try {
      await waitFor(() => managerHarness.manager.sendMessage.mock.calls.length === 1);

      vi.useFakeTimers();
      managerHarness.sessions.get("s12").state = "running";
      managerHarness.manager.emit({
        type: "session-state-changed",
        sessionId: "s12",
        projectId: "demo",
        previousState: "waiting-input",
        state: "running",
        updatedAt: "2024-01-01T00:01:00.000Z",
      });
      const typingCountBeforeFailure = apiHarness.chatActions.length;
      managerHarness.manager.emit({
        type: "session-turn-failed",
        sessionId: "s12",
        projectId: "demo",
        timestamp: "2024-01-01T00:01:30.000Z",
        historyEntryId: "telegram-turn-failed",
        failure: {
          status: "failed",
          stopReason: "error",
          errorMessage: "OpenAI is unavailable",
        },
      });
      await vi.advanceTimersByTimeAsync(4_000);
      expect(apiHarness.chatActions.length).toBeGreaterThan(typingCountBeforeFailure);

      managerHarness.sessions.get("s12").state = "waiting-input";
      managerHarness.manager.emit({
        type: "session-state-changed",
        sessionId: "s12",
        projectId: "demo",
        previousState: "running",
        state: "waiting-input",
        updatedAt: "2024-01-01T00:02:00.000Z",
      });
      const typingCountAfterRun = apiHarness.chatActions.length;
      await vi.advanceTimersByTimeAsync(8_000);
      expect(apiHarness.chatActions).toHaveLength(typingCountAfterRun);
      vi.useRealTimers();

      await waitFor(() =>
        apiHarness.sendMessages.some(
          (message) => message.text === "turn failed. please try again.",
        ),
      );
      expect(logs).toContainEqual({
        level: "error",
        message: "telegram session turn failed",
        data: {
          sessionId: "s12",
          projectId: "demo",
          failure: {
            status: "failed",
            stopReason: "error",
            errorMessage: "OpenAI is unavailable",
          },
        },
      });

      nextUpdate.resolve([
        {
          update_id: 2,
          message: {
            message_id: 701,
            chat: { id: 470, type: "private" },
            from: { id: 7 },
            text: "second",
          },
        },
      ]);
      await waitFor(() => managerHarness.manager.sendMessage.mock.calls.length === 2);

      expect(managerHarness.manager.sendMessage.mock.calls.map((call) => call[0])).toEqual([
        "s12",
        "s12",
      ]);
      expect(managerHarness.sessions.get("s12").state).toBe("waiting-input");
    } finally {
      vi.useRealTimers();
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
          messageId: "assistant-intermediate",
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
          messageId: "assistant-final",
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
          messageId: "assistant-checking",
          text: "checking the logs",
        },
      });

      await vi.advanceTimersByTimeAsync(0);
      expect(apiHarness.sendRichMessages).toContainEqual(
        expect.objectContaining({ markdown: "checking the logs" }),
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

  it("retries a transient notification delivery failure", async () => {
    const chatId = 472;
    const managerHarness = createSessionManagerHarness([
      {
        id: "s1",
        projectId: "demo",
        ownerId: ownerIdForChat(chatId),
        state: "running",
        createdAt: "2024-01-01T00:00:00.000Z",
        updatedAt: "2024-01-01T00:00:00.000Z",
      },
    ]);
    let sendRichMessageCalls = 0;
    vi.stubGlobal(
      "fetch",
      createTelegramFetchStub({
        setMyCommands: async () => createJsonResponse({ ok: true, result: true }),
        getUpdates: async () => pendingTelegramCall(),
        sendRichMessage: async () => {
          sendRichMessageCalls += 1;
          return sendRichMessageCalls === 1
            ? createJsonResponse(
                {
                  ok: false,
                  error_code: 429,
                  description: "Too Many Requests",
                  parameters: { retry_after: 2 },
                },
                429,
              )
            : createJsonResponse({ ok: true, result: true });
        },
      }),
    );
    const adapter = await startAdapter({
      botToken: "token",
      projects: { demo: { repo: "git@example.com:demo.git" } },
      sessionManager: managerHarness.manager,
      pollIntervalMs: 1,
      requestTimeoutSeconds: 1,
    });

    vi.useFakeTimers();
    try {
      emitAssistantProgress(managerHarness.manager, "assistant-final", "final answer");
      await vi.advanceTimersByTimeAsync(0);
      expect(sendRichMessageCalls).toBe(1);

      await vi.advanceTimersByTimeAsync(1999);
      expect(sendRichMessageCalls).toBe(1);

      await vi.advanceTimersByTimeAsync(1);
      expect(sendRichMessageCalls).toBe(2);
    } finally {
      vi.useRealTimers();
      await adapter.close();
      vi.unstubAllGlobals();
    }
  });

  it.each([
    {
      name: "HTTP error response body read failure",
      createResponse: () => ({
        ok: false,
        status: 503,
        text: vi.fn(async () => {
          throw new TypeError("connection reset while reading response");
        }),
      }),
    },
    {
      name: "successful response body read failure",
      createResponse: () => ({
        ok: true,
        status: 200,
        text: vi.fn(async () => {
          throw new TypeError("connection reset while reading response");
        }),
      }),
    },
  ])("retries a $name", async ({ createResponse }) => {
    const chatId = 473;
    const managerHarness = createSessionManagerHarness([
      {
        id: "s1",
        projectId: "demo",
        ownerId: ownerIdForChat(chatId),
        state: "running",
        createdAt: "2024-01-01T00:00:00.000Z",
        updatedAt: "2024-01-01T00:00:00.000Z",
      },
    ]);
    let sendRichMessageCalls = 0;
    vi.stubGlobal(
      "fetch",
      createTelegramFetchStub({
        setMyCommands: async () => createJsonResponse({ ok: true, result: true }),
        getUpdates: async () => pendingTelegramCall(),
        sendRichMessage: async () => {
          sendRichMessageCalls += 1;
          return sendRichMessageCalls === 1
            ? createResponse()
            : createJsonResponse({ ok: true, result: true });
        },
      }),
    );
    const adapter = await startAdapter({
      botToken: "token",
      projects: { demo: { repo: "git@example.com:demo.git" } },
      sessionManager: managerHarness.manager,
      pollIntervalMs: 1,
      requestTimeoutSeconds: 1,
    });

    vi.useFakeTimers();
    try {
      emitAssistantProgress(managerHarness.manager, "assistant-final", "final answer");
      await vi.advanceTimersByTimeAsync(0);
      expect(sendRichMessageCalls).toBe(1);

      await vi.advanceTimersByTimeAsync(1000);
      expect(sendRichMessageCalls).toBe(2);
    } finally {
      vi.useRealTimers();
      await adapter.close();
      vi.unstubAllGlobals();
    }
  });

  it("does not retry malformed successful response bodies", async () => {
    const chatId = 474;
    const managerHarness = createSessionManagerHarness([
      {
        id: "s1",
        projectId: "demo",
        ownerId: ownerIdForChat(chatId),
        state: "running",
        createdAt: "2024-01-01T00:00:00.000Z",
        updatedAt: "2024-01-01T00:00:00.000Z",
      },
    ]);
    let sendRichMessageCalls = 0;
    const logs = [];
    vi.stubGlobal(
      "fetch",
      createTelegramFetchStub({
        setMyCommands: async () => createJsonResponse({ ok: true, result: true }),
        getUpdates: async () => pendingTelegramCall(),
        sendRichMessage: async () => {
          sendRichMessageCalls += 1;
          return new Response("{", { status: 200 });
        },
      }),
    );
    const adapter = await startAdapter({
      botToken: "token",
      projects: { demo: { repo: "git@example.com:demo.git" } },
      sessionManager: managerHarness.manager,
      pollIntervalMs: 1,
      requestTimeoutSeconds: 1,
      onLog: (entry) => logs.push(entry),
    });

    try {
      emitAssistantProgress(managerHarness.manager, "assistant-final", "final answer");
      await waitFor(() =>
        logs.some((entry) => entry.message === "failed to send telegram notification"),
      );
      expect(sendRichMessageCalls).toBe(1);
    } finally {
      await adapter.close();
      vi.unstubAllGlobals();
    }
  });

  it("retries a delivery attempt after its deadline", async () => {
    const chatId = 475;
    const apiHarness = createApiHarness([]);
    const attemptSignals = [];
    apiHarness.api.sendRichMessage.mockImplementation(async (sentChatId, markdown, options) => {
      attemptSignals.push(options.signal);
      if (attemptSignals.length === 1) {
        return await new Promise(() => {});
      }
      apiHarness.sendRichMessages.push({ chatId: sentChatId, markdown, options });
    });
    const { adapter, manager } = await startNotificationTestAdapter({ chatId, apiHarness });

    vi.useFakeTimers();
    try {
      emitAssistantProgress(manager, "assistant-final", "final answer");
      await vi.advanceTimersByTimeAsync(0);
      expect(attemptSignals).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(30_000);
      expect(attemptSignals[0].aborted).toBe(true);
      expect(attemptSignals).toHaveLength(1);

      await vi.advanceTimersByTimeAsync(1000);
      expect(attemptSignals).toHaveLength(2);
      expect(apiHarness.sendRichMessages).toHaveLength(1);
    } finally {
      vi.useRealTimers();
      await adapter.close();
    }
  });

  it("does not start later chunks after shutdown aborts an in-flight delivery", async () => {
    const chatId = 476;
    const apiHarness = createApiHarness([]);
    const attemptSignals = [];
    apiHarness.api.sendRichMessage.mockImplementation(async (_chatId, _markdown, options) => {
      attemptSignals.push(options.signal);
      return await new Promise(() => {});
    });
    const { adapter, manager } = await startNotificationTestAdapter({ chatId, apiHarness });

    emitAssistantProgress(manager, "assistant-final", "x".repeat(40_000));
    await waitFor(() => attemptSignals.length === 1);

    await adapter.close();

    expect(attemptSignals).toHaveLength(1);
    expect(attemptSignals[0].aborted).toBe(true);
  });

  it("does not retry permanent notification delivery failures", async () => {
    const chatId = 473;
    const apiHarness = createApiHarness([]);
    apiHarness.api.sendRichMessage.mockRejectedValue(
      new TelegramRequestError("telegram rejected rich markdown", { retryable: false }),
    );
    const logs = [];
    const { adapter, manager } = await startNotificationTestAdapter({
      chatId,
      apiHarness,
      onLog: (entry) => logs.push(entry),
    });

    try {
      emitAssistantProgress(manager, "assistant-final", "final answer");
      await waitFor(() =>
        logs.some((entry) => entry.message === "failed to send telegram notification"),
      );

      expect(apiHarness.api.sendRichMessage).toHaveBeenCalledTimes(1);
      expect(logs).toContainEqual({
        level: "error",
        message: "failed to send telegram notification",
        data: {
          sessionId: "s1",
          chatId,
          messageId: "assistant-final",
          attempts: 1,
          cause: "telegram rejected rich markdown",
        },
      });
    } finally {
      await adapter.close();
    }
  });

  it("logs exhausted notification retries with recoverable message identity", async () => {
    const chatId = 474;
    const apiHarness = createApiHarness([]);
    apiHarness.api.sendRichMessage.mockRejectedValue(
      new TelegramRequestError("telegram unavailable", { retryable: true }),
    );
    const logs = [];
    const { adapter, manager } = await startNotificationTestAdapter({
      chatId,
      apiHarness,
      onLog: (entry) => logs.push(entry),
    });

    vi.useFakeTimers();
    try {
      emitAssistantProgress(manager, "assistant-final", "final answer");
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(1000);
      await vi.advanceTimersByTimeAsync(5000);

      expect(apiHarness.api.sendRichMessage).toHaveBeenCalledTimes(3);
      expect(logs).toContainEqual({
        level: "error",
        message: "telegram notification delivery retries exhausted",
        data: {
          sessionId: "s1",
          chatId,
          messageId: "assistant-final",
          attempts: 3,
          cause: "telegram unavailable",
        },
      });
    } finally {
      vi.useRealTimers();
      await adapter.close();
    }
  });

  it("preserves notification order while an earlier delivery retries", async () => {
    const chatId = 475;
    const apiHarness = createApiHarness([]);
    const attempts = [];
    let failedIntermediate = false;
    apiHarness.api.sendRichMessage.mockImplementation(async (sentChatId, markdown, options) => {
      attempts.push(markdown);
      if (markdown === "intermediate" && !failedIntermediate) {
        failedIntermediate = true;
        throw new TelegramRequestError("telegram unavailable", { retryable: true });
      }
      apiHarness.sendRichMessages.push({ chatId: sentChatId, markdown, options });
    });
    const { adapter, manager } = await startNotificationTestAdapter({ chatId, apiHarness });

    vi.useFakeTimers();
    try {
      emitAssistantProgress(manager, "assistant-intermediate", "intermediate");
      emitAssistantProgress(manager, "assistant-final", "final answer");
      await vi.advanceTimersByTimeAsync(0);
      expect(attempts).toEqual(["intermediate"]);

      await vi.advanceTimersByTimeAsync(1000);
      expect(attempts).toEqual(["intermediate", "intermediate", "final answer"]);
      expect(apiHarness.sendRichMessages.map((entry) => entry.markdown)).toEqual([
        "intermediate",
        "final answer",
      ]);
    } finally {
      vi.useRealTimers();
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
          messageId: "assistant-oversized",
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

  it("uploads generated voice notes with Telegram multipart form data", async () => {
    const chatId = 991;
    const ownerId = ownerIdForChat(chatId);
    const managerHarness = createSessionManagerHarness([
      {
        id: "s-voice-upload",
        projectId: "demo",
        ownerId,
        state: "running",
        createdAt: "2024-01-01T00:00:00.000Z",
        updatedAt: "2024-01-01T00:00:00.000Z",
      },
    ]);
    const sendVoiceCalls = [];
    const telegramFetch = createTelegramFetchStub({
      setMyCommands: async () => createJsonResponse({ ok: true, result: true }),
      getUpdates: async () => pendingTelegramCall(),
      sendRichMessage: async () => createJsonResponse({ ok: true, result: { message_id: 1 } }),
      sendVoice: async ({ init }) => {
        sendVoiceCalls.push(init);
        return createJsonResponse({ ok: true, result: { message_id: 1 } });
      },
    });
    vi.stubGlobal("fetch", telegramFetch);

    const adapter = await startAdapter({
      botToken: "token",
      projects: { demo: { repo: "git@example.com:demo.git" } },
      sessionManager: managerHarness.manager,
      projectPreferences: {
        initialize: vi.fn(async () => {}),
        get: vi.fn(() => undefined),
        set: vi.fn(async () => {}),
        isTtsEnabled: vi.fn((id) => id === ownerId),
        setTtsEnabled: vi.fn(async () => {}),
      },
      geminiApiKey: "gemini-key",
      generateVoice: vi.fn(async () => Buffer.from("OggS voice")),
      pollIntervalMs: 1,
      requestTimeoutSeconds: 1,
    });

    try {
      managerHarness.manager.emit({
        type: "session-progress",
        sessionId: "s-voice-upload",
        projectId: "demo",
        state: "running",
        timestamp: "2024-01-01T00:01:00.000Z",
        progress: {
          type: "assistant-message",
          messageId: "assistant-final",
          text: "final answer",
        },
      });
      managerHarness.manager.emit({
        type: "session-response-completed",
        sessionId: "s-voice-upload",
        projectId: "demo",
        timestamp: "2024-01-01T00:01:30.000Z",
        messageId: "assistant-final",
        text: "final answer",
      });
      managerHarness.manager.emit({
        type: "session-state-changed",
        sessionId: "s-voice-upload",
        projectId: "demo",
        previousState: "running",
        state: "waiting-input",
        updatedAt: "2024-01-01T00:02:00.000Z",
      });

      await waitFor(() => sendVoiceCalls.length === 1);
      const form = sendVoiceCalls[0].body;
      expect(form).toBeInstanceOf(FormData);
      expect(form.get("chat_id")).toBe(String(chatId));
      const voice = form.get("voice");
      expect(voice).toBeInstanceOf(File);
      expect(voice.name).toBe("response.ogg");
      expect(voice.type).toBe("audio/ogg");
      expect(Buffer.from(await voice.arrayBuffer())).toEqual(Buffer.from("OggS voice"));
    } finally {
      await adapter.close();
      vi.unstubAllGlobals();
    }
  });

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
    {
      name: "Telegram rejects getUpdates with a conflict",
      handlers: {
        setMyCommands: async () => createJsonResponse({ ok: true, result: true }),
        getUpdates: async ({ call }) =>
          call === 1
            ? createJsonResponse(
                {
                  ok: false,
                  error_code: 409,
                  description: "Conflict: terminated by other getUpdates request",
                },
                409,
              )
            : pendingTelegramCall(),
      },
      expectWarning: (entry) =>
        entry.level === "warn" &&
        entry.message === "telegram poll failed" &&
        entry.data?.cause ===
          "telegram getUpdates failed: HTTP 409: Conflict: terminated by other getUpdates request",
    },
    {
      name: "getUpdates encounters a network failure",
      handlers: {
        setMyCommands: async () => createJsonResponse({ ok: true, result: true }),
        getUpdates: async ({ call }) => {
          if (call !== 1) {
            return pendingTelegramCall();
          }

          const cause = Object.assign(new Error("socket disconnected"), { code: "ECONNRESET" });
          throw new TypeError("fetch failed", { cause });
        },
      },
      expectWarning: (entry) =>
        entry.level === "warn" &&
        entry.message === "telegram poll failed" &&
        entry.data?.cause ===
          "telegram getUpdates network request failed: fetch failed: socket disconnected (ECONNRESET)",
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
