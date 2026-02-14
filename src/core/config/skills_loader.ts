import { join, resolve, sep } from "node:path";
import { parse as parseYaml } from "yaml";
import type { Skill } from "../types.js";
import type { ConfigDeps } from "./deps.js";
import { createDefaultConfigDeps } from "./deps.js";
import { resolveConfigLevels } from "./paths.js";
import type { Config } from "./schema.js";
import { buildVirtualBundle } from "./virtual_bundle.js";

const SKILL_NAME_REGEX = /^[a-z0-9-]{1,64}$/;

function parseSkillFrontMatter(content: string): { name: string; description: string } | undefined {
  const lines = content.split("\n");
  if (lines[0]?.trim() !== "---") {
    return undefined;
  }

  let endIndex = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]?.trim() === "---") {
      endIndex = i;
      break;
    }
  }

  if (endIndex === -1) {
    return undefined;
  }

  const frontMatterText = lines.slice(1, endIndex).join("\n");

  let parsed: unknown;
  try {
    parsed = parseYaml(frontMatterText);
  } catch {
    return undefined;
  }

  if (!parsed || typeof parsed !== "object") {
    return undefined;
  }

  const data = parsed as Record<string, unknown>;
  const name = typeof data.name === "string" ? data.name.trim() : "";
  const description = typeof data.description === "string" ? data.description.trim() : "";

  if (!SKILL_NAME_REGEX.test(name)) {
    return undefined;
  }

  if (!description || description.length > 1024) {
    return undefined;
  }

  return { name, description };
}

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

    const frontMatter = parseSkillFrontMatter(content);
    if (!frontMatter) {
      continue;
    }

    const dirName = skillDir.split(sep).pop();
    if (!dirName || dirName !== frontMatter.name) {
      continue;
    }

    skills.push({
      name: frontMatter.name,
      description: frontMatter.description,
      path: resolve(skillFile),
    });
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
