import type { ChildProcess } from "node:child_process";
import type { Writable } from "node:stream";
import type { CoreDeps } from "../core/runtime/deps.js";
import {
  GEMINI_SPEECH_BITS_PER_SAMPLE,
  GEMINI_SPEECH_CHANNEL_COUNT,
  GEMINI_SPEECH_PLAYBACK_RATE,
  GEMINI_SPEECH_SAMPLE_RATE_HZ,
  streamGeminiSpeechPcm,
} from "../core/utils/gemini_speech.js";
import type { SpawnCaptureResult } from "../core/utils/spawn_capture.js";

const SPEECH_PLAYBACK_START_BUFFER_MS = 500;
const SPEECH_PLAYBACK_START_BUFFER_BYTES = Math.ceil(
  GEMINI_SPEECH_SAMPLE_RATE_HZ *
    GEMINI_SPEECH_CHANNEL_COUNT *
    (GEMINI_SPEECH_BITS_PER_SAMPLE / 8) *
    (SPEECH_PLAYBACK_START_BUFFER_MS / 1000),
);

type PlaybackOutcome = { result: SpawnCaptureResult } | { error: unknown };

export async function runSpeechPlaybackTask(args: {
  deps: CoreDeps;
  apiKey: string;
  sourceText: string;
  signal: AbortSignal;
  onActivityLabel: (hint: string) => void;
}): Promise<void> {
  const abortController = createLinkedAbortController(args.signal);
  const bufferedAudio: Buffer[] = [];
  let bufferedAudioBytes = 0;
  let playback: Promise<PlaybackOutcome> | undefined;
  let playbackInput: Writable | null = null;

  const startPlayback = async (): Promise<Writable> => {
    if (!playback) {
      playback = args.deps
        .spawn(
          "ffplay",
          [
            "-nodisp",
            "-autoexit",
            "-loglevel",
            "error",
            "-f",
            "s16le",
            "-ar",
            String(GEMINI_SPEECH_SAMPLE_RATE_HZ),
            "-ch_layout",
            "mono",
            "-af",
            `atempo=${GEMINI_SPEECH_PLAYBACK_RATE}`,
            "pipe:0",
          ],
          {
            detached: true,
            killProcessGroup: true,
            signal: abortController.signal,
            stdio: ["pipe", "ignore", "pipe"],
            captureOutput: "stderr",
            maxCaptureBytes: 20_000,
            onSpawn: (child: ChildProcess) => {
              playbackInput = child.stdin;
              playbackInput?.on("error", () => {});
            },
          },
        )
        .then(
          (result) => ({ result }),
          (error: unknown) => ({ error }),
        );
    }

    if (!playbackInput) {
      const outcome = await playback;
      throw "error" in outcome ? outcome.error : playbackFailure(outcome.result);
    }

    args.onActivityLabel("playing speech");
    return playbackInput;
  };

  const flushBufferedAudio = async (): Promise<void> => {
    const input = await startPlayback();
    for (const audio of bufferedAudio) {
      await writePlaybackAudio(input, audio, abortController.signal);
    }
    bufferedAudio.length = 0;
    bufferedAudioBytes = 0;
  };

  try {
    for await (const chunk of streamGeminiSpeechPcm({
      apiKey: args.apiKey,
      sourceText: args.sourceText,
      signal: abortController.signal,
      onStageChange: (stage) => {
        args.onActivityLabel(stage === "rewriting" ? "rewriting for speech" : "preparing speech");
      },
    })) {
      if (!playback) {
        bufferedAudio.push(chunk.audio);
        bufferedAudioBytes += chunk.audio.length;
        if (bufferedAudioBytes < SPEECH_PLAYBACK_START_BUFFER_BYTES) {
          continue;
        }
        await flushBufferedAudio();
        continue;
      }

      await writePlaybackAudio(playbackInput!, chunk.audio, abortController.signal);
    }

    if (!playback) {
      await flushBufferedAudio();
    }
    await endPlayback(playbackInput!);
    const outcome = await playback!;
    if ("error" in outcome) {
      throw outcome.error;
    }
    if (args.signal.aborted || outcome.result.aborted) {
      return;
    }
    if (outcome.result.exitCode !== 0) {
      throw playbackFailure(outcome.result);
    }
  } catch (error) {
    abortController.abort();
    const outcome = playback ? await playback : undefined;
    if (args.signal.aborted || (error instanceof Error && error.name === "AbortError")) {
      return;
    }
    if (
      isMissingExecutableError(error) ||
      (outcome && "error" in outcome && isMissingExecutableError(outcome.error))
    ) {
      throw new Error("ffplay not found. Install ffmpeg to use /speak.");
    }
    if (outcome && "result" in outcome && !outcome.result.aborted) {
      throw playbackFailure(outcome.result);
    }
    throw error;
  } finally {
    abortController.abort();
    abortController.dispose();
  }
}

async function writePlaybackAudio(
  input: Writable,
  audio: Buffer,
  signal: AbortSignal,
): Promise<void> {
  if (signal.aborted) {
    throw abortError();
  }

  await new Promise<void>((resolve, reject) => {
    input.write(audio, (error) => {
      if (error) {
        reject(error);
      } else {
        resolve();
      }
    });
  });
}

async function endPlayback(input: Writable): Promise<void> {
  if (input.destroyed || input.writableEnded) {
    return;
  }
  await new Promise<void>((resolve) => input.end(resolve));
}

function playbackFailure(result: {
  stderr: string;
  exitCode: number | null;
  closeSignal: NodeJS.Signals | null;
}): Error {
  const detail = result.stderr.trim();
  if (detail) {
    return new Error(`ffplay failed: ${detail}`);
  }
  if (result.exitCode !== null) {
    return new Error(`ffplay exited with code ${result.exitCode}`);
  }
  if (result.closeSignal) {
    return new Error(`ffplay terminated by signal ${result.closeSignal}`);
  }
  return new Error("ffplay exited");
}

function isMissingExecutableError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

function createLinkedAbortController(parent: AbortSignal): {
  signal: AbortSignal;
  abort: () => void;
  dispose: () => void;
} {
  const controller = new AbortController();
  const onAbort = () => controller.abort(parent.reason);

  if (parent.aborted) {
    onAbort();
  } else {
    parent.addEventListener("abort", onAbort, { once: true });
  }

  return {
    signal: controller.signal,
    abort: () => controller.abort(),
    dispose: () => parent.removeEventListener("abort", onAbort),
  };
}

function abortError(): Error {
  const error = new Error("Speech playback was aborted");
  error.name = "AbortError";
  return error;
}
