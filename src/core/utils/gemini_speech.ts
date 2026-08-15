import { z } from "zod";

const GEMINI_GENERATE_CONTENT_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/models";
export const GEMINI_SPEECH_PLAYBACK_RATE = 1.15;
const DEFAULT_GEMINI_SPEECH_REWRITE_MODEL = "gemini-3.7-flash";
const DEFAULT_GEMINI_SPEECH_REWRITE_THINKING_LEVEL = "low";
const DEFAULT_GEMINI_SPEECH_TTS_MODEL = "gemini-3.1-flash-tts-preview";
const DEFAULT_GEMINI_TTS_VOICE_NAME = "Despina";
export const GEMINI_SPEECH_SAMPLE_RATE_HZ = 24000;
export const GEMINI_SPEECH_CHANNEL_COUNT = 1;
export const GEMINI_SPEECH_BITS_PER_SAMPLE = 16;
const DEFAULT_TTS_MAX_ATTEMPTS = 3;
const SPEECH_REWRITE_TIMEOUT_MS = 60_000;
const COMPLETE_TTS_CONCURRENCY = 3;
const MAX_SPEECH_SEGMENT_SECONDS = 120;
const ESTIMATED_SPEECH_CHARACTERS_PER_SECOND = 17;
const MAX_SPEECH_SEGMENT_WEIGHT =
  MAX_SPEECH_SEGMENT_SECONDS * ESTIMATED_SPEECH_CHARACTERS_PER_SECOND;
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

export type GeminiSpeechSegmentProgress = {
  ready: number;
  total: number;
};

export type GeminiSpeechOptions = {
  apiKey: string;
  sourceText: string;
  rewriteModel?: string;
  ttsModel?: string;
  voiceName?: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  maxTtsAttempts?: number;
  onStageChange?: (stage: GeminiSpeechStage) => void | Promise<void>;
  onSegmentProgress?: (progress: GeminiSpeechSegmentProgress) => void | Promise<void>;
};

export type GeminiSpeechAudioChunk = {
  index: number;
  total: number;
  audio: Buffer;
  mimeType: "audio/wav";
};

