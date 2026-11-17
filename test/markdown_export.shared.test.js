import { once } from "node:events";
import { createServer } from "node:http";
import { afterEach, describe, expect, it } from "vitest";
import { exportMarkdown } from "../dist/tui/markdown_export.js";

const markdown = "  # Proposal\n\n```ts\nconst n = 1;\n```\n";
const servers = [];

// Loopback HTTP is the only plain-HTTP export target the configuration accepts.
async function startServer(respond) {
  const requests = [];
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    requests.push({
      method: request.method,
      url: request.url,
      headers: request.headers,
      body: Buffer.concat(chunks).toString("utf8"),
      socket: request.socket,
    });
    respond(response);
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  servers.push(server);
  return { url: `http://127.0.0.1:${server.address().port}/documents`, requests };
}

function reply(status, body) {
  return (response) => {
    response.writeHead(status, { "content-type": "application/json" });
    response.end(typeof body === "string" ? body : JSON.stringify(body));
  };
}

function exportTo(config, overrides = {}) {
  return exportMarkdown({
    config,
    markdown,
    env: {},
    signal: new AbortController().signal,
    ...overrides,
  });
}

afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
});

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
    async (credentials, env, authorization) => {
      const { url, requests } = await startServer(
        reply(201, { version: 1, url: "https://example.com/doc/1" }),
      );
      expect(await exportTo({ url, ...credentials }, { env })).toBe("https://example.com/doc/1");
      expect(requests).toHaveLength(1);
      expect(requests[0]).toMatchObject({ method: "POST", url: "/documents" });
      expect(requests[0].headers.authorization).toBe(authorization);
      expect(JSON.parse(requests[0].body)).toEqual({ version: 1, markdown });
    },
  );

  it.each([
    { url: "http://example.com/documents" },
    { url: "https://user:secret@example.com/documents" },
    { tokenEnv: "MISSING" },
    { tokenEnv: "EMPTY" },
    { tokenEnv: "INVALID" },
  ])("rejects unsafe configuration before sending %j", async (config) => {
    const { url, requests } = await startServer(reply(201, {}));
    await expect(
      exportTo({ url, ...config }, { env: { EMPTY: " ", INVALID: "secret\r\nheader" } }),
    ).rejects.toThrow();
    expect(requests).toEqual([]);
  });

  it.each([
    [200, { version: 1, url: "https://example.com/doc/1" }],
    [500, { secret: "private-token" }],
    [201, { version: 2, url: "https://example.com/doc/1" }],
    [201, { version: 1, url: "javascript:alert(1)" }],
    [201, { version: 1, url: "https://user:private-token@example.com" }],
    [201, { version: 1, url: "https://example.com/\u001b" }],
    [201, null],
    [201, "not json"],
    [201, "x".repeat(65537)],
  ])("rejects invalid responses without retries or leaked body (%s, %j)", async (status, body) => {
    const { url, requests } = await startServer(reply(status, body));
    const error = await exportTo({ url }).catch((caught) => caught);
    expect(error).toBeInstanceOf(Error);
    expect(error.message).not.toContain("private-token");
    expect(requests).toHaveLength(1);
  });

  it("does not follow redirects", async () => {
    const { url, requests } = await startServer((response) => {
      response.writeHead(307, { Location: "/redirected" });
      response.end();
    });
    await expect(exportTo({ url, token: "secret" })).rejects.toThrow();
    expect(requests.map((request) => request.url)).toEqual(["/documents"]);
  });

  it("cancels an in-flight request without retrying", async () => {
    const { url, requests } = await startServer(() => {});
    const controller = new AbortController();
    const pending = exportTo({ url }, { signal: controller.signal });
    await expect.poll(() => requests.length).toBe(1);
    const closed = once(requests[0].socket, "close");
    controller.abort();
    await expect(pending).rejects.toThrow();
    await closed;
    expect(requests).toHaveLength(1);
  });
});
