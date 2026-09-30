import { z } from "zod";

const GEMINI_GENERATE_CONTENT_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/models";
export const SPEECH_PLAYBACK_RATE = 1.15;
const DEFAULT_SPEECH_REWRITE_MODEL = "gemini-3.8-flash";
const DEFAULT_SPEECH_REWRITE_THINKING_LEVEL = "low";
const ELEVENLABS_BASE_URL = "https://api.elevenlabs.io/v1";
const SPEECH_MODEL = "eleven_v4_turbo";
const DEFAULT_VOICE_ID = "QtY3JBOUKEB5xzrRfOKc";
const FALLBACK_VOICE_ID = "AaOhDHYJ1XLZk74lXhdE";
const SPEECH_DELIVERY_NOTE = "[Brisk but relaxed, speaking naturally to a colleague] ";
const SPEECH_REQUEST_TIMEOUT_MS = 120_000;
export const SPEECH_SAMPLE_RATE_HZ = 24000;
export const SPEECH_CHANNEL_COUNT = 1;
export const SPEECH_BITS_PER_SAMPLE = 16;
const SPEECH_REWRITE_TIMEOUT_MS = 60_000;
const COMPLETE_TTS_CONCURRENCY = 3;
const MAX_SPEECH_SEGMENT_SECONDS = 120;
const ESTIMATED_SPEECH_CHARACTERS_PER_SECOND = 17;
const MAX_SPEECH_SEGMENT_WEIGHT =
  MAX_SPEECH_SEGMENT_SECONDS * ESTIMATED_SPEECH_CHARACTERS_PER_SECOND;
const MAX_SPEECH_SOURCE_CHARACTERS = 10_000;
const MAX_SPOKEN_TEXT_CHARACTERS = 10_000;
const MAX_SPEECH_PCM_BYTES = 32 * 1024 * 1024;

const errorPayloadSchema = z.object({
  error: z
    .object({
      message: z.string().trim().min(1).optional(),
      status: z.string().trim().min(1).optional(),
      code: z.number().int().optional(),
    })
    .optional(),
});

export type SpeechStage = "rewriting" | "generating";

export type SpeechSegmentProgress = {
  ready: number;
  total: number;
};

export type SpeechOptions = {
  googleApiKey: string;
  elevenLabsApiKey: string;
  sourceText: string;
  voiceId?: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  onStageChange?: (stage: SpeechStage) => void | Promise<void>;
  onSegmentProgress?: (progress: SpeechSegmentProgress) => void | Promise<void>;
};

export type SpeechPcmOptions = SpeechOptions & {
  initialBufferBytes?: number;
};

export type SpeechAudioChunk = {
  index: number;
  total: number;
  audio: Buffer;
  mimeType: "audio/wav";
};

export type SpeechPcmChunk = {
  index: number;
  total: number;
  audio: Buffer;
};

class GeminiApiError extends Error {
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "GeminiApiError";
    this.status = status;
  }
}

type PreparedSpeech = {
  apiKey: string;
  voiceId: string;
  spokenSegments: string[];
  fetchImpl: typeof fetch;
};

export async function* generateSpeechAudio(
  options: SpeechOptions,
): AsyncGenerator<SpeechAudioChunk> {
  const abortController = createLinkedAbortController(options.signal);
  let completed = false;

  try {
    const prepared = await prepareSpeech(options, abortController.signal);

    for await (const chunk of synthesizeSpeechAudioSegmentsInOrder({
      ...prepared,
      signal: abortController.signal,
      concurrency: COMPLETE_TTS_CONCURRENCY,
      onSegmentProgress: options.onSegmentProgress,
      abortOnFailure: () => abortController.abort(),
    })) {
      yield {
        index: chunk.index,
        total: prepared.spokenSegments.length,
        audio: encodeWaveFile({
          pcmAudio: chunk.pcmAudio,
          sampleRateHz: SPEECH_SAMPLE_RATE_HZ,
          channelCount: SPEECH_CHANNEL_COUNT,
          bitsPerSample: SPEECH_BITS_PER_SAMPLE,
        }),
        mimeType: "audio/wav",
      };
    }

    completed = true;
  } finally {
    if (!completed) {
      abortController.abort();
    }
    abortController.dispose();
  }
}

