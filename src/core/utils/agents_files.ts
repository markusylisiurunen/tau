import { existsSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { getGitRoot } from "./git.js";

type TauAgentsConfigParseResult = {
  paths: string[];
  error?: string;
};

type AgentsFilesInScopeResult = {
  files: string[];
  errors: string[];
};

export function findAgentsFilesFromCwdToHome(cwd: string, home: string): string[] {
  const cwdAbs = resolve(cwd);
  const homeAbs = resolve(home);

  // If we're not inside the user's home directory, don't walk beyond it.
  if (cwdAbs !== homeAbs && !cwdAbs.startsWith(homeAbs + sep)) {
    return [];
  }

  const found: string[] = [];

  let dir = cwdAbs;
  // Closest-first order: cwd, parent, ..., home.
  while (true) {
    const candidate = join(dir, "AGENTS.md");
    if (existsSync(candidate)) {
      found.push(candidate);
    }

    if (dir === homeAbs) break;

    const parent = dirname(dir);
    if (parent === dir) break;
    // Stay within home.
    if (parent !== homeAbs && !parent.startsWith(homeAbs + sep)) break;

    dir = parent;
  }

  return found;
}

function findTauConfigFilesFromCwd(args: {
  cwd: string;
  home: string;
  gitRootAbs?: string;
}): string[] {
  const cwdAbs = resolve(args.cwd);
  const homeAbs = resolve(args.home);

  if (cwdAbs !== homeAbs && !cwdAbs.startsWith(homeAbs + sep)) {
    return [];
  }

  const gitRootAbs = args.gitRootAbs ?? getGitRoot(cwdAbs);

  const stopAbs =
    gitRootAbs && (cwdAbs === gitRootAbs || cwdAbs.startsWith(gitRootAbs + sep))
      ? gitRootAbs
      : homeAbs;

  const found: string[] = [];

  let dir = cwdAbs;
  while (true) {
    const candidate = join(dir, ".tau", "config.json");
    if (existsSync(candidate)) {
      found.push(candidate);
    }

    if (dir === stopAbs) break;

    const parent = dirname(dir);
    if (parent === dir) break;
    if (parent !== homeAbs && !parent.startsWith(homeAbs + sep)) break;

    dir = parent;
  }

  return found;
}

function getAgentsPathsFromTauConfig(configPath: string): TauAgentsConfigParseResult {
  try {
    if (!existsSync(configPath)) return { paths: [] };

    const content = readFileSync(configPath, "utf-8");
    const json = JSON.parse(content) as unknown;
    if (!json || typeof json !== "object") {
      return { paths: [], error: `${configPath}: config must be a JSON object.` };
    }

    const agentsRaw = (json as { agents?: unknown }).agents;

    const rawList =
      typeof agentsRaw === "string" ? [agentsRaw] : Array.isArray(agentsRaw) ? agentsRaw : [];

    if (agentsRaw !== undefined && rawList.length === 0) {
      return { paths: [], error: `${configPath}: 'agents' must be a string or string array.` };
    }

    return {
      paths: rawList
        .filter((p): p is string => typeof p === "string")
        .map((p) => p.trim())
        .filter(Boolean),
    };
  } catch (err) {
    return {
      paths: [],
      error: `${configPath}: failed to read/parse: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

function resolveAgentsFilePath(args: {
  configPath: string;
  pathRaw: string;
  homeAbs: string;
}): string | undefined {
  const scopeDir = dirname(dirname(args.configPath));
  const candidateAbs = resolve(scopeDir, args.pathRaw);

  // Guard the *path* first to prevent obvious escapes before filesystem ops.
  if (candidateAbs !== args.homeAbs && !candidateAbs.startsWith(args.homeAbs + sep)) {
    return undefined;
  }

  let homeRealAbs = args.homeAbs;
  try {
    homeRealAbs = realpathSync(args.homeAbs);
  } catch {
    // Best-effort, fall back to the raw home path.
  }

  let realAbs = "";
  try {
    realAbs = realpathSync(candidateAbs);

    const stat = statSync(realAbs);
    if (!stat.isFile()) return undefined;
  } catch {
    return undefined;
  }

  // Guard the *real target* too to prevent symlink escapes.
  if (realAbs !== homeRealAbs && !realAbs.startsWith(homeRealAbs + sep)) {
    return undefined;
  }

  if (basename(candidateAbs) !== "AGENTS.md" || basename(realAbs) !== "AGENTS.md") {
    return undefined;
  }

  return candidateAbs;
}

function findAdditionalAgentsFilesFromTauConfigsDetailed(args: {
  cwd: string;
  home: string;
  gitRootAbs?: string;
}): AgentsFilesInScopeResult {
  const homeAbs = resolve(args.home);

  const configPaths = findTauConfigFilesFromCwd(args);
  if (configPaths.length === 0) return { files: [], errors: [] };

  const files: string[] = [];
  const errors: string[] = [];

  for (const configPath of configPaths) {
    const { paths, error } = getAgentsPathsFromTauConfig(configPath);
    if (error) errors.push(error);

    for (const pathRaw of paths) {
      const resolved = resolveAgentsFilePath({ configPath, pathRaw, homeAbs });
      if (!resolved) continue;
      files.push(resolved);
    }
  }

  return { files, errors };
}

export function findAgentsFilesInScopeDetailed(
  cwd: string,
  home: string,
  gitRootAbs?: string,
): AgentsFilesInScopeResult {
  const base = findAgentsFilesFromCwdToHome(cwd, home);
  const extra = findAdditionalAgentsFilesFromTauConfigsDetailed({ cwd, home, gitRootAbs });

  const seen = new Set<string>();
  const files: string[] = [];

  for (const file of [...base, ...extra.files]) {
    if (seen.has(file)) continue;
    seen.add(file);
    files.push(file);
  }

  return { files, errors: extra.errors };
}

export function findAgentsFilesInScope(cwd: string, home: string, gitRootAbs?: string): string[] {
  return findAgentsFilesInScopeDetailed(cwd, home, gitRootAbs).files;
}
