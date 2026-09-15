import { basename } from "node:path";
import { fileTypeFromBuffer } from "file-type";
import { z } from "zod";
import type { TauSdkClientTool, TauSdkClientToolContext } from "../../sdk/types.js";
import type { TelegramApi } from "./adapter.js";

const MAX_IMAGE_BYTES = 50_000_000;
const CHUNK_BYTES = 8_000_000;
const inputSchema = z.strictObject({
  path: z
    .string()
    .min(1)
    .regex(/^[^\r\n\0]+$/)
    .describe("Path to the image file, absolute or relative to the session working directory."),
  caption: z
    .string()
    .max(1024)
    .optional()
    .describe("Optional plain-text caption accompanying the image (up to 1,024 characters)."),
});
const chunkSchema = z.strictObject({
  identity: z.string(),
  size: z.number().int().positive().max(MAX_IMAGE_BYTES),
  content: z.string().max(4 * Math.ceil(CHUNK_BYTES / 3)),
});

export function createTelegramSendImageTool(
  api: Pick<TelegramApi, "sendDocument">,
  chatId: number,
): TauSdkClientTool {
  return {
    schema: {
      name: "send_image",
      description:
        "Send an image file from the execution environment to the current Telegram chat. Use this to deliver images requested by the user or produced as part of their task. Sends the original file without resizing or recompression, as a Telegram document. Supports PNG and JPEG up to 50 MB. This shares the image with the chat; it does not display it to the model.",
      parameters: z.toJSONSchema(inputSchema),
      executionTimeoutMs: 300_000,
    },
    async execute(args, context) {
      const input = inputSchema.parse(args);
      const data = await readImage(input.path, context);
      context.signal.throwIfAborted();
      const format = await fileTypeFromBuffer(data);
      if (format?.mime !== "image/png" && format?.mime !== "image/jpeg") {
        throw new Error("only PNG and JPEG images are supported");
      }
      context.signal.throwIfAborted();
      await api.sendDocument(
        chatId,
        {
          data,
          fileName: basename(input.path),
          mimeType: format.mime,
          ...(input.caption !== undefined ? { caption: input.caption } : {}),
        },
        { signal: context.signal },
      );
      return "image sent to the current Telegram chat.";
    },
  };
}

async function readImage(path: string, context: TauSdkClientToolContext): Promise<Buffer> {
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
        String(MAX_IMAGE_BYTES),
        String(CHUNK_BYTES),
      ],
      timeoutMs: 30_000,
      maxCaptureBytes: 4 * Math.ceil(CHUNK_BYTES / 3) + 4096,
      signal: context.signal,
    });
    context.signal.throwIfAborted();
    if (result.exitCode !== 0 || result.truncated || result.timedOut || result.aborted) {
      throw new Error(
        "failed to read image: file must be a stable, readable regular file between 1 and 50,000,000 bytes",
      );
    }
    let chunk: z.infer<typeof chunkSchema>;
    try {
      chunk = chunkSchema.parse(JSON.parse(result.stdout));
    } catch {
      throw new Error("invalid image chunk response");
    }
    const bytes = Buffer.from(chunk.content, "base64");
    if (
      (identity && (identity !== chunk.identity || size !== chunk.size)) ||
      bytes.length !== Math.min(CHUNK_BYTES, chunk.size - offset)
    ) {
      throw new Error("image changed while reading");
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
  if (!stats.isFile() || size < 1 || size > Number(maxText)) throw new Error("invalid image size or file type");
  if (expectedIdentity && expectedIdentity !== identity) throw new Error("image changed while reading");
  const content = Buffer.alloc(Math.min(Number(chunkText), size - offset));
  let read = 0;
  while (read < content.length) {
    const count = fs.readSync(fd, content, read, content.length - read, offset + read);
    if (!count) throw new Error("image changed while reading");
    read += count;
  }
  if (identityOf(fs.fstatSync(fd, { bigint: true })) !== identity) throw new Error("image changed while reading");
  process.stdout.write(JSON.stringify({ identity, size, content: content.toString("base64") }));
} finally {
  fs.closeSync(fd);
}
`.trim();
