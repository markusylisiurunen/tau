import { spawnSync } from "node:child_process";
import { readdirSync } from "node:fs";
import { join } from "node:path";

const DEFAULT_IGNORED_DIRS = new Set([".git", "node_modules"]);

export function listProjectFiles(cwd: string): string[] {
  const fromGit = listProjectFilesFromGit(cwd);
  if (fromGit.length) return fromGit;
  return listProjectFilesByWalking(cwd);
}

function listProjectFilesFromGit(cwd: string): string[] {
  try {
    const inside = spawnSync("git", ["rev-parse", "--is-inside-work-tree"], {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (inside.status !== 0) return [];
    if ((inside.stdout ?? "").trim() !== "true") return [];

    const res = spawnSync("git", ["ls-files", "--cached", "--others", "--exclude-standard"], {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
      maxBuffer: 10 * 1024 * 1024,
    });
    if (res.status !== 0) return [];

    const files = (res.stdout ?? "")
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);

    // Keep stable order and avoid duplicates.
    return [...new Set(files)].sort();
  } catch {
    return [];
  }
}

function listProjectFilesByWalking(cwd: string): string[] {
  const out: string[] = [];

  const walk = (dirAbs: string, dirRel: string) => {
    try {
      const entries = readdirSync(dirAbs, { withFileTypes: true, encoding: "utf8" });

      for (const entry of entries) {
        if (entry.name.startsWith(".")) {
          // Keep hidden files out of autocomplete by default; they are rarely helpful.
          // (Still allow hidden directories to be traversed if explicitly desired later.)
          if (entry.isDirectory()) continue;
          continue;
        }

        if (entry.isDirectory()) {
          if (DEFAULT_IGNORED_DIRS.has(entry.name)) continue;
          const nextAbs = join(dirAbs, entry.name);
          const nextRel = dirRel ? join(dirRel, entry.name) : entry.name;
          walk(nextAbs, nextRel);
          continue;
        }

        if (entry.isFile()) {
          const rel = dirRel ? join(dirRel, entry.name) : entry.name;
          out.push(rel);
        }
      }
    } catch {
      return;
    }
  };

  walk(cwd, "");

  return [...new Set(out)].sort();
}
