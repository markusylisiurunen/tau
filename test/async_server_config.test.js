import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { AsyncDaemonConfigError, loadAsyncDaemonConfig } from "../dist/core/async/server_config.js";

function setupFixture() {
  const root = mkdtempSync(join(tmpdir(), "tau-async-daemon-config-"));

  return {
    root,
    cleanup: () => {
      rmSync(root, { recursive: true, force: true });
    },
  };
}

describe("async daemon config", () => {
  it("loads valid daemon config and resolves workspace roots relative to config file", () => {
    const fx = setupFixture();

    try {
      const configDir = join(fx.root, "config");
      mkdirSync(configDir, { recursive: true });
      const configPath = join(configDir, "daemon.json");

      writeFileSync(
        configPath,
        JSON.stringify({
          host: "0.0.0.0",
          port: 8899,
          authToken: "secret",
          maxSessions: 4,
          workspaceRoot: "workspaces",
          telegram: {
            botToken: "bot-token",
            defaultProjectId: "tau",
          },
          projects: {
            tau: {
              repo: "markusylisiurunen/tau",
              workspaceRoot: "projects/tau",
              ref: "main",
            },
          },
        }),
      );

      const config = loadAsyncDaemonConfig(configPath);
      expect(config.host).toBe("0.0.0.0");
      expect(config.port).toBe(8899);
      expect(config.workspaceRoot).toBe(join(configDir, "workspaces"));
      expect(config.projects.tau.workspaceRoot).toBe(join(configDir, "projects", "tau"));
      expect(config.projects.tau.repo).toBe("markusylisiurunen/tau");
      expect(config.telegram?.defaultProjectId).toBe("tau");
    } finally {
      fx.cleanup();
    }
  });

  it("rejects repos outside owner/repo format", () => {
    const fx = setupFixture();

    try {
      const configPath = join(fx.root, "daemon.json");
      writeFileSync(
        configPath,
        JSON.stringify({
          projects: {
            bad: {
              repo: "https://github.com/markusylisiurunen/tau.git",
            },
          },
        }),
      );

      expect(() => loadAsyncDaemonConfig(configPath)).toThrow(AsyncDaemonConfigError);
      expect(() => loadAsyncDaemonConfig(configPath)).toThrow("owner/repo");
    } finally {
      fx.cleanup();
    }
  });
});
