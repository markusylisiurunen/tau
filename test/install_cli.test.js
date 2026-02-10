import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { InstallCliError, runInstallCommand } from "../dist/core/install/cli.js";

function setupFixture() {
  const root = mkdtempSync(join(tmpdir(), "tau-install-"));
  const cwd = join(root, "workspace");
  const home = join(root, "home");
  const starter = join(root, "starter");

  mkdirSync(cwd, { recursive: true });
  mkdirSync(home, { recursive: true });
  mkdirSync(join(starter, "prompts"), { recursive: true });
  mkdirSync(join(starter, "skills", "greet"), { recursive: true });
  mkdirSync(join(starter, "skills", "wave"), { recursive: true });

  writeFileSync(
    join(starter, "prompts", "sample.md"),
    ["---", "id: sample", "---", "", "hello prompt"].join("\n"),
  );

  writeFileSync(
    join(starter, "prompts", "review.md"),
    ["---", "id: review", "---", "", "review prompt"].join("\n"),
  );

  writeFileSync(
    join(starter, "skills", "greet", "SKILL.md"),
    [
      "---",
      "name: greet",
      "description: greet skill. Trigger: explicit.",
      "---",
      "",
      "say hi",
    ].join("\n"),
  );

  writeFileSync(
    join(starter, "skills", "wave", "SKILL.md"),
    [
      "---",
      "name: wave",
      "description: wave skill. Trigger: explicit.",
      "---",
      "",
      "wave hello",
    ].join("\n"),
  );

  return {
    cwd,
    home,
    starter,
    cleanup: () => rmSync(root, { recursive: true, force: true }),
  };
}

