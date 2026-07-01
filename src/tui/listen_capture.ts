import { readFile, unlink } from "node:fs/promises";
import {
  type Config,
  getGoogleApiKey,
  getMistralApiKey,
  type SpeechToTextProvider,
} from "../core/config/index.js";
import type { CoreDeps } from "../core/runtime/deps.js";
import type { SpawnCaptureResult } from "../core/utils/spawn_capture.js";
import { transcribeAudio } from "../core/utils/speech_to_text.js";

export const LISTEN_TEMP_FILE_TEMPLATE = "/tmp/tau-listen.XXXXXX";
export const LISTEN_RECORDING_MIN_BYTES = 1024;
export const LISTEN_RECORDING_MAX_DURATION_MS = 5 * 60 * 1000;

export type ListenRecording = {
  audioPath: string;
  stopRequested: boolean;
  abortController: AbortController;
  completion: Promise<SpawnCaptureResult>;
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
}): Promise<SpawnCaptureResult> {
  return args.deps.spawn(
    "ffmpeg",
    [
      "-hide_banner",
      "-loglevel",
      "error",
      "-nostdin",
      "-f",
      "avfoundation",
      "-i",
      ":0",
      "-ac",
      "1",
      "-ar",
      "16000",
      "-c:a",
      "pcm_s16le",
      "-f",
      "wav",
      "-y",
      args.audioPath,
    ],
    {
      detached: true,
      killProcessGroup: true,
      signal: args.signal,
      stdio: ["ignore", "ignore", "ignore"],
    },
  );
}

export async function readListenAudio(path: string): Promise<Buffer> {
  return await readFile(path);
}

export async function cleanupListenTempFile(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch {
    // best-effort cleanup
  }
}

export function getSpeechToTextProvider(config: Config): SpeechToTextProvider {
  return config.speechToText?.provider ?? "mistral";
}

export function getSpeechToTextApiKey(config: Config, deps: CoreDeps): string | undefined {
  const provider = getSpeechToTextProvider(config);
  return provider === "gemini"
    ? getGoogleApiKey(config, deps.env.env())
    : getMistralApiKey(config, deps.env.env());
}

export function getSpeechToTextApiKeyErrorMessage(config: Config, action: string): string {
  const provider = getSpeechToTextProvider(config);
  return provider === "gemini"
    ? `set GEMINI_API_KEY or apiKeys.google to ${action}`
    : `set MISTRAL_API_KEY or apiKeys.mistral to ${action}`;
}

export async function transcribeListenAudio(args: {
  config: Config;
  deps: CoreDeps;
  audio: Buffer;
}): Promise<string> {
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
  });
}
