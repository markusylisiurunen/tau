import type { SpeechToTextProvider } from "../config/schema.js";
import { type GeminiTranscriptionProgress, transcribeGeminiAudio } from "./gemini_transcription.js";
import { transcribeMistralAudio } from "./mistral_transcription.js";
import type { SpeechToTextContext } from "./speech_to_text_context.js";

export type SpeechToTextProgress = GeminiTranscriptionProgress;

export type SpeechToTextOptions = {
  provider: SpeechToTextProvider;
  apiKey: string;
  audio: Buffer;
  mimeType?: string;
  fileName?: string;
  language?: string;
  context?: SpeechToTextContext;
  fetchImpl?: typeof fetch;
  onProgress?: (progress: SpeechToTextProgress) => void;
};

export type SpeechToTextResult = {
  text: string;
  usedFallback: boolean;
};

export async function transcribeAudio(options: SpeechToTextOptions): Promise<SpeechToTextResult> {
  switch (options.provider) {
    case "gemini":
      return await transcribeGeminiAudio({
        apiKey: options.apiKey,
        audio: options.audio,
        mimeType: options.mimeType,
        context: options.context,
        fetchImpl: options.fetchImpl,
        onProgress: options.onProgress,
      });
    case "mistral":
      return {
        text: await transcribeMistralAudio({
          apiKey: options.apiKey,
          audio: options.audio,
          mimeType: options.mimeType,
          fileName: options.fileName,
          language: options.language,
          fetchImpl: options.fetchImpl,
        }),
        usedFallback: false,
      };
  }
}
