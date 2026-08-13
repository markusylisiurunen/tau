import { z } from "zod";

const GEMINI_GENERATE_CONTENT_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/models";
export const GEMINI_SPEECH_PLAYBACK_RATE = 1.15;
const DEFAULT_GEMINI_SPEECH_REWRITE_MODEL = "gemini-3.7-flash";
const DEFAULT_GEMINI_SPEECH_REWRITE_THINKING_LEVEL = "low";
const DEFAULT_GEMINI_SPEECH_TTS_MODEL = "gemini-3.1-flash-tts-preview";
const DEFAULT_GEMINI_TTS_VOICE_NAME = "Despina";
const DEFAULT_TTS_SAMPLE_RATE_HZ = 24000;
const DEFAULT_TTS_CHANNEL_COUNT = 1;
const DEFAULT_TTS_BITS_PER_SAMPLE = 16;
const DEFAULT_TTS_MAX_ATTEMPTS = 3;
const SPEECH_REWRITE_TIMEOUT_MS = 60_000;
const PROGRESSIVE_TTS_CONCURRENCY = 6;
const COMPLETE_TTS_CONCURRENCY = 3;
const PROGRESSIVE_SPEECH_CHUNK_CHARACTERS = 500;
const COMPLETE_SPEECH_CHUNK_CHARACTERS = 1000;
const MAX_SPEECH_SOURCE_CHARACTERS = 10_000;
const MAX_SPOKEN_TEXT_CHARACTERS = 10_000;
const MAX_SPEECH_PCM_BYTES = 32 * 1024 * 1024;
const TTS_MAX_OUTPUT_TOKENS = 8192;
const RETRYABLE_TTS_STATUS_CODES = new Set([408, 429, 500, 502, 503, 504]);

const errorPayloadSchema = z.object({
  error: z
    .object({
      message: z.string().trim().min(1).optional(),
      status: z.string().trim().min(1).optional(),
      code: z.number().int().optional(),
    })
    .optional(),
});

export type GeminiSpeechStage = "rewriting" | "generating";
export type GeminiSpeechDeliveryMode = "progressive" | "complete";

export type GeminiSpeechChunkProgress = {
  ready: number;
  total: number;
};

export type GeminiSpeechOptions = {
  apiKey: string;
  sourceText: string;
  deliveryMode: GeminiSpeechDeliveryMode;
  rewriteModel?: string;
  ttsModel?: string;
  voiceName?: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  maxTtsAttempts?: number;
  onStageChange?: (stage: GeminiSpeechStage) => void | Promise<void>;
  onChunkProgress?: (progress: GeminiSpeechChunkProgress) => void | Promise<void>;
};

export type GeminiSpeechAudioChunk = {
  index: number;
  total: number;
  audio: Buffer;
  mimeType: "audio/wav";
};

class GeminiApiError extends Error {
  readonly status?: number;

  constructor(message: string, status?: number) {
    super(message);
    this.name = "GeminiApiError";
    this.status = status;
  }
}

class GeminiTtsResponseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GeminiTtsResponseError";
  }
}

class GeminiTtsOutputLimitError extends Error {
  constructor() {
    super("Gemini TTS reached its output token limit");
    this.name = "GeminiTtsOutputLimitError";
  }
}

