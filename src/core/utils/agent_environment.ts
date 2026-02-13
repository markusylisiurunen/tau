import { realpathSync } from "node:fs";
import { basename, dirname, resolve } from "node:path";
import type { SandboxConfig } from "../config/index.js";
import { getGitRoot } from "./git.js";
import {
  normalizeSandboxMountPath,
  resolveSandboxPathForHostPath,
  resolveSandboxWorkdir,
} from "./sandbox_paths.js";

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
  sandboxEnabled: boolean;
  sandboxConfig?: SandboxConfig;
}): string {
  if (!args.sandboxEnabled) {
    return args.cwd;
  }
  return resolveSandboxCwd(args.cwd, args.sandboxConfig);
}

export function resolveSandboxPath(args: {
  hostPath: string;
  cwd: string;
  sandboxConfig?: SandboxConfig;
}): string {
  const mountPath = normalizeSandboxMountPath(args.sandboxConfig?.mountPath);
  try {
    const root = getGitRoot(args.cwd) ?? args.cwd;
    const rootReal = realpathSync(root);
    const hostAbs = resolve(args.hostPath);
    const hostDir = dirname(hostAbs);
    let hostDirReal = hostDir;
    try {
      hostDirReal = realpathSync(hostDir);
    } catch {
      // fall back to resolved host dir
    }
    const hostPathRealish = resolve(hostDirReal, basename(hostAbs));
    return resolveSandboxPathForHostPath({
      hostPath: hostPathRealish,
      rootReal,
      mountPath,
    });
  } catch {
    return mountPath;
  }
}
