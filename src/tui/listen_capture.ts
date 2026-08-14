import type { ChildProcess } from "node:child_process";
import { readFile, unlink } from "node:fs/promises";
import {
  type Config,
  getGoogleApiKey,
  getMistralApiKey,
  getOpenAIApiKey,
  type SpeechToTextProvider,
} from "../core/config/index.js";
import type { CoreDeps } from "../core/runtime/deps.js";
import type { SpawnCaptureResult } from "../core/utils/spawn_capture.js";
import {
  type SpeechToTextDependencies,
  type SpeechToTextProgress,
  type SpeechToTextResult,
  type StreamingSpeechToText,
  startStreamingSpeechToText,
  transcribeAudio,
} from "../core/utils/speech_to_text.js";
import type { SpeechToTextContext } from "../core/utils/speech_to_text_context.js";

export const LISTEN_TEMP_FILE_TEMPLATE = "/tmp/tau-listen.XXXXXX";
export const LISTEN_RECORDING_MIN_BYTES = 1024;
export const LISTEN_RECORDING_MAX_DURATION_MS = 5 * 60 * 1000;

export type ListenRecording = {
  audioPath: string;
  stopRequested: boolean;
  abortController: AbortController;
  completion: Promise<SpawnCaptureResult>;
  streamingTranscription?: StreamingSpeechToText;
  maxDurationTimeout?: ReturnType<typeof setTimeout>;
};

export async function createListenTempFilePath(deps: CoreDeps): Promise<string> {
  const result = await deps.spawn("mktemp", [LISTEN_TEMP_FILE_TEMPLATE]);
  if (result.exitCode !== 0) {
    const message = result.stderr.trim() || result.stdout.trim() || "mktemp failed";
    throw new Error(message);
  }

  const path = result.stdout.trim().split(/\r?\n/, 1)[0]?.trim();
  if (!path) {
    throw new Error("mktemp returned an empty path");
  }
  return path;
}

export function startListenAudioCapture(args: {
  deps: CoreDeps;
  audioPath: string;
  signal: AbortSignal;
  onAudioChunk?: (audio: Buffer) => void;
}): Promise<SpawnCaptureResult> {
  const inputArgs = [
    "-hide_banner",
    "-loglevel",
    "error",
    "-nostdin",
    "-f",
    "avfoundation",
    "-i",
    ":0",
  ];
  const waveOutputArgs = [
    "-map",
    "0:a",
    "-ac",
    "1",
    "-ar",
    args.onAudioChunk ? "24000" : "16000",
    "-c:a",
    "pcm_s16le",
    "-f",
    "wav",
    "-y",
    args.audioPath,
  ];
  const streamOutputArgs = args.onAudioChunk
    ? ["-map", "0:a", "-ac", "1", "-ar", "24000", "-c:a", "pcm_s16le", "-f", "s16le", "pipe:1"]
    : [];

  return args.deps.spawn("ffmpeg", [...inputArgs, ...waveOutputArgs, ...streamOutputArgs], {
    detached: true,
    killProcessGroup: true,
    signal: args.signal,
    ...(args.onAudioChunk
      ? {
          captureOutput: "stderr" as const,
          maxCaptureBytes: 20_000,
          stdio: ["ignore", "pipe", "pipe"] as ["ignore", "pipe", "pipe"],
          onSpawn: (child: ChildProcess) => {
            child.stdout?.on("data", (chunk: Buffer) => args.onAudioChunk?.(chunk));
          },
        }
      : { stdio: ["ignore", "ignore", "ignore"] as ["ignore", "ignore", "ignore"] }),
  });
}

export async function readListenAudio(path: string): Promise<Buffer> {
  return await readFile(path);
}

export async function deleteListenTempFile(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}

export async function cleanupListenTempFile(path: string): Promise<void> {
  try {
    await deleteListenTempFile(path);
  } catch {
    // best-effort cleanup
  }
}

export function getSpeechToTextProvider(config: Config): SpeechToTextProvider {
  return config.speechToText?.provider ?? "mistral";
}

export function getSpeechToTextApiKey(config: Config, deps: CoreDeps): string | undefined {
  const provider = getSpeechToTextProvider(config);
  switch (provider) {
    case "gemini":
      return getGoogleApiKey(config, deps.env.env());
    case "mistral":
      return getMistralApiKey(config, deps.env.env());
    case "openai":
      return getOpenAIApiKey(config, deps.env.env());
  }
}

export function getSpeechToTextApiKeyErrorMessage(config: Config, action: string): string {
  const provider = getSpeechToTextProvider(config);
  switch (provider) {
    case "gemini":
      return `set GEMINI_API_KEY or apiKeys.google to ${action}`;
    case "mistral":
      return `set MISTRAL_API_KEY or apiKeys.mistral to ${action}`;
    case "openai":
      return `set OPENAI_API_KEY or apiKeys.openai to ${action}`;
  }
}

export async function startListenStreamingTranscription(args: {
  config: Config;
  deps: CoreDeps;
  context?: SpeechToTextContext;
  speechToTextDeps?: SpeechToTextDependencies;
}): Promise<StreamingSpeechToText | undefined> {
  const provider = getSpeechToTextProvider(args.config);
  const apiKey = getSpeechToTextApiKey(args.config, args.deps);
  if (!apiKey) {
    throw new Error(getSpeechToTextApiKeyErrorMessage(args.config, "transcribe speech"));
  }

  return await startStreamingSpeechToText({
    provider,
    apiKey,
    context: args.context,
    webSocketFactory: args.speechToTextDeps?.webSocketFactory,
  });
}

export async function transcribeListenAudio(args: {
  config: Config;
  deps: CoreDeps;
  audio: Buffer;
  context?: SpeechToTextContext;
  onProgress?: (progress: SpeechToTextProgress) => void;
  speechToTextDeps?: SpeechToTextDependencies;
}): Promise<SpeechToTextResult> {
  const provider = getSpeechToTextProvider(args.config);
  const apiKey = getSpeechToTextApiKey(args.config, args.deps);
  if (!apiKey) {
    throw new Error(getSpeechToTextApiKeyErrorMessage(args.config, "transcribe speech"));
  }

  return await transcribeAudio({
    provider,
    apiKey,
    audio: args.audio,
    mimeType: "audio/wav",
    fileName: "speech.wav",
    language: "en",
    context: args.context,
    onProgress: args.onProgress,
    webSocketFactory: args.speechToTextDeps?.webSocketFactory,
    spawnImpl: args.speechToTextDeps?.spawnImpl ?? args.deps.spawn,
  });
}
