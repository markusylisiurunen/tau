import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { printTelegramHelp, runTelegramCommand } from "../dist/core/telegram/cli.js";
import { loadTelegramConfig } from "../dist/core/telegram/config.js";

function writeConfig(content) {
  const dir = mkdtempSync(join(tmpdir(), "tau-telegram-config-test-"));
  const path = join(dir, "telegram.json");
  writeFileSync(path, JSON.stringify(content), "utf8");
  return { dir, path };
}

describe("telegram cli", () => {
  it("prints telegram help", async () => {
    const stdout = vi.fn();

    await runTelegramCommand(["--help"], { stdout });

    expect(stdout).toHaveBeenCalledWith(expect.stringContaining("tau telegram --config-file"));
  });

  it("requires --config-file", async () => {
    await expect(runTelegramCommand([], { stdout: () => {} })).rejects.toMatchObject({
      message: "missing --config-file <path>",
    });
  });

  it("rejects unknown options", async () => {
    await expect(runTelegramCommand(["--bogus"], { stdout: () => {} })).rejects.toMatchObject({
      message: "unknown option: --bogus",
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
          persona: "gpt-5.4-coder:high",
          riskLevel: "read-only",
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
          persona: "gpt-5.4-coder:high",
          riskLevel: "read-only",
        },
      },
    });
  });

  it("documents the reduced command surface", () => {
    const stdout = vi.fn();

    printTelegramHelp(stdout);

    const help = stdout.mock.calls[0][0];
    expect(help).toContain("tau telegram --config-file <path>");
    expect(help).not.toContain("tau async");
    expect(help).not.toContain("status <sessionId>");
    expect(help).not.toContain("cron");
  });
});