export async function* streamSpeechPcm(options: SpeechPcmOptions): AsyncGenerator<SpeechPcmChunk> {
  const abortController = createLinkedAbortController(options.signal);
  let completed = false;
  let totalPcmBytes = 0;

  try {
    const prepared = await prepareSpeech(options, abortController.signal);
    const total = prepared.spokenSegments.length;
    const accountAudio = (audio: Buffer): void => {
      totalPcmBytes += audio.length;
      if (totalPcmBytes > MAX_SPEECH_PCM_BYTES) {
        throw new Error("generated speech audio exceeds the 32 MiB limit");
      }
    };
    const prefetch = (index: number): Promise<PrefetchedSpeechSegment> =>
      collectStreamingSpeechSegment({
        ...prepared,
        spokenText: prepared.spokenSegments[index]!,
        signal: abortController.signal,
        accountAudio,
      }).then(
        (audio) => ({ audio }),
        (error: unknown) => ({ error }),
      );

    let ready = 0;
    const firstStream = streamSpeechSegment({
      ...prepared,
      spokenText: prepared.spokenSegments[0]!,
      signal: abortController.signal,
      initialBufferBytes: Math.max(0, Math.trunc(options.initialBufferBytes ?? 0)),
    });
    let prefetched = total > 1 ? prefetch(1) : undefined;

    for await (const audio of firstStream) {
      accountAudio(audio);
      yield { index: 0, total, audio };
    }
    ready += 1;
    await options.onSegmentProgress?.({ ready, total });

    for (let index = 1; index < total; index += 1) {
      const outcome = await prefetched!;
      if ("error" in outcome) {
        throw outcome.error instanceof Error
          ? outcome.error
          : new Error("ElevenLabs speech request failed");
      }

      prefetched = index + 1 < total ? prefetch(index + 1) : undefined;
      yield { index, total, audio: outcome.audio };
      ready += 1;
      await options.onSegmentProgress?.({ ready, total });
    }

    completed = true;
  } finally {
    if (!completed) {
      abortController.abort();
    }
    abortController.dispose();
  }
}

type PrefetchedSpeechSegment = { audio: Buffer } | { error: unknown };

