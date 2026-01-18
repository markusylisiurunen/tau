import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@mariozechner/pi-ai", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    getOAuthApiKey: vi.fn(),
    getEnvApiKey: vi.fn(),
  };
});

const { getOAuthApiKey, getEnvApiKey } = await import("@mariozechner/pi-ai");

import { AuthStorage } from "../dist/core/auth/auth_storage.js";
import { createCredentialResolver } from "../dist/core/auth/credential_resolver.js";

function createTempAuthPath() {
  const dir = mkdtempSync(join(tmpdir(), "tau-auth-"));
  return {
    dir,
    authPath: join(dir, "auth.json"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("AuthStorage", () => {
  it("reads and writes api key credentials", async () => {
    const fx = createTempAuthPath();
    try {
      writeFileSync(
        fx.authPath,
        JSON.stringify({ openai: { type: "api_key", key: "sk-test" } }, null, 2),
      );

      const storage = new AuthStorage(fx.authPath);
      expect(storage.get("openai").key).toBe("sk-test");
      expect(await storage.getApiKey("openai")).toBe("sk-test");

      storage.set("anthropic", { type: "api_key", key: "sk-ant" });
      const saved = JSON.parse(readFileSync(fx.authPath, "utf-8"));
      expect(saved.anthropic.key).toBe("sk-ant");
    } finally {
      fx.cleanup();
    }
  });

  it("refreshes oauth credentials and persists updates", async () => {
    const fx = createTempAuthPath();
    try {
      writeFileSync(
        fx.authPath,
        JSON.stringify(
          {
            "openai-codex": {
              type: "oauth",
              access: "old-access",
              refresh: "old-refresh",
              expires: 0,
              accountId: "acct-old",
            },
          },
          null,
          2,
        ),
      );

      getOAuthApiKey.mockResolvedValue({
        apiKey: "new-access",
        newCredentials: {
          access: "new-access",
          refresh: "new-refresh",
          expires: 999999,
          accountId: "acct-new",
        },
      });

      const storage = new AuthStorage(fx.authPath);
      const apiKey = await storage.getApiKey("openai-codex");
      expect(apiKey).toBe("new-access");

      const saved = JSON.parse(readFileSync(fx.authPath, "utf-8"));
      expect(saved["openai-codex"].access).toBe("new-access");
      expect(saved["openai-codex"].refresh).toBe("new-refresh");
    } finally {
      fx.cleanup();
    }
  });
});

describe("CredentialResolver", () => {
  it("prefers auth storage, then config, then environment", async () => {
    const fx = createTempAuthPath();
    try {
      const storage = new AuthStorage(fx.authPath);
      const resolver = createCredentialResolver({
        authStorage: storage,
        getConfig: () => ({ apiKeys: { openai: "config-key" } }),
      });

      getEnvApiKey.mockReturnValue("env-key");

      storage.set("openai", { type: "api_key", key: "auth-key" });
      expect(await resolver.getApiKey("openai")).toBe("auth-key");

      storage.remove("openai");
      expect(await resolver.getApiKey("openai")).toBe("config-key");

      const resolverNoConfig = createCredentialResolver({
        authStorage: storage,
        getConfig: () => ({}),
      });
      expect(await resolverNoConfig.getApiKey("openai")).toBe("env-key");
    } finally {
      fx.cleanup();
    }
  });
});
