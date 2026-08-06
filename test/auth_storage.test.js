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

const { codexLogin, codexRefresh, codexToAuth } = vi.hoisted(() => ({
  codexLogin: vi.fn(),
  codexRefresh: vi.fn(),
  codexToAuth: vi.fn(),
}));

vi.mock("@earendil-works/pi-ai/providers/openai-codex", () => ({
  openaiCodexProvider: () => ({
    auth: {
      oauth: {
        login: codexLogin,
        refresh: codexRefresh,
        toAuth: codexToAuth,
      },
    },
  }),
}));

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
  codexLogin.mockReset();
  codexRefresh.mockReset().mockImplementation(async (credential) => credential);
  codexToAuth.mockReset().mockImplementation(async (credential) => ({
    apiKey: credential.access,
  }));
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

  it("defaults existing OAuth accounts to enabled", () => {
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
                  accountId: "acct-existing",
                  access: "existing-access",
                  refresh: "existing-refresh",
                  expires: 1,
                },
              ],
            },
          },
        }),
      );

      const storage = new AuthStorage(fx.authPath);

      expect(storage.getInvalidReason()).toBeUndefined();
      expect(storage.getData().providers["openai-codex"].accounts[0].disabled).toBe(false);
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

  it("enforces owner-only permissions under a restrictive umask", () => {
    const fx = createTempAuthPath();
    try {
      writeFileSync(fx.authPath, JSON.stringify({ providers: {} }), { mode: 0o644 });
      chmodSync(fx.dir, 0o755);
      chmodSync(fx.authPath, 0o644);

      const previousUmask = process.umask(0o777);
      let storage;
      try {
        storage = new AuthStorage(fx.authPath);
        storage.update((data) => {
          data.providers = {};
        });
      } finally {
        process.umask(previousUmask);
      }

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
      codexRefresh.mockImplementation(async () => {
        refreshStarted.resolve();
        return await releaseRefresh.promise;
      });

      const listingStorage = new AuthStorage(fx.authPath);
      const listing = new AuthManager(listingStorage).listProviderAccounts();
      await refreshStarted.promise;

      const logoutStorage = new AuthStorage(fx.authPath);
      new AuthManager(logoutStorage).removeAccount("openai-codex", "acct-race");
      releaseRefresh.resolve({
        type: "oauth",
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
      codexRefresh.mockImplementation(async () => {
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
        type: "oauth",
        access: "access-newer",
        refresh: "refresh-newer",
        expires: 100,
        accountId: "acct-parallel",
      });
      await expect(firstRead).resolves.toMatchObject({
        type: "oauth",
        access: "access-newer",
        refresh: "refresh-newer",
      });

      refreshes[1].resolve({
        type: "oauth",
        access: "access-stale",
        refresh: "refresh-stale",
        expires: 200,
        accountId: "acct-parallel",
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

      codexRefresh.mockResolvedValue({
        type: "oauth",
        access: refreshedAccess,
        refresh: "refresh-plan-next",
        expires: Number.MAX_SAFE_INTEGER,
        accountId: "acct-plan",
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
                limit_window_seconds: 18000,
              },
            },
          }),
        })),
      );

      const storage = new AuthStorage(fx.authPath);
      const authManager = new AuthManager(storage);

      const providers = await authManager.listProviderAccounts();
      expect(providers[0]?.accounts[0]).toMatchObject({
        plan: "pro",
        credentialExpired: false,
        credentialRefreshStatus: "succeeded",
        usageRefreshStatus: "succeeded",
      });

      const saved = JSON.parse(readFileSync(fx.authPath, "utf-8"));
      const account = saved.providers["openai-codex"].accounts[0];
      expect(account.access).toBe(refreshedAccess);
      expect(account.refresh).toBe("refresh-plan-next");
    } finally {
      fx.cleanup();
    }
  });

  it("reports stale codex account data when listing refreshes fail", async () => {
    const fx = createTempAuthPath();
    try {
      const access = createAccessToken({
        accountId: "acct-stale",
        email: "stale@example.com",
        plan: "pro",
      });
      const usage = {
        windows: [
          {
            name: "primary",
            usedPercent: 0,
            resetAt: 1,
            windowSeconds: 604800,
          },
        ],
      };
      writeFileSync(
        fx.authPath,
        JSON.stringify({
          providers: {
            "openai-codex": {
              accounts: [
                {
                  type: "oauth",
                  accountId: "acct-stale",
                  providerAccountId: "acct-stale",
                  access,
                  refresh: "refresh-stale",
                  expires: 0,
                  usage,
                },
              ],
            },
          },
        }),
        { mode: 0o600 },
      );
      codexRefresh.mockRejectedValue(new Error("refresh token rejected"));

      const providers = await new AuthManager(new AuthStorage(fx.authPath)).listProviderAccounts();

      expect(providers[0]?.accounts[0]).toMatchObject({
        email: "stale@example.com",
        credentialExpired: true,
        credentialRefreshStatus: "failed",
        usage,
        usageRefreshStatus: "failed",
      });
    } finally {
      fx.cleanup();
    }
  });

  it("accepts credentials replaced while a listing refresh fails", async () => {
    const fx = createTempAuthPath();
    try {
      const originalAccess = createAccessToken({
        accountId: "acct-credential-race",
        email: "old@example.com",
        plan: "plus",
      });
      const replacementAccess = createAccessToken({
        accountId: "acct-credential-race",
        email: "new@example.com",
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
                  accountId: "acct-credential-race",
                  providerAccountId: "acct-credential-race",
                  access: originalAccess,
                  refresh: "refresh-original",
                  expires: 0,
                },
              ],
            },
          },
        }),
        { mode: 0o600 },
      );
      const refreshStarted = deferred();
      const releaseRefresh = deferred();
      codexRefresh.mockImplementation(async () => {
        refreshStarted.resolve();
        return await releaseRefresh.promise;
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
                limit_window_seconds: 18000,
              },
            },
          }),
        })),
      );

      const listing = new AuthManager(new AuthStorage(fx.authPath)).listProviderAccounts();
      await refreshStarted.promise;

      new AuthManager(new AuthStorage(fx.authPath)).addOAuthAccount("openai-codex", {
        type: "oauth",
        access: replacementAccess,
        refresh: "refresh-replacement",
        expires: Number.MAX_SAFE_INTEGER,
        accountId: "acct-credential-race",
      });
      releaseRefresh.reject(new Error("refresh token rejected"));

      await expect(listing).resolves.toEqual([
        expect.objectContaining({
          accounts: [
            expect.objectContaining({
              email: "new@example.com",
              credentialRefreshStatus: "succeeded",
              usageRefreshStatus: "succeeded",
            }),
          ],
        }),
      ]);
    } finally {
      fx.cleanup();
    }
  });

  it("reports usage as stale when a credential replacement discards its refresh", async () => {
    const fx = createTempAuthPath();
    try {
      const originalAccess = createAccessToken({
        accountId: "acct-usage-race",
        email: "old@example.com",
        plan: "plus",
      });
      const replacementAccess = createAccessToken({
        accountId: "acct-usage-race",
        email: "new@example.com",
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
                  accountId: "acct-usage-race",
                  providerAccountId: "acct-usage-race",
                  access: originalAccess,
                  refresh: "refresh-original",
                  expires: Number.MAX_SAFE_INTEGER,
                },
              ],
            },
          },
        }),
        { mode: 0o600 },
      );
      const fetchStarted = deferred();
      const releaseFetch = deferred();
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          fetchStarted.resolve();
          await releaseFetch.promise;
          return {
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
          };
        }),
      );

      const listing = new AuthManager(new AuthStorage(fx.authPath)).listProviderAccounts();
      await fetchStarted.promise;

      new AuthManager(new AuthStorage(fx.authPath)).addOAuthAccount("openai-codex", {
        type: "oauth",
        access: replacementAccess,
        refresh: "refresh-replacement",
        expires: Number.MAX_SAFE_INTEGER,
        accountId: "acct-usage-race",
      });
      releaseFetch.resolve();

      await expect(listing).resolves.toEqual([
        expect.objectContaining({
          accounts: [
            expect.objectContaining({
              email: "new@example.com",
              credentialRefreshStatus: "succeeded",
              usage: undefined,
              usageRefreshStatus: "failed",
            }),
          ],
        }),
      ]);
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
                    accountId: "acct-disabled",
                    disabled: true,
                    providerAccountId: "provider-disabled",
                    access: "access-disabled",
                    refresh: "refresh-disabled",
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

      codexToAuth.mockImplementation(async (credential) => ({
        apiKey: credential.refresh === "refresh-exhausted" ? "api-exhausted" : "api-next",
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
      expect(
        fetch.mock.calls.some(
          ([, init]) => init.headers["ChatGPT-Account-Id"] === "provider-disabled",
        ),
      ).toBe(false);
    } finally {
      fx.cleanup();
    }
  });

  it("excludes disabled accounts from automatic selection", async () => {
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
                  accountId: "acct-disabled",
                  disabled: true,
                  access: "access-disabled",
                  refresh: "refresh-disabled",
                  expires: Number.MAX_SAFE_INTEGER,
                  usage: {
                    windows: [
                      {
                        name: "primary",
                        usedPercent: 90,
                        resetAt: 4102444800,
                        windowSeconds: 18000,
                      },
                    ],
                  },
                },
                {
                  type: "oauth",
                  accountId: "acct-enabled",
                  access: "access-enabled",
                  refresh: "refresh-enabled",
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
        }),
        { mode: 0o600 },
      );
      const storage = new AuthStorage(fx.authPath);
      const store = new TauCredentialStore({ authStorage: storage, getConfig: () => ({}) });

      const credential = await store.read("openai-codex");
      expect(credential?.type).toBe("oauth");
      expect(credential?.refresh).toBe("refresh-enabled");

      new AuthManager(storage).setAccountEnabled("openai-codex", "acct-enabled", false);
      await expect(store.read("openai-codex")).resolves.toBeUndefined();
      expect(codexToAuth).toHaveBeenCalledOnce();
    } finally {
      fx.cleanup();
    }
  });

  it("does not complete an in-flight selection after the account is disabled", async () => {
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
                  accountId: "acct-disable-race",
                  access: "access-disable-race",
                  refresh: "refresh-disable-race",
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
        }),
        { mode: 0o600 },
      );
      const authStarted = deferred();
      const releaseAuth = deferred();
      codexToAuth.mockImplementation(async () => {
        authStarted.resolve();
        return await releaseAuth.promise;
      });
      const storage = new AuthStorage(fx.authPath);
      const selection = new TauCredentialStore({
        authStorage: storage,
        getConfig: () => ({}),
      }).read("openai-codex");
      await authStarted.promise;

      new AuthManager(storage).setAccountEnabled("openai-codex", "acct-disable-race", false);
      releaseAuth.resolve({ apiKey: "api-disable-race" });

      await expect(selection).resolves.toBeUndefined();
    } finally {
      fx.cleanup();
    }
  });

  it("lists stored credential metadata without resolving credentials", async () => {
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
                  accountId: "acct-list",
                  access: "access-list",
                  refresh: "refresh-list",
                  expires: 0,
                },
              ],
            },
            anthropic: {
              accounts: [
                {
                  type: "api_key",
                  accountId: "anthropic:default",
                  key: "secret-key",
                },
              ],
            },
            empty: { accounts: [] },
          },
        }),
        { mode: 0o600 },
      );

      const store = new TauCredentialStore({
        authStorage: new AuthStorage(fx.authPath),
        getConfig: () => ({}),
      });

      await expect(store.list()).resolves.toEqual([
        { providerId: "openai-codex", type: "oauth" },
        { providerId: "anthropic", type: "api_key" },
      ]);
      expect(codexRefresh).not.toHaveBeenCalled();
      expect(codexToAuth).not.toHaveBeenCalled();
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

  it("rejects a forced disabled codex account", async () => {
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
                  accountId: "acct-disabled-forced",
                  disabled: true,
                  access: createAccessToken({
                    accountId: "acct-disabled-forced",
                    email: "disabled@example.com",
                    plan: "plus",
                  }),
                  refresh: "refresh-disabled",
                  expires: Number.MAX_SAFE_INTEGER,
                },
                {
                  type: "oauth",
                  accountId: "acct-enabled-fallback",
                  access: "access-enabled",
                  refresh: "refresh-enabled",
                  expires: Number.MAX_SAFE_INTEGER,
                },
              ],
            },
          },
        }),
        { mode: 0o600 },
      );
      const store = new TauCredentialStore({
        authStorage: new AuthStorage(fx.authPath),
        getConfig: () => ({}),
        env: { TAU_CODEX_ACCOUNT: "disabled@example.com" },
      });

      await expect(store.read("openai-codex")).rejects.toThrow(
        'TAU_CODEX_ACCOUNT matched disabled Codex account "acct-disabled-forced"',
      );
      expect(codexToAuth).not.toHaveBeenCalled();
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

      let sessionId = "sticky-disable-session-1";
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

      new AuthManager(storage).setAccountEnabled("openai-codex", "acct-a", false);
      const afterDisable = await store.read("openai-codex");
      expect(afterDisable?.type).toBe("oauth");
      expect(afterDisable?.refresh).toBe("refresh-b");

      sessionId = "sticky-disable-session-2";
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
