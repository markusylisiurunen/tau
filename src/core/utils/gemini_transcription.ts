import { z } from "zod";
import { formatSpeechToTextContext, type SpeechToTextContext } from "./speech_to_text_context.js";

const GEMINI_GENERATE_CONTENT_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/models";
const GEMINI_TRANSCRIPTION_MODEL = "gemini-3.7-flash";
const GEMINI_TRANSCRIPTION_THINKING_LEVEL = "low";
const DEFAULT_GEMINI_AUDIO_MIME_TYPE = "audio/wav";

const errorPayloadSchema = z.object({
  error: z
    .object({
      message: z.string().trim().min(1).optional(),
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

export type GeminiTranscriptionOptions = {
  apiKey: string;
  audio: Buffer;
  mimeType?: string;
  context?: SpeechToTextContext;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
};

export async function transcribeGeminiAudio(options: GeminiTranscriptionOptions): Promise<string> {
  const apiKey = options.apiKey.trim();
  if (!apiKey) {
    throw new Error("missing Gemini API key");
  }

  const fetchFn = options.fetchImpl ?? fetch;
  const response = await fetchFn(
    `${GEMINI_GENERATE_CONTENT_BASE_URL}/${GEMINI_TRANSCRIPTION_MODEL}:generateContent`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey,
      },
      signal: options.signal,
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
                text: buildTranscriptionPrompt(options.context),
              },
              {
                inlineData: {
                  mimeType: options.mimeType ?? DEFAULT_GEMINI_AUDIO_MIME_TYPE,
                  data: options.audio.toString("base64"),
                },
              },
            ],
          },
        ],
        generationConfig: {
          responseMimeType: "application/json",
          responseSchema: GEMINI_TRANSCRIPTION_RESPONSE_SCHEMA,
          thinkingConfig: {
            thinkingLevel: GEMINI_TRANSCRIPTION_THINKING_LEVEL,
          },
        },
      }),
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
    throw new Error(
      parsed.success ? (parsed.data.error?.message ?? fallbackMessage) : fallbackMessage,
    );
  }

  const text = extractGeminiText(payload);
  if (!text) {
    throw new Error("transcription result was empty or malformed");
  }
  return text;
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
