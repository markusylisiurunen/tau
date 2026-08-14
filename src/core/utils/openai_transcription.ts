import type { ChildProcess } from "node:child_process";
import WebSocket from "ws";
import { z } from "zod";
import type { SpawnCaptureResult } from "./spawn_capture.js";
import { spawnWithCapture } from "./spawn_capture.js";
import { formatSpeechToTextContext, type SpeechToTextContext } from "./speech_to_text_context.js";
import { truncateForTokens } from "./truncate.js";

const OPENAI_REALTIME_TRANSCRIPTION_URL = "wss://api.openai.com/v1/realtime?intent=transcription";
const OPENAI_TRANSCRIPTION_MODEL = "gpt-live-transcribe";
const OPENAI_TRANSCRIPTION_SAMPLE_RATE = 24_000;
const OPENAI_TRANSCRIPTION_CONNECT_TIMEOUT_MS = 15_000;
const OPENAI_TRANSCRIPTION_COMPLETION_TIMEOUT_MS = 30_000;
const OPENAI_TRANSCRIPTION_CONTEXT_TOKENS = 900;
const OPENAI_TRANSCRIPTION_FFMPEG_TIMEOUT_MS = 5 * 60 * 1_000;
const OPENAI_TRANSCRIPTION_FFMPEG_OUTPUT_LIMIT_BYTES = 20_000;
const OPENAI_TRANSCRIPTION_MAX_PCM_BYTES =
  OPENAI_TRANSCRIPTION_SAMPLE_RATE * 2 * (OPENAI_TRANSCRIPTION_FFMPEG_TIMEOUT_MS / 1_000);
const OPENAI_TRANSCRIPTION_BACKPRESSURE_HIGH_BYTES = 1024 * 1024;
const OPENAI_TRANSCRIPTION_BACKPRESSURE_LOW_BYTES = 256 * 1024;

const eventSchema = z.object({ type: z.string() }).passthrough();
const errorEventSchema = z.object({
  type: z.literal("error"),
  error: z.object({ message: z.string().trim().min(1) }),
});
const transcriptionFailedEventSchema = z.object({
  type: z.literal("conversation.item.input_audio_transcription.failed"),
  error: z.object({ message: z.string().trim().min(1) }),
});
const transcriptionCompletedEventSchema = z.object({
  type: z.literal("conversation.item.input_audio_transcription.completed"),
  transcript: z.string().trim().min(1),
});

