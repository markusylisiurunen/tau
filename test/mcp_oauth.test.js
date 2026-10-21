import { createHash, randomUUID } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createMcpCapability } from "../dist/core/code_mode/mcp.js";
import { parseMcpCliArgs, runMcpCommand } from "../dist/core/mcp/cli.js";
import { McpManager } from "../dist/core/mcp/manager.js";
import {
  createMcpAuthProvider,
  McpAuthorizationError,
  McpOAuthStorage,
  mcpOAuthFetch,
} from "../dist/core/mcp/oauth.js";
import { searchMcpTools } from "../dist/core/mcp/search.js";
import { createCapabilityTool } from "./helpers/code_mode.js";

const signal = () => new AbortController().signal;

async function fixture({ challengeOnly = false, scopedTools = false, metadataScopes = true } = {}) {
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
    if (
      request.url === "/metadata" ||
      (!challengeOnly && request.url.startsWith("/.well-known/oauth-protected-resource"))
    ) {
      return json({
        resource: url,
        authorization_servers: [issuer],
        ...(metadataScopes ? { scopes_supported: ["account.read"] } : {}),
      });
    }
    if (
      request.url === `/.well-known/oauth-authorization-server${challengeOnly ? "/issuer" : ""}`
    ) {
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
    if (request.url === `${challengeOnly ? "/issuer" : ""}/register`) {
      const registration = JSON.parse(text);
      registrations.push(registration);
      return json({ ...registration, client_id: `tau-client-${registrations.length}` });
    }
    if (request.url === `${challengeOnly ? "/issuer" : ""}/token`) {
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
      const registration = registrations[Number(params.get("client_id").split("-").at(-1)) - 1];
      if (!scope.split(" ").every((value) => registration.scope.split(" ").includes(value))) {
        return json({ error: "invalid_scope" }, 400);
      }
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
          "www-authenticate": `Bearer resource_metadata="${new URL(url).origin}${challengeOnly ? "/metadata" : "/.well-known/oauth-protected-resource/mcp"}", scope="account.read"`,
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
        result = {
          tools:
            scopedTools && !scopes.split(" ").includes("dns.write")
              ? []
              : [{ name: "dns", inputSchema: { type: "object" } }],
        };
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
  if (challengeOnly) issuer += "/issuer";
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
        beforeAuthorization = async () => {},
        onAuthorization = async (value) => {
          const auth = new URL(value);
          await beforeAuthorization();
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
        "grantId",
        "redirectUrl",
        "resourceMetadataUrl",
        "tokens",
        "tokensExpireAt",
      ]);
      await fx.login(["--scope", "dns.write"]);
      expect(fx.authorizations[1].searchParams.get("scope").split(" ")).toEqual([
        "account.read",
        "dns.write",
      ]);
      expect(fx.registrations).toHaveLength(2);
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

  it("uses challenge-only scopes for default login while preserving existing grants", async () => {
    const fx = await fixture({ metadataScopes: false });
    try {
      await fx.login();
      expect(fx.storage.read(fx.url).tokens.scope).toBe("account.read");
      await fx.login(["--scope", "dns.write"]);
      await fx.login();
      expect(fx.storage.read(fx.url).tokens.scope.split(" ")).toEqual([
        "account.read",
        "dns.write",
      ]);
    } finally {
      await fx.close();
    }
  });

  it("accepts token rotation during login but rejects replacement or removal of the grant", async () => {
    const fx = await fixture();
    try {
      await fx.login();
      const before = fx.storage.read(fx.url);
      await fx.login(["--scope", "dns.write"], {
        beforeAuthorization: async () => {
          fx.storage.save(fx.url, { ...before, tokensExpireAt: 0 });
          const provider = createMcpAuthProvider("cloudflare", fx.url, fx.storage, signal(), false);
          await provider.token();
          expect(fx.storage.read(fx.url).grantId).toBe(before.grantId);
        },
      });
      expect(fx.refreshes).toBe(1);
      expect(fx.storage.read(fx.url).tokens.scope).toBe("account.read dns.write");
      expect(fx.storage.read(fx.url).grantId).not.toBe(before.grantId);
      const replacement = { ...fx.storage.read(fx.url), grantId: randomUUID() };
      await expect(
        fx.login([], {
          beforeAuthorization: async () => fx.storage.save(fx.url, replacement),
        }),
      ).rejects.toThrow();
      expect(fx.storage.read(fx.url)).toEqual(replacement);
      await expect(
        fx.login([], {
          beforeAuthorization: async () => fx.logout(),
        }),
      ).rejects.toThrow();
      expect(fx.storage.read(fx.url)).toBeUndefined();
    } finally {
      await fx.close();
    }
  });

  it.each(["issuer", "redirect"])(
    "rejects insecure discovery %s before login or refresh can send credentials",
    async (mode) => {
      const fx = await fixture();
      const realFetch = globalThis.fetch;
      let spy;
      try {
        await fx.login();
        const before = fx.storage.read(fx.url);
        fx.storage.save(fx.url, { ...before, tokensExpireAt: 0 });
        spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
          const url = new URL(input);
          if (url.hostname !== "127.0.0.1") throw new Error("unexpected network request");
          if (url.pathname.startsWith("/.well-known/oauth-protected-resource")) {
            return mode === "issuer"
              ? Response.json({
                  resource: fx.url,
                  authorization_servers: ["http://issuer.example"],
                })
              : new Response(null, {
                  status: 302,
                  headers: { location: "http://issuer.example/metadata" },
                });
          }
          return realFetch(input, init);
        });
        await expect(fx.login()).rejects.toThrow();
        const provider = createMcpAuthProvider("cloudflare", fx.url, fx.storage, signal(), false);
        await expect(provider.token()).rejects.toThrow();
        expect(spy.mock.calls.every(([url]) => new URL(url).hostname === "127.0.0.1")).toBe(true);
        expect(fx.refreshes).toBe(0);
        expect(fx.storage.read(fx.url).tokens).toEqual(before.tokens);
        expect(fx.authorizations).toHaveLength(1);
      } finally {
        spy?.mockRestore();
        await fx.close();
      }
    },
  );

  it("validates every discovery redirect and does not redirect credential POSTs", async () => {
    const spy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = new URL(input);
      return new Response(null, {
        status: 307,
        headers: {
          location: url.pathname === "/start" ? "/metadata" : "http://issuer.example/metadata",
        },
      });
    });
    try {
      await expect(mcpOAuthFetch("https://issuer.example/start")).rejects.toThrow();
      expect(spy.mock.calls.map(([url]) => url.href)).toEqual([
        "https://issuer.example/start",
        "https://issuer.example/metadata",
      ]);
      expect(spy.mock.calls.every(([, init]) => init.redirect === "manual")).toBe(true);
      spy.mockClear();
      await expect(
        mcpOAuthFetch("https://issuer.example/start", {
          method: "POST",
          body: "refresh_token=secret",
        }),
      ).rejects.toThrow();
      expect(spy).toHaveBeenCalledTimes(1);
      spy.mockClear();
      await expect(mcpOAuthFetch("http://issuer.example/token")).rejects.toThrow();
      await expect(mcpOAuthFetch("ftp://localhost/token")).rejects.toThrow();
      expect(spy).not.toHaveBeenCalled();
    } finally {
      spy.mockRestore();
    }
  });

  it("discovers challenge-only metadata and uses it for proactive and reactive refresh", async () => {
    const fx = await fixture({ challengeOnly: true });
    try {
      await fx.login(["--all"]);
      const before = fx.storage.read(fx.url);
      expect(before.authorizationServerUrl).toBe(`${new URL(fx.url).origin}/issuer`);
      fx.storage.save(fx.url, { ...before, tokensExpireAt: 0 });
      const provider = createMcpAuthProvider("cloudflare", fx.url, fx.storage, signal(), false);
      const token = await provider.token();
      expect(fx.refreshes).toBe(1);
      const { resourceMetadataUrl, ...current } = fx.storage.read(fx.url);
      fx.storage.save(fx.url, current);
      await provider.onUnauthorized({
        token,
        response: new Response(null, {
          status: 401,
          headers: {
            "www-authenticate": `Bearer resource_metadata="${resourceMetadataUrl}"`,
          },
        }),
      });
      expect(fx.refreshes).toBe(2);
      expect(fx.storage.read(fx.url).resourceMetadataUrl).toBe(resourceMetadataUrl);
    } finally {
      await fx.close();
    }
  });

  it("refreshes the tool catalog after login expands the grant and after logout", async () => {
    const fx = await fixture({ scopedTools: true });
    try {
      await fx.login();
      const client = fx.manager();
      expect((await client.listTools("cloudflare", signal())).tools).toEqual([]);
      const before = fx.storage.read(fx.url);
      const controller = new AbortController();
      await expect(
        fx.login(["--scope", "dns.write"], {
          signal: controller.signal,
          onAuthorization: async () => controller.abort(),
        }),
      ).rejects.toThrow();
      expect(fx.storage.read(fx.url)).toEqual(before);
      await fx.login(["--scope", "dns.write"]);
      expect(
        (await client.listTools("cloudflare", signal())).tools.map((tool) => tool.name),
      ).toEqual(["dns"]);
      expect((await client.callTool("cloudflare", "dns", {}, signal())).isError).toBe(false);
      await fx.login(["--scope", "dns.write"]);
      expect(fx.registrations).toHaveLength(3);
      await fx.logout();
      await expect(client.listTools("cloudflare", signal())).rejects.toBeInstanceOf(
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
