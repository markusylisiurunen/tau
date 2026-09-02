import WebSocket from "ws";
import { z } from "zod";
import type { SpeechToTextWebSocket, SpeechToTextWebSocketFactory } from "./speech_to_text.js";
import type { SpeechToTextContext } from "./speech_to_text_context.js";
import { formatSpeechToTextContext } from "./speech_to_text_context.js";
import {
  normalizeSpeechToTextKeywords,
  SPEECH_TO_TEXT_KEYWORD_INSTRUCTIONS,
} from "./speech_to_text_keywords.js";

const GEMINI_GENERATE_CONTENT_BASE_URL = "https://generativelanguage.googleapis.com/v1beta/models";
const GEMINI_FILE_UPLOAD_URL = "https://generativelanguage.googleapis.com/upload/v1beta/files";
const GEMINI_INTERACTIONS_URL = "https://generativelanguage.googleapis.com/v1beta/interactions";
const GEMINI_FILES_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";
const GEMINI_LIVE_TRANSCRIPTION_URL =
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";
const GEMINI_TRANSCRIPTION_MODEL = "gemini-3.5-transcribe";
const GEMINI_LIVE_TRANSCRIPTION_MODEL = "gemini-3.5-transcribe-live";
const GEMINI_TRANSCRIPTION_KEYWORD_MODEL = "gemini-3.8-flash";
const GEMINI_TRANSCRIPTION_MAX_KEYWORD_CHARACTERS_TOTAL = 10_000;
const GEMINI_TRANSCRIPTION_KEYWORD_TIMEOUT_MS = 15_000;
const GEMINI_TRANSCRIPTION_CONNECT_TIMEOUT_MS = 15_000;
const GEMINI_TRANSCRIPTION_COMPLETION_TIMEOUT_MS = 30_000;
const GEMINI_FILE_DELETE_TIMEOUT_MS = 5_000;
const DEFAULT_GEMINI_AUDIO_MIME_TYPE = "audio/wav";

const errorPayloadSchema = z.object({
  error: z
    .object({
      message: z.string().trim().min(1).optional(),
    })
    .optional(),
});
const generateContentResponseSchema = z.object({
  candidates: z
    .array(
      z.object({
        content: z.object({
          parts: z.array(z.unknown()).optional(),
        }),
      }),
    )
    .optional(),
});
const textPartSchema = z.object({ text: z.string() });
const transcriptionKeywordsSchema = z
  .object({
    keywords: z.array(z.string()),
  })
  .strict();
const uploadedFileSchema = z.object({
  file: z.object({
    name: z.string().trim().min(1),
    uri: z.string().trim().min(1),
  }),
});
const interactionSchema = z.object({
  steps: z.array(z.unknown()).optional(),
});
const interactionModelOutputSchema = z.object({
  type: z.literal("model_output"),
  content: z.array(z.unknown()),
});
const interactionTextSchema = z.object({
  type: z.literal("text"),
  text: z.string(),
});
const liveMessageSchema = z
  .object({
    setupComplete: z.object({}).optional(),
    serverContent: z
      .object({
        inputTranscription: z
          .object({
            text: z.string().trim().min(1),
          })
          .optional(),
      })
      .passthrough()
      .optional(),
    error: z
      .object({
        message: z.string().trim().min(1),
      })
      .optional(),
  })
  .passthrough();

export type GeminiTranscriptionOptions = {
  apiKey: string;
  audio: Buffer;
  mimeType?: string;
  context?: SpeechToTextContext;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
};

export type StartGeminiTranscriptionOptions = {
  apiKey: string;
  context?: SpeechToTextContext;
  fetchImpl?: typeof fetch;
  webSocketFactory?: SpeechToTextWebSocketFactory;
};

export type GeminiStreamingTranscription = {
  appendAudio(audio: Buffer): void;
  finish(options?: { signal?: AbortSignal }): Promise<string>;
  abort(): void;
};

type UploadedGeminiFile = {
  name: string;
  uri: string;
};

