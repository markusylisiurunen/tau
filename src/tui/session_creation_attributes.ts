import { spawnSync } from "node:child_process";
import { type Dirent, readdirSync, realpathSync } from "node:fs";
import { resolve } from "node:path";
import {
  buildRepositoryAttribute,
  normalizeRepositoryReference,
} from "../core/utils/repository.js";

export function createLocalTuiSessionAttributes(cwd: string): Record<string, string> {
  const repository = buildRepositoryAttribute(discoverLocalWorkspaceRepositories(cwd));
  return {
    source: "tui",
    ...(repository ? { repository } : {}),
  };
}

export function discoverLocalWorkspaceRepositories(cwd: string): string[] {
  const repositoryRoot = gitOutput(cwd, ["rev-parse", "--show-toplevel"]);
  if (repositoryRoot) {
    const repository = repositoryFromRoot(repositoryRoot);
    return repository ? [repository] : [];
  }

  let children: Dirent[];
  try {
    children = readdirSync(cwd, { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .sort((a, b) => a.name.localeCompare(b.name));
  } catch {
    return [];
  }

  const repositories: string[] = [];
  for (const child of children) {
    const childPath = resolve(cwd, child.name);
    const childRoot = gitOutput(childPath, ["rev-parse", "--show-toplevel"]);
    if (!childRoot || realpath(childRoot) !== realpath(childPath)) continue;
    const repository = repositoryFromRoot(childRoot);
    if (repository) repositories.push(repository);
  }
  return repositories;
}

function realpath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function repositoryFromRoot(root: string): string | undefined {
  const remote = gitOutput(root, ["remote", "get-url", "origin"]);
  return remote ? normalizeRepositoryReference(remote) : undefined;
}

function gitOutput(cwd: string, args: string[]): string | undefined {
  try {
    const result = spawnSync("git", ["-C", cwd, ...args], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 5_000,
    });
    if (result.status !== 0) return undefined;
    return result.stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}
