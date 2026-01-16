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
      };

      await runLoginCommand({
        providerArg: "openai-codex",
        authStorage,
        authPath: fx.authPath,
        prompt: async () => "",
        log: () => {},
        loginHandlers: {
          "openai-codex": async () => credentials,
        },
      });

      const saved = JSON.parse(readFileSync(fx.authPath, "utf-8"));
      expect(saved["openai-codex"].access).toBe("access-token");

      await runLogoutCommand({
        providerArg: "openai-codex",
        authStorage,
        authPath: fx.authPath,
        prompt: async () => "",
        log: () => {},
      });

      const removed = JSON.parse(readFileSync(fx.authPath, "utf-8"));
      expect(removed["openai-codex"]).toBeUndefined();
    } finally {
      fx.cleanup();
    }
  });
});
