import { realpathSync } from "node:fs";
import type { SandboxConfig } from "../config/index.js";
import { getGitRoot } from "./git.js";
import { normalizeSandboxMountPath, resolveSandboxWorkdir } from "./sandbox_paths.js";

function resolveSandboxCwd(cwd: string, config?: SandboxConfig): string {
  const mountPath = normalizeSandboxMountPath(config?.mountPath);

  try {
    const root = getGitRoot(cwd) ?? cwd;
    const rootReal = realpathSync(root);
    const cwdReal = realpathSync(cwd);
    return resolveSandboxWorkdir({ cwdReal, rootReal, mountPath });
  } catch {
    return mountPath;
  }
}

export function resolveAgentCwd(args: {
  cwd: string;
  sandboxEnabled?: boolean;
  sandboxConfig?: SandboxConfig;
}): string {
  if (!args.sandboxEnabled) {
    return args.cwd;
  }
  return resolveSandboxCwd(args.cwd, args.sandboxConfig);
}
