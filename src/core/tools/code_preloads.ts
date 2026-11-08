import { dirname, resolve } from "node:path";
import type { TauCodeModeSource } from "../../code_mode/runtime.js";
import type { ToolExecutionBackend } from "./execution_backend.js";

const MAX_FILE_BYTES = 1024 * 1024;
const MAX_TOTAL_BYTES = 8 * MAX_FILE_BYTES;
const MAX_FILES = 64;
const MAX_DEPTH = 16;

export type CodeProgram = { code: string; sourceName: string; preloads: TauCodeModeSource[] };

function preloadPaths(code: string): string[] {
  const paths: string[] = [];
  let remaining = code.trimStart();
  while (remaining) {
    if (remaining.startsWith("//")) {
      const end = remaining.search(/[\r\n\u2028\u2029]/);
      const comment = end < 0 ? remaining.slice(2) : remaining.slice(2, end);
      if (/^\s*@preload(?:\s|$)/.test(comment)) {
        const path = comment.replace(/^\s*@preload(?:\s|$)/, "").trim();
        if (!path.endsWith(".js") || /\0/.test(path)) {
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
}): Promise<CodeProgram> {
  const preloads: TauCodeModeSource[] = [];
  const heights = new Map<string, number>();
  const active = new Set<string>();
  let totalBytes = 0;

  async function visit(path: string, depth: number): Promise<number> {
    options.signal.throwIfAborted();
    if (active.has(path)) throw new Error(`cyclic @preload dependency: ${path}`);
    const height = heights.get(path);
    if (depth + (height ?? 0) > MAX_DEPTH) throw new Error("@preload nesting exceeds 16 levels");
    if (height !== undefined) return height;
    if (heights.size + active.size >= MAX_FILES) throw new Error("program exceeds 64 source files");
    active.add(path);
    try {
      const result = await options.backend.readFileBinary(path, { maxBytes: MAX_FILE_BYTES });
      options.signal.throwIfAborted();
      totalBytes += result.content.byteLength;
      if (totalBytes > MAX_TOTAL_BYTES) throw new Error("program source exceeds 8 MiB");
      const code = result.content.toString("utf8");
      const height = await dependencies(code, dirname(path), depth);
      heights.set(path, height);
      preloads.push({ code, sourceName: path });
      return height;
    } catch (error) {
      throw new Error(`${path}: ${error instanceof Error ? error.message : String(error)}`, {
        cause: error,
      });
    } finally {
      active.delete(path);
    }
  }

  async function dependencies(code: string, cwd: string, depth: number): Promise<number> {
    let height = 0;
    for (const path of preloadPaths(code)) {
      height = Math.max(height, 1 + (await visit(resolve(cwd, path), depth + 1)));
    }
    return height;
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
