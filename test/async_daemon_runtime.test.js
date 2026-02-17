import { describe, expect, it, vi } from "vitest";
import {
  AsyncDaemonRuntimeError,
  startAsyncDaemonRuntime,
} from "../dist/core/async/daemon_runtime.js";

function createDaemonConfig(overrides = {}) {
  return {
    host: "127.0.0.1",
    port: 7788,
    workspaceRoot: "/tmp/tau-async",
    projects: {
      alpha: {
        workingDirectory: "/workspace/alpha",
      },
      beta: {
        workingDirectory: "/workspace/beta",
      },
    },
    ...overrides,
  };
}

describe("async daemon runtime", () => {
  it("starts adapters and closes all resources", async () => {
    const logs = [];
    const events = [];

    const cronHandle = {
      close: vi.fn(async () => {
        events.push("close-cron");
      }),
    };
    const httpHandle = {
      baseUrl: "http://127.0.0.1:7788",
      close: vi.fn(async () => {
        events.push("close-http");
      }),
    };
    const telegramHandle = {
      close: vi.fn(async () => {
        events.push("close-telegram:bot-one");
      }),
    };

    const sessionManager = {
      close: vi.fn(async () => {
        events.push("close-session-manager");
      }),
    };

    const runtime = await startAsyncDaemonRuntime({
      daemonConfig: createDaemonConfig({
        cronJobs: {
          nightly: {
            projectId: "alpha",
            schedule: "0 0 * * *",
            prompt: "nightly check",
          },
        },
        telegram: {
          "bot-one": {
            botToken: "token-1",
          },
          "bot-two": {},
        },
      }),
      authToken: "secret",
      mistralApiKey: "mistral-key",
      sessionManager,
      onLog: (line) => {
        logs.push(line);
      },
      deps: {
        startCronScheduler: vi.fn((options) => {
          events.push("start-cron");
          options.onLog?.({
            timestamp: "2026-01-01T00:00:00.000Z",
            level: "info",
            message: "cron tick",
          });
          return cronHandle;
        }),
        startHttpServer: vi.fn(async () => {
          events.push("start-http");
          return httpHandle;
        }),
        createScopedSessionManager: vi.fn(({ ownerId }) => {
          events.push(`scope:${ownerId}`);
          return {
            close: async () => {},
          };
        }),
        startTelegramAdapter: vi.fn(async (options) => {
          events.push(`start-telegram:${options.botToken}`);
          options.onLog?.({
            level: "warn",
            message: "adapter ready",
          });
          return telegramHandle;
        }),
      },
    });

    expect(runtime.baseUrl).toBe("http://127.0.0.1:7788");
    expect(events).toEqual([
      "start-cron",
      "start-http",
      "scope:telegram:bot-one",
      "start-telegram:token-1",
    ]);
    expect(logs).toEqual([
      "[cron:info] cron tick",
      "tau async cron scheduler enabled",
      "[telegram:bot-one:warn] adapter ready",
      "tau async telegram adapter enabled (bot-one)",
    ]);

    await runtime.close();

    expect(httpHandle.close).toHaveBeenCalledTimes(1);
    expect(telegramHandle.close).toHaveBeenCalledTimes(1);
    expect(cronHandle.close).toHaveBeenCalledTimes(1);
    expect(sessionManager.close).toHaveBeenCalledTimes(1);
    expect(events.slice(-4)).toEqual([
      "close-http",
      "close-telegram:bot-one",
      "close-cron",
      "close-session-manager",
    ]);
  });

  it("rolls back previously started resources on partial startup failure", async () => {
    const cronHandle = {
      close: vi.fn(async () => {}),
    };
    const httpHandle = {
      baseUrl: "http://127.0.0.1:7788",
      close: vi.fn(async () => {}),
    };
    const firstTelegramHandle = {
      close: vi.fn(async () => {}),
    };

    const sessionManager = {
      close: vi.fn(async () => {}),
    };

    const startTelegramAdapter = vi
      .fn()
      .mockResolvedValueOnce(firstTelegramHandle)
      .mockRejectedValueOnce(new Error("telegram failed"));

    let thrownError;

    try {
      await startAsyncDaemonRuntime({
        daemonConfig: createDaemonConfig({
          cronJobs: {
            nightly: {
              projectId: "alpha",
              schedule: "0 0 * * *",
              prompt: "nightly check",
            },
          },
          telegram: {
            "bot-one": {
              botToken: "token-1",
            },
            "bot-two": {
              botToken: "token-2",
            },
          },
        }),
        authToken: "secret",
        sessionManager,
        deps: {
          startCronScheduler: vi.fn(() => cronHandle),
          startHttpServer: vi.fn(async () => httpHandle),
          createScopedSessionManager: vi.fn(() => ({ close: async () => {} })),
          startTelegramAdapter,
        },
      });
    } catch (error) {
      thrownError = error;
    }

    expect(thrownError).toBeInstanceOf(AsyncDaemonRuntimeError);
    expect(thrownError).toMatchObject({
      message: "failed to start async adapters: telegram failed",
    });

    expect(httpHandle.close).toHaveBeenCalledTimes(1);
    expect(firstTelegramHandle.close).toHaveBeenCalledTimes(1);
    expect(cronHandle.close).toHaveBeenCalledTimes(1);
    expect(sessionManager.close).toHaveBeenCalledTimes(1);
  });

  it("cleans up resources when http server handle is missing", async () => {
    const cronHandle = {
      close: vi.fn(async () => {}),
    };
    const sessionManager = {
      close: vi.fn(async () => {}),
    };

    let thrownError;

    try {
      await startAsyncDaemonRuntime({
        daemonConfig: createDaemonConfig({
          cronJobs: {
            nightly: {
              projectId: "alpha",
              schedule: "0 0 * * *",
              prompt: "nightly check",
            },
          },
        }),
        authToken: "secret",
        sessionManager,
        deps: {
          startCronScheduler: vi.fn(() => cronHandle),
          startHttpServer: vi.fn(async () => undefined),
        },
      });
    } catch (error) {
      thrownError = error;
    }

    expect(thrownError).toBeInstanceOf(AsyncDaemonRuntimeError);
    expect(thrownError).toMatchObject({
      message: "failed to start async http server",
    });

    expect(cronHandle.close).toHaveBeenCalledTimes(1);
    expect(sessionManager.close).toHaveBeenCalledTimes(1);
  });

  it("supports idempotent close", async () => {
    const httpHandle = {
      baseUrl: "http://127.0.0.1:7788",
      close: vi.fn(async () => {}),
    };
    const sessionManager = {
      close: vi.fn(async () => {}),
    };

    const runtime = await startAsyncDaemonRuntime({
      daemonConfig: createDaemonConfig(),
      authToken: "secret",
      sessionManager,
      deps: {
        startHttpServer: vi.fn(async () => httpHandle),
      },
    });

    await Promise.all([runtime.close(), runtime.close(), runtime.close()]);

    expect(httpHandle.close).toHaveBeenCalledTimes(1);
    expect(sessionManager.close).toHaveBeenCalledTimes(1);
  });
});
