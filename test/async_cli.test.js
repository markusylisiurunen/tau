import { describe, expect, it, vi } from "vitest";
import { AsyncCliError, runAsyncCommand } from "../dist/core/async/cli.js";

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

    await runAsyncCommand(["ship", "it"], {
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
          projects: {
            demo: {
              repo: "git@example.com:demo.git",
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

  it("maps list/status/logs/send/cancel commands to expected requests", async () => {
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
            projects: {
              demo: { repo: "git@example.com:demo.git" },
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
    await run(["cancel", "abc"]);

    expect(fetchMock.mock.calls.map((call) => [call[0], call[1].method])).toEqual([
      ["http://localhost:9000/v1/sessions", "GET"],
      ["http://localhost:9000/v1/sessions/abc", "GET"],
      ["http://localhost:9000/v1/sessions/abc/logs", "GET"],
      ["http://localhost:9000/v1/sessions/abc/messages", "POST"],
      ["http://localhost:9000/v1/sessions/abc/cancel", "POST"],
    ]);

    expect(JSON.parse(fetchMock.mock.calls[3][1].body)).toEqual({ text: "hello world" });
  });

  it("requires --project when multiple async projects are configured", async () => {
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
            projects: {
              a: { repo: "git@example.com:a.git" },
              b: { repo: "git@example.com:b.git" },
            },
          },
        },
        fetchImpl: vi.fn(),
        stdout: () => {},
      }),
    ).rejects.toBeInstanceOf(AsyncCliError);
  });
});
