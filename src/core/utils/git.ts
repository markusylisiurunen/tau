import { spawnSync } from "node:child_process";
import { relative, resolve } from "node:path";

export function getGitRoot(cwd: string): string | undefined {
  try {
    const res = spawnSync("git", ["rev-parse", "--show-toplevel"], {
      cwd,
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    });

    if (res.status !== 0) return undefined;

    const root = (res.stdout ?? "").trim();
    if (!root) return undefined;

    return resolve(root);
  } catch {
    return undefined;
  }
}

export function resolvePromptGitRoot(args: { cwd: string; hostCwd?: string }): string | undefined {
  const hostCwd = args.hostCwd ?? args.cwd;
  const hostGitRoot = getGitRoot(hostCwd);
  if (!hostGitRoot) return undefined;

  const rel = relative(hostCwd, hostGitRoot);
  return resolve(args.cwd, rel);
}
