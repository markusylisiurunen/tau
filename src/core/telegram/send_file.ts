import { basename } from "node:path";
import { z } from "zod";
import type { TauSdkClientTool, TauSdkClientToolContext } from "../../sdk/types.js";
import type { TelegramApi } from "./adapter.js";

const MAX_FILE_BYTES = 50_000_000;
const CHUNK_BYTES = 8_000_000;
const inputSchema = z.strictObject({
  path: z
    .string()
    .min(1)
    .regex(/^[^\r\n\0]+$/)
    .describe("Path to the file, absolute or relative to the session working directory."),
  caption: z
    .string()
    .max(1024)
    .optional()
    .describe("Optional plain-text caption accompanying the file (up to 1,024 characters)."),
});
const chunkSchema = z.strictObject({
  identity: z.string().min(1),
  size: z.number().int().positive().max(MAX_FILE_BYTES),
  content: z.string().max(4 * Math.ceil(CHUNK_BYTES / 3)),
});

type TelegramFileApi = Pick<TelegramApi, "sendPhoto" | "sendVideo" | "sendAudio" | "sendDocument">;

export function createTelegramFileTools(api: TelegramFileApi, chatId: number): TauSdkClientTool[] {
  const deliveries = [
    {
      kind: "photo",
      method: "sendPhoto",
      maxBytes: 10_000_000,
      description:
        "Send a JPEG or PNG from the execution environment to the current Telegram chat as a photo. Maximum 10 MB; width plus height must not exceed 10,000 pixels and aspect ratio must not exceed 20. Use send_document_to_telegram for original-quality files or images outside these limits. This sends the photo to the chat; it does not display it to the model.",
    },
    {
      kind: "video",
      method: "sendVideo",
      maxBytes: MAX_FILE_BYTES,
      description:
        "Send an MPEG4 video from the execution environment to the current Telegram chat as a playable video. Maximum 50 MB. Use send_document_to_telegram for other video formats.",
    },
    {
      kind: "audio",
      method: "sendAudio",
      maxBytes: MAX_FILE_BYTES,
      description:
        "Send an MP3 or M4A file from the execution environment to the current Telegram chat in Telegram's audio player. Maximum 50 MB. Use send_document_to_telegram for other audio formats, including WAV.",
    },
    {
      kind: "document",
      method: "sendDocument",
      maxBytes: MAX_FILE_BYTES,
      description:
        "Send any file from the execution environment to the current Telegram chat as a document, including PDF, CSV, archives, and original-quality media. Preserves the original bytes and filename. Maximum 50 MB.",
    },
  ] as const;
  return deliveries.map(({ kind, method, maxBytes, description }) => ({
    schema: {
      name: `send_${kind}_to_telegram`,
      description: `${description} Files are not converted; Telegram validates media compatibility. Uploads are not automatically retried.`,
      parameters: z.toJSONSchema(inputSchema),
      executionTimeoutMs: 300_000,
    },
    async execute(args, context) {
      const input = inputSchema.parse(args);
      const data = await readFile(input.path, maxBytes, context);
      context.signal.throwIfAborted();
      await api[method](
        chatId,
        {
          data,
          fileName: basename(input.path),
          mimeType: "application/octet-stream",
          ...(input.caption !== undefined ? { caption: input.caption } : {}),
        },
        { signal: context.signal },
      );
      return `${kind} sent to the current Telegram chat.`;
    },
  }));
}

async function readFile(
  path: string,
  maxBytes: number,
  context: TauSdkClientToolContext,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let offset = 0;
  let identity = "";
  let size = 0;
  do {
    context.signal.throwIfAborted();
    const result = await context.executionEnvironment.exec('exec "$0" "$@"', {
      args: [
        "node",
        "-e",
        READ_CHUNK_SCRIPT,
        path,
        String(offset),
        identity,
        String(maxBytes),
        String(CHUNK_BYTES),
      ],
      timeoutMs: 30_000,
      maxCaptureBytes: 4 * Math.ceil(CHUNK_BYTES / 3) + 4096,
      signal: context.signal,
    });
    context.signal.throwIfAborted();
    if (result.exitCode !== 0 || result.truncated || result.timedOut || result.aborted) {
      throw new Error(
        `failed to read file: file must be a stable, readable regular file between 1 and ${maxBytes} bytes`,
      );
    }
    let chunk: z.infer<typeof chunkSchema>;
    try {
      chunk = chunkSchema.parse(JSON.parse(result.stdout));
    } catch {
      throw new Error("invalid file chunk response");
    }
    const bytes = Buffer.from(chunk.content, "base64");
    if (
      chunk.size > maxBytes ||
      (identity && (identity !== chunk.identity || size !== chunk.size)) ||
      bytes.length !== Math.min(CHUNK_BYTES, chunk.size - offset)
    ) {
      throw new Error("file changed while reading");
    }
    identity = chunk.identity;
    size = chunk.size;
    chunks.push(bytes);
    offset += bytes.length;
  } while (offset < size);
  return Buffer.concat(chunks, size);
}

const READ_CHUNK_SCRIPT = `
const fs = require("node:fs");
const [path, offsetText, expectedIdentity, maxText, chunkText] = process.argv.slice(1);
const offset = Number(offsetText);
const fd = fs.openSync(path, fs.constants.O_RDONLY | fs.constants.O_NONBLOCK);
try {
  const stats = fs.fstatSync(fd, { bigint: true });
  const identityOf = (s) => [s.dev, s.ino, s.size, s.mtimeNs, s.ctimeNs].join(":");
  const identity = identityOf(stats);
  const size = Number(stats.size);
  if (!stats.isFile() || size < 1 || size > Number(maxText)) throw new Error("invalid file size or file type");
  if (expectedIdentity && expectedIdentity !== identity) throw new Error("file changed while reading");
  const content = Buffer.alloc(Math.min(Number(chunkText), size - offset));
  let read = 0;
  while (read < content.length) {
    const count = fs.readSync(fd, content, read, content.length - read, offset + read);
    if (!count) throw new Error("file changed while reading");
    read += count;
  }
  if (identityOf(fs.fstatSync(fd, { bigint: true })) !== identity) throw new Error("file changed while reading");
  process.stdout.write(JSON.stringify({ identity, size, content: content.toString("base64") }));
} finally {
  fs.closeSync(fd);
}
`.trim();