class GeminiStreamingTranscriptionImpl implements GeminiStreamingTranscription {
  private readonly socket: SpeechToTextWebSocket;
  private readonly keywordAbortController = new AbortController();
  private readonly keywordsPromise: Promise<string[]>;
  private ready = false;
  private aborted = false;
  private failure?: Error;
  private completedTranscript?: string;
  private hasAudio = false;
  private pendingAudio: Buffer[] = [];
  private readyTimeout?: ReturnType<typeof setTimeout>;
  private completionTimeout?: ReturnType<typeof setTimeout>;
  private resolveReady?: () => void;
  private rejectReady?: (error: Error) => void;
  private resolveCompletion?: (transcript: string) => void;
  private rejectCompletion?: (error: Error) => void;
  readonly readyPromise: Promise<void>;

  constructor(options: StartGeminiTranscriptionOptions) {
    const apiKey = options.apiKey.trim();
    if (!apiKey) {
      throw new Error("missing Gemini API key");
    }

    this.keywordsPromise = prepareGeminiTranscriptionKeywords({
      apiKey,
      context: options.context,
      signal: this.keywordAbortController.signal,
      fetchImpl: options.fetchImpl,
    });
    const webSocketFactory = options.webSocketFactory ?? defaultWebSocketFactory;
    this.socket = webSocketFactory(
      `${GEMINI_LIVE_TRANSCRIPTION_URL}?key=${encodeURIComponent(apiKey)}`,
    );
    this.readyPromise = new Promise<void>((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    void this.readyPromise.catch(() => {});
    this.readyTimeout = setTimeout(() => {
      this.fail(new Error("timed out opening Gemini transcription session"));
      this.socket.terminate();
    }, GEMINI_TRANSCRIPTION_CONNECT_TIMEOUT_MS);
    this.readyTimeout.unref?.();

    this.socket.on("open", () => {
      if (this.readyTimeout) clearTimeout(this.readyTimeout);
      this.readyTimeout = undefined;
      void this.configureSession();
    });
    this.socket.on("message", (data) => this.handleMessage(data));
    this.socket.on("error", (error) => {
      this.fail(new Error(`Gemini transcription connection failed: ${error.message}`));
    });
    this.socket.on("close", (code, reason) => {
      if (this.aborted || this.completedTranscript) return;
      const detail = reason.toString("utf8").trim();
      this.fail(
        new Error(
          detail
            ? `Gemini transcription connection closed (${code}): ${detail}`
            : `Gemini transcription connection closed (${code})`,
        ),
      );
    });
  }

  appendAudio(audio: Buffer): void {
    if (audio.length === 0 || this.aborted || this.failure || this.completedTranscript) return;
    this.hasAudio = true;
    if (!this.ready) {
      this.pendingAudio.push(audio);
      return;
    }

    this.sendAudio(audio);
  }

  async finish(options: { signal?: AbortSignal } = {}): Promise<string> {
    const abortListener = () => this.abort();
    if (options.signal?.aborted) {
      abortListener();
    } else {
      options.signal?.addEventListener("abort", abortListener, { once: true });
    }

    try {
      await this.readyPromise;
      if (this.failure) throw this.failure;
      if (this.aborted) throw new Error("Gemini transcription was aborted");
      if (this.completedTranscript) return this.completedTranscript;
      if (!this.hasAudio) throw new Error("Gemini transcription received no audio");

      const completion = new Promise<string>((resolve, reject) => {
        this.resolveCompletion = resolve;
        this.rejectCompletion = reject;
      });
      this.completionTimeout = setTimeout(() => {
        this.fail(new Error("timed out waiting for Gemini transcription"));
        this.socket.terminate();
      }, GEMINI_TRANSCRIPTION_COMPLETION_TIMEOUT_MS);
      this.completionTimeout.unref?.();
      this.send({ realtimeInput: { activityEnd: {} } });
      return await completion;
    } finally {
      options.signal?.removeEventListener("abort", abortListener);
    }
  }

  abort(): void {
    if (this.aborted || this.completedTranscript) return;
    const error = new Error("Gemini transcription was aborted");
    this.aborted = true;
    this.pendingAudio = [];
    this.keywordAbortController.abort(error);
    this.clearTimers();
    this.rejectReady?.(error);
    this.rejectCompletion?.(error);
    this.clearWaiters();
    this.socket.close();
  }

  private async configureSession(): Promise<void> {
    const keywords = await this.keywordsPromise;
    if (this.aborted || this.failure) return;

    this.readyTimeout = setTimeout(() => {
      this.fail(new Error("timed out opening Gemini transcription session"));
      this.socket.terminate();
    }, GEMINI_TRANSCRIPTION_CONNECT_TIMEOUT_MS);
    this.readyTimeout.unref?.();
    this.send({
      setup: {
        model: `models/${GEMINI_LIVE_TRANSCRIPTION_MODEL}`,
        generationConfig: {
          responseModalities: ["TEXT"],
        },
        inputAudioTranscription: {
          languageCodes: [],
          ...(keywords.length > 0 ? { customVocabulary: keywords } : {}),
          mode: "SMART",
        },
        realtimeInputConfig: {
          automaticActivityDetection: {
            disabled: true,
          },
        },
      },
    });
  }

  private handleMessage(data: unknown): void {
    let payload: unknown;
    try {
      payload = JSON.parse(formatWebSocketMessage(data)) as unknown;
    } catch {
      this.fail(new Error("Gemini transcription returned malformed JSON"));
      return;
    }

    const event = liveMessageSchema.safeParse(payload);
    if (!event.success) {
      this.fail(new Error("Gemini transcription returned a malformed event"));
      return;
    }

    if (event.data.error) {
      this.fail(new Error(event.data.error.message));
      return;
    }

    if (event.data.setupComplete && !this.ready) {
      this.ready = true;
      if (this.readyTimeout) clearTimeout(this.readyTimeout);
      this.readyTimeout = undefined;
      this.send({ realtimeInput: { activityStart: {} } });
      const pendingAudio = this.pendingAudio;
      this.pendingAudio = [];
      for (const audio of pendingAudio) {
        this.sendAudio(audio);
      }
      if (this.failure) return;
      this.resolveReady?.();
      this.resolveReady = undefined;
      this.rejectReady = undefined;
      return;
    }

    const transcript = event.data.serverContent?.inputTranscription?.text;
    if (transcript) {
      this.completedTranscript = transcript;
      this.clearTimers();
      this.resolveCompletion?.(transcript);
      this.clearWaiters();
      this.socket.close();
    }
  }

  private sendAudio(audio: Buffer): void {
    this.send({
      realtimeInput: {
        audio: {
          data: audio.toString("base64"),
          mimeType: "audio/pcm;rate=16000",
        },
      },
    });
  }

  private send(event: Record<string, unknown>): void {
    if (this.failure || this.aborted) return;
    try {
      this.socket.send(JSON.stringify(event), (error) => {
        if (error) {
          this.fail(new Error(`failed to send Gemini transcription audio: ${error.message}`));
        }
      });
    } catch (error) {
      this.fail(
        new Error(`failed to send Gemini transcription audio: ${(error as Error).message}`),
      );
    }
  }

  private fail(error: Error): void {
    if (this.failure || this.aborted || this.completedTranscript) return;
    this.failure = error;
    this.pendingAudio = [];
    this.keywordAbortController.abort(error);
    this.clearTimers();
    this.rejectReady?.(error);
    this.rejectCompletion?.(error);
    this.clearWaiters();
    this.socket.terminate();
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

export function startGeminiTranscription(
  options: StartGeminiTranscriptionOptions,
): GeminiStreamingTranscription {
  return new GeminiStreamingTranscriptionImpl(options);
}

export async function transcribeGeminiAudio(options: GeminiTranscriptionOptions): Promise<string> {
  const apiKey = options.apiKey.trim();
  if (!apiKey) {
    throw new Error("missing Gemini API key");
  }

  const fetchFn = options.fetchImpl ?? fetch;
  const [keywords, uploadedFile] = await Promise.all([
    prepareGeminiTranscriptionKeywords({
      apiKey,
      context: options.context,
      signal: options.signal,
      fetchImpl: fetchFn,
    }),
    uploadGeminiAudio({
      apiKey,
      audio: options.audio,
      mimeType: options.mimeType ?? DEFAULT_GEMINI_AUDIO_MIME_TYPE,
      signal: options.signal,
      fetchImpl: fetchFn,
    }),
  ]);

  try {
    const response = await fetchFn(GEMINI_INTERACTIONS_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": apiKey,
      },
      signal: options.signal,
      body: JSON.stringify({
        model: GEMINI_TRANSCRIPTION_MODEL,
        input: [
          {
            type: "audio",
            uri: uploadedFile.uri,
            mime_type: options.mimeType ?? DEFAULT_GEMINI_AUDIO_MIME_TYPE,
          },
        ],
        generation_config: {
          transcription_config: {
            language_codes: [],
            ...(keywords.length > 0 ? { custom_vocabulary: keywords } : {}),
            mode: "smart",
          },
        },
        store: false,
      }),
    });
    const { payload, responseText } = await readResponsePayload(response);
    if (!response.ok) {
      throw createResponseError(payload, responseText, response.status);
    }

    const transcript = extractInteractionText(payload)?.trim();
    if (!transcript) {
      throw new Error("transcription result was empty or malformed");
    }
    return transcript;
  } finally {
    await deleteGeminiFile({
      apiKey,
      fileName: uploadedFile.name,
      fetchImpl: fetchFn,
    });
  }
}

async function prepareGeminiTranscriptionKeywords(args: {
  apiKey: string;
  context?: SpeechToTextContext;
  signal?: AbortSignal;
  fetchImpl?: typeof fetch;
}): Promise<string[]> {
  const formattedContext = formatSpeechToTextContext(args.context);
  if (!formattedContext) return [];

  try {
    const signals = [AbortSignal.timeout(GEMINI_TRANSCRIPTION_KEYWORD_TIMEOUT_MS)];
    if (args.signal) signals.push(args.signal);
    const response = await (args.fetchImpl ?? fetch)(
      `${GEMINI_GENERATE_CONTENT_BASE_URL}/${GEMINI_TRANSCRIPTION_KEYWORD_MODEL}:generateContent`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "x-goog-api-key": args.apiKey,
        },
        signal: AbortSignal.any(signals),
        body: JSON.stringify({
          systemInstruction: {
            parts: [{ text: SPEECH_TO_TEXT_KEYWORD_INSTRUCTIONS }],
          },
          contents: [
            {
              parts: [{ text: formattedContext }],
            },
          ],
          generationConfig: {
            responseMimeType: "application/json",
            responseSchema: {
              type: "OBJECT",
              properties: {
                keywords: {
                  type: "ARRAY",
                  items: { type: "STRING" },
                },
              },
              required: ["keywords"],
            },
            thinkingConfig: {
              thinkingLevel: "low",
            },
          },
        }),
      },
    );
    if (!response.ok) {
      await response.body?.cancel().catch(() => {});
      return [];
    }

    const payload = (await response.json()) as unknown;
    const outputText = extractGenerateContentText(payload);
    const parsedKeywords = transcriptionKeywordsSchema.safeParse(
      outputText ? (JSON.parse(outputText) as unknown) : undefined,
    );
    return parsedKeywords.success
      ? normalizeSpeechToTextKeywords(parsedKeywords.data.keywords, {
          maxTotalCharacters: GEMINI_TRANSCRIPTION_MAX_KEYWORD_CHARACTERS_TOTAL,
        })
      : [];
  } catch {
    return [];
  }
}

