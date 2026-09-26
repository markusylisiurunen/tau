#!/usr/bin/env node

import { spawn } from "node:child_process";
import { appendFileSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { parseArgs } from "node:util";
import WebSocket from "ws";

const { values } = parseArgs({
  options: {
    interactions: { type: "boolean", default: false },
    seconds: { type: "string", default: "60" },
    device: { type: "string" },
    help: { type: "boolean", default: false },
  },
});

if (values.help) {
  console.log(`Usage: node scripts/probe-gemini-transcription.js [--interactions] [--seconds 60] [--device DEVICE]

Reads apiKeys.google from ~/.config/tau/config.json. Requires ffmpeg.
Records live VERBATIM transcription with manual voice activity detection and English/Finnish hints; press Enter to stop recording early.
Observes all server events for 30 seconds after activityEnd, even after final text.
Prints and saves the interim-at-stop, last interim, and final transcripts for comparison.
--interactions also uploads the same recording for a non-streaming verbatim comparison.
--seconds sets the recording limit (1–480 seconds).
--device defaults to :0 (macOS avfoundation) or default (Linux PulseAudio).
Raw server messages, request metadata, and audio are saved in a private temporary directory.
Audio is sent to Google; captures contain your speech. No API key is logged.`);
} else {
  await main();
}

async function main() {
  let apiKey;
  let log;
  let output;
  let comparison;
  let redact = (text) => text;
  try {
    const seconds = Number(values.seconds);
    if (!Number.isFinite(seconds) || seconds < 1 || seconds > 480) {
      throw new Error("--seconds must be between 1 and 480");
    }
    if (process.platform !== "darwin" && process.platform !== "linux") {
      throw new Error("only macOS and Linux are supported");
    }
    const config = JSON.parse(readFileSync(join(homedir(), ".config/tau/config.json"), "utf8"));
    apiKey = config.apiKeys?.google?.trim();
    if (!apiKey) throw new Error("missing apiKeys.google in ~/.config/tau/config.json");

    output = mkdtempSync(join(tmpdir(), "tau-gemini-probe-"));
    const started = performance.now();
    redact = (text) => text.replaceAll(apiKey, "[REDACTED]");
    comparison = {
      interimAtStop: null,
      lastInterim: null,
      finalSegments: [],
      generationCompleteCount: 0,
    };
    log = (kind, data) => {
      appendFileSync(
        join(output, "events.jsonl"),
        `${redact(JSON.stringify({ at: new Date().toISOString(), ms: performance.now() - started, kind, ...data }))}\n`,
        { mode: 0o600 },
      );
    };
    console.log(`Capture directory: ${output}`);
    log("probe.start", { platform: process.platform, seconds, interactions: values.interactions });
    const audio = await captureLive({ apiKey, seconds, output, log, comparison });
    if (values.interactions) await captureInteraction({ apiKey, audio, output, log, redact });
    log("probe.complete", {});
    console.log(`Done. Share the capture directory path for inspection: ${output}`);
  } catch (error) {
    const message = apiKey ? String(error.message).replaceAll(apiKey, "[REDACTED]") : error.message;
    log?.("probe.error", { message });
    console.error(message);
    process.exitCode = 1;
  } finally {
    if (comparison && output) {
      const finalTranscript = comparison.finalSegments.join("");
      writeFileSync(
        join(output, "comparison.json"),
        redact(JSON.stringify({ ...comparison, finalTranscript }, null, 2)),
        { mode: 0o600 },
      );
      for (const [label, text] of [
        ["interim at stop", comparison.interimAtStop],
        ["last interim received", comparison.lastInterim],
        ["final transcript", comparison.finalSegments.length > 0 ? finalTranscript : null],
      ]) {
        console.log(
          `\n=== ${label} (${text === null ? "not received" : `${text.length} characters`}) ===`,
        );
        console.log(text === null ? "[no transcript received]" : redact(text));
      }
      console.log(
        `\nFinal segments: ${comparison.finalSegments.length}; generationComplete events: ${comparison.generationCompleteCount}`,
      );
      console.log(`Comparison and raw events saved in: ${output}`);
    }
  }
}

async function captureLive({ apiKey, seconds, output, log, comparison }) {
  const socket = new WebSocket(
    `wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=${encodeURIComponent(apiKey)}`,
  );
  const completion = Promise.withResolvers();
  const chunks = [];
  let recorder;
  let recorderClosed;
  let input;
  let stopping = false;
  let observing = false;
  let cleaningUp = false;
  let ready = false;
  let recordingTimer;
  let observationTimer;
  let killTimer;
  let pending = Buffer.alloc(0);
  let audioOffset = 0;
  const setupTimer = setTimeout(() => completion.reject(new Error("live setup timed out")), 20_000);
  const send = (payload, metadata) => {
    log("live.send", metadata ?? { raw: JSON.stringify(payload) });
    socket.send(JSON.stringify(payload), (error) => {
      if (error) completion.reject(error);
    });
  };
  const sendAudio = (audio) => {
    send(
      {
        realtimeInput: {
          audio: { data: audio.toString("base64"), mimeType: "audio/pcm;rate=16000" },
        },
      },
      { audioOffset, audioBytes: audio.length },
    );
    audioOffset += audio.length;
  };
  const stop = () => {
    if (stopping || !recorder) return;
    stopping = true;
    comparison.interimAtStop = comparison.lastInterim;
    log("recording.stopRequested", {});
    recorder.kill("SIGINT");
    killTimer = setTimeout(() => recorder.kill("SIGKILL"), 3_000);
  };
  const interrupt = () => completion.reject(new Error("probe interrupted; captured data retained"));
  process.on("SIGINT", interrupt);
  process.on("SIGTERM", interrupt);

  socket.on("open", () => {
    send({
      setup: {
        model: "models/gemini-3.5-transcribe-live",
        generationConfig: { responseModalities: ["TEXT"] },
        inputAudioTranscription: { languageCodes: ["en-US", "fi-FI"], mode: "VERBATIM" },
        realtimeInputConfig: { automaticActivityDetection: { disabled: true } },
      },
    });
  });
  socket.on("message", (data, isBinary) => {
    const raw = data.toString("utf8");
    log("live.receive", { isBinary, raw });
    let event;
    try {
      event = JSON.parse(raw);
    } catch {
      console.log("[non-JSON response saved]");
      return;
    }
    const content = event.serverContent;
    if (typeof content?.interimInputTranscription?.text === "string") {
      comparison.lastInterim = content.interimInputTranscription.text;
    }
    if (typeof content?.inputTranscription?.text === "string") {
      comparison.finalSegments.push(content.inputTranscription.text);
    }
    if (content?.generationComplete) comparison.generationCompleteCount++;
    console.log(`[live] ${raw}`);
    if (event.error) {
      completion.reject(new Error("Gemini returned an error; see events.jsonl"));
      return;
    }
    if (!event.setupComplete || ready) return;
    ready = true;
    clearTimeout(setupTimer);
    send({ realtimeInput: { activityStart: {} } });
    const format = process.platform === "darwin" ? "avfoundation" : "pulse";
    const device = values.device ?? (process.platform === "darwin" ? ":0" : "default");
    const args = [
      "-hide_banner",
      "-loglevel",
      "error",
      "-nostdin",
      "-f",
      format,
      "-i",
      device,
      "-ac",
      "1",
      "-ar",
      "16000",
      "-c:a",
      "pcm_s16le",
      "-f",
      "s16le",
      "pipe:1",
    ];
    log("recording.start", { command: "ffmpeg", args });
    recorder = spawn("ffmpeg", args, { stdio: ["ignore", "pipe", "pipe"] });
    recorderClosed = new Promise((resolve) => recorder.once("close", resolve));
    recorder.on("error", (error) => completion.reject(error));
    recorder.stderr.on("data", (data) => {
      log("recording.stderr", { text: data.toString("utf8") });
      process.stderr.write(data);
    });
    recorder.stdout.on("data", (chunk) => {
      if (chunks.length === 0) console.log("Recording. Speak now; press Enter to stop.");
      chunks.push(chunk);
      appendFileSync(join(output, "audio.pcm"), chunk, { mode: 0o600 });
      pending = Buffer.concat([pending, chunk]);
      while (pending.length >= 3200) {
        sendAudio(pending.subarray(0, 3200));
        pending = pending.subarray(3200);
      }
    });
    recorder.on("close", (code, signal) => {
      clearTimeout(killTimer);
      clearTimeout(recordingTimer);
      input?.close();
      log("recording.close", { code, signal });
      if (!stopping || chunks.length === 0) {
        completion.reject(new Error("recorder stopped unexpectedly or captured no audio"));
        return;
      }
      if (cleaningUp || socket.readyState !== WebSocket.OPEN) return;
      if (pending.length > 0) sendAudio(pending);
      send({ realtimeInput: { activityEnd: {} } });
      observing = true;
      console.log("Recording stopped. Observing all live events for 30 seconds...");
      observationTimer = setTimeout(() => {
        log("live.observationComplete", { reason: "30-second observation window elapsed" });
        completion.resolve();
      }, 30_000);
    });
    input = createInterface({ input: process.stdin });
    input.on("line", stop);
    recordingTimer = setTimeout(stop, seconds * 1000);
  });
  socket.on("error", (error) => completion.reject(error));
  socket.on("close", (code, reason) => {
    log("live.close", { code, reason: reason.toString("utf8") });
    if (observing && code === 1000) completion.resolve();
    else completion.reject(new Error(`live connection closed (${code}); see events.jsonl`));
  });

  try {
    await completion.promise;
  } finally {
    cleaningUp = true;
    clearTimeout(setupTimer);
    clearTimeout(recordingTimer);
    clearTimeout(observationTimer);
    input?.close();
    if (recorder && recorder.exitCode === null && recorder.signalCode === null) {
      stop();
      await recorderClosed;
    }
    clearTimeout(killTimer);
    socket.terminate();
    process.off("SIGINT", interrupt);
    process.off("SIGTERM", interrupt);
    if (chunks.length > 0) {
      writeFileSync(join(output, "audio.wav"), makeWav(Buffer.concat(chunks)), { mode: 0o600 });
    }
  }
  return readFileSync(join(output, "audio.wav"));
}

function makeWav(pcm) {
  const header = Buffer.alloc(44);
  header.write("RIFF", 0);
  header.writeUInt32LE(36 + pcm.length, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(16000, 24);
  header.writeUInt32LE(32000, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([header, pcm]);
}

async function captureInteraction({ apiKey, audio, output, log, redact }) {
  const base = "https://generativelanguage.googleapis.com";
  const headers = { "x-goog-api-key": apiKey, "Content-Type": "application/json" };
  const request = async (name, url, options) => {
    log("http.start", { name });
    const response = await fetch(url, { ...options, signal: AbortSignal.timeout(120_000) });
    const text = await response.text();
    writeFileSync(join(output, `${name}.response.txt`), redact(text), { mode: 0o600 });
    log("http.response", {
      name,
      status: response.status,
      contentType: response.headers.get("content-type"),
    });
    if (!response.ok)
      throw new Error(`${name} returned HTTP ${response.status}; raw response saved`);
    return { response, text };
  };
  console.log("Uploading the same audio for Interactions verbatim transcription...");
  const { response } = await request("upload-start", `${base}/upload/v1beta/files`, {
    method: "POST",
    headers: {
      ...headers,
      "X-Goog-Upload-Protocol": "resumable",
      "X-Goog-Upload-Command": "start",
      "X-Goog-Upload-Header-Content-Length": String(audio.length),
      "X-Goog-Upload-Header-Content-Type": "audio/wav",
    },
    body: JSON.stringify({ file: { display_name: "tau-gemini-probe" } }),
  });
  const uploadUrl = response.headers.get("x-goog-upload-url");
  if (!uploadUrl) throw new Error("upload URL missing");
  const { text } = await request("upload-finalize", uploadUrl, {
    method: "POST",
    headers: {
      "Content-Type": "audio/wav",
      "X-Goog-Upload-Offset": "0",
      "X-Goog-Upload-Command": "upload, finalize",
    },
    body: audio,
  });
  const { file } = JSON.parse(text);
  if (!file?.name || !file?.uri) throw new Error("upload response missing file name or URI");
  try {
    const body = JSON.stringify({
      model: "gemini-3.5-transcribe",
      input: [{ type: "audio", uri: file.uri, mime_type: "audio/wav" }],
      generation_config: {
        transcription_config: { language_codes: ["en-US", "fi-FI"], mode: { type: "verbatim" } },
      },
      store: false,
    });
    writeFileSync(join(output, "interaction.request.json"), body, { mode: 0o600 });
    const result = await request("interaction", `${base}/v1beta/interactions`, {
      method: "POST",
      headers,
      body,
    });
    console.log(`[interaction] ${redact(result.text)}`);
  } finally {
    await request("file-delete", `${base}/v1beta/${file.name}`, { method: "DELETE", headers });
  }
}