async function prepareSpeech(options: SpeechOptions, signal: AbortSignal): Promise<PreparedSpeech> {
  const sourceText = options.sourceText.trim();
  if (!sourceText) {
    throw new Error("speech source text was empty");
  }
  if (exceedsUnicodeCharacterLimit(sourceText, MAX_SPEECH_SOURCE_CHARACTERS)) {
    throw new Error("speech source text exceeds 10,000 characters");
  }

  const apiKey = options.elevenLabsApiKey.trim();
  const googleApiKey = options.googleApiKey.trim();
  if (!apiKey || !googleApiKey) {
    throw new Error("Google and ElevenLabs API keys are required for speech");
  }
  if (options.voiceId !== undefined && !options.voiceId.trim()) {
    throw new Error("speech voice ID must not be empty");
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  await options.onStageChange?.("rewriting");
  const rewriteController = createLinkedAbortController(signal);
  const rewriteTimeout = setTimeout(() => rewriteController.abort(), SPEECH_REWRITE_TIMEOUT_MS);
  rewriteTimeout.unref?.();
  let spokenText: string;
  try {
    spokenText = await rewriteTextForSpeech({
      apiKey: googleApiKey,
      model: DEFAULT_SPEECH_REWRITE_MODEL,
      sourceText,
      fetchImpl,
      signal: rewriteController.signal,
    });
  } catch (error) {
    if (!signal.aborted && rewriteController.signal.aborted) {
      throw new Error("speech rewrite timed out after 1 minute");
    }
    throw error;
  } finally {
    clearTimeout(rewriteTimeout);
    rewriteController.dispose();
  }

  if (exceedsUnicodeCharacterLimit(spokenText, MAX_SPOKEN_TEXT_CHARACTERS)) {
    throw new Error("rewritten speech text exceeds 10,000 characters");
  }

  const spokenSegments = splitSpeechSegments(spokenText);
  await options.onStageChange?.("generating");
  const voiceId = await resolveSpeechVoice({
    apiKey,
    voiceId: options.voiceId,
    fetchImpl,
    signal,
  });
  await options.onSegmentProgress?.({ ready: 0, total: spokenSegments.length });

  return {
    apiKey,
    voiceId,
    spokenSegments,
    fetchImpl,
  };
}

type RewriteTextForSpeechArgs = {
  apiKey: string;
  model: string;
  sourceText: string;
  fetchImpl: typeof fetch;
  signal?: AbortSignal;
};

async function rewriteTextForSpeech(args: RewriteTextForSpeechArgs): Promise<string> {
  const payload = await requestGeminiGenerateContent({
    apiKey: args.apiKey,
    model: args.model,
    fetchImpl: args.fetchImpl,
    signal: args.signal,
    body: {
      contents: [
        {
          parts: [
            {
              text: buildSpeechRewritePrompt(args.sourceText),
            },
          ],
        },
      ],
      generationConfig: {
        thinkingConfig: {
          thinkingLevel: DEFAULT_SPEECH_REWRITE_THINKING_LEVEL,
        },
      },
    },
  });

  const rewrittenText = extractGeminiText(payload).trim();
  if (!rewrittenText) {
    throw new Error("Gemini rewrite returned empty text");
  }
  return rewrittenText;
}

type SynthesizeSpeechAudioSegmentsArgs = PreparedSpeech & {
  signal?: AbortSignal;
  concurrency: number;
  onSegmentProgress?: (progress: SpeechSegmentProgress) => void | Promise<void>;
};

type SynthesizedSpeechAudioSegment = {
  index: number;
  pcmAudio: Buffer;
};

type SynthesizeSpeechAudioSegmentsInOrderArgs = SynthesizeSpeechAudioSegmentsArgs & {
  abortOnFailure?: () => void;
};

async function* synthesizeSpeechAudioSegmentsInOrder(
  args: SynthesizeSpeechAudioSegmentsInOrderArgs,
): AsyncGenerator<SynthesizedSpeechAudioSegment> {
  const total = args.spokenSegments.length;
  const results = new Array<Buffer | undefined>(total);
  const concurrency = Math.max(1, Math.trunc(args.concurrency));
  let nextIndex = 0;
  let nextYieldIndex = 0;
  let ready = 0;
  let totalPcmBytes = 0;
  let failure: unknown;
  let notify: (() => void) | undefined;

  const wake = (): void => {
    notify?.();
    notify = undefined;
  };

  const waitForWake = async (): Promise<void> => {
    await new Promise<void>((resolve) => {
      notify = resolve;
    });
  };

  const onAbort = (): void => {
    if (failure === undefined) {
      failure = abortError();
    }
    wake();
  };

  if (args.signal) {
    if (args.signal.aborted) {
      onAbort();
    } else {
      args.signal.addEventListener("abort", onAbort, { once: true });
    }
  }

  const worker = async (): Promise<void> => {
    while (failure === undefined && !args.signal?.aborted) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= total) {
        return;
      }

      try {
        const pcmAudio = await synthesizeSpeechAudioSegment({
          ...args,
          spokenText: args.spokenSegments[index]!,
        });
        totalPcmBytes += pcmAudio.length;
        if (totalPcmBytes > MAX_SPEECH_PCM_BYTES) {
          throw new Error("generated speech audio exceeds the 32 MiB limit");
        }
        results[index] = pcmAudio;
        ready += 1;
        await args.onSegmentProgress?.({ ready, total });
        wake();
      } catch (error) {
        if (failure === undefined) {
          failure = error;
        }
        args.abortOnFailure?.();
        wake();
        return;
      }
    }
  };

  const workers = Array.from({ length: Math.min(concurrency, total) }, () => worker());
  void Promise.allSettled(workers);

  try {
    while (nextYieldIndex < total) {
      const nextResult = results[nextYieldIndex];
      if (nextResult) {
        results[nextYieldIndex] = undefined;
        yield { index: nextYieldIndex, pcmAudio: nextResult };
        nextYieldIndex += 1;
        continue;
      }

      if (failure !== undefined) {
        throw failure instanceof Error ? failure : new Error("ElevenLabs speech request failed");
      }

      await waitForWake();
    }

    await Promise.all(workers);
  } finally {
    args.signal?.removeEventListener("abort", onAbort);
  }
}

