import WebSocket from "ws";
import { z } from "zod";
import type { SpeechToTextWebSocket, SpeechToTextWebSocketFactory } from "./speech_to_text.js";
import type { SpeechToTextContext } from "./speech_to_text_context.js";
import { prepareSpeechToTextKeywords } from "./speech_to_text_keywords.js";

type ScribeOptions = {
  apiKey: string;
  openAIApiKey?: string;
  context?: SpeechToTextContext;
  vocabulary?: string[];
  fetchImpl?: typeof fetch;
};

type StreamingOptions = ScribeOptions & {
  webSocketFactory?: SpeechToTextWebSocketFactory;
  onProgress?: (text: string) => void;
};

const eventSchema = z.object({
  message_type: z.string(),
  text: z.string().optional(),
  error: z.string().optional(),
});

export async function transcribeScribeAudio(
  options: ScribeOptions & {
    audio: Buffer;
    mimeType?: string;
    signal?: AbortSignal;
  },
): Promise<string> {
  if (!options.apiKey.trim()) throw new Error("missing ElevenLabs API key");
  const keywords = await prepareSpeechToTextKeywords({
    apiKey: options.openAIApiKey,
    context: options.context,
    vocabulary: options.vocabulary,
    signal: options.signal,
    fetchImpl: options.fetchImpl,
  });
  options.signal?.throwIfAborted();
  const body = new FormData();
  body.set("model_id", "scribe_v2");
  body.set("no_verbatim", "true");
  body.set("tag_audio_events", "false");
  body.set("diarize", "false");
  body.set(
    "file",
    new Blob([Uint8Array.from(options.audio)], {
      type: options.mimeType ?? "audio/wav",
    }),
    "recording",
  );
  for (const keyword of keywords) body.append("keyterms", keyword);
  const response = await (options.fetchImpl ?? fetch)(
    "https://api.elevenlabs.io/v1/speech-to-text",
    {
      method: "POST",
      headers: { "xi-api-key": options.apiKey.trim() },
      body,
      signal: options.signal,
    },
  );
  if (!response.ok) {
    const payload = await response.json().catch(() => undefined);
    const parsed = z
      .object({
        detail: z.union([z.string(), z.object({ message: z.string() })]),
      })
      .safeParse(payload);
    const detail = parsed.success
      ? typeof parsed.data.detail === "string"
        ? parsed.data.detail
        : parsed.data.detail.message
      : "";
    throw new Error(
      `ElevenLabs transcription failed (HTTP ${response.status})${detail ? `: ${redactApiKey(detail, options.apiKey)}` : ""}`,
    );
  }
  return z
    .object({ text: z.string() })
    .parse(await response.json())
    .text.trim();
}

export function startScribeTranscription(options: StreamingOptions) {
  return new ScribeStreamingTranscription(options);
}

const AUDIO_CHUNK_BYTES = 6_400; // 200 ms of mono PCM16 at 16 kHz.
const AUDIO_SEND_INTERVAL_MS = 100; // At most 2x real time, ten messages per second.

class ScribeStreamingTranscription {
  private socket?: SpeechToTextWebSocket;
  private readonly controller = new AbortController();
  private readonly ready = Promise.withResolvers<void>();
  private readonly result = Promise.withResolvers<string>();
  private pendingAudio: Buffer[] = [];
  private pendingAudioBytes = 0;
  private finalAudioQueued = false;
  private sendTimer?: ReturnType<typeof setTimeout>;
  private connected = false;
  private stopped = false;
  private finishing = false;
  private finalCommitSent = false;
  private hasAudio = false;
  private committed = "";
  private partial = "";
  private failure?: Error;
  private finishPromise?: Promise<string>;
  private readyTimer?: ReturnType<typeof setTimeout>;
  private finishTimer?: ReturnType<typeof setTimeout>;
  private drainTimer?: ReturnType<typeof setTimeout>;