export type GeminiSpeechPcmChunk = {
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

type PreparedGeminiSpeech = {
  apiKey: string;
  model: string;
  voiceName: string;
  spokenSegments: string[];
  fetchImpl: typeof fetch;
  maxAttempts: number;
};

export async function* generateGeminiSpeechAudio(
  options: GeminiSpeechOptions,
): AsyncGenerator<GeminiSpeechAudioChunk> {
  const abortController = createLinkedAbortController(options.signal);
  let completed = false;

  try {
    const prepared = await prepareGeminiSpeech(options, abortController.signal);

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
          sampleRateHz: GEMINI_SPEECH_SAMPLE_RATE_HZ,
          channelCount: GEMINI_SPEECH_CHANNEL_COUNT,
          bitsPerSample: GEMINI_SPEECH_BITS_PER_SAMPLE,
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

export async function* streamGeminiSpeechPcm(
  options: GeminiSpeechOptions,
): AsyncGenerator<GeminiSpeechPcmChunk> {
  const abortController = createLinkedAbortController(options.signal);
  let completed = false;
  let totalPcmBytes = 0;

  try {
    const prepared = await prepareGeminiSpeech(options, abortController.signal);
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
    const firstStream = streamSpeechSegmentWithRetries({
      ...prepared,
      spokenText: prepared.spokenSegments[0]!,
      signal: abortController.signal,
    });
    const firstIterator = firstStream[Symbol.asyncIterator]();
    let nextAudio = firstIterator.next();
    let prefetched = total > 1 ? prefetch(1) : undefined;

    while (true) {
      const next = await nextAudio;
      if (next.done) {
        break;
      }
      accountAudio(next.value);
      yield { index: 0, total, audio: next.value };
      nextAudio = firstIterator.next();
    }
    ready += 1;
    await options.onSegmentProgress?.({ ready, total });

    for (let index = 1; index < total; index += 1) {
      const outcome = await prefetched!;
      if ("error" in outcome) {
        throw outcome.error instanceof Error
          ? outcome.error
          : new Error("Gemini TTS request failed");
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

async function prepareGeminiSpeech(
  options: GeminiSpeechOptions,
  signal: AbortSignal,
): Promise<PreparedGeminiSpeech> {
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
  await options.onStageChange?.("rewriting");
  const rewriteController = createLinkedAbortController(signal);
  const rewriteTimeout = setTimeout(() => rewriteController.abort(), SPEECH_REWRITE_TIMEOUT_MS);
  rewriteTimeout.unref?.();
  let spokenText: string;
  try {
    spokenText = await rewriteTextForSpeech({
      apiKey,
      model: options.rewriteModel ?? DEFAULT_GEMINI_SPEECH_REWRITE_MODEL,
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
  await options.onSegmentProgress?.({ ready: 0, total: spokenSegments.length });

  return {
    apiKey,
    model: options.ttsModel ?? DEFAULT_GEMINI_SPEECH_TTS_MODEL,
    voiceName: options.voiceName ?? DEFAULT_GEMINI_TTS_VOICE_NAME,
    spokenSegments,
    fetchImpl,
    maxAttempts: options.maxTtsAttempts ?? DEFAULT_TTS_MAX_ATTEMPTS,
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

type SynthesizeSpeechAudioSegmentsArgs = PreparedGeminiSpeech & {
  signal?: AbortSignal;
  concurrency: number;
  onSegmentProgress?: (progress: GeminiSpeechSegmentProgress) => void | Promise<void>;
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
        throw failure instanceof Error ? failure : new Error("Gemini TTS request failed");
      }

      await waitForWake();
    }

    await Promise.all(workers);
  } finally {
    args.signal?.removeEventListener("abort", onAbort);
  }
}

type SynthesizeSpeechAudioSegmentArgs = Omit<PreparedGeminiSpeech, "spokenSegments"> & {
  spokenText: string;
  signal?: AbortSignal;
};

async function synthesizeSpeechAudioSegment(
  args: SynthesizeSpeechAudioSegmentArgs,
): Promise<Buffer> {
  const maxAttempts = Math.max(1, Math.trunc(args.maxAttempts));
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      const payload = await requestGeminiGenerateContent({
        apiKey: args.apiKey,
        model: args.model,
        fetchImpl: args.fetchImpl,
        signal: args.signal,
        body: buildSpeechSynthesisRequest(args.spokenText, args.voiceName),
      });

      assertGeminiTtsCompleted(payload);
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

type StreamSpeechSegmentArgs = SynthesizeSpeechAudioSegmentArgs;

async function* streamSpeechSegmentWithRetries(
  args: StreamSpeechSegmentArgs,
): AsyncGenerator<Buffer> {
  const maxAttempts = Math.max(1, Math.trunc(args.maxAttempts));
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    let emittedAudio = false;
    try {
      for await (const audio of requestGeminiSpeechStream(args)) {
        emittedAudio = true;
        yield audio;
      }
      return;
    } catch (error) {
      lastError = error;
      if (
        emittedAudio ||
        args.signal?.aborted ||
        !isRetryableTtsError(error) ||
        attempt >= maxAttempts
      ) {
        throw error;
      }
      await waitForRetryDelay(attempt, args.signal);
    }
  }

  throw lastError instanceof Error ? lastError : new Error("Gemini TTS request failed");
}

async function collectStreamingSpeechSegment(
  args: StreamSpeechSegmentArgs & { accountAudio: (audio: Buffer) => void },
): Promise<Buffer> {
  const maxAttempts = Math.max(1, Math.trunc(args.maxAttempts));
  let lastError: unknown;

  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    const chunks: Buffer[] = [];
    try {
      for await (const audio of requestGeminiSpeechStream(args)) {
        chunks.push(audio);
      }
    } catch (error) {
      lastError = error;
      if (args.signal?.aborted || !isRetryableTtsError(error) || attempt >= maxAttempts) {
        throw error;
      }
      await waitForRetryDelay(attempt, args.signal);
      continue;
    }

    const audio = Buffer.concat(chunks);
    args.accountAudio(audio);
    return audio;
  }

  throw lastError instanceof Error ? lastError : new Error("Gemini TTS request failed");
}

async function* requestGeminiSpeechStream(args: StreamSpeechSegmentArgs): AsyncGenerator<Buffer> {
  const response = await requestGeminiResponse({
    apiKey: args.apiKey,
    model: args.model,
    method: "streamGenerateContent?alt=sse",
    fetchImpl: args.fetchImpl,
    signal: args.signal,
    body: buildSpeechSynthesisRequest(args.spokenText, args.voiceName),
  });
  if (!response.body) {
    throw new GeminiTtsResponseError("Gemini TTS streaming response did not include a body");
  }

  let receivedAudio = false;
  let completed = false;
  for await (const payload of parseGeminiSse(response.body)) {
    const finishReason = getGeminiFinishReason(payload);
    if (finishReason) {
      assertGeminiTtsFinishReason(finishReason);
      completed = finishReason === "STOP";
    }

    for (const audioData of extractGeminiInlineAudioDataParts(payload)) {
      receivedAudio = true;
      yield Buffer.from(audioData, "base64");
    }
  }

  if (!receivedAudio) {
    throw new GeminiTtsResponseError("Gemini TTS response did not include audio data");
  }
  if (!completed) {
    throw new GeminiTtsResponseError("Gemini TTS stream ended without a stop response");
  }
}

function buildSpeechSynthesisRequest(
  spokenText: string,
  voiceName: string,
): Record<string, unknown> {
  return {
    contents: [
      {
        parts: [
          {
            text: buildSpeechSynthesisPrompt(spokenText),
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
            voiceName,
          },
        },
      },
    },
  };
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

async function* parseGeminiSse(body: ReadableStream<Uint8Array>): AsyncGenerator<unknown> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffered = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      buffered += decoder.decode(value, { stream: !done });

      let boundary = findSseEventBoundary(buffered);
      while (boundary) {
        const event = buffered.slice(0, boundary.index);
        buffered = buffered.slice(boundary.index + boundary.length);
        const payload = parseSseEvent(event);
        if (payload !== undefined) {
          yield payload;
        }
        boundary = findSseEventBoundary(buffered);
      }

      if (done) {
        const payload = parseSseEvent(buffered);
        if (payload !== undefined) {
          yield payload;
        }
        return;
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function findSseEventBoundary(text: string): { index: number; length: number } | undefined {
  const match = /\r?\n\r?\n/u.exec(text);
  return match ? { index: match.index, length: match[0].length } : undefined;
}

function parseSseEvent(event: string): unknown {
  const data = event
    .split(/\r?\n/u)
    .filter((line) => line.startsWith("data:"))
    .map((line) => line.slice(5).trimStart())
    .join("\n")
    .trim();
  if (!data || data === "[DONE]") {
    return undefined;
  }

  try {
    return JSON.parse(data) as unknown;
  } catch {
    throw new GeminiTtsResponseError("Gemini TTS returned malformed streaming data");
  }
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

function assertGeminiTtsCompleted(payload: unknown): void {
  const finishReason = getGeminiFinishReason(payload);
  if (finishReason) {
    assertGeminiTtsFinishReason(finishReason);
  }
}

function assertGeminiTtsFinishReason(finishReason: string): void {
  if (finishReason === "MAX_TOKENS") {
    throw new GeminiTtsOutputLimitError();
  }
  if (finishReason !== "STOP") {
    throw new GeminiTtsResponseError(`Gemini TTS stopped with finish reason '${finishReason}'`);
  }
}

function getGeminiFinishReason(payload: unknown): string | undefined {
  if (!isObject(payload) || !Array.isArray(payload.candidates)) {
    return undefined;
  }

  for (const candidate of payload.candidates) {
    if (isObject(candidate) && typeof candidate.finishReason === "string") {
      return candidate.finishReason;
    }
  }
  return undefined;
}

function extractGeminiInlineAudioData(payload: unknown): string | undefined {
  return extractGeminiInlineAudioDataParts(payload)[0];
}

function extractGeminiInlineAudioDataParts(payload: unknown): string[] {
  if (!isObject(payload) || !Array.isArray(payload.candidates)) {
    return [];
  }

  const audioData: string[] = [];
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
        audioData.push(data);
      }
    }
  }

  return audioData;
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
  const segmentCount = Math.max(1, Math.ceil(totalWeight / MAX_SPEECH_SEGMENT_WEIGHT));
  if (segmentCount === 1) {
    return [normalizedText];
  }

  const boundaries = [0];
  for (let segment = 1; segment < segmentCount; segment += 1) {
    const previousBoundary = boundaries.at(-1)!;
    const previousWeight = cumulativeWeights[previousBoundary]!;
    const remainingSegments = segmentCount - segment;
    const minimumWeight = Math.max(
      previousWeight + 1,
      totalWeight - remainingSegments * MAX_SPEECH_SEGMENT_WEIGHT,
    );
    const maximumWeight = Math.min(
      previousWeight + MAX_SPEECH_SEGMENT_WEIGHT,
      totalWeight - remainingSegments,
    );
    const idealWeight = (totalWeight * segment) / segmentCount;
    const maximumBoundary = characters.length - remainingSegments;
    const candidates = Array.from(
      { length: maximumBoundary - previousBoundary },
      (_, offset) => previousBoundary + offset + 1,
    ).filter((index) => {
      const weight = cumulativeWeights[index]!;
      return weight >= minimumWeight && weight <= maximumWeight;
    });
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
