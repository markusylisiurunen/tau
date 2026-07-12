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
          persona: "gpt-5.5-coder:high",
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
          persona: "gpt-5.5-coder:high",
        },
      },
    });
  });
});