type SynthesizeSpeechAudioSegmentArgs = Omit<PreparedSpeech, "spokenSegments"> & {
  spokenText: string;
  signal?: AbortSignal;
};

async function synthesizeSpeechAudioSegment(
  args: SynthesizeSpeechAudioSegmentArgs,
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const audio of requestSpeechStream(args)) {
    chunks.push(audio);
  }
  return Buffer.concat(chunks);
}

type StreamSpeechSegmentArgs = SynthesizeSpeechAudioSegmentArgs;

async function* streamSpeechSegment(
  args: StreamSpeechSegmentArgs & { initialBufferBytes: number },
): AsyncGenerator<Buffer> {
  const bufferedAudio: Buffer[] = [];
  let bufferedAudioBytes = 0;
  let emittedAudio = false;
  for await (const audio of requestSpeechStream(args)) {
    if (!emittedAudio) {
      bufferedAudio.push(audio);
      bufferedAudioBytes += audio.length;
      if (bufferedAudioBytes < args.initialBufferBytes) {
        continue;
      }
      emittedAudio = true;
      yield Buffer.concat(bufferedAudio);
      bufferedAudio.length = 0;
    } else {
      yield audio;
    }
  }
  if (!emittedAudio && bufferedAudio.length > 0) {
    yield Buffer.concat(bufferedAudio);
  }
}

async function collectStreamingSpeechSegment(
  args: StreamSpeechSegmentArgs & { accountAudio: (audio: Buffer) => void },
): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const audio of requestSpeechStream(args)) {
    args.accountAudio(audio);
    chunks.push(audio);
  }
  return Buffer.concat(chunks);
}

async function resolveSpeechVoice(args: {
  apiKey: string;
  voiceId?: string;
  fetchImpl: typeof fetch;
  signal: AbortSignal;
}): Promise<string> {
  const voiceIds =
    args.voiceId === undefined ? [DEFAULT_VOICE_ID, FALLBACK_VOICE_ID] : [args.voiceId.trim()];
  for (const voiceId of voiceIds) {
    const response = await args.fetchImpl(
      `${ELEVENLABS_BASE_URL}/voices/${encodeURIComponent(voiceId)}`,
      {
        headers: { "xi-api-key": args.apiKey },
        signal: AbortSignal.any([args.signal, AbortSignal.timeout(SPEECH_REQUEST_TIMEOUT_MS)]),
      },
    );
    if (response.ok) {
      const payload: unknown = await response.json();
      if (!isObject(payload) || payload.voice_id !== voiceId) {
        throw new Error("ElevenLabs returned invalid voice metadata");
      }
      return voiceId;
    }
    const payload: unknown = await response.json().catch(() => undefined);
    const detail = isObject(payload) && isObject(payload.detail) ? payload.detail : undefined;
    const unavailable =
      (response.status === 400 || response.status === 404) && detail?.status === "voice_not_found";
    if (!unavailable) {
      throw new Error(`ElevenLabs voice lookup failed (HTTP ${response.status})`);
    }
  }
  throw new Error(
    args.voiceId === undefined
      ? "Neither Maisie nor Caleb is available from ElevenLabs"
      : "The configured ElevenLabs speech voice is unavailable",
  );
}

