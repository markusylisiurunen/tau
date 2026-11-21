import { extname, join } from "node:path";
import { z } from "zod";
import { getElevenLabsApiKey } from "../config/schema.js";
import { describeMediaError, mediaRequest, readMediaJsonResponse } from "./media.js";
import {
  appendBytes,
  assembleSpeechWav,
  type MediaContext,
  prepareOutput,
  publish,
  removeFile,
  replaceFile,
  writeNew,
} from "./target.js";

const SAMPLE_RATE = 24000;
const CHUNK_CHARACTERS = 2000;
const PCM_TRANSFER_BYTES = 1024 * 1024;

export const speechDocument = z.strictObject({
  voices: z.record(z.string().min(1), z.string().trim().min(1)),
  chunks: z
    .array(
      z
        .array(
          z.strictObject({
            speaker: z.string().min(1),
            text: z.string().refine((text) => text.trim().length > 0, "text must not be blank"),
          }),
        )
        .min(1),
    )
    .min(1),
});

type SpeechInput = { voice_id: string; text: string };
type SpeechBatch = { chunks: number[]; inputs: SpeechInput[]; characters: number };

function planSpeechBatches(document: z.infer<typeof speechDocument>): SpeechBatch[] {
  const batches: SpeechBatch[] = [];
  const voices = new Set<string>();
  for (const [index, chunk] of document.chunks.entries()) {
    const characters = chunk.reduce((sum, turn) => sum + Array.from(turn.text).length, 0);
    if (characters > CHUNK_CHARACTERS) {
      throw new Error(
        `chunk ${index + 1} has ${characters} characters; maximum ${CHUNK_CHARACTERS}; split it into smaller chunks`,
      );
    }
    const inputs = chunk.map((turn, turnIndex) => {
      const voice = Object.hasOwn(document.voices, turn.speaker)
        ? document.voices[turn.speaker]
        : undefined;
      if (!voice) {
        throw new Error(
          `chunk ${index + 1}, turn ${turnIndex + 1}: unknown speaker ${turn.speaker}; add it to voices or use a defined speaker`,
        );
      }
      voices.add(voice);
      return { voice_id: voice, text: turn.text };
    });
    const previous = batches.at(-1);
    if (previous && previous.characters + characters <= CHUNK_CHARACTERS) {
      previous.chunks.push(index + 1);
      previous.inputs.push(...inputs);
      previous.characters += characters;
    } else {
      batches.push({ chunks: [index + 1], inputs, characters });
    }
  }
  if (voices.size > 10) {
    throw new Error("speech supports at most 10 distinct voices");
  }
  return batches;
}

export const speechModels = ["eleven_v4_turbo", "eleven_v4"] as const;
function elevenKey(ctx: MediaContext) {
  const key = getElevenLabsApiKey(ctx.config);
  if (!key) throw new Error("missing ELEVENLABS_API_KEY or apiKeys.elevenlabs");
  return key;
}
export const voiceOptions = z.strictObject({
  model: z.enum(speechModels),
  cursor: z.string().min(1).optional(),
  limit: z.number().int().min(1).max(100).default(100),
});
export async function listVoices(
  { cursor: token, limit }: z.infer<typeof voiceOptions>,
  ctx: MediaContext,
) {
  const apiKey = elevenKey(ctx);

  const url = new URL("https://api.elevenlabs.io/v2/voices");
  url.searchParams.set("page_size", String(limit));
  if (token) {
    url.searchParams.set("next_page_token", token);
  }
  const response = await mediaRequest(ctx, url.href, { headers: { "xi-api-key": apiKey } });
  const page = await readMediaJsonResponse(
    response,
    8 * 1024 * 1024,
    z.object({
      voices: z.array(z.object({ voice_id: z.string(), name: z.string() })),
      has_more: z.boolean(),
      next_page_token: z.string().nullable().optional(),
    }),
    "ElevenLabs voice-list response",
  );
  if (page.has_more && (!page.next_page_token || page.next_page_token === token))
    throw new Error("invalid voice pagination");
  return {
    voices: page.voices.map((v) => ({ id: v.voice_id, name: v.name })),
    nextCursor: page.has_more ? page.next_page_token : null,
  };
}
async function savePcm(ctx: MediaContext, response: Response, path: string): Promise<number> {
  if (!response.body) throw new Error("missing PCM response body");
  await writeNew(ctx, path, Buffer.alloc(0));
  let bytes = 0;
  let buffered = 0;
  const buffer = Buffer.alloc(PCM_TRANSFER_BYTES);
  const reader = response.body.getReader();
  try {
    while (true) {
      const { value, done } = await reader.read().catch(async (error: unknown) => {
        if (buffered) {
          await appendBytes(ctx, path, buffer.subarray(0, buffered)).catch(() => {});
        }
        throw error;
      });
      if (done) break;
      bytes += value.length;
      if (bytes > 128 * 1024 * 1024) throw new Error("PCM response exceeds size limit");
      let offset = 0;
      while (offset < value.length) {
        const length = Math.min(buffer.length - buffered, value.length - offset);
        buffer.set(value.subarray(offset, offset + length), buffered);
        buffered += length;
        offset += length;
        if (buffered === buffer.length) {
          await appendBytes(ctx, path, buffer);
          buffered = 0;
        }
      }
    }
    if (buffered) await appendBytes(ctx, path, buffer.subarray(0, buffered));
  } finally {
    reader.releaseLock();
  }
  if (!bytes || bytes % 2) throw new Error("provider returned empty or unaligned PCM audio");
  return bytes;
}

