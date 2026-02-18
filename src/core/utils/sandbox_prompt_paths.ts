import { realpathSync } from "node:fs";
import { isAbsolute, posix as pathPosix, relative, resolve, sep } from "node:path";
import type { SandboxConfig } from "../config/index.js";
import { getGitRoot } from "./git.js";
import { normalizeSandboxMountPath, resolveSandboxPathForHostPath } from "./sandbox_paths.js";

export type SandboxPromptPathScope = {
  rootReal: string;
  mountPath: string;
};

function resolvePathRealish(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return resolve(path);
  }
}

function isPathWithinRoot(path: string, root: string): boolean {
  const rel = relative(root, path);
  return rel === "" || rel === "." || !(rel === ".." || rel.startsWith(`..${sep}`));
}

function isSandboxPathWithinMount(path: string, mountPath: string): boolean {
  const relFromMount = pathPosix.relative(mountPath, path);
  return !(relFromMount === ".." || relFromMount.startsWith("../"));
}

export function resolveSandboxPromptPathScope(args: {
  cwd: string;
  sandboxEnabled?: boolean;
  sandboxConfig?: SandboxConfig;
  sandboxHostRoot?: string;
}): SandboxPromptPathScope | undefined {
  if (!args.sandboxEnabled) {
    return undefined;
  }

  const root = args.sandboxHostRoot ?? getGitRoot(args.cwd) ?? args.cwd;
  return {
    rootReal: resolvePathRealish(root),
    mountPath: normalizeSandboxMountPath(args.sandboxConfig?.mountPath),
  };
}

export function resolveSandboxPromptPath(
  path: string,
  scope: SandboxPromptPathScope,
): string | undefined {
  const hostPath = resolvePathRealish(path);
  if (!isPathWithinRoot(hostPath, scope.rootReal)) {
    return undefined;
  }

  return resolveSandboxPathForHostPath({
    hostPath,
    rootReal: scope.rootReal,
    mountPath: scope.mountPath,
  });
}

export function resolveSandboxHostRoot(args: {
  cwd: string;
  hostCwd: string;
  sandboxEnabled: boolean;
  sandboxMountPath?: string;
}): string | undefined {
  if (!args.sandboxEnabled) {
    return undefined;
  }

  const mountPath = normalizeSandboxMountPath(args.sandboxMountPath);
  if (!isSandboxPathWithinMount(args.cwd, mountPath)) {
    return undefined;
  }

  const relFromMount = pathPosix.relative(mountPath, args.cwd);
  const depth = relFromMount
    .split(pathPosix.sep)
    .map((part) => part.trim())
    .filter((part) => part.length > 0).length;

  let root = resolve(args.hostCwd);
  for (let i = 0; i < depth; i++) {
    root = resolve(root, "..");
  }

  return root;
}

export function resolveSandboxMappedWorkingDirectory(args: {
  cwd: string;
  hostCwd: string;
  workingDirectory?: string;
  sandboxEnabled: boolean;
  sandboxMountPath?: string;
}): { cwd: string; hostCwd: string; error?: string } {
  if (!args.workingDirectory) {
    return { cwd: args.cwd, hostCwd: args.hostCwd };
  }

  const cwd = resolve(args.cwd, args.workingDirectory);
  const rel = relative(args.cwd, cwd);

  if (args.sandboxEnabled) {
    const mountPath = normalizeSandboxMountPath(args.sandboxMountPath);
    if (!isSandboxPathWithinMount(cwd, mountPath)) {
      return {
        cwd,
        hostCwd: args.hostCwd,
        error:
          `workingDirectory '${cwd}' is outside sandbox mount path '${mountPath}' and ` +
          "cannot be mapped to host prompt context.",
      };
    }
  }

  if (!isAbsolute(args.workingDirectory)) {
    return { cwd, hostCwd: resolve(args.hostCwd, rel) };
  }

  if (!args.sandboxEnabled) {
    return { cwd, hostCwd: cwd };
  }

  return { cwd, hostCwd: resolve(args.hostCwd, rel) };
}
