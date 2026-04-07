import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadRuntimeConfig } from "../dist/core/config/runtime.js";
import { createTokenCounter } from "../dist/core/utils/token_counting.js";

function createConfigDeps({ cwd, home, env }) {
  return {
    fs: {
      readFile: (path) => readFileSync(path, "utf-8"),
      exists: (path) => existsSync(path),
      listDir: (path) => readdirSync(path),
      stat: (path) => statSync(path),
    },
    env: {
      getEnv: () => env,
      cwd: () => cwd,
      home: () => home,
    },
  };
}

function setupFixture() {
  const home = mkdtempSync(join(tmpdir(), "tau-token-counting-home-"));
  const repo = mkdtempSync(join(tmpdir(), "tau-token-counting-repo-"));

  return {
    home: resolve(home),
    repo: resolve(repo),
    cleanup: () => {
      rmSync(home, { recursive: true, force: true });
      rmSync(repo, { recursive: true, force: true });
    },
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("token counting", () => {
  it("uses the existing heuristic backend uniformly", async () => {
    const counter = createTokenCounter({
      method: "heuristic",
      getAnthropicApiKey: async () => undefined,
    });

    expect(await counter.countTextTokens("123456789012")).toBe(2);

    const truncated = await counter.truncateTextToTokens("abcdefghijklmnopqrstuvwx", {
      maxTokens: 2,
      strategy: "head",
    });

    expect(truncated.truncated).toBe(true);
    expect(truncated.totalTokens).toBe(4);
    expect(truncated.outputTokens).toBe(2);
    expect(truncated.content.startsWith("abcdefghijkl")).toBe(true);
  });

  it("counts tokens through the Anthropic fetch endpoint", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_url, init) => {
        const payload = JSON.parse(init.body);
        const text = payload.messages[0].content;
        const inputTokens = 3 + text.length;
        return new Response(JSON.stringify({ input_tokens: inputTokens }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }),
    );

    const counter = createTokenCounter({
      method: "anthropic",
      getAnthropicApiKey: async () => "anthropic-key",
    });

    expect(await counter.countTextTokens("hello")).toBe(5);
  });

  it("reports a fatal runtime config error when anthropic token counting has no api key", async () => {
    const fx = setupFixture();
    const originalAnthropicApiKey = process.env.ANTHROPIC_API_KEY;

    try {
      mkdirSync(join(fx.repo, ".tau"), { recursive: true });
      writeFileSync(
        join(fx.repo, ".tau", "config.json"),
        JSON.stringify({ tokenCounting: "anthropic" }),
      );

      delete process.env.ANTHROPIC_API_KEY;

      const deps = createConfigDeps({
        cwd: fx.repo,
        home: fx.home,
        env: {},
      });
      const runtime = await loadRuntimeConfig(fx.repo, deps);

      expect(runtime.fatalErrors).toEqual([
        "tokenCounting 'anthropic' requires an Anthropic API key.",
      ]);
    } finally {
      if (originalAnthropicApiKey === undefined) {
        delete process.env.ANTHROPIC_API_KEY;
      } else {
        process.env.ANTHROPIC_API_KEY = originalAnthropicApiKey;
      }
      fx.cleanup();
    }
  });

  it("accepts anthropic token counting when the config provides an api key", async () => {
    const fx = setupFixture();

    try {
      mkdirSync(join(fx.repo, ".tau"), { recursive: true });
      writeFileSync(
        join(fx.repo, ".tau", "config.json"),
        JSON.stringify({
          tokenCounting: "anthropic",
          apiKeys: { anthropic: "config-anthropic-key" },
        }),
      );

      const deps = createConfigDeps({
        cwd: fx.repo,
        home: fx.home,
        env: {},
      });
      const runtime = await loadRuntimeConfig(fx.repo, deps);

      expect(runtime.fatalErrors).toEqual([]);
    } finally {
      fx.cleanup();
    }
  });
});
