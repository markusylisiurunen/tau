import { posix as pathPosix, relative, sep } from "node:path";

const DEFAULT_SANDBOX_MOUNT_PATH = "/workspace";

export function normalizeSandboxMountPath(mountPath?: string): string {
  const trimmed = (mountPath ?? DEFAULT_SANDBOX_MOUNT_PATH).trim() || DEFAULT_SANDBOX_MOUNT_PATH;
  if (trimmed.endsWith("/") && trimmed.length > 1) {
    return trimmed.slice(0, -1);
  }
  return trimmed;
}

export function resolveSandboxWorkdir(args: {
  cwdReal: string;
  rootReal: string;
  mountPath: string;
}): string {
  const relCwd = relative(args.rootReal, args.cwdReal) || ".";
  if (relCwd === ".." || relCwd.startsWith(`..${sep}`)) {
    return args.mountPath;
  }

  const relPosix = relCwd.split(sep).join(pathPosix.sep);
  return relPosix === "." ? args.mountPath : pathPosix.join(args.mountPath, relPosix);
}
