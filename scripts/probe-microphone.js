#!/usr/bin/env node

import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import { spawnWithCapture } from "../dist/core/utils/spawn_capture.js";
import { startListenAudioCapture } from "../dist/tui/listen_capture.js";

const { values } = parseArgs({
  options: {
    seconds: { type: "string", default: "30" },
    compare: { type: "boolean", default: false },
    ffmpeg: { type: "string", default: "ffmpeg" },
    help: { type: "boolean", default: false },
  },
});

if (values.help) {
  console.log(`Usage: node scripts/probe-microphone.js [--seconds 30] [--compare] [--ffmpeg PATH]

Requires a built Tau checkout, macOS, ffmpeg, and ffplay.
Uses Tau's actual microphone capture path: AVFoundation :0, mono 16 kHz PCM.
Press Enter to stop recording and hear the saved WAV at its original level.
Ctrl+C cancels recording or playback. No normalization, API calls, or credentials.
The WAV is retained in the printed private temporary directory.
--ffmpeg selects a test binary for capture/conversion without changing your installation.
--compare records native-rate audio without conversion, then converts the same clip
  to Tau's 16 kHz mono format offline and plays both with ffplay.
  Also requires ffprobe; preserves packet timestamps and audio metadata for diagnosis.`);
} else {
  await main().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}

async function main() {
  if (process.platform !== "darwin") throw new Error("Tau microphone capture requires macOS");
  const seconds = Number(values.seconds);
  if (!Number.isFinite(seconds) || seconds < 1 || seconds > 480) {
    throw new Error("--seconds must be between 1 and 480");
  }
  const directory = await mkdtemp(join(tmpdir(), "tau-microphone-probe-"));
  if (values.compare) {
    await compareCapture(directory, seconds);
    return;
  }
  const audioPath = join(directory, "audio.wav");
  console.log(`Recording saved at: ${audioPath}`);
  console.log("Opening microphone...");

  const captureAbort = new AbortController();
  const playbackAbort = new AbortController();
  let cancelled = false;
  let stopRequested = false;
  let samples = 0;
  let sumSquares = 0;
  let peak = 0;
  let clipped = 0;
  let pending = Buffer.alloc(0);
  let input;
  let recordingTimer;
  let startupTimer;
  const stop = () => {
    stopRequested = true;
    captureAbort.abort();
  };
  const cancel = () => {
    cancelled = true;
    stop();
    playbackAbort.abort();
  };
  process.on("SIGINT", cancel);
  process.on("SIGTERM", cancel);
  const capture = startListenAudioCapture({
    deps: { spawn: (_command, args, options) => spawnWithCapture(values.ffmpeg, args, options) },
    audioPath,
    signal: captureAbort.signal,
    streamingSampleRate: 16_000,
    onAudioChunk: (chunk) => {
      const data = Buffer.concat([pending, chunk]);
      const length = data.length - (data.length % 2);
      for (let offset = 0; offset < length; offset += 2) {
        const value = Math.abs(data.readInt16LE(offset));
        peak = Math.max(peak, value);
        sumSquares += value * value;
        samples++;
        if (value >= 32767) clipped++;
      }
      pending = data.subarray(length);
    },
  });
  void capture.completion.catch(() => {});
  try {
    startupTimer = setTimeout(stop, 15_000);
    await capture.started;
    clearTimeout(startupTimer);
    if (cancelled) return;
    console.log("Recording. Speak normally; press Enter to stop and play it back.");
    input = createInterface({ input: process.stdin });
    input.on("line", stop);
    recordingTimer = setTimeout(stop, seconds * 1000);
    const result = await capture.completion;
    clearTimeout(recordingTimer);
    input.close();
    if (cancelled) return;
    if (!stopRequested || samples === 0) {
      throw new Error(result.stderr.trim() || "microphone capture ended unexpectedly");
    }
    const db = (value) =>
      value > 0 ? `${(20 * Math.log10(value / 32768)).toFixed(1)} dBFS` : "silence";
    console.log(`Captured ${(samples / 16000).toFixed(2)} seconds of audio.`);
    console.log(
      `Peak: ${db(peak)}; RMS including silence: ${db(Math.sqrt(sumSquares / samples))}; clipped samples: ${clipped}.`,
    );
    console.log("Playing the unmodified recording. Your system output volume still applies.");
    const playback = await spawnWithCapture(
      "ffplay",
      ["-hide_banner", "-loglevel", "error", "-nodisp", "-autoexit", audioPath],
      {
        signal: playbackAbort.signal,
        detached: true,
        killProcessGroup: true,
        captureOutput: "stderr",
        maxCaptureBytes: 20_000,
      },
    );
    if (!cancelled && playback.exitCode !== 0) {
      throw new Error(playback.stderr.trim() || "audio playback failed");
    }
  } finally {
    clearTimeout(startupTimer);
    clearTimeout(recordingTimer);
    input?.close();
    captureAbort.abort();
    await capture.completion.catch(() => {});
    process.off("SIGINT", cancel);
    process.off("SIGTERM", cancel);
    console.log(`WAV retained at: ${audioPath}`);
  }
}