describe("install cli", () => {
  it("installs starter content to .tau in cwd by default", async () => {
    const fx = setupFixture();
    try {
      await runInstallCommand([], {
        cwd: fx.cwd,
        home: fx.home,
        starterContentRoot: fx.starter,
        log: () => {},
      });

      expect(existsSync(join(fx.cwd, ".tau", "prompts", "sample.md"))).toBe(true);
      expect(existsSync(join(fx.cwd, ".tau", "prompts", "review.md"))).toBe(true);
      expect(existsSync(join(fx.cwd, ".tau", "skills", "greet", "SKILL.md"))).toBe(true);
      expect(existsSync(join(fx.cwd, ".tau", "skills", "wave", "SKILL.md"))).toBe(true);
    } finally {
      fx.cleanup();
    }
  });

  it("installs starter content to global config with --global", async () => {
    const fx = setupFixture();
    try {
      await runInstallCommand(["--global"], {
        cwd: fx.cwd,
        home: fx.home,
        starterContentRoot: fx.starter,
        log: () => {},
      });

      expect(existsSync(join(fx.home, ".config", "tau", "prompts", "sample.md"))).toBe(true);
      expect(existsSync(join(fx.home, ".config", "tau", "prompts", "review.md"))).toBe(true);
      expect(existsSync(join(fx.home, ".config", "tau", "skills", "greet", "SKILL.md"))).toBe(true);
      expect(existsSync(join(fx.home, ".config", "tau", "skills", "wave", "SKILL.md"))).toBe(true);
    } finally {
      fx.cleanup();
    }
  });

  it("installs only the selected prompt with --prompt", async () => {
    const fx = setupFixture();
    try {
      await runInstallCommand(["--prompt", "sample"], {
        cwd: fx.cwd,
        home: fx.home,
        starterContentRoot: fx.starter,
        log: () => {},
      });

      expect(existsSync(join(fx.cwd, ".tau", "prompts", "sample.md"))).toBe(true);
      expect(existsSync(join(fx.cwd, ".tau", "prompts", "review.md"))).toBe(false);
      expect(existsSync(join(fx.cwd, ".tau", "skills", "greet", "SKILL.md"))).toBe(false);
    } finally {
      fx.cleanup();
    }
  });

  it("installs only the selected skill with --skill", async () => {
    const fx = setupFixture();
    try {
      await runInstallCommand(["--skill", "greet"], {
        cwd: fx.cwd,
        home: fx.home,
        starterContentRoot: fx.starter,
        log: () => {},
      });

      expect(existsSync(join(fx.cwd, ".tau", "skills", "greet", "SKILL.md"))).toBe(true);
      expect(existsSync(join(fx.cwd, ".tau", "skills", "wave", "SKILL.md"))).toBe(false);
      expect(existsSync(join(fx.cwd, ".tau", "prompts", "sample.md"))).toBe(false);
    } finally {
      fx.cleanup();
    }
  });

  it("skips existing prompt files and skill directories without --force", async () => {
    const fx = setupFixture();
    try {
      const targetPromptPath = join(fx.cwd, ".tau", "prompts", "sample.md");
      const targetSkillDir = join(fx.cwd, ".tau", "skills", "greet");
      const targetSkillPath = join(targetSkillDir, "SKILL.md");

      mkdirSync(join(fx.cwd, ".tau", "prompts"), { recursive: true });
      mkdirSync(targetSkillDir, { recursive: true });
      writeFileSync(targetPromptPath, "existing prompt");
      writeFileSync(targetSkillPath, "existing skill");

      const logs = [];
      await runInstallCommand([], {
        cwd: fx.cwd,
        home: fx.home,
        starterContentRoot: fx.starter,
        log: (line) => logs.push(line),
      });

      expect(readFileSync(targetPromptPath, "utf-8")).toBe("existing prompt");
      expect(readFileSync(targetSkillPath, "utf-8")).toBe("existing skill");
      expect(logs.join("\n")).toContain("skipped prompt 'sample'");
      expect(logs.join("\n")).toContain("skipped skill 'greet'");
    } finally {
      fx.cleanup();
    }
  });

  it("overwrites existing content with --force", async () => {
    const fx = setupFixture();
    try {
      const targetPromptPath = join(fx.cwd, ".tau", "prompts", "sample.md");
      const targetSkillDir = join(fx.cwd, ".tau", "skills", "greet");
      const targetSkillPath = join(targetSkillDir, "SKILL.md");
      const staleSkillPath = join(targetSkillDir, "stale.txt");

      mkdirSync(join(fx.cwd, ".tau", "prompts"), { recursive: true });
      mkdirSync(targetSkillDir, { recursive: true });
      writeFileSync(targetPromptPath, "existing prompt");
      writeFileSync(targetSkillPath, "existing skill");
      writeFileSync(staleSkillPath, "stale data");

      await runInstallCommand(["--force"], {
        cwd: fx.cwd,
        home: fx.home,
        starterContentRoot: fx.starter,
        log: () => {},
      });

      expect(readFileSync(targetPromptPath, "utf-8")).toContain("id: sample");
      expect(readFileSync(targetSkillPath, "utf-8")).toContain("name: greet");
      expect(existsSync(staleSkillPath)).toBe(false);
    } finally {
      fx.cleanup();
    }
  });

  it("overwrites only the selected prompt with --prompt and --force", async () => {
    const fx = setupFixture();
    try {
      await runInstallCommand([], {
        cwd: fx.cwd,
        home: fx.home,
        starterContentRoot: fx.starter,
        log: () => {},
      });

      const samplePromptPath = join(fx.cwd, ".tau", "prompts", "sample.md");
      const reviewPromptPath = join(fx.cwd, ".tau", "prompts", "review.md");

      writeFileSync(samplePromptPath, "local sample prompt");
      writeFileSync(reviewPromptPath, "local review prompt");

      await runInstallCommand(["--prompt", "sample", "--force"], {
        cwd: fx.cwd,
        home: fx.home,
        starterContentRoot: fx.starter,
        log: () => {},
      });

      expect(readFileSync(samplePromptPath, "utf-8")).toContain("id: sample");
      expect(readFileSync(reviewPromptPath, "utf-8")).toBe("local review prompt");
    } finally {
      fx.cleanup();
    }
  });

  it("overwrites a prompt directory target with --force", async () => {
    const fx = setupFixture();
    try {
      const promptsDir = join(fx.cwd, ".tau", "prompts");
      const samplePromptPath = join(promptsDir, "sample.md");

      mkdirSync(samplePromptPath, { recursive: true });

      await runInstallCommand(["--prompt", "sample", "--force"], {
        cwd: fx.cwd,
        home: fx.home,
        starterContentRoot: fx.starter,
        log: () => {},
      });

      expect(readFileSync(samplePromptPath, "utf-8")).toContain("id: sample");
    } finally {
      fx.cleanup();
    }
  });

  it("throws for empty prompt values", async () => {
    const fx = setupFixture();
    try {
      await expect(
        runInstallCommand(["--prompt", "   "], {
          cwd: fx.cwd,
          home: fx.home,
          starterContentRoot: fx.starter,
          log: () => {},
        }),
      ).rejects.toBeInstanceOf(InstallCliError);
    } finally {
      fx.cleanup();
    }
  });

  it("throws for empty skill values", async () => {
    const fx = setupFixture();
    try {
      await expect(
        runInstallCommand(["--skill", "   "], {
          cwd: fx.cwd,
          home: fx.home,
          starterContentRoot: fx.starter,
          log: () => {},
        }),
      ).rejects.toBeInstanceOf(InstallCliError);
    } finally {
      fx.cleanup();
    }
  });

  it("throws for unknown options", async () => {
    await expect(runInstallCommand(["--nope"], { log: () => {} })).rejects.toBeInstanceOf(
      InstallCliError,
    );
  });

  it("throws for unknown starter prompt", async () => {
    const fx = setupFixture();
    try {
      await expect(
        runInstallCommand(["--prompt", "missing"], {
          cwd: fx.cwd,
          home: fx.home,
          starterContentRoot: fx.starter,
          log: () => {},
        }),
      ).rejects.toBeInstanceOf(InstallCliError);
    } finally {
      fx.cleanup();
    }
  });

  it("throws when --prompt and --skill are combined", async () => {
    const fx = setupFixture();
    try {
      await expect(
        runInstallCommand(["--prompt", "sample", "--skill", "greet"], {
          cwd: fx.cwd,
          home: fx.home,
          starterContentRoot: fx.starter,
          log: () => {},
        }),
      ).rejects.toBeInstanceOf(InstallCliError);
    } finally {
      fx.cleanup();
    }
  });
});
