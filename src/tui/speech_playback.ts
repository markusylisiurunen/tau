import { unlink, writeFile } from "node:fs/promises";
import type { CoreDeps } from "../core/runtime/deps.js";
import { streamGeminiSpeechAudio } from "../core/utils/gemini_speech.js";

export const SPEAK_TEMP_FILE_TEMPLATE = "/tmp/tau-speak.XXXXXX";
const SPEAK_PLAYBACK_RATE = 1.4;

export async function runSpeechPlaybackTask(args: {
  deps: CoreDeps;
  apiKey: string;
  sourceText: string;
  signal: AbortSignal;
  onActivityLabel: (hint: string) => void;
}): Promise<void> {
  let audioPath: string | undefined;
  let readyChunks = 0;
  let totalChunks = 0;
  let playedChunks = 0;
  let playbackStarted = false;

  const refreshSpeechProgress = (): void => {
    if (totalChunks <= 0) return;
    args.onActivityLabel(
      playbackStarted
        ? formatSpeechPlaybackProgressMessage(playedChunks, readyChunks, totalChunks)
        : formatSpeechChunkProgressMessage(readyChunks, totalChunks),
    );
  };

  try {
    for await (const chunk of streamGeminiSpeechAudio({
      apiKey: args.apiKey,
      sourceText: args.sourceText,
      deliveryMode: "progressive",
      signal: args.signal,
      onStageChange: (stage) => {
        args.onActivityLabel(stage === "rewriting" ? "rewriting for speech" : "generating speech");
      },
      onChunkProgress: ({ ready, total }) => {
        readyChunks = ready;
        totalChunks = total;
        refreshSpeechProgress();
      },
    })) {
      if (args.signal.aborted) {
        return;
      }

      playbackStarted = true;
      totalChunks = chunk.total;
      refreshSpeechProgress();

      audioPath = await createTempFilePath(args.deps, SPEAK_TEMP_FILE_TEMPLATE);
      await writeFile(audioPath, chunk.audio);

      const playback = await args.deps.spawn(
        "afplay",
        ["-r", String(SPEAK_PLAYBACK_RATE), audioPath],
        {
          detached: true,
          killProcessGroup: true,
          signal: args.signal,
          stdio: ["ignore", "ignore", "ignore"],
        },
      );
      await cleanupTempFile(audioPath);
      audioPath = undefined;

      if (args.signal.aborted || playback.aborted) {
        return;
      }
      if (playback.exitCode !== 0) {
        const detail =
          playback.exitCode !== null
            ? `afplay exited with code ${playback.exitCode}`
            : playback.closeSignal
              ? `afplay terminated by signal ${playback.closeSignal}`
              : "afplay exited";
        throw new Error(detail);
      }

      playedChunks = chunk.index + 1;
      refreshSpeechProgress();
    }
  } catch (err) {
    if (args.signal.aborted) {
      return;
    }
    const error = err as NodeJS.ErrnoException;
    if (error.name === "AbortError") {
      return;
    }
    if (error.code === "ENOENT") {
      throw new Error("afplay not found.");
    }
    throw err;
  } finally {
    if (audioPath) {
      await cleanupTempFile(audioPath);
    }
  }
}

async function createTempFilePath(deps: CoreDeps, template: string): Promise<string> {
  const result = await deps.spawn("mktemp", [template]);
  if (result.exitCode !== 0) {
    throw new Error(result.stderr || result.stdout || "mktemp failed");
  }
  const path = result.stdout.trim();
  if (!path) {
    throw new Error("mktemp returned an empty path");
  }
  return path;
}

async function cleanupTempFile(path: string): Promise<void> {
  try {
    await unlink(path);
  } catch {
    // best-effort cleanup
  }
}

function formatSpeechChunkProgressMessage(ready: number, total: number): string {
  return `generating speech chunks (${ready} out of ${total} ready)`;
}

function formatSpeechPlaybackProgressMessage(played: number, ready: number, total: number): string {
  return `playing speech (${played}/${total} played, ${ready}/${total} ready)`;
}
