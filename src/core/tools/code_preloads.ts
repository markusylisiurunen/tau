import { dirname, resolve } from "node:path";
import type { TauCodeModeSource } from "../../code_mode/runtime.js";
import type { ToolExecutionBackend } from "./execution_backend.js";

const MAX_FILE_BYTES = 1024 * 1024;
const MAX_TOTAL_BYTES = 8 * MAX_FILE_BYTES;
const MAX_FILES = 64;
const MAX_DEPTH = 16;

function preloadPaths(code: string): string[] {
  const paths: string[] = [];
  let remaining = code.trimStart();
  while (remaining) {
    if (remaining.startsWith("//")) {
      const end = remaining.search(/[\r\n\u2028\u2029]/);
      const comment = end < 0 ? remaining.slice(2) : remaining.slice(2, end);
      if (/^\s*@preload\b/.test(comment)) {
        const path = comment.replace(/^\s*@preload\b/, "").trim();
        if (!path.endsWith(".js") || /[\0\r\n\u2028\u2029]/.test(path)) {
          throw new Error("invalid @preload path: expected a .js file path");
        }
        paths.push(path);
      }
      remaining = end < 0 ? "" : remaining.slice(end).trimStart();
    } else if (remaining.startsWith("/*")) {
      const end = remaining.indexOf("*/", 2);
      if (end < 0) break;
      remaining = remaining.slice(end + 2).trimStart();
    } else {
      break;
    }
  }
  return paths;
}

export async function loadCodeProgram(options: {
  backend: ToolExecutionBackend;
  cwd: string;
  source: { code: string } | { file: string };
  signal: AbortSignal;
}): Promise<{ code: string; sourceName: string; preloads: TauCodeModeSource[] }> {
  const preloads: TauCodeModeSource[] = [];
  const visited = new Set<string>();
  const active = new Set<string>();
  let totalBytes = 0;

  async function visit(path: string, depth: number): Promise<void> {
    options.signal.throwIfAborted();
    if (active.has(path)) throw new Error(`cyclic @preload dependency: ${path}`);
    if (visited.has(path)) return;
    if (depth > MAX_DEPTH) throw new Error("@preload nesting exceeds 16 levels");
    if (visited.size >= MAX_FILES) throw new Error("program exceeds 64 source files");
    visited.add(path);
    active.add(path);
    try {
      const result = await options.backend.readFileBinary(path, { maxBytes: MAX_FILE_BYTES });
      options.signal.throwIfAborted();
      totalBytes += result.content.byteLength;
      if (totalBytes > MAX_TOTAL_BYTES) throw new Error("program source exceeds 8 MiB");
      const code = result.content.toString("utf8");
      await dependencies(code, dirname(path), depth);
      preloads.push({ code, sourceName: path });
    } catch (error) {
      throw new Error(`${path}: ${error instanceof Error ? error.message : String(error)}`, {
        cause: error,
      });
    } finally {
      active.delete(path);
    }
  }

  async function dependencies(code: string, cwd: string, depth: number): Promise<void> {
    for (const path of preloadPaths(code)) await visit(resolve(cwd, path), depth + 1);
  }

  options.signal.throwIfAborted();
  if ("file" in options.source) {
    await visit(resolve(options.cwd, options.source.file), 0);
    const entry = preloads.pop()!;
    if (!entry.code.trim()) throw new Error("program source must not be empty");
    return { ...entry, preloads };
  }
  const code = options.source.code;
  totalBytes = Buffer.byteLength(code);
  if (totalBytes > MAX_TOTAL_BYTES) throw new Error("program source exceeds 8 MiB");
  await dependencies(code, options.cwd, 0);
  return { code, sourceName: "inline code", preloads };
}
