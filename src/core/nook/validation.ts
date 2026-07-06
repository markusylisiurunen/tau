import { posix } from "node:path";

export const NOOK_RESERVED_PATH_PREFIX = "/__nook";

const RESERVED_SITE_SLUGS = new Set([
  "admin",
  "api",
  "assets",
  "login",
  "logout",
  "nook",
  "quick",
  "static",
  "www",
]);

export const NOOK_DEPLOY_LIMITS = {
  maxFiles: 1_000,
  maxTotalBytes: 100 * 1024 * 1024,
  maxFileBytes: 10 * 1024 * 1024,
  maxPathLength: 512,
} as const;

export type NookValidationResult =
  | { ok: true }
  | {
      ok: false;
      code: string;
      message: string;
    };

export type NookManifestFile = {
  path: string;
  sizeBytes: number;
  contentType: string;
  sha256: string;
};

export function validateNookSiteSlug(slug: string): NookValidationResult {
  if (!/^[a-z0-9][a-z0-9-]{0,61}[a-z0-9]$/.test(slug)) {
    return {
      ok: false,
      code: "invalid_slug",
      message:
        "Site slug must be 2-63 lowercase letters, numbers, or hyphens, and must start and end with a letter or number.",
    };
  }

  if (RESERVED_SITE_SLUGS.has(slug) || slug.startsWith("__")) {
    return {
      ok: false,
      code: "reserved_slug",
      message: `Site slug '${slug}' is reserved.`,
    };
  }

  return { ok: true };
}

export function normalizeNookAssetPath(rawPath: string): string {
  if (!rawPath || rawPath.includes("\0")) {
    throw new Error("asset path must be non-empty and cannot contain null bytes");
  }

  if (!rawPath.startsWith("/")) {
    throw new Error(`asset path '${rawPath}' must start with /`);
  }

  if (/^[A-Za-z]:[\\/]/.test(rawPath) || rawPath.startsWith("//")) {
    throw new Error(`asset path '${rawPath}' must not be an absolute filesystem path`);
  }

  const rawSegments = rawPath.split(/[\\/]/).filter(Boolean);
  if (rawSegments.includes("..")) {
    throw new Error(`asset path '${rawPath}' must not contain ..`);
  }

  const normalized = posix.normalize(rawPath);
  if (
    normalized === NOOK_RESERVED_PATH_PREFIX ||
    normalized.startsWith(`${NOOK_RESERVED_PATH_PREFIX}/`)
  ) {
    throw new Error(`asset path '${rawPath}' is under reserved ${NOOK_RESERVED_PATH_PREFIX}/`);
  }

  if (normalized.length > NOOK_DEPLOY_LIMITS.maxPathLength) {
    throw new Error(
      `asset path '${rawPath}' exceeds maximum length ${NOOK_DEPLOY_LIMITS.maxPathLength}`,
    );
  }

  return normalized;
}

export function assertVisibleNookRelativePath(relativePath: string): void {
  const segments = relativePath.split(/[\\/]/).filter(Boolean);
  for (const segment of segments) {
    if (segment.startsWith(".")) {
      throw new Error(`hidden deploy path '${relativePath}' is not allowed`);
    }
  }
}

export function validateNookManifest(files: NookManifestFile[]): void {
  if (files.length === 0) {
    throw new Error("deploy directory has no files");
  }
  if (files.length > NOOK_DEPLOY_LIMITS.maxFiles) {
    throw new Error(`deployment exceeds maximum file count ${NOOK_DEPLOY_LIMITS.maxFiles}`);
  }

  let totalBytes = 0;
  const paths = new Set<string>();
  let hasIndex = false;

  for (const file of files) {
    const path = normalizeNookAssetPath(file.path);
    if (path !== file.path) {
      throw new Error(`asset path '${file.path}' must be normalized as '${path}'`);
    }
    if (paths.has(path)) {
      throw new Error(`duplicate deploy path '${path}'`);
    }
    if (path.split("/").some((segment) => segment.startsWith("."))) {
      throw new Error(`hidden deploy path '${path}' is not allowed`);
    }
    if (typeof file.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(file.sha256)) {
      throw new Error(`asset path '${path}' has invalid sha256`);
    }
    paths.add(path);
    if (path === "/index.html") {
      hasIndex = true;
    }
    if (!Number.isInteger(file.sizeBytes) || file.sizeBytes < 0) {
      throw new Error(`asset path '${path}' has invalid size`);
    }
    if (file.sizeBytes > NOOK_DEPLOY_LIMITS.maxFileBytes) {
      throw new Error(
        `asset path '${path}' exceeds maximum file size ${NOOK_DEPLOY_LIMITS.maxFileBytes}`,
      );
    }
    totalBytes += file.sizeBytes;
  }

  if (!hasIndex) {
    throw new Error("deploy directory must contain root index.html");
  }

  if (totalBytes > NOOK_DEPLOY_LIMITS.maxTotalBytes) {
    throw new Error(`deployment exceeds maximum total size ${NOOK_DEPLOY_LIMITS.maxTotalBytes}`);
  }
}
