import type { SpeechToTextProvider } from "../config/schema.js";
import { transcribeGeminiAudio } from "./gemini_transcription.js";
import { transcribeMistralAudio } from "./mistral_transcription.js";
import type { SpeechToTextContext } from "./speech_to_text_context.js";

export type SpeechToTextOptions = {
  provider: SpeechToTextProvider;
  apiKey: string;
  audio: Buffer;
  mimeType?: string;
  fileName?: string;
  language?: string;
  context?: SpeechToTextContext;
  fetchImpl?: typeof fetch;
};

export async function transcribeAudio(options: SpeechToTextOptions): Promise<string> {
  switch (options.provider) {
    case "gemini":
      return await transcribeGeminiAudio({
        apiKey: options.apiKey,
        audio: options.audio,
        mimeType: options.mimeType,
        context: options.context,
        fetchImpl: options.fetchImpl,
      });
    case "mistral":
      return await transcribeMistralAudio({
        apiKey: options.apiKey,
        audio: options.audio,
        mimeType: options.mimeType,
        fileName: options.fileName,
        language: options.language,
        fetchImpl: options.fetchImpl,
      });
  }
}
