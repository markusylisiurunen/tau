import { realpathSync } from "node:fs";
import { posix as pathPosix, relative, sep } from "node:path";
import type { SandboxConfig } from "../config/index.js";
import { getRestrictedRoot } from "./restricted_fs.js";

const DEFAULT_SANDBOX_MOUNT_PATH = "/workspace";

function normalizeSandboxMountPath(mountPath?: string): string {
  const trimmed = (mountPath ?? DEFAULT_SANDBOX_MOUNT_PATH).trim() || DEFAULT_SANDBOX_MOUNT_PATH;
  if (trimmed.endsWith("/") && trimmed.length > 1) {
    return trimmed.slice(0, -1);
  }
  return trimmed;
}

function resolveSandboxCwd(cwd: string, config?: SandboxConfig): string {
  const mountPath = normalizeSandboxMountPath(config?.mountPath);

  try {
    const { rootReal } = getRestrictedRoot(cwd);
    const cwdReal = realpathSync(cwd);
    const relCwd = relative(rootReal, cwdReal) || ".";

    if (relCwd === ".." || relCwd.startsWith(`..${sep}`)) {
      return mountPath;
    }

    const relPosix = relCwd.split(sep).join(pathPosix.sep);
    return relPosix === "." ? mountPath : pathPosix.join(mountPath, relPosix);
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
