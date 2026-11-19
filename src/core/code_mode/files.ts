import { z } from "zod";
import { codeModeError } from "../../code_mode/errors.js";
import {
  isToolExecutionBackendError,
  type ToolExecutionBackend,
} from "../tools/execution_backend.js";
import { replaceExactText } from "../tools/file_edits.js";
import { type CodeModePackage, definePackage, method } from "./package.js";

const MAX_FILE_BYTES = 16 * 1024 * 1024;
const MAX_EDITS = 128;
const pathValue = z
  .string()
  .trim()
  .min(1)
  .regex(/^[^\r\n\0]+$/);
const replacement = z.strictObject({ oldText: z.string().min(1), newText: z.string() });

/** Whole-file reads, writes, and exact edits. */
export function createFilesPackage(backend: ToolExecutionBackend): CodeModePackage {
  const readBytes = async (path: string) => {
    try {
      return (await backend.readFileBinary(path, { maxBytes: MAX_FILE_BYTES })).content;
    } catch (error) {
      if (!isToolExecutionBackendError(error, "too-large")) throw error;
      throw codeModeError("file_too_large", `File exceeds 16 MiB: ${path}`);
    }
  };
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
  return definePackage("files", "Read, write, and edit whole files.", {
    readText: method(z.tuple([pathValue]), ([path]) => readText(path)),
    readBytes: method(z.tuple([pathValue]), ([path]) => readBytes(path)),
    writeText: method(z.tuple([pathValue, z.string()]), async ([path, text]) => {
      checkSize(Buffer.byteLength(text));
      const result = await backend.writeFile(path, text);
      return { path: result.path, bytes: result.bytes };
    }),
    writeBytes: method(z.tuple([pathValue, z.instanceof(Uint8Array)]), async ([path, content]) => {
      checkSize(content.byteLength);
      const result = await backend.writeFileBinary(path, Buffer.from(content));
      return { path: result.path, bytes: result.bytes };
    }),
    edit: method(
      // The cap bounds the synchronous search work one call does on the host.
      z.tuple([pathValue, z.array(replacement).min(1).max(MAX_EDITS)]),
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
    ),
  });
}
