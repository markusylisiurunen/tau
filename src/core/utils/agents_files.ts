import { existsSync, readFileSync, realpathSync, readdirSync, statSync } from "node:fs";
import { basename, dirname, join, parse, resolve, sep } from "node:path";
import type { ConfigDeps } from "../config/deps.js";
import { resolveConfigLevels } from "../config/paths.js";

type TauAgentsConfigParseResult = {
  paths: string[];
  error?: string;
};

type AgentsFilesInScopeResult = {
  files: string[];
  errors: string[];
};

function safeRealpath(path: string): string {
  const abs = resolve(path);
  try {
    return realpathSync(abs);
  } catch {
    return abs;
  }
}

function isSameOrParentPath(parent: string, child: string): boolean {
  if (parent === child) return true;
  const root = parse(parent).root;
  if (parent === root) return child.startsWith(root);
  return child.startsWith(parent + sep);
}

export function isAgentContextPathInScope(filePath: string, cwd: string): boolean {
  const cwdReal = safeRealpath(cwd);
  const fileReal = safeRealpath(filePath);
  const fileDir = dirname(fileReal);
  return isSameOrParentPath(fileDir, cwdReal) || isSameOrParentPath(cwdReal, fileDir);
}

function createAgentsConfigDeps(cwd: string, home: string): ConfigDeps {
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

export function findAgentsFilesFromCwdToHome(cwd: string, home: string): string[] {
  const cwdAbs = resolve(cwd);
  const homeAbs = resolve(home);
  const withinHome = cwdAbs === homeAbs || cwdAbs.startsWith(homeAbs + sep);
  const stopAbs = withinHome ? homeAbs : parse(cwdAbs).root;

  const found: string[] = [];

  let dir = cwdAbs;
  // Closest-first order: cwd, parent, ..., home/root.
  while (true) {
    const candidate = join(dir, "AGENTS.md");
    if (existsSync(candidate)) {
      found.push(candidate);
    }

    if (dir === stopAbs) break;

    const parent = dirname(dir);
    if (parent === dir) break;

    dir = parent;
  }

  return found;
}

function getAgentContextPathsFromConfig(
  configPath: string,
  deps: ConfigDeps,
): TauAgentsConfigParseResult {
  try {
    if (!deps.fs.exists(configPath)) return { paths: [] };

    const content = deps.fs.readFile(configPath);
    const json = JSON.parse(content) as unknown;
    if (!json || typeof json !== "object") {
      return { paths: [], error: `${configPath}: config must be a JSON object.` };
    }

    const agentContextRaw = (json as { agentContextFiles?: unknown }).agentContextFiles;

    const rawList =
      typeof agentContextRaw === "string"
        ? [agentContextRaw]
        : Array.isArray(agentContextRaw)
          ? agentContextRaw
          : [];

    if (agentContextRaw !== undefined && rawList.length === 0) {
      return {
        paths: [],
        error: `${configPath}: 'agentContextFiles' must be a string or string array.`,
      };
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

function resolveAgentContextFilePath(args: {
  levelRoot: string;
  pathRaw: string;
  homeAbs: string;
}): string | undefined {
  const candidateAbs = resolve(args.levelRoot, args.pathRaw);

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

function findAdditionalAgentsFilesFromConfigsDetailed(args: {
  cwd: string;
  home: string;
}): AgentsFilesInScopeResult {
  const homeAbs = resolve(args.home);
  const cwdAbs = resolve(args.cwd);
  const deps = createAgentsConfigDeps(args.cwd, args.home);
  const levels = resolveConfigLevels(deps, { cwd: args.cwd });
  const files: string[] = [];
  const errors: string[] = [];

  for (const level of levels) {
    const { paths, error } = getAgentContextPathsFromConfig(level.configPath, deps);
    if (error) errors.push(error);

    for (const pathRaw of paths) {
      const resolved = resolveAgentContextFilePath({
        levelRoot: level.levelRoot,
        pathRaw,
        homeAbs,
      });
      if (!resolved) continue;
      if (!isAgentContextPathInScope(resolved, cwdAbs)) continue;
      files.push(resolved);
    }
  }

  return { files, errors };
}

export function findAgentsFilesInScopeDetailed(cwd: string, home: string): AgentsFilesInScopeResult {
  const base = findAgentsFilesFromCwdToHome(cwd, home);
  const extra = findAdditionalAgentsFilesFromConfigsDetailed({ cwd, home });

  const seen = new Set<string>();
  const files: string[] = [];

  for (const file of [...base, ...extra.files]) {
    if (seen.has(file)) continue;
    seen.add(file);
    files.push(file);
  }

  return { files, errors: extra.errors };
}

export function findAgentsFilesInScope(cwd: string, home: string): string[] {
  return findAgentsFilesInScopeDetailed(cwd, home).files;
}
