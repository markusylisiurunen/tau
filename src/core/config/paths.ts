import { dirname, join, resolve, sep } from "node:path";
import { getGitRoot } from "../utils/git.js";
import type { ConfigDeps } from "./deps.js";

export type UserContentDirs = {
  personas: string;
  prompts: string;
  skills: string;
};

export type ProjectContentDirs = {
  personas: string[];
  prompts: string[];
  skills: string[];
};

export type ConfigPaths = {
  configHome: string;
  userConfigDir: string;
  userConfigPath: string;
  projectConfigDir?: string;
  projectConfigPath?: string;
  userContentDirs: UserContentDirs;
  projectContentDirs: ProjectContentDirs;
  repoRoot?: string;
};

function resolveConfigHome(env: NodeJS.ProcessEnv, home: string): string {
  const xdgConfigHome = env.XDG_CONFIG_HOME;
  if (xdgConfigHome && xdgConfigHome.trim()) {
    return xdgConfigHome;
  }
  return join(home, ".config");
}

function resolveSearchStop(cwdAbs: string, homeAbs: string, repoRootAbs?: string): string {
  if (repoRootAbs && (cwdAbs === repoRootAbs || cwdAbs.startsWith(repoRootAbs + sep))) {
    return repoRootAbs;
  }

  if (cwdAbs === homeAbs || cwdAbs.startsWith(homeAbs + sep)) {
    return homeAbs;
  }

  return cwdAbs;
}

function findProjectTauDirs(args: {
  deps: ConfigDeps;
  cwd: string;
  home: string;
  repoRoot?: string;
  subdir: "personas" | "prompts" | "skills";
}): string[] {
  const cwdAbs = resolve(args.cwd);
  const homeAbs = resolve(args.home);
  const repoRootAbs = args.repoRoot ? resolve(args.repoRoot) : undefined;

  const stopAbs = resolveSearchStop(cwdAbs, homeAbs, repoRootAbs);

  const found: string[] = [];
  let dir = cwdAbs;

  while (true) {
    const candidate = join(dir, ".tau", args.subdir);
    if (args.deps.fs.exists(candidate)) {
      found.push(candidate);
    }

    if (dir === stopAbs) break;

    const parent = dirname(dir);
    if (parent === dir) break;

    dir = parent;
  }

  return found;
}

export function resolveConfigPaths(
  deps: ConfigDeps,
  options?: { cwd?: string; repoRoot?: string },
): ConfigPaths {
  const cwd = options?.cwd ?? deps.env.cwd();
  const home = deps.env.home();
  const env = deps.env.getEnv();

  const configHome = resolveConfigHome(env, home);
  const userConfigDir = join(configHome, "tau");
  const userConfigPath = join(userConfigDir, "config.json");

  const repoRoot = options?.repoRoot ?? getGitRoot(cwd);
  const projectConfigDir = repoRoot ? join(repoRoot, ".tau") : undefined;
  const projectConfigPath = projectConfigDir ? join(projectConfigDir, "config.json") : undefined;

  const userContentDirs = {
    personas: join(userConfigDir, "personas"),
    prompts: join(userConfigDir, "prompts"),
    skills: join(userConfigDir, "skills"),
  };

  const projectContentDirs = {
    personas: findProjectTauDirs({ deps, cwd, home, repoRoot, subdir: "personas" }),
    prompts: findProjectTauDirs({ deps, cwd, home, repoRoot, subdir: "prompts" }),
    skills: findProjectTauDirs({ deps, cwd, home, repoRoot, subdir: "skills" }),
  };

  return {
    configHome,
    userConfigDir,
    userConfigPath,
    projectConfigDir,
    projectConfigPath,
    userContentDirs,
    projectContentDirs,
    repoRoot,
  };
}
