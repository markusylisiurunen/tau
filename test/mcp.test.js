import { realpathSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { McpClient, McpConnectionClosedError } from "@earendil-works/pi-mcp";
import { describe, expect, it, vi } from "vitest";
import { createMcpCapability } from "../dist/core/code_mode/mcp.js";
import { McpManager } from "../dist/core/mcp/manager.js";
import { createCapabilityTool } from "./helpers/code_mode.js";
import { createProtocolImage } from "./helpers/session_protocol_fixtures.js";

const fixture = fileURLToPath(new URL("./fixtures/mcp_server.js", import.meta.url));
const signal = () => new AbortController().signal;
const stdioConfig = (overrides = {}) => ({
  type: "stdio",
  command: process.execPath,
  args: [fixture],
  cwd: tmpdir(),
  env: { MCP_TEST_SECRET: `\${TEST_SECRET}` },
  ...overrides,
});
const manager = (overrides = {}) =>
  new McpManager({ test: stdioConfig(overrides) }, { TEST_SECRET: "test-secret" });
const echo = (client, message = "hello") => client.callTool("test", "echo", { message }, signal());

async function runTool(tool, code, abortSignal = signal()) {
  const activities = [];
  const result = await tool.execute(
    { id: "mcp-call", name: "mcp", arguments: { code } },
    {
      agentId: "mcp-test-agent",
      turnId: "turn",
      assistantMessageId: "assistant",
      signal: abortSignal,
      emitActivity: async (activity) => activities.push(activity),
    },
  );
  return {
    ...result,
    text: result.content
      .filter((part) => part.type === "text")
      .map((part) => part.text)
      .join("\n"),
    activities,
  };
}

function backend() {
  return { runNodeScript: vi.fn(), writeFile: vi.fn() };
}

function assertExited(pid) {
  expect(() => process.kill(pid, 0)).toThrow();
}

describe("MCP search", () => {
  it("searches through the capability API and observes catalog invalidation", async () => {
    const client = manager();
    const api = createMcpCapability(client).api;
    const context = { signal: signal() };
    try {
      expect(await api.searchTools(["messages"], context)).toMatchObject({
        tools: [{ server: "test", name: "echo", score: expect.any(Number) }],
        errors: [],
      });
      await client.callTool("test", "refresh", {}, signal());
      const refreshed = await api.searchTools(["added", { server: "test", limit: 1 }], context);
      expect(refreshed.tools.map((tool) => tool.name)).toEqual(["added"]);
      for (const args of [[" "], ["echo", { limit: 0 }], ["echo", { offset: 1 }]]) {
        await expect(api.searchTools(args, context)).rejects.toThrow();
      }
    } finally {
      await client.close();
    }
  });

  it("bounds discovery concurrency and rejects cancellation", async () => {
    const { searchMcpTools } = await import("../dist/core/mcp/search.js");
    const controller = new AbortController();
    let active = 0;
    let peak = 0;
    const client = {
      listServers: () => Array.from({ length: 12 }, (_, index) => ({ name: String(index) })),
      listTools: vi.fn(async () => {
        active++;
        peak = Math.max(peak, active);
        await new Promise((resolve) => setTimeout(resolve, 1));
        active--;
        return { tools: [] };
      }),
    };
    await searchMcpTools(client, "issue", { limit: 8 }, controller.signal);
    expect(peak).toBe(4);
    client.listTools.mockImplementation(async () => {
      controller.abort(new Error("cancelled"));
      controller.signal.throwIfAborted();
    });
    await expect(searchMcpTools(client, "issue", { limit: 8 }, controller.signal)).rejects.toBe(
      controller.signal.reason,
    );
  });
});

describe("host-owned MCP connections", () => {
  it("discovers and calls a stdio server without exposing host configuration", async () => {
    const client = manager();
    try {
      expect(client.listServers()).toEqual([{ name: "test" }]);
      expect(JSON.stringify(client.listServers())).not.toContain("test-secret");
      const catalog = await client.listTools("test", signal());
      expect(catalog.instructions).toBe("Test service usage guidance");
      expect(catalog.tools[0].inputSchema.required).toEqual(["message"]);
      const result = await echo(client);
      expect(result).toMatchObject({
        content: [{ type: "text", text: "raw service response" }],
        structuredContent: {
          message: "hello",
          calls: 1,
          authenticated: true,
          cwd: realpathSync(tmpdir()),
        },
      });
      expect(result._meta).toBeUndefined();
      const pid = result.structuredContent.pid;
      await client.close();
      assertExited(pid);
      await expect(echo(client)).rejects.toThrow("closed");
    } finally {
      await client.close();
    }
  });

  it("validates arguments, preserves tool errors, and refreshes changed catalogs", async () => {
    const client = manager();
    try {
      await expect(client.callTool("test", "echo", { message: 12 }, signal())).rejects.toThrow(
        "Invalid arguments",
      );
      await expect(client.callTool("test", "missing", {}, signal())).rejects.toThrow("has no tool");
      expect((await echo(client)).structuredContent.calls).toBe(1);
      const failed = await client.callTool("test", "fail", {}, signal());
      expect(failed.isError).toBe(true);
      expect(failed.content[0].text).toContain("service rejected");
      await client.callTool("test", "refresh", {}, signal());
      expect((await client.describeTool("test", "added", signal())).name).toBe("added");
    } finally {
      await client.close();
    }
  });

  it("shares a connection across concurrent calls and cancels only the requested call", async () => {
    const client = manager();
    try {
      const results = await Promise.all([echo(client, "one"), echo(client, "two")]);
      expect(results[0].structuredContent.pid).toBe(results[1].structuredContent.pid);
      const controller = new AbortController();
      const slow = client.callTool("test", "slow", {}, controller.signal);
      const rejected = expect(slow).rejects.toThrow();
      await vi.waitFor(async () => expect((await echo(client)).structuredContent.pending).toBe(1));
      controller.abort();
      await rejected;
      await vi.waitFor(async () =>
        expect((await echo(client)).structuredContent.cancelled).toBe(1),
      );
      expect((await echo(client)).structuredContent.pid).toBe(results[0].structuredContent.pid);
    } finally {
      await client.close();
    }
  });

  it("does not retry mutations and reconnects for a subsequent call after a server exits", async () => {
    const client = manager();
    try {
      const first = await echo(client);
      await expect(client.callTool("test", "exit", {}, signal())).rejects.toThrow();
      const next = await echo(client);
      expect(next.structuredContent.pid).not.toBe(first.structuredContent.pid);
      expect(next.structuredContent.calls).toBe(1);
    } finally {
      await client.close();
    }
  });

  it("bounds startup, skips disabled servers, and fails missing credentials without leaking values", async () => {
    const client = manager({ discoveryTimeoutMs: 100, env: { MCP_TEST_NO_INITIALIZE: "1" } });
    const unavailable = new McpManager({ disabled: stdioConfig({ enabled: false }) });
    const missing = new McpManager({ test: stdioConfig() }, {});
    try {
      await expect(client.listTools("test", signal())).rejects.toThrow("failed to connect");
      expect(unavailable.available).toBe(false);
      expect(unavailable.listServers()).toEqual([]);
      await expect(unavailable.listTools("disabled", signal())).rejects.toThrow("unavailable");
      await expect(missing.listTools("test", signal())).rejects.toThrow("TEST_SECRET");
      const controller = new AbortController();
      controller.abort(new Error("already cancelled"));
      await expect(missing.listTools("test", controller.signal)).rejects.toThrow(
        "already cancelled",
      );
    } finally {
      await Promise.all([client.close(), unavailable.close(), missing.close()]);
    }
  });

  it("closes servers while initialization is pending", async () => {
    const client = manager({ env: { MCP_TEST_NO_INITIALIZE: "1" } });
    const listing = client.listTools("test", signal());
    const rejected = expect(listing).rejects.toThrow();
    await client.close();
    await rejected;
  });

  it("connects over streamable HTTP with host-resolved authentication and deletes the session", async () => {
    const requests = [];
    let initializations = 0;
    const server = createServer(async (request, response) => {
      const entry = { method: request.method, authorization: request.headers.authorization };
      requests.push(entry);
      if (request.headers.authorization !== "Bearer test-secret") {
        response.writeHead(401).end();
        return;
      }
      if (request.method === "DELETE") {
        response.writeHead(204).end();
        return;
      }
      if (request.method === "GET") {
        response.writeHead(405).end();
        return;
      }
      let body = "";
      for await (const chunk of request) body += chunk;
      const message = JSON.parse(body);
      entry.rpcMethod = message.method;
      entry.message = message.params?.arguments?.message;
      if (message.method === "initialize") initializations++;
      if (entry.message === "expire") {
        response.writeHead(404).end();
        return;
      }
      if (entry.message === "oversized") {
        response.writeHead(200, { "content-type": "application/json" });
        response.write('{"jsonrpc":"2.0","result":{"content":[],"structuredContent":{"text":"');
        response.end(`${"x".repeat(16 * 1024 * 1024)}"}},"id":${message.id}}`);
        return;
      }
      if (message.id === undefined) {
        response.writeHead(202).end();
        return;
      }
      const result =
        message.method === "initialize"
          ? {
              protocolVersion: message.params.protocolVersion,
              capabilities: { tools: {} },
              serverInfo: { name: "http-test", version: "1" },
            }
          : message.method === "tools/list"
            ? {
                tools: [{ name: "echo", inputSchema: { type: "object" } }],
              }
            : { content: [], structuredContent: message.params.arguments };
      response.writeHead(200, {
        "content-type": "application/json",
        "mcp-session-id": "test-session",
      });
      response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const client = new McpManager(
      {
        test: {
          type: "http",
          url: `http://127.0.0.1:${server.address().port}/mcp`,
          headers: { Authorization: `Bearer \${TEST_SECRET}` },
        },
      },
      { TEST_SECRET: "test-secret" },
    );
    try {
      expect((await echo(client)).structuredContent).toEqual({ message: "hello" });
      await expect(echo(client, "oversized")).rejects.toThrow();
      await expect(echo(client, "expire")).rejects.toThrow();
      expect((await echo(client)).structuredContent).toEqual({ message: "hello" });
      expect(initializations).toBe(2);
      expect(requests.filter((entry) => entry.message === "expire")).toHaveLength(1);
      await client.close();
      expect(requests.some((request) => request.method === "DELETE")).toBe(true);
      expect(requests.every((request) => request.authorization === "Bearer test-secret")).toBe(
        true,
      );
    } finally {
      await client.close();
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

describe("MCP HTTP notification failures", () => {
  it("preserves an in-flight tool call when the notification stream exhausts retries", async () => {
    const toolStarted = Promise.withResolvers();
    const streamFailed = Promise.withResolvers();
    const connect = McpClient.prototype.connect;
    const connectSpy = vi.spyOn(McpClient.prototype, "connect").mockImplementation(function (
      ...args
    ) {
      this.onError(streamFailed.resolve);
      return connect.apply(this, args);
    });
    let toolResponse;
    let toolMessage;
    let getRequests = 0;
    let toolCalls = 0;
    let initializations = 0;
    let deletions = 0;
    const server = createServer(async (request, response) => {
      if (request.method === "DELETE") {
        deletions++;
        response.writeHead(204).end();
        return;
      }
      if (request.method === "GET") {
        getRequests++;
        await toolStarted.promise;
        response.writeHead(200, { "content-type": "text/event-stream" });
        response.end("retry: 0\n\n");
        return;
      }
      let body = "";
      for await (const chunk of request) body += chunk;
      const message = JSON.parse(body);
      if (message.method === "tools/call") {
        toolCalls++;
        toolResponse = response;
        toolMessage = message;
        toolStarted.resolve();
        return;
      }
      if (message.id === undefined) {
        response.writeHead(202).end();
        return;
      }
      if (message.method === "initialize") initializations++;
      const result =
        message.method === "initialize"
          ? {
              protocolVersion: message.params.protocolVersion,
              capabilities: { tools: {} },
              serverInfo: { name: "http-test", version: "1" },
            }
          : { tools: [{ name: "echo", inputSchema: { type: "object" } }] };
      response.writeHead(200, {
        "content-type": "application/json",
        "mcp-session-id": "test-session",
      });
      response.end(JSON.stringify({ jsonrpc: "2.0", id: message.id, result }));
    });
    await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
    const client = new McpManager({
      test: { type: "http", url: `http://127.0.0.1:${server.address().port}/mcp` },
    });
    try {
      const pending = echo(client);
      await Promise.race([streamFailed.promise, pending]);
      expect(getRequests).toBeGreaterThan(1);
      toolResponse.writeHead(200, { "content-type": "application/json" });
      toolResponse.end(
        JSON.stringify({
          jsonrpc: "2.0",
          id: toolMessage.id,
          result: { content: [], structuredContent: toolMessage.params.arguments },
        }),
      );
      expect((await pending).structuredContent).toEqual({ message: "hello" });
      expect(initializations).toBe(1);
      expect(toolCalls).toBe(1);
      expect(deletions).toBe(0);
      await client.close();
      expect(deletions).toBe(1);
    } finally {
      await client.close();
      connectSpy.mockRestore();
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });
});

describe("MCP code-mode tool", () => {
  it("forwards MCP screenshots as real image content without files or base64 previews", async () => {
    const client = manager();
    const executionBackend = backend();
    const tool = createCapabilityTool(executionBackend, createMcpCapability(client));
    try {
      const result = await runTool(
        tool,
        'const result = await tau.mcp.callTool("test", "screenshot", {}); printText("1"); await printImage(result.content[0]); printText("2")',
      );
      expect(result.outcome).toBe("succeeded");
      expect(result.content).toEqual([
        { type: "text", text: "1" },
        createProtocolImage(),
        { type: "text", text: "2" },
      ]);
      expect(JSON.stringify(result.activities)).not.toContain(createProtocolImage().data);
      expect(executionBackend.writeFile).not.toHaveBeenCalled();
      expect(executionBackend.runNodeScript).not.toHaveBeenCalled();
    } finally {
      await client.close();
    }
  });

  it("discovers paginated resources and templates and reads explicit text and image context", async () => {
    const client = manager();
    const api = createMcpCapability(client).api;
    const context = { signal: signal() };
    try {
      expect(await api.listResources(["test", { limit: 1 }], context)).toMatchObject({
        resources: [{ uri: "docs://schema", annotations: { audience: ["assistant"] } }],
        total: 2,
        nextOffset: 1,
      });
      expect(await api.listResources(["test", { offset: 1 }], context)).toMatchObject({
        resources: [{ uri: "docs://guide" }],
        total: 2,
      });
      expect(
        await api.listResources(["test", { query: "database schema" }], context),
      ).toMatchObject({
        resources: [{ uri: "docs://schema" }],
        total: 1,
      });
      expect(
        await api.listResourceTemplates(["test", { query: "service documents" }], context),
      ).toMatchObject({
        resourceTemplates: [{ uriTemplate: "docs://{documentId}" }],
        total: 1,
      });
      expect(await api.readResource(["test", "docs://unlisted"], context)).toEqual({
        contents: [{ uri: "docs://unlisted", mimeType: "text/plain", text: "resource context" }],
      });
      const preview = await api.readResource(["test", "docs://preview"], context);
      expect(preview.contents[0]).toMatchObject({
        blob: createProtocolImage().data,
        mimeType: "image/png",
      });
      await expect(api.readResource(["test", "docs://missing"], context)).rejects.toThrow();
      await expect(api.listResources(["test", { limit: 0 }], context)).rejects.toThrow();
      await expect(
        api.listResourceTemplates(["test", { unknown: true }], context),
      ).rejects.toThrow();
      await expect(api.readResource(["test", ""], context)).rejects.toThrow();
    } finally {
      await client.close();
    }
  });

  it("rejects oversized resource responses and reconnects for later reads", async () => {
    const client = manager();
    try {
      const first = await echo(client);
      const pending = client.callTool("test", "slow", {}, signal()).then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
      await vi.waitFor(async () => expect((await echo(client)).structuredContent.pending).toBe(1), {
        timeout: 5000,
      });
      await expect(
        client.readResource("test", "docs://oversized", signal()),
      ).rejects.toBeInstanceOf(McpConnectionClosedError);
      expect((await pending).error).toBeInstanceOf(McpConnectionClosedError);
      const api = createMcpCapability(client).api;
      const result = await api.readResource(["test", "docs://schema"], { signal: signal() });
      expect(result.contents[0].text).toBe("resource context");
      const second = await echo(client);
      expect(second.structuredContent.pid).not.toBe(first.structuredContent.pid);
      expect(second.structuredContent.calls).toBe(1);
    } finally {
      await client.close();
    }
  }, 20_000);

  it("cancels resource reads without closing the shared connection", async () => {
    const client = manager();
    const controller = new AbortController();
    try {
      const tool = createCapabilityTool(backend(), createMcpCapability(client));
      const run = runTool(
        tool,
        'await tau.mcp.readResource("test", "docs://slow")',
        controller.signal,
      );
      await vi.waitFor(async () => expect((await echo(client)).structuredContent.pending).toBe(1));
      controller.abort();
      expect((await run).outcome).toBe("cancelled");
      await vi.waitFor(async () =>
        expect((await echo(client)).structuredContent.cancelled).toBe(1),
      );
      expect((await client.readResource("test", "docs://schema", signal())).contents).toHaveLength(
        1,
      );
    } finally {
      controller.abort();
      await client.close();
    }
  });

  it("returns service errors as data and rejects invalid capability calls before dispatch", async () => {
    const client = manager();
    const api = createMcpCapability(client).api;
    const context = { signal: signal() };
    try {
      expect(await api.callTool(["test", "fail", {}], context)).toMatchObject({ isError: true });
      await expect(api.callTool(["test", "echo", { message: 1 }], context)).rejects.toThrow();
      const result = await api.callTool(["test", "echo", { message: "ok" }], context);
      expect(result.structuredContent.calls).toBe(2);
      await expect(api.listTools(["test", { limit: 0 }], context)).rejects.toThrow();
      expect((await api.listTools(["test"], context)).tools.length).toBeGreaterThan(0);
    } finally {
      await client.close();
    }
  });
});
