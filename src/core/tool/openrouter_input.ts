import { constants } from "node:fs";
import { mkdtemp, open, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable } from "node:stream";
import { OPENROUTER_TEXT_BYTES } from "../models/openrouter_media.js";
import { parseMediaJson } from "../utils/media_validation.js";
import type { spawnWithCapture } from "../utils/spawn_capture.js";

async function readBounded(stream: Readable, limit: number): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += bytes.length;
    if (size > limit) throw new Error(`input exceeds ${limit} bytes; reduce its size`);
    chunks.push(bytes);
  }
  return Buffer.concat(chunks);
}

export async function readOpenRouterFile(path: string, limit: number): Promise<Buffer> {
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const stat = await file.stat();
    if (!stat.isFile()) throw new Error(`expected a regular local file: ${path}`);
    if (stat.size > limit) throw new Error(`input exceeds ${limit} bytes: ${path}`);
    return await readBounded(file.createReadStream({ autoClose: false }), limit);
  } finally {
    await file.close();
  }
}

export async function readOpenRouterStdin(stdin: Readable & { isTTY?: boolean }): Promise<Buffer> {
  if (stdin.isTTY) throw new Error("--input - requires piped or redirected JSON, not a terminal");
  const timer = setTimeout(
    () => stdin.destroy(new Error("stdin did not reach EOF within 30 seconds")),
    30_000,
  );
  try {
    return await readBounded(stdin, OPENROUTER_TEXT_BYTES);
  } finally {
    clearTimeout(timer);
  }
}

export async function probeOpenRouterMedia(
  bytes: Buffer,
  format: string,
  spawnImpl: typeof spawnWithCapture,
): Promise<unknown> {
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
      throw new Error("ffprobe could not validate media; use a valid WAV, MP3, or MP4 file");
    }
    return parseMediaJson(result.stdout, "ffprobe output");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error(
        "ffprobe not found; install FFmpeg (brew install ffmpeg or apt install ffmpeg) and ensure ffprobe is on PATH",
      );
    }
    throw error;
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}
