import { join } from "node:path";
import type { Skill } from "../types.js";
import type { ConfigDeps } from "./deps.js";
import { createDefaultConfigDeps } from "./deps.js";
import { resolveConfigLevels } from "./paths.js";
import type { Config } from "./schema.js";
import { parseSkill } from "./skill_parser.js";
import { buildVirtualBundle } from "./virtual_bundle.js";

function loadSkillsFromDir(dir: string, deps: ConfigDeps): Skill[] {
  if (!deps.fs.exists(dir)) {
    return [];
  }

  let entries: string[];
  try {
    entries = deps.fs.listDir(dir);
  } catch {
    return [];
  }

  const skills: Skill[] = [];

  for (const entry of entries) {
    const skillDir = join(dir, entry);

    let stats: ReturnType<ConfigDeps["fs"]["stat"]>;
    try {
      stats = deps.fs.stat(skillDir);
    } catch {
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
      continue;
    }

    const result = parseSkill(skillFile, content);
    if (result.skill) {
      skills.push(result.skill);
    }
  }

  return skills;
}

export async function loadSkillsForPromptContext(args: {
  config?: Config;
  cwd: string;
  deps?: ConfigDeps;
}): Promise<Skill[]> {
  const deps = args.deps ?? createDefaultConfigDeps();
  const levels = resolveConfigLevels(deps, { cwd: args.cwd });

  const skillsByName = new Map<string, Skill>();

  const virtualBundle = buildVirtualBundle(args.config ?? {}, deps);
  for (const skill of virtualBundle.skills) {
    skillsByName.set(skill.name.toLowerCase(), skill);
  }

  const globalLevel = levels.find((level) => level.scope === "global");
  if (globalLevel) {
    for (const dir of [globalLevel.skillsDir, globalLevel.agentsSkillsDir]) {
      for (const skill of loadSkillsFromDir(dir, deps)) {
        skillsByName.set(skill.name.toLowerCase(), skill);
      }
    }
  }

  for (const level of levels.filter((entry) => entry.scope === "project")) {
    for (const dir of [level.skillsDir, level.agentsSkillsDir]) {
      for (const skill of loadSkillsFromDir(dir, deps)) {
        skillsByName.set(skill.name.toLowerCase(), skill);
      }
    }
  }

  return Array.from(skillsByName.values()).sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { sensitivity: "base" }),
  );
}
