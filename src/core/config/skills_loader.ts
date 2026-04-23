import { join } from "node:path";
import type { Skill } from "../types.js";
import type { ConfigDeps } from "./deps.js";
import type { ConfigLevel } from "./paths.js";
import { resolveConfigLevels } from "./paths.js";
import type { Config } from "./schema.js";
import { parseSkill } from "./skill_parser.js";

export type SkillsLoadResult = {
  skills: Skill[];
  errors: string[];
};

function loadSkillsFromDir(dir: string, deps: ConfigDeps): SkillsLoadResult {
  if (!deps.fs.exists(dir)) {
    return { skills: [], errors: [] };
  }

  let entries: string[];
  try {
    entries = deps.fs.listDir(dir);
  } catch {
    return { skills: [], errors: [`failed to read directory: ${dir}`] };
  }

  const skills: Skill[] = [];
  const errors: string[] = [];

  for (const entry of entries) {
    const skillDir = join(dir, entry);

    let stats: ReturnType<ConfigDeps["fs"]["stat"]>;
    try {
      stats = deps.fs.stat(skillDir);
    } catch {
      errors.push(`failed to stat path: ${skillDir}`);
      continue;
    }
    if (!stats.isDirectory()) {
      continue;
    }

    const skillFile = join(skillDir, "SKILL.md");
    if (!deps.fs.exists(skillFile)) {
      continue;
    }

    let content = "";
    try {
      content = deps.fs.readFile(skillFile);
    } catch {
      errors.push(`failed to read file: ${skillFile}`);
      continue;
    }

    const result = parseSkill(skillFile, content);
    if (result.skill) {
      skills.push(result.skill);
      continue;
    }
    if (result.error) {
      errors.push(result.error);
    }
  }

  return { skills, errors };
}

export async function loadSkillsContent(
  _config: Config | undefined,
  options: { deps: ConfigDeps; levels: ConfigLevel[] },
): Promise<SkillsLoadResult> {
  const deps = options.deps;
  const levels = options.levels;

  const skillsByName = new Map<string, Skill>();
  const errors: string[] = [];

  for (const level of levels) {
    for (const dir of [level.skillsDir, level.agentsSkillsDir]) {
      const result = loadSkillsFromDir(dir, deps);
      errors.push(...result.errors);
      for (const skill of result.skills) {
        skillsByName.set(skill.name.toLowerCase(), skill);
      }
    }
  }

  const skills = Array.from(skillsByName.values()).sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
  );

  return { skills, errors };
}

export async function loadSkillsForPromptContext(args: {
  config?: Config;
  cwd: string;
  deps: ConfigDeps;
}): Promise<SkillsLoadResult> {
  const levels = resolveConfigLevels(args.deps, { cwd: args.cwd });
  return loadSkillsContent(args.config, {
    deps: args.deps,
    levels,
  });
}
