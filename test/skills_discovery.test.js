import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { loadAllContent, resolveConfigLevels } from "../dist/core/config/index.js";

function createConfigDeps({ cwd, home }) {
  return {
    fs: {
      readFile: (path) => readFileSync(path, "utf-8"),
      exists: (path) => existsSync(path),
      listDir: (path) => readdirSync(path),
      stat: (path) => statSync(path),
    },
    env: {
      getEnv: () => ({}),
      cwd: () => cwd,
      home: () => home,
    },
  };
}

function setupFixture() {
  const home = mkdtempSync(join(tmpdir(), "tau-skills-home-"));
  const cwd = join(home, "repo", "packages", "app");
  mkdirSync(cwd, { recursive: true });

  return {
    home: resolve(home),
    cwd: resolve(cwd),
    cleanup: () => {
      rmSync(home, { recursive: true, force: true });
    },
  };
}

function writeSkill(skillsDir, name, description) {
  const skillDir = join(skillsDir, name);
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    join(skillDir, "SKILL.md"),
    ["---", `name: ${name}`, `description: ${description}`, "---", ""].join("\n"),
  );
}

describe("skills discovery", () => {
  it("loads project skills from .agents/skills when .tau is absent", async () => {
    const fx = setupFixture();

    try {
      const skillsDir = join(fx.cwd, ".agents", "skills");
      writeSkill(skillsDir, "alpha", "alpha from agents");

      const deps = createConfigDeps({ cwd: fx.cwd, home: fx.home });
      const { skills, errors } = await loadAllContent({}, { deps, cwd: fx.cwd });

      expect(errors).toEqual([]);
      expect(skills.map((skill) => skill.name)).toEqual(["alpha"]);
      expect(skills[0].description).toBe("alpha from agents");
      expect(skills[0].path).toBe(join(skillsDir, "alpha", "SKILL.md"));
    } finally {
      fx.cleanup();
    }
  });

  it("traverses .agents/skills up the cwd ancestry", async () => {
    const fx = setupFixture();

    try {
      const repoRoot = join(fx.home, "repo");
      const packageRoot = join(repoRoot, "packages");
      writeSkill(join(repoRoot, ".agents", "skills"), "root-skill", "from repo root");
      writeSkill(join(packageRoot, ".agents", "skills"), "pkg-skill", "from package root");

      const deps = createConfigDeps({ cwd: fx.cwd, home: fx.home });
      const levels = resolveConfigLevels(deps, { cwd: fx.cwd })
        .filter((level) => level.scope === "project")
        .map((level) => level.levelRoot);
      expect(levels).toEqual([repoRoot, packageRoot]);

      const { skills, errors } = await loadAllContent({}, { deps, cwd: fx.cwd });
      expect(errors).toEqual([]);
      expect(skills.map((skill) => skill.name)).toEqual(["pkg-skill", "root-skill"]);
    } finally {
      fx.cleanup();
    }
  });

  it("prefers .agents/skills over .tau/skills at the same level", async () => {
    const fx = setupFixture();

    try {
      const repoRoot = join(fx.home, "repo");
      writeSkill(join(repoRoot, ".tau", "skills"), "shared", "from tau");
      writeSkill(join(repoRoot, ".agents", "skills"), "shared", "from agents");

      const deps = createConfigDeps({ cwd: fx.cwd, home: fx.home });
      const { skills, errors } = await loadAllContent({}, { deps, cwd: fx.cwd });
      expect(errors).toEqual([]);

      const shared = skills.find((skill) => skill.name === "shared");
      expect(shared).toBeTruthy();
      expect(shared.description).toBe("from agents");
      expect(shared.path).toBe(join(repoRoot, ".agents", "skills", "shared", "SKILL.md"));
    } finally {
      fx.cleanup();
    }
  });

  it("loads user skills from ~/.agents/skills", async () => {
    const fx = setupFixture();

    try {
      writeSkill(join(fx.home, ".agents", "skills"), "global-agent", "from global agents");

      const deps = createConfigDeps({ cwd: fx.cwd, home: fx.home });
      const { skills, errors } = await loadAllContent({}, { deps, cwd: fx.cwd });
      expect(errors).toEqual([]);

      const globalAgent = skills.find((skill) => skill.name === "global-agent");
      expect(globalAgent).toBeTruthy();
      expect(globalAgent.description).toBe("from global agents");
      expect(globalAgent.path).toBe(join(fx.home, ".agents", "skills", "global-agent", "SKILL.md"));
    } finally {
      fx.cleanup();
    }
  });
});
