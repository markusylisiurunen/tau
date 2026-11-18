import { z } from "zod";
import { codeModeError } from "../../code_mode/errors.js";
import type { ToolExecutionBackend } from "../tools/execution_backend.js";
import { replaceExactText } from "../tools/file_edits.js";
import { type CodeModeMethod, type CodeModePackage, definePackage, method } from "./package.js";

const MAX_FILE_BYTES = 16 * 1024 * 1024;
const pathValue = z
  .string()
  .trim()
  .min(1)
  .regex(/^[^\r\n\0]+$/);
const replacement = z.strictObject({ oldText: z.string().min(1), newText: z.string() });

/** Offers the file operations the persona's tools permit: reads with Bash, `write`, and `edit`. */
export function createFilesPackage(
  backend: ToolExecutionBackend,
  allowed: ReadonlySet<string>,
): CodeModePackage | undefined {
  const readBytes = async (path: string) =>
    (await backend.readFileBinary(path, { maxBytes: MAX_FILE_BYTES })).content;
  const readText = async (path: string) => {
    const content = await readBytes(path);
    try {
      return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(content);
    } catch {
      throw codeModeError("invalid_utf8", `File is not valid UTF-8: ${path}`);
    }
  };
  const checkSize = (size: number) => {
    if (size > MAX_FILE_BYTES) throw codeModeError("file_too_large", "File exceeds 16 MiB");
  };
  const methods: Record<string, CodeModeMethod> = {};
  const operations: string[] = [];
  if (allowed.has("bash")) {
    operations.push("read files");
    methods.readText = method(z.tuple([pathValue]), ([path]) => readText(path));
    methods.readBytes = method(
      z.tuple([pathValue]),
      async ([path]) => new Uint8Array(await readBytes(path)),
    );
  }
  if (allowed.has("write")) {
    operations.push("create or replace files");
    methods.writeText = method(z.tuple([pathValue, z.string()]), async ([path, text]) => {
      checkSize(Buffer.byteLength(text));
      const result = await backend.writeFile(path, text);
      return { path: result.path, bytes: result.bytes };
    });
    methods.writeBytes = method(
      z.tuple([pathValue, z.instanceof(Uint8Array)]),
      async ([path, content]) => {
        checkSize(content.byteLength);
        const result = await backend.writeFileBinary(path, Buffer.from(content));
        return { path: result.path, bytes: result.bytes };
      },
    );
  }
  if (allowed.has("edit")) {
    operations.push("apply exact text edits");
    methods.edit = method(
      z.tuple([pathValue, z.array(replacement).min(1)]),
      async ([path, edits], { signal }) => {
        let content = await readText(path);
        for (const { oldText, newText } of edits) {
          content = replaceExactText(content, oldText, newText);
          checkSize(Buffer.byteLength(content));
        }
        signal.throwIfAborted();
        const result = await backend.writeFile(path, content);
        return { path: result.path, edits: edits.length };
      },
    );
  }
  if (operations.length === 0) return undefined;
  const summary = joinOperations(operations);
  return definePackage("files", `${summary[0]!.toUpperCase()}${summary.slice(1)}.`, methods);
}

function joinOperations(operations: string[]): string {
  if (operations.length === 1) return operations[0]!;
  return `${operations.slice(0, -1).join(", ")}${operations.length > 2 ? "," : ""} and ${operations.at(-1)}`;
}
