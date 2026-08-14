import { z } from "zod";

const MISTRAL_TRANSCRIPTION_URL = "https://api.mistral.ai/v1/audio/transcriptions";
const DEFAULT_MISTRAL_TRANSCRIPTION_MODEL = "voxtral-mini-latest";
const DEFAULT_MISTRAL_LANGUAGE = "en";
const DEFAULT_MISTRAL_AUDIO_MIME_TYPE = "audio/wav";
const DEFAULT_MISTRAL_AUDIO_FILE_NAME = "speech.wav";

const errorSchema = z.object({ message: z.string() });
const successSchema = z.object({ text: z.string().trim().min(1) });

export type MistralTranscriptionOptions = {
  apiKey: string;
  audio: Buffer;
  model?: string;
  language?: string;
  mimeType?: string;
  fileName?: string;
  fetchImpl?: typeof fetch;
};

export async function transcribeMistralAudio(
  options: MistralTranscriptionOptions,
): Promise<string> {
  const formData = new FormData();
  formData.append("model", options.model ?? DEFAULT_MISTRAL_TRANSCRIPTION_MODEL);
  formData.append(
    "file",
    new Blob([Uint8Array.from(options.audio)], {
      type: options.mimeType ?? DEFAULT_MISTRAL_AUDIO_MIME_TYPE,
    }),
    options.fileName ?? DEFAULT_MISTRAL_AUDIO_FILE_NAME,
  );

  const language = options.language?.trim() || DEFAULT_MISTRAL_LANGUAGE;
  formData.append("language", language);

  const fetchFn = options.fetchImpl ?? fetch;
  const response = await fetchFn(MISTRAL_TRANSCRIPTION_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${options.apiKey}`,
    },
    body: formData,
  });

  const responseText = await response.text();
  let payload: unknown;
  try {
    payload = responseText ? JSON.parse(responseText) : undefined;
  } catch {
    payload = undefined;
  }

  if (!response.ok) {
    const parsed = errorSchema.safeParse(payload);
    throw new Error(
      parsed.success ? parsed.data.message : responseText.trim() || `HTTP ${response.status}`,
    );
  }

  const parsed = successSchema.safeParse(payload);
  if (!parsed.success) {
    throw new Error("transcription result was empty or malformed");
  }
  return parsed.data.text;
}