export async function* streamGeminiSpeechAudio(
  options: GeminiSpeechOptions,
): AsyncGenerator<GeminiSpeechAudioChunk> {
  const sourceText = options.sourceText.trim();
  if (!sourceText) {
    throw new Error("speech source text was empty");
  }
  if (exceedsUnicodeCharacterLimit(sourceText, MAX_SPEECH_SOURCE_CHARACTERS)) {
    throw new Error("speech source text exceeds 10,000 characters");
  }

  const apiKey = options.apiKey.trim();
  if (!apiKey) {
    throw new Error("missing Gemini API key");
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const rewriteModel = options.rewriteModel ?? DEFAULT_GEMINI_SPEECH_REWRITE_MODEL;
  const ttsModel = options.ttsModel ?? DEFAULT_GEMINI_SPEECH_TTS_MODEL;
  const voiceName = options.voiceName ?? DEFAULT_GEMINI_TTS_VOICE_NAME;
  const abortController = createLinkedAbortController(options.signal);
  let completed = false;

  try {
    await options.onStageChange?.("rewriting");
    const rewriteController = createLinkedAbortController(abortController.signal);
    const rewriteTimeout = setTimeout(() => rewriteController.abort(), SPEECH_REWRITE_TIMEOUT_MS);
    rewriteTimeout.unref?.();
    let spokenText: string;
    try {
      spokenText = await rewriteTextForSpeech({
        apiKey,
        model: rewriteModel,
        sourceText,
        fetchImpl,
        signal: rewriteController.signal,
      });
    } catch (error) {
      if (!abortController.signal.aborted && rewriteController.signal.aborted) {
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

    const spokenChunks = splitSpeechChunks(spokenText, options.deliveryMode);
    await options.onStageChange?.("generating");
    await options.onChunkProgress?.({ ready: 0, total: spokenChunks.length });

    for await (const chunk of synthesizeSpeechAudioChunksInOrder({
      apiKey,
      model: ttsModel,
      voiceName,
      spokenChunks,
      fetchImpl,
      signal: abortController.signal,
      maxAttempts: options.maxTtsAttempts ?? DEFAULT_TTS_MAX_ATTEMPTS,
      concurrency:
        options.deliveryMode === "progressive"
          ? PROGRESSIVE_TTS_CONCURRENCY
          : COMPLETE_TTS_CONCURRENCY,
      onChunkProgress: options.onChunkProgress,
      abortOnFailure: () => abortController.abort(),
    })) {
      yield {
        index: chunk.index,
        total: spokenChunks.length,
        audio: encodeWaveFile({
          pcmAudio: chunk.pcmAudio,
          sampleRateHz: DEFAULT_TTS_SAMPLE_RATE_HZ,
          channelCount: DEFAULT_TTS_CHANNEL_COUNT,
          bitsPerSample: DEFAULT_TTS_BITS_PER_SAMPLE,
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
          thinkingLevel: DEFAULT_GEMINI_SPEECH_REWRITE_THINKING_LEVEL,
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

type SynthesizeSpeechAudioChunksArgs = {
  apiKey: string;
  model: string;
  voiceName: string;
  spokenChunks: string[];
  fetchImpl: typeof fetch;
  signal?: AbortSignal;
  maxAttempts: number;
  concurrency: number;
  onChunkProgress?: (progress: GeminiSpeechChunkProgress) => void | Promise<void>;
};

type SynthesizedSpeechAudioChunk = {
  index: number;
  pcmAudio: Buffer;
};

type SynthesizeSpeechAudioChunksInOrderArgs = SynthesizeSpeechAudioChunksArgs & {
  abortOnFailure?: () => void;
};

async function* synthesizeSpeechAudioChunksInOrder(
  args: SynthesizeSpeechAudioChunksInOrderArgs,
): AsyncGenerator<SynthesizedSpeechAudioChunk> {
  const total = args.spokenChunks.length;
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
        const pcmAudio = await synthesizeSpeechAudioChunk({
          apiKey: args.apiKey,
          model: args.model,
          voiceName: args.voiceName,
          spokenText: args.spokenChunks[index]!,
          fetchImpl: args.fetchImpl,
          signal: args.signal,
          maxAttempts: args.maxAttempts,
        });
        totalPcmBytes += pcmAudio.length;
        if (totalPcmBytes > MAX_SPEECH_PCM_BYTES) {
          throw new Error("generated speech audio exceeds the 32 MiB limit");
        }
        results[index] = pcmAudio;
        ready += 1;
        await args.onChunkProgress?.({ ready, total });
        wake();
      } catch (err) {
        if (failure === undefined) {
          failure = err;
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
        throw failure instanceof Error ? failure : new Error("Gemini TTS request failed");
      }

      await waitForWake();
    }

    await Promise.all(workers);
  } finally {
    args.signal?.removeEventListener("abort", onAbort);
  }
}

type SynthesizeSpeechAudioChunkArgs = {
  apiKey: string;
  model: string;
  voiceName: string;
  spokenText: string;
  fetchImpl: typeof fetch;
  signal?: AbortSignal;
  maxAttempts: number;
};

async function synthesizeSpeechAudioChunk(args: SynthesizeSpeechAudioChunkArgs): Promise<Buffer> {
  const maxAttempts = Math.max(1, Math.trunc(args.maxAttempts));
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
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
                  text: buildSpeechSynthesisPrompt(args.spokenText),
                },
              ],
            },
          ],
          generationConfig: {
            responseModalities: ["AUDIO"],
            maxOutputTokens: TTS_MAX_OUTPUT_TOKENS,
            speechConfig: {
              voiceConfig: {
                prebuiltVoiceConfig: {
                  voiceName: args.voiceName,
                },
              },
            },
          },
        },
      });

      assertGeminiTtsDidNotReachOutputLimit(payload);
      const audioData = extractGeminiInlineAudioData(payload);
      if (!audioData) {
        throw new GeminiTtsResponseError("Gemini TTS response did not include audio data");
      }

      return Buffer.from(audioData, "base64");
    } catch (error) {
      lastError = error;
      if (args.signal?.aborted || !isRetryableTtsError(error) || attempt >= maxAttempts) {
        throw error;
      }
      await waitForRetryDelay(attempt, args.signal);
    }
  }

  throw lastError instanceof Error ? lastError : new Error("Gemini TTS request failed");
}

type RequestGeminiGenerateContentArgs = {
  apiKey: string;
  model: string;
  body: Record<string, unknown>;
  fetchImpl: typeof fetch;
  signal?: AbortSignal;
};

