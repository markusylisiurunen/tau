import { fileTypeFromBuffer } from "file-type";
import sharp from "sharp";
import { z } from "zod";

export const OPENROUTER_TEXT_BYTES = 20 * 1024 * 1024;
export const OPENROUTER_REQUEST_BYTES = 512 * 1024 * 1024;
export const OPENROUTER_IMAGE_BYTES = 32 * 1024 * 1024;
export const OPENROUTER_MEDIA_BYTES = 256 * 1024 * 1024;
export const OPENROUTER_RESPONSE_BYTES = 32 * 1024 * 1024;
export type OpenRouterAttachment = { kind: "image" | "audio" | "video" } & (
  | { path: string; data?: never; mimeType?: never }
  | { data: string; mimeType: string; path?: never }
);
export type OpenRouterMediaPart =
  | { type: "image_url"; image_url: { url: string } }
  | { type: "input_audio"; input_audio: { data: string; format: "wav" | "mp3" } }
  | { type: "video_url"; video_url: { url: string } };
export type OpenRouterMediaAdapter = {
  readFile(path: string, limit: number): Promise<Buffer>;
  probe(bytes: Buffer, format: "wav" | "mp3" | "mov", path?: string): Promise<unknown>;
};

export function decodeOpenRouterText(bytes: Buffer): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new Error("input must be valid UTF-8");
  }
}

const mediaProbe = z.object({
  format: z.object({
    duration: z.string().transform(Number).pipe(z.number().positive().max(7200)),
  }),
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

function validateProbe(value: unknown, kind: "audio" | "video", format: string): number {
  const parsed = mediaProbe.safeParse(value);
  if (!parsed.success) throw new Error("media must have a known duration of at most 7200 seconds");
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
      throw new Error("audio requires a single PCM 16-bit WAV or MP3 audio stream");
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
    throw new Error("video requires H.264 MP4 up to 3840x2160, with optional AAC audio");
  }
  return metadata.duration;
}

export async function prepareOpenRouterAttachments(
  attachments: OpenRouterAttachment[],
  adapter: OpenRouterMediaAdapter,
  signal: AbortSignal,
  imageProfile: "standard" | "jev" = "standard",
): Promise<OpenRouterMediaPart[]> {
  if (attachments.length > (imageProfile === "jev" ? 16 : 64)) {
    throw new Error("too many attachments");
  }
  const parts: OpenRouterMediaPart[] = [];
  let duration = 0;
  let encodedBytes = 0;
  for (const attachment of attachments) {
    signal.throwIfAborted();
    const { kind } = attachment;
    const limit = Math.min(
      kind === "image" ? OPENROUTER_IMAGE_BYTES : OPENROUTER_MEDIA_BYTES,
      Math.floor((OPENROUTER_REQUEST_BYTES - encodedBytes) / 4) * 3,
    );
    const path = attachment.path ?? "inline attachment";
    if (attachment.data !== undefined && attachment.data.length > 4 * Math.ceil(limit / 3))
      throw new Error("attachment exceeds its byte limit");
    const bytes =
      attachment.path !== undefined
        ? await adapter.readFile(attachment.path, limit)
        : Buffer.from(attachment.data, "base64");
    if (bytes.length === 0 || bytes.length > limit)
      throw new Error("attachment exceeds its byte limit or is empty");
    if (attachment.data !== undefined && bytes.toString("base64") !== attachment.data)
      throw new Error("invalid padded base64 attachment");
    encodedBytes += 4 * Math.ceil(bytes.length / 3);
    if (encodedBytes > OPENROUTER_REQUEST_BYTES)
      throw new Error("attachments exceed the 512 MiB encoded request limit");
    const type = await fileTypeFromBuffer(bytes);
    if (attachment.mimeType !== undefined && type?.mime !== attachment.mimeType)
      throw new Error("attachment MIME type does not match its bytes");
    if (kind === "image") {
      if (!type || !["image/png", "image/jpeg", "image/webp"].includes(type.mime)) {
        throw new Error(`unsupported image: ${path}; use PNG, JPEG, or WebP`);
      }
      const image = sharp(bytes, { limitInputPixels: 100_000_000 });
      const metadata = await image.metadata();
      if (
        !metadata.width ||
        !metadata.height ||
        metadata.width > 32768 ||
        metadata.height > 32768 ||
        (metadata.pages ?? 1) > 1
      ) {
        throw new Error(
          "images must be single-frame, at most 32768 pixels per edge and 100 megapixels",
        );
      }
      if (
        imageProfile === "jev" &&
        (type.mime === "image/webp" ||
          metadata.width < 256 ||
          metadata.height < 256 ||
          metadata.width > 1568 ||
          metadata.height > 1568 ||
          metadata.width * metadata.height < 78_400)
      ) {
        throw new Error(
          "Jev images require PNG or JPEG, 256–1568 pixels per edge and at least 78,400 pixels in total",
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
          ? ({ "audio/wav": "wav", "audio/mpeg": "mp3" } as Record<string, "wav" | "mp3">)[
              type?.mime ?? ""
            ]
          : type?.mime === "video/mp4"
            ? "mov"
            : undefined;
      if (!format) throw new Error(`unsupported ${kind}: ${path}; use WAV/MP3 audio or MP4 video`);
      duration += validateProbe(await adapter.probe(bytes, format, attachment.path), kind, format);
      if (duration > 7200) throw new Error("combined audio/video duration exceeds 7200 seconds");
      parts.push(
        kind === "audio"
          ? {
              type: "input_audio",
              input_audio: {
                data: bytes.toString("base64"),
                format: type?.mime === "audio/wav" ? "wav" : "mp3",
              },
            }
          : {
              type: "video_url",
              video_url: { url: `data:video/mp4;base64,${bytes.toString("base64")}` },
            },
      );
    }
  }
  signal.throwIfAborted();
  return parts;
}
