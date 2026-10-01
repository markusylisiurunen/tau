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
import { loadSkillsFromToolBackend } from "../dist/core/config/runtime_config_snapshot.js";
import { loadSkillsContent } from "../dist/core/config/skills_loader.js";
import { buildVirtualBundle } from "../dist/core/config/virtual_bundle.js";
import { loadModelResolver } from "../dist/core/models/catalog.js";
import { createLocalToolExecutionBackend } from "../dist/core/tools/execution_backend.js";

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

async function loadAllContentWithModelResolver(config, options) {
  const levels = resolveConfigLevels(options.deps, { cwd: options.cwd });
  const modelResolver = loadModelResolver();
  return await loadAllContent(config, {
    deps: options.deps,
    levels,
    modelResolver: modelResolver.resolveModel,
    virtualBundle: buildVirtualBundle(modelResolver.resolveConfiguredModel),
  });
}

describe("skills discovery", () => {
  it("collects only skills with the same scope and precedence as runtime discovery", async () => {
    const fx = setupFixture();
    try {
      writeSkill(join(fx.home, ".config", "tau", "skills"), "shared", "global");
      writeSkill(join(fx.home, ".config", "tau", "skills"), "global-only", "global only");
      writeSkill(join(fx.home, "repo", ".agents", "skills"), "shared", "parent");
      writeSkill(join(fx.cwd, ".agents", "skills"), "shared", "agents");
      writeSkill(join(fx.cwd, ".tau", "skills"), "shared", "nearest tau");
      mkdirSync(join(fx.cwd, ".tau", "personas"), { recursive: true });
      writeFileSync(join(fx.cwd, ".tau", "personas", "huge.md"), "x".repeat(2_000_000));
      writeFileSync(join(fx.cwd, ".tau", "config.json"), "invalid config");
      const backend = createLocalToolExecutionBackend();
      const collected = [];
      const focusedBackend = {
        runNodeScript: async (...args) => {
          const result = await backend.runNodeScript(...args);
          collected.push(...JSON.parse(result.output).files);
          return result;
        },
      };
      const result = await loadSkillsFromToolBackend({
        backend: focusedBackend,
        cwd: fx.cwd,
        home: fx.home,
      });
      expect(result.errors).toEqual([]);
      expect(result.skills).toEqual([
        {
          name: "global-only",
          description: "global only",
          path: join(fx.home, ".config", "tau", "skills", "global-only", "SKILL.md"),
        },
        {
          name: "shared",
          description: "nearest tau",
          path: join(fx.cwd, ".tau", "skills", "shared", "SKILL.md"),
        },
      ]);
      expect(collected.every((file) => file.path.endsWith("/SKILL.md"))).toBe(true);
      const outsideHome = await loadSkillsFromToolBackend({
        backend,
        cwd: fx.cwd,
        home: join(fx.home, "other"),
      });
      expect(outsideHome.skills).toEqual(
        result.skills.filter((skill) => skill.name !== "global-only"),
      );
    } finally {
      fx.cleanup();
    }
  });

  it("loads project skills from .agents/skills when .tau is absent", async () => {
    const fx = setupFixture();

    try {
      const skillsDir = join(fx.cwd, ".agents", "skills");
      writeSkill(skillsDir, "alpha", "alpha from agents");

      const deps = createConfigDeps({ cwd: fx.cwd, home: fx.home });
      const { skills, errors } = await loadAllContentWithModelResolver(
        {},
        {
          deps,
          cwd: fx.cwd,
        },
      );

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

      const { skills, errors } = await loadAllContentWithModelResolver(
        {},
        {
          deps,
          cwd: fx.cwd,
        },
      );
      expect(errors).toEqual([]);
      expect(skills.map((skill) => skill.name)).toEqual(["pkg-skill", "root-skill"]);
    } finally {
      fx.cleanup();
    }
  });

  it("prefers .tau/skills over .agents/skills at the same level", async () => {
    const fx = setupFixture();

    try {
      const repoRoot = join(fx.home, "repo");
      writeSkill(join(repoRoot, ".tau", "skills"), "shared", "from tau");
      writeSkill(join(repoRoot, ".agents", "skills"), "shared", "from agents");

      const deps = createConfigDeps({ cwd: fx.cwd, home: fx.home });
      const { skills, errors } = await loadAllContentWithModelResolver(
        {},
        {
          deps,
          cwd: fx.cwd,
        },
      );
      expect(errors).toEqual([]);

      const shared = skills.find((skill) => skill.name === "shared");
      expect(shared).toBeTruthy();
      expect(shared.description).toBe("from tau");
      expect(shared.path).toBe(join(repoRoot, ".tau", "skills", "shared", "SKILL.md"));
    } finally {
      fx.cleanup();
    }
  });

  it("keeps nearest-project precedence above Tau-specific same-level precedence", async () => {
    const fx = setupFixture();

    try {
      writeSkill(join(fx.home, ".config", "tau", "skills"), "shared", "global tau");
      writeSkill(join(fx.home, ".agents", "skills"), "shared", "global agents");
      const deps = createConfigDeps({ cwd: fx.cwd, home: fx.home });
      const options = { deps, levels: resolveConfigLevels(deps, { cwd: fx.cwd }) };
      const global = await loadSkillsContent(options);
      expect(global.errors).toEqual([]);
      expect(global.skills.find((skill) => skill.name === "shared").description).toBe("global tau");

      writeSkill(join(fx.home, "repo", ".tau", "skills"), "shared", "parent tau");
      writeSkill(join(fx.cwd, ".agents", "skills"), "shared", "nearest agents");
      const project = await loadSkillsContent({
        deps,
        levels: resolveConfigLevels(deps, { cwd: fx.cwd }),
      });
      expect(project.errors).toEqual([]);
      expect(project.skills.find((skill) => skill.name === "shared").description).toBe(
        "nearest agents",
      );
    } finally {
      fx.cleanup();
    }
  });

  it("returns explicit diagnostics for invalid skill names", async () => {
    const fx = setupFixture();

    try {
      const invalidDir = join(fx.cwd, ".tau", "skills", "bad--skill");
      mkdirSync(invalidDir, { recursive: true });
      writeFileSync(
        join(invalidDir, "SKILL.md"),
        ["---", "name: bad--skill", "description: bad", "---", ""].join("\n"),
      );

      const deps = createConfigDeps({ cwd: fx.cwd, home: fx.home });
      const { skills, errors } = await loadSkillsContent({
        deps,
        levels: resolveConfigLevels(deps, { cwd: fx.cwd }),
      });

      expect(skills).toEqual([]);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain("invalid frontmatter");
    } finally {
      fx.cleanup();
    }
  });

  it("surfaces skill frontmatter YAML parse errors", async () => {
    const fx = setupFixture();

    try {
      const invalidDir = join(fx.cwd, ".tau", "skills", "broken");
      mkdirSync(invalidDir, { recursive: true });
      writeFileSync(
        join(invalidDir, "SKILL.md"),
        ["---", "name broken", "description: bad", "---", ""].join("\n"),
      );

      const deps = createConfigDeps({ cwd: fx.cwd, home: fx.home });
      const { skills, errors } = await loadSkillsContent({
        deps,
        levels: resolveConfigLevels(deps, { cwd: fx.cwd }),
      });

      expect(skills).toEqual([]);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain("invalid frontmatter YAML");
    } finally {
      fx.cleanup();
    }
  });

  it("surfaces skill frontmatter non-object errors", async () => {
    const fx = setupFixture();

    try {
      const invalidDir = join(fx.cwd, ".tau", "skills", "broken");
      mkdirSync(invalidDir, { recursive: true });
      writeFileSync(
        join(invalidDir, "SKILL.md"),
        ["---", "- not", "- object", "---", ""].join("\n"),
      );

      const deps = createConfigDeps({ cwd: fx.cwd, home: fx.home });
      const { skills, errors } = await loadSkillsContent({
        deps,
        levels: resolveConfigLevels(deps, { cwd: fx.cwd }),
      });

      expect(skills).toEqual([]);
      expect(errors).toHaveLength(1);
      expect(errors[0]).toContain("frontmatter must be a YAML object");
    } finally {
      fx.cleanup();
    }
  });

  it("loads user skills from ~/.agents/skills", async () => {
    const fx = setupFixture();

    try {
      writeSkill(join(fx.home, ".agents", "skills"), "global-agent", "from global agents");

      const deps = createConfigDeps({ cwd: fx.cwd, home: fx.home });
      const { skills, errors } = await loadAllContentWithModelResolver(
        {},
        {
          deps,
          cwd: fx.cwd,
        },
      );
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
