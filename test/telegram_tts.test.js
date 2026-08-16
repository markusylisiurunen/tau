import { mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { generateTelegramVoice, sweepStaleTelegramTtsTempDirs } from "../dist/core/telegram/tts.js";

function createWaveAudio(pcm) {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVE", 8);
  header.write("fmt ", 12);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(24_000, 24);
  header.writeUInt32LE(48_000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

describe("telegram TTS", () => {
  it("removes stale Telegram TTS directories", async () => {
    const staleDirectory = await mkdtemp(join(tmpdir(), "tau-telegram-tts-"));
    await writeFile(join(staleDirectory, "speech.wav"), Buffer.from("assistant audio"));

    await sweepStaleTelegramTtsTempDirs();

    await expect(stat(staleDirectory)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("writes ordered Gemini WAV chunks and encodes one Ogg Opus voice note", async () => {
    const waves = [
      createWaveAudio(Buffer.from([1, 2, 3, 4])),
      createWaveAudio(Buffer.from([5, 6, 7, 8])),
    ];
    const generateSpeechAudio = vi.fn(async function* () {
      for (const [index, audio] of waves.entries()) {
        yield { index, total: waves.length, audio, mimeType: "audio/wav" };
      }
    });
    let manifest;
    let writtenWaves;
    const spawn = vi.fn(async (_command, args, options) => {
      manifest = await readFile(join(options.cwd, args[args.indexOf("-i") + 1]), "utf8");
      writtenWaves = await Promise.all(
        ["chunk-000.wav", "chunk-001.wav"].map(
          async (name) => await readFile(join(options.cwd, name)),
        ),
      );
      await writeFile(join(options.cwd, args.at(-1)), Buffer.from("OggS voice"));
      return {
        stdout: "",
        stderr: "",
        exitCode: 0,
        captureLimitExceeded: false,
        timedOut: false,
        aborted: false,
        closeSignal: null,
      };
    });

    const voice = await generateTelegramVoice({
      apiKey: "gemini-key",
      sourceText: "final answer",
      deps: { generateSpeechAudio, spawn },
    });

    expect(voice).toEqual(Buffer.from("OggS voice"));
    expect(generateSpeechAudio).toHaveBeenCalledWith(
      expect.objectContaining({ apiKey: "gemini-key", sourceText: "final answer" }),
    );
    expect(manifest).toBe("ffconcat version 1.0\nfile 'chunk-000.wav'\nfile 'chunk-001.wav'\n");
    expect(writtenWaves).toEqual(waves);
    expect(spawn).toHaveBeenCalledWith(
      "ffmpeg",
      expect.arrayContaining([
        "-f",
        "concat",
        "-safe",
        "1",
        "-filter:a",
        "atempo=1.15",
        "-c:a",
        "libopus",
        "-application",
        "voip",
      ]),
      expect.objectContaining({
        cwd: expect.stringContaining("tau-telegram-tts-"),
        detached: true,
        killProcessGroup: true,
      }),
    );
  });
});
