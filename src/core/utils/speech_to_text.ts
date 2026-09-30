import { startGeminiTranscription, transcribeGeminiAudio } from "./gemini_transcription.js";
import type { SpeechToTextContext } from "./speech_to_text_context.js";

export const SPEECH_TO_TEXT_CLIENT_MAX_DURATION_MS = 20 * 60 * 1_000;

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
};

export type SpeechToTextTranscriptionOptions = {
  mode: "streaming" | "file";
  apiKey: string;
  openAIApiKey?: string;
  context?: SpeechToTextContext;
  deps?: SpeechToTextDependencies;
  onProgress?: (text: string) => void;
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

type ProviderStreamingTranscription = {
  appendAudio(audio: Buffer): void;
  finish(options?: { signal?: AbortSignal }): Promise<string>;
  abort(): void;
};

export function getSpeechToTextRecordingMaxDurationMs(): number {
  return 9 * 60 * 1_000;
}

export function getSpeechToTextStreamingSampleRate(): number {
  return 16_000;
}

export function createSpeechToTextTranscription(
  options: SpeechToTextTranscriptionOptions,
): SpeechToTextTranscription {
  if (options.mode === "streaming") {
    return createStreamingTranscription(
      startGeminiTranscription({
        onProgress: options.onProgress,
        apiKey: options.apiKey,
        openAIApiKey: options.openAIApiKey,
        context: options.context,
        fetchImpl: options.deps?.fetchImpl,
        webSocketFactory: options.deps?.webSocketFactory,
      }),
    );
  }

  return createBatchTranscription(async (recording, signal) => {
    return await transcribeGeminiAudio({
      apiKey: options.apiKey,
      openAIApiKey: options.openAIApiKey,
      audio: recording.audio,
      mimeType: recording.mimeType,
      context: options.context,
      signal,
      fetchImpl: options.deps?.fetchImpl,
    });
  });
}

function createStreamingTranscription(
  transcription: ProviderStreamingTranscription,
): SpeechToTextTranscription {
  return {
    appendAudio: (audio) => transcription.appendAudio(audio),
    finish: async (_recording, finishOptions) =>
      await transcription.finish({ signal: finishOptions?.signal }),
    abort: () => transcription.abort(),
  };
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
