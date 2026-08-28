import type { SpeechToTextProvider } from "../config/schema.js";
import { startGeminiTranscription, transcribeGeminiAudio } from "./gemini_transcription.js";
import { startOpenAITranscription, transcribeOpenAIAudio } from "./openai_transcription.js";
import type { spawnWithCapture } from "./spawn_capture.js";
import type { SpeechToTextContext } from "./speech_to_text_context.js";

export type SpeechToTextWebSocket = {
  on(event: "open", listener: () => void): unknown;
  on(event: "message", listener: (data: unknown) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  on(event: "close", listener: (code: number, reason: Buffer) => void): unknown;
  send(data: string, callback?: (error?: Error) => void): void;
  close(): void;
  terminate(): void;
};

export type SpeechToTextWebSocketFactory = (
  url: string,
  options?: { headers?: Record<string, string> },
) => SpeechToTextWebSocket;

export type SpeechToTextDependencies = {
  fetchImpl?: typeof fetch;
  webSocketFactory?: SpeechToTextWebSocketFactory;
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
};

export type SpeechToTextTranscription = {
  appendAudio(audio: Buffer): void;
  finish(recording: SpeechToTextRecording, options?: { signal?: AbortSignal }): Promise<string>;
  abort(): void;
};

export function getSpeechToTextStreamingSampleRate(provider: SpeechToTextProvider): number {
  switch (provider) {
    case "gemini":
      return 16_000;
    case "openai":
      return 24_000;
  }
}

export function createSpeechToTextTranscription(
  options: SpeechToTextTranscriptionOptions,
): SpeechToTextTranscription {
  switch (options.provider) {
    case "gemini": {
      if (options.mode === "streaming") {
        const transcription = startGeminiTranscription({
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
    }
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