async function* requestSpeechStream(args: StreamSpeechSegmentArgs): AsyncGenerator<Buffer> {
  const timeout = AbortSignal.timeout(SPEECH_REQUEST_TIMEOUT_MS);
  const signal = args.signal ? AbortSignal.any([args.signal, timeout]) : timeout;
  const response = await args.fetchImpl(
    `${ELEVENLABS_BASE_URL}/text-to-speech/${encodeURIComponent(args.voiceId)}/stream?output_format=pcm_24000`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json", "xi-api-key": args.apiKey },
      body: JSON.stringify({
        model_id: SPEECH_MODEL,
        text: SPEECH_DELIVERY_NOTE + args.spokenText,
      }),
      signal,
    },
  );
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`ElevenLabs speech generation failed (HTTP ${response.status})`);
  }
  const contentType = response.headers.get("content-type")?.split(";")[0]?.trim();
  if (contentType !== "audio/pcm" || !response.body) {
    await response.body?.cancel();
    throw new Error("ElevenLabs speech response did not include PCM audio");
  }
  const reader = response.body.getReader();
  let totalBytes = 0;
  let pendingByte = Buffer.alloc(0);
  let completed = false;
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.length;
      if (totalBytes > MAX_SPEECH_PCM_BYTES) {
        throw new Error("generated speech audio exceeds the 32 MiB limit");
      }
      const audio = Buffer.concat([pendingByte, value]);
      const alignedLength = audio.length - (audio.length % 2);
      pendingByte = Buffer.from(audio.subarray(alignedLength));
      if (alignedLength > 0) yield audio.subarray(0, alignedLength);
    }
    if (totalBytes === 0 || pendingByte.length > 0) {
      throw new Error("ElevenLabs returned empty or incomplete PCM audio");
    }
    completed = true;
  } finally {
    if (!completed) await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}

type RequestGeminiGenerateContentArgs = {
  apiKey: string;
  model: string;
  body: Record<string, unknown>;
  fetchImpl: typeof fetch;
  signal?: AbortSignal;
};

type RequestGeminiResponseArgs = RequestGeminiGenerateContentArgs & {
  method: string;
};

async function requestGeminiGenerateContent(
  args: RequestGeminiGenerateContentArgs,
): Promise<unknown> {
  const response = await requestGeminiResponse({ ...args, method: "generateContent" });
  const responseText = await response.text();
  try {
    return responseText ? (JSON.parse(responseText) as unknown) : undefined;
  } catch {
    return undefined;
  }
}