export type OpenAITranscriptionWebSocket = {
  readonly bufferedAmount?: number;
  on(event: "open", listener: () => void): unknown;
  on(event: "message", listener: (data: unknown) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  on(event: "close", listener: (code: number, reason: Buffer) => void): unknown;
  send(data: string, callback?: (error?: Error) => void): void;
  close(): void;
  terminate(): void;
};

export type OpenAITranscriptionWebSocketFactory = (
  url: string,
  options: { headers: Record<string, string> },
) => OpenAITranscriptionWebSocket;

export type OpenAIStreamingTranscription = {
  appendAudio(audio: Buffer): void;
  finish(options?: {
    audio?: Buffer;
    signal?: AbortSignal;
    spawnImpl?: typeof spawnWithCapture;
  }): Promise<string>;
  abort(): void;
};

export type StartOpenAITranscriptionOptions = {
  apiKey: string;
  context?: SpeechToTextContext;
  webSocketFactory?: OpenAITranscriptionWebSocketFactory;
};

export type TranscribeOpenAIAudioOptions = StartOpenAITranscriptionOptions & {
  audio: Buffer;
  signal?: AbortSignal;
  spawnImpl?: typeof spawnWithCapture;
};

class OpenAIStreamingTranscriptionImpl implements OpenAIStreamingTranscription {
  private readonly socket: OpenAITranscriptionWebSocket;
  private readonly abortController = new AbortController();
  private readonly audioDrainWaiters = new Set<() => void>();
  private ready = false;
  private aborted = false;
  private failure?: Error;
  private completedTranscript?: string;
  private hasAudio = false;
  private pendingAudio: Buffer[] = [];
  private pendingAudioBytes = 0;
  private readyTimeout?: ReturnType<typeof setTimeout>;
  private completionTimeout?: ReturnType<typeof setTimeout>;
  private resolveReady?: () => void;
  private rejectReady?: (error: Error) => void;
  private resolveCompletion?: (transcript: string) => void;
  private rejectCompletion?: (error: Error) => void;
  readonly readyPromise: Promise<void>;

  constructor(options: StartOpenAITranscriptionOptions) {
    const apiKey = options.apiKey.trim();
    if (!apiKey) {
      throw new Error("missing OpenAI API key");
    }

    const webSocketFactory = options.webSocketFactory ?? defaultWebSocketFactory;
    this.socket = webSocketFactory(OPENAI_REALTIME_TRANSCRIPTION_URL, {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    void this.readyPromise.catch(() => {});
    this.readyTimeout = setTimeout(() => {
      this.fail(new Error("timed out opening OpenAI transcription session"));
      this.socket.terminate();
    }, OPENAI_TRANSCRIPTION_CONNECT_TIMEOUT_MS);
    this.readyTimeout.unref?.();

    this.socket.on("open", () => {
      this.send({
        type: "session.update",
        session: {
          type: "transcription",
          audio: {
            input: {
              format: {
                type: "audio/pcm",
                rate: OPENAI_TRANSCRIPTION_SAMPLE_RATE,
              },
              transcription: {
                model: OPENAI_TRANSCRIPTION_MODEL,
                prompt: buildOpenAITranscriptionPrompt(options.context),
                delay: "medium",
              },
              turn_detection: null,
            },
          },
        },
      });
    });
    this.socket.on("message", (data) => this.handleMessage(data));
    this.socket.on("error", (error) => {
      this.fail(new Error(`OpenAI transcription connection failed: ${error.message}`));
    });
    this.socket.on("close", (code, reason) => {
      if (this.aborted || this.completedTranscript) return;
      const detail = reason.toString("utf8").trim();
      this.fail(
        new Error(
          detail
            ? `OpenAI transcription connection closed (${code}): ${detail}`
            : `OpenAI transcription connection closed (${code})`,
        ),
      );
    });
  }

  appendAudio(audio: Buffer): void {
    if (audio.length === 0 || this.aborted || this.failure || this.completedTranscript) return;
    this.hasAudio = true;
    if (!this.ready) {
      this.pendingAudio.push(audio);
      this.pendingAudioBytes += audio.length;
      return;
    }

    this.sendAudio(audio);
  }

  async finish(
    options: { audio?: Buffer; signal?: AbortSignal; spawnImpl?: typeof spawnWithCapture } = {},
  ): Promise<string> {
    const abortListener = () => this.abort();
    if (options.signal?.aborted) {
      abortListener();
    } else {
      options.signal?.addEventListener("abort", abortListener, { once: true });
    }

    try {
      await this.readyPromise;
      if (this.failure) throw this.failure;
      if (this.aborted) throw new Error("OpenAI transcription was aborted");
      if (this.completedTranscript) return this.completedTranscript;

      if (!this.hasAudio && options.audio) {
        try {
          await decodeAndStreamOpenAIAudio({
            audio: options.audio,
            signal: this.abortController.signal,
            transcription: this,
            spawnImpl: options.spawnImpl,
          });
        } catch (error) {
          const failure = error instanceof Error ? error : new Error(String(error));
          this.fail(failure);
          throw failure;
        }
      }

      if (this.failure) throw this.failure;
      if (this.aborted) throw new Error("OpenAI transcription was aborted");

      const completion = new Promise<string>((resolve, reject) => {
        this.resolveCompletion = resolve;
        this.rejectCompletion = reject;
      });
      this.completionTimeout = setTimeout(() => {
        this.fail(new Error("timed out waiting for OpenAI transcription"));
        this.socket.terminate();
      }, OPENAI_TRANSCRIPTION_COMPLETION_TIMEOUT_MS);
      this.completionTimeout.unref?.();
      this.send({ type: "input_audio_buffer.commit" });
      return await completion;
    } finally {
      options.signal?.removeEventListener("abort", abortListener);
    }
  }

  abort(): void {
    if (this.aborted || this.completedTranscript) return;
    const error = new Error("OpenAI transcription was aborted");
    this.aborted = true;
    this.abortController.abort(error);
    this.pendingAudio = [];
    this.pendingAudioBytes = 0;
    this.clearTimers();
    this.rejectReady?.(error);
    this.rejectCompletion?.(error);
    this.resolveAudioDrainWaiters();
    this.clearWaiters();
    this.socket.close();
  }

  private handleMessage(data: unknown): void {
    let payload: unknown;
    try {
      payload = JSON.parse(formatWebSocketMessage(data)) as unknown;
    } catch {
      this.fail(new Error("OpenAI transcription returned malformed JSON"));
      return;
    }

    const event = eventSchema.safeParse(payload);
    if (!event.success) {
      this.fail(new Error("OpenAI transcription returned a malformed event"));
      return;
    }

    if (event.data.type === "session.updated") {
      this.ready = true;
      if (this.readyTimeout) clearTimeout(this.readyTimeout);
      this.readyTimeout = undefined;
      const pendingAudio = this.pendingAudio;
      this.pendingAudio = [];
      this.pendingAudioBytes = 0;
      for (const audio of pendingAudio) {
        this.sendAudio(audio);
      }
      this.resolveAudioDrainWaitersIfReady();
      if (this.failure) return;
      this.resolveReady?.();
      this.resolveReady = undefined;
      this.rejectReady = undefined;
      return;
    }

    if (event.data.type === "error") {
      const parsed = errorEventSchema.safeParse(payload);
      this.fail(
        new Error(
          parsed.success ? parsed.data.error.message : "OpenAI transcription returned an error",
        ),
      );
      return;
    }

    if (event.data.type === "conversation.item.input_audio_transcription.failed") {
      const parsed = transcriptionFailedEventSchema.safeParse(payload);
      this.fail(
        new Error(
          parsed.success
            ? parsed.data.error.message
            : "OpenAI transcription failed with a malformed error",
        ),
      );
      return;
    }

    if (event.data.type === "conversation.item.input_audio_transcription.completed") {
      const parsed = transcriptionCompletedEventSchema.safeParse(payload);
      if (!parsed.success) {
        this.fail(new Error("transcription result was empty or malformed"));
        return;
      }

      this.completedTranscript = parsed.data.transcript;
      this.clearTimers();
      this.resolveCompletion?.(this.completedTranscript);
      this.clearWaiters();
      this.socket.close();
    }
  }

  private sendAudio(audio: Buffer): void {
    this.send({
      type: "input_audio_buffer.append",
      audio: audio.toString("base64"),
    });
  }

  private send(event: Record<string, unknown>): void {
    if (this.failure || this.aborted) return;
    try {
      this.socket.send(JSON.stringify(event), (error) => {
        if (error) {
          this.fail(new Error(`failed to send OpenAI transcription audio: ${error.message}`));
          return;
        }
        this.resolveAudioDrainWaitersIfReady();
      });
    } catch (error) {
      this.fail(
        new Error(`failed to send OpenAI transcription audio: ${(error as Error).message}`),
      );
    }
  }

  isAudioBackpressured(): boolean {
    return (
      this.pendingAudioBytes > OPENAI_TRANSCRIPTION_BACKPRESSURE_HIGH_BYTES ||
      (this.socket.bufferedAmount ?? 0) > OPENAI_TRANSCRIPTION_BACKPRESSURE_HIGH_BYTES
    );
  }

  waitForAudioDrain(): Promise<void> {
    if (!this.isAudioBackpressured() || this.failure || this.aborted) {
      return Promise.resolve();
    }

    return new Promise((resolve) => this.audioDrainWaiters.add(resolve));
  }

  private fail(error: Error): void {
    if (this.failure || this.aborted || this.completedTranscript) return;
    this.failure = error;
    this.abortController.abort(error);
    this.pendingAudio = [];
    this.pendingAudioBytes = 0;
    this.clearTimers();
    this.rejectReady?.(error);
    this.rejectCompletion?.(error);
    this.resolveAudioDrainWaiters();
    this.clearWaiters();
    this.socket.terminate();
  }

  private resolveAudioDrainWaitersIfReady(): void {
    if (
      this.pendingAudioBytes > OPENAI_TRANSCRIPTION_BACKPRESSURE_LOW_BYTES ||
      (this.socket.bufferedAmount ?? 0) > OPENAI_TRANSCRIPTION_BACKPRESSURE_LOW_BYTES
    ) {
      return;
    }
    this.resolveAudioDrainWaiters();
  }

  private resolveAudioDrainWaiters(): void {
    for (const resolve of this.audioDrainWaiters) {
      resolve();
    }
    this.audioDrainWaiters.clear();
  }

  private clearTimers(): void {
    if (this.readyTimeout) clearTimeout(this.readyTimeout);
    if (this.completionTimeout) clearTimeout(this.completionTimeout);
    this.readyTimeout = undefined;
    this.completionTimeout = undefined;
  }

  private clearWaiters(): void {
    this.resolveReady = undefined;
    this.rejectReady = undefined;
    this.resolveCompletion = undefined;
    this.rejectCompletion = undefined;
  }
}

export function startOpenAITranscription(
  options: StartOpenAITranscriptionOptions,
): OpenAIStreamingTranscription {
  return new OpenAIStreamingTranscriptionImpl(options);
}

export async function transcribeOpenAIAudio(
  options: TranscribeOpenAIAudioOptions,
): Promise<string> {
  const transcription = startOpenAITranscription(options);
  try {
    return await transcription.finish({
      audio: options.audio,
      signal: options.signal,
      spawnImpl: options.spawnImpl,
    });
  } catch (error) {
    transcription.abort();
    throw error;
  }
}

async function decodeAndStreamOpenAIAudio(args: {
  audio: Buffer;
  signal: AbortSignal;
  transcription: OpenAIStreamingTranscriptionImpl;
  spawnImpl?: typeof spawnWithCapture;
}): Promise<void> {
  const spawnImpl = args.spawnImpl ?? spawnWithCapture;
  const decoderAbortController = new AbortController();
  const signal = AbortSignal.any([args.signal, decoderAbortController.signal]);
  let decodedBytes = 0;
  let decodeFailure: Error | undefined;
  let result: SpawnCaptureResult;
  try {
    result = await spawnImpl(
      "ffmpeg",
      [
        "-nostdin",
        "-hide_banner",
        "-loglevel",
        "error",
        "-i",
        "pipe:0",
        "-vn",
        "-ac",
        "1",
        "-ar",
        String(OPENAI_TRANSCRIPTION_SAMPLE_RATE),
        "-c:a",
        "pcm_s16le",
        "-f",
        "s16le",
        "pipe:1",
      ],
      {
        input: args.audio,
        signal,
        timeoutMs: OPENAI_TRANSCRIPTION_FFMPEG_TIMEOUT_MS,
        maxCaptureBytes: OPENAI_TRANSCRIPTION_FFMPEG_OUTPUT_LIMIT_BYTES,
        captureOutput: "stderr",
        stdio: ["pipe", "pipe", "pipe"],
        onSpawn: (child: ChildProcess) => {
          const output = child.stdout;
          output?.on("data", (chunk: Buffer) => {
            if (decodeFailure || signal.aborted) return;
            decodedBytes += chunk.length;
            if (decodedBytes > OPENAI_TRANSCRIPTION_MAX_PCM_BYTES) {
              decodeFailure = new Error("audio exceeds the five-minute OpenAI transcription limit");
              decoderAbortController.abort(decodeFailure);
              return;
            }

            args.transcription.appendAudio(chunk);
            if (!args.transcription.isAudioBackpressured()) return;

            output.pause();
            void args.transcription.waitForAudioDrain().then(() => {
              if (!signal.aborted) {
                output.resume();
              }
            });
          });
        },
      },
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new Error("ffmpeg is required for OpenAI speech transcription");
    }
    throw error;
  }

  if (decodeFailure) {
    throw decodeFailure;
  }
  if (result.aborted) {
    throw signal.reason instanceof Error
      ? signal.reason
      : new Error("OpenAI transcription was aborted");
  }
  if (result.timedOut) {
    throw new Error("ffmpeg timed out while decoding audio for OpenAI transcription");
  }
  if (result.exitCode !== 0) {
    const detail = result.stderr.trim();
    throw new Error(
      detail
        ? `ffmpeg failed to decode audio for OpenAI transcription: ${detail}`
        : `ffmpeg exited with code ${result.exitCode ?? "unknown"}`,
    );
  }
}

function buildOpenAITranscriptionPrompt(context: SpeechToTextContext | undefined): string {
  const formattedContext = formatSpeechToTextContext(context);
  const boundedContext = formattedContext
    ? truncateForTokens(formattedContext, {
        maxTokens: OPENAI_TRANSCRIPTION_CONTEXT_TOKENS,
        strategy: "tail",
      }).content.trim()
    : "";
  return [
    "The speaker is dictating a message for insertion into an AI coding assistant chat input.",
    boundedContext
      ? `Use this recent conversation only to resolve likely names, acronyms, terminology, and references:\n${boundedContext}`
      : undefined,
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n\n");
}

function formatWebSocketMessage(data: unknown): string {
  if (typeof data === "string") return data;
  if (Buffer.isBuffer(data)) return data.toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  if (ArrayBuffer.isView(data)) {
    return Buffer.from(data.buffer, data.byteOffset, data.byteLength).toString("utf8");
  }
  throw new Error("unsupported WebSocket message");
}

function defaultWebSocketFactory(
  url: string,
  options: { headers: Record<string, string> },
): OpenAITranscriptionWebSocket {
  return new WebSocket(url, options) as OpenAITranscriptionWebSocket;
}
