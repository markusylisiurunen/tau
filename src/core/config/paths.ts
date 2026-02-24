import { dirname, join, parse, resolve, sep } from "node:path";
import type { ConfigDeps } from "./deps.js";

export type ConfigLevelScope = "global" | "project" | "builtin";

export type ConfigLevel = {
  levelRoot: string;
  configDir: string;
  configPath: string;
  modelsPath: string;
  personasDir: string;
  promptsDir: string;
  skillsDir: string;
  agentsSkillsDir: string;
  themesDir: string;
  scope: ConfigLevelScope;
};

function buildLevel(levelRoot: string, configDir: string, scope: ConfigLevelScope): ConfigLevel {
  const root = resolve(levelRoot);
  const dir = resolve(configDir);
  return {
    levelRoot: root,
    configDir: dir,
    configPath: join(dir, "config.json"),
    modelsPath: join(dir, "models.json"),
    personasDir: join(dir, "personas"),
    promptsDir: join(dir, "prompts"),
    skillsDir: join(dir, "skills"),
    agentsSkillsDir: join(root, ".agents", "skills"),
    themesDir: join(dir, "themes"),
    scope,
  };
}

function isDirectory(deps: ConfigDeps, path: string): boolean {
  if (!deps.fs.exists(path)) {
    return false;
  }
  try {
    return deps.fs.stat(path).isDirectory();
  } catch {
    return false;
  }
}

export function resolveConfigLevels(deps: ConfigDeps, options: { cwd: string }): ConfigLevel[] {
  const cwdAbs = resolve(options.cwd);
  const homeAbs = resolve(deps.env.home());

  const withinHome = cwdAbs === homeAbs || cwdAbs.startsWith(homeAbs + sep);
  const stopAbs = withinHome ? homeAbs : parse(cwdAbs).root;

  const levels: ConfigLevel[] = [];
  if (withinHome) {
    levels.push(buildLevel(homeAbs, join(homeAbs, ".config", "tau"), "global"));
  }

  const projectLevels: ConfigLevel[] = [];
  let dir = cwdAbs;

  while (true) {
    const configDir = join(dir, ".tau");
    const agentsSkillsDir = join(dir, ".agents", "skills");
    if (isDirectory(deps, configDir) || isDirectory(deps, agentsSkillsDir)) {
      projectLevels.push(buildLevel(dir, configDir, "project"));
    }

    if (dir === stopAbs) break;

    const parent = dirname(dir);
    if (parent === dir) break;

    dir = parent;
  }

  projectLevels.reverse();
  levels.push(...projectLevels);

  return levels;
}
