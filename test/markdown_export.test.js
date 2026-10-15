import { once } from "node:events";
import { createServer } from "node:http";
import { afterEach, describe, expect, it, vi } from "vitest";
import { exportMarkdown } from "../dist/tui/markdown_export.js";

const options = {
  config: { url: "https://example.com/documents" },
  markdown: "  # Proposal\n\n```ts\nconst n = 1;\n```\n",
  env: {},
  signal: new AbortController().signal,
};

afterEach(() => vi.unstubAllGlobals());

describe("Markdown export", () => {
  it.each([
    [
      { token: "inline", tokenEnv: "EXPORT_TOKEN" },
      { EXPORT_TOKEN: "environment" },
      "Bearer inline",
    ],
    [{ tokenEnv: "EXPORT_TOKEN" }, { EXPORT_TOKEN: "environment" }, "Bearer environment"],
    [{}, {}, undefined],
  ])(
    "posts the versioned Markdown contract with credentials %j",
    async (config, env, authorization) => {
      const fetch = vi.fn(async () =>
        Response.json({ version: 1, url: "https://example.com/doc/1" }, { status: 201 }),
      );
      vi.stubGlobal("fetch", fetch);
      expect(
        await exportMarkdown({ ...options, config: { ...options.config, ...config }, env }),
      ).toBe("https://example.com/doc/1");
      expect(fetch).toHaveBeenCalledTimes(1);
      const [url, request] = fetch.mock.calls[0];
      expect(url).toBe(options.config.url);
      expect(request.method).toBe("POST");
      expect(request.redirect).toBe("error");
      expect(request.headers.Authorization).toBe(authorization);
      expect(JSON.parse(request.body)).toEqual({ version: 1, markdown: options.markdown });
    },
  );

  it.each([
    { url: "http://example.com/documents" },
    { url: "https://user:secret@example.com/documents" },
    { url: options.config.url, tokenEnv: "MISSING" },
    { url: options.config.url, tokenEnv: "EMPTY" },
    { url: options.config.url, tokenEnv: "INVALID" },
  ])("rejects unsafe configuration before sending %j", async (config) => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    await expect(
      exportMarkdown({ ...options, config, env: { EMPTY: " ", INVALID: "secret\r\nheader" } }),
    ).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });

  it.each([
    [200, { version: 1, url: "https://example.com/doc/1" }],
    [500, { secret: "private-token" }],
    [201, { version: 2, url: "https://example.com/doc/1" }],
    [201, { version: 1, url: "javascript:alert(1)" }],
    [201, { version: 1, url: "https://user:private-token@example.com" }],
    [201, { version: 1, url: "https://example.com/\u001b" }],
    [201, null],
  ])("rejects invalid responses without retries or leaked body (%s, %j)", async (status, body) => {
    const fetch = vi.fn(async () => Response.json(body, { status }));
    vi.stubGlobal("fetch", fetch);
    await expect(exportMarkdown(options)).rejects.toThrow();
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it.each(["not json", "x".repeat(65537)])(
    "rejects malformed or oversized bodies",
    async (body) => {
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => new Response(body, { status: 201 })),
      );
      await expect(exportMarkdown(options)).rejects.toThrow();
    },
  );

  it("does not follow redirects or forward credentials and content", async () => {
    const requests = [];
    const server = createServer((request, response) => {
      requests.push(request.url);
      response.writeHead(307, { Location: "/redirected" });
      response.end();
    });
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    try {
      const url = `http://127.0.0.1:${server.address().port}/export`;
      await expect(
        exportMarkdown({ ...options, config: { url, token: "secret" } }),
      ).rejects.toThrow();
      expect(requests).toEqual(["/export"]);
    } finally {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });

  it("redacts transport errors and cancels requests", async () => {
    const controller = new AbortController();
    const fetch = vi.fn(async (_url, { signal }) => {
      await new Promise((resolve) => signal.addEventListener("abort", resolve, { once: true }));
      throw new Error("private-token");
    });
    vi.stubGlobal("fetch", fetch);
    const pending = exportMarkdown({ ...options, signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.not.toThrow("private-token");
    expect(fetch).toHaveBeenCalledTimes(1);
  });
});
