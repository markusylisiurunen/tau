import { realpathSync, statSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";
import { getGitRoot } from "./git.js";

export type RestrictedRoot = {
  root: string;
  rootReal: string;
};

const TRAVERSAL_PATTERN = /(^|[\\/])\.\.([\\/]|$)/;

function isOutsideRoot(rootReal: string, candidate: string): boolean {
  const rel = relative(rootReal, candidate);
  if (!rel) {
    return false;
  }
  return rel === ".." || rel.startsWith(`..${sep}`);
}

export function getRestrictedRoot(cwd: string = process.cwd()): RestrictedRoot {
  const root = getGitRoot(cwd) ?? cwd;
  const rootReal = realpathSync(root);
  return { root, rootReal };
}

export function resolveRestrictedPath(
  rawPath: string,
  options?: { mustExist?: boolean },
): {
  rootReal: string;
  absPath: string;
  realPath: string;
  relPath: string;
} {
  const cleaned = rawPath.trim() || ".";

  if (cleaned.includes("\0")) {
    throw new Error("Invalid path: contains null byte.");
  }

  if (TRAVERSAL_PATTERN.test(cleaned)) {
    throw new Error("Invalid path: '..' traversal is not allowed.");
  }

  const { rootReal } = getRestrictedRoot();
  const absPath = isAbsolute(cleaned) ? resolve(cleaned) : resolve(rootReal, cleaned);

  if (isOutsideRoot(rootReal, absPath)) {
    throw new Error("Path is outside the allowed root.");
  }

  if (options?.mustExist) {
    const realPath = realpathSync(absPath);
    if (isOutsideRoot(rootReal, realPath)) {
      throw new Error("Path resolves outside the allowed root.");
    }
    return { rootReal, absPath, realPath, relPath: relative(rootReal, realPath) || "." };
  }

  return { rootReal, absPath, realPath: absPath, relPath: relative(rootReal, absPath) || "." };
}

export function resolveRestrictedFilePath(rawPath: string): {
  rootReal: string;
  absPath: string;
  realPath: string;
  relPath: string;
} {
  const resolved = resolveRestrictedPath(rawPath, { mustExist: true });
  const stat = statSync(resolved.realPath);
  if (!stat.isFile()) {
    throw new Error("Path is not a file.");
  }
  return resolved;
}

export function resolveRestrictedDirPath(rawPath: string): {
  rootReal: string;
  absPath: string;
  realPath: string;
  relPath: string;
} {
  const resolved = resolveRestrictedPath(rawPath, { mustExist: true });
  const stat = statSync(resolved.realPath);
  if (!stat.isDirectory()) {
    throw new Error("Path is not a directory.");
  }
  return resolved;
}
