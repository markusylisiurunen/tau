import { dirname, join, resolve } from "node:path";
import type { ConfigDeps } from "./deps.js";

export type ConfigLevelScope = "global" | "project";

export type ConfigLevel = {
  levelRoot: string;
  configDir: string;
  configPath: string;
  personasDir: string;
  promptsDir: string;
  skillsDir: string;
  agentsSkillsDir: string;
  scope: ConfigLevelScope;
};

function buildLevel(levelRoot: string, configDir: string, scope: ConfigLevelScope): ConfigLevel {
  const root = resolve(levelRoot);
  const dir = resolve(configDir);
  return {
    levelRoot: root,
    configDir: dir,
    configPath: join(dir, "config.json"),
    personasDir: join(dir, "personas"),
    promptsDir: join(dir, "prompts"),
    skillsDir: join(dir, "skills"),
    agentsSkillsDir: join(root, ".agents", "skills"),
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

function projectRoots(cwd: string): string[] {
  const roots: string[] = [];
  for (let dir = resolve(cwd); ; dir = dirname(dir)) {
    roots.push(dir);
    if (dirname(dir) === dir) return roots.reverse();
  }
}

export function configLevels(home: string, cwd: string): ConfigLevel[] {
  return [
    buildLevel(home, join(home, ".config", "tau"), "global"),
    ...projectRoots(cwd).map((root) => buildLevel(root, join(root, ".tau"), "project")),
  ];
}

export function resolveConfigLevels(deps: ConfigDeps, options: { cwd: string }): ConfigLevel[] {
  return configLevels(deps.env.home(), options.cwd).filter(
    (level) =>
      level.scope === "global" ||
      isDirectory(deps, level.configDir) ||
      isDirectory(deps, level.agentsSkillsDir),
  );
}