  constructor(private readonly options: StreamingOptions) {
    if (!options.apiKey.trim()) throw new Error("missing ElevenLabs API key");
    void this.ready.promise.catch(() => {});
    void this.result.promise.catch(() => {});
    this.readyTimer = setTimeout(
      () => this.fail(new Error("timed out opening ElevenLabs transcription session")),
      30_000,
    );
    this.readyTimer.unref?.();
    void this.connect().catch((error: Error) => this.fail(error));
  }

  private async connect(): Promise<void> {
    const keywords = await prepareSpeechToTextKeywords({
      apiKey: this.options.openAIApiKey,
      context: this.options.context,
      vocabulary: this.options.vocabulary,
      signal: this.controller.signal,
      fetchImpl: this.options.fetchImpl,
    });
    if (this.stopped) return;
    const url = new URL("wss://api.elevenlabs.io/v1/speech-to-text/realtime");
    url.searchParams.set("model_id", "scribe_v2_realtime");
    url.searchParams.set("audio_format", "pcm_16000");
    url.searchParams.set("commit_strategy", "vad");
    url.searchParams.set("no_verbatim", "true");
    const realtimeKeywords = keywords.filter((keyword) => [...keyword].length <= 20).slice(0, 50);
    for (const keyword of realtimeKeywords) url.searchParams.append("keyterms", keyword);
    const factory =
      this.options.webSocketFactory ?? ((address, init) => new WebSocket(address, init));
    this.socket = factory(url.toString(), {
      headers: { "xi-api-key": this.options.apiKey.trim() },
    });
    this.socket.on("message", (data) => this.handleMessage(data));
    this.socket.on("error", (error) =>
      this.fail(
        new Error(
          `ElevenLabs transcription connection failed: ${redactApiKey(error.message, this.options.apiKey)}`,
        ),
      ),
    );
    this.socket.on("close", (code, reason) =>
      this.fail(
        new Error(
          `ElevenLabs transcription connection closed (${code}): ${redactApiKey(reason.toString("utf8"), this.options.apiKey)}`,
        ),
      ),
    );
  }

  appendAudio(audio: Buffer): void {
    if (!audio.length || this.stopped || this.finishing) return;
    this.hasAudio = true;
    this.pendingAudio.push(audio);
    this.pendingAudioBytes += audio.length;
    this.pumpAudio();
  }

  finish(options: { signal?: AbortSignal } = {}): Promise<string> {
    this.finishPromise ??= this.finishStream(options.signal);
    return this.finishPromise;
  }

  private async finishStream(signal?: AbortSignal): Promise<string> {
    this.finishing = true;
    const onAbort = () => this.abort();
    if (signal?.aborted) onAbort();
    else signal?.addEventListener("abort", onAbort, { once: true });
    try {
      await this.ready.promise;
      if (this.failure) throw this.failure;
      if (!this.hasAudio) throw new Error("ElevenLabs transcription received no audio");
      // Scribe buffers roughly two seconds before processing, including short recordings.
      this.pendingAudio.push(Buffer.alloc(64_000));
      this.pendingAudioBytes += 64_000;
      this.finalAudioQueued = true;
      this.pumpAudio();
      return await this.result.promise;
    } finally {
      signal?.removeEventListener("abort", onAbort);
      if (!this.stopped) this.abort();
    }
  }

  abort(): void {
    this.fail(new Error("speech transcription was aborted"));
  }

