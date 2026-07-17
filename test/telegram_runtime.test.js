import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
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
      mistralApiKey: "mistral-key",
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

  it("persists project preferences across runtime restarts", async () => {
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
    await firstRuntime.close();

    const secondRuntime = await startTelegramRuntime({
      config,
      createSessionClient: vi.fn(),
      deps: {
        startTelegramAdapter: vi.fn(async (options) => {
          expect(options.projectPreferences.get(ownerId)).toBe("beta");
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
