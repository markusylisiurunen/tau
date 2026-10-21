import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { createMcpCapability } from "../dist/core/code_mode/mcp.js";
import { parseMcpCliArgs, runMcpCommand } from "../dist/core/mcp/cli.js";
import { McpManager } from "../dist/core/mcp/manager.js";
import {
  createMcpAuthProvider,
  McpAuthorizationError,
  McpOAuthStorage,
} from "../dist/core/mcp/oauth.js";
import { searchMcpTools } from "../dist/core/mcp/search.js";
import { createCapabilityTool } from "./helpers/code_mode.js";

const signal = () => new AbortController().signal;

async function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "tau-mcp-oauth-"));
  const authPath = join(directory, "auth.json");
  const registrations = [];
  const grants = new Map();
  const authorizations = [];
  let refreshes = 0;
  let calls = 0;
  let advertise = true;
  let issuer;
  const server = createServer(async (request, response) => {
    const chunks = [];
    for await (const chunk of request) chunks.push(chunk);
    const text = Buffer.concat(chunks).toString();
    const json = (body, status = 200) => {
      response.writeHead(status, { "content-type": "application/json" });
      response.end(JSON.stringify(body));
    };
    if (request.url.startsWith("/.well-known/oauth-protected-resource")) {
      return json({
        resource: `${issuer}/mcp`,
        authorization_servers: [issuer],
        scopes_supported: ["account.read"],
      });
    }
    if (request.url.startsWith("/.well-known/oauth-authorization-server")) {
      return json({
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        registration_endpoint: `${issuer}/register`,
        response_types_supported: ["code"],
        grant_types_supported: ["authorization_code", "refresh_token"],
        code_challenge_methods_supported: ["S256"],
        token_endpoint_auth_methods_supported: ["none"],
        authorization_response_iss_parameter_supported: true,
        ...(advertise ? { scopes_supported: ["account.read", "dns.write", "offline_access"] } : {}),
      });
    }
    if (request.url === "/register") {
      const registration = JSON.parse(text);
      registrations.push(registration);
      return json({ ...registration, client_id: "tau-client" });
    }
    if (request.url === "/token") {
      const params = new URLSearchParams(text);
      const refresh = params.get("grant_type") === "refresh_token";
      if (refresh) refreshes++;
      const auth = authorizations.at(-1);
      if (
        !refresh &&
        createHash("sha256").update(params.get("code_verifier")).digest("base64url") !==
          auth.searchParams.get("code_challenge")
      ) {
        return json({ error: "invalid_grant" }, 400);
      }
      const scope = refresh
        ? grants.get(params.get("refresh_token"))
        : auth.searchParams.get("scope");
      if (!scope) return json({ error: "invalid_grant" }, 400);
      const access = `access-${grants.size}`;
      const refreshToken = `refresh-${grants.size}`;
      if (refresh) grants.delete(params.get("refresh_token"));
      grants.set(access, scope);
      grants.set(refreshToken, scope);
      return json({
        access_token: access,
        refresh_token: refreshToken,
        token_type: "Bearer",
        expires_in: 3600,
        scope,
      });
    }
    if (request.url === "/mcp") {
      const token = request.headers.authorization?.replace("Bearer ", "");
      const scopes = grants.get(token);
      if (!scopes) {
        response.writeHead(401, {
          "www-authenticate": `Bearer resource_metadata="${issuer}/.well-known/oauth-protected-resource/mcp", scope="account.read"`,
        });
        return response.end();
      }
      if (request.method === "GET" || request.method === "DELETE") {
        response.writeHead(405);
        return response.end();
      }
      const message = JSON.parse(text);
      if (message.method === "tools/call" && !scopes.split(" ").includes("dns.write")) {
        response.writeHead(403, {
          "www-authenticate": 'Bearer error="insufficient_scope", scope="dns.write"',
        });
        return response.end();
      }
      if (message.id === undefined) {
        response.writeHead(202);
        return response.end();
      }
      let result;
      if (message.method === "initialize")
        result = {
          protocolVersion: message.params.protocolVersion,
          capabilities: { tools: {} },
          serverInfo: { name: "oauth-test", version: "1" },
        };
      else if (message.method === "tools/list")
        result = { tools: [{ name: "dns", inputSchema: { type: "object" } }] };
      else if (message.method === "tools/call") {
        calls++;
        result = { content: [{ type: "text", text: "done" }] };
      }
      return json({ jsonrpc: "2.0", id: message.id, result });
    }
    response.writeHead(404);
    response.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  issuer = `http://127.0.0.1:${server.address().port}`;
  const url = `${issuer}/mcp`;
  const servers = { cloudflare: { type: "http", url } };
  const storage = new McpOAuthStorage(authPath);
  const clients = [];
  return {
    authPath,
    url,
    storage,
    registrations,
    authorizations,
    get refreshes() {
      return refreshes;
    },
    get calls() {
      return calls;
    },
    noAdvertisedScopes() {
      advertise = false;
    },
    manager() {
      const client = new McpManager(servers, {}, authPath);
      clients.push(client);
      return client;
    },
    async login(flags = [], override = {}) {
      const {
        onAuthorization = async (value) => {
          const auth = new URL(value);
          authorizations.push(auth);
          const callback = new URL(auth.searchParams.get("redirect_uri"));
          callback.searchParams.set("state", auth.searchParams.get("state"));
          callback.searchParams.set("code", "test-code");
          callback.searchParams.set("iss", issuer);
          await fetch(callback);
        },
        ...options
      } = override;
      const controller = new AbortController();
      let authorization;
      try {
        await runMcpCommand({
          command: parseMcpCliArgs(["login", "cloudflare", ...flags]),
          servers,
          authPath,
          ...options,
          signal: AbortSignal.any([controller.signal, ...(options.signal ? [options.signal] : [])]),
          log: (message) => {
            const url = message.split("\n").find((line) => line.startsWith("http://"));
            if (url) {
              authorization = onAuthorization(url);
              void authorization.catch((error) => controller.abort(error));
            }
          },
        });
      } finally {
        await authorization;
      }
    },
    async logout() {
      await runMcpCommand({
        command: parseMcpCliArgs(["logout", "cloudflare"]),
        servers,
        authPath,
        signal: signal(),
        log: () => {},
      });
    },
    async close() {
      await Promise.all(clients.map((client) => client.close()));
      await new Promise((resolve) => server.close(resolve));
      rmSync(directory, { recursive: true, force: true });
    },
  };
}

describe("MCP OAuth", () => {
  it("reports required scopes, accepts explicit authorization, and reloads credentials without restarting", async () => {
    const fx = await fixture();
    try {
      const client = fx.manager();
      const discovery = await searchMcpTools(client, "dns", { limit: 8 }, signal());
      expect(JSON.parse(discovery.errors[0].error)).toMatchObject({
        code: "mcp_authorization_required",
        server: "cloudflare",
        scopes: [],
      });
      await fx.login();
      expect(fx.authorizations[0].searchParams.get("scope")).toBe("account.read");
      await expect(client.callTool("cloudflare", "dns", {}, signal())).rejects.toMatchObject({
        code: "mcp_authorization_required",
        scopes: ["dns.write"],
      });
      const tool = createCapabilityTool({}, createMcpCapability(client));
      const failure = await tool.execute(
        {
          id: "oauth",
          name: "mcp",
          arguments: { code: 'await tau.mcp.callTool("cloudflare", "dns", {})' },
        },
        {
          agentId: "agent",
          turnId: "turn",
          assistantMessageId: "message",
          signal: signal(),
          emitActivity: async () => {},
        },
      );
      expect(failure.outcome).toBe("failed");
      expect(JSON.stringify(failure)).toContain("dns.write");
      expect(JSON.stringify(failure)).toContain("mcp_authorization_required");
      expect(fx.calls).toBe(0);
      const persisted = JSON.parse(readFileSync(fx.authPath, "utf8")).mcp[fx.url];
      expect(Object.keys(persisted).sort()).toEqual([
        "authorizationServerUrl",
        "clientInformation",
        "redirectUrl",
        "tokens",
        "tokensExpireAt",
      ]);
      await fx.login(["--scope", "dns.write"]);
      expect(fx.authorizations[1].searchParams.get("scope").split(" ")).toEqual([
        "account.read",
        "dns.write",
      ]);
      expect(fx.registrations).toHaveLength(1);
      expect((await client.callTool("cloudflare", "dns", {}, signal())).isError).toBe(false);
      expect(fx.calls).toBe(1);
      expect(statSync(fx.authPath).mode & 0o777).toBe(0o600);
      await fx.logout();
      await expect(client.callTool("cloudflare", "dns", {}, signal())).rejects.toBeInstanceOf(
        McpAuthorizationError,
      );
    } finally {
      await fx.close();
    }
  });

  it("requests every advertised scope only with --all, and rejects absent advertisements", async () => {
    const fx = await fixture();
    try {
      await fx.login(["--all"]);
      expect(fx.authorizations[0].searchParams.get("scope").split(" ")).toEqual([
        "account.read",
        "dns.write",
        "offline_access",
      ]);
      fx.noAdvertisedScopes();
      await expect(fx.login(["--all"])).rejects.toThrow();
      expect(fx.authorizations).toHaveLength(1);
    } finally {
      await fx.close();
    }
  });

  it("serializes refreshes across independent managers and keeps rotated credentials", async () => {
    const fx = await fixture();
    try {
      await fx.login(["--all"]);
      const before = fx.storage.read(fx.url);
      fx.storage.save(fx.url, { ...before, tokensExpireAt: 0 });
      const first = fx.manager();
      const second = fx.manager();
      await Promise.all([
        first.listTools("cloudflare", signal()),
        second.listTools("cloudflare", signal()),
      ]);
      expect(fx.refreshes).toBe(1);
      expect(fx.storage.read(fx.url).tokens.refresh_token).not.toBe(before.tokens.refresh_token);
      expect((await first.callTool("cloudflare", "dns", {}, signal())).isError).toBe(false);
    } finally {
      await fx.close();
    }
  });

  it("rejects mismatched issuers without saving credentials and cancels a pending login", async () => {
    const fx = await fixture();
    try {
      await expect(
        fx.login([], {
          onAuthorization: async (value) => {
            const auth = new URL(value);
            const callback = new URL(auth.searchParams.get("redirect_uri"));
            callback.searchParams.set("state", auth.searchParams.get("state"));
            callback.searchParams.set("code", "test-code");
            callback.searchParams.set("iss", "https://wrong.example");
            await fetch(callback);
          },
        }),
      ).rejects.toThrow();
      expect(fx.storage.read(fx.url)).toBeUndefined();
      const controller = new AbortController();
      await expect(
        fx.login([], {
          signal: controller.signal,
          onAuthorization: async () => controller.abort(),
        }),
      ).rejects.toThrow();
      expect(fx.storage.read(fx.url)).toBeUndefined();
    } finally {
      await fx.close();
    }
  });

  it("isolates credentials by URL, respects static headers, and refuses a changed authorization server", async () => {
    const fx = await fixture();
    try {
      await fx.login(["--all"]);
      const other = createMcpAuthProvider("other", `${fx.url}/other`, fx.storage, signal(), false);
      expect(await other.token()).toBeUndefined();
      const explicit = createMcpAuthProvider("cloudflare", fx.url, fx.storage, signal(), true);
      expect(await explicit.token()).toBeUndefined();
      const before = fx.storage.read(fx.url);
      fx.storage.save(fx.url, {
        ...before,
        authorizationServerUrl: "https://old.example",
        tokensExpireAt: 0,
      });
      await expect(fx.manager().listTools("cloudflare", signal())).rejects.toBeInstanceOf(
        McpAuthorizationError,
      );
      expect(fx.refreshes).toBe(0);
      expect(fx.storage.read(fx.url).tokens).toEqual(before.tokens);
    } finally {
      await fx.close();
    }
  });

  it("parses explicit scope flags without combining --all or accepting shell-like server names", () => {
    expect(
      parseMcpCliArgs(["login", "cloudflare", "--scope", "dns.write", "--scope", "dns.write"])
        .scopes,
    ).toEqual(["dns.write"]);
    for (const args of [
      ["login", "x", "--all", "--scope", "dns.write"],
      ["login", "x", "--scope"],
      ["login", "x;echo"],
      ["logout", "x", "--all"],
    ]) {
      expect(() => parseMcpCliArgs(args)).toThrow();
    }
  });
});
