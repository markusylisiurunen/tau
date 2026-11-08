import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import {
  createTelegramProjectPreferenceStore,
  resolveTelegramProjectPreferencesPath,
} from "../dist/core/telegram/project_preferences.js";
import { startTelegramRuntime } from "../dist/core/telegram/runtime.js";

const workspaceRoot = join(tmpdir(), `tau-telegram-runtime-${process.pid}`);

afterAll(async () => {
  await Promise.all([
    rm(`${workspaceRoot}-sessions.json`, { force: true }),
    rm(`${workspaceRoot}-project-preferences.json`, { force: true }),
  ]);
});

function createTelegramConfig(overrides = {}) {
  return {
    workspaceRoot,
    projects: {
      alpha: {
        repo: "owner/alpha",
      },
      beta: {
        repo: "owner/beta",
      },
    },
    bots: {},
    ...overrides,
  };
}

describe("telegram runtime", () => {
  it("routes each bot's environment to its sessions without changing the runner", async () => {
    const root = await mkdtemp(join(tmpdir(), "tau-bot-env-"));
    const requests = [];
    let manager;
    let runtime;
    const inherited = process.env.GH_CONFIG_DIR;
    try {
      runtime = await startTelegramRuntime({
        config: createTelegramConfig({
          workspaceRoot: join(root, "managed"),
          projects: { alpha: { directory: root } },
          bots: {
            first: {
              botToken: "first-token",
              startup: { source: "workspace" },
              env: { GH_CONFIG_DIR: "/first/gh" },
            },
            second: { botToken: "second-token", startup: { source: "workspace" } },
          },
        }),
        createSessionClient: async (options) => ({
          sessions: {
            create: async (request) => {
              requests.push({ ownerId: options.ownerId, env: request.executionEnvironment.env });
              throw new Error("stop after session creation request");
            },
          },
          close: async () => {},
        }),
        deps: {
          startTelegramAdapter: async (options) => {
            manager = options.sessionManager;
            return { close: async () => {} };
          },
        },
      });
      await Promise.all(
        ["first", "second"].map((bot) =>
          manager.createSession({
            projectId: "alpha",
            ownerId: `telegram:${bot}:chat:123`,
          }),
        ),
      );
      await vi.waitFor(() => expect(requests).toHaveLength(2));
      expect(requests).toEqual(
        expect.arrayContaining([
          { ownerId: "telegram:first:chat:123", env: { GH_CONFIG_DIR: "/first/gh" } },
          { ownerId: "telegram:second:chat:123", env: {} },
        ]),
      );
      expect(process.env.GH_CONFIG_DIR).toBe(inherited);
    } finally {
      await runtime?.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("binds file tools to each session's owning bot and chat", async () => {
    const root = await mkdtemp(join(tmpdir(), "tau-file-routing-"));
    const clients = [];
    let manager;
    let runtime;
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    try {
      runtime = await startTelegramRuntime({
        config: createTelegramConfig({
          workspaceRoot: join(root, "managed"),
          projects: { alpha: { directory: root } },
          bots: {
            first: {
              botToken: "first-token",
              startup: { source: "preset", preset: "chat" },
              autoCompactThresholdTokens: 128000,
              presets: {
                chat: {
                  source: "persona",
                  persona: "chat",
                  label: "Chat",
                  reasoning: "low",
                  autoCompactThresholdTokens: 80000,
                },
              },
            },
            second: { botToken: "second-token", startup: { source: "workspace" } },
          },
        }),
        createSessionClient: async (options) => {
          clients.push(options);
          throw new Error("stop after client creation");
        },
        deps: {
          startTelegramAdapter: async (options) => {
            manager = options.sessionManager;
            return { close: async () => {} };
          },
        },
      });
      for (const ownerId of ["telegram:first:chat:123", "telegram:second:chat:-456"]) {
        await manager.createSession({ projectId: "alpha", ownerId });
      }
      await vi.waitFor(() => expect(clients).toHaveLength(2));
      expect(
        clients.find((client) => client.ownerId === "telegram:first:chat:123").autoCompactDefaults,
      ).toEqual({ thresholdTokens: 128000 });
      expect(
        clients.find((client) => client.ownerId === "telegram:second:chat:-456")
          .autoCompactDefaults,
      ).toEqual({});
      expect(
        clients.find((client) => client.ownerId === "telegram:first:chat:123").personaSelection,
      ).toEqual({ personaId: "chat", reasoning: "low", autoCompactThresholdTokens: 80000 });
      expect(
        clients.find((client) => client.ownerId === "telegram:second:chat:-456").personaSelection,
      ).toEqual({ personaId: null });
      const content = Buffer.from("ffd8ffe000104a464946000101", "hex");
      for (const client of clients) {
        expect(client.clientTools.map((tool) => tool.schema.name)).toEqual([
          "send_photo_to_telegram",
          "send_video_to_telegram",
          "send_audio_to_telegram",
          "send_document_to_telegram",
        ]);
        for (const tool of client.clientTools) {
          await tool.execute(
            { path: "image.jpg" },
            {
              signal: new AbortController().signal,
              executionEnvironment: {
                exec: async () => ({
                  exitCode: 0,
                  stdout: JSON.stringify({
                    identity: "stable",
                    size: content.length,
                    content: content.toString("base64"),
                  }),
                }),
              },
            },
          );
        }
      }
      expect(fetchMock.mock.calls.map(([url, init]) => [url, init.body.get("chat_id")])).toEqual([
        ...["sendPhoto", "sendVideo", "sendAudio", "sendDocument"].map((method) => [
          `https://api.telegram.org/botfirst-token/${method}`,
          "123",
        ]),
        ...["sendPhoto", "sendVideo", "sendAudio", "sendDocument"].map((method) => [
          `https://api.telegram.org/botsecond-token/${method}`,
          "-456",
        ]),
      ]);
    } finally {
      await runtime?.close();
      vi.unstubAllGlobals();
      await rm(root, { recursive: true, force: true });
    }
  });

  it("starts telegram adapters and closes resources", async () => {
    const logs = [];
    const events = [];

    const telegramHandle = {
      close: vi.fn(async () => {
        events.push("close-telegram:bot-one");
      }),
    };

    const runtime = await startTelegramRuntime({
      config: createTelegramConfig({
        bots: {
          "bot-one": {
            botToken: "token-1",
            startup: { source: "workspace" },
            speechCleanupStyle: "default",
            allowedProjectIds: ["alpha"],
          },
        },
      }),
      createSessionClient: vi.fn(),
      elevenLabsApiKey: "eleven-key",
      openAIApiKey: "openai-key",
      speechVoiceId: "custom-voice",
      onLog: (line) => {
        logs.push(line);
      },
      deps: {
        startTelegramAdapter: vi.fn(async (options) => {
          events.push(`start-telegram:${options.botToken}:${options.botId}`);
          expect(Object.keys(options.projects)).toEqual(["alpha"]);
          expect(options.elevenLabsApiKey).toBe("eleven-key");
          expect(options.speechCleanupStyle).toBe("default");
          expect(options.openAIApiKey).toBe("openai-key");
          expect(options.speechVoiceId).toBe("custom-voice");
          options.onLog?.({
            level: "warn",
            message: "telegram poll failed",
            data: { cause: "telegram getUpdates failed: HTTP 409: Conflict" },
          });
          return telegramHandle;
        }),
      },
    });

    expect(events).toEqual(["start-telegram:token-1:bot-one"]);
    expect(logs).toEqual([
      "[telegram:bot-one:warn] telegram poll failed: telegram getUpdates failed: HTTP 409: Conflict",
      "tau telegram adapter enabled (bot-one)",
    ]);

    await runtime.close();

    expect(telegramHandle.close).toHaveBeenCalledTimes(1);
    expect(events.slice(-1)).toEqual(["close-telegram:bot-one"]);
  });

  it("preserves version 1 project preferences when saving TTS settings", async () => {
    const preferenceRoot = `${workspaceRoot}-migration`;
    const preferencePath = resolveTelegramProjectPreferencesPath(preferenceRoot);
    const ownerId = "telegram:bot-one:chat:42";
    await writeFile(
      preferencePath,
      `${JSON.stringify({ version: 1, preferences: { [ownerId]: "beta" } })}\n`,
      "utf8",
    );

    try {
      const store = createTelegramProjectPreferenceStore(preferencePath);
      await store.initialize();
      expect(store.get(ownerId)).toBe("beta");
      expect(store.isTtsEnabled(ownerId)).toBe(false);

      await store.setTtsEnabled(ownerId, true);
      expect(JSON.parse(await readFile(preferencePath, "utf8"))).toEqual({
        version: 2,
        preferences: {
          [ownerId]: { projectId: "beta", ttsEnabled: true },
        },
      });
    } finally {
      await rm(preferencePath, { force: true });
    }
  });

  it("persists project and TTS preferences across runtime restarts", async () => {
    const ownerId = "telegram:bot-one:chat:42";
    const config = createTelegramConfig({
      bots: { "bot-one": { botToken: "token-1", startup: { source: "workspace" } } },
    });
    let firstStore;
    const firstRuntime = await startTelegramRuntime({
      config,
      createSessionClient: vi.fn(),
      deps: {
        startTelegramAdapter: vi.fn(async (options) => {
          firstStore = options.projectPreferences;
          return { close: vi.fn(async () => {}) };
        }),
      },
    });

    await firstStore.set(ownerId, "beta");
    await firstStore.setTtsEnabled(ownerId, true);
    await firstRuntime.close();

    const secondRuntime = await startTelegramRuntime({
      config,
      createSessionClient: vi.fn(),
      deps: {
        startTelegramAdapter: vi.fn(async (options) => {
          expect(options.projectPreferences.get(ownerId)).toBe("beta");
          expect(options.projectPreferences.isTtsEnabled(ownerId)).toBe(true);
          return { close: vi.fn(async () => {}) };
        }),
      },
    });
    await secondRuntime.close();
  });

  it("rolls back previously started adapters on startup failure", async () => {
    const firstTelegramHandle = {
      close: vi.fn(async () => {}),
    };

    const startTelegramAdapter = vi
      .fn()
      .mockResolvedValueOnce(firstTelegramHandle)
      .mockRejectedValueOnce(new Error("telegram failed"));

    await expect(
      startTelegramRuntime({
        config: createTelegramConfig({
          bots: {
            "bot-one": {
              botToken: "token-1",
              startup: { source: "workspace" },
            },
            "bot-two": {
              botToken: "token-2",
              startup: { source: "workspace" },
            },
          },
        }),
        createSessionClient: vi.fn(),
        deps: {
          startTelegramAdapter,
        },
      }),
    ).rejects.toMatchObject({
      message: "failed to start telegram runtime: telegram failed",
    });

    expect(firstTelegramHandle.close).toHaveBeenCalledTimes(1);
  });
});
