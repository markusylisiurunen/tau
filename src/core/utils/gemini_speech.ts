import { z } from "zod";

const GEMINI_GENERATE_CONTENT_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/models";
const DEFAULT_GEMINI_SPEECH_REWRITE_MODEL = "gemini-3-flash-preview";
const DEFAULT_GEMINI_SPEECH_TTS_MODEL = "gemini-3.1-flash-tts-preview";
const DEFAULT_GEMINI_TTS_VOICE_NAME = "Despina";
const DEFAULT_TTS_SAMPLE_RATE_HZ = 24000;
const DEFAULT_TTS_CHANNEL_COUNT = 1;
const DEFAULT_TTS_BITS_PER_SAMPLE = 16;
const DEFAULT_TTS_MAX_ATTEMPTS = 3;
const DEFAULT_TTS_CONCURRENCY = 6;
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

export type GeminiSpeechChunkProgress = {
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
  onChunkProgress?: (progress: GeminiSpeechChunkProgress) => void | Promise<void>;
};

export type GeminiSpeechResult = {
  spokenText: string;
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

export async function generateGeminiSpeech(
  options: GeminiSpeechOptions,
): Promise<GeminiSpeechResult> {
  const sourceText = options.sourceText.trim();
  if (!sourceText) {
    throw new Error("speech source text was empty");
  }

  const apiKey = options.apiKey.trim();
  if (!apiKey) {
    throw new Error("missing Gemini API key");
  }

  const fetchImpl = options.fetchImpl ?? fetch;
  const rewriteModel = options.rewriteModel ?? DEFAULT_GEMINI_SPEECH_REWRITE_MODEL;
  const ttsModel = options.ttsModel ?? DEFAULT_GEMINI_SPEECH_TTS_MODEL;
  const voiceName = options.voiceName ?? DEFAULT_GEMINI_TTS_VOICE_NAME;
  await options.onStageChange?.("rewriting");
  const spokenText = await rewriteTextForSpeech({
    apiKey,
    model: rewriteModel,
    sourceText,
    fetchImpl,
    signal: options.signal,
  });

  const spokenParagraphs = splitSpeechParagraphs(spokenText);
  await options.onStageChange?.("generating");
  await options.onChunkProgress?.({ ready: 0, total: spokenParagraphs.length });
  const pcmChunks = await synthesizeSpeechAudioChunks({
    apiKey,
    model: ttsModel,
    voiceName,
    spokenParagraphs,
    fetchImpl,
    signal: options.signal,
    maxAttempts: options.maxTtsAttempts ?? DEFAULT_TTS_MAX_ATTEMPTS,
    concurrency: DEFAULT_TTS_CONCURRENCY,
    onChunkProgress: options.onChunkProgress,
  });

  return {
    spokenText,
    audio: encodeWaveFile({
      pcmAudio: Buffer.concat(pcmChunks),
      sampleRateHz: DEFAULT_TTS_SAMPLE_RATE_HZ,
      channelCount: DEFAULT_TTS_CHANNEL_COUNT,
      bitsPerSample: DEFAULT_TTS_BITS_PER_SAMPLE,
    }),
    mimeType: "audio/wav",
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
          thinkingLevel: "minimal",
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
  spokenParagraphs: string[];
  fetchImpl: typeof fetch;
  signal?: AbortSignal;
  maxAttempts: number;
  concurrency: number;
  onChunkProgress?: (progress: GeminiSpeechChunkProgress) => void | Promise<void>;
};

async function synthesizeSpeechAudioChunks(
  args: SynthesizeSpeechAudioChunksArgs,
): Promise<Buffer[]> {
  const total = args.spokenParagraphs.length;
  const results = new Array<Buffer>(total);
  const concurrency = Math.max(1, Math.trunc(args.concurrency));
  let nextIndex = 0;
  let ready = 0;

  const worker = async (): Promise<void> => {
    while (true) {
      const index = nextIndex;
      nextIndex += 1;
      if (index >= total) {
        return;
      }

      results[index] = await synthesizeSpeechAudioChunk({
        apiKey: args.apiKey,
        model: args.model,
        voiceName: args.voiceName,
        spokenText: args.spokenParagraphs[index]!,
        fetchImpl: args.fetchImpl,
        signal: args.signal,
        maxAttempts: args.maxAttempts,
      });
      ready += 1;
      await args.onChunkProgress?.({ ready, total });
    }
  };

  await Promise.all(Array.from({ length: Math.min(concurrency, total) }, () => worker()));
  return results;
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
            temperature: 1,
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
    "For file references, keep the filename and any line or range info that was actually present. Do not add location detail that was not in the original.",
    "Say code identifiers and version strings as natural words (for example, handleToolUiEvent as 'handle tool UI event', v5.4 as 'version 5.4'). Keep numbers and units natural (for example, 8,192 tokens as 'about eight thousand tokens').",
    "",
    "Examples of good rewrites:",
    '- `src/core/utils/gemini_speech.ts:372` → "gemini_speech.ts, line 372"',
    '- `src/tui/chat_controller.ts:1819-1855` → "chat_controller.ts, lines 1819 to 1855"',
    '- `src/core/session/compaction.ts` → "compaction.ts"',
    '- `/Users/markus/.config/tau/config.json` → "the tau config.json in your home directory"',
    '- `rg --heading -n -t ts "ToolUiText" src` → "ripgrep for ToolUiText in TypeScript files under src"',
    '- `<available-skills>` → "the available-skills tag"',
    "- A markdown bullet list of short items → a natural comma-separated list or short sentences",
    "",
    "Write in prose-like paragraphs of sensible spoken length, separated by blank lines.",
    "Return plain text only, with no markdown fences or commentary.",
    "",
    "ASSISTANT RESPONSE:",
    sourceText,
  ].join("\n");
}

function splitSpeechParagraphs(spokenText: string): string[] {
  const paragraphs = spokenText
    .split(/\n\s*\n/g)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0);

  return paragraphs.length > 0 ? paragraphs : [spokenText.trim()];
}

function buildSpeechSynthesisPrompt(spokenText: string): string {
  return [
    "Synthesize speech audio for the labeled transcript below.",
    "Speak only the transcript. Do not speak the instructions, labels, or headings.",
    "",
    "### DIRECTOR'S NOTES",
    "Style: Clear, natural, conversational.",
    "Pacing: Slightly slower than conversational, with deliberate enunciation. The audio will be sped up during playback.",
    "",
    "### TRANSCRIPT",
    spokenText,
  ].join("\n");
}

function isRetryableTtsError(error: unknown): boolean {
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