async function requestGeminiResponse(args: RequestGeminiResponseArgs): Promise<Response> {
  const response = await args.fetchImpl(
    `${GEMINI_GENERATE_CONTENT_BASE_URL}/${encodeURIComponent(args.model)}:${args.method}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": args.apiKey,
      },
      body: JSON.stringify(args.body),
      signal: args.signal,
    },
  );
  if (response.ok) {
    return response;
  }

  const responseText = await response.text();
  let payload: unknown;
  try {
    payload = responseText ? (JSON.parse(responseText) as unknown) : undefined;
  } catch {
    payload = undefined;
  }
  const parsed = errorPayloadSchema.safeParse(payload);
  const fallbackMessage = responseText.trim() || `HTTP ${response.status}`;
  const message = parsed.success
    ? (parsed.data.error?.message ?? fallbackMessage)
    : fallbackMessage;
  throw new GeminiApiError(message, response.status);
}

function extractGeminiText(payload: unknown): string {
  if (!isObject(payload) || !Array.isArray(payload.candidates)) {
    return "";
  }

  for (const candidate of payload.candidates) {
    if (
      !isObject(candidate) ||
      !isObject(candidate.content) ||
      !Array.isArray(candidate.content.parts)
    ) {
      continue;
    }

    const text = candidate.content.parts
      .map((part) => (isObject(part) && typeof part.text === "string" ? part.text : ""))
      .join("")
      .trim();
    if (text) {
      return text;
    }
  }

  return "";
}

function buildSpeechRewritePrompt(sourceText: string): string {
  return [
    "Rewrite the assistant response below so it sounds natural when spoken aloud.",
    "Keep prose unchanged. Only rewrite spans that are awkward to say aloud, so the listener can follow along with the original text.",
    "Do not drop, condense, or add content. Preserve meaning, order, and technical accuracy.",
    "Things that typically need rewriting: file paths, shell commands, code identifiers, markdown structure, XML-like tags, long option lists, and code-heavy formatting.",
    "Remove formatting. Convert headings, lists, tables, and code blocks into plain spoken prose. Do not preserve markdown bullets, heading markers, table rows, fences, or standalone labels.",
    "For file references, keep the filename and any line or range info that was actually present. Do not add location detail that was not in the original.",
    "Preserve numbers exactly as written, including separators, decimals, units, versions, line numbers, and ranges.",
    "Preserve established technical names, acronyms, initialisms, commands, program names, filenames, and extensions exactly as written. Do not spell their letters apart, expand them, or change their capitalization. Examples that must remain unchanged include 24, PCM, ffmpeg, npm, v5.4, and config.json.",
    "Rewrite a code identifier only when its literal form would be difficult to follow aloud, and preserve its exact meaning.",
    "",
    "Examples of good rewrites:",
    '- `src/core/utils/speech.ts:372` → "speech.ts, line 372"',
    '- `src/tui/session_chat_controller.ts:1819-1855` → "session_chat_controller.ts, lines 1819 to 1855"',
    '- `src/core/session/compaction.ts` → "compaction.ts"',
    '- `/Users/markus/.config/tau/config.json` → "the tau config.json in your home directory"',
    '- `rg --heading -n -t ts "ToolRunPresentation" src` → "the rg command searching TypeScript files for ToolRunPresentation under src"',
    '- `24 kHz PCM with ffmpeg` → "24 kHz PCM with ffmpeg"',
    '- `<available-skills>` → "the available-skills tag"',
    "- A markdown bullet list of short items → a natural comma-separated list or short sentences",
    "",
    "Write only plain text paragraphs of sensible spoken length, separated by blank lines.",
    "Do not make headings, bullets, or numbered items their own paragraphs. Fold short structural text into the surrounding prose.",
    "Return plain text only, with no markdown fences, bullets, numbering, tables, headings, or commentary.",
    "",
    "ASSISTANT RESPONSE:",
    sourceText,
  ].join("\n");
}

function exceedsUnicodeCharacterLimit(text: string, limit: number): boolean {
  let count = 0;
  for (const _character of text) {
    count += 1;
    if (count > limit) {
      return true;
    }
  }
  return false;
}

function splitSpeechSegments(spokenText: string): string[] {
  const normalizedText = spokenText
    .trim()
    .split(/\n\s*\n/gu)
    .map((paragraph) => paragraph.replace(/\s+/gu, " ").trim())
    .filter(Boolean)
    .join("\n\n");
  const characters = Array.from(normalizedText);
  const cumulativeWeights = [0];
  for (const character of characters) {
    cumulativeWeights.push(cumulativeWeights.at(-1)! + speechCharacterWeight(character));
  }

  const totalWeight = cumulativeWeights.at(-1)!;
  const minimumSegmentCounts = minimumSpeechSegmentCounts(cumulativeWeights);
  const segmentCount = minimumSegmentCounts[0]!;
  if (segmentCount === 1) {
    return [normalizedText];
  }

  const boundaries = [0];
  for (let segment = 1; segment < segmentCount; segment += 1) {
    const previousBoundary = boundaries.at(-1)!;
    const previousWeight = cumulativeWeights[previousBoundary]!;
    const remainingSegments = segmentCount - segment;
    const idealWeight = (totalWeight * segment) / segmentCount;
    const maximumBoundary = characters.length - remainingSegments;
    const candidates = Array.from(
      { length: maximumBoundary - previousBoundary },
      (_, offset) => previousBoundary + offset + 1,
    ).filter(
      (index) =>
        cumulativeWeights[index]! - previousWeight <= MAX_SPEECH_SEGMENT_WEIGHT &&
        minimumSegmentCounts[index]! <= remainingSegments,
    );
    const naturalCandidates = candidates.filter((index) =>
      isNaturalSpeechBoundary(characters, index),
    );
    const wordCandidates = candidates.filter((index) => /\s/u.test(characters[index] ?? ""));
    boundaries.push(
      selectSpeechBoundary(
        naturalCandidates,
        wordCandidates.length > 0 ? wordCandidates : candidates,
        cumulativeWeights,
        idealWeight,
      ),
    );
  }
  boundaries.push(characters.length);

  return boundaries
    .slice(1)
    .map((boundary, index) => characters.slice(boundaries[index], boundary).join("").trim());
}

function speechCharacterWeight(character: string): number {
  return /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}]/u.test(character)
    ? 3
    : 1;
}

function minimumSpeechSegmentCounts(cumulativeWeights: number[]): number[] {
  const counts = new Array<number>(cumulativeWeights.length).fill(0);
  let boundary = cumulativeWeights.length - 1;
  for (let index = cumulativeWeights.length - 2; index >= 0; index -= 1) {
    while (cumulativeWeights[boundary]! - cumulativeWeights[index]! > MAX_SPEECH_SEGMENT_WEIGHT) {
      boundary -= 1;
    }
    counts[index] = counts[boundary]! + 1;
  }
  return counts;
}

function isNaturalSpeechBoundary(characters: string[], index: number): boolean {
  const previous = characters[index - 1] ?? "";
  const next = characters[index] ?? "";
  return (previous === "\n" && next === "\n") || isSpeechSentenceBoundary(previous, next);
}

function selectSpeechBoundary(
  naturalCandidates: number[],
  fallbackCandidates: number[],
  cumulativeWeights: number[],
  idealWeight: number,
): number {
  const fallback = closestSpeechBoundary(fallbackCandidates, cumulativeWeights, idealWeight);
  if (naturalCandidates.length === 0) {
    return fallback;
  }

  const natural = closestSpeechBoundary(naturalCandidates, cumulativeWeights, idealWeight);
  const naturalDistance = Math.abs(cumulativeWeights[natural]! - idealWeight);
  const fallbackDistance = Math.abs(cumulativeWeights[fallback]! - idealWeight);
  return naturalDistance <= fallbackDistance + MAX_SPEECH_SEGMENT_WEIGHT * 0.05
    ? natural
    : fallback;
}

function closestSpeechBoundary(
  candidates: number[],
  cumulativeWeights: number[],
  idealWeight: number,
): number {
  let closest = candidates[0]!;
  let closestDistance = Math.abs(cumulativeWeights[closest]! - idealWeight);
  for (const candidate of candidates.slice(1)) {
    const distance = Math.abs(cumulativeWeights[candidate]! - idealWeight);
    if (distance < closestDistance) {
      closest = candidate;
      closestDistance = distance;
    }
  }
  return closest;
}

function isSpeechSentenceBoundary(previous: string, next: string): boolean {
  return /[。！？]/u.test(previous) || (/[.!?;:]/u.test(previous) && /\s/u.test(next));
}

function createLinkedAbortController(parent?: AbortSignal): {
  signal: AbortSignal;
  abort: () => void;
  dispose: () => void;
} {
  const controller = new AbortController();
  const onAbort = () => controller.abort(parent?.reason);

  if (parent) {
    if (parent.aborted) {
      onAbort();
    } else {
      parent.addEventListener("abort", onAbort, { once: true });
    }
  }

  return {
    signal: controller.signal,
    abort: () => controller.abort(),
    dispose: () => parent?.removeEventListener("abort", onAbort),
  };
}

function encodeWaveFile(args: {
  pcmAudio: Buffer;
  sampleRateHz: number;
  channelCount: number;
  bitsPerSample: number;
}): Buffer {
  const byteRate = (args.sampleRateHz * args.channelCount * args.bitsPerSample) / 8;
  const blockAlign = (args.channelCount * args.bitsPerSample) / 8;
  const header = Buffer.alloc(44);

  header.write("RIFF", 0);
  header.writeUInt32LE(36 + args.pcmAudio.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(args.channelCount, 22);
  header.writeUInt32LE(args.sampleRateHz, 24);
  header.writeUInt32LE(byteRate, 28);
  header.writeUInt16LE(blockAlign, 32);
  header.writeUInt16LE(args.bitsPerSample, 34);
  header.write("data", 36);
  header.writeUInt32LE(args.pcmAudio.length, 40);

  return Buffer.concat([header, args.pcmAudio]);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function abortError(): Error {
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  return error;
}
