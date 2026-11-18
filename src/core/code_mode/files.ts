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

// The tool each function needs. Every function is always exported, so programs and the
// reference stay the same, and a call without its tool fails with `not_permitted`.
const REQUIRED_TOOLS = {
  readText: "bash",
  readBytes: "bash",
  writeText: "write",
  writeBytes: "write",
  edit: "edit",
} as const;

/** Whole-file operations, present when the persona's tools permit at least one of them. */
export function createFilesPackage(
  backend: ToolExecutionBackend,
  allowed: ReadonlySet<string>,
): CodeModePackage | undefined {
  const denied = Object.entries(REQUIRED_TOOLS).filter(([, tool]) => !allowed.has(tool));
  if (denied.length === Object.keys(REQUIRED_TOOLS).length) return undefined;
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
  const methods: Record<keyof typeof REQUIRED_TOOLS, CodeModeMethod> = {
    readText: method(z.tuple([pathValue]), ([path]) => readText(path)),
    readBytes: method(
      z.tuple([pathValue]),
      async ([path]) => new Uint8Array(await readBytes(path)),
    ),
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
    ),
  };
  for (const [name, tool] of denied) {
    methods[name as keyof typeof REQUIRED_TOOLS] = method(z.tuple([]).rest(z.unknown()), () => {
      throw codeModeError("not_permitted", `${name} needs the ${tool} tool, which is not enabled`);
    });
  }
  const unavailable = denied.length
    ? ` Not permitted in this session: ${denied.map(([name]) => name).join(", ")}.`
    : "";
  return definePackage("files", `Read, write, and edit whole files.${unavailable}`, methods);
}
