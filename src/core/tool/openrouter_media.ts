import { constants } from "node:fs";
import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { fileTypeFromBuffer } from "file-type";
import sharp from "sharp";
import { z } from "zod";
import type { spawnWithCapture } from "../utils/spawn_capture.js";
import { ToolCliError } from "./errors.js";
import { parseMediaJson } from "./media.js";

export const OPENROUTER_TEXT_BYTES = 1_000_000;
export const OPENROUTER_REQUEST_BYTES = 20_000_000;
export type OpenRouterAttachment = { kind: "image" | "audio" | "video"; path: string };

async function readBounded(stream: Readable, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > limit) throw new ToolCliError(`input exceeds ${limit} bytes; reduce its size`);
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

export async function readOpenRouterFile(path: string, limit: number): Promise<Buffer> {
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile()) throw new ToolCliError(`expected a regular local file: ${path}`);
    if (stat.size > limit) throw new ToolCliError(`input exceeds ${limit} bytes: ${path}`);
    return await readBounded(file.createReadStream({ autoClose: false }), limit);
  } finally {
    await file.close();
  }
}

export async function readOpenRouterStdin(stdin: Readable & { isTTY?: boolean }): Promise<Buffer> {
  if (stdin.isTTY)
    throw new ToolCliError("--input - requires piped or redirected JSON, not a terminal");
  const timer = setTimeout(
    () => stdin.destroy(new ToolCliError("stdin did not reach EOF within 30 seconds")),
    30_000,
  );
  try {
    return await readBounded(stdin, OPENROUTER_TEXT_BYTES);
  } finally {
    clearTimeout(timer);
  }
}

export function decodeOpenRouterText(bytes: Buffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new ToolCliError("input must be valid UTF-8");
  }
}

const mediaProbe = z.object({
  format: z.object({ duration: z.string().transform(Number).pipe(z.number().positive().max(600)) }),
  streams: z
    .array(
      z.object({
        codec_type: z.string(),
        codec_name: z.string(),
        width: z.number().optional(),
        height: z.number().optional(),
      }),
    )
    .min(1),
});

async function probeMedia(
  bytes: Buffer,
  kind: "audio" | "video",
  format: string,
  spawnImpl: typeof spawnWithCapture,
): Promise<number> {
  const directory = await mkdtemp(join(tmpdir(), "tau-openrouter-"));
  try {
    const path = join(directory, "input");
    await writeFile(path, bytes, { mode: 0o600 });
    const result = await spawnImpl(
      "ffprobe",
      [
        "-v",
        "error",
        "-protocol_whitelist",
        "file",
        "-f",
        format,
        "-show_entries",
        "format=duration:stream=codec_type,codec_name,width,height",
        "-of",
        "json",
        path,
      ],
      { timeoutMs: 15_000, maxCaptureBytes: 1_000_000, detached: true, killProcessGroup: true },
    );
    if (result.exitCode !== 0 || result.timedOut || result.captureLimitExceeded || result.aborted) {
      throw new ToolCliError("ffprobe could not validate media; use a valid WAV, MP3, or MP4 file");
    }
    const parsed = mediaProbe.safeParse(parseMediaJson(result.stdout, "ffprobe output"));
    if (!parsed.success)
      throw new ToolCliError("media must have a known duration of at most 600 seconds");
    const { streams, format: metadata } = parsed.data;
    if (kind === "audio") {
      if (
        streams.length !== 1 ||
        streams.some(
          (stream) =>
            stream.codec_type !== "audio" ||
            stream.codec_name !== (format === "wav" ? "pcm_s16le" : "mp3"),
        )
      ) {
        throw new ToolCliError("audio requires a single PCM 16-bit WAV or MP3 audio stream");
      }
    } else if (
      !streams.some((stream) => stream.codec_type === "video") ||
      streams.some((stream) => {
        if (stream.codec_type === "audio") return stream.codec_name !== "aac";
        return (
          stream.codec_type !== "video" ||
          stream.codec_name !== "h264" ||
          !stream.width ||
          !stream.height ||
          stream.width > 3840 ||
          stream.height > 2160
        );
      })
    ) {
      throw new ToolCliError("video requires H.264 MP4 up to 3840x2160, with optional AAC audio");
    }
    return metadata.duration;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new ToolCliError(
        "ffprobe not found; install FFmpeg (brew install ffmpeg or apt install ffmpeg) and ensure ffprobe is on PATH",
      );
    }
    throw error;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function prepareOpenRouterAttachments(
  attachments: OpenRouterAttachment[],
  spawnImpl: typeof spawnWithCapture,
): Promise<unknown[]> {
  if (
    attachments.length > 16 ||
    attachments.filter((item) => item.kind === "audio").length > 4 ||
    attachments.filter((item) => item.kind === "video").length > 1
  ) {
    throw new ToolCliError(
      "at most 16 attachments, including at most 4 audio files and 1 video, are supported",
    );
  }
  const parts: unknown[] = [];
  let duration = 0;
  let encodedBytes = 0;
  for (const { kind, path } of attachments) {
    const bytes = await readOpenRouterFile(path, kind === "image" ? 5_000_000 : 12_000_000);
    encodedBytes += 4 * Math.ceil(bytes.length / 3);
    if (encodedBytes > OPENROUTER_REQUEST_BYTES)
      throw new ToolCliError("attachments exceed the 20 MB encoded request limit");
    const type = await fileTypeFromBuffer(bytes);
    if (kind === "image") {
      if (!type || !["image/png", "image/jpeg", "image/webp"].includes(type.mime)) {
        throw new ToolCliError(`unsupported image: ${path}; use PNG, JPEG, or WebP`);
      }
      const image = sharp(bytes, { limitInputPixels: 32_000_000 });
      const metadata = await image.metadata();
      if (
        !metadata.width ||
        !metadata.height ||
        metadata.width > 8000 ||
        metadata.height > 8000 ||
        (metadata.pages ?? 1) > 1
      ) {
        throw new ToolCliError(
          "images must be single-frame, at most 8000 pixels per edge and 32 megapixels",
        );
      }
      await image.stats();
      parts.push({
        type: "image_url",
        image_url: { url: `data:${type.mime};base64,${bytes.toString("base64")}` },
      });
    } else {
      const format =
        kind === "audio"
          ? ({ "audio/wav": "wav", "audio/mpeg": "mp3" } as Record<string, string>)[
              type?.mime ?? ""
            ]
          : type?.mime === "video/mp4"
            ? "mov"
            : undefined;
      if (!format)
        throw new ToolCliError(`unsupported ${kind}: ${path}; use WAV/MP3 audio or MP4 video`);
      duration += await probeMedia(bytes, kind, format, spawnImpl);
      if (duration > 600)
        throw new ToolCliError("combined audio/video duration exceeds 600 seconds");
      parts.push(
        kind === "audio"
          ? { type: "input_audio", input_audio: { data: bytes.toString("base64"), format } }
          : {
              type: "video_url",
              video_url: { url: `data:video/mp4;base64,${bytes.toString("base64")}` },
            },
      );
    }
  }
  return parts;
}