  private handleMessage(data: unknown): void {
    if (this.stopped) return;
    try {
      const raw =
        typeof data === "string"
          ? data
          : Buffer.isBuffer(data)
            ? data.toString("utf8")
            : String(data);
      const event = eventSchema.parse(JSON.parse(raw));
      if (event.error) {
        throw new Error(
          `ElevenLabs transcription: ${redactApiKey(event.error, this.options.apiKey)}`,
        );
      }
      if (event.message_type === "session_started" && !this.connected) {
        this.connected = true;
        clearTimeout(this.readyTimer);
        this.ready.resolve();
        this.pumpAudio();
      } else if (
        event.message_type === "partial_transcript" ||
        event.message_type === "committed_transcript"
      ) {
        if (event.text === undefined) throw new Error("missing transcript text");
        if (event.message_type === "committed_transcript") {
          this.committed = joinText(this.committed, event.text);
          this.partial = "";
        } else this.partial = event.text;
        this.options.onProgress?.(joinText(this.committed, this.partial));
        // Committed events have no audio watermark. Drain delayed segments after the final commit.
        clearTimeout(this.drainTimer);
        if (this.finalCommitSent && !this.partial) {
          this.drainTimer = setTimeout(() => {
            this.stopped = true;
            this.clearTimers();
            this.result.resolve(this.committed.trim());
            this.socket?.close();
          }, 2_000);
          this.drainTimer.unref?.();
        }
      }
    } catch (error) {
      this.fail(
        error instanceof Error ? error : new Error("malformed ElevenLabs transcription event"),
      );
    }
  }

  private pumpAudio(): void {
    if (!this.connected || this.stopped || this.sendTimer || this.finalCommitSent) return;
    if (!this.pendingAudioBytes) return;
    if (this.pendingAudioBytes < AUDIO_CHUNK_BYTES && !this.finalAudioQueued) return;

    const audio = Buffer.allocUnsafe(Math.min(AUDIO_CHUNK_BYTES, this.pendingAudioBytes));
    let offset = 0;
    while (offset < audio.length) {
      const next = this.pendingAudio[0]!;
      const length = Math.min(next.length, audio.length - offset);
      next.copy(audio, offset, 0, length);
      offset += length;
      if (length === next.length) this.pendingAudio.shift();
      else this.pendingAudio[0] = next.subarray(length);
    }
    this.pendingAudioBytes -= audio.length;
    this.finalCommitSent = this.finalAudioQueued && this.pendingAudioBytes === 0;
    if (this.finalCommitSent) {
      this.finishTimer = setTimeout(
        () => this.fail(new Error("timed out waiting for ElevenLabs transcription")),
        30_000,
      );
      this.finishTimer.unref?.();
    }
    this.sendAudio(audio, this.finalCommitSent);
    if (this.stopped || this.finalCommitSent) return;
    // Schedule from this send, so a delayed timer never causes a catch-up burst.
    this.sendTimer = setTimeout(() => {
      this.sendTimer = undefined;
      this.pumpAudio();
    }, AUDIO_SEND_INTERVAL_MS);
    this.sendTimer.unref?.();
  }

  private sendAudio(audio: Buffer, commit = false): void {
    if (this.stopped) return;
    try {
      this.socket?.send(
        JSON.stringify({
          message_type: "input_audio_chunk",
          audio_base_64: audio.toString("base64"),
          sample_rate: 16_000,
          commit,
        }),
        (error) => {
          if (error) this.fail(new Error("failed to send ElevenLabs transcription audio"));
        },
      );
    } catch {
      this.fail(new Error("failed to send ElevenLabs transcription audio"));
    }
  }

  private fail(error: Error): void {
    if (this.stopped) return;
    this.stopped = true;
    this.failure = error;
    this.pendingAudio = [];
    this.pendingAudioBytes = 0;
    this.controller.abort(error);
    this.clearTimers();
    this.ready.reject(error);
    this.result.reject(error);
    this.socket?.terminate();
  }

  private clearTimers(): void {
    clearTimeout(this.sendTimer);
    clearTimeout(this.readyTimer);
    clearTimeout(this.finishTimer);
    clearTimeout(this.drainTimer);
  }
}

function joinText(committed: string, next: string): string {
  if (!committed || !next || /\s$/.test(committed) || /^\s|^[.,!?;:]/.test(next))
    return committed + next;
  return `${committed} ${next}`;
}

function redactApiKey(message: string, apiKey: string): string {
  return message.replaceAll(apiKey.trim(), "[redacted]").slice(0, 500);
}