async function uploadGeminiAudio(args: {
  apiKey: string;
  audio: Buffer;
  mimeType: string;
  signal?: AbortSignal;
  fetchImpl: typeof fetch;
}): Promise<UploadedGeminiFile> {
  const startResponse = await args.fetchImpl(GEMINI_FILE_UPLOAD_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-goog-api-key": args.apiKey,
      "X-Goog-Upload-Protocol": "resumable",
      "X-Goog-Upload-Command": "start",
      "X-Goog-Upload-Header-Content-Length": String(args.audio.byteLength),
      "X-Goog-Upload-Header-Content-Type": args.mimeType,
    },
    signal: args.signal,
    body: JSON.stringify({ file: { display_name: "tau-speech" } }),
  });
  if (!startResponse.ok) {
    const { payload, responseText } = await readResponsePayload(startResponse);
    throw createResponseError(payload, responseText, startResponse.status);
  }

  const uploadUrl = startResponse.headers.get("x-goog-upload-url")?.trim();
  await startResponse.body?.cancel().catch(() => {});
  if (!uploadUrl) {
    throw new Error("Gemini file upload did not return an upload URL");
  }

  const uploadResponse = await args.fetchImpl(uploadUrl, {
    method: "POST",
    headers: {
      "Content-Length": String(args.audio.byteLength),
      "Content-Type": args.mimeType,
      "X-Goog-Upload-Offset": "0",
      "X-Goog-Upload-Command": "upload, finalize",
    },
    signal: args.signal,
    body: Uint8Array.from(args.audio),
  });
  const { payload, responseText } = await readResponsePayload(uploadResponse);
  if (!uploadResponse.ok) {
    throw createResponseError(payload, responseText, uploadResponse.status);
  }

  const uploadedFile = uploadedFileSchema.safeParse(payload);
  if (!uploadedFile.success) {
    throw new Error("Gemini file upload returned a malformed response");
  }
  return uploadedFile.data.file;
}

