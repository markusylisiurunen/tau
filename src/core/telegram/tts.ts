import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { GEMINI_SPEECH_PLAYBACK_RATE, streamGeminiSpeechAudio } from "../utils/gemini_speech.js";
import { spawnWithCapture } from "../utils/spawn_capture.js";

const TELEGRAM_TTS_TEMP_DIR_PREFIX = "tau-telegram-tts-";
const TELEGRAM_TTS_CONVERSION_TIMEOUT_MS = 120_000;
const WAVE_HEADER_BYTES = 44;

export async function sweepStaleTelegramTtsTempDirs(): Promise<void> {
  const systemTmpDir = tmpdir();
  try {
    const entries = await readdir(systemTmpDir, { withFileTypes: true, encoding: "utf8" });
    await Promise.allSettled(
      entries
        .filter(
          (entry) => entry.isDirectory() && entry.name.startsWith(TELEGRAM_TTS_TEMP_DIR_PREFIX),
        )
        .map(
          async (entry) =>
            await rm(join(systemTmpDir, entry.name), { recursive: true, force: true }),
        ),
    );
  } catch {
    return;
  }
}

export type GenerateTelegramVoiceOptions = {
  apiKey: string;
  sourceText: string;
  fetchImpl?: typeof fetch;
  signal?: AbortSignal;
  deps?: {
    streamSpeechAudio?: typeof streamGeminiSpeechAudio;
    spawn?: typeof spawnWithCapture;
  };
};

export async function generateTelegramVoice(
  options: GenerateTelegramVoiceOptions,
): Promise<Buffer> {
  const streamSpeechAudio = options.deps?.streamSpeechAudio ?? streamGeminiSpeechAudio;
  const spawn = options.deps?.spawn ?? spawnWithCapture;
  const temporaryDirectory = await mkdtemp(join(tmpdir(), TELEGRAM_TTS_TEMP_DIR_PREFIX));
  const manifestPath = join(temporaryDirectory, "speech.ffconcat");
  const outputPath = join(temporaryDirectory, "speech.ogg");

  try {
    const chunkNames: string[] = [];
    let waveFormat: Buffer | undefined;

    for await (const chunk of streamSpeechAudio({
      apiKey: options.apiKey,
      sourceText: options.sourceText,
      deliveryMode: "complete",
      fetchImpl: options.fetchImpl,
      signal: options.signal,
    })) {
      const header = parseWaveHeader(chunk.audio);
      if (waveFormat && !header.format.equals(waveFormat)) {
        throw new Error("Gemini TTS returned incompatible audio chunks");
      }
      waveFormat ??= Buffer.from(header.format);

      const chunkName = `chunk-${String(chunkNames.length).padStart(3, "0")}.wav`;
      await writeFile(
        join(temporaryDirectory, chunkName),
        chunk.audio.subarray(0, WAVE_HEADER_BYTES + header.dataBytes),
      );
      chunkNames.push(chunkName);
    }

    if (chunkNames.length === 0) {
      throw new Error("Gemini TTS returned no audio");
    }

    await writeFile(
      manifestPath,
      `ffconcat version 1.0\n${chunkNames.map((name) => `file '${name}'`).join("\n")}\n`,
      "utf8",
    );
    const result = await spawn(
      "ffmpeg",
      [
        "-nostdin",
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-f",
        "concat",
        "-safe",
        "1",
        "-i",
        "speech.ffconcat",
        "-filter:a",
        `atempo=${GEMINI_SPEECH_PLAYBACK_RATE}`,
        "-c:a",
        "libopus",
        "-b:a",
        "48k",
        "-vbr",
        "on",
        "-application",
        "voip",
        "speech.ogg",
      ],
      {
        cwd: temporaryDirectory,
        detached: true,
        killProcessGroup: true,
        signal: options.signal,
        timeoutMs: TELEGRAM_TTS_CONVERSION_TIMEOUT_MS,
        maxCaptureBytes: 20_000,
      },
    );

    if (result.aborted || options.signal?.aborted) {
      throw abortError();
    }
    if (result.timedOut) {
      throw new Error("ffmpeg timed out while encoding Telegram voice audio");
    }
    if (result.exitCode !== 0) {
      const detail = result.stderr.trim();
      throw new Error(
        detail
          ? `ffmpeg failed to encode Telegram voice audio: ${detail}`
          : `ffmpeg exited with code ${result.exitCode ?? "unknown"}`,
      );
    }

    const voice = await readFile(outputPath);
    if (voice.length === 0) {
      throw new Error("ffmpeg produced empty Telegram voice audio");
    }
    return voice;
  } catch (error) {
    if (isMissingExecutableError(error)) {
      throw new Error("ffmpeg is required to encode Telegram voice notes");
    }
    throw error;
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

function parseWaveHeader(audio: Buffer): { format: Buffer; dataBytes: number } {
  if (
    audio.length < WAVE_HEADER_BYTES ||
    audio.toString("ascii", 0, 4) !== "RIFF" ||
    audio.toString("ascii", 8, 12) !== "WAVE" ||
    audio.toString("ascii", 12, 16) !== "fmt " ||
    audio.toString("ascii", 36, 40) !== "data"
  ) {
    throw new Error("Gemini TTS returned invalid WAV audio");
  }

  const dataBytes = audio.readUInt32LE(40);
  if (dataBytes > audio.length - WAVE_HEADER_BYTES) {
    throw new Error("Gemini TTS returned truncated WAV audio");
  }

  return {
    format: audio.subarray(20, 36),
    dataBytes,
  };
}

function isMissingExecutableError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

function abortError(): Error {
  const error = new Error("Telegram TTS was aborted");
  error.name = "AbortError";
  return error;
}
