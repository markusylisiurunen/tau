import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AuthManager } from "../dist/core/auth/auth_manager.js";
import { AuthStorage } from "../dist/core/auth/auth_storage.js";
import { runListCommand, runLoginCommand } from "../dist/core/auth/cli.js";
import { TauCredentialStore } from "../dist/core/auth/credential_store.js";
import { ModelRuntime } from "../dist/core/utils/model_stream.js";

const scope = "openid profile email offline_access resource.invoke chatgpt.tokens.use.direct";
const tokenUrl = "https://auth.openai.com/api/accounts/oauth/token";
let directory;
let authPath;
let storage;

function credential(overrides = {}) {
  return {
    type: "oauth",
    access: "chatgpt-access",
    refresh: "chatgpt-refresh",
    expires: Date.now() + 3600000,
    clientId: "issued-client",
    scopes: scope.split(" "),
    ...overrides,
  };
}

function runtime() {
  return new ModelRuntime({
    authStorage: storage,
    getConfig: () => ({ apiKeys: { openai: "sk-config" } }),
    env: {},
  });
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), "tau-openai-auth-"));
  authPath = join(directory, "auth.json");
  storage = new AuthStorage(authPath);
});

afterEach(() => {
  vi.unstubAllGlobals();
  rmSync(directory, { recursive: true, force: true });
});