async function compareCapture(directory, seconds) {
  const nativePath = join(directory, "native.wav");
  const convertedPath = join(directory, "converted-16k.wav");
  console.log(`Comparison directory: ${directory}`);
  console.log("Opening the MacBook microphone at its native format (no resampling)...");
  const captureAbort = new AbortController();
  const operationsAbort = new AbortController();
  const ready = Promise.withResolvers();
  let input;
  let cancelled = false;
  let stopRequested = false;
  let startupTimer;
  let recordingTimer;
  let firstAudioAt;
  let stopAt;
  const stop = () => {
    if (stopRequested) return;
    stopRequested = true;
    stopAt = performance.now();
    captureAbort.abort();
  };
  const cancel = () => {
    cancelled = true;
    stop();
    operationsAbort.abort();
  };
  process.on("SIGINT", cancel);
  process.on("SIGTERM", cancel);
  const args = [
    "-hide_banner",
    "-loglevel",
    "verbose",
    "-debug_ts",
    "-nostdin",
    "-f",
    "avfoundation",
    "-i",
    ":0",
    "-map",
    "0:a",
    "-c:a",
    "copy",
    "-f",
    "wav",
    nativePath,
    "-stats_period",
    "0.1",
    "-progress",
    "pipe:1",
  ];
  const capture = spawnWithCapture(values.ffmpeg, args, {
    signal: captureAbort.signal,
    detached: true,
    killProcessGroup: true,
    captureOutput: "stderr",
    maxCaptureBytes: 4 * 1024 * 1024,
    onSpawn: (child) => {
      let progress = "";
      child.stdout.on("data", (chunk) => {
        progress += chunk.toString("utf8");
        const lines = progress.split("\n");
        progress = lines.pop();
        if (
          lines.some((line) => /^out_time_us=\d+$/.test(line) && Number(line.split("=")[1]) > 0)
        ) {
          if (firstAudioAt === undefined) firstAudioAt = performance.now();
          ready.resolve();
        }
      });
    },
  });
  void capture.then(
    () => ready.reject(new Error("capture ended before audio arrived; see native-capture.log")),
    (error) => ready.reject(error),
  );
  const run = async (command, commandArgs, name) => {
    const result = await spawnWithCapture(
      command === "ffmpeg" ? values.ffmpeg : command,
      commandArgs,
      {
        signal: operationsAbort.signal,
        detached: true,
        killProcessGroup: true,
        maxCaptureBytes: 1024 * 1024,
        timeoutMs: Math.max(120_000, (seconds + 30) * 1000),
      },
    );
    await writeFile(join(directory, `${name}.log`), result.stderr, { mode: 0o600 });
    if (cancelled) throw new Error("comparison cancelled; files retained");
    if (result.exitCode !== 0) throw new Error(`${command} failed; see ${name}.log`);
    return result;
  };
  try {
    startupTimer = setTimeout(stop, 15_000);
    await ready.promise;
    clearTimeout(startupTimer);
    if (cancelled) return;
    console.log("Recording native audio. Speak normally, then press Enter to stop.");
    input = createInterface({ input: process.stdin });
    input.on("line", stop);
    recordingTimer = setTimeout(stop, seconds * 1000);
    const result = await capture;
    clearTimeout(recordingTimer);
    input.close();
    if (cancelled) return;
    if (!stopRequested || result.captureLimitExceeded) {
      throw new Error("native capture ended unexpectedly; see native-capture.log");
    }
    console.log("Converting this exact recording to 16 kHz mono, without gain or filtering...");
    await run(
      "ffmpeg",
      [
        "-hide_banner",
        "-loglevel",
        "info",
        "-nostdin",
        "-i",
        nativePath,
        "-map",
        "0:a",
        "-ac",
        "1",
        "-ar",
        "16000",
        "-c:a",
        "pcm_s16le",
        convertedPath,
      ],
      "conversion",
    );
    for (const [label, path] of [
      ["native", nativePath],
      ["converted-16k", convertedPath],
    ]) {
      const probe = await run(
        "ffprobe",
        ["-v", "error", "-show_streams", "-show_format", "-of", "json", path],
        `${label}-metadata`,
      );
      await writeFile(join(directory, `${label}.json`), probe.stdout, { mode: 0o600 });
      const metadata = JSON.parse(probe.stdout);
      const stream = metadata.streams[0];
      console.log(
        `${label}: ${stream.sample_rate} Hz, ${stream.channels} channel(s), ${metadata.format.duration}s`,
      );
      console.log(`Playing ${label} now...`);
      await run(
        "ffplay",
        ["-hide_banner", "-loglevel", "error", "-nodisp", "-autoexit", path],
        `${label}-playback`,
      );
    }
  } finally {
    clearTimeout(startupTimer);
    clearTimeout(recordingTimer);
    input?.close();
    captureAbort.abort();
    const result = await capture.catch(() => undefined);
    if (result)
      await writeFile(join(directory, "native-capture.log"), result.stderr, { mode: 0o600 });
    await writeFile(
      join(directory, "capture.json"),
      JSON.stringify(
        {
          ffmpeg: values.ffmpeg,
          args,
          wallSeconds:
            firstAudioAt !== undefined && stopAt !== undefined
              ? (stopAt - firstAudioAt) / 1000
              : null,
          stopRequested,
          cancelled,
        },
        null,
        2,
      ),
      { mode: 0o600 },
    );
    process.off("SIGINT", cancel);
    process.off("SIGTERM", cancel);
    console.log(`Audio and diagnostic logs retained at: ${directory}`);
  }
}
