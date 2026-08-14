import type { SpeechToTextProvider } from "../config/schema.js";
import { transcribeGeminiAudio } from "./gemini_transcription.js";
import { transcribeMistralAudio } from "./mistral_transcription.js";
import {
  type OpenAITranscriptionWebSocketFactory,
  startOpenAITranscription,
} from "./openai_transcription.js";
import type { spawnWithCapture } from "./spawn_capture.js";
import type { SpeechToTextContext } from "./speech_to_text_context.js";

export type SpeechToTextProgress = "retrying" | "trying-fallback";

export type SpeechToTextDependencies = {
  fetchImpl?: typeof fetch;
  webSocketFactory?: OpenAITranscriptionWebSocketFactory;
  spawnImpl?: typeof spawnWithCapture;
};

export type SpeechToTextTranscriptionOptions = {
  provider: SpeechToTextProvider;
  apiKey: string;
  context?: SpeechToTextContext;
  onProgress?: (progress: SpeechToTextProgress) => void;
  deps?: SpeechToTextDependencies;
};

export type SpeechToTextRecording = {
  audio: Buffer;
  mimeType?: string;
  fileName?: string;
  language?: string;
};

export type SpeechToTextResult = {
  text: string;
  usedFallback: boolean;
};

export type SpeechToTextTranscription = {
  appendAudio(audio: Buffer): void;
  finish(
    recording: SpeechToTextRecording,
    options?: { signal?: AbortSignal },
  ): Promise<SpeechToTextResult>;
  abort(): void;
};

export function createSpeechToTextTranscription(
  options: SpeechToTextTranscriptionOptions,
): SpeechToTextTranscription {
  switch (options.provider) {
    case "gemini":
      return createBatchTranscription(async (recording) => {
        return await transcribeGeminiAudio({
          apiKey: options.apiKey,
          audio: recording.audio,
          mimeType: recording.mimeType,
          context: options.context,
          fetchImpl: options.deps?.fetchImpl,
          onProgress: options.onProgress,
        });
      });
    case "mistral":
      return createBatchTranscription(async (recording) => {
        return {
          text: await transcribeMistralAudio({
            apiKey: options.apiKey,
            audio: recording.audio,
            mimeType: recording.mimeType,
            fileName: recording.fileName,
            language: recording.language,
            fetchImpl: options.deps?.fetchImpl,
          }),
          usedFallback: false,
        };
      });
    case "openai": {
      const transcription = startOpenAITranscription({
        apiKey: options.apiKey,
        context: options.context,
        webSocketFactory: options.deps?.webSocketFactory,
      });
      return {
        appendAudio: (audio) => transcription.appendAudio(audio),
        finish: async (recording, finishOptions) => ({
          text: await transcription.finish({
            audio: recording.audio,
            signal: finishOptions?.signal,
            spawnImpl: options.deps?.spawnImpl,
          }),
          usedFallback: false,
        }),
        abort: () => transcription.abort(),
      };
    }
  }
}

function createBatchTranscription(
  transcribe: (recording: SpeechToTextRecording) => Promise<SpeechToTextResult>,
): SpeechToTextTranscription {
  let aborted = false;
  return {
    appendAudio: () => {},
    finish: async (recording) => {
      if (aborted) {
        throw new Error("speech transcription was aborted");
      }
      const result = await transcribe(recording);
      if (aborted) {
        throw new Error("speech transcription was aborted");
      }
      return result;
    },
    abort: () => {
      aborted = true;
    },
  };
}