describe("Sign in with ChatGPT", () => {
  it("uses Pi's public login flow and persists its registration with a stable installation ID", async () => {
    const fetchMock = vi.fn(async (url, options) => {
      expect(String(url)).toBe(tokenUrl);
      const body = new URLSearchParams(options.body);
      expect(body.get("grant_type")).toBe("authorization_code");
      expect(body.get("client_id")).toBe("issued-client");
      expect(body.get("code_verifier")).toBeTruthy();
      return Response.json({
        access_token: "chatgpt-access",
        refresh_token: "chatgpt-refresh",
        expires_in: 3600,
        id_token: "id-token",
        scope,
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const deviceIds = [];
    for (let i = 0; i < 2; i++) {
      let authorizationUrl;
      await runLoginCommand({
        providerArg: "openai",
        authStorage: new AuthStorage(authPath),
        authPath,
        log: (message) => {
          if (message.startsWith("https://auth.openai.com/")) authorizationUrl = new URL(message);
        },
        prompt: async (prompt) => {
          expect(prompt.type).toBe("manual_code");
          expect(authorizationUrl.searchParams.get("client_id")).toBe("dynamic_agent_client");
          deviceIds.push(authorizationUrl.searchParams.get("ext_agent_host_id"));
          const callback = new URL(authorizationUrl.searchParams.get("redirect_uri"));
          callback.searchParams.set("code", "authorization-code");
          callback.searchParams.set("state", authorizationUrl.searchParams.get("state"));
          callback.searchParams.set("client_id", "issued-client");
          return callback.toString();
        },
      });
    }
    const saved = JSON.parse(readFileSync(authPath, "utf8"));
    expect(deviceIds).toEqual([`urn:uuid:${saved.deviceId}`, `urn:uuid:${saved.deviceId}`]);
    expect(saved.providers.openai.accounts).toHaveLength(1);
    expect(saved.providers.openai.accounts[0]).toMatchObject({
      accountId: "openai:default",
      access: "chatgpt-access",
      refresh: "chatgpt-refresh",
      clientId: "issued-client",
      scopes: scope.split(" "),
    });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("refreshes through the model runtime and preserves the issued client ID and replacement scopes", async () => {
    new AuthManager(storage).addOAuthAccount("openai", credential({ expires: 0 }));
    const log = vi.fn();
    await runListCommand({ authStorage: storage, log });
    expect(log.mock.calls.flat().join("\n")).toContain(
      "refresh will be attempted on the next model request",
    );
    const replacementScope = "resource.invoke chatgpt.tokens.use.direct";
    const fetchMock = vi.fn(async (url, options) => {
      expect(String(url)).toBe(tokenUrl);
      const body = new URLSearchParams(options.body);
      expect(body.get("grant_type")).toBe("refresh_token");
      expect(body.get("client_id")).toBe("issued-client");
      expect(body.get("refresh_token")).toBe("chatgpt-refresh");
      return Response.json({
        access_token: "refreshed-access",
        refresh_token: "rotated-refresh",
        expires_in: 3600,
        scope: replacementScope,
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const models = runtime();
    const model = models.resolveModel("openai", "gpt-5.4");
    expect((await models.getAuth(model)).auth.apiKey).toBe("refreshed-access");
    const reopened = new TauCredentialStore({
      authStorage: new AuthStorage(authPath),
      getConfig: () => ({}),
    });
    expect(await reopened.read("openai")).toMatchObject({
      access: "refreshed-access",
      refresh: "rotated-refresh",
      clientId: "issued-client",
      scopes: replacementScope.split(" "),
    });
    expect((await models.getAuth(model)).auth.apiKey).toBe("refreshed-access");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("sends the access token to Responses and omits fields unsupported by ChatGPT sign-in", async () => {
    new AuthManager(storage).addOAuthAccount("openai", credential());
    let requestBody;
    vi.stubGlobal(
      "fetch",
      vi.fn(async (input, init) => {
        const request = new Request(input, init);
        expect(request.url).toBe("https://api.openai.com/v1/responses");
        expect(request.headers.get("authorization")).toBe("Bearer chatgpt-access");
        requestBody = await request.json();
        return new Response(
          'data: {"type":"response.completed","response":{"id":"resp-test","status":"completed","output":[],"usage":{"input_tokens":0,"output_tokens":0}}}\n\n',
          {
            headers: { "content-type": "text/event-stream" },
          },
        );
      }),
    );
    const models = runtime();
    const result = await models
      .streamModel(
        models.resolveModel("openai", "gpt-5.4"),
        {
          systemPrompt: "test",
          messages: [{ role: "user", content: "hello", timestamp: Date.now() }],
        },
        { maxTokens: 128, temperature: 0.5, cacheRetention: "long" },
      )
      .result();
    expect(result.stopReason).not.toBe("error");
    expect(requestBody).toBeDefined();
    expect(requestBody.max_output_tokens).toBeUndefined();
    expect(requestBody.temperature).toBeUndefined();
    expect(requestBody.prompt_cache_retention).toBeUndefined();
    expect(requestBody.prompt_cache_options).toBeUndefined();
  });

  it("lists, disables, enables, and removes ChatGPT independently of legacy Codex", async () => {
    const manager = new AuthManager(storage);
    manager.addOAuthAccount("openai", credential());
    storage.update((data) => {
      data.providers["openai-codex"] = { accounts: [] };
    });
    const log = vi.fn();
    await runListCommand({ authStorage: storage, log });
    expect(log.mock.calls.flat().join("\n")).toContain("openai:default");
    expect(log.mock.calls.flat().join("\n")).not.toContain("refresh failed");
    const models = runtime();
    const model = models.resolveModel("openai", "gpt-5.4");
    expect((await models.getAuth(model)).auth.apiKey).toBe("chatgpt-access");
    manager.setAccountEnabled("openai", "openai:default", false);
    expect((await models.getAuth(model)).auth.apiKey).toBe("sk-config");
    manager.setAccountEnabled("openai", "openai:default", true);
    expect((await models.getAuth(model)).auth.apiKey).toBe("chatgpt-access");
    manager.removeAccount("openai", "openai:default");
    expect((await models.getAuth(model)).auth.apiKey).toBe("sk-config");
    expect(storage.getData().providers["openai-codex"]).toEqual({ accounts: [] });
  });

  it("refreshes once across concurrent runtimes sharing the auth file", async () => {
    new AuthManager(storage).addOAuthAccount("openai", credential({ expires: 0 }));
    const fetchMock = vi.fn(async () => {
      await new Promise((resolve) => setTimeout(resolve, 30));
      return Response.json({
        access_token: "refreshed-access",
        refresh_token: "rotated-refresh",
        expires_in: 3600,
        scope,
      });
    });
    vi.stubGlobal("fetch", fetchMock);
    const runtimes = Array.from(
      { length: 3 },
      () =>
        new ModelRuntime({
          authStorage: new AuthStorage(authPath),
          getConfig: () => ({}),
          env: {},
        }),
    );
    const results = await Promise.all(
      runtimes.map((models) => models.getAuth(models.resolveModel("openai", "gpt-5.4"))),
    );
    expect(results.map((result) => result.auth.apiKey)).toEqual(Array(3).fill("refreshed-access"));
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it.each(["disable", "logout", "reconnect"])(
    "does not overwrite a concurrent %s during refresh",
    async (action) => {
      const manager = new AuthManager(storage);
      manager.addOAuthAccount("openai", credential({ expires: 0 }));
      let finishRefresh;
      const started = Promise.withResolvers();
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          const result = Promise.withResolvers();
          finishRefresh = () =>
            result.resolve(
              Response.json({
                access_token: "stale-access",
                refresh_token: "stale-refresh",
                expires_in: 3600,
                scope,
              }),
            );
          started.resolve();
          return result.promise;
        }),
      );
      const models = runtime();
      const pending = models.getAuth(models.resolveModel("openai", "gpt-5.4"));
      await started.promise;
      if (action === "disable") manager.setAccountEnabled("openai", "openai:default", false);
      if (action === "logout") manager.removeAccount("openai", "openai:default");
      if (action === "reconnect")
        manager.addOAuthAccount(
          "openai",
          credential({ clientId: "new-client", access: "new-access" }),
        );
      finishRefresh();
      const auth = await pending;
      storage.reload();
      const account = storage.getData().providers.openai.accounts[0];
      if (action === "reconnect") {
        expect(auth.auth.apiKey).toBe("new-access");
        expect(account.clientId).toBe("new-client");
      } else {
        expect(auth).toBeUndefined();
        if (action === "logout") expect(account).toBeUndefined();
        else expect(account.disabled).toBe(true);
      }
      expect(account?.refresh).not.toBe("stale-refresh");
    },
  );

  it("cancels a queued credential mutation without holding the refresh lock", async () => {
    const store = new TauCredentialStore({ authStorage: storage, getConfig: () => ({}) });
    const started = Promise.withResolvers();
    const release = Promise.withResolvers();
    const holding = store.modify("openai", async () => {
      started.resolve();
      await release.promise;
      return credential();
    });
    await started.promise;
    const controller = new AbortController();
    const mutate = vi.fn();
    const queued = store.modify("openai", mutate, { signal: controller.signal });
    controller.abort();
    await expect(queued).rejects.toThrow();
    expect(mutate).not.toHaveBeenCalled();
    release.resolve();
    await holding;
    expect(await store.modify("openai", async (current) => current)).toMatchObject({
      clientId: "issued-client",
    });
  });

  it("keeps the legacy Codex browser and device-code login choices", async () => {
    await expect(
      runLoginCommand({
        providerArg: "codex",
        authStorage: storage,
        authPath,
        log: () => {},
        prompt: async (prompt) => {
          expect(prompt.type).toBe("select");
          expect(prompt.options.map((option) => option.id)).toEqual(["browser", "device_code"]);
          throw new Error("cancel test login");
        },
      }),
    ).rejects.toThrow("cancel test login");
    expect(storage.getData().deviceId).toBeUndefined();
  });

  it("rejects incomplete registrations without changing stored credentials", () => {
    const manager = new AuthManager(storage);
    manager.addOAuthAccount("openai", credential());
    expect(() => manager.addOAuthAccount("openai", credential({ clientId: undefined }))).toThrow(
      "issued client ID",
    );
    expect(() => manager.addOAuthAccount("openai", credential({ scopes: ["openid"] }))).toThrow(
      "direct token scope",
    );
    storage.reload();
    expect(storage.getData().providers.openai.accounts[0].clientId).toBe("issued-client");
  });
});