async function deleteGeminiFile(args: {
  apiKey: string;
  fileName: string;
  fetchImpl: typeof fetch;
}): Promise<void> {
  try {
    const response = await args.fetchImpl(`${GEMINI_FILES_BASE_URL}/${args.fileName}`, {
      method: "DELETE",
      headers: { "x-goog-api-key": args.apiKey },
      signal: AbortSignal.timeout(GEMINI_FILE_DELETE_TIMEOUT_MS),
    });
    await response.body?.cancel().catch(() => {});
  } catch {
    // best-effort remote cleanup
  }
}

function extractGenerateContentText(payload: unknown): string | undefined {
  const parsed = generateContentResponseSchema.safeParse(payload);
  if (!parsed.success) return undefined;

  return (parsed.data.candidates?.[0]?.content.parts ?? [])
    .map((part) => {
      const parsedPart = textPartSchema.safeParse(part);
      return parsedPart.success ? parsedPart.data.text : "";
    })
    .join("");
}

function extractInteractionText(payload: unknown): string | undefined {
  const parsed = interactionSchema.safeParse(payload);
  if (!parsed.success) return undefined;

  return (parsed.data.steps ?? [])
    .flatMap((step) => {
      const modelOutput = interactionModelOutputSchema.safeParse(step);
      return modelOutput.success ? modelOutput.data.content : [];
    })
    .flatMap((content) => {
      const text = interactionTextSchema.safeParse(content);
      return text.success ? [text.data.text] : [];
    })
    .join("");
}

async function readResponsePayload(
  response: Response,
): Promise<{ payload: unknown; responseText: string }> {
  const responseText = await response.text();
  try {
    return {
      payload: responseText ? (JSON.parse(responseText) as unknown) : undefined,
      responseText,
    };
  } catch {
    return { payload: undefined, responseText };
  }
}

function createResponseError(payload: unknown, responseText: string, status: number): Error {
  const parsed = errorPayloadSchema.safeParse(payload);
  return new Error(
    parsed.success
      ? (parsed.data.error?.message ?? (responseText.trim() || `HTTP ${status}`))
      : responseText.trim() || `HTTP ${status}`,
  );
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

function defaultWebSocketFactory(url: string): SpeechToTextWebSocket {
  return new WebSocket(url) as SpeechToTextWebSocket;
}
