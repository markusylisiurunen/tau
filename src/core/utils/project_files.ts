import { readdir, realpath, stat } from "node:fs/promises";
import { join } from "node:path";
import { spawnWithCapture } from "./spawn_capture.js";

const DEFAULT_IGNORED_DIRS = new Set([".git", "node_modules"]);

async function runCommand(
  cwd: string,
  cmd: string,
  args: string[],
): Promise<{ status: number; stdout: string }> {
  const MAX_STDOUT_BYTES = 10 * 1024 * 1024;

  const result = await spawnWithCapture(cmd, args, {
    cwd,
    maxCaptureBytes: MAX_STDOUT_BYTES,
    stdio: ["ignore", "pipe", "ignore"],
  });

  if (result.captureLimitExceeded) {
    const err = new Error(`command stdout exceeded ${MAX_STDOUT_BYTES} bytes: ${cmd}`);
    err.name = "StdoutLimitExceededError";
    throw err;
  }

  return { status: result.exitCode ?? 1, stdout: result.stdout };
}

export async function listProjectFilesAsync(cwd: string): Promise<string[]> {
  const fromRipgrep = await listProjectFilesFromRipgrepAsync(cwd);
  if (fromRipgrep.length) return fromRipgrep;
  return listProjectFilesByWalkingAsync(cwd);
}

async function listProjectFilesFromRipgrepAsync(cwd: string): Promise<string[]> {
  try {
    const res = await runCommand(cwd, "rg", ["--files"]);
    if (res.status !== 0) return [];

    const files = (res.stdout ?? "")
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);

    return [...new Set(files)].sort();
  } catch {
    return [];
  }
}

async function listProjectFilesByWalkingAsync(cwd: string): Promise<string[]> {
  const out: string[] = [];
  const realpathStack = new Set<string>();

  const walk = async (dirAbs: string, dirRel: string): Promise<void> => {
    let dirReal: string;
    try {
      dirReal = await realpath(dirAbs);
    } catch {
      return;
    }

    if (realpathStack.has(dirReal)) return;
    realpathStack.add(dirReal);

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
    } finally {
      realpathStack.delete(dirReal);
    }
  };

  await walk(cwd, "");

  return [...new Set(out)].sort();
}
