import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getNookAccessClientSecret } from "../dist/core/config/index.js";
import {
  buildNookDeployManifest,
  buildNookTemplateManifest,
  NookClient,
  normalizeNookAssetPath,
  validateNookManifest,
  validateNookSiteSlug,
  validateNookTemplateName,
} from "../dist/core/nook/index.js";
import {
  parseNookDestroyInputs,
  parseNookInfrastructureDomain,
  parseNookSetupInputs,
  runNookSetup,
} from "../dist/core/nook/setup.js";
import { createNookToolDefinition } from "../dist/core/tools/nook.js";
import worker, { cacheControlForDeployedAsset, RegistryDO } from "../dist/nook/worker/index.js";

afterEach(() => {
  vi.restoreAllMocks();
});

function createDurableStorage() {
  const records = new Map();
  return {
    records,
    async get(key) {
      return records.get(key);
    },
    async put(key, value) {
      records.set(key, value);
    },
    async delete(keys) {
      for (const key of Array.isArray(keys) ? keys : [keys]) records.delete(key);
      return true;
    },
    async list(options = {}) {
      return new Map(
        [...records.entries()].filter(([key]) => !options.prefix || key.startsWith(options.prefix)),
      );
    },
    async deleteAll() {
      records.clear();
    },
  };
}

const templateManifest = [
  {
    path: "/package.json",
    sizeBytes: 2,
    contentType: "application/json",
    sha256: "a".repeat(64),
  },
];

async function startTemplateSave(registry, name = "starter") {
  const response = await registry.fetch(
    new Request(`https://registry.local/templates/${name}/save/start`, {
      method: "POST",
      body: JSON.stringify({ files: templateManifest }),
    }),
  );
  return { response, body: await response.json() };
}

async function runTool(tool, toolCall, signal = new AbortController().signal) {
  const activities = [];
  const outcome = await tool.execute(toolCall, {
    agentId: "test-agent",
    turnId: "test-turn",
    assistantMessageId: "test-assistant",
    signal,
    emitActivity: async (activity) => activities.push(activity),
  });
  return {
    toolResult: { ...outcome, toolCallId: toolCall.id, toolName: toolCall.name },
    uiEvent: activities.at(-1),
    activities,
  };
}

