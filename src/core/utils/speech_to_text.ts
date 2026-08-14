import type { SpeechToTextProvider } from "../config/schema.js";
import { type GeminiTranscriptionProgress, transcribeGeminiAudio } from "./gemini_transcription.js";
import { transcribeMistralAudio } from "./mistral_transcription.js";
import {
  type OpenAIStreamingTranscription,
  type OpenAITranscriptionWebSocketFactory,
  startOpenAITranscription,
  transcribeOpenAIAudio,
} from "./openai_transcription.js";
import type { spawnWithCapture } from "./spawn_capture.js";
import type { SpeechToTextContext } from "./speech_to_text_context.js";

export type SpeechToTextProgress = GeminiTranscriptionProgress;

export type SpeechToTextDependencies = {
  webSocketFactory?: OpenAITranscriptionWebSocketFactory;
  spawnImpl?: typeof spawnWithCapture;
};

export type SpeechToTextOptions = SpeechToTextDependencies & {
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

export type StreamingSpeechToTextOptions = Pick<
  SpeechToTextOptions,
  "provider" | "apiKey" | "context" | "webSocketFactory"
>;

export type StreamingSpeechToText = OpenAIStreamingTranscription;

export type SpeechToTextResult = {
  text: string;
  usedFallback: boolean;
};

export async function startStreamingSpeechToText(
  options: StreamingSpeechToTextOptions,
): Promise<StreamingSpeechToText | undefined> {
  if (options.provider !== "openai") return undefined;
  return await startOpenAITranscription({
    apiKey: options.apiKey,
    context: options.context,
    webSocketFactory: options.webSocketFactory,
  });
}

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
    case "openai":
      return {
        text: await transcribeOpenAIAudio({
          apiKey: options.apiKey,
          audio: options.audio,
          context: options.context,
          webSocketFactory: options.webSocketFactory,
          spawnImpl: options.spawnImpl,
        }),
        usedFallback: false,
      };
  }
}
