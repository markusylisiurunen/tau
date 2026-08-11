import { readFile, writeFile } from "node:fs/promises";
import { describe, expect, it, vi } from "vitest";
import { generateTelegramVoice } from "../dist/core/telegram/tts.js";

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
  it("combines Gemini WAV chunks and encodes an Ogg Opus voice note", async () => {
    const streamSpeechAudio = vi.fn(async function* () {
      yield {
        index: 0,
        total: 2,
        audio: createWaveAudio(Buffer.from([1, 2, 3, 4])),
        mimeType: "audio/wav",
      };
      yield {
        index: 1,
        total: 2,
        audio: createWaveAudio(Buffer.from([5, 6, 7, 8])),
        mimeType: "audio/wav",
      };
    });
    let combinedWave;
    const spawn = vi.fn(async (_command, args) => {
      const inputPath = args[args.indexOf("-i") + 1];
      const outputPath = args.at(-1);
      combinedWave = await readFile(inputPath);
      await writeFile(outputPath, Buffer.from("OggS voice"));
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
      deps: { streamSpeechAudio, spawn },
    });

    expect(voice).toEqual(Buffer.from("OggS voice"));
    expect(streamSpeechAudio).toHaveBeenCalledWith(
      expect.objectContaining({ deliveryMode: "complete" }),
    );
    expect(combinedWave.subarray(44)).toEqual(Buffer.from([1, 2, 3, 4, 5, 6, 7, 8]));
    expect(combinedWave.readUInt32LE(40)).toBe(8);
    expect(spawn).toHaveBeenCalledWith(
      "ffmpeg",
      expect.arrayContaining([
        "-filter:a",
        "atempo=1.1",
        "-c:a",
        "libopus",
        "-application",
        "voip",
      ]),
      expect.objectContaining({ detached: true, killProcessGroup: true }),
    );
  });
});
