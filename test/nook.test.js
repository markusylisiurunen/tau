import { createHash } from "node:crypto";
import { chmodSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

  it("accepts Cloudflare Access JWTs verified with jose remote JWKS", async () => {
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
    const env = {
      ASSETS: {},
      REGISTRY_DO: {
        idFromName: (name) => name,
        get: () => ({ fetch: registryFetch }),
      },
      SITE_DO: {
        idFromName: (name) => name,
        get: () => ({ fetch: vi.fn() }),
      },
      NOOK_DOMAIN: "nook.example.com",
      NOOK_ACCESS_TEAM_DOMAIN: teamDomain,
      NOOK_ACCESS_AUD: audience,
    };

    const response = await worker.fetch(
      new Request("https://nook.example.com/__nook/api/sites", {
        headers: { "Cf-Access-Jwt-Assertion": token },
      }),
      env,
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ sites: [] });
    expect(registryFetch).toHaveBeenCalledOnce();
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

describe("nook tool", () => {
  const toolCall = {
    type: "toolCall",
    id: "call_1",
    name: "nook",
    arguments: { operation: "list_sites" },
  };

  it("requires read-write risk for every operation", async () => {
    const tool = createNookToolDefinition({});
    const result = await tool.dispatch(toolCall, "read-only", new AbortController().signal, {
      config: { nook: { domain: "nook.example.com" } },
    });

    expect(result.kind).toBe("single");
    expect(result.toolResult.isError).toBe(true);
    expect(result.toolResult.content[0].text).toContain("read-write");
  });

  it("fails fast when nook is not configured", async () => {
    const tool = createNookToolDefinition({});
    const result = await tool.dispatch(toolCall, "read-write", new AbortController().signal, {
      config: {},
    });

    expect(result.kind).toBe("single");
    expect(result.toolResult.isError).toBe(true);
    expect(result.toolResult.content[0].text).toContain("not configured");
  });

  it("rejects a non-empty template copy destination before downloading", async () => {
    const backend = {
      listDir: vi.fn(async () => ({
        path: "/workspace/app",
        entries: [{ name: "existing.txt", isDirectory: false, isSymlink: false }],
      })),
    };
    const fetchMock = vi.spyOn(globalThis, "fetch");
    const tool = createNookToolDefinition(backend);
    const result = await tool.dispatch(
      {
        type: "toolCall",
        id: "call_1",
        name: "nook",
        arguments: {
          operation: "copy_template",
          template: "starter",
          directory: "/workspace/app",
        },
      },
      "read-write",
      new AbortController().signal,
      { config: { nook: { domain: "nook.example.com" } } },
    );

    expect(result.kind).toBe("single");
    expect(result.toolResult.isError).toBe(true);
    expect(result.toolResult.content[0].text).toContain("not empty");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("requires a value for put_kv", async () => {
    const tool = createNookToolDefinition({});
    const result = await tool.dispatch(
      {
        type: "toolCall",
        id: "call_1",
        name: "nook",
        arguments: { operation: "put_kv", site: "demo", key: "settings" },
      },
      "read-write",
      new AbortController().signal,
      { config: { nook: { domain: "nook.example.com" } } },
    );

    expect(result.kind).toBe("single");
    expect(result.toolResult.isError).toBe(true);
    expect(result.toolResult.content[0].text).toContain("requires value");
  });
});
