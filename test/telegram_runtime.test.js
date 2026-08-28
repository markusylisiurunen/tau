import { readFile, rm, writeFile } from "node:fs/promises";
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
            allowedProjectIds: ["alpha"],
          },
        },
      }),
      createSessionClient: vi.fn(),
      geminiApiKey: "gemini-key",
      onLog: (line) => {
        logs.push(line);
      },
      deps: {
        startTelegramAdapter: vi.fn(async (options) => {
          events.push(`start-telegram:${options.botToken}:${options.botId}`);
          expect(Object.keys(options.projects)).toEqual(["alpha"]);
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

  it("keeps runtime log causes single-line and bounded", async () => {
    const logs = [];
    const runtime = await startTelegramRuntime({
      config: createTelegramConfig({
        bots: { "bot-one": { botToken: "token-1" } },
      }),
      createSessionClient: vi.fn(),
      onLog: (line) => {
        logs.push(line);
      },
      deps: {
        startTelegramAdapter: vi.fn(async (options) => {
          options.onLog?.({
            level: "warn",
            message: "telegram poll failed",
            data: { cause: `gateway failure\r\n${"x".repeat(600)}` },
          });
          return { close: vi.fn(async () => {}) };
        }),
      },
    });

    const warning = logs[0];
    expect(warning).not.toMatch(/[\r\n]/);
    expect(warning).toMatch(
      /^\[telegram:bot-one:warn\] telegram poll failed: gateway failure x+…$/,
    );
    expect(warning.length).toBe("[telegram:bot-one:warn] telegram poll failed: ".length + 500);

    await runtime.close();
  });

  it("includes exhausted-delivery recovery identifiers in runtime logs", async () => {
    const logs = [];
    const runtime = await startTelegramRuntime({
      config: createTelegramConfig({
        bots: { "bot-one": { botToken: "token-1" } },
      }),
      createSessionClient: vi.fn(),
      onLog: (line) => {
        logs.push(line);
      },
      deps: {
        startTelegramAdapter: vi.fn(async (options) => {
          options.onLog?.({
            level: "error",
            message: "telegram notification delivery retries exhausted",
            data: {
              sessionId: "session-one",
              chatId: 42,
              messageId: "assistant-final",
              attempts: 3,
              cause: "telegram unavailable",
            },
          });
          return { close: vi.fn(async () => {}) };
        }),
      },
    });

    expect(logs[0]).toBe(
      '[telegram:bot-one:error] telegram notification delivery retries exhausted [sessionId="session-one" messageId="assistant-final" chatId=42 attempts=3]: telegram unavailable',
    );

    await runtime.close();
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
      bots: { "bot-one": { botToken: "token-1" } },
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
            },
            "bot-two": {
              botToken: "token-2",
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
