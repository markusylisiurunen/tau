import { mkdirSync, writeFileSync } from "node:fs";
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
} from "../dist/core/nook/setup.js";
import { createNookToolDefinition } from "../dist/core/tools/nook.js";
import worker, { cacheControlForDeployedAsset } from "../dist/nook/worker/index.js";

afterEach(() => {
  vi.restoreAllMocks();
});

describe("nook validation", () => {
  it("accepts subdomain-safe slugs and rejects reserved or malformed slugs", () => {
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
});

describe("nook setup cli parsing", () => {
  it("requires and normalizes Access validation inputs for setup", () => {
    expect(
      parseNookSetupInputs({
        argv: [
          "--domain",
          "HTTPS://NOOK.EXAMPLE.COM/",
          "--access-team-domain",
          "https://team.cloudflareaccess.com/",
          "--access-aud",
          "aud",
        ],
      }),
    ).toEqual({
      domain: "nook.example.com",
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
