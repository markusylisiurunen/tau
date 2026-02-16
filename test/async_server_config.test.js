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

function writeCronJobFile(cronJobsDir, args) {
  const lines = [
    "---",
    `id: ${args.id}`,
    `projectId: ${args.projectId}`,
    `schedule: "${args.schedule}"`,
    ...(args.enabled === undefined ? [] : [`enabled: ${args.enabled ? "true" : "false"}`]),
    "---",
    args.prompt,
    "",
  ];

  writeFileSync(join(cronJobsDir, `${args.id}.md`), lines.join("\n"));
}

describe("async daemon config", () => {
  it("loads valid daemon config and resolves workspace roots relative to config file", () => {
    const fx = setupFixture();

    try {
      const configDir = join(fx.root, "config");
      mkdirSync(configDir, { recursive: true });
      const configPath = join(configDir, "daemon.json");

      const cronJobsDir = join(configDir, "cron-jobs");
      mkdirSync(cronJobsDir, { recursive: true });
      writeCronJobFile(cronJobsDir, {
        id: "docs-drift-nightly",
        projectId: "tau",
        schedule: "0 2 * * *",
        prompt: "check for documentation drift",
      });

      writeFileSync(
        configPath,
        JSON.stringify({
          host: "0.0.0.0",
          port: 8899,
          authToken: "secret",
          maxSessions: 4,
          workspaceRoot: "workspaces",
          systemMessage: "focus on small diffs",
          cron: {
            jobsDir: "cron-jobs",
            systemMessage: "this prompt is running from a scheduled cron job",
          },
          telegram: {
            botToken: "bot-token",
            defaultProjectId: "tau",
            systemMessage: "telegram-specific notice",
          },
          projects: {
            tau: {
              repo: "markusylisiurunen/tau",
              workspaceRoot: "projects/tau",
              workingDirectory: "packages/core",
              description: "core workspace",
              ref: "main",
              bootstrapCommands: ["npm ci"],
              backgroundBootstrapCommands: ["npm run build"],
            },
          },
        }),
      );

      const config = loadAsyncDaemonConfig(configPath);
      expect(config.host).toBe("0.0.0.0");
      expect(config.port).toBe(8899);
      expect(config.workspaceRoot).toBe(join(configDir, "workspaces"));
      expect(config.systemMessage).toBe("focus on small diffs");
      expect(config.projects.tau.workspaceRoot).toBe(join(configDir, "projects", "tau"));
      expect(config.projects.tau.workingDirectory).toBe("packages/core");
      expect(config.projects.tau.description).toBe("core workspace");
      expect(config.projects.tau.repo).toBe("markusylisiurunen/tau");
      expect(config.projects.tau.bootstrapCommands).toEqual(["npm ci"]);
      expect(config.projects.tau.backgroundBootstrapCommands).toEqual(["npm run build"]);
      expect(config.telegram?.default?.defaultProjectId).toBe("tau");
      expect(config.telegram?.default?.systemMessage).toBe("telegram-specific notice");
      expect(config.cron?.systemMessage).toBe("this prompt is running from a scheduled cron job");
      expect(config.cronJobs).toEqual({
        "docs-drift-nightly": {
          projectId: "tau",
          schedule: "0 2 * * *",
          prompt: "check for documentation drift",
        },
      });
    } finally {
      fx.cleanup();
    }
  });

  it("rejects empty systemMessage", () => {
    const fx = setupFixture();

    try {
      const configPath = join(fx.root, "daemon.json");
      writeFileSync(
        configPath,
        JSON.stringify({
          systemMessage: "   ",
          projects: {
            tau: {
              repo: "markusylisiurunen/tau",
            },
          },
        }),
      );

      expect(() => loadAsyncDaemonConfig(configPath)).toThrow(AsyncDaemonConfigError);
      expect(() => loadAsyncDaemonConfig(configPath)).toThrow("systemMessage");
    } finally {
      fx.cleanup();
    }
  });

  it("rejects empty telegram.systemMessage", () => {
    const fx = setupFixture();

    try {
      const configPath = join(fx.root, "daemon.json");
      writeFileSync(
        configPath,
        JSON.stringify({
          telegram: {
            systemMessage: "",
          },
          projects: {
            tau: {
              repo: "markusylisiurunen/tau",
            },
          },
        }),
      );

      expect(() => loadAsyncDaemonConfig(configPath)).toThrow(AsyncDaemonConfigError);
      expect(() => loadAsyncDaemonConfig(configPath)).toThrow("telegram.systemMessage");
    } finally {
      fx.cleanup();
    }
  });

  it("loads named telegram bots and keeps per-bot project allowlists", () => {
    const fx = setupFixture();

    try {
      const configPath = join(fx.root, "daemon.json");
      writeFileSync(
        configPath,
        JSON.stringify({
          telegram: {
            ops: {
              botToken: "ops-token",
              allowedProjectIds: ["tau"],
              defaultProjectId: "tau",
            },
            docs: {
              botToken: "docs-token",
              allowedProjectIds: ["docs"],
              systemMessage: "docs only",
            },
          },
          projects: {
            tau: {
              repo: "markusylisiurunen/tau",
            },
            docs: {
              repo: "markusylisiurunen/docs",
            },
          },
        }),
      );

      const config = loadAsyncDaemonConfig(configPath);
      expect(config.telegram).toEqual({
        ops: {
          botToken: "ops-token",
          allowedProjectIds: ["tau"],
          defaultProjectId: "tau",
        },
        docs: {
          botToken: "docs-token",
          allowedProjectIds: ["docs"],
          systemMessage: "docs only",
        },
      });
    } finally {
      fx.cleanup();
    }
  });

  it("rejects unknown telegram allowedProjectIds", () => {
    const fx = setupFixture();

    try {
      const configPath = join(fx.root, "daemon.json");
      writeFileSync(
        configPath,
        JSON.stringify({
          telegram: {
            ops: {
              botToken: "ops-token",
              allowedProjectIds: ["missing"],
            },
          },
          projects: {
            tau: {
              repo: "markusylisiurunen/tau",
            },
          },
        }),
      );

      expect(() => loadAsyncDaemonConfig(configPath)).toThrow(AsyncDaemonConfigError);
      expect(() => loadAsyncDaemonConfig(configPath)).toThrow("allowedProjectIds");
    } finally {
      fx.cleanup();
    }
  });

  it("rejects defaultProjectId outside allowedProjectIds", () => {
    const fx = setupFixture();

    try {
      const configPath = join(fx.root, "daemon.json");
      writeFileSync(
        configPath,
        JSON.stringify({
          telegram: {
            ops: {
              botToken: "ops-token",
              allowedProjectIds: ["tau"],
              defaultProjectId: "docs",
            },
          },
          projects: {
            tau: {
              repo: "markusylisiurunen/tau",
            },
            docs: {
              repo: "markusylisiurunen/docs",
            },
          },
        }),
      );

      expect(() => loadAsyncDaemonConfig(configPath)).toThrow(AsyncDaemonConfigError);
      expect(() => loadAsyncDaemonConfig(configPath)).toThrow("defaultProjectId");
      expect(() => loadAsyncDaemonConfig(configPath)).toThrow("allowedProjectIds");
    } finally {
      fx.cleanup();
    }
  });

  it("rejects empty cron.systemMessage", () => {
    const fx = setupFixture();

    try {
      const configPath = join(fx.root, "daemon.json");
      writeFileSync(
        configPath,
        JSON.stringify({
          cron: {
            systemMessage: "",
          },
          projects: {
            tau: {
              repo: "markusylisiurunen/tau",
            },
          },
        }),
      );

      expect(() => loadAsyncDaemonConfig(configPath)).toThrow(AsyncDaemonConfigError);
      expect(() => loadAsyncDaemonConfig(configPath)).toThrow("cron.systemMessage");
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

  it("rejects absolute projects.<id>.workingDirectory values", () => {
    const fx = setupFixture();

    try {
      const configPath = join(fx.root, "daemon.json");
      writeFileSync(
        configPath,
        JSON.stringify({
          projects: {
            tau: {
              repo: "markusylisiurunen/tau",
              workingDirectory: "/tmp/repo",
            },
          },
        }),
      );

      expect(() => loadAsyncDaemonConfig(configPath)).toThrow(AsyncDaemonConfigError);
      expect(() => loadAsyncDaemonConfig(configPath)).toThrow(
        "workingDirectory must be a relative path",
      );
    } finally {
      fx.cleanup();
    }
  });

  it("rejects invalid backgroundBootstrapCommands values", () => {
    const fx = setupFixture();

    try {
      const configPath = join(fx.root, "daemon.json");
      writeFileSync(
        configPath,
        JSON.stringify({
          projects: {
            tau: {
              repo: "markusylisiurunen/tau",
              backgroundBootstrapCommands: ["npm run build", "   "],
            },
          },
        }),
      );

      expect(() => loadAsyncDaemonConfig(configPath)).toThrow(AsyncDaemonConfigError);
      expect(() => loadAsyncDaemonConfig(configPath)).toThrow("backgroundBootstrapCommands");
    } finally {
      fx.cleanup();
    }
  });

  it("skips disabled cron job markdown files", () => {
    const fx = setupFixture();

    try {
      const cronJobsDir = join(fx.root, "cron-jobs");
      mkdirSync(cronJobsDir, { recursive: true });

      writeCronJobFile(cronJobsDir, {
        id: "nightly",
        projectId: "tau",
        schedule: "0 2 * * *",
        prompt: "check docs drift",
        enabled: false,
      });

      const configPath = join(fx.root, "daemon.json");
      writeFileSync(
        configPath,
        JSON.stringify({
          projects: {
            tau: {
              repo: "markusylisiurunen/tau",
            },
          },
          cron: {
            jobsDir: "cron-jobs",
          },
        }),
      );

      const config = loadAsyncDaemonConfig(configPath);
      expect(config.cronJobs).toEqual({});
    } finally {
      fx.cleanup();
    }
  });

  it("rejects missing cron.jobsDir", () => {
    const fx = setupFixture();

    try {
      const configPath = join(fx.root, "daemon.json");
      writeFileSync(
        configPath,
        JSON.stringify({
          projects: {
            tau: {
              repo: "markusylisiurunen/tau",
            },
          },
          cron: {
            jobsDir: "cron-jobs",
          },
        }),
      );

      expect(() => loadAsyncDaemonConfig(configPath)).toThrow(AsyncDaemonConfigError);
      expect(() => loadAsyncDaemonConfig(configPath)).toThrow("cron.jobsDir does not exist");
    } finally {
      fx.cleanup();
    }
  });

  it("rejects cron jobs with invalid schedule expressions", () => {
    const fx = setupFixture();

    try {
      const cronJobsDir = join(fx.root, "cron-jobs");
      mkdirSync(cronJobsDir, { recursive: true });
      writeCronJobFile(cronJobsDir, {
        id: "nightly",
        projectId: "tau",
        schedule: "bad expression",
        prompt: "check docs drift",
      });

      const configPath = join(fx.root, "daemon.json");
      writeFileSync(
        configPath,
        JSON.stringify({
          projects: {
            tau: {
              repo: "markusylisiurunen/tau",
            },
          },
          cron: {
            jobsDir: "cron-jobs",
          },
        }),
      );

      expect(() => loadAsyncDaemonConfig(configPath)).toThrow(AsyncDaemonConfigError);
      expect(() => loadAsyncDaemonConfig(configPath)).toThrow("frontmatter schedule is invalid");
    } finally {
      fx.cleanup();
    }
  });

  it("rejects cron jobs that reference unknown projects", () => {
    const fx = setupFixture();

    try {
      const cronJobsDir = join(fx.root, "cron-jobs");
      mkdirSync(cronJobsDir, { recursive: true });
      writeCronJobFile(cronJobsDir, {
        id: "nightly",
        projectId: "missing",
        schedule: "0 2 * * *",
        prompt: "check docs drift",
      });

      const configPath = join(fx.root, "daemon.json");
      writeFileSync(
        configPath,
        JSON.stringify({
          projects: {
            tau: {
              repo: "markusylisiurunen/tau",
            },
          },
          cron: {
            jobsDir: "cron-jobs",
          },
        }),
      );

      expect(() => loadAsyncDaemonConfig(configPath)).toThrow(AsyncDaemonConfigError);
      expect(() => loadAsyncDaemonConfig(configPath)).toThrow(
        "frontmatter projectId refers to an unknown project",
      );
    } finally {
      fx.cleanup();
    }
  });
});
