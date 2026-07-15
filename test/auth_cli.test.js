import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { AuthStorage } from "../dist/core/auth/auth_storage.js";
import { parseAuthCliArgs, runLoginCommand, runLogoutCommand } from "../dist/core/auth/cli.js";

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
  ])("rejects invalid arguments %#", (args, message) => {
    expect(() => parseAuthCliArgs(args)).toThrow(message);
  });

  it("stores credentials on login and removes them on logout", async () => {
    const fx = createTempAuthPath();
    try {
      const authStorage = new AuthStorage(fx.authPath);
      const accountId = "acct-123";
      const credentials = {
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
          "openai-codex": async (callbacks) => {
            const input = await callbacks.onPrompt({ message: "Paste code:" });
            const accountId = `acct-${input}`;
            return {
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
