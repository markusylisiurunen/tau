import { describe, expect, it, vi } from "vitest";
import { runAsyncCommand } from "../dist/core/async/cli.js";

function createJsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: {
      "content-type": "application/json",
    },
  });
}

describe("async cli", () => {
  it("creates a session from prompt text and maps to POST /v1/sessions", async () => {
    const fetchMock = vi.fn(async () =>
      createJsonResponse({ ok: true, data: { session: { id: "s1" } } }),
    );
    const stdout = vi.fn();

    await runAsyncCommand(["--project", "demo", "ship", "it"], {
      config: {
        async: {
          client: {
            defaultTarget: "dev",
            targets: {
              dev: {
                url: "http://localhost:7788",
                token: "secret",
              },
            },
          },
        },
      },
      fetchImpl: fetchMock,
      stdout,
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://localhost:7788/v1/sessions");
    expect(init.method).toBe("POST");
    expect(init.headers.authorization).toBe("Bearer secret");
    expect(JSON.parse(init.body)).toEqual({ projectId: "demo", prompt: "ship it" });
    expect(stdout).toHaveBeenCalledWith(
      JSON.stringify({ ok: true, data: { session: { id: "s1" } } }, null, 2),
    );
  });

  it("uses async.client.defaultProjectId when --project is omitted", async () => {
    const fetchMock = vi.fn(async () => createJsonResponse({ ok: true, data: { session: {} } }));

    await runAsyncCommand(["ship", "it"], {
      config: {
        async: {
          client: {
            defaultTarget: "dev",
            defaultProjectId: "tau",
            targets: {
              dev: {
                url: "http://localhost:7788",
                token: "secret",
              },
            },
          },
        },
      },
      fetchImpl: fetchMock,
      stdout: () => {},
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(JSON.parse(fetchMock.mock.calls[0][1].body)).toEqual({
      projectId: "tau",
      prompt: "ship it",
    });
  });

  it("maps list/status/logs/send/interrupt/cancel/cron commands to expected requests", async () => {
    const fetchMock = vi.fn(async () => createJsonResponse({ ok: true, data: {} }));

    const run = (argv) =>
      runAsyncCommand(argv, {
        config: {
          async: {
            client: {
              targets: {
                one: {
                  url: "http://localhost:9000",
                  token: "tok",
                },
              },
            },
          },
        },
        fetchImpl: fetchMock,
        stdout: () => {},
      });

    await run(["list"]);
    await run(["status", "abc"]);
    await run(["logs", "abc"]);
    await run(["send", "abc", "hello", "world"]);
    await run(["interrupt", "abc"]);
    await run(["cancel", "abc"]);
    await run(["cron", "list"]);
    await run(["cron", "runs"]);
    await run(["cron", "runs", "nightly"]);
    await run(["cron", "run", "nightly"]);

    expect(fetchMock.mock.calls.map((call) => [call[0], call[1].method])).toEqual([
      ["http://localhost:9000/v1/sessions", "GET"],
      ["http://localhost:9000/v1/sessions/abc", "GET"],
      ["http://localhost:9000/v1/sessions/abc/logs", "GET"],
      ["http://localhost:9000/v1/sessions/abc/messages", "POST"],
      ["http://localhost:9000/v1/sessions/abc/interrupt", "POST"],
      ["http://localhost:9000/v1/sessions/abc/cancel", "POST"],
      ["http://localhost:9000/v1/cron/jobs", "GET"],
      ["http://localhost:9000/v1/cron/runs", "GET"],
      ["http://localhost:9000/v1/cron/runs?jobId=nightly", "GET"],
      ["http://localhost:9000/v1/cron/jobs/nightly/run", "POST"],
    ]);

    expect(JSON.parse(fetchMock.mock.calls[3][1].body)).toEqual({ text: "hello world" });
  });

  it("uses explicit --url/--token when configured default target is invalid", async () => {
    const fetchMock = vi.fn(async () => createJsonResponse({ ok: true, data: { sessions: [] } }));

    await runAsyncCommand(["list", "--url", "http://localhost:9100", "--token", "override"], {
      config: {
        async: {
          client: {
            defaultTarget: "missing",
            targets: {
              one: {
                url: "http://localhost:9000",
                token: "tok",
              },
            },
          },
        },
      },
      fetchImpl: fetchMock,
      stdout: () => {},
    });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://localhost:9100/v1/sessions");
    expect(init.headers.authorization).toBe("Bearer override");
  });

  it("requires project id when --project and defaultProjectId are missing", async () => {
    await expect(
      runAsyncCommand(["do", "work"], {
        config: {
          async: {
            client: {
              targets: {
                one: {
                  url: "http://localhost:9000",
                  token: "tok",
                },
              },
            },
          },
        },
        fetchImpl: vi.fn(),
        stdout: () => {},
      }),
    ).rejects.toMatchObject({
      message: expect.stringContaining("async.client.defaultProjectId"),
    });
  });

  it("requires session id for interrupt", async () => {
    await expect(
      runAsyncCommand(["interrupt"], {
        config: {
          async: {
            client: {
              targets: {
                one: {
                  url: "http://localhost:9000",
                  token: "tok",
                },
              },
            },
          },
        },
        fetchImpl: vi.fn(),
        stdout: () => {},
      }),
    ).rejects.toMatchObject({
      message: "missing session id for interrupt",
    });
  });

  it("requires cron subcommand", async () => {
    await expect(
      runAsyncCommand(["cron"], {
        config: {
          async: {
            client: {
              targets: {
                one: {
                  url: "http://localhost:9000",
                  token: "tok",
                },
              },
            },
          },
        },
        fetchImpl: vi.fn(),
        stdout: () => {},
      }),
    ).rejects.toMatchObject({ message: expect.stringContaining("missing cron subcommand") });
  });

  it("requires --config-file for daemon mode", async () => {
    await expect(
      runAsyncCommand(["daemon"], {
        config: {
          async: {
            client: {
              targets: {
                one: {
                  url: "http://localhost:9000",
                  token: "tok",
                },
              },
            },
          },
        },
        stdout: () => {},
      }),
    ).rejects.toMatchObject({ message: expect.stringContaining("--config-file") });
  });
});
