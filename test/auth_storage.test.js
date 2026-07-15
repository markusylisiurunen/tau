import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@earendil-works/pi-ai/oauth", async (importOriginal) => {
  const actual = await importOriginal();
  return {
    ...actual,
    getOAuthApiKey: vi.fn(),
    refreshOpenAICodexToken: vi.fn(),
  };
});

const { getOAuthApiKey, refreshOpenAICodexToken } = await import("@earendil-works/pi-ai/oauth");

import { AuthManager } from "../dist/core/auth/auth_manager.js";
import { AuthStorage } from "../dist/core/auth/auth_storage.js";
import { TauCredentialStore } from "../dist/core/auth/credential_store.js";

function toBase64Url(value) {
  return Buffer.from(value, "utf-8")
    .toString("base64")
    .replace(/=+$/g, "")
    .replace(/\+/g, "-")
    .replace(/\//g, "_");
}

function createAccessToken({ accountId, email, plan }) {
  const header = toBase64Url(JSON.stringify({ alg: "none", typ: "JWT" }));
  const payload = toBase64Url(
    JSON.stringify({
      "https://api.openai.com/auth": {
        chatgpt_account_id: accountId,
        chatgpt_plan_type: plan,
      },
      "https://api.openai.com/profile": {
        email,
      },
    }),
  );
  return `${header}.${payload}.sig`;
}

function createTempAuthPath() {
  const dir = mkdtempSync(join(tmpdir(), "tau-auth-"));
  return {
    dir,
    authPath: join(dir, "auth.json"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((promiseResolve, promiseReject) => {
    resolve = promiseResolve;
    reject = promiseReject;
  });
  return { promise, resolve, reject };
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

  it("enforces owner-only permissions before reading auth storage", () => {
    const fx = createTempAuthPath();
    try {
      writeFileSync(fx.authPath, JSON.stringify({ providers: {} }), { mode: 0o644 });
      chmodSync(fx.dir, 0o755);
      chmodSync(fx.authPath, 0o644);

      const storage = new AuthStorage(fx.authPath);

      expect(storage.getInvalidReason()).toBeUndefined();
      expect(statSync(fx.dir).mode & 0o777).toBe(0o700);
      expect(statSync(fx.authPath).mode & 0o777).toBe(0o600);
    } finally {
      fx.cleanup();
    }
  });

  it("rejects auth storage not owned by the current user before reading it", () => {
    const fx = createTempAuthPath();
    const getuid = vi.spyOn(process, "getuid").mockReturnValue(process.getuid() + 1);
    try {
      writeFileSync(fx.authPath, JSON.stringify({ providers: {} }), { mode: 0o600 });

      const storage = new AuthStorage(fx.authPath);

      expect(storage.getInvalidReason()).toContain(
        "auth storage directory is not owned by the current user",
      );
    } finally {
      getuid.mockRestore();
      fx.cleanup();
    }
  });

  it("rejects symlinked auth storage before reading it", () => {
    const fx = createTempAuthPath();
    try {
      const targetPath = join(fx.dir, "target.json");
      writeFileSync(targetPath, JSON.stringify({ providers: {} }), { mode: 0o600 });
      symlinkSync(targetPath, fx.authPath);

      const storage = new AuthStorage(fx.authPath);

      expect(storage.getInvalidReason()).toContain("auth storage file is not a regular file");
      expect(lstatSync(fx.authPath).isSymbolicLink()).toBe(true);
    } finally {
      fx.cleanup();
    }
  });

  it("cleans stale auth temporaries during initialization and mutation", () => {
    const fx = createTempAuthPath();
    try {
      const startupTemp = join(fx.dir, "auth.json.00000000-0000-4000-8000-000000000001.tmp");
      writeFileSync(startupTemp, "stale", { mode: 0o600 });
      const storage = new AuthStorage(fx.authPath);
      expect(() => lstatSync(startupTemp)).toThrow(expect.objectContaining({ code: "ENOENT" }));

      const mutationTemp = join(fx.dir, "auth.json.00000000-0000-4000-8000-000000000002.tmp");
      writeFileSync(mutationTemp, "stale", { mode: 0o600 });
      storage.update((data) => {
        data.providers = {};
      });
      expect(() => lstatSync(mutationTemp)).toThrow(expect.objectContaining({ code: "ENOENT" }));
    } finally {
      fx.cleanup();
    }
  });

  it("recovers an auth lock owned by a process that no longer exists", () => {
    const fx = createTempAuthPath();
    try {
      const lockPath = `${fx.authPath}.lock`;
      mkdirSync(lockPath);
      writeFileSync(
        join(lockPath, "owner.json"),
        JSON.stringify({ pid: 2_147_483_647, token: "stale-owner", createdAt: 1 }),
        { mode: 0o600 },
      );

      const storage = new AuthStorage(fx.authPath);
      storage.update((data) => {
        data.providers = {};
      });

      expect(storage.getInvalidReason()).toBeUndefined();
      expect(() => lstatSync(lockPath)).toThrow(expect.objectContaining({ code: "ENOENT" }));
    } finally {
      fx.cleanup();
    }
  });
});

describe("AuthManager and TauCredentialStore", () => {
  it("does not restore an account removed during an in-flight refresh", async () => {
    const fx = createTempAuthPath();
    try {
      const originalAccess = createAccessToken({
        accountId: "acct-race",
        email: "user@example.com",
        plan: "plus",
      });
      const refreshedAccess = createAccessToken({
        accountId: "acct-race",
        email: "user@example.com",
        plan: "pro",
      });
      writeFileSync(
        fx.authPath,
        JSON.stringify({
          providers: {
            "openai-codex": {
              accounts: [
                {
                  type: "oauth",
                  accountId: "acct-race",
                  providerAccountId: "acct-race",
                  access: originalAccess,
                  refresh: "refresh-race",
                  expires: 1,
                },
              ],
            },
          },
        }),
        { mode: 0o600 },
      );
      const refreshStarted = deferred();
      const releaseRefresh = deferred();
      refreshOpenAICodexToken.mockImplementation(async () => {
        refreshStarted.resolve();
        return await releaseRefresh.promise;
      });

      const listingStorage = new AuthStorage(fx.authPath);
      const listing = new AuthManager(listingStorage).listProviderAccounts();
      await refreshStarted.promise;

      const logoutStorage = new AuthStorage(fx.authPath);
      new AuthManager(logoutStorage).removeAccount("openai-codex", "acct-race");
      releaseRefresh.resolve({
        access: refreshedAccess,
        refresh: "refresh-race-next",
        expires: Number.MAX_SAFE_INTEGER,
        accountId: "acct-race",
      });

      await expect(listing).resolves.toEqual([]);
      const saved = JSON.parse(readFileSync(fx.authPath, "utf8"));
      expect(saved.providers["openai-codex"].accounts).toEqual([]);
    } finally {
      fx.cleanup();
    }
  });

  it("does not let credential-store refresh restore a deleted account", async () => {
    const fx = createTempAuthPath();
    try {
      writeFileSync(
        fx.authPath,
        JSON.stringify({
          providers: {
            "openai-codex": {
              accounts: [
                {
                  type: "oauth",
                  accountId: "acct-modify-race",
                  providerAccountId: "acct-modify-race",
                  access: "access-original",
                  refresh: "refresh-original",
                  expires: 1,
                },
              ],
            },
          },
        }),
        { mode: 0o600 },
      );
      getOAuthApiKey.mockImplementation(async (_provider, providers) => ({
        apiKey: providers["openai-codex"].access,
        newCredentials: providers["openai-codex"],
      }));
      const refreshStarted = deferred();
      const releaseRefresh = deferred();
      const store = new TauCredentialStore({
        authStorage: new AuthStorage(fx.authPath),
        getConfig: () => ({}),
      });
      const refresh = store.modify("openai-codex", async (current) => {
        refreshStarted.resolve();
        await releaseRefresh.promise;
        return {
          ...current,
          access: "access-refreshed",
          refresh: "refresh-refreshed",
          expires: 100,
        };
      });
      await refreshStarted.promise;

      const logoutStorage = new AuthStorage(fx.authPath);
      new AuthManager(logoutStorage).removeAccount("openai-codex", "acct-modify-race");
      releaseRefresh.resolve();

      await expect(refresh).resolves.toBeUndefined();
      const saved = JSON.parse(readFileSync(fx.authPath, "utf8"));
      expect(saved.providers["openai-codex"].accounts).toEqual([]);
    } finally {
      fx.cleanup();
    }
  });

  it("does not let a later parallel refresh overwrite a newer credential generation", async () => {
    const fx = createTempAuthPath();
    try {
      writeFileSync(
        fx.authPath,
        JSON.stringify({
          providers: {
            "openai-codex": {
              accounts: [
                {
                  type: "oauth",
                  accountId: "acct-parallel",
                  providerAccountId: "acct-parallel",
                  access: "access-original",
                  refresh: "refresh-original",
                  expires: 1,
                },
              ],
            },
          },
        }),
        { mode: 0o600 },
      );
      const bothRefreshesStarted = deferred();
      const refreshes = [deferred(), deferred()];
      let refreshCallCount = 0;
      getOAuthApiKey.mockImplementation(async () => {
        const callIndex = refreshCallCount++;
        if (refreshCallCount === 2) {
          bothRefreshesStarted.resolve();
        }
        return await refreshes[callIndex].promise;
      });

      const firstRead = new TauCredentialStore({
        authStorage: new AuthStorage(fx.authPath),
        getConfig: () => ({}),
      }).read("openai-codex");
      const secondRead = new TauCredentialStore({
        authStorage: new AuthStorage(fx.authPath),
        getConfig: () => ({}),
      }).read("openai-codex");
      await bothRefreshesStarted.promise;

      refreshes[0].resolve({
        apiKey: "api-newer",
        newCredentials: {
          access: "access-newer",
          refresh: "refresh-newer",
          expires: 100,
          accountId: "acct-parallel",
        },
      });
      await expect(firstRead).resolves.toMatchObject({
        type: "oauth",
        access: "access-newer",
        refresh: "refresh-newer",
      });

      refreshes[1].resolve({
        apiKey: "api-stale",
        newCredentials: {
          access: "access-stale",
          refresh: "refresh-stale",
          expires: 200,
          accountId: "acct-parallel",
        },
      });
      await expect(secondRead).resolves.toBeUndefined();

      const saved = JSON.parse(readFileSync(fx.authPath, "utf8"));
      expect(saved.providers["openai-codex"].accounts[0]).toMatchObject({
        access: "access-newer",
        refresh: "refresh-newer",
        expires: 100,
      });
    } finally {
      fx.cleanup();
    }
  });

  it("refreshes codex account identity before listing plans", async () => {
    const fx = createTempAuthPath();
    try {
      const originalAccess = createAccessToken({
        accountId: "acct-plan",
        email: "user@example.com",
        plan: "plus",
      });
      const refreshedAccess = createAccessToken({
        accountId: "acct-plan",
        email: "user@example.com",
        plan: "pro",
      });
      writeFileSync(
        fx.authPath,
        JSON.stringify(
          {
            providers: {
              "openai-codex": {
                accounts: [
                  {
                    type: "oauth",
                    accountId: "acct-plan",
                    providerAccountId: "acct-plan",
                    access: originalAccess,
                    refresh: "refresh-plan",
                    expires: Number.MAX_SAFE_INTEGER,
                  },
                ],
              },
            },
          },
          null,
          2,
        ),
      );

      refreshOpenAICodexToken.mockResolvedValue({
        access: refreshedAccess,
        refresh: "refresh-plan-next",
        expires: Number.MAX_SAFE_INTEGER,
        accountId: "acct-plan",
      });
      getOAuthApiKey.mockImplementation(async (_provider, providers) => ({
        apiKey: providers["openai-codex"].access,
        newCredentials: providers["openai-codex"],
      }));
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => ({
          ok: true,
          json: async () => ({
            rate_limit: {
              primary_window: {
                used_percent: 12,
                reset_at: 4102444800,
                limit_window_seconds: 18000,
              },
            },
          }),
        })),
      );

      const storage = new AuthStorage(fx.authPath);
      const authManager = new AuthManager(storage);

      const providers = await authManager.listProviderAccounts();
      expect(providers[0]?.accounts[0]?.plan).toBe("pro");

      const saved = JSON.parse(readFileSync(fx.authPath, "utf-8"));
      const account = saved.providers["openai-codex"].accounts[0];
      expect(account.access).toBe(refreshedAccess);
      expect(account.refresh).toBe("refresh-plan-next");
    } finally {
      fx.cleanup();
    }
  });

  it("uses codex failover selection in pi-ai credential store", async () => {
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
                          windowSeconds: 18000,
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
                          windowSeconds: 18000,
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
        return {
          apiKey: account.refresh === "refresh-exhausted" ? "api-exhausted" : "api-next",
          newCredentials: account,
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
                  limit_window_seconds: 18000,
                },
              },
            }),
          };
        }),
      );

      const storage = new AuthStorage(fx.authPath);
      const store = new TauCredentialStore({ authStorage: storage, getConfig: () => ({}) });
      const credential = await store.read("openai-codex");

      expect(credential?.type).toBe("oauth");
      expect(credential?.refresh).toBe("refresh-next");
    } finally {
      fx.cleanup();
    }
  });

  it("matches forced codex accounts by email in pi-ai credential store", async () => {
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
                    accountId: "acct-email",
                    providerAccountId: "provider-email",
                    access: createAccessToken({
                      accountId: "acct-email",
                      email: "user@example.com",
                      plan: "plus",
                    }),
                    refresh: "refresh-email",
                    expires: Number.MAX_SAFE_INTEGER,
                  },
                ],
              },
            },
          },
          null,
          2,
        ),
      );

      const storage = new AuthStorage(fx.authPath);
      const store = new TauCredentialStore({
        authStorage: storage,
        getConfig: () => ({}),
        env: { TAU_CODEX_ACCOUNT: "user@example.com" },
      });
      const credential = await store.read("openai-codex");

      expect(credential?.type).toBe("oauth");
      expect(credential?.refresh).toBe("refresh-email");
    } finally {
      fx.cleanup();
    }
  });

  it("keeps codex account selection sticky per model runtime session", async () => {
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
                    accountId: "acct-a",
                    providerAccountId: "provider-a",
                    access: "access-a",
                    refresh: "refresh-a",
                    expires: Number.MAX_SAFE_INTEGER,
                    usage: {
                      windows: [
                        {
                          name: "primary",
                          usedPercent: 80,
                          resetAt: 4102444800,
                          windowSeconds: 18000,
                        },
                      ],
                    },
                  },
                  {
                    type: "oauth",
                    accountId: "acct-b",
                    providerAccountId: "provider-b",
                    access: "access-b",
                    refresh: "refresh-b",
                    expires: Number.MAX_SAFE_INTEGER,
                    usage: {
                      windows: [
                        {
                          name: "primary",
                          usedPercent: 10,
                          resetAt: 4102444800,
                          windowSeconds: 18000,
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

      getOAuthApiKey.mockImplementation(async (_provider, providers) => ({
        apiKey: providers["openai-codex"].access,
        newCredentials: providers["openai-codex"],
      }));

      let sessionId = "session-1";
      const storage = new AuthStorage(fx.authPath);
      const store = new TauCredentialStore({
        authStorage: storage,
        getConfig: () => ({}),
        getSessionId: () => sessionId,
      });

      const first = await store.read("openai-codex");
      expect(first?.type).toBe("oauth");
      expect(first?.refresh).toBe("refresh-a");

      storage.update((data) => {
        const accounts = data.providers["openai-codex"].accounts;
        accounts[0].usage.windows[0].usedPercent = 20;
        accounts[1].usage.windows[0].usedPercent = 90;
      });

      const sameSession = await store.read("openai-codex");
      expect(sameSession?.type).toBe("oauth");
      expect(sameSession?.refresh).toBe("refresh-a");

      sessionId = "session-2";
      const nextSession = await store.read("openai-codex");
      expect(nextSession?.type).toBe("oauth");
      expect(nextSession?.refresh).toBe("refresh-b");
    } finally {
      fx.cleanup();
    }
  });

  it("clears sticky codex account selection after exhausted-account provider errors", async () => {
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
                    accountId: "acct-a",
                    providerAccountId: "provider-a",
                    access: "access-a",
                    refresh: "refresh-a",
                    expires: Number.MAX_SAFE_INTEGER,
                    usage: {
                      windows: [
                        {
                          name: "primary",
                          usedPercent: 80,
                          resetAt: 4102444800,
                          windowSeconds: 18000,
                        },
                      ],
                    },
                  },
                  {
                    type: "oauth",
                    accountId: "acct-b",
                    providerAccountId: "provider-b",
                    access: "access-b",
                    refresh: "refresh-b",
                    expires: Number.MAX_SAFE_INTEGER,
                    usage: {
                      windows: [
                        {
                          name: "primary",
                          usedPercent: 10,
                          resetAt: 4102444800,
                          windowSeconds: 18000,
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

      getOAuthApiKey.mockImplementation(async (_provider, providers) => ({
        apiKey: providers["openai-codex"].access,
        newCredentials: providers["openai-codex"],
      }));
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
          return {
            ok: true,
            json: async () => ({
              rate_limit: {
                primary_window: {
                  used_percent: accountId === "provider-a" ? 100 : 10,
                  reset_at: 4102444800,
                  limit_window_seconds: 18000,
                },
              },
            }),
          };
        }),
      );

      const storage = new AuthStorage(fx.authPath);
      const store = new TauCredentialStore({
        authStorage: storage,
        getConfig: () => ({}),
        getSessionId: () => "session-1",
      });

      const first = await store.read("openai-codex");
      expect(first?.type).toBe("oauth");
      expect(first?.refresh).toBe("refresh-a");

      await store.noteProviderError("openai-codex", {
        sessionId: "session-1",
        error: new Error("quota exceeded"),
      });

      const afterError = await store.read("openai-codex");
      expect(afterError?.type).toBe("oauth");
      expect(afterError?.refresh).toBe("refresh-b");
    } finally {
      fx.cleanup();
    }
  });

  it("fails early when codex usage windows change unexpectedly", async () => {
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
                    providerAccountId: "provider-old",
                    access: "old-access",
                    refresh: "old-refresh",
                    expires: 0,
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
          access: "old-access",
          refresh: "old-refresh",
          expires: 0,
          accountId: "provider-old",
        },
      });

      vi.stubGlobal(
        "fetch",
        vi.fn(async () => ({
          ok: true,
          json: async () => ({
            rate_limit: {
              primary_window: {
                used_percent: 12,
                reset_at: 4102444800,
                limit_window_seconds: 3600,
              },
            },
          }),
        })),
      );

      const storage = new AuthStorage(fx.authPath);
      const store = new TauCredentialStore({ authStorage: storage, getConfig: () => ({}) });

      await expect(store.read("openai-codex")).rejects.toThrow(
        "unexpected ChatGPT Codex primary usage window: 3600 seconds (expected 18000 for 5h or 604800 for 7d)",
      );
    } finally {
      fx.cleanup();
    }
  });
});
