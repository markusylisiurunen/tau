import { realpathSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { McpClient } from "@earendil-works/pi-mcp";
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
  it("searches through the code-mode API and observes catalog invalidation", async () => {
    const client = manager();
    const tool = createCapabilityTool(backend(), createMcpCapability(client));
    try {
      const result = await runTool(
        tool,
        'printText(JSON.stringify(await tau.mcp.searchTools("messages")))',
      );
      expect(result.outcome).toBe("succeeded");
      expect(JSON.parse(result.text)).toMatchObject({
        tools: [{ server: "test", name: "echo", score: expect.any(Number) }],
        errors: [],
      });
      await client.callTool("test", "refresh", {}, signal());
      const refreshed = await runTool(
        tool,
        'printText(JSON.stringify(await tau.mcp.searchTools("added", { server: "test", limit: 1 })))',
      );
      expect(JSON.parse(refreshed.text).tools.map((tool) => tool.name)).toEqual(["added"]);
      for (const code of [
        'await tau.mcp.searchTools(" ")',
        'await tau.mcp.searchTools("echo", { limit: 0 })',
        'await tau.mcp.searchTools("echo", { offset: 1 })',
      ]) {
        expect((await runTool(tool, code)).outcome).toBe("failed");
      }
    } finally {
      await client.close();
    }
  });

  it("ranks across servers, scopes discovery, and reports partial failures", async () => {
    const { searchMcpTools } = await import("../dist/core/mcp/search.js");
    const client = {
      listServers: () => [{ name: "first" }, { name: "second" }, { name: "broken" }],
      listTools: vi.fn(async (server) => {
        if (server === "broken") throw new Error("private connection details");
        return {
          tools: [
            {
              name: server === "first" ? "lookup" : "findIssues",
              inputSchema: {
                allOf: [
                  {
                    properties: {
                      filters: {
                        type: "array",
                        items: {
                          oneOf: [{ description: "Issue assignees" }],
                        },
                      },
                    },
                  },
                ],
              },
            },
          ],
        };
      }),
    };
    const result = await searchMcpTools(client, "issues", { limit: 8 }, signal());
    expect(result.tools.map((tool) => tool.server)).toEqual(["second", "first"]);
    expect(result.errors).toEqual([{ server: "broken", error: expect.any(String) }]);
    expect(JSON.stringify(result)).not.toContain("private connection details");
    client.listTools.mockClear();
    const scoped = await searchMcpTools(
      client,
      "assignee",
      { server: "first", limit: 1 },
      signal(),
    );
    expect(scoped.tools.map((tool) => tool.server)).toEqual(["first"]);
    expect(client.listTools).toHaveBeenCalledTimes(1);
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
  it("separates discovery deadlines from configurable tool and resource execution deadlines", async () => {
    const toolCalls = vi.spyOn(McpClient.prototype, "callTool");
    const resourceReads = vi.spyOn(McpClient.prototype, "readResource");
    const connect = vi.spyOn(McpClient.prototype, "connect");
    const clients = [manager(), manager({ timeoutMs: 900_000, discoveryTimeoutMs: 2_000 })];
    try {
      for (const client of clients) {
        await echo(client);
        await client.readResource("test", "docs://schema", signal());
      }
      expect(toolCalls.mock.calls.map((call) => call[2].timeoutMs)).toEqual([300_000, 900_000]);
      expect(resourceReads.mock.calls.map((call) => call[1].timeoutMs)).toEqual([300_000, 900_000]);
      expect(connect.mock.instances.map((client) => client.options.requestTimeoutMs)).toEqual([
        30_000, 2_000,
      ]);
    } finally {
      await Promise.all(clients.map((client) => client.close()));
      toolCalls.mockRestore();
      resourceReads.mockRestore();
      connect.mockRestore();
    }
  });

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

describe("MCP code-mode tool", () => {
  it("returns a clean result and strips metadata only at MCP content boundaries", async () => {
    const client = manager();
    try {
      const tool = createCapabilityTool(backend(), createMcpCapability(client));
      const result = await runTool(
        tool,
        'printText(JSON.stringify(await tau.mcp.callTool("test", "metadata", {})))',
      );
      expect(result.outcome).toBe("succeeded");
      const value = JSON.parse(result.text);
      expect(Object.keys(value)).toEqual(["content", "structuredContent", "isError"]);
      expect(value.isError).toBe(false);
      expect(value.content).toEqual([
        { type: "text", text: "public text", annotations: { priority: 0.8 } },
        { type: "resource", resource: { uri: "docs://embedded", text: "public resource" } },
        { type: "resource_link", uri: "docs://linked", name: "linked" },
      ]);
      expect(value.structuredContent).toEqual({ _meta: { application: "preserved" } });
      expect(result.text).not.toContain("private-");
    } finally {
      await client.close();
    }
  });

  it("allows large resources across transport and bridge without printing their contents", async () => {
    const client = manager();
    try {
      const tool = createCapabilityTool(backend(), createMcpCapability(client));
      const result = await runTool(
        tool,
        'const result = await tau.mcp.readResource("test", "docs://large"); printText(JSON.stringify(result.contents[0].text.length))',
      );
      expect(result.outcome).toBe("succeeded");
      expect(Number(result.text)).toBe(2 * 1024 * 1024);
    } finally {
      await client.close();
    }
  });

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

      const failed = await runTool(
        tool,
        'await printImage((await tau.mcp.callTool("test", "screenshot", {})).content[0]); throw new Error("later failure")',
      );
      expect(failed.outcome).toBe("failed");
      expect(failed.content[0]).toEqual(createProtocolImage());
      expect(failed.text).toContain("later failure");
    } finally {
      await client.close();
    }
  });

  it("discovers paginated resources and templates and reads explicit text and image context", async () => {
    const client = manager();
    const executionBackend = backend();
    const tool = createCapabilityTool(executionBackend, createMcpCapability(client));
    try {
      const result = await runTool(
        tool,
        '\n        printText(JSON.stringify(await tau.mcp.listResources("test", { limit: 1 })));\n        printText(JSON.stringify(await tau.mcp.listResources("test", { offset: 1 })));\n        printText(JSON.stringify(await tau.mcp.listResources("test", { query: "database schema" })));\n        printText(JSON.stringify(await tau.mcp.listResourceTemplates("test", { query: "service documents" })));\n        printText(JSON.stringify(await tau.mcp.readResource("test", "docs://unlisted")));\n        const preview = await tau.mcp.readResource("test", "docs://preview");\n        printText("before");\n        await printImage({ type: "image", data: preview.contents[0].blob, mimeType: preview.contents[0].mimeType });\n        printText("after");\n      ',
      );
      expect(result.outcome).toBe("succeeded");
      const lines = result.content[0].text.split("\n");
      expect(JSON.parse(lines[0])).toMatchObject({
        resources: [{ uri: "docs://schema", annotations: { audience: ["assistant"] } }],
        total: 2,
        nextOffset: 1,
      });
      expect(JSON.parse(lines[1])).toMatchObject({
        resources: [{ uri: "docs://guide" }],
        total: 2,
      });
      expect(JSON.parse(lines[2])).toMatchObject({
        resources: [{ uri: "docs://schema" }],
        total: 1,
      });
      expect(JSON.parse(lines[3])).toMatchObject({
        resourceTemplates: [{ uriTemplate: "docs://{documentId}" }],
        total: 1,
      });
      expect(JSON.parse(lines[4])).toEqual({
        contents: [{ uri: "docs://unlisted", mimeType: "text/plain", text: "resource context" }],
      });
      expect(result.content[1]).toEqual(createProtocolImage());
      expect(result.content[2]).toEqual({ type: "text", text: "after" });
      expect(result.text).not.toContain("_meta");
      expect(executionBackend.writeFile).not.toHaveBeenCalled();
      expect(executionBackend.runNodeScript).not.toHaveBeenCalled();
      const missing = await runTool(tool, 'await tau.mcp.readResource("test", "docs://missing")');
      expect(missing.outcome).toBe("failed");
      for (const code of [
        'await tau.mcp.listResources("test", { limit: 0 })',
        'await tau.mcp.listResourceTemplates("test", { unknown: true })',
        'await tau.mcp.readResource("test", "")',
      ]) {
        expect((await runTool(tool, code)).outcome).toBe("failed");
      }
    } finally {
      await client.close();
    }
  });

  it("rejects oversized resource responses without preventing later reads", async () => {
    const client = manager({ timeoutMs: 1_000 });
    try {
      const tool = createCapabilityTool(backend(), createMcpCapability(client));
      const result = await runTool(
        tool,
        'printText(JSON.stringify(await tau.mcp.readResource("test", "docs://oversized")))',
      );
      expect(result.outcome).toBe("failed");
      expect(result.text).not.toContain("x".repeat(100));
      expect((await client.readResource("test", "docs://schema", signal())).contents[0].text).toBe(
        "resource context",
      );
    } finally {
      await client.close();
    }
  });

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

  it("propagates interruption to MCP calls without closing the shared connection", async () => {
    const client = manager();
    const tool = createCapabilityTool(backend(), createMcpCapability(client));
    const controller = new AbortController();
    try {
      const run = runTool(tool, "await tau.mcp.callTool('test', 'slow', {})", controller.signal);
      await vi.waitFor(async () => expect((await echo(client)).structuredContent.pending).toBe(1));
      controller.abort();
      expect((await run).outcome).toBe("cancelled");
      await vi.waitFor(async () =>
        expect((await echo(client)).structuredContent.cancelled).toBe(1),
      );
    } finally {
      controller.abort();
      await client.close();
    }
  });

  it("progressively documents, discovers, and composes calls without workspace access", async () => {
    const client = manager();
    const executionBackend = backend();
    const tool = createCapabilityTool(executionBackend, createMcpCapability(client));
    try {
      const docs = await runTool(tool, 'printText(await tau.docs("mcp"))');
      expect(docs.outcome).toBe("succeeded");
      expect(docs.text).toContain("tau.mcp.describeTool");
      expect(docs.text).not.toContain("test-secret");
      const result = await runTool(
        tool,
        '\n        printText(JSON.stringify(await tau.mcp.listServers()));\n        printText(JSON.stringify(await tau.mcp.listTools("test", { limit: 1 })));\n        printText(JSON.stringify(await tau.mcp.listTools("test", { query: "echo message" })));\n        printText(JSON.stringify(await tau.mcp.describeTool("test", "echo")));\n        const results = await Promise.all(["one", "two"].map(message =>\n          tau.mcp.callTool("test", "echo", { message })));\n        printText(JSON.stringify(results.map(result => result.structuredContent.message)));\n      ',
      );
      expect(result.outcome).toBe("succeeded");
      expect(JSON.parse(result.text.split("\n")[0])).toEqual([{ name: "test" }]);
      expect(result.text).toContain('"nextOffset":1');
      expect(result.text).toContain('"total":1');
      expect(result.text).toContain('"inputSchema"');
      expect(result.text).toContain('["one","two"]');
      expect(result.text).not.toContain("raw service response");
      expect(result.text).not.toContain("test-secret");
      expect(result.activities.map((activity) => activity.type)).toEqual([
        "code_mode_started",
        "code_mode_finished",
      ]);
      expect(executionBackend.runNodeScript).not.toHaveBeenCalled();
    } finally {
      await client.close();
    }
  });

  it("handles service errors as data and bridge failures as catchable exceptions", async () => {
    const client = manager();
    const tool = createCapabilityTool(backend(), createMcpCapability(client));
    try {
      const result = await runTool(
        tool,
        '\n        const failed = await tau.mcp.callTool("test", "fail", {});\n        printText(JSON.stringify({ isError: failed.isError }));\n        try { await tau.mcp.callTool("test", "echo", { message: 1 }); }\n        catch (error) { printText(error.message); }\n        printText(JSON.stringify((await tau.mcp.callTool("test", "echo", { message: "ok" })).structuredContent.calls));\n      ',
      );
      expect(result.outcome).toBe("succeeded");
      expect(result.text).toContain('"isError":true');
      expect(result.text).toContain("Invalid arguments");
      expect(result.text.split("\n").at(-1)).toBe("2");
      const malformed = await runTool(tool, "await tau.mcp.listTools('test', { limit: 0 })");
      expect(malformed.outcome).toBe("failed");
      expect(malformed.text).toContain("Invalid tau.mcp.listTools arguments");
      const defaultList = await runTool(
        tool,
        "printText(JSON.stringify(await tau.mcp.listTools('test')))",
      );
      expect(defaultList.outcome).toBe("succeeded");
    } finally {
      await client.close();
    }
  });
});
