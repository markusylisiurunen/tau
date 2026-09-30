import { realpathSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { fileURLToPath } from "node:url";
import { describe, expect, it, vi } from "vitest";
import { McpManager } from "../dist/core/mcp/manager.js";
import { createMcpToolDefinition } from "../dist/core/tools/mcp.js";
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

describe("host-owned MCP connections", () => {
  it("discovers and calls a stdio server without exposing host configuration", async () => {
    const client = manager();
    try {
      expect(client.listServers()).toEqual([{ name: "test", type: "stdio" }]);
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
    const client = manager({ timeoutMs: 100, env: { MCP_TEST_NO_INITIALIZE: "1" } });
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
        response.end(`${"x".repeat(1024 * 1024)}"}},"id":${message.id}}`);
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
      await expect(echo(client, "oversized")).rejects.toThrow("exceeded the 1 MiB limit");
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
  it("forwards MCP screenshots as real image content without files or base64 previews", async () => {
    const client = manager();
    const executionBackend = backend();
    const tool = createMcpToolDefinition(executionBackend, client);
    try {
      const result = await runTool(
        tool,
        'const result = await mcp.callTool("test", "screenshot", {}); console.log("1"); await image(result.content[0]); console.log("2")',
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
        'await image((await mcp.callTool("test", "screenshot", {})).content[0]); throw new Error("later failure")',
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
    const tool = createMcpToolDefinition(executionBackend, client);
    try {
      const result = await runTool(
        tool,
        `
        console.log(await mcp.listResources("test", { limit: 1 }));
        console.log(await mcp.listResources("test", { offset: 1 }));
        console.log(await mcp.listResources("test", { query: "database schema" }));
        console.log(await mcp.listResourceTemplates("test", { query: "service documents" }));
        console.log(await mcp.readResource("test", "docs://unlisted"));
        const preview = await mcp.readResource("test", "docs://preview");
        console.log("before");
        await image({ type: "image", data: preview.contents[0].blob, mimeType: preview.contents[0].mimeType });
        console.log("after");
      `,
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
      const missing = await runTool(tool, 'await mcp.readResource("test", "docs://missing")');
      expect(missing.outcome).toBe("failed");
      for (const code of [
        'await mcp.listResources("test", { limit: 0 })',
        'await mcp.listResourceTemplates("test", { unknown: true })',
        'await mcp.readResource("test", "")',
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
      const tool = createMcpToolDefinition(backend(), client);
      const result = await runTool(
        tool,
        'console.log(await mcp.readResource("test", "docs://oversized"))',
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
      const tool = createMcpToolDefinition(backend(), client);
      const run = runTool(tool, 'await mcp.readResource("test", "docs://slow")', controller.signal);
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
    const tool = createMcpToolDefinition(backend(), client);
    const controller = new AbortController();
    try {
      const run = runTool(tool, "await mcp.callTool('test', 'slow', {})", controller.signal);
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
    const tool = createMcpToolDefinition(executionBackend, client);
    try {
      const docs = await runTool(tool, "console.log(docs)");
      expect(docs.outcome).toBe("succeeded");
      expect(docs.text).toContain("mcp.describeTool");
      expect(docs.text).not.toContain("test-secret");
      const result = await runTool(
        tool,
        `
        console.log(await mcp.listServers());
        console.log(await mcp.listTools("test", { limit: 1 }));
        console.log(await mcp.listTools("test", { query: "echo message" }));
        console.log(await mcp.describeTool("test", "echo"));
        const results = await Promise.all(["one", "two"].map(message =>
          mcp.callTool("test", "echo", { message })));
        console.log(results.map(result => result.structuredContent.message));
      `,
      );
      expect(result.outcome).toBe("succeeded");
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
    const tool = createMcpToolDefinition(backend(), client);
    try {
      const result = await runTool(
        tool,
        `
        const failed = await mcp.callTool("test", "fail", {});
        console.log({ isError: failed.isError });
        try { await mcp.callTool("test", "echo", { message: 1 }); }
        catch (error) { console.log(error.message); }
        console.log((await mcp.callTool("test", "echo", { message: "ok" })).structuredContent.calls);
      `,
      );
      expect(result.outcome).toBe("succeeded");
      expect(result.text).toContain('"isError":true');
      expect(result.text).toContain("Invalid arguments");
      expect(result.text.split("\n").at(-1)).toBe("2");
      const malformed = await runTool(tool, "await mcp.listTools('test', { limit: 0 })");
      expect(malformed.outcome).toBe("failed");
      expect(malformed.text).toContain("Invalid mcp.listTools arguments");
      const defaultList = await runTool(tool, "console.log(await mcp.listTools('test'))");
      expect(defaultList.outcome).toBe("succeeded");
    } finally {
      await client.close();
    }
  });
});
