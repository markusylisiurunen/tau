import { spawnSync } from "node:child_process";
import type { Dirent } from "node:fs";
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, parse, resolve, sep } from "node:path";
import type { ConfigDeps } from "../config/deps.js";
import { resolveConfigLevels } from "../config/paths.js";
import { loadConfigWithDiagnostics } from "../config/schema.js";
import { loadModelResolver } from "../models/catalog.js";

type AgentsFilesInScopeResult = {
  files: string[];
  errors: string[];
};

const CHILD_AGENTS_RG_TIMEOUT_MS = 2000;
const CHILD_AGENTS_WALK_TIMEOUT_MS = 1000;
const CHILD_AGENTS_WALK_MAX_DIRS = 8_192;
const CHILD_AGENTS_WALK_MAX_DEPTH = 16;

const DEFAULT_IGNORED_CHILD_DIRS = new Set([
  ".cache",
  ".git",
  ".hg",
  ".jj",
  ".next",
  ".nuxt",
  ".parcel-cache",
  ".repository-cache",
  ".svn",
  ".turbo",
  ".venv",
  ".vite",
  "__pycache__",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "out",
  "target",
  "vendor",
  "venv",
]);

const HOME_IGNORED_CHILD_DIRS = new Set([
  ".bun",
  ".cargo",
  ".config",
  ".deno",
  ".gradle",
  ".local",
  ".m2",
  ".npm",
  ".nvm",
  ".pnpm-store",
  ".rustup",
  ".sdkman",
  ".yarn",
]);

function getIgnoredHomeChildDirs(): Set<string> {
  return new Set([
    ...HOME_IGNORED_CHILD_DIRS,
    ...(process.platform === "darwin" ? ["Library"] : process.platform === "linux" ? ["snap"] : []),
  ]);
}

function isSameOrParentPath(parent: string, child: string): boolean {
  if (parent === child) return true;
  const root = parse(parent).root;
  if (parent === root) return child.startsWith(root);
  return child.startsWith(parent + sep);
}

function resolveAgentContextPath(args: { path: string; cwd: string; home: string }): string | null {
  const resolved = resolve(args.path);
  if (basename(resolved) !== "AGENTS.md") return null;

  let realPath: string;
  try {
    realPath = realpathSync(resolved);
  } catch {
    return null;
  }

  if (basename(realPath) !== "AGENTS.md") return null;

  try {
    const stat = statSync(realPath);
    if (!stat.isFile()) return null;
  } catch {
    return null;
  }

  const cwdAbs = resolve(args.cwd);
  const homeAbs = resolve(args.home);
  let cwdReal = cwdAbs;
  let homeReal = homeAbs;
  try {
    cwdReal = realpathSync(cwdAbs);
  } catch {
    // fall back to cwdAbs
  }
  try {
    homeReal = realpathSync(homeAbs);
  } catch {
    // fall back to homeAbs
  }
  const withinHome = cwdReal === homeReal || cwdReal.startsWith(homeReal + sep);
  if (withinHome && !isSameOrParentPath(homeReal, realPath)) return null;
  if (!isAgentContextPathInScope(realPath, cwdReal)) return null;

  return resolved;
}

export function isAgentContextPathInScope(filePath: string, cwd: string): boolean {
  const cwdAbs = resolve(cwd);
  const fileDir = dirname(resolve(filePath));
  return isSameOrParentPath(fileDir, cwdAbs) || isSameOrParentPath(cwdAbs, fileDir);
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
      const resolved = resolveAgentContextPath({ path: candidate, cwd: cwdAbs, home });
      if (resolved) {
        found.push(resolved);
      }
    }

    if (dir === stopAbs) break;

    const parent = dirname(dir);
    if (parent === dir) break;

    dir = parent;
  }

  return found;
}

function buildIgnoredChildDirGlobs(includeHomeChildren: boolean): string[] {
  return [
    ...[...DEFAULT_IGNORED_CHILD_DIRS].flatMap((dir) => ["--glob", `!${dir}/`]),
    ...(includeHomeChildren
      ? [...getIgnoredHomeChildDirs()].flatMap((dir) => ["--glob", `!/${dir}/**`])
      : []),
  ];
}

function findChildAgentsFilesWithRipgrep(cwd: string, home: string): string[] | null {
  const cwdAbs = resolve(cwd);
  const homeAbs = resolve(home);
  const result = spawnSync(
    "rg",
    [
      "--files",
      "--hidden",
      "--max-depth",
      String(CHILD_AGENTS_WALK_MAX_DEPTH),
      "--no-ignore",
      "--glob",
      "**/AGENTS.md",
      ...buildIgnoredChildDirGlobs(cwdAbs === homeAbs),
    ],
    {
      cwd: cwdAbs,
      encoding: "utf8",
      maxBuffer: 10 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
      timeout: CHILD_AGENTS_RG_TIMEOUT_MS,
    },
  );

  if (result.error) {
    const code = "code" in result.error ? result.error.code : undefined;
    return code === "ETIMEDOUT" ? [] : null;
  }
  if (result.status !== 0 && result.status !== 1) return null;
  if (typeof result.stdout !== "string") return null;

  return result.stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .sort((a, b) => a.localeCompare(b))
    .map((filePath) => resolve(cwdAbs, filePath))
    .filter((filePath) => dirname(filePath) !== cwdAbs)
    .flatMap((filePath) => {
      const resolved = resolveAgentContextPath({ path: filePath, cwd: cwdAbs, home });
      return resolved ? [resolved] : [];
    });
}