export const speechOptions = z.strictObject({
  model: z.enum(speechModels),
  outputPath: z.string().min(1),
});
export async function generateSpeech(
  script: z.infer<typeof speechDocument>,
  { model, outputPath: output }: z.infer<typeof speechOptions>,
  ctx: MediaContext,
) {
  const apiKey = elevenKey(ctx);

  if (extname(output).toLowerCase() !== ".wav")
    throw new Error("output must have a .wav extension");
  const batches = planSpeechBatches(script);
  const destination = await prepareOutput(ctx, output);
  const manifest = {
    model,
    sampleRate: SAMPLE_RATE,
    channels: 1,
    bitsPerSample: 16,
    output: destination.path,
    batches: batches.map((batch, index) => ({
      ...batch,
      file: `batch-${String(index + 1).padStart(4, "0")}.pcm`,
      bytes: 0,
      requestId: null as string | null,
      characterCost: null as string | null,
    })),
  };
  const saveManifest = async () => {
    const temporary = join(destination.parts, "manifest.json.tmp");
    await writeNew(ctx, temporary, Buffer.from(JSON.stringify(manifest, null, 2)));
    await replaceFile(ctx, temporary, join(destination.parts, "manifest.json"));
  };
  let stage = "saving the batch plan";
  try {
    await writeNew(
      ctx,
      join(destination.parts, "manifest.json"),
      Buffer.from(JSON.stringify(manifest, null, 2)),
    );
    for (const [index, batch] of manifest.batches.entries()) {
      stage = `preparing batch ${index + 1} of ${manifest.batches.length}`;
      const previousRequestIds = manifest.batches
        .slice(Math.max(0, index - 3), index)
        .map((previous) => {
          if (!previous.requestId) {
            throw new Error("provider omitted request-id; cannot stitch the next speech batch");
          }
          return previous.requestId;
        });
      stage = `requesting batch ${index + 1} of ${manifest.batches.length}`;
      const response = await mediaRequest(
        ctx,
        "https://api.elevenlabs.io/v1/text-to-dialogue?output_format=pcm_24000",
        {
          method: "POST",
          headers: { "xi-api-key": apiKey, "Content-Type": "application/json" },
          body: JSON.stringify({
            model_id: model,
            inputs: batch.inputs,
            ...(previousRequestIds.length ? { previous_request_ids: previousRequestIds } : {}),
          }),
        },
      );
      stage = `saving batch ${index + 1} of ${manifest.batches.length}`;
      batch.requestId = response.headers.get("request-id");
      batch.characterCost = response.headers.get("character-cost");
      const path = join(destination.parts, batch.file);
      let bytes: number;
      try {
        await saveManifest();
        bytes = await savePcm(ctx, response, `${path}.partial`);
      } finally {
        await response.body?.cancel().catch(() => {});
      }
      await publish(ctx, `${path}.partial`, path);
      batch.bytes = bytes;
      await saveManifest();
      await removeFile(ctx, `${path}.partial`);
    }
    stage = "assembling the WAV";
    const artifact = join(destination.parts, "assembled.wav");
    await assembleSpeechWav(
      ctx,
      manifest.batches.map((batch) => join(destination.parts, batch.file)),
      artifact,
      manifest.batches.reduce((sum, b) => sum + b.bytes, 0),
      SAMPLE_RATE,
    );
    stage = "publishing the WAV";
    await publish(ctx, artifact, destination.path);
    return { outputPath: destination.path, artifacts: destination.parts, batches: batches.length };
  } catch (error) {
    throw new Error(
      `speech generation failed while ${stage}: ${describeMediaError(error)}; retained artifacts: ${destination.parts} (any saved manifest, completed .pcm batches, .partial downloads, and assembled.wav); inspect the manifest before recovery and do not reuse .partial files`,
    );
  }
}
