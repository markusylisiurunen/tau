import { z } from "zod";
import { formatSpeechToTextContext, type SpeechToTextContext } from "./speech_to_text_context.js";

const GEMINI_GENERATE_CONTENT_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/models";
const PRIMARY_GEMINI_TRANSCRIPTION_MODEL = "gemini-3.7-flash";
const PRIMARY_GEMINI_TRANSCRIPTION_THINKING_LEVEL = "low";
const FALLBACK_GEMINI_TRANSCRIPTION_MODEL = "gemini-3.6-flash";
const FALLBACK_GEMINI_TRANSCRIPTION_THINKING_LEVEL = "minimal";
const DEFAULT_GEMINI_AUDIO_MIME_TYPE = "audio/wav";
const MAX_RETRY_DELAY_MS = 5_000;

const RETRYABLE_GEMINI_ERROR_STATUSES = new Set([
  "DEADLINE_EXCEEDED",
  "INTERNAL",
  "NOT_FOUND",
  "RESOURCE_EXHAUSTED",
  "UNAVAILABLE",
]);

const GEMINI_TRANSCRIPTION_ATTEMPTS = [
  {
    model: PRIMARY_GEMINI_TRANSCRIPTION_MODEL,
    thinkingLevel: PRIMARY_GEMINI_TRANSCRIPTION_THINKING_LEVEL,
    progress: undefined,
    delayMs: 0,
    usedFallback: false,
  },
  {
    model: PRIMARY_GEMINI_TRANSCRIPTION_MODEL,
    thinkingLevel: PRIMARY_GEMINI_TRANSCRIPTION_THINKING_LEVEL,
    progress: "retrying" as const,
    delayMs: 250,
    usedFallback: false,
  },
  {
    model: FALLBACK_GEMINI_TRANSCRIPTION_MODEL,
    thinkingLevel: FALLBACK_GEMINI_TRANSCRIPTION_THINKING_LEVEL,
    progress: "trying-fallback" as const,
    delayMs: 500,
    usedFallback: true,
  },
];

const errorPayloadSchema = z.object({
  error: z
    .object({
      message: z.string().trim().min(1).optional(),
      status: z.string().trim().min(1).optional(),
      code: z.number().int().optional(),
    })
    .optional(),
});

const GEMINI_TRANSCRIPTION_RESPONSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    transcription: { type: "STRING" },
  },
  required: ["transcription"],
};

const textPartSchema = z.object({ text: z.string() });
const apiResponseSchema = z.object({
  candidates: z
    .array(
      z.object({
        content: z.object({
          parts: z.array(z.unknown()).optional(),
        }),
      }),
    )
    .optional(),
});
const transcriptionResultSchema = z.object({
  transcription: z.string().trim().min(1),
});

export type GeminiTranscriptionProgress = "retrying" | "trying-fallback";

export type GeminiTranscriptionResult = {
  text: string;
  usedFallback: boolean;
};

export type GeminiTranscriptionOptions = {
  apiKey: string;
  audio: Buffer;
  mimeType?: string;
  context?: SpeechToTextContext;
  fetchImpl?: typeof fetch;
  onProgress?: (progress: GeminiTranscriptionProgress) => void;
};

class GeminiTranscriptionAttemptError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly retryAfterMs = 0,
  ) {
    super(message);
  }
}

export async function transcribeGeminiAudio(
  options: GeminiTranscriptionOptions,
): Promise<GeminiTranscriptionResult> {
  const apiKey = options.apiKey.trim();
  if (!apiKey) {
    throw new Error("missing Gemini API key");
  }

  const fetchFn = options.fetchImpl ?? fetch;
  let retryAfterMs = 0;

  for (const [index, attempt] of GEMINI_TRANSCRIPTION_ATTEMPTS.entries()) {
    if (attempt.progress) {
      options.onProgress?.(attempt.progress);
      await waitForRetry(Math.max(attempt.delayMs, retryAfterMs));
    }

    try {
      const text = await requestGeminiTranscription({
        apiKey,
        audio: options.audio,
        mimeType: options.mimeType ?? DEFAULT_GEMINI_AUDIO_MIME_TYPE,
        context: options.context,
        fetchFn,
        model: attempt.model,
        thinkingLevel: attempt.thinkingLevel,
      });
      return { text, usedFallback: attempt.usedFallback };
    } catch (error) {
      if (
        !(error instanceof GeminiTranscriptionAttemptError) ||
        !error.retryable ||
        index === GEMINI_TRANSCRIPTION_ATTEMPTS.length - 1
      ) {
        throw error;
      }
      retryAfterMs = error.retryAfterMs;
    }
  }

  throw new Error("Gemini transcription attempts exhausted");
}

