import type { SpeechToTextProvider } from "../config/schema.js";
import { transcribeGeminiAudio } from "./gemini_transcription.js";
import { transcribeMistralAudio } from "./mistral_transcription.js";
import {
  type OpenAITranscriptionWebSocketFactory,
  startOpenAITranscription,
  transcribeOpenAIAudio,
} from "./openai_transcription.js";
import type { spawnWithCapture } from "./spawn_capture.js";
import type { SpeechToTextContext } from "./speech_to_text_context.js";

export type SpeechToTextDependencies = {
  fetchImpl?: typeof fetch;
  webSocketFactory?: OpenAITranscriptionWebSocketFactory;
  spawnImpl?: typeof spawnWithCapture;
};

export type SpeechToTextTranscriptionOptions = {
  provider: SpeechToTextProvider;
  mode: "streaming" | "file";
  apiKey: string;
  context?: SpeechToTextContext;
  deps?: SpeechToTextDependencies;
};

export type SpeechToTextRecording = {
  audio: Buffer;
  mimeType?: string;
  fileName?: string;
  language?: string;
};

export type SpeechToTextTranscription = {
  appendAudio(audio: Buffer): void;
  finish(recording: SpeechToTextRecording, options?: { signal?: AbortSignal }): Promise<string>;
  abort(): void;
};

export function createSpeechToTextTranscription(
  options: SpeechToTextTranscriptionOptions,
): SpeechToTextTranscription {
  switch (options.provider) {
    case "gemini":
      return createBatchTranscription(async (recording, signal) => {
        return await transcribeGeminiAudio({
          apiKey: options.apiKey,
          audio: recording.audio,
          mimeType: recording.mimeType,
          context: options.context,
          signal,
          fetchImpl: options.deps?.fetchImpl,
        });
      });
    case "mistral":
      return createBatchTranscription(async (recording, signal) => {
        return await transcribeMistralAudio({
          apiKey: options.apiKey,
          audio: recording.audio,
          mimeType: recording.mimeType,
          fileName: recording.fileName,
          language: recording.language,
          signal,
          fetchImpl: options.deps?.fetchImpl,
        });
      });
    case "openai": {
      if (options.mode === "streaming") {
        const transcription = startOpenAITranscription({
          apiKey: options.apiKey,
          context: options.context,
          fetchImpl: options.deps?.fetchImpl,
          webSocketFactory: options.deps?.webSocketFactory,
        });
        return {
          appendAudio: (audio) => transcription.appendAudio(audio),
          finish: async (_recording, finishOptions) =>
            await transcription.finish({ signal: finishOptions?.signal }),
          abort: () => transcription.abort(),
        };
      }

      const abortController = new AbortController();
      return {
        appendAudio: () => {},
        finish: async (recording, finishOptions) =>
          await transcribeOpenAIAudio({
            apiKey: options.apiKey,
            audio: recording.audio,
            context: options.context,
            signal: finishOptions?.signal
              ? AbortSignal.any([abortController.signal, finishOptions.signal])
              : abortController.signal,
            fetchImpl: options.deps?.fetchImpl,
            spawnImpl: options.deps?.spawnImpl,
          }),
        abort: () => abortController.abort(new Error("OpenAI transcription was aborted")),
      };
    }
  }
}

function createBatchTranscription(
  transcribe: (recording: SpeechToTextRecording, signal: AbortSignal) => Promise<string>,
): SpeechToTextTranscription {
  const abortController = new AbortController();
  return {
    appendAudio: () => {},
    finish: async (recording, finishOptions) => {
      const signal = finishOptions?.signal
        ? AbortSignal.any([abortController.signal, finishOptions.signal])
        : abortController.signal;
      signal.throwIfAborted();
      const result = await transcribe(recording, signal);
      signal.throwIfAborted();
      return result;
    },
    abort: () => abortController.abort(new Error("speech transcription was aborted")),
  };
}
