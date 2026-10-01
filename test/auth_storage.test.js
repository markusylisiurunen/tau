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
import { ModelRuntime } from "../dist/core/utils/model_stream.js";

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

function writeCodexAccounts(authPath, accounts, options) {
  writeFileSync(authPath, JSON.stringify({ providers: { "openai-codex": { accounts } } }), options);
}

function createUsage(usedPercent) {
  return {
    windows: [{ name: "primary", usedPercent, resetAt: 4102444800, windowSeconds: 18000 }],
  };
}

function createUsageResponse(usedPercent, windowSeconds = 18000) {
  return {
    ok: true,
    json: async () => ({
      rate_limit: {
        primary_window: {
          used_percent: usedPercent,
          reset_at: 4102444800,
          limit_window_seconds: windowSeconds,
        },
      },
    }),
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

  it("activates the unique enabled account in older stores", () => {
    const fx = createTempAuthPath();
    try {
      writeCodexAccounts(fx.authPath, [
        {
          type: "oauth",
          accountId: "acct-existing",
          access: "existing-access",
          refresh: "existing-refresh",
          expires: 1,
        },
      ]);

      const storage = new AuthStorage(fx.authPath);

      expect(storage.getInvalidReason()).toBeUndefined();
      expect(storage.getData().providers["openai-codex"].activeAccountId).toBe("acct-existing");
    } finally {
      fx.cleanup();
    }
  });

  it("rejects auth.json when any account entry is invalid", () => {
    const fx = createTempAuthPath();
    try {
      writeCodexAccounts(fx.authPath, [
        {
          type: "oauth",
          accountId: "acct-good",
          access: "old-access",
          refresh: "old-refresh",
          expires: 0,
          idToken: "header.payload.signature",
        },
        { type: "oauth", accountId: "bad" },
      ]);

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
  it("preserves invalid auth storage when changing account state", () => {
    const fx = createTempAuthPath();
    try {
      const invalidAuth = '{"providers":';
      writeFileSync(fx.authPath, invalidAuth, { mode: 0o600 });
      const storage = new AuthStorage(fx.authPath);

      expect(() => new AuthManager(storage).useAccount("openai-codex", "acct-invalid")).toThrow(
        "failed to parse auth.json",
      );
      expect(readFileSync(fx.authPath, "utf8")).toBe(invalidAuth);
    } finally {
      fx.cleanup();
    }
  });

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
      writeCodexAccounts(
        fx.authPath,
        [
          {
            type: "oauth",
            accountId: "acct-race",
            providerAccountId: "acct-race",
            access: originalAccess,
            refresh: "refresh-race",
            expires: 1,
          },
        ],
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
      writeCodexAccounts(
        fx.authPath,
        [
          {
            type: "oauth",
            accountId: "acct-modify-race",
            providerAccountId: "acct-modify-race",
            access: "access-original",
            refresh: "refresh-original",
            expires: 1,
          },
        ],
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

  it("serializes refresh callbacks across credential stores and observes the newer generation", async () => {
    const fx = createTempAuthPath();
    try {
      writeCodexAccounts(fx.authPath, [
        {
          type: "oauth",
          accountId: "acct-parallel",
          access: "access-original",
          refresh: "refresh-original",
          expires: 1,
        },
      ]);
      const started = deferred();
      const release = deferred();
      const stores = [0, 1].map(
        () =>
          new TauCredentialStore({
            authStorage: new AuthStorage(fx.authPath),
            getConfig: () => ({}),
          }),
      );
      const first = stores[0].modify("openai-codex", async (current) => {
        started.resolve();
        await release.promise;
        return {
          ...current,
          access: "access-newer",
          refresh: "refresh-newer",
          expires: Number.MAX_SAFE_INTEGER,
        };
      });
      await started.promise;
      const second = stores[1].modify("openai-codex", async (current) => {
        expect(current.refresh).toBe("refresh-newer");
        return undefined;
      });
      release.resolve();
      for (const result of await Promise.all([first, second]))
        expect(result.refresh).toBe("refresh-newer");
      expect(
        JSON.parse(readFileSync(fx.authPath, "utf8")).providers["openai-codex"].accounts[0].refresh,
      ).toBe("refresh-newer");
    } finally {
      fx.cleanup();
    }
  });

  it("preserves credentials replaced during an in-flight refresh", async () => {
    const fx = createTempAuthPath();
    try {
      writeCodexAccounts(fx.authPath, [
        { type: "oauth", accountId: "a", access: "original", refresh: "original", expires: 0 },
      ]);
      const started = deferred();
      const release = deferred();
      const storage = new AuthStorage(fx.authPath);
      const store = new TauCredentialStore({ authStorage: storage, getConfig: () => ({}) });
      const result = store.modify("openai-codex", async (current) => {
        started.resolve();
        await release.promise;
        return { ...current, access: "stale", refresh: "stale" };
      });
      await started.promise;
      new AuthStorage(fx.authPath).update((data) => {
        data.providers["openai-codex"].accounts[0].refresh = "replacement";
      });
      release.resolve();
      expect((await result).refresh).toBe("replacement");
      expect(
        JSON.parse(readFileSync(fx.authPath, "utf8")).providers["openai-codex"].accounts[0].refresh,
      ).toBe("replacement");
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
      writeCodexAccounts(fx.authPath, [
        {
          type: "oauth",
          accountId: "acct-plan",
          providerAccountId: "acct-plan",
          access: originalAccess,
          refresh: "refresh-plan",
          expires: Number.MAX_SAFE_INTEGER,
        },
      ]);

      codexRefresh.mockResolvedValue({
        type: "oauth",
        access: refreshedAccess,
        refresh: "refresh-plan-next",
        expires: Number.MAX_SAFE_INTEGER,
        accountId: "acct-plan",
      });
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => createUsageResponse(12)),
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
      writeCodexAccounts(
        fx.authPath,
        [
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
      writeCodexAccounts(
        fx.authPath,
        [
          {
            type: "oauth",
            accountId: "acct-credential-race",
            providerAccountId: "acct-credential-race",
            access: originalAccess,
            refresh: "refresh-original",
            expires: 0,
          },
        ],
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
        vi.fn(async () => createUsageResponse(12)),
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
      writeCodexAccounts(
        fx.authPath,
        [
          {
            type: "oauth",
            accountId: "acct-usage-race",
            providerAccountId: "acct-usage-race",
            access: originalAccess,
            refresh: "refresh-original",
            expires: Number.MAX_SAFE_INTEGER,
          },
        ],
        { mode: 0o600 },
      );
      const fetchStarted = deferred();
      const releaseFetch = deferred();
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => {
          fetchStarted.resolve();
          await releaseFetch.promise;
          return createUsageResponse(12);
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

  it("preserves ambiguous old accounts without choosing by quota", async () => {
    const fx = createTempAuthPath();
    try {
      const accounts = ["a", "b"].map((id) => ({
        type: "oauth",
        accountId: id,
        access: `access-${id}`,
        refresh: `refresh-${id}`,
        expires: Number.MAX_SAFE_INTEGER,
        usage: createUsage(id === "a" ? 100 : 0),
      }));
      writeCodexAccounts(fx.authPath, accounts);
      const storage = new AuthStorage(fx.authPath);
      expect(storage.getData().providers["openai-codex"]).toEqual({
        accounts,
        activeAccountId: null,
      });
      await expect(
        new TauCredentialStore({ authStorage: storage, getConfig: () => ({}) }).read(
          "openai-codex",
        ),
      ).rejects.toThrow(/auth use/);
    } finally {
      fx.cleanup();
    }
  });

  it("reads expired credentials without refreshing and binds an account only for one request", async () => {
    const fx = createTempAuthPath();
    try {
      writeCodexAccounts(
        fx.authPath,
        ["a", "b"].map((id) => ({
          type: "oauth",
          accountId: id,
          access: `access-${id}`,
          refresh: `refresh-${id}`,
          expires: 0,
        })),
      );
      const storage = new AuthStorage(fx.authPath);
      const manager = new AuthManager(storage);
      manager.useAccount("openai-codex", "a");
      const store = new TauCredentialStore({ authStorage: storage, getConfig: () => ({}) });
      const request = store.bindCodexAccount();
      manager.useAccount("openai-codex", "b");
      expect((await request.read("openai-codex")).refresh).toBe("refresh-a");
      expect((await store.read("openai-codex")).refresh).toBe("refresh-b");
      expect(codexRefresh).not.toHaveBeenCalled();
    } finally {
      fx.cleanup();
    }
  });
  it.each(["identity", "usage"])(
    "serializes CLI %s token rotation with a model request",
    async (phase) => {
      const fx = createTempAuthPath();
      try {
        const access = createAccessToken({ accountId: "a", email: "a@example.com", plan: "pro" });
        writeCodexAccounts(fx.authPath, [
          {
            type: "oauth",
            accountId: "a",
            providerAccountId: "a",
            access,
            refresh: "original",
            expires: 0,
          },
        ]);
        const started = deferred();
        const release = deferred();
        if (phase === "usage")
          codexRefresh.mockRejectedValueOnce(new Error("identity refresh failed"));
        codexRefresh.mockImplementationOnce(async (credential) => {
          started.resolve();
          await release.promise;
          return { ...credential, refresh: "rotated", expires: Number.MAX_SAFE_INTEGER };
        });
        vi.stubGlobal(
          "fetch",
          vi.fn(async () => createUsageResponse(12)),
        );
        const runtime = new ModelRuntime({
          authStorage: new AuthStorage(fx.authPath),
          getConfig: () => ({}),
          env: {},
        });
        const provider = runtime.models.getProvider("openai-codex");
        runtime.models.setProvider({
          ...provider,
          auth: { oauth: { ...provider.auth.oauth, refresh: codexRefresh, toAuth: codexToAuth } },
        });
        const listing = new AuthManager(new AuthStorage(fx.authPath)).listProviderAccounts();
        await started.promise;
        const request = runtime.getAuth(runtime.resolveModel("openai-codex", "gpt-6.1-sol"));
        expect(codexRefresh).toHaveBeenCalledTimes(phase === "identity" ? 1 : 2);
        release.resolve();
        expect((await request).auth.apiKey).toBe(access);
        expect((await listing)[0].accounts[0].usageRefreshStatus).toBe("succeeded");
        expect(codexRefresh).toHaveBeenCalledTimes(phase === "identity" ? 1 : 2);
        expect(
          JSON.parse(readFileSync(fx.authPath, "utf8")).providers["openai-codex"].accounts[0]
            .refresh,
        ).toBe("rotated");
      } finally {
        fx.cleanup();
      }
    },
  );

  it("rereads the account after waiting for a request refresh before listing", async () => {
    const fx = createTempAuthPath();
    try {
      const access = createAccessToken({ accountId: "a", email: "a@example.com", plan: "pro" });
      writeCodexAccounts(fx.authPath, [
        { type: "oauth", accountId: "a", access, refresh: "original", expires: 0 },
      ]);
      const started = deferred();
      const release = deferred();
      const request = new TauCredentialStore({
        authStorage: new AuthStorage(fx.authPath),
        getConfig: () => ({}),
      }).modify("openai-codex", async (credential) => {
        started.resolve();
        await release.promise;
        return { ...credential, refresh: "rotated", expires: Number.MAX_SAFE_INTEGER };
      });
      await started.promise;
      codexRefresh.mockImplementation(async (credential) => {
        expect(credential.refresh).toBe("rotated");
        return credential;
      });
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => createUsageResponse(12)),
      );
      const listing = new AuthManager(new AuthStorage(fx.authPath)).listProviderAccounts();
      expect(codexRefresh).not.toHaveBeenCalled();
      release.resolve();
      await request;
      expect((await listing)[0].accounts[0].credentialRefreshStatus).toBe("succeeded");
      expect(codexRefresh).toHaveBeenCalledTimes(1);
    } finally {
      fx.cleanup();
    }
  });
});
