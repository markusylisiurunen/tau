import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { afterEach, describe, expect, it, vi } from "vitest";
import { getNookAccessClientSecret } from "../dist/core/config/index.js";
import {
  buildNookDeployManifest,
  normalizeNookAssetPath,
  validateNookManifest,
  validateNookSiteSlug,
} from "../dist/core/nook/index.js";
import {
  parseNookDestroyInputs,
  parseNookInfrastructureDomain,
  parseNookSetupInputs,
  runNookSetup,
} from "../dist/core/nook/setup.js";
import { createNookToolDefinition } from "../dist/core/tools/nook.js";
import worker, { cacheControlForDeployedAsset } from "../dist/nook/worker/index.js";

afterEach(() => {
  vi.restoreAllMocks();
});

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

describe("nook worker", () => {
  it("requires revalidation for deployed asset URLs that remain stable across deploys", () => {
    expect(cacheControlForDeployedAsset()).toBe("public, no-cache, must-revalidate");
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
