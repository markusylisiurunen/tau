const MISTRAL_TRANSCRIPTION_URL = "https://api.mistral.ai/v1/audio/transcriptions";
const DEFAULT_MISTRAL_TRANSCRIPTION_MODEL = "voxtral-mini-latest";
const DEFAULT_MISTRAL_LANGUAGE = "en";
const DEFAULT_MISTRAL_AUDIO_MIME_TYPE = "audio/wav";
const DEFAULT_MISTRAL_AUDIO_FILE_NAME = "speech.wav";

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
    new Blob([options.audio], {
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

  let payload: unknown;
  const responseText = await response.text();
  if (responseText) {
    try {
      payload = JSON.parse(responseText) as unknown;
    } catch {
      payload = undefined;
    }
  }

  if (!response.ok) {
    const fromObject =
      payload && typeof payload === "object" && "message" in payload
        ? (payload as Record<string, unknown>).message
        : undefined;
    const fromString = typeof fromObject === "string" ? fromObject : undefined;
    const fallback = responseText.trim() || `HTTP ${response.status}`;
    throw new Error(fromString || fallback);
  }

  const text =
    payload && typeof payload === "object" && "text" in payload
      ? (payload as Record<string, unknown>).text
      : undefined;
  if (typeof text !== "string") {
    return "";
  }

  return text;
}
