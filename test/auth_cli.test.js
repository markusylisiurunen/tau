import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { codexRefresh, codexToAuth } = vi.hoisted(() => ({
  codexRefresh: vi.fn(),
  codexToAuth: vi.fn(),
}));

vi.mock("@earendil-works/pi-ai/providers/openai-codex", () => ({
  openaiCodexProvider: () => ({
    auth: {
      oauth: {
        login: vi.fn(),
        refresh: codexRefresh,
        toAuth: codexToAuth,
      },
    },
  }),
}));

import { AuthStorage } from "../dist/core/auth/auth_storage.js";
import {
  parseAuthCliArgs,
  runListCommand,
  runLoginCommand,
  runLogoutCommand,
  runSetAccountEnabledCommand,
} from "../dist/core/auth/cli.js";

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
  const dir = mkdtempSync(join(tmpdir(), "tau-auth-cli-"));
  return {
    dir,
    authPath: join(dir, "auth.json"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

beforeEach(() => {
  codexRefresh.mockReset().mockImplementation(async (credential) => credential);
  codexToAuth.mockReset().mockImplementation(async (credential) => ({
    apiKey: credential.access,
  }));
  vi.unstubAllGlobals();
});

describe("auth cli", () => {
  it("parses complete auth subcommands", () => {
    expect(parseAuthCliArgs(["login", "codex"])).toEqual({
      type: "login",
      providerArg: "codex",
    });
    expect(parseAuthCliArgs(["list"])).toEqual({ type: "list" });
    expect(parseAuthCliArgs(["logout", "codex", "--account", "user@example.com"])).toEqual({
      type: "logout",
      providerArg: "codex",
      accountId: "user@example.com",
    });
    expect(parseAuthCliArgs(["disable", "codex", "--account", "user@example.com"])).toEqual({
      type: "disable",
      providerArg: "codex",
      accountId: "user@example.com",
    });
    expect(parseAuthCliArgs(["enable", "codex", "--account", "acct-123"])).toEqual({
      type: "enable",
      providerArg: "codex",
      accountId: "acct-123",
    });
  });

  it.each([
    [["list", "--bogus"], 'unknown auth list option "--bogus"'],
    [["list", "extra"], 'unexpected auth list argument "extra"'],
    [["login", "codex", "extra"], 'unexpected auth login argument "extra"'],
    [["logout", "codex", "--account", "wanted", "--force"], 'unknown auth logout option "--force"'],
    [
      ["logout", "codex", "--account", "first", "--account", "second"],
      'duplicate auth logout option "--account"',
    ],
    [["logout", "codex", "--account"], 'missing value for auth logout option "--account"'],
    [["disable", "codex"], "missing --account <id> for disable"],
    [["enable", "codex", "--bogus"], 'unknown auth enable option "--bogus"'],
  ])("rejects invalid arguments %#", (args, message) => {
    expect(() => parseAuthCliArgs(args)).toThrow(message);
  });

  it("stores credentials on login and removes them on logout", async () => {
    const fx = createTempAuthPath();
    try {
      const authStorage = new AuthStorage(fx.authPath);
      const accountId = "acct-123";
      const credentials = {
        type: "oauth",
        access: createAccessToken({
          accountId,
          email: "user@example.com",
          plan: "free",
        }),
        refresh: "refresh-token",
        expires: 123,
        accountId,
      };

      await runLoginCommand({
        providerArg: "codex",
        authStorage,
        authPath: fx.authPath,
        prompt: async () => "",
        log: () => {},
        loginHandlers: {
          "openai-codex": async () => credentials,
        },
      });

      const saved = JSON.parse(readFileSync(fx.authPath, "utf-8"));
      expect(saved.providers["openai-codex"].accounts[0].access).toBe(credentials.access);

      await runLogoutCommand({
        providerArg: "codex",
        accountId,
        authStorage,
        authPath: fx.authPath,
        prompt: async () => "",
        log: () => {},
      });

      const removed = JSON.parse(readFileSync(fx.authPath, "utf-8"));
      expect(removed.providers["openai-codex"].accounts.length).toBe(0);
    } finally {
      fx.cleanup();
    }
  });

  it("disables accounts by email and preserves the state across login", async () => {
    const fx = createTempAuthPath();
    try {
      const authStorage = new AuthStorage(fx.authPath);
      const credentials = {
        type: "oauth",
        access: createAccessToken({
          accountId: "acct-toggle",
          email: "toggle@example.com",
          plan: "pro",
        }),
        refresh: "refresh-original",
        expires: Number.MAX_SAFE_INTEGER,
        accountId: "acct-toggle",
      };

      await runLoginCommand({
        providerArg: "codex",
        authStorage,
        authPath: fx.authPath,
        prompt: async () => "",
        log: () => {},
        loginHandlers: { "openai-codex": async () => credentials },
      });
      await runSetAccountEnabledCommand({
        enabled: false,
        providerArg: "codex",
        accountId: "toggle@example.com",
        authStorage,
        authPath: fx.authPath,
        prompt: async () => "",
        log: () => {},
      });
      await runLoginCommand({
        providerArg: "codex",
        authStorage,
        authPath: fx.authPath,
        prompt: async () => "",
        log: () => {},
        loginHandlers: {
          "openai-codex": async () => ({ ...credentials, refresh: "refresh-reauthenticated" }),
        },
      });

      let saved = JSON.parse(readFileSync(fx.authPath, "utf-8"));
      expect(saved.providers["openai-codex"].accounts[0]).toMatchObject({
        disabled: true,
        refresh: "refresh-reauthenticated",
      });

      await runSetAccountEnabledCommand({
        enabled: true,
        providerArg: "codex",
        accountId: "acct-toggle",
        authStorage,
        authPath: fx.authPath,
        prompt: async () => "",
        log: () => {},
      });

      saved = JSON.parse(readFileSync(fx.authPath, "utf-8"));
      expect(saved.providers["openai-codex"].accounts[0].disabled).toBe(false);
    } finally {
      fx.cleanup();
    }
  });

  it("warns when account and usage refreshes fail", async () => {
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
                  accountId: "acct-stale",
                  providerAccountId: "acct-stale",
                  access: createAccessToken({
                    accountId: "acct-stale",
                    email: "stale@example.com",
                    plan: "pro",
                  }),
                  refresh: "refresh-stale",
                  expires: 0,
                  usage: {
                    windows: [
                      {
                        name: "primary",
                        usedPercent: 0,
                        resetAt: 1,
                        windowSeconds: 604800,
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
      codexRefresh.mockRejectedValue(new Error("refresh token rejected"));
      const output = [];

      await runListCommand({
        authStorage: new AuthStorage(fx.authPath),
        log: (message) => output.push(message),
      });

      expect(output).toContain(
        '    credentials expired; refresh failed, run "tau auth login codex" to re-authenticate',
      );
      expect(output).toContain("    usage refresh failed; showing stale cached usage");
    } finally {
      fx.cleanup();
    }
  });

  it("refreshes and labels disabled accounts without selecting them", async () => {
    const fx = createTempAuthPath();
    try {
      const access = createAccessToken({
        accountId: "acct-disabled",
        email: "disabled@example.com",
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
                  accountId: "acct-disabled",
                  disabled: true,
                  providerAccountId: "acct-disabled",
                  access,
                  refresh: "refresh-disabled",
                  expires: Number.MAX_SAFE_INTEGER,
                },
              ],
            },
          },
        }),
        { mode: 0o600 },
      );
      vi.stubGlobal(
        "fetch",
        vi.fn(async () => ({
          ok: true,
          json: async () => ({
            rate_limit: {
              primary_window: {
                used_percent: 25,
                reset_at: 4102444800,
                limit_window_seconds: 18000,
              },
            },
          }),
        })),
      );
      const output = [];

      await runListCommand({
        authStorage: new AuthStorage(fx.authPath),
        log: (message) => output.push(message),
      });

      expect(codexRefresh).toHaveBeenCalledOnce();
      expect(fetch).toHaveBeenCalledOnce();
      const accountLine = output.find((line) => line.includes("disabled@example.com"));
      expect(accountLine).toContain("[pro] [disabled]");
      expect(accountLine.trimStart().startsWith("*")).toBe(false);
    } finally {
      fx.cleanup();
    }
  });

  it("supports manual prompt fallback during login", async () => {
    const fx = createTempAuthPath();
    try {
      const authStorage = new AuthStorage(fx.authPath);
      const promptCalls = [];
      const inputValue = "manual-code";
      const expectedAccess = createAccessToken({
        accountId: `acct-${inputValue}`,
        email: `user+${inputValue}@example.com`,
        plan: "free",
      });

      await runLoginCommand({
        providerArg: "codex",
        authStorage,
        authPath: fx.authPath,
        prompt: async (prompt) => {
          promptCalls.push(prompt.message);
          return inputValue;
        },
        log: () => {},
        loginHandlers: {
          "openai-codex": async (interaction) => {
            const input = await interaction.prompt({
              type: "manual_code",
              message: "Paste code:",
            });
            const accountId = `acct-${input}`;
            return {
              type: "oauth",
              access: createAccessToken({
                accountId,
                email: `user+${input}@example.com`,
                plan: "free",
              }),
              refresh: "refresh-token",
              expires: 123,
              accountId,
            };
          },
        },
      });

      const saved = JSON.parse(readFileSync(fx.authPath, "utf-8"));
      expect(saved.providers["openai-codex"].accounts[0].access).toBe(expectedAccess);
      expect(promptCalls).toEqual(["Paste code:"]);
    } finally {
      fx.cleanup();
    }
  });
});
