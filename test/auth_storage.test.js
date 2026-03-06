import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@mariozechner/pi-ai/oauth", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    getOAuthApiKey: vi.fn(),
  };
});

vi.mock("@mariozechner/pi-ai", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    getEnvApiKey: vi.fn(),
  };
});

const { getOAuthApiKey } = await import("@mariozechner/pi-ai/oauth");
const { getEnvApiKey } = await import("@mariozechner/pi-ai");

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

afterEach(() => {
  vi.unstubAllGlobals();
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

  it("rejects auth.json when any account entry is invalid", () => {
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
      expect(storage.getInvalidReason()).toBeDefined();
      expect(storage.getData().providers).toEqual({});
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

  it("refreshes exhausted codex accounts before deciding failover candidates", async () => {
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
                    accountId: "acct-exhausted",
                    providerAccountId: "provider-exhausted",
                    access: "access-exhausted",
                    refresh: "refresh-exhausted",
                    expires: 0,
                    usage: {
                      windows: [
                        {
                          name: "primary",
                          usedPercent: 100,
                          resetAt: 4102444800,
                          windowSeconds: 3600,
                        },
                      ],
                    },
                  },
                  {
                    type: "oauth",
                    accountId: "acct-next",
                    providerAccountId: "provider-next",
                    access: "access-next",
                    refresh: "refresh-next",
                    expires: 0,
                    usage: {
                      windows: [
                        {
                          name: "primary",
                          usedPercent: 100,
                          resetAt: 4102444800,
                          windowSeconds: 3600,
                        },
                      ],
                    },
                  },
                ],
              },
            },
          },
          null,
          2,
        ),
      );

      getOAuthApiKey.mockImplementation(async (_provider, providers) => {
        const account = providers["openai-codex"];
        if (account.refresh === "refresh-exhausted") {
          return {
            apiKey: "api-exhausted",
            newCredentials: {
              access: account.access,
              refresh: account.refresh,
              expires: account.expires,
              accountId: account.accountId,
            },
          };
        }

        return {
          apiKey: "api-next",
          newCredentials: {
            access: account.access,
            refresh: account.refresh,
            expires: account.expires,
            accountId: account.accountId,
          },
        };
      });

      vi.stubGlobal(
        "fetch",
        vi.fn(async (_url, init) => {
          const rawHeaders = init?.headers;
          const accountId =
            rawHeaders instanceof Headers
              ? rawHeaders.get("ChatGPT-Account-Id")
              : rawHeaders && typeof rawHeaders === "object"
                ? rawHeaders["ChatGPT-Account-Id"]
                : undefined;
          const usedPercent = accountId === "provider-next" ? 12 : 100;
          return {
            ok: true,
            json: async () => ({
              rate_limit: {
                primary_window: {
                  used_percent: usedPercent,
                  reset_at: 4102444800,
                  limit_window_seconds: 3600,
                },
              },
            }),
          };
        }),
      );

      const storage = new AuthStorage(fx.authPath);
      const resolver = createCredentialResolver({
        authStorage: storage,
        getConfig: () => ({}),
      });

      const apiKey = await resolver.getApiKey("openai-codex", { sessionId: "session-1" });
      expect(apiKey).toBe("api-next");
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
