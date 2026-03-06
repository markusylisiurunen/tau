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

function withFixture(run) {
  const fx = setupFixture();

  try {
    run(fx);
  } finally {
    fx.cleanup();
  }
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

function writeConfigFile(path, value) {
  writeFileSync(path, JSON.stringify(value));
}

function expectConfigError(configPath, ...messageParts) {
  expect(() => loadAsyncDaemonConfig(configPath)).toThrow(AsyncDaemonConfigError);
  for (const messagePart of messageParts) {
    expect(() => loadAsyncDaemonConfig(configPath)).toThrow(messagePart);
  }
}

describe("async daemon config", () => {
  it("loads valid daemon config and resolves workspace roots relative to config file", () => {
    withFixture((fx) => {
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
            default: {
              botToken: "bot-token",
              defaultProjectId: "tau",
              systemMessage: "telegram-specific notice",
            },
          },
          projects: {
            tau: {
              repo: "markusylisiurunen/tau",
              workspaceRoot: "projects/tau",
              workingDirectory: "packages/core",
              description: "core workspace",
              ref: "main",
              persona: "gpt-5.4-coder:high",
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
      expect(config.projects.tau.persona).toBe("gpt-5.4-coder:high");
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
    });
  });

  const unknownKeyCases = [
    {
      name: "rejects unknown top-level async daemon config keys",
      config: {
        projects: { tau: { repo: "markusylisiurunen/tau" } },
        extra: true,
      },
      errors: ["unknown key in config: extra"],
    },
    {
      name: "rejects unknown cron config keys",
      config: {
        projects: { tau: { repo: "markusylisiurunen/tau" } },
        cron: { jobsDir: "cron-jobs", extra: true },
      },
      errors: ["unknown key in cron: extra"],
    },
    {
      name: "rejects unknown telegram bot config keys",
      config: {
        telegram: { ops: { botToken: "ops-token", unknownSetting: true } },
        projects: { tau: { repo: "markusylisiurunen/tau" } },
      },
      errors: ["unknown key in telegram.ops: unknownSetting"],
    },
    {
      name: "rejects unknown project config keys",
      config: {
        projects: { tau: { repo: "markusylisiurunen/tau", unexpected: "value" } },
      },
      errors: ["unknown key in projects.tau: unexpected"],
    },
  ];

  for (const testCase of unknownKeyCases) {
    it(testCase.name, () => {
      withFixture((fx) => {
        const configPath = join(fx.root, "daemon.json");
        writeConfigFile(configPath, testCase.config);
        expectConfigError(configPath, ...testCase.errors);
      });
    });
  }

  const validationCases = [
    {
      name: "rejects empty systemMessage",
      config: { systemMessage: "   ", projects: { tau: { repo: "markusylisiurunen/tau" } } },
      errors: ["systemMessage"],
    },
    {
      name: "rejects empty telegram.systemMessage",
      config: {
        telegram: { default: { botToken: "bot-token", systemMessage: "" } },
        projects: { tau: { repo: "markusylisiurunen/tau" } },
      },
      errors: ["telegram.default.systemMessage"],
    },
    {
      name: "rejects empty cron.systemMessage",
      config: {
        cron: { systemMessage: "" },
        projects: { tau: { repo: "markusylisiurunen/tau" } },
      },
      errors: ["cron.systemMessage"],
    },
    {
      name: "rejects repos outside owner/repo format",
      config: {
        projects: { bad: { repo: "https://github.com/markusylisiurunen/tau.git" } },
      },
      errors: ["owner/repo"],
    },
    {
      name: "rejects invalid projects.<id>.persona reasoning suffixes",
      config: {
        projects: { tau: { repo: "markusylisiurunen/tau", persona: "gpt-5.4-coder:ultra" } },
      },
      errors: ["invalid reasoning level 'ultra'"],
    },
    {
      name: "rejects absolute projects.<id>.workingDirectory values",
      config: {
        projects: { tau: { repo: "markusylisiurunen/tau", workingDirectory: "/tmp/repo" } },
      },
      errors: ["workingDirectory must be a relative path"],
    },
    {
      name: "rejects invalid backgroundBootstrapCommands values",
      config: {
        projects: {
          tau: {
            repo: "markusylisiurunen/tau",
            backgroundBootstrapCommands: ["npm run build", "   "],
          },
        },
      },
      errors: ["backgroundBootstrapCommands"],
    },
  ];

  for (const testCase of validationCases) {
    it(testCase.name, () => {
      withFixture((fx) => {
        const configPath = join(fx.root, "daemon.json");
        writeConfigFile(configPath, testCase.config);
        expectConfigError(configPath, ...testCase.errors);
      });
    });
  }

  it("loads named telegram bots and keeps per-bot project allowlists", () => {
    withFixture((fx) => {
      const configPath = join(fx.root, "daemon.json");
      writeConfigFile(configPath, {
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
          tau: { repo: "markusylisiurunen/tau" },
          docs: { repo: "markusylisiurunen/docs" },
        },
      });

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
    });
  });

  it("rejects unknown telegram allowedProjectIds", () => {
    withFixture((fx) => {
      const configPath = join(fx.root, "daemon.json");
      writeConfigFile(configPath, {
        telegram: {
          ops: { botToken: "ops-token", allowedProjectIds: ["missing"] },
        },
        projects: {
          tau: { repo: "markusylisiurunen/tau" },
        },
      });

      expectConfigError(configPath, "allowedProjectIds");
    });
  });

  it("rejects defaultProjectId outside allowedProjectIds", () => {
    withFixture((fx) => {
      const configPath = join(fx.root, "daemon.json");
      writeConfigFile(configPath, {
        telegram: {
          ops: {
            botToken: "ops-token",
            allowedProjectIds: ["tau"],
            defaultProjectId: "docs",
          },
        },
        projects: {
          tau: { repo: "markusylisiurunen/tau" },
          docs: { repo: "markusylisiurunen/docs" },
        },
      });

      expectConfigError(configPath, "defaultProjectId", "allowedProjectIds");
    });
  });

  it("skips disabled cron job markdown files", () => {
    withFixture((fx) => {
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
      writeConfigFile(configPath, {
        projects: {
          tau: { repo: "markusylisiurunen/tau" },
        },
        cron: { jobsDir: "cron-jobs" },
      });

      const config = loadAsyncDaemonConfig(configPath);
      expect(config.cronJobs).toEqual({});
    });
  });

  const cronFrontmatterCases = [
    {
      name: "rejects unknown cron job frontmatter keys",
      contents: [
        "---",
        "id: nightly",
        "projectId: tau",
        'schedule: "0 2 * * *"',
        "unexpected: true",
        "---",
        "check docs drift",
        "",
      ].join("\n"),
      errors: ["unknown key in", "frontmatter: unexpected"],
    },
    {
      name: "rejects cron job frontmatter with missing closing delimiter",
      contents: [
        "---",
        "id: nightly",
        "projectId: tau",
        'schedule: "0 2 * * *"',
        "check docs",
      ].join("\n"),
      errors: ["frontmatter is missing a closing '---' delimiter", join("cron-jobs", "nightly.md")],
    },
    {
      name: "rejects cron job files with invalid frontmatter yaml",
      contents: [
        "---",
        "id: nightly",
        "projectId: tau",
        "schedule: [",
        "---",
        "check docs drift",
        "",
      ].join("\n"),
      errors: ["invalid frontmatter YAML", join("cron-jobs", "nightly.md")],
    },
    {
      name: "rejects cron job files with non-object frontmatter",
      contents: ["---", "- nightly", "---", "check docs"].join("\n"),
      errors: ["frontmatter must be a YAML object", join("cron-jobs", "nightly.md")],
    },
  ];

  for (const testCase of cronFrontmatterCases) {
    it(testCase.name, () => {
      withFixture((fx) => {
        const cronJobsDir = join(fx.root, "cron-jobs");
        mkdirSync(cronJobsDir, { recursive: true });
        writeFileSync(join(cronJobsDir, "nightly.md"), testCase.contents);

        const configPath = join(fx.root, "daemon.json");
        writeConfigFile(configPath, {
          projects: {
            tau: { repo: "markusylisiurunen/tau" },
          },
          cron: {
            jobsDir: "cron-jobs",
          },
        });

        expectConfigError(configPath, ...testCase.errors);
      });
    });
  }

  it("rejects missing cron.jobsDir", () => {
    withFixture((fx) => {
      const configPath = join(fx.root, "daemon.json");
      writeConfigFile(configPath, {
        projects: {
          tau: { repo: "markusylisiurunen/tau" },
        },
        cron: {
          jobsDir: "cron-jobs",
        },
      });

      expectConfigError(configPath, "cron.jobsDir does not exist");
    });
  });

  const cronJobValidationCases = [
    {
      name: "rejects cron jobs with invalid schedule expressions",
      cronJob: {
        id: "nightly",
        projectId: "tau",
        schedule: "bad expression",
        prompt: "check docs drift",
      },
      errors: ["frontmatter schedule is invalid"],
    },
    {
      name: "rejects cron jobs that reference unknown projects",
      cronJob: {
        id: "nightly",
        projectId: "missing",
        schedule: "0 2 * * *",
        prompt: "check docs drift",
      },
      errors: ["frontmatter projectId refers to an unknown project"],
    },
  ];

  for (const testCase of cronJobValidationCases) {
    it(testCase.name, () => {
      withFixture((fx) => {
        const cronJobsDir = join(fx.root, "cron-jobs");
        mkdirSync(cronJobsDir, { recursive: true });
        writeCronJobFile(cronJobsDir, testCase.cronJob);

        const configPath = join(fx.root, "daemon.json");
        writeConfigFile(configPath, {
          projects: {
            tau: { repo: "markusylisiurunen/tau" },
          },
          cron: {
            jobsDir: "cron-jobs",
          },
        });

        expectConfigError(configPath, ...testCase.errors);
      });
    });
  }
});
