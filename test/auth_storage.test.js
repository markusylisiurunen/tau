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
  it("rejects legacy auth.json formats", () => {
    const fx = createTempAuthPath();
    try {
      writeFileSync(
        fx.authPath,
        JSON.stringify({ "openai-codex": { type: "oauth", access: "x" } }, null, 2),
      );
      const storage = new AuthStorage(fx.authPath);
      expect(storage.getInvalidReason()).toBeDefined();
      expect(storage.getData().providers).toEqual({});
    } finally {
      fx.cleanup();
    }
  });

  it("filters invalid accounts from auth.json", () => {
    const fx = createTempAuthPath();
    try {
      writeFileSync(
        fx.authPath,
        JSON.stringify(
          {
            providers: {
              "openai-codex": {
                accounts: [
                  {
                    type: "oauth",
                    accountId: "acct-good",
                    access: "old-access",
                    refresh: "old-refresh",
                    expires: 0,
                    idToken: "header.payload.signature",
                  },
                  { type: "oauth", accountId: "bad" },
                ],
              },
            },
          },
          null,
          2,
        ),
      );

      const storage = new AuthStorage(fx.authPath);
      const accounts = storage.getData().providers["openai-codex"]?.accounts ?? [];
      expect(accounts.length).toBe(1);
      expect(accounts[0].accountId).toBe("acct-good");
    } finally {
      fx.cleanup();
    }
  });
});

describe("CredentialResolver", () => {
  it("uses codex auth accounts and persists refreshed credentials", async () => {
    const fx = createTempAuthPath();
    try {
      writeFileSync(
        fx.authPath,
        JSON.stringify(
          {
            providers: {
              "openai-codex": {
                accounts: [
                  {
                    type: "oauth",
                    accountId: "acct-old",
                    access: "old-access",
                    refresh: "old-refresh",
                    expires: 0,
                    idToken: "header.payload.signature",
                  },
                ],
              },
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
      const resolver = createCredentialResolver({
        authStorage: storage,
        getConfig: () => ({}),
      });

      const apiKey = await resolver.getApiKey("openai-codex", { sessionId: "session-1" });
      expect(apiKey).toBe("new-access");

      const saved = JSON.parse(readFileSync(fx.authPath, "utf-8"));
      const account = saved.providers["openai-codex"].accounts[0];
      expect(account.access).toBe("new-access");
      expect(account.refresh).toBe("new-refresh");
    } finally {
      fx.cleanup();
    }
  });

  it("prefers config apiKeys, then environment", async () => {
    const fx = createTempAuthPath();
    try {
      const storage = new AuthStorage(fx.authPath);
      const resolver = createCredentialResolver({
        authStorage: storage,
        getConfig: () => ({ apiKeys: { openai: "config-key" } }),
      });

      getEnvApiKey.mockReturnValue("env-key");
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
