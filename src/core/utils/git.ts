import { spawnSync } from "node:child_process";
import { resolve } from "node:path";

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
