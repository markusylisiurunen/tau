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
  it("requires --config-file", async () => {
    await expect(runTelegramCommand([], { stdout: () => {} })).rejects.toMatchObject({
      message: "missing --config-file <path>",
    });
  });

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

  it.each([{ HOME: "/other" }, { "BAD=KEY": "value" }, { VALUE: "bad\0value" }, { VALUE: 1 }])(
    "rejects invalid bot environments %j",
    (env) => {
      const { path } = writeConfig({
        bots: { bot: { botToken: "token", startup: { source: "workspace" }, env } },
        projects: {},
      });
      expect(() => loadTelegramConfig(path)).toThrow();
    },
  );

  it("loads telegram runner config", () => {
    const { dir, path } = writeConfig({
      workspaceRoot: "workspaces",
      maxSessions: 2,
      bots: {
        ops: {
          botToken: "token",
          startup: { source: "workspace" },
          systemMessage: "bot guidance",
          defaultProjectId: "tau",
          allowedProjectIds: ["tau"],
        },
      },
      projects: {
        tau: {
          repo: "markusylisiurunen/tau",
          ref: "main",
          workingDirectory: "packages/core",
        },
      },
    });

    expect(loadTelegramConfig(path)).toEqual({
      workspaceRoot: join(dir, "workspaces"),
      maxSessions: 2,
      bots: {
        ops: {
          botToken: "token",
          startup: { source: "workspace" },
          systemMessage: "bot guidance",
          defaultProjectId: "tau",
          allowedProjectIds: ["tau"],
        },
      },
      projects: {
        tau: {
          repo: "markusylisiurunen/tau",
          ref: "main",
          workingDirectory: "packages/core",
        },
      },
    });
  });

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

  it.each([
    {},
    { startup: { source: "preset", preset: "missing" } },
    { startup: { source: "bot", preset: "fast" } },
    { startup: { source: "workspace" }, personaMenu: [] },
    { startup: { source: "workspace" }, presets: [] },
    {
      startup: { source: "workspace" },
      presets: { fast: { source: "persona", label: "Fast", persona: "chat:high" } },
    },
    {
      startup: { source: "workspace" },
      presets: {
        fast: { source: "persona", label: "Fast", persona: "chat", reasoning: "invalid" },
      },
    },
    {
      startup: { source: "workspace" },
      presets: { workspace: { source: "workspace", label: "Default", reasoning: "low" } },
    },
  ])("rejects invalid startup and presets: %j", (fields) => {
    const { path } = writeConfig({ bots: { bot: { botToken: "token", ...fields } }, projects: {} });
    expect(() => loadTelegramConfig(path)).toThrow();
  });

  it.each([49999, 1.5, "128k", null, Number.MAX_SAFE_INTEGER + 1])(
    "rejects invalid bot and preset thresholds %j",
    (threshold) => {
      for (const fields of [
        { autoCompactThresholdTokens: threshold },
        {
          presets: {
            chat: {
              source: "persona",
              persona: "chat",
              label: "Chat",
              autoCompactThresholdTokens: threshold,
            },
          },
        },
      ]) {
        const { path } = writeConfig({
          bots: { bot: { botToken: "token", startup: { source: "workspace" }, ...fields } },
          projects: {},
        });
        expect(() => loadTelegramConfig(path)).toThrow();
      }
    },
  );

  it.each([
    { repo: "owner/repo", persona: "chat" },
    { directory: "/home/tau", persona: "chat" },
    { projectIds: ["one", "two"], persona: "chat" },
  ])("rejects project persona selection: %j", (project) => {
    const { path } = writeConfig({
      bots: { bot: { botToken: "token", startup: { source: "workspace" } } },
      projects: { selected: project },
    });
    expect(() => loadTelegramConfig(path)).toThrow();
  });

  it("loads persistent directory projects", () => {
    const { dir, path } = writeConfig({
      bots: {
        ops: {
          botToken: "token",
          startup: { source: "workspace" },
          allowedProjectIds: ["me"],
        },
      },
      projects: {
        me: {
          directory: "workspaces/me",
        },
      },
    });

    expect(loadTelegramConfig(path).projects.me).toEqual({
      directory: join(dir, "workspaces/me"),
    });
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

  it("rejects subagent launch models on repository projects", () => {
    const { path } = writeConfig({
      bots: { ops: { botToken: "token", startup: { source: "workspace" } } },
      projects: {
        me: {
          repo: "owner/repo",
          subagents: { launchModels: ["openai/gpt-5.6-sol:high"] },
        },
      },
    });

    expect(() => loadTelegramConfig(path)).toThrow("projects.me does not support subagents");
  });

  it("rejects project ids that cannot be Telegram command suffixes", () => {
    const { path } = writeConfig({
      bots: { ops: { botToken: "token", startup: { source: "workspace" } } },
      projects: { "invalid-project": { repo: "owner/repo" } },
    });

    expect(() => loadTelegramConfig(path)).toThrow(
      "project id 'invalid-project' must contain only lowercase letters, digits, and underscores",
    );
  });

  it("reserves thirteen Telegram commands when validating the project command limit", () => {
    const projects = Object.fromEntries(
      Array.from({ length: 90 }, (_, index) => [`project_${index}`, { repo: "owner/repo" }]),
    );
    const accepted = writeConfig({
      bots: {
        ops: {
          botToken: "token",
          startup: { source: "workspace" },
          allowedProjectIds: Object.keys(projects).slice(0, 87),
        },
      },
      projects,
    });
    expect(loadTelegramConfig(accepted.path).bots.ops.allowedProjectIds).toHaveLength(87);

    const rejected = writeConfig({
      bots: { ops: { botToken: "token", startup: { source: "workspace" } } },
      projects,
    });
    expect(() => loadTelegramConfig(rejected.path)).toThrow(
      "bots.ops exposes 90 projects, exceeding Telegram's 100-command limit with built-in commands",
    );
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

  it("rejects composite projects that reference another composite", () => {
    const { path } = writeConfig({
      bots: { ops: { botToken: "token", startup: { source: "workspace" } } },
      projects: {
        one: { repo: "owner/one" },
        two: { repo: "owner/two" },
        pair: { projectIds: ["one", "two"] },
        nested: { projectIds: ["pair", "one"] },
      },
    });

    expect(() => loadTelegramConfig(path)).toThrow(
      "projects.nested.projectIds must reference repository projects, not composite project 'pair'",
    );
  });
});
