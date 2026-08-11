import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { streamGeminiSpeechAudio } from "../utils/gemini_speech.js";
import { spawnWithCapture } from "../utils/spawn_capture.js";

const TELEGRAM_TTS_TEMP_DIR_PREFIX = "tau-telegram-tts-";
const TELEGRAM_TTS_CONVERSION_TIMEOUT_MS = 120_000;
const WAVE_HEADER_BYTES = 44;

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
  const chunks: Buffer[] = [];

  for await (const chunk of streamSpeechAudio({
    apiKey: options.apiKey,
    sourceText: options.sourceText,
    fetchImpl: options.fetchImpl,
    signal: options.signal,
  })) {
    chunks.push(chunk.audio);
  }

  const waveAudio = concatenateWaveAudio(chunks);
  const temporaryDirectory = await mkdtemp(join(tmpdir(), TELEGRAM_TTS_TEMP_DIR_PREFIX));
  const inputPath = join(temporaryDirectory, "speech.wav");
  const outputPath = join(temporaryDirectory, "speech.ogg");

  try {
    await writeFile(inputPath, waveAudio);
    const result = await spawn(
      "ffmpeg",
      [
        "-nostdin",
        "-hide_banner",
        "-loglevel",
        "error",
        "-y",
        "-i",
        inputPath,
        "-c:a",
        "libopus",
        "-b:a",
        "48k",
        "-vbr",
        "on",
        "-application",
        "voip",
        outputPath,
      ],
      {
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

function concatenateWaveAudio(chunks: Buffer[]): Buffer {
  if (chunks.length === 0) {
    throw new Error("Gemini TTS returned no audio");
  }

  const firstHeader = parseWaveHeader(chunks[0]!);
  const pcmChunks: Buffer[] = [];
  let totalPcmBytes = 0;

  for (const chunk of chunks) {
    const header = parseWaveHeader(chunk);
    if (!header.format.equals(firstHeader.format)) {
      throw new Error("Gemini TTS returned incompatible audio chunks");
    }
    const pcm = chunk.subarray(WAVE_HEADER_BYTES, WAVE_HEADER_BYTES + header.dataBytes);
    pcmChunks.push(pcm);
    totalPcmBytes += pcm.length;
  }

  const header = Buffer.from(chunks[0]!.subarray(0, WAVE_HEADER_BYTES));
  header.writeUInt32LE(WAVE_HEADER_BYTES - 8 + totalPcmBytes, 4);
  header.writeUInt32LE(totalPcmBytes, 40);
  return Buffer.concat([header, ...pcmChunks], WAVE_HEADER_BYTES + totalPcmBytes);
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
