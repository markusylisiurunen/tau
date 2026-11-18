import { z } from "zod";
import type { TauCodeModeApi } from "../../code_mode/runtime.js";
import type { ToolExecutionBackend } from "../tools/execution_backend.js";
import { replaceExactText } from "../tools/file_edits.js";
import { codeModeError } from "./errors.js";

const MAX_FILE_BYTES = 16 * 1024 * 1024;
const pathValue = z
  .string()
  .trim()
  .min(1)
  .regex(/^[^\r\n\0]+$/);
const replacement = z.strictObject({ oldText: z.string().min(1), newText: z.string() });

export function createFilesApi(
  backend: ToolExecutionBackend,
  allowed: ReadonlySet<string>,
): TauCodeModeApi {
  const readText = async (path: string) => {
    const { content } = await backend.readFileBinary(path, { maxBytes: MAX_FILE_BYTES });
    try {
      return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(content);
    } catch {
      throw codeModeError("INVALID_UTF8", `File is not valid UTF-8: ${path}`);
    }
  };
  const checkSize = (size: number) => {
    if (size > MAX_FILE_BYTES) throw codeModeError("FILE_LIMIT", "File content exceeds 16 MiB");
  };
  const files: TauCodeModeApi = {};
  if (allowed.has("bash")) {
    files.readText = (args) => readText(z.tuple([pathValue]).parse(args)[0]);
    files.readBytes = async (args) => {
      const [path] = z.tuple([pathValue]).parse(args);
      const { content } = await backend.readFileBinary(path, { maxBytes: MAX_FILE_BYTES });
      return new Uint8Array(content);
    };
  }
  if (allowed.has("write")) {
    files.writeText = async (args, { signal }) => {
      const [path, content] = z.tuple([pathValue, z.string()]).parse(args);
      checkSize(Buffer.byteLength(content));
      signal.throwIfAborted();
      const result = await backend.writeFile(path, content);
      return { path: result.path, bytes: result.bytes };
    };
    files.writeBytes = async (args, { signal }) => {
      const [path, bytes] = z.tuple([pathValue, z.instanceof(Uint8Array)]).parse(args);
      checkSize(bytes.byteLength);
      signal.throwIfAborted();
      const result = await backend.writeFileBinary(path, Buffer.from(bytes));
      return { path: result.path, bytes: result.bytes };
    };
  }
  if (allowed.has("edit")) {
    files.edit = async (args, { signal }) => {
      const values = z
        .union([
          z.tuple([pathValue, z.string().min(1), z.string()]),
          z.tuple([pathValue, z.array(replacement).min(1)]),
        ])
        .parse(args);
      const [path] = values;
      const replacements =
        values.length === 3 ? [{ oldText: values[1], newText: values[2] }] : values[1];
      let content = await readText(path);
      for (const { oldText, newText } of replacements) {
        content = replaceExactText(content, oldText, newText);
        checkSize(Buffer.byteLength(content));
      }
      signal.throwIfAborted();
      const result = await backend.writeFile(path, content);
      return { path: result.path, replacements: replacements.length };
    };
  }
  return files;
}
