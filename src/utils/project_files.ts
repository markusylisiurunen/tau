import { spawn, spawnSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { join, relative } from "node:path";

const DEFAULT_IGNORED_DIRS = new Set([".git", "node_modules"]);

async function runCommand(
  cwd: string,
  cmd: string,
  args: string[],
): Promise<{ status: number; stdout: string }> {
  const MAX_STDOUT_BYTES = 10 * 1024 * 1024;

  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, {
      cwd,
      stdio: ["ignore", "pipe", "ignore"],
    });

    const stdout: Buffer[] = [];
    let stdoutBytes = 0;
    let settled = false;

    const settleResolve = (status: number, out: Buffer[]) => {
      if (settled) return;
      settled = true;
      resolve({ status, stdout: Buffer.concat(out).toString("utf-8") });
    };

    const settleReject = (err: Error) => {
      if (settled) return;
      settled = true;
      reject(err);
    };

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_STDOUT_BYTES) {
        const err = new Error(`command stdout exceeded ${MAX_STDOUT_BYTES} bytes: ${cmd}`);
        err.name = "StdoutLimitExceededError";
        settleReject(err);
        child.kill();
        return;
      }

      stdout.push(chunk);
    });

    child.on("error", (err) => settleReject(err instanceof Error ? err : new Error(String(err))));
    child.on("close", (code) => {
      settleResolve(code ?? 1, stdout);
    });
  });
}

export function listProjectFiles(cwd: string): string[] {
  const fromGit = listProjectFilesFromGit(cwd);
  if (fromGit.length) return fromGit;
  return listProjectFilesByWalking(cwd);
}

export async function listProjectFilesAsync(cwd: string): Promise<string[]> {
  const fromGit = await listProjectFilesFromGitAsync(cwd);
  if (fromGit.length) return fromGit;
  return listProjectFilesByWalkingAsync(cwd);
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

    const rootRes = spawnSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    if (rootRes.status !== 0) return [];

    const repoRoot = (rootRes.stdout ?? "").trim();
    if (!repoRoot) return [];

    const res = spawnSync(
      "git",
      ["ls-files", "--full-name", "--cached", "--others", "--exclude-standard"],
      {
        cwd,
        encoding: "utf-8",
        stdio: ["ignore", "pipe", "ignore"],
        maxBuffer: 10 * 1024 * 1024,
      },
    );
    if (res.status !== 0) return [];

    const files = (res.stdout ?? "")
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .map((file) => relative(cwd, join(repoRoot, file)));

    // Keep stable order and avoid duplicates.
    return [...new Set(files)].sort();
  } catch {
    return [];
  }
}

async function listProjectFilesFromGitAsync(cwd: string): Promise<string[]> {
  try {
    const inside = await runCommand(cwd, "git", ["rev-parse", "--is-inside-work-tree"]);
    if (inside.status !== 0) return [];
    if ((inside.stdout ?? "").trim() !== "true") return [];

    const rootRes = await runCommand(cwd, "git", ["rev-parse", "--show-toplevel"]);
    if (rootRes.status !== 0) return [];

    const repoRoot = (rootRes.stdout ?? "").trim();
    if (!repoRoot) return [];

    const res = await runCommand(cwd, "git", [
      "ls-files",
      "--full-name",
      "--cached",
      "--others",
      "--exclude-standard",
    ]);
    if (res.status !== 0) return [];

    const files = (res.stdout ?? "")
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean)
      .map((file) => relative(cwd, join(repoRoot, file)));

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

        // Handle symlinks that point to directories
        if (entry.isSymbolicLink()) {
          try {
            const targetPath = join(dirAbs, entry.name);
            const stat = statSync(targetPath);
            if (stat.isDirectory()) {
              if (DEFAULT_IGNORED_DIRS.has(entry.name)) continue;
              const nextRel = dirRel ? join(dirRel, entry.name) : entry.name;
              walk(targetPath, nextRel);
            } else if (stat.isFile()) {
              const rel = dirRel ? join(dirRel, entry.name) : entry.name;
              out.push(rel);
            }
          } catch {
            // Broken symlink or permission error, skip
          }
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

async function listProjectFilesByWalkingAsync(cwd: string): Promise<string[]> {
  const out: string[] = [];

  const walk = async (dirAbs: string, dirRel: string): Promise<void> => {
    try {
      const entries = await readdir(dirAbs, { withFileTypes: true, encoding: "utf8" });

      for (const entry of entries) {
        if (entry.name.startsWith(".")) {
          if (entry.isDirectory()) continue;
          continue;
        }

        if (entry.isDirectory()) {
          if (DEFAULT_IGNORED_DIRS.has(entry.name)) continue;
          const nextAbs = join(dirAbs, entry.name);
          const nextRel = dirRel ? join(dirRel, entry.name) : entry.name;
          await walk(nextAbs, nextRel);
          continue;
        }

        if (entry.isSymbolicLink()) {
          try {
            const targetPath = join(dirAbs, entry.name);
            const st = await stat(targetPath);
            if (st.isDirectory()) {
              if (DEFAULT_IGNORED_DIRS.has(entry.name)) continue;
              const nextRel = dirRel ? join(dirRel, entry.name) : entry.name;
              await walk(targetPath, nextRel);
            } else if (st.isFile()) {
              const rel = dirRel ? join(dirRel, entry.name) : entry.name;
              out.push(rel);
            }
          } catch {
            // Broken symlink or permission error, skip
          }
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

  await walk(cwd, "");

  return [...new Set(out)].sort();
}
