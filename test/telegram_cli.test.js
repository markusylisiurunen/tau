import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
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

  it("loads telegram runner config", () => {
    const { dir, path } = writeConfig({
      workspaceRoot: "workspaces",
      systemMessage: "telegram guidance",
      maxSessions: 2,
      bots: {
        ops: {
          botToken: "token",
          defaultProjectId: "tau",
          allowedProjectIds: ["tau"],
        },
      },
      projects: {
        tau: {
          repo: "markusylisiurunen/tau",
          ref: "main",
          workspaceRoot: "project-workspaces",
          workingDirectory: "packages/core",
          persona: "gpt-5.6-sol-coder:high",
        },
      },
    });

    expect(loadTelegramConfig(path)).toEqual({
      workspaceRoot: join(dir, "workspaces"),
      systemMessage: "telegram guidance",
      maxSessions: 2,
      bots: {
        ops: {
          botToken: "token",
          defaultProjectId: "tau",
          allowedProjectIds: ["tau"],
        },
      },
      projects: {
        tau: {
          repo: "markusylisiurunen/tau",
          ref: "main",
          workspaceRoot: join(dir, "project-workspaces"),
          workingDirectory: "packages/core",
          persona: "gpt-5.6-sol-coder:high",
        },
      },
    });
  });

  it("loads persistent directory projects", () => {
    const { dir, path } = writeConfig({
      bots: {
        ops: {
          botToken: "token",
          allowedProjectIds: ["me"],
        },
      },
      projects: {
        me: {
          directory: "workspaces/me",
          persona: "gpt-5.6-sol-coder:high",
          noAgentContextFiles: true,
        },
      },
    });

    expect(loadTelegramConfig(path).projects.me).toEqual({
      directory: join(dir, "workspaces/me"),
      persona: "gpt-5.6-sol-coder:high",
      noAgentContextFiles: true,
    });
  });

  it("rejects projects with multiple workspace sources", () => {
    const { path } = writeConfig({
      bots: { ops: { botToken: "token" } },
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
          persona: "gpt-5.6-sol-coder:high",
          instructions: "Keep changes coordinated.",
        },
      },
    });

    expect(loadTelegramConfig(path).projects.tau_cowork).toEqual({
      projectIds: ["tau", "cowork"],
      persona: "gpt-5.6-sol-coder:high",
      instructions: "Keep changes coordinated.",
    });
  });

  it("rejects project ids that cannot be Telegram command suffixes", () => {
    const { path } = writeConfig({
      bots: { ops: { botToken: "token" } },
      projects: { "invalid-project": { repo: "owner/repo" } },
    });

    expect(() => loadTelegramConfig(path)).toThrow(
      "project id 'invalid-project' must contain only lowercase letters, digits, and underscores",
    );
  });

  it("reserves ten Telegram commands when validating the project command limit", () => {
    const projects = Object.fromEntries(
      Array.from({ length: 91 }, (_, index) => [`project_${index}`, { repo: "owner/repo" }]),
    );
    const accepted = writeConfig({
      bots: {
        ops: {
          botToken: "token",
          allowedProjectIds: Object.keys(projects).slice(0, 90),
        },
      },
      projects,
    });
    expect(loadTelegramConfig(accepted.path).bots.ops.allowedProjectIds).toHaveLength(90);

    const rejected = writeConfig({
      bots: { ops: { botToken: "token" } },
      projects,
    });
    expect(() => loadTelegramConfig(rejected.path)).toThrow(
      "bots.ops exposes 91 projects, exceeding Telegram's 100-command limit with built-in commands",
    );
  });

  it("rejects composite projects that reference a persistent directory", () => {
    const { path } = writeConfig({
      bots: { ops: { botToken: "token" } },
      projects: {
        me: { directory: "/home/tau/me" },
        one: { repo: "owner/one" },
        combined: { projectIds: ["me", "one"], persona: "gpt-5.6-sol-coder" },
      },
    });

    expect(() => loadTelegramConfig(path)).toThrow(
      "projects.combined.projectIds must reference repository projects, not directory project 'me'",
    );
  });

  it("rejects composite projects that reference another composite", () => {
    const { path } = writeConfig({
      bots: { ops: { botToken: "token" } },
      projects: {
        one: { repo: "owner/one" },
        two: { repo: "owner/two" },
        pair: { projectIds: ["one", "two"], persona: "gpt-5.6-sol-coder" },
        nested: { projectIds: ["pair", "one"], persona: "gpt-5.6-sol-coder" },
      },
    });

    expect(() => loadTelegramConfig(path)).toThrow(
      "projects.nested.projectIds must reference repository projects, not composite project 'pair'",
    );
  });
});
