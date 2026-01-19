import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { AuthStorage } from "../dist/core/auth/auth_storage.js";
import { runLoginCommand, runLogoutCommand } from "../dist/core/auth/cli.js";

function createTempAuthPath() {
  const dir = mkdtempSync(join(tmpdir(), "tau-auth-cli-"));
  return {
    dir,
    authPath: join(dir, "auth.json"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

describe("auth cli", () => {
  it("stores credentials on login and removes them on logout", async () => {
    const fx = createTempAuthPath();
    try {
      const authStorage = new AuthStorage(fx.authPath);
      const credentials = {
        access: "access-token",
        refresh: "refresh-token",
        expires: 123,
        accountId: "acct",
        idToken: "header.payload.signature",
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
      expect(saved.providers["openai-codex"].accounts[0].access).toBe("access-token");

      await runLogoutCommand({
        providerArg: "codex",
        accountId: "acct",
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

      await runLoginCommand({
        providerArg: "codex",
        authStorage,
        authPath: fx.authPath,
        prompt: async (prompt) => {
          promptCalls.push(prompt.message);
          return "manual-code";
        },
        log: () => {},
        loginHandlers: {
          "openai-codex": async (callbacks) => {
            const input = await callbacks.onPrompt({ message: "Paste code:" });
            return {
              access: `access-${input}`,
              refresh: "refresh-token",
              expires: 123,
              accountId: "acct",
              idToken: "header.payload.signature",
            };
          },
        },
      });

      const saved = JSON.parse(readFileSync(fx.authPath, "utf-8"));
      expect(saved.providers["openai-codex"].accounts[0].access).toBe("access-manual-code");
      expect(promptCalls).toEqual(["Paste code:"]);
    } finally {
      fx.cleanup();
    }
  });
});