describe("nook validation", () => {
  it("accepts path-safe slugs and rejects reserved or malformed slugs", () => {
    expect(validateNookSiteSlug("demo-app").ok).toBe(true);
    expect(validateNookSiteSlug("Demo").ok).toBe(false);
    expect(validateNookSiteSlug("api").ok).toBe(false);
    expect(validateNookSiteSlug("-demo").ok).toBe(false);
    expect(validateNookSiteSlug("demo-").ok).toBe(false);
  });

  it("normalizes deploy paths and rejects reserved or traversal paths", () => {
    expect(normalizeNookAssetPath("/assets/app.js")).toBe("/assets/app.js");
    expect(() => normalizeNookAssetPath("/__nook/client.js")).toThrow(/reserved/);
    expect(() => normalizeNookAssetPath("../index.html")).toThrow(/must start/);
    expect(() => normalizeNookAssetPath("/../index.html")).toThrow(/must not contain/);
  });

  it("builds a manifest for visible static files and requires index.html", async () => {
    const root = await mkdtemp(join(tmpdir(), "tau-nook-test-"));
    mkdirSync(join(root, "assets"));
    writeFileSync(join(root, "index.html"), "<html></html>");
    writeFileSync(join(root, "assets", "app.js"), "console.log('ok');");

    const files = buildNookDeployManifest(root);
    expect(files.map((file) => file.path)).toEqual(["/assets/app.js", "/index.html"]);
    expect(files[0]?.sha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("builds templates without requiring index.html and validates template names", async () => {
    const root = await mkdtemp(join(tmpdir(), "tau-nook-template-test-"));
    writeFileSync(join(root, "package.json"), '{"name":"starter"}');

    expect(buildNookTemplateManifest(root).map((file) => file.path)).toEqual(["/package.json"]);
    expect(validateNookTemplateName("demo-starter").ok).toBe(true);
    expect(validateNookTemplateName("api").ok).toBe(true);
    expect(validateNookTemplateName("Demo").ok).toBe(false);
  });

  it("rejects hidden deploy files", async () => {
    const root = await mkdtemp(join(tmpdir(), "tau-nook-test-"));
    writeFileSync(join(root, "index.html"), "<html></html>");
    writeFileSync(join(root, ".env"), "secret");

    expect(() => buildNookDeployManifest(root)).toThrow(/hidden deploy path/);
  });

  it("requires visible hashed manifest entries", () => {
    const validHash = "a".repeat(64);
    expect(() =>
      validateNookManifest([
        {
          path: "/index.html",
          sizeBytes: 1,
          contentType: "text/html; charset=utf-8",
          sha256: validHash,
        },
        {
          path: "/assets/.secret",
          sizeBytes: 1,
          contentType: "text/plain; charset=utf-8",
          sha256: validHash,
        },
      ]),
    ).toThrow(/hidden deploy path/);
    expect(() =>
      validateNookManifest([
        {
          path: "/index.html",
          sizeBytes: 1,
          contentType: "text/html; charset=utf-8",
        },
      ]),
    ).toThrow(/invalid sha256/);
  });
});

describe("nook config", () => {
  it("prefers access client secret env over inline secret", () => {
    expect(
      getNookAccessClientSecret(
        {
          domain: "nook.example.com",
          accessClientSecret: "inline",
          accessClientSecretEnv: "NOOK_SECRET",
        },
        { NOOK_SECRET: "from-env" },
      ),
    ).toBe("from-env");
  });
});

describe("nook client cancellation", () => {
  it("forwards cancellation to Nook HTTP requests", async () => {
    const controller = new AbortController();
    let requestStarted;
    const started = new Promise((resolve) => {
      requestStarted = resolve;
    });
    const fetchImpl = vi.fn(
      async (_url, init) =>
        await new Promise((_resolve, reject) => {
          requestStarted();
          init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
        }),
    );
    const client = new NookClient({
      config: { domain: "nook.example.com" },
      fetchImpl,
      signal: controller.signal,
    });

    const request = client.listSites();
    await started;
    controller.abort();

    await expect(request).rejects.toMatchObject({ name: "AbortError" });
    expect(fetchImpl.mock.calls[0][1].signal).toBe(controller.signal);
  });
});

describe("nook KV client", () => {
  it("uses the Access-protected management API", async () => {
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(Response.json({ value: { theme: "dark" } }))
      .mockResolvedValueOnce(Response.json({ key: "settings" }))
      .mockResolvedValueOnce(Response.json({ key: "settings", deleted: true }))
      .mockResolvedValueOnce(Response.json({ site: "demo", keys: [] }));
    const client = new NookClient({
      config: {
        domain: "nook.example.com",
        accessClientId: "client-id",
        accessClientSecret: "client-secret",
      },
      fetchImpl,
    });

    await client.getKv("demo", "todos/1");
    await client.putKv("demo", "settings", { theme: "dark" });
    await client.deleteKv("demo", "settings");
    await client.listKv("demo", "todos/");

    expect(fetchImpl.mock.calls.map(([url]) => new URL(String(url)).pathname)).toEqual([
      "/__nook/api/sites/demo/kv/todos%2F1",
      "/__nook/api/sites/demo/kv/settings",
      "/__nook/api/sites/demo/kv/settings",
      "/__nook/api/sites/demo/kv",
    ]);
    expect(new URL(String(fetchImpl.mock.calls[3][0])).searchParams.get("prefix")).toBe("todos/");
    for (const [, init] of fetchImpl.mock.calls) {
      expect(init.headers).toMatchObject({
        "CF-Access-Client-Id": "client-id",
        "CF-Access-Client-Secret": "client-secret",
      });
    }
  });
});

describe("nook site copy", () => {
  it("copies verified active deployment files into an existing empty directory", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tau-nook-site-copy-test-"));
    const content = Buffer.from("<html>restored</html>");
    const sha256 = createHash("sha256").update(content).digest("hex");
    const fetchImpl = vi.fn(async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/__nook/api/sites/demo") {
        return Response.json({
          site: "demo",
          deploymentId: "dep_aaaaaaaaaaaaaaaaaaaaaaaa",
          visibility: "private",
          fileCount: 1,
          byteCount: content.byteLength,
          files: [
            {
              path: "/index.html",
              sizeBytes: content.byteLength,
              contentType: "text/html; charset=utf-8",
              sha256,
            },
          ],
        });
      }
      if (url.pathname === "/__nook/api/sites/demo/file") {
        expect(url.searchParams.get("deployment")).toBe("dep_aaaaaaaaaaaaaaaaaaaaaaaa");
        expect(url.searchParams.get("path")).toBe("/index.html");
        return new Response(content);
      }
      throw new Error(`unexpected request ${url}`);
    });
    const client = new NookClient({ config: { domain: "nook.example.com" }, fetchImpl });

    const result = await client.copySiteToDirectory("demo", directory);

    expect(result.deploymentId).toBe("dep_aaaaaaaaaaaaaaaaaaaaaaaa");
    expect(readFileSync(join(directory, "index.html"))).toEqual(content);
  });

  it("rejects a non-empty destination before downloading", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tau-nook-site-copy-test-"));
    writeFileSync(join(directory, "existing.txt"), "keep");
    const fetchImpl = vi.fn();
    const client = new NookClient({ config: { domain: "nook.example.com" }, fetchImpl });

    await expect(client.copySiteToDirectory("demo", directory)).rejects.toThrow(/not empty/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });
});

describe("nook templates", () => {
  it("copies verified binary files into an existing empty directory", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tau-nook-copy-test-"));
    const content = Buffer.from([0, 1, 2, 255]);
    const sha256 = createHash("sha256").update(content).digest("hex");
    const fetchImpl = vi.fn(async (input) => {
      const url = new URL(String(input));
      if (url.pathname === "/__nook/api/templates/starter") {
        return Response.json({
          template: {
            name: "starter",
            revisionId: "tpl_aaaaaaaaaaaaaaaaaaaaaaaa",
            createdAt: "2026-07-09T00:00:00.000Z",
            updatedAt: "2026-07-09T00:00:00.000Z",
            fileCount: 1,
            byteCount: content.byteLength,
          },
          files: [
            {
              path: "/assets/image.bin",
              sizeBytes: content.byteLength,
              contentType: "application/octet-stream",
              sha256,
            },
          ],
        });
      }
      if (url.pathname === "/__nook/api/templates/starter/file") {
        expect(url.searchParams.get("revision")).toBe("tpl_aaaaaaaaaaaaaaaaaaaaaaaa");
        return new Response(content);
      }
      throw new Error(`unexpected request ${url}`);
    });
    const client = new NookClient({ config: { domain: "nook.example.com" }, fetchImpl });

    await client.copyTemplateToDirectory("starter", directory);

    expect(readFileSync(join(directory, "assets", "image.bin"))).toEqual(content);
  });

  it("requires an existing empty copy destination before downloading", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tau-nook-copy-test-"));
    writeFileSync(join(directory, "existing.txt"), "keep");
    const fetchImpl = vi.fn();
    const client = new NookClient({ config: { domain: "nook.example.com" }, fetchImpl });

    await expect(client.copyTemplateToDirectory("starter", directory)).rejects.toThrow(/not empty/);
    await expect(
      client.copyTemplateToDirectory("starter", join(directory, "missing")),
    ).rejects.toThrow(/does not exist/);
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("does not write files when a download fails manifest verification", async () => {
    const directory = await mkdtemp(join(tmpdir(), "tau-nook-copy-test-"));
    const expected = Buffer.from("expected");
    const fetchImpl = vi
      .fn()
      .mockResolvedValueOnce(
        Response.json({
          template: {
            name: "starter",
            revisionId: "tpl_aaaaaaaaaaaaaaaaaaaaaaaa",
            createdAt: "2026-07-09T00:00:00.000Z",
            updatedAt: "2026-07-09T00:00:00.000Z",
            fileCount: 1,
            byteCount: expected.byteLength,
          },
          files: [
            {
              path: "/file.txt",
              sizeBytes: expected.byteLength,
              contentType: "text/plain",
              sha256: createHash("sha256").update(expected).digest("hex"),
            },
          ],
        }),
      )
      .mockResolvedValueOnce(new Response("corrupt!"));
    const client = new NookClient({ config: { domain: "nook.example.com" }, fetchImpl });

    await expect(client.copyTemplateToDirectory("starter", directory)).rejects.toThrow(/hash/);
    expect(readdirSync(directory)).toEqual([]);
  });
});

