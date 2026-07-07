import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, relative, resolve, sep } from "node:path";
import type { ToolExecutionBackend } from "../tools/execution_backend.js";
import {
  assertVisibleNookRelativePath,
  type NookManifestFile,
  normalizeNookAssetPath,
  validateNookManifest,
} from "./validation.js";

export type NookDeployFile = NookManifestFile & {
  absolutePath: string;
};

export type NookBackendDeployFile = NookManifestFile & {
  backendPath: string;
  readContent: () => Promise<Buffer>;
};

const CONTENT_TYPES: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "application/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".mjs": "application/javascript; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".wasm": "application/wasm",
  ".webp": "image/webp",
};

function contentTypeForPath(path: string): string {
  return CONTENT_TYPES[extname(path).toLowerCase()] ?? "application/octet-stream";
}

function walkDirectory(dir: string, output: string[]): void {
  const entries = readdirSync(dir, { withFileTypes: true });
  for (const entry of entries) {
    if (entry.name.startsWith(".")) {
      throw new Error(`hidden deploy path '${entry.name}' is not allowed`);
    }

    const entryPath = join(dir, entry.name);
    if (entry.isSymbolicLink()) {
      throw new Error(`symlink deploy path '${entryPath}' is not allowed`);
    }
    if (entry.isDirectory()) {
      walkDirectory(entryPath, output);
      continue;
    }
    if (entry.isFile()) {
      output.push(entryPath);
    }
  }
}

export function buildNookDeployManifest(directory: string): NookDeployFile[] {
  const root = resolve(directory);
  const stats = statSync(root);
  if (!stats.isDirectory()) {
    throw new Error(`deploy path is not a directory: ${directory}`);
  }

  const absoluteFiles: string[] = [];
  walkDirectory(root, absoluteFiles);

  const files = absoluteFiles.map((absolutePath): NookDeployFile => {
    const relativePath = relative(root, absolutePath);
    assertVisibleNookRelativePath(relativePath);
    const assetPath = normalizeNookAssetPath(`/${relativePath.split(sep).join("/")}`);
    const content = readFileSync(absolutePath);
    return {
      path: assetPath,
      absolutePath,
      sizeBytes: content.length,
      sha256: createHash("sha256").update(content).digest("hex"),
      contentType: contentTypeForPath(assetPath),
    };
  });

  validateNookManifest(files);
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

function joinBackendPath(dir: string, name: string): string {
  const trimmed = dir.replace(/\/+$/, "");
  return trimmed ? `${trimmed}/${name}` : name;
}

async function walkBackendDirectory(args: {
  backend: ToolExecutionBackend;
  dir: string;
  relativeDir: string;
  output: Array<{ backendPath: string; relativePath: string }>;
}): Promise<void> {
  const listed = await args.backend.listDir(args.dir);
  for (const entry of listed.entries) {
    if (entry.name.startsWith(".")) {
      throw new Error(`hidden deploy path '${entry.name}' is not allowed`);
    }

    const backendPath = joinBackendPath(args.dir, entry.name);
    const relativePath = args.relativeDir ? `${args.relativeDir}/${entry.name}` : entry.name;
    if (entry.isSymlink) {
      throw new Error(`symlink deploy path '${relativePath}' is not allowed`);
    }
    if (entry.isDirectory) {
      await walkBackendDirectory({
        backend: args.backend,
        dir: backendPath,
        relativeDir: relativePath,
        output: args.output,
      });
      continue;
    }
    args.output.push({ backendPath, relativePath });
  }
}

export async function buildNookDeployManifestFromBackend(
  backend: ToolExecutionBackend,
  directory: string,
): Promise<NookBackendDeployFile[]> {
  const files: Array<{ backendPath: string; relativePath: string }> = [];
  await walkBackendDirectory({ backend, dir: directory, relativeDir: "", output: files });

  const manifest: NookBackendDeployFile[] = [];
  for (const file of files) {
    assertVisibleNookRelativePath(file.relativePath);
    const assetPath = normalizeNookAssetPath(`/${file.relativePath}`);
    const binary = await backend.readFileBinary(file.backendPath);
    const content = Buffer.from(binary.content);
    manifest.push({
      path: assetPath,
      backendPath: file.backendPath,
      sizeBytes: content.length,
      sha256: createHash("sha256").update(content).digest("hex"),
      contentType: contentTypeForPath(assetPath),
      readContent: async () => content,
    });
  }

  validateNookManifest(manifest);
  return manifest.sort((a, b) => a.path.localeCompare(b.path));
}