async function requestGeminiGenerateContent(
  args: RequestGeminiGenerateContentArgs,
): Promise<unknown> {
  const response = await args.fetchImpl(
    `${GEMINI_GENERATE_CONTENT_BASE_URL}/${encodeURIComponent(args.model)}:generateContent`,
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

  const responseText = await response.text();
  let payload: unknown;
  try {
    payload = responseText ? (JSON.parse(responseText) as unknown) : undefined;
  } catch {
    payload = undefined;
  }

  if (!response.ok) {
    const parsed = errorPayloadSchema.safeParse(payload);
    const fallbackMessage = responseText.trim() || `HTTP ${response.status}`;
    const message = parsed.success
      ? (parsed.data.error?.message ?? fallbackMessage)
      : fallbackMessage;
    throw new GeminiApiError(message, response.status);
  }

  return payload;
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

function assertGeminiTtsDidNotReachOutputLimit(payload: unknown): void {
  if (!isObject(payload) || !Array.isArray(payload.candidates)) {
    return;
  }

  if (
    payload.candidates.some(
      (candidate) => isObject(candidate) && candidate.finishReason === "MAX_TOKENS",
    )
  ) {
    throw new GeminiTtsOutputLimitError();
  }
}

function extractGeminiInlineAudioData(payload: unknown): string | undefined {
  if (!isObject(payload) || !Array.isArray(payload.candidates)) {
    return undefined;
  }

  for (const candidate of payload.candidates) {
    if (
      !isObject(candidate) ||
      !isObject(candidate.content) ||
      !Array.isArray(candidate.content.parts)
    ) {
      continue;
    }

    for (const part of candidate.content.parts) {
      if (
        !isObject(part) ||
        !isObject(part.inlineData) ||
        typeof part.inlineData.data !== "string"
      ) {
        continue;
      }
      const data = part.inlineData.data.trim();
      if (data) {
        return data;
      }
    }
  }

  return undefined;
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
    '- `src/core/utils/gemini_speech.ts:372` → "gemini_speech.ts, line 372"',
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

function splitSpeechChunks(spokenText: string, deliveryMode: GeminiSpeechDeliveryMode): string[] {
  const normalizedText = spokenText
    .trim()
    .split(/\n\s*\n/gu)
    .map((paragraph) => paragraph.replace(/\s+/gu, " ").trim())
    .filter(Boolean)
    .join("\n\n");
  const maxCharacters =
    deliveryMode === "progressive"
      ? PROGRESSIVE_SPEECH_CHUNK_CHARACTERS
      : COMPLETE_SPEECH_CHUNK_CHARACTERS;
  const chunks: string[] = [];
  let remaining = Array.from(normalizedText);

  while (remaining.length > maxCharacters) {
    const boundary = findSpeechChunkBoundary(remaining, maxCharacters);
    chunks.push(remaining.slice(0, boundary).join("").trim());
    remaining = Array.from(remaining.slice(boundary).join("").trim());
  }

  if (remaining.length > 0) {
    chunks.push(remaining.join(""));
  }

  return chunks.length > 0 ? chunks : [spokenText.trim()];
}

function findSpeechChunkBoundary(characters: string[], maxCharacters: number): number {
  const preferredMinimum = Math.floor(maxCharacters * 0.6);

  for (let index = maxCharacters; index >= preferredMinimum; index -= 1) {
    if (characters[index] === "\n" && characters[index + 1] === "\n") {
      return index;
    }
  }

  for (let index = maxCharacters; index >= preferredMinimum; index -= 1) {
    if (isSpeechSentenceBoundary(characters[index - 1] ?? "", characters[index] ?? "")) {
      return index;
    }
  }

  for (let index = maxCharacters; index >= 1; index -= 1) {
    if (/\s/u.test(characters[index] ?? "")) {
      return index;
    }
  }

  return maxCharacters;
}

function isSpeechSentenceBoundary(previous: string, next: string): boolean {
  return /[。！？]/u.test(previous) || (/[.!?;:]/u.test(previous) && /\s/u.test(next));
}

function buildSpeechSynthesisPrompt(spokenText: string): string {
  return [
    "Synthesize speech audio for the labeled transcript below.",
    "Speak only the transcript. Do not speak the instructions or section labels.",
    "",
    "### DIRECTOR'S NOTES",
    "Style: Clear, natural, conversational.",
    "Pacing: Brisk conversational speed. Keep it clear, confident, and energetic without sounding rushed.",
    "",
    "### TRANSCRIPT",
    spokenText,
  ].join("\n");
}

function isRetryableTtsError(error: unknown): boolean {
  if (error instanceof GeminiTtsOutputLimitError) {
    return false;
  }

  if (error instanceof GeminiTtsResponseError) {
    return true;
  }

  if (error instanceof GeminiApiError) {
    return error.status !== undefined && RETRYABLE_TTS_STATUS_CODES.has(error.status);
  }

  if (error instanceof Error) {
    return error.name !== "AbortError";
  }

  return false;
}

async function waitForRetryDelay(attempt: number, signal?: AbortSignal): Promise<void> {
  const durationMs = Math.min(1000, 150 * 2 ** (attempt - 1));
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, durationMs);
    timeout.unref?.();

    const onAbort = () => {
      clearTimeout(timeout);
      reject(abortError());
    };

    if (!signal) {
      return;
    }

    if (signal.aborted) {
      clearTimeout(timeout);
      reject(abortError());
      return;
    }

    signal.addEventListener("abort", onAbort, { once: true });
  });
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