describe("nook worker", () => {
  it("requires revalidation for deployed asset URLs that remain stable across deploys", () => {
    expect(cacheControlForDeployedAsset()).toBe("public, no-cache, must-revalidate");
  });

  it("atomically switches template revisions and preserves creation time", async () => {
    const storage = createDurableStorage();
    const registry = new RegistryDO({ storage });
    const first = await startTemplateSave(registry);
    expect(first.response.status).toBe(200);
    await registry.fetch(
      new Request(
        `https://registry.local/templates/starter/save/${first.body.saveId}/mark-uploaded`,
        {
          method: "POST",
          body: JSON.stringify({ token: first.body.token, path: "/package.json" }),
        },
      ),
    );
    const firstFinish = await registry.fetch(
      new Request(`https://registry.local/templates/starter/save/${first.body.saveId}/finish`, {
        method: "POST",
        body: JSON.stringify({ token: first.body.token }),
      }),
    );
    const firstResult = await firstFinish.json();
    expect(firstResult.revisionId).toBe(first.body.saveId);
    expect(firstResult.previousRevisionId).toBeUndefined();

    const second = await startTemplateSave(registry);
    await registry.fetch(
      new Request(
        `https://registry.local/templates/starter/save/${second.body.saveId}/mark-uploaded`,
        {
          method: "POST",
          body: JSON.stringify({ token: second.body.token, path: "/package.json" }),
        },
      ),
    );
    const secondFinish = await registry.fetch(
      new Request(`https://registry.local/templates/starter/save/${second.body.saveId}/finish`, {
        method: "POST",
        body: JSON.stringify({ token: second.body.token }),
      }),
    );
    const secondResult = await secondFinish.json();

    expect(secondResult.revisionId).toBe(second.body.saveId);
    expect(secondResult.previousRevisionId).toBe(first.body.saveId);
    expect(secondResult.createdAt).toBe(firstResult.createdAt);
    expect(storage.records.get("template:starter").revisionId).toBe(second.body.saveId);
  });

  it("keeps expired saves available for R2 cleanup", async () => {
    const now = vi.spyOn(Date, "now").mockReturnValue(0);
    const storage = createDurableStorage();
    const registry = new RegistryDO({ storage });
    const expired = await startTemplateSave(registry);
    now.mockReturnValue(15 * 60 * 1000 + 1);

    const finish = await registry.fetch(
      new Request(`https://registry.local/templates/starter/save/${expired.body.saveId}/finish`, {
        method: "POST",
        body: JSON.stringify({ token: expired.body.token }),
      }),
    );
    expect(finish.status).toBe(410);
    expect(storage.records.has(`template-save:starter:${expired.body.saveId}`)).toBe(true);

    const next = await startTemplateSave(registry);
    expect(next.body.expiredSaveIds).toEqual([expired.body.saveId]);
    expect(storage.records.has(`template-save:starter:${expired.body.saveId}`)).toBe(false);
  });

  it("limits pending template saves and removes them on delete", async () => {
    const storage = createDurableStorage();
    const registry = new RegistryDO({ storage });
    await startTemplateSave(registry);
    await startTemplateSave(registry);
    await startTemplateSave(registry);

    const fourth = await startTemplateSave(registry);
    expect(fourth.response.status).toBe(429);

    const deleted = await registry.fetch(
      new Request("https://registry.local/templates/starter", { method: "DELETE" }),
    );
    expect(deleted.status).toBe(200);
    expect([...storage.records.keys()].filter((key) => key.includes("starter"))).toEqual([]);
  });

  it("uses verified Access JWTs for the control plane and private sites", async () => {
    const teamDomain = "https://team.cloudflareaccess.com";
    const audience = "aud";
    const { publicKey, privateKey } = await generateKeyPair("RS256");
    const jwk = await exportJWK(publicKey);
    const token = await new SignJWT({ email: "user@example.com" })
      .setProtectedHeader({ alg: "RS256", kid: "test-key" })
      .setIssuer(teamDomain)
      .setAudience(audience)
      .setExpirationTime("5m")
      .sign(privateKey);

    vi.spyOn(globalThis, "fetch").mockImplementation(async (url) => {
      if (String(url) === `${teamDomain}/cdn-cgi/access/certs`) {
        return Response.json({ keys: [{ ...jwk, kid: "test-key", alg: "RS256", use: "sig" }] });
      }
      throw new Error(`unexpected fetch ${String(url)}`);
    });

    const registryFetch = vi.fn(async () => Response.json({ sites: [] }));
    const siteFetch = vi.fn(async (request) => {
      const url = new URL(request.url);
      if (url.pathname === "/active") {
        return Response.json({
          deploymentId: "dep_1",
          public: false,
          files: [{ path: "/app.js", contentType: "application/javascript" }],
        });
      }
      if (url.pathname === "/kv/todos%2Fsettings") {
        expect(request.headers.get("x-nook-actor")).toBe("user@example.com");
        return Response.json({ value: { theme: "dark" } });
      }
      return Response.json({ error: { message: "unexpected" } }, { status: 404 });
    });
    const env = {
      ASSETS: {
        get: vi.fn(async () => ({
          body: new Response("console.log('private');").body,
          httpMetadata: { contentType: "application/javascript" },
        })),
      },
      REGISTRY_DO: {
        idFromName: (name) => name,
        get: () => ({ fetch: registryFetch }),
      },
      SITE_DO: {
        idFromName: (name) => name,
        get: () => ({ fetch: siteFetch }),
      },
      NOOK_DOMAIN: "nook.example.com",
      NOOK_ACCESS_TEAM_DOMAIN: teamDomain,
      NOOK_ACCESS_AUD: audience,
    };

    const apiResponse = await worker.fetch(
      new Request("https://nook.example.com/__nook/api/sites", {
        headers: { "Cf-Access-Jwt-Assertion": token },
      }),
      env,
    );
    expect(apiResponse.status).toBe(200);
    expect(await apiResponse.json()).toEqual({ sites: [] });
    expect(registryFetch).toHaveBeenCalledOnce();

    const kvResponse = await worker.fetch(
      new Request("https://nook.example.com/__nook/api/sites/demo/kv/todos%2Fsettings", {
        headers: { "Cf-Access-Jwt-Assertion": token },
      }),
      env,
    );
    expect(kvResponse.status).toBe(200);
    expect(await kvResponse.json()).toEqual({ value: { theme: "dark" } });

    const assetResponse = await worker.fetch(
      new Request("https://nook.example.com/demo/app.js", {
        headers: { Cookie: `CF_Authorization=${token}` },
      }),
      env,
    );
    expect(assetResponse.status).toBe(200);
    expect(await assetResponse.text()).toBe("console.log('private');");

    const authResponse = await worker.fetch(
      new Request("https://nook.example.com/__nook/auth?returnTo=%2Fdemo%2Fapp.js%3Ftheme%3Ddark", {
        headers: { "Cf-Access-Jwt-Assertion": token },
        redirect: "manual",
      }),
      env,
    );
    expect(authResponse.status).toBe(303);
    expect(authResponse.headers.get("location")).toBe(
      "https://nook.example.com/demo/app.js?theme=dark",
    );

    const unsafeAuthResponse = await worker.fetch(
      new Request("https://nook.example.com/__nook/auth?returnTo=https%3A%2F%2Fexample.com%2F", {
        headers: { "Cf-Access-Jwt-Assertion": token },
      }),
      env,
    );
    expect(unsafeAuthResponse.status).toBe(400);
  });

  it("serves sites from the first path segment", async () => {
    const response = await worker.fetch(
      new Request("https://nook.example.com/demo", { redirect: "manual" }),
      {
        ASSETS: {},
        REGISTRY_DO: {
          idFromName: (name) => name,
          get: () => ({ fetch: vi.fn() }),
        },
        SITE_DO: {
          idFromName: (name) => name,
          get: () => ({ fetch: vi.fn() }),
        },
        NOOK_DOMAIN: "nook.example.com",
        NOOK_ACCESS_TEAM_DOMAIN: "https://team.cloudflareaccess.com",
        NOOK_ACCESS_AUD: "aud",
      },
    );

    expect(response.status).toBe(308);
    expect(response.headers.get("location")).toBe("https://nook.example.com/demo/");
  });

  it("serves public site assets without Access identity", async () => {
    const siteFetch = vi.fn(async () =>
      Response.json({
        deploymentId: "dep_1",
        public: true,
        files: [{ path: "/app.js", contentType: "application/javascript" }],
      }),
    );
    const assetFetch = vi.fn(async () => ({
      body: new Response("console.log('public');").body,
      httpMetadata: { contentType: "application/javascript" },
    }));

    const response = await worker.fetch(new Request("https://nook.example.com/demo/app.js"), {
      ASSETS: { get: assetFetch },
      REGISTRY_DO: {
        idFromName: (name) => name,
        get: () => ({ fetch: vi.fn() }),
      },
      SITE_DO: {
        idFromName: (name) => name,
        get: () => ({ fetch: siteFetch }),
      },
      NOOK_DOMAIN: "nook.example.com",
      NOOK_ACCESS_TEAM_DOMAIN: "https://team.cloudflareaccess.com",
      NOOK_ACCESS_AUD: "aud",
    });

    expect(response.status).toBe(200);
    expect(await response.text()).toBe("console.log('public');");
    expect(assetFetch).toHaveBeenCalledWith("sites/demo/deployments/dep_1/app.js");
  });

  it("returns private apps to the current document after KV reauthentication", async () => {
    const siteFetch = vi.fn(async () =>
      Response.json({
        deploymentId: "dep_1",
        public: true,
        files: [],
      }),
    );
    const clientResponse = await worker.fetch(
      new Request("https://nook.example.com/demo/__nook/client.js"),
      {
        ASSETS: {},
        REGISTRY_DO: {
          idFromName: (name) => name,
          get: () => ({ fetch: vi.fn() }),
        },
        SITE_DO: {
          idFromName: (name) => name,
          get: () => ({ fetch: siteFetch }),
        },
        NOOK_DOMAIN: "nook.example.com",
        NOOK_ACCESS_TEAM_DOMAIN: "https://team.cloudflareaccess.com",
        NOOK_ACCESS_AUD: "aud",
      },
    );
    const clientScript = await clientResponse.text();
    const assign = vi.fn();
    const window = {
      location: {
        origin: "https://nook.example.com",
        pathname: "/demo/tasks",
        search: "?filter=open",
        hash: "#task-1",
        assign,
      },
    };
    const fetchImpl = vi.fn(async () =>
      Response.json(
        { error: { code: "unauthorized", message: "Authentication required" } },
        { status: 401 },
      ),
    );
    runInNewContext(clientScript, {
      document: {
        currentScript: { src: "https://nook.example.com/demo/__nook/client.js" },
      },
      fetch: fetchImpl,
      URL,
      window,
    });

    await expect(window.nook.kv.put("settings", { theme: "dark" })).rejects.toThrow(
      "Authentication required",
    );
    expect(assign).toHaveBeenCalledWith(
      "https://nook.example.com/__nook/auth?returnTo=%2Fdemo%2Ftasks%3Ffilter%3Dopen%23task-1",
    );
  });

  it("redirects anonymous private sites through the Access auth endpoint", async () => {
    const siteFetch = vi.fn(async () =>
      Response.json({
        deploymentId: "dep_1",
        public: false,
        files: [{ path: "/index.html", contentType: "text/html; charset=utf-8" }],
      }),
    );
    const env = {
      ASSETS: {},
      REGISTRY_DO: {
        idFromName: (name) => name,
        get: () => ({ fetch: vi.fn() }),
      },
      SITE_DO: {
        idFromName: (name) => name,
        get: () => ({ fetch: siteFetch }),
      },
      NOOK_DOMAIN: "nook.example.com",
      NOOK_ACCESS_TEAM_DOMAIN: "https://team.cloudflareaccess.com",
      NOOK_ACCESS_AUD: "aud",
    };

    const response = await worker.fetch(
      new Request("https://nook.example.com/demo/?theme=dark", { redirect: "manual" }),
      env,
    );
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      "https://nook.example.com/__nook/auth?returnTo=%2Fdemo%2F%3Ftheme%3Ddark",
    );

    const kvResponse = await worker.fetch(
      new Request("https://nook.example.com/demo/__nook/kv/settings"),
      env,
    );
    expect(kvResponse.status).toBe(401);
    expect(await kvResponse.json()).toEqual({
      error: {
        code: "unauthorized",
        message: "Authentication required",
      },
    });
  });

  it("routes browser KV through the path-scoped site Durable Object", async () => {
    const siteFetch = vi.fn(async (request) => {
      const url = new URL(request.url);
      if (url.pathname === "/active") {
        return Response.json({
          deploymentId: "dep_1",
          public: true,
          files: [{ path: "/index.html", contentType: "text/html; charset=utf-8" }],
        });
      }
      if (url.pathname === "/kv/settings") {
        return Response.json({ value: { theme: "dark" } });
      }
      return Response.json({ error: { message: "unexpected" } }, { status: 404 });
    });

    const response = await worker.fetch(
      new Request("https://nook.example.com/demo/__nook/kv/settings"),
      {
        ASSETS: {},
        REGISTRY_DO: {
          idFromName: (name) => name,
          get: () => ({ fetch: vi.fn() }),
        },
        SITE_DO: {
          idFromName: (name) => name,
          get: () => ({ fetch: siteFetch }),
        },
        NOOK_DOMAIN: "nook.example.com",
        NOOK_ACCESS_TEAM_DOMAIN: "https://team.cloudflareaccess.com",
        NOOK_ACCESS_AUD: "aud",
      },
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ value: { theme: "dark" } });
    expect(siteFetch).toHaveBeenCalledWith(
      expect.objectContaining({ url: "https://site.local/kv/settings" }),
    );
  });
});

