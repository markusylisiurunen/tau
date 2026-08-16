import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { RemoteModelCatalog } from "../dist/core/models/remote_catalog.js";
import { PI_AI_VERSION } from "../dist/core/version.js";

function model(provider, id, overrides = {}) {
  return {
    id,
    name: id,
    api: "openai-responses",
    provider,
    baseUrl: "https://models.example/v1",
    reasoning: true,
    input: ["text"],
    cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 0 },
    contextWindow: 100000,
    maxTokens: 10000,
    ...overrides,
  };
}

function catalogResponse(provider, id, options = {}) {
  return new Response(JSON.stringify({ [id]: model(provider, id, options.modelOverrides) }), {
    status: 200,
    headers: {
      "content-type": "application/json",
      "last-modified": options.lastModified ?? "Wed, 01 Jan 2026 00:00:00 GMT",
      etag: options.etag ?? '"catalog-v1"',
    },
  });
}

describe("remote model catalog", () => {
  it("persists successful providers when another provider fails", async () => {
    const home = mkdtempSync(join(tmpdir(), "tau-remote-model-catalog-"));
    const path = join(home, "models-store.json");
    try {
      const catalog = new RemoteModelCatalog({
        path,
        providerIds: ["openai", "anthropic"],
        builtinGeneratedAt: 0,
        fetch: vi.fn(async (url) => {
          const provider = new URL(url).pathname.split("/").at(-1);
          if (provider === "anthropic") throw new Error("unavailable");
          return catalogResponse("openai", "remote-openai");
        }),
      });

      const result = await catalog.refresh({ force: true });

      expect(result.providers.get("openai")).toEqual({ status: "updated", modelCount: 1 });
      expect(result.providers.get("anthropic")).toMatchObject({
        status: "failed",
        error: { message: "unavailable" },
      });
      expect(result.snapshot.get("openai")?.map((entry) => entry.id)).toEqual(["remote-openai"]);
      expect(result.snapshot.has("anthropic")).toBe(false);
      expect(JSON.parse(readFileSync(path, "utf8")).providers.openai.models).toHaveLength(1);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("accepts Pi catalog endpoint and sentinel pricing values", async () => {
    const home = mkdtempSync(join(tmpdir(), "tau-remote-model-catalog-"));
    try {
      const catalog = new RemoteModelCatalog({
        path: join(home, "models-store.json"),
        providerIds: ["azure-openai-responses", "openrouter"],
        builtinGeneratedAt: 0,
        fetch: vi.fn(async (url) => {
          const provider = new URL(url).pathname.split("/").at(-1);
          return provider === "azure-openai-responses"
            ? catalogResponse(provider, "gpt-4", { modelOverrides: { baseUrl: "" } })
            : catalogResponse(provider, "openrouter/auto", {
                modelOverrides: {
                  cost: {
                    input: -1000000,
                    output: -1000000,
                    cacheRead: 0,
                    cacheWrite: 0,
                  },
                },
              });
        }),
      });

      const result = await catalog.refresh({ force: true });

      expect(result.providers.get("azure-openai-responses")?.status).toBe("updated");
      expect(result.providers.get("openrouter")?.status).toBe("updated");
      expect(result.snapshot.get("azure-openai-responses")?.[0].baseUrl).toBe("");
      expect(result.snapshot.get("openrouter")?.[0].cost.input).toBe(-1000000);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("uses the freshness window and conditionally revalidates cached shards", async () => {
    const home = mkdtempSync(join(tmpdir(), "tau-remote-model-catalog-"));
    const path = join(home, "models-store.json");
    let now = Date.parse("2026-01-02T00:00:00.000Z");
    try {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(catalogResponse("openai", "remote-openai"))
        .mockResolvedValueOnce(new Response(null, { status: 304 }));
      const catalog = new RemoteModelCatalog({
        path,
        providerIds: ["openai"],
        builtinGeneratedAt: 0,
        now: () => now,
        fetch: fetchMock,
      });

      await catalog.refresh({ force: true });
      expect(fetchMock.mock.calls[0][1].headers["User-Agent"]).toMatch(
        new RegExp(`^pi/${PI_AI_VERSION.replaceAll(".", "\\.")} `),
      );
      const fresh = await catalog.refresh();
      expect(fresh.providers.get("openai")).toEqual({ status: "fresh", modelCount: 1 });
      expect(fetchMock).toHaveBeenCalledTimes(1);

      now += 5 * 60 * 60 * 1000;
      const revalidated = await catalog.refresh();
      expect(revalidated.providers.get("openai")).toEqual({
        status: "unchanged",
        modelCount: 1,
      });
      expect(fetchMock.mock.calls[1][1].headers["If-None-Match"]).toBe('"catalog-v1"');
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("times out one provider without cancelling successful providers", async () => {
    const home = mkdtempSync(join(tmpdir(), "tau-remote-model-catalog-"));
    try {
      const catalog = new RemoteModelCatalog({
        path: join(home, "models-store.json"),
        providerIds: ["openai", "anthropic"],
        builtinGeneratedAt: 0,
        requestTimeoutMs: 20,
        fetch: vi.fn(async (url, options) => {
          const provider = new URL(url).pathname.split("/").at(-1);
          if (provider === "openai") {
            return await new Promise((_resolve, reject) => {
              options.signal.addEventListener("abort", () => reject(options.signal.reason), {
                once: true,
              });
            });
          }
          return catalogResponse("anthropic", "remote-anthropic");
        }),
      });

      const result = await catalog.refresh({ force: true });

      expect(result.providers.get("openai")?.status).toBe("failed");
      expect(result.providers.get("anthropic")).toEqual({ status: "updated", modelCount: 1 });
      expect(result.snapshot.get("anthropic")?.[0].id).toBe("remote-anthropic");
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("shares an active refresh between catalog instances for the same store", async () => {
    const home = mkdtempSync(join(tmpdir(), "tau-remote-model-catalog-"));
    let resolveFetch;
    const response = new Promise((resolve) => {
      resolveFetch = resolve;
    });
    try {
      const fetchMock = vi.fn(async () => await response);
      const options = {
        path: join(home, "models-store.json"),
        providerIds: ["openai"],
        builtinGeneratedAt: 0,
        fetch: fetchMock,
      };
      const first = new RemoteModelCatalog(options);
      const second = new RemoteModelCatalog(options);

      const firstRefresh = first.refresh({ force: true });
      const secondRefresh = second.refresh({ force: true });
      resolveFetch(catalogResponse("openai", "remote-openai"));

      await expect(firstRefresh).resolves.toEqual(await secondRefresh);
      expect(fetchMock).toHaveBeenCalledOnce();
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });

  it("does not let an older remote shard override newer bundled model data", async () => {
    const home = mkdtempSync(join(tmpdir(), "tau-remote-model-catalog-"));
    try {
      const catalog = new RemoteModelCatalog({
        path: join(home, "models-store.json"),
        providerIds: ["openai"],
        builtinGeneratedAt: Date.parse("2026-02-01T00:00:00.000Z"),
        fetch: vi.fn(async () =>
          catalogResponse("openai", "remote-openai", {
            lastModified: "Thu, 01 Jan 2026 00:00:00 GMT",
          }),
        ),
      });

      const result = await catalog.refresh({ force: true });

      expect(result.providers.get("openai")).toEqual({ status: "updated", modelCount: 1 });
      expect(result.snapshot.has("openai")).toBe(false);
      expect(catalog.snapshot().has("openai")).toBe(false);
    } finally {
      rmSync(home, { recursive: true, force: true });
    }
  });
});