async function requestGeminiTranscription(args: {
  apiKey: string;
  audio: Buffer;
  mimeType: string;
  context?: SpeechToTextContext;
  fetchFn: typeof fetch;
  model: string;
  thinkingLevel: string;
}): Promise<string> {
  let response: Response;
  try {
    response = await args.fetchFn(
      `${GEMINI_GENERATE_CONTENT_BASE_URL}/${encodeURIComponent(args.model)}:generateContent`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": args.apiKey,
        },
        body: JSON.stringify({
          systemInstruction: {
            parts: [
              {
                text: buildTranscriptionSystemInstruction(),
              },
            ],
          },
          contents: [
            {
              parts: [
                {
                  text: buildTranscriptionPrompt(args.context),
                },
                {
                  inlineData: {
                    mimeType: args.mimeType,
                    data: args.audio.toString("base64"),
                  },
                },
              ],
            },
          ],
          generationConfig: {
            responseMimeType: "application/json",
            responseSchema: GEMINI_TRANSCRIPTION_RESPONSE_SCHEMA,
            thinkingConfig: {
              thinkingLevel: args.thinkingLevel,
            },
          },
        }),
      },
    );
  } catch (error) {
    throw new GeminiTranscriptionAttemptError((error as Error).message, true);
  }

  let responseText: string;
  try {
    responseText = await response.text();
  } catch (error) {
    throw new GeminiTranscriptionAttemptError((error as Error).message, true);
  }

  let payload: unknown;
  try {
    payload = responseText ? (JSON.parse(responseText) as unknown) : undefined;
  } catch {
    payload = undefined;
  }

  if (!response.ok) {
    const parsed = errorPayloadSchema.safeParse(payload);
    const fallbackMessage = responseText.trim() || `HTTP ${response.status}`;
    const errorStatus = parsed.success ? parsed.data.error?.status : undefined;
    throw new GeminiTranscriptionAttemptError(
      parsed.success ? (parsed.data.error?.message ?? fallbackMessage) : fallbackMessage,
      isRetryableGeminiError(response.status, errorStatus),
      parseRetryAfterMs(response.headers.get("retry-after")),
    );
  }

  const text = extractGeminiText(payload);
  if (!text) {
    throw new GeminiTranscriptionAttemptError("transcription result was empty or malformed", true);
  }
  return text;
}

function isRetryableGeminiError(status: number, errorStatus: string | undefined): boolean {
  return (
    status === 408 ||
    status === 429 ||
    status >= 500 ||
    (errorStatus !== undefined && RETRYABLE_GEMINI_ERROR_STATUSES.has(errorStatus))
  );
}

function parseRetryAfterMs(value: string | null): number {
  if (!value) return 0;

  const seconds = Number(value);
  if (Number.isFinite(seconds)) {
    return Math.min(Math.max(0, seconds * 1_000), MAX_RETRY_DELAY_MS);
  }

  const dateMs = Date.parse(value);
  if (!Number.isFinite(dateMs)) return 0;
  return Math.min(Math.max(0, dateMs - Date.now()), MAX_RETRY_DELAY_MS);
}

async function waitForRetry(delayMs: number): Promise<void> {
  if (delayMs <= 0) return;
  await new Promise((resolve) => setTimeout(resolve, delayMs));
}

function buildTranscriptionSystemInstruction(): string {
  return [
    "You are a speech-to-text engine.",
    "Transcribe the speaker's intended message for insertion into a chat input.",
    "Detect the speaker's language and transcribe in that same language; never translate unless the speaker explicitly asks for translation.",
    "Preserve the speaker's wording and register as spoken, including colloquial forms, dialect, and informal language; do not normalize informal speech into formal standard language.",
    "Use natural punctuation and capitalization where helpful, without changing the speaker's wording or register.",
    "Lightly clean only speech artifacts that do not affect meaning, such as filler words, repeated stutters, obvious false starts, and unintelligible mumbling.",
    "Do not rewrite, paraphrase, summarize, answer the speaker, add labels, add timestamps, or describe background sounds.",
  ].join("\n");
}

function buildTranscriptionPrompt(context: SpeechToTextContext | undefined): string {
  const formattedContext = formatSpeechToTextContext(context);
  return [
    "Transcribe the attached audio into the transcription field.",
    "Return only the lightly cleaned transcript text, with no timestamps or commentary.",
    formattedContext
      ? [
          "Use the recent conversation context below only to resolve likely words, names, acronyms, terminology, and references in the audio.",
          "Do not transcribe the context itself, and do not add words from the context that were not spoken.",
          "If the audio is ambiguous, prefer the transcription that best fits this context.",
          "",
          "Recent conversation context:",
          formattedContext,
        ].join("\n")
      : undefined,
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}

function extractGeminiText(payload: unknown): string | undefined {
  const parsed = apiResponseSchema.safeParse(payload);
  if (!parsed.success) {
    return undefined;
  }

  const responseText = (parsed.data.candidates?.[0]?.content.parts ?? [])
    .map((part) => {
      const parsedPart = textPartSchema.safeParse(part);
      return parsedPart.success ? parsedPart.data.text : "";
    })
    .join("");

  let transcriptionPayload: unknown;
  try {
    transcriptionPayload = responseText ? (JSON.parse(responseText) as unknown) : undefined;
  } catch {
    return undefined;
  }

  const transcription = transcriptionResultSchema.safeParse(transcriptionPayload);
  return transcription.success ? transcription.data.transcription : undefined;
}