describe("nook setup cli parsing", () => {
  it("requires and normalizes Access validation inputs for setup", () => {
    expect(
      parseNookSetupInputs({
        argv: [
          "--domain",
          "HTTPS://NOOK.EXAMPLE.COM/",
          "--zone-name",
          "EXAMPLE.COM",
          "--access-team-domain",
          "https://team.cloudflareaccess.com/",
          "--access-aud",
          "aud",
        ],
      }),
    ).toEqual({
      domain: "nook.example.com",
      zoneName: "example.com",
      accessTeamDomain: "https://team.cloudflareaccess.com",
      accessAud: "aud",
      remaining: [],
    });
  });

  it("requires Access service-token inputs for destroy", () => {
    expect(
      parseNookDestroyInputs({
        argv: ["--domain", "nook.example.com", "--yes"],
        env: {
          NOOK_ACCESS_CLIENT_ID: "client-id",
          NOOK_ACCESS_CLIENT_SECRET: "client-secret",
        },
      }),
    ).toEqual({
      domain: "nook.example.com",
      accessClientId: "client-id",
      accessClientSecret: "client-secret",
      yes: true,
      remaining: [],
    });
  });

  it("rejects infrastructure domains with paths", () => {
    expect(() =>
      parseNookInfrastructureDomain({
        argv: ["--domain", "https://nook.example.com/path"],
      }),
    ).toThrow(/without a path/);
  });

  it("deploys from a self-contained wrangler project with an explicit R2 bucket", async () => {
    const root = await mkdtemp(join(tmpdir(), "tau-nook-wrangler-test-"));
    const binDir = join(root, "bin");
    mkdirSync(binDir);
    const npmPath = join(binDir, "npm");
    writeFileSync(
      npmPath,
      [
        "#!/usr/bin/env node",
        'import { mkdirSync, readFileSync, writeFileSync } from "node:fs";',
        'import { join } from "node:path";',
        'const packageJson = JSON.parse(readFileSync(join(process.cwd(), "package.json"), "utf-8"));',
        "if (!packageJson.private) process.exit(21);",
        'if (packageJson.type !== "module") process.exit(22);',
        "if (!packageJson.dependencies?.jose) process.exit(23);",
        'mkdirSync(join(process.cwd(), "node_modules", "jose"), { recursive: true });',
        'writeFileSync(join(process.cwd(), "node_modules", "jose", "package.json"), "{}");',
      ].join("\n"),
    );
    chmodSync(npmPath, 0o755);
    const wranglerPath = join(binDir, "wrangler");
    writeFileSync(
      wranglerPath,
      [
        "#!/usr/bin/env node",
        'import { existsSync, readFileSync } from "node:fs";',
        'import { join } from "node:path";',
        "const args = process.argv.slice(2);",
        'if (JSON.stringify(args) === JSON.stringify(["r2", "bucket", "info", "tau-nook-assets", "--json"])) {',
        '  if (process.env.NOOK_FAKE_BUCKET_ERROR === "1") {',
        '    console.error("authentication failed");',
        "    process.exit(1);",
        "  }",
        '  if (process.env.NOOK_FAKE_BUCKET_EXISTS === "1") {',
        '    console.log(JSON.stringify({ name: "tau-nook-assets", created: "2026-07-07T11:52:15.437Z", location: "EEUR", default_storage_class: "Standard", object_count: "1", bucket_size: "428 B" }));',
        "    process.exit(0);",
        "  }",
        '  console.error("The specified bucket does not exist. [code: 10007]");',
        "  process.exit(1);",
        "}",
        'if (JSON.stringify(args) === JSON.stringify(["r2", "bucket", "create", "tau-nook-assets"])) {',
        '  console.log("created tau-nook-assets remotely");',
        "  process.exit(0);",
        "}",
        'if (args[0] === "deploy") {',
        '  const config = JSON.parse(readFileSync(join(process.cwd(), "wrangler.json"), "utf-8"));',
        '  if (config.main !== "worker/index.js") process.exit(31);',
        '  if (JSON.stringify(config.routes) !== JSON.stringify([{ pattern: "nook.example.com/*", zone_name: "example.com" }])) process.exit(34);',
        '  if (!existsSync(join(process.cwd(), "worker", "index.js"))) process.exit(32);',
        '  if (!existsSync(join(process.cwd(), "node_modules", "jose", "package.json"))) process.exit(33);',
        '  console.log("wrangler deploy streamed output");',
        "}",
      ].join("\n"),
    );
    chmodSync(wranglerPath, 0o755);

    const outputLines = [];
    await runNookSetup({
      domain: "nook.example.com",
      zoneName: "example.com",
      accessTeamDomain: "https://team.cloudflareaccess.com",
      accessAud: "aud",
      env: {
        ...process.env,
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        CLOUDFLARE_API_TOKEN: "test-token",
      },
      stdout: (line) => outputLines.push(line),
    });

    expect(outputLines).toContain("created R2 bucket tau-nook-assets");
    expect(outputLines).toContain("wrangler deploy streamed output");
    expect(outputLines).toContain("  https://nook.example.com/__nook/*");
    expect(outputLines).toContain("  disable the Cookie Path Attribute");

    const existingOutputLines = [];
    await runNookSetup({
      domain: "nook.example.com",
      zoneName: "example.com",
      accessTeamDomain: "https://team.cloudflareaccess.com",
      accessAud: "aud",
      env: {
        ...process.env,
        NOOK_FAKE_BUCKET_EXISTS: "1",
        PATH: `${binDir}:${process.env.PATH ?? ""}`,
        CLOUDFLARE_API_TOKEN: "test-token",
      },
      stdout: (line) => existingOutputLines.push(line),
    });

    expect(existingOutputLines).toContain("R2 bucket tau-nook-assets already exists");
    expect(existingOutputLines).not.toContain("created R2 bucket tau-nook-assets");
    expect(existingOutputLines).toContain("wrangler deploy streamed output");

    const failingOutputLines = [];
    await expect(
      runNookSetup({
        domain: "nook.example.com",
        zoneName: "example.com",
        accessTeamDomain: "https://team.cloudflareaccess.com",
        accessAud: "aud",
        env: {
          ...process.env,
          NOOK_FAKE_BUCKET_ERROR: "1",
          PATH: `${binDir}:${process.env.PATH ?? ""}`,
          CLOUDFLARE_API_TOKEN: "test-token",
        },
        stdout: (line) => failingOutputLines.push(line),
      }),
    ).rejects.toThrow(/wrangler r2 bucket info tau-nook-assets failed/);
    expect(failingOutputLines).not.toContain("created R2 bucket tau-nook-assets");
    expect(failingOutputLines).not.toContain("wrangler deploy streamed output");
  });
});