function findChildAgentsFilesByWalking(cwd: string, home: string): string[] {
  const cwdAbs = resolve(cwd);
  let homeReal = resolve(home);
  try {
    homeReal = realpathSync(homeReal);
  } catch {
    // use the resolved home path
  }
  let cwdReal = cwdAbs;
  try {
    cwdReal = realpathSync(cwdAbs);
  } catch {
    return [];
  }
  const ignoredHomeChildDirs = getIgnoredHomeChildDirs();
  const found: string[] = [];
  const queuedDirs = new Set([cwdReal]);
  const pendingDirs = [{ dir: cwdAbs, canonicalDir: cwdReal, depth: 0 }];
  const startedAt = Date.now();

  for (let index = 0; index < pendingDirs.length; index += 1) {
    if (Date.now() - startedAt >= CHILD_AGENTS_WALK_TIMEOUT_MS) {
      break;
    }
    const current = pendingDirs[index]!;
    let entries: Dirent<string>[];
    try {
      entries = readdirSync(current.dir, { withFileTypes: true, encoding: "utf8" });
    } catch {
      continue;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    const agentsEntry = entries.find((entry) => entry.name === "AGENTS.md");
    if (
      current.depth > 0 &&
      agentsEntry &&
      (agentsEntry.isFile() || agentsEntry.isSymbolicLink())
    ) {
      const resolved = resolveAgentContextPath({
        path: join(current.dir, agentsEntry.name),
        cwd: cwdAbs,
        home,
      });
      if (resolved) {
        found.push(resolved);
      }
    }

    if (current.depth >= CHILD_AGENTS_WALK_MAX_DEPTH) {
      continue;
    }
    for (const entry of entries) {
      if (pendingDirs.length >= CHILD_AGENTS_WALK_MAX_DIRS) break;
      if (!entry.isDirectory() && !entry.isSymbolicLink()) continue;
      if (
        DEFAULT_IGNORED_CHILD_DIRS.has(entry.name) ||
        (current.canonicalDir === homeReal && ignoredHomeChildDirs.has(entry.name))
      ) {
        continue;
      }

      const childDir = join(current.dir, entry.name);
      let canonicalChildDir: string;
      if (entry.isDirectory()) {
        canonicalChildDir = join(current.canonicalDir, entry.name);
      } else {
        try {
          if (!statSync(childDir).isDirectory()) continue;
          canonicalChildDir = realpathSync(childDir);
        } catch {
          continue;
        }
      }
      if (queuedDirs.has(canonicalChildDir) || !isSameOrParentPath(cwdReal, canonicalChildDir)) {
        continue;
      }
      queuedDirs.add(canonicalChildDir);
      pendingDirs.push({
        dir: childDir,
        canonicalDir: canonicalChildDir,
        depth: current.depth + 1,
      });
    }
  }

  return found.sort((a, b) => a.localeCompare(b));
}

export function findChildAgentsFiles(cwd: string, home: string): string[] {
  return findChildAgentsFilesWithRipgrep(cwd, home) ?? findChildAgentsFilesByWalking(cwd, home);
}

function findAdditionalAgentsFilesFromConfigsDetailed(args: {
  cwd: string;
  home: string;
}): AgentsFilesInScopeResult {
  const deps = createAgentsConfigDeps(args.cwd, args.home);
  const levels = resolveConfigLevels(deps, { cwd: args.cwd });
  const modelResolver = loadModelResolver({ deps, levels });
  const configResult = loadConfigWithDiagnostics(deps, { levels, modelResolver });
  const files: string[] = [];
  const errors = [...configResult.errors];

  for (const pathRaw of configResult.config.agentContextFiles ?? []) {
    const resolved = resolveAgentContextPath({ path: pathRaw, cwd: args.cwd, home: args.home });
    if (resolved) {
      files.push(resolved);
    }
  }

  return { files, errors };
}

export function findAgentsFilesInScopeDetailed(
  cwd: string,
  home: string,
): AgentsFilesInScopeResult {
  const base = findAgentsFilesFromCwdToHome(cwd, home);
  const extra = findAdditionalAgentsFilesFromConfigsDetailed({ cwd, home });

  const seen = new Set<string>();
  const files: string[] = [];

  for (const file of [...base, ...extra.files]) {
    let dedupeKey = file;
    try {
      dedupeKey = realpathSync(file);
    } catch {
      // fallback to the resolved path
    }
    if (seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    files.push(file);
  }

  return { files, errors: extra.errors };
}

export function findAgentsFilesInScope(cwd: string, home: string): string[] {
  return findAgentsFilesInScopeDetailed(cwd, home).files;
}
