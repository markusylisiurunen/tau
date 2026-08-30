import type { ChildProcess } from "node:child_process";
import { readFile, unlink } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type Config,
  getGoogleApiKey,
  getOpenAIApiKey,
  type SpeechToTextProvider,
} from "../core/config/index.js";
import type { CoreDeps } from "../core/runtime/deps.js";
import type { SpawnCaptureResult } from "../core/utils/spawn_capture.js";
import {
  createSpeechToTextTranscription,
  type SpeechToTextDependencies,
  type SpeechToTextTranscription,
} from "../core/utils/speech_to_text.js";
import type { SpeechToTextContext } from "../core/utils/speech_to_text_context.js";

export const LISTEN_TEMP_FILE_TEMPLATE = join(tmpdir(), "tau-listen.XXXXXX");
export const LISTEN_CAPTURE_START_TIMEOUT_MS = 15_000;
export const LISTEN_RECORDING_MIN_BYTES = 1024;

export type ListenRecording = {
  audioPath: string;
  startedAt: number;
  stopRequested: boolean;
  abortController: AbortController;
  completion: Promise<SpawnCaptureResult>;
  transcription: SpeechToTextTranscription;
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
  streamingSampleRate: number;
  onAudioChunk: (audio: Buffer) => void;
}): { completion: Promise<SpawnCaptureResult>; started: Promise<void> } {
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
    "16000",
    "-c:a",
    "pcm_s16le",
    "-f",
    "wav",
    "-y",
    args.audioPath,
  ];
  const streamOutputArgs = [
    "-map",
    "0:a",
    "-ac",
    "1",
    "-ar",
    String(args.streamingSampleRate),
    "-c:a",
    "pcm_s16le",
    "-f",
    "s16le",
    "pipe:1",
  ];

  const {
    promise: started,
    resolve: resolveStarted,
    reject: rejectStarted,
  } = Promise.withResolvers<void>();
  let receivedAudio = false;
  const completion = args.deps.spawn(
    "ffmpeg",
    [...inputArgs, ...waveOutputArgs, ...streamOutputArgs],
    {
      detached: true,
      killProcessGroup: true,
      signal: args.signal,
      captureOutput: "stderr",
      maxCaptureBytes: 20_000,
      stdio: ["ignore", "pipe", "pipe"],
      onSpawn: (child: ChildProcess) => {
        child.stdout?.on("data", (chunk: Buffer) => {
          if (!receivedAudio) {
            receivedAudio = true;
            resolveStarted();
          }
          args.onAudioChunk(chunk);
        });
      },
    },
  );
  void completion.then(
    (result) => {
      if (receivedAudio) return;
      const detail = result.stderr.trim();
      rejectStarted(
        new Error(
          detail
            ? `ffmpeg failed to start recording: ${detail}`
            : "ffmpeg exited before recording audio",
        ),
      );
    },
    (error) => rejectStarted(error),
  );
  return { completion, started };
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
  return config.speechToText?.provider ?? "openai";
}

export function getSpeechToTextApiKey(config: Config, deps: CoreDeps): string | undefined {
  const provider = getSpeechToTextProvider(config);
  switch (provider) {
    case "gemini":
      return getGoogleApiKey(config, deps.env.env());
    case "openai":
      return getOpenAIApiKey(config, deps.env.env());
  }
}

export function getSpeechToTextApiKeyErrorMessage(config: Config, action: string): string {
  const provider = getSpeechToTextProvider(config);
  switch (provider) {
    case "gemini":
      return `set GEMINI_API_KEY or apiKeys.google to ${action}`;
    case "openai":
      return `set OPENAI_API_KEY or apiKeys.openai to ${action}`;
  }
}

export function createListenTranscription(args: {
  config: Config;
  deps: CoreDeps;
  mode: "streaming" | "file";
  context?: SpeechToTextContext;
  speechToTextDeps?: SpeechToTextDependencies;
}): SpeechToTextTranscription {
  const provider = getSpeechToTextProvider(args.config);
  const apiKey = getSpeechToTextApiKey(args.config, args.deps);
  if (!apiKey) {
    throw new Error(getSpeechToTextApiKeyErrorMessage(args.config, "transcribe speech"));
  }

  return createSpeechToTextTranscription({
    provider,
    mode: args.mode,
    apiKey,
    context: args.context,
    deps: {
      ...args.speechToTextDeps,
      spawnImpl: args.speechToTextDeps?.spawnImpl ?? args.deps.spawn,
    },
  });
}