function createNookToolBackend(entries = []) {
  return {
    dispose: vi.fn(),
    runBash: vi.fn(),
    runNodeScript: vi.fn(),
    readFile: vi.fn(),
    readFileBinary: vi.fn(async (path) => {
      const content = Buffer.from("<html></html>");
      return { path, content, bytes: content.byteLength };
    }),
    writeFile: vi.fn(async (path, content) => ({
      path,
      bytes: Buffer.byteLength(content),
      lines: content.split("\n").length,
    })),
    writeFileBinary: vi.fn(async (path, content) => ({ path, bytes: content.byteLength })),
    listDir: vi.fn(async (path) => ({ path, entries })),
  };
}

function createNookTool(backend, deps, config = { nook: { domain: "nook.example.com" } }) {
  return createNookToolDefinition(backend, config, deps);
}

async function runNookCode(tool, code, signal = new AbortController().signal) {
  return await runTool(
    tool,
    { type: "toolCall", id: "call_1", name: "nook", arguments: { code } },
    signal,
  );
}

function getToolText(result) {
  return result.toolResult.content.find((block) => block.type === "text")?.text ?? "";
}

describe("nook code-mode tool", () => {
  it("runs generated code in a capability-limited sandbox without exposing config", async () => {
    const backend = createNookToolBackend();
    const client = { readSkill: vi.fn(async () => "# Nook app skill") };
    const createClient = vi.fn(() => client);
    const tool = createNookTool(
      backend,
      { createClient },
      {
        nook: {
          domain: "nook.example.com",
          accessClientId: "client-id",
          accessClientSecret: "top-secret",
        },
      },
    );
    const result = await runNookCode(
      tool,
      [
        "console.log(typeof process, typeof fetch, typeof require, typeof _requestNook);",
        "console.log(typeof Date.now(), Number.isFinite(new Date().getTime()), Math.random() >= 0 && Math.random() < 1);",
        "const DerivedDate = new Date().constructor;",
        "console.log(DerivedDate === Date, Object.getPrototypeOf(new Date()) === Date.prototype, typeof DerivedDate(), new DerivedDate() instanceof Date, Object.isFrozen(Date), Object.isFrozen(Date.prototype));",
        "console.log('docs=' + docs.includes('nook.sites.deploy'));",
        "console.log('secret=' + docs.includes('top-secret'));",
        "console.log(await nook.skill());",
        "try { console.log.constructor('return process')(); } catch { console.log('escape blocked'); }",
        "return 'ignored';",
      ].join("\n"),
    );

    expect(result.uiEvent).toMatchObject({ type: "code_mode_finished", toolName: "nook" });
    expect(result.toolResult.outcome).toBe("succeeded");
    expect(getToolText(result)).toContain("undefined undefined undefined undefined");
    expect(getToolText(result)).toContain("number true true");
    expect(getToolText(result)).toContain("true true string true true true");
    expect(getToolText(result)).toContain("docs=true");
    expect(getToolText(result)).toContain("secret=false");
    expect(getToolText(result)).toContain("# Nook app skill");
    expect(getToolText(result)).toContain("escape blocked");
    expect(getToolText(result)).not.toContain("ignored");
    expect(client.readSkill).toHaveBeenCalledOnce();
    expect(createClient.mock.calls[0][0].signal).toBeInstanceOf(AbortSignal);
    expect(backend.runNodeScript).not.toHaveBeenCalled();
    expect(backend.runBash).not.toHaveBeenCalled();
  });

  it("composes facade calls and returns list values as arrays", async () => {
    const backend = createNookToolBackend();
    const client = {
      listSites: vi.fn(async () => [{ slug: "demo", url: "https://nook.example.com/demo" }]),
      listTemplates: vi.fn(async () => [{ name: "starter" }]),
      getKv: vi.fn(async () => ({ theme: "dark" })),
      putKv: vi.fn(async (site, key) => ({ site, key })),
      listKv: vi.fn(async (site) => ({
        site,
        keys: [{ key: "settings", sizeBytes: 16, updatedAt: "2026-07-30T00:00:00Z" }],
      })),
    };
    const tool = createNookTool(backend, { createClient: () => client });
    const result = await runNookCode(
      tool,
      [
        "const [sites, templates] = await Promise.all([nook.sites.list(), nook.templates.list()]);",
        "const settings = await nook.kv.get('demo', 'settings');",
        "const stored = await nook.kv.put('demo', 'next', { enabled: true });",
        "const keys = await nook.kv.list('demo', { prefix: 'set' });",
        "console.log(sites[0].slug, templates[0].name, settings.theme, stored.key, keys[0].key);",
      ].join("\n"),
    );

    expect(result.toolResult.outcome).toBe("succeeded");
    expect(getToolText(result)).toContain("demo starter dark next settings");
    expect(client.getKv).toHaveBeenCalledWith("demo", "settings");
    expect(client.putKv).toHaveBeenCalledWith("demo", "next", { enabled: true });
    expect(client.listKv).toHaveBeenCalledWith("demo", "set");
  });

  it("moves KV values between Nook and execution-environment files", async () => {
    const backend = createNookToolBackend();
    let fileContent = "";
    backend.writeFile.mockImplementation(async (path, content) => {
      fileContent = content;
      return { path, bytes: Buffer.byteLength(content), lines: 1 };
    });
    backend.readFileBinary.mockImplementation(async (path) => {
      const content = Buffer.from(fileContent);
      return { path, content, bytes: content.byteLength };
    });
    const client = {
      getKv: vi.fn(async () => ({ theme: "dark", density: 2 })),
      putKv: vi.fn(async (site, key) => ({ site, key })),
    };
    const tool = createNookTool(backend, { createClient: () => client });
    const result = await runNookCode(
      tool,
      [
        "const saved = await nook.kv.getToFile('demo', 'settings', '/tmp/settings.json');",
        "const stored = await nook.kv.putFromFile('demo', 'settings-copy', saved.file);",
        "console.log(saved.file, saved.bytes, stored.key);",
      ].join("\n"),
    );

    expect(result.toolResult.outcome).toBe("succeeded");
    expect(getToolText(result)).toContain("/tmp/settings.json 28 settings-copy");
    expect(fileContent).toBe('{"theme":"dark","density":2}');
    expect(backend.writeFile).toHaveBeenCalledWith(
      "/tmp/settings.json",
      '{"theme":"dark","density":2}',
    );
    expect(backend.readFileBinary).toHaveBeenCalledWith("/tmp/settings.json", {
      maxBytes: 64 * 1024,
    });
    expect(client.putKv).toHaveBeenCalledWith("demo", "settings-copy", {
      theme: "dark",
      density: 2,
    });
  });

  it("requires explicit visibility and validates deploy inputs before filesystem access", async () => {
    const backend = createNookToolBackend([
      { name: "index.html", isDirectory: false, isSymlink: false },
    ]);
    const client = {
      deploySite: vi.fn(async ({ site, visibility, files }) => ({
        site,
        url: `https://nook.example.com/${site}`,
        visibility,
        deploymentId: "dep_1",
        fileCount: files.length,
        byteCount: files[0].sizeBytes,
      })),
    };
    const tool = createNookTool(backend, { createClient: () => client });
    const result = await runNookCode(
      tool,
      [
        "for (const call of [",
        "  () => nook.sites.deploy('demo', '/tmp/dist'),",
        "  () => nook.sites.deploy('Demo', '/tmp/dist', { visibility: 'private' }),",
        "  () => nook.sites.deploy('demo', '/tmp/dist', { visibility: 'private', public: true }),",
        "]) {",
        "  try { await call(); } catch (error) { console.log(error.message); }",
        "}",
        "const deployed = await nook.sites.deploy('demo', '/tmp/dist', { visibility: 'public' });",
        "console.log(deployed.visibility);",
      ].join("\n"),
    );

    expect(result.toolResult.outcome).toBe("succeeded");
    expect(getToolText(result)).toContain("Invalid nook.sites.deploy arguments");
    expect(getToolText(result)).toContain("Site slug must be");
    expect(getToolText(result)).toContain('Unrecognized key: "public"');
    expect(getToolText(result)).toContain("public");
    expect(client.deploySite).toHaveBeenCalledOnce();
    expect(client.deploySite.mock.calls[0][0]).toMatchObject({
      site: "demo",
      visibility: "public",
    });
    expect(backend.listDir).toHaveBeenCalledOnce();
    expect(backend.readFileBinary).toHaveBeenCalledOnce();
  });

  it("rejects non-JSON KV values before crossing the bridge", async () => {
    const backend = createNookToolBackend();
    const client = { putKv: vi.fn() };
    const tool = createNookTool(backend, { createClient: () => client });
    const result = await runNookCode(
      tool,
      [
        "for (const value of [undefined, 1n, Infinity]) {",
        "  try { await nook.kv.put('demo', 'settings', value); } catch (error) { console.log(error.message); }",
        "}",
      ].join("\n"),
    );

    expect(result.toolResult.outcome).toBe("succeeded");
    expect(getToolText(result).match(/must be JSON-serializable values/g)).toHaveLength(3);
    expect(client.putKv).not.toHaveBeenCalled();
  });

  it("rejects a non-empty copy destination before downloading", async () => {
    const backend = createNookToolBackend([
      { name: "existing.txt", isDirectory: false, isSymlink: false },
    ]);
    const client = {
      getTemplateManifest: vi.fn(),
      downloadTemplateFiles: vi.fn(),
    };
    const tool = createNookTool(backend, { createClient: () => client });
    const result = await runNookCode(
      tool,
      "await nook.templates.copy('starter', '/workspace/app')",
    );

    expect(result.toolResult.outcome).toBe("failed");
    expect(getToolText(result)).toContain("template copy destination is not empty");
    expect(client.getTemplateManifest).not.toHaveBeenCalled();
    expect(client.downloadTemplateFiles).not.toHaveBeenCalled();
  });

  it("fails fast when Nook is not configured", async () => {
    const backend = createNookToolBackend();
    const tool = createNookTool(backend, undefined, {});
    const result = await runNookCode(
      tool,
      "await nook.sites.list()",
      new AbortController().signal,
      {},
    );

    expect(result.toolResult.outcome).toBe("blocked");
    expect(getToolText(result)).toContain("nook is not configured");
  });

  it("rejects unknown tool arguments without starting the sandbox", async () => {
    const backend = createNookToolBackend();
    const createClient = vi.fn();
    const tool = createNookTool(backend, { createClient });
    const result = await runTool(
      tool,
      {
        type: "toolCall",
        id: "call_1",
        name: "nook",
        arguments: { code: "console.log(docs)", operation: "list_sites" },
      },
      new AbortController().signal,
    );

    expect(result.toolResult.outcome).toBe("blocked");
    expect(getToolText(result)).toContain("Invalid arguments");
    expect(createClient).not.toHaveBeenCalled();
  });

  it("rejects bridge fan-out beyond the concurrent request budget", async () => {
    const backend = createNookToolBackend();
    const createClient = vi.fn(() => ({
      listSites: vi.fn(
        async () =>
          await new Promise((_resolve, reject) => {
            const signal = createClient.mock.calls[0][0].signal;
            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          }),
      ),
    }));
    const tool = createNookTool(backend, { createClient });
    const result = await runNookCode(
      tool,
      "await Promise.all(Array.from({ length: 5 }, () => nook.sites.list()))",
    );

    expect(result.toolResult.outcome).toBe("failed");
    expect(getToolText(result)).toContain("exceeded 4 concurrent bridge requests");
    expect(createClient).toHaveBeenCalledTimes(4);
  });

  it("rejects programs beyond the total bridge request budget", async () => {
    const backend = createNookToolBackend();
    const createClient = vi.fn(() => ({ listSites: vi.fn(async () => []) }));
    const tool = createNookTool(backend, { createClient });
    const result = await runNookCode(
      tool,
      "for (let index = 0; index < 65; index += 1) await nook.sites.list()",
    );

    expect(result.toolResult.outcome).toBe("failed");
    expect(getToolText(result)).toContain("exceeded 64 bridge requests");
    expect(createClient).toHaveBeenCalledTimes(64);
  });

  it("cancels and settles Nook requests before returning", async () => {
    const backend = createNookToolBackend();
    let markRequestStarted;
    const requestStarted = new Promise((resolve) => {
      markRequestStarted = resolve;
    });
    let requestSettled = false;
    const client = {
      listSites: vi.fn(
        async () =>
          await new Promise((_resolve, reject) => {
            const signal = createClient.mock.calls[0][0].signal;
            markRequestStarted();
            signal.addEventListener(
              "abort",
              () => {
                requestSettled = true;
                reject(signal.reason);
              },
              { once: true },
            );
          }),
      ),
    };
    const createClient = vi.fn(() => client);
    const tool = createNookTool(backend, { createClient });
    const controller = new AbortController();
    const run = runNookCode(tool, "await nook.sites.list()", controller.signal);

    await requestStarted;
    controller.abort();
    const result = await run;

    expect(requestSettled).toBe(true);
    expect(createClient.mock.calls[0][0].signal.aborted).toBe(true);
    expect(result.toolResult.outcome).toBe("cancelled");
    expect(getToolText(result)).toContain("(tau) aborted");
  });
});
