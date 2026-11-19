import { resolve } from "node:path";
import type { ToolExecutionBackend } from "./execution_backend.js";

const MAX_FILE_BYTES = 1024 * 1024;

export type CodeProgram = { code: string; cwd: string; entryPath?: string };

export async function readCodeModule(
  backend: ToolExecutionBackend,
  path: string,
  signal: AbortSignal,
): Promise<string> {
  signal.throwIfAborted();
  const { content } = await backend.readFileBinary(path, { maxBytes: MAX_FILE_BYTES });
  signal.throwIfAborted();
  return new TextDecoder("utf-8", { fatal: true }).decode(content);
}

export async function loadCodeProgram(options: {
  backend: ToolExecutionBackend;
  cwd: string;
  source: { code: string } | { file: string };
  signal: AbortSignal;
}): Promise<CodeProgram> {
  const { backend, cwd, source, signal } = options;
  signal.throwIfAborted();
  if ("file" in source) {
    const entryPath = resolve(cwd, source.file);
    const code = await readCodeModule(backend, entryPath, signal);
    if (!code.trim()) throw new Error("Program source must not be empty");
    return { code, cwd, entryPath };
  }
  return { code: source.code, cwd };
}
