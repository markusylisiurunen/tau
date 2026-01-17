import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, parse, resolve, sep } from "node:path";
import type { ConfigDeps } from "../config/deps.js";
import { loadConfigWithDiagnostics } from "../config/schema.js";

type AgentsFilesInScopeResult = {
  files: string[];
  errors: string[];
};

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

function findAdditionalAgentsFilesFromConfigsDetailed(args: {
  cwd: string;
  home: string;
}): AgentsFilesInScopeResult {
  const deps = createAgentsConfigDeps(args.cwd, args.home);
  const configResult = loadConfigWithDiagnostics(args.cwd, deps);
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
