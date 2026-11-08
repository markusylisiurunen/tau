import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { runTelegramCommand } from "../dist/core/telegram/cli.js";
import { loadTelegramConfig } from "../dist/core/telegram/config.js";

function writeConfig(content) {
  const dir = mkdtempSync(join(tmpdir(), "tau-telegram-config-test-"));
  const path = join(dir, "telegram.json");
  writeFileSync(path, JSON.stringify(content), "utf8");
  return { dir, path };
}

describe("telegram cli", () => {
  it("checks configuration without starting sessions or requiring provider configuration", async () => {
    const { path } = writeConfig({
      bots: {
        bot: {
          botToken: "token",
          startup: { source: "workspace" },
          env: { GH_CONFIG_DIR: "/bot/gh" },
        },
      },
      projects: {},
    });
    const createSessionClient = vi.fn();
    await runTelegramCommand(["--config-file", path, "--check-config"], {
      createSessionClient,
      stdout: () => {},
    });
    expect(createSessionClient).not.toHaveBeenCalled();
    const invalid = writeConfig({
      bots: {
        bot: { botToken: "token", startup: { source: "workspace" }, env: { HOME: "/other" } },
      },
      projects: {},
    });
    await expect(
      runTelegramCommand(["--config-file", invalid.path, "--check-config"], { stdout: () => {} }),
    ).rejects.toThrow();
  });

  it("loads bot environments without expanding or trimming values", () => {
    const env = { GH_CONFIG_DIR: "/bot/gh", GH_TOKEN: "", VALUE: " $HOME " };
    const { path } = writeConfig({
      bots: { bot: { botToken: "token", startup: { source: "workspace" }, env } },
      projects: {},
    });
    expect(loadTelegramConfig(path).bots.bot.env).toEqual(env);
  });

  it.each([{ HOME: "/other" }, { VALUE: "bad\0value" }])(
    "rejects invalid bot environments %j",
    (env) => {
      const { path } = writeConfig({
        bots: { bot: { botToken: "token", startup: { source: "workspace" }, env } },
        projects: {},
      });
      expect(() => loadTelegramConfig(path)).toThrow();
    },
  );

  it("loads explicit presets and keeps omitted and empty menus distinct", () => {
    const presets = {
      workspace: { source: "workspace", label: "Workspace default" },
      fast: {
        source: "persona",
        label: "Fast",
        persona: "project-persona",
        reasoning: "low",
        autoCompactThresholdTokens: 80000,
      },
    };
    const { path } = writeConfig({
      bots: {
        curated: { botToken: "token", startup: { source: "preset", preset: "fast" }, presets },
        empty: { botToken: "token", startup: { source: "workspace" }, presets: {} },
        full: { botToken: "token", startup: { source: "workspace" } },
      },
      projects: { tau: { repo: "owner/repo" } },
    });
    const { bots } = loadTelegramConfig(path);
    expect(bots.curated.presets).toEqual(presets);
    expect(bots.empty.presets).toEqual({});
    expect(bots.full.presets).toBeUndefined();
  });

  it("rejects projects with multiple workspace sources", () => {
    const { path } = writeConfig({
      bots: { ops: { botToken: "token", startup: { source: "workspace" } } },
      projects: {
        me: {
          repo: "owner/repo",
          directory: "/home/tau/me",
        },
      },
    });

    expect(() => loadTelegramConfig(path)).toThrow(
      "projects.me must define exactly one of repo, directory, or projectIds",
    );
  });

  it("loads composite projects that reference repository projects", () => {
    const { path } = writeConfig({
      bots: {
        ops: {
          botToken: "token",
          startup: { source: "workspace" },
          allowedProjectIds: ["tau", "cowork", "tau_cowork"],
        },
      },
      projects: {
        tau: {
          repo: "markusylisiurunen/tau",
          ref: "main",
        },
        cowork: {
          repo: "markusylisiurunen/cowork",
          workingDirectory: "packages/server",
        },
        tau_cowork: {
          projectIds: ["tau", "cowork"],
          instructions: "Keep changes coordinated.",
          subagents: {
            launchModels: ["openai/gpt-5.6-sol:high"],
          },
        },
      },
    });

    expect(loadTelegramConfig(path).projects.tau_cowork).toEqual({
      projectIds: ["tau", "cowork"],
      instructions: "Keep changes coordinated.",
      subagents: {
        launchModels: ["openai/gpt-5.6-sol:high"],
      },
    });
  });

  it("rejects composite projects that reference a persistent directory", () => {
    const { path } = writeConfig({
      bots: { ops: { botToken: "token", startup: { source: "workspace" } } },
      projects: {
        me: { directory: "/home/tau/me" },
        one: { repo: "owner/one" },
        combined: { projectIds: ["me", "one"] },
      },
    });

    expect(() => loadTelegramConfig(path)).toThrow(
      "projects.combined.projectIds must reference repository projects, not directory project 'me'",
    );
  });
});
