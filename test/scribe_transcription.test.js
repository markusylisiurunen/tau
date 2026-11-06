import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  startScribeTranscription,
  transcribeScribeAudio,
} from "../dist/core/utils/scribe_transcription.js";
import { cleanupSpeechTranscript } from "../dist/core/utils/speech_cleanup.js";
import { prepareSpeechToTextKeywords } from "../dist/core/utils/speech_to_text_keywords.js";

function json(payload, status = 200) {
  return new Response(JSON.stringify(payload), { status });
}

async function live() {
  vi.useFakeTimers();
  const socket = new EventEmitter();
  socket.send = vi.fn((_data, callback) => callback?.());
  socket.close = vi.fn();
  socket.terminate = vi.fn();
  const factory = vi.fn(() => socket);
  const onProgress = vi.fn();
  const transcription = startScribeTranscription({
    apiKey: "key",
    vocabulary: ["Tau"],
    webSocketFactory: factory,
    onProgress,
  });
  transcription.appendAudio(Buffer.alloc(32000));
  await vi.advanceTimersByTimeAsync(0);
  const emit = (event) => socket.emit("message", JSON.stringify(event));
  emit({ message_type: "session_started" });
  return { transcription, socket, factory, onProgress, emit };
}

afterEach(() => vi.useRealTimers());

describe("Scribe transcription", () => {
  it("sends file audio and prioritized, provider-valid keyterms", async () => {
    const fetchImpl = vi.fn(async (url) =>
      url.includes("openai")
        ? json({
            status: "completed",
            output: [
              {
                type: "message",
                status: "completed",
                content: [
                  {
                    type: "output_text",
                    text: JSON.stringify({
                      keywords: ["tau", "Derived", "bad\\term", "one two three four five six"],
                    }),
                  },
                ],
              },
            ],
          })
        : json({ text: " Valmis. " }),
    );
    expect(
      await transcribeScribeAudio({
        apiKey: "eleven",
        openAIApiKey: "openai",
        vocabulary: ["Tau", "x".repeat(51), "bad[term]"],
        context: { messages: [{ role: "user", text: "context" }] },
        audio: Buffer.from("audio"),
        mimeType: "audio/ogg",
        fetchImpl,
      }),
    ).toBe("Valmis.");
    const [url, request] = fetchImpl.mock.calls[1];
    expect(url).toBe("https://api.elevenlabs.io/v1/speech-to-text");
    expect(request.headers).toEqual({ "xi-api-key": "eleven" });
    expect(request.body.getAll("keyterms")).toEqual(["Tau", "Derived"]);
    expect(request.body.get("no_verbatim")).toBe("true");
    expect(request.body.get("model_id")).toBe("scribe_v2");
    expect(request.body.has("language_code")).toBe(false);
    expect(await request.body.get("file").text()).toBe("audio");
  });

  it.each([
    [{ detail: { message: "quota exhausted" } }, "quota exhausted"],
    [{ detail: "invalid key secret-key" }, "invalid key [redacted]"],
    [{ unexpected: true }, "HTTP 401"],
  ])("preserves file API diagnostics without credentials", async (payload, detail) => {
    await expect(
      transcribeScribeAudio({
        apiKey: "secret-key",
        audio: Buffer.from("audio"),
        fetchImpl: async () => json(payload, 401),
      }),
    ).rejects.toThrow(detail);
  });

  it("redacts credentials from provider error events", async () => {
    const { transcription, emit } = await live();
    const result = transcription.finish();
    const rejected = expect(result).rejects.toThrow("invalid credential [redacted]");
    emit({ message_type: "auth_error", error: "invalid credential key" });
    await rejected;
  });

  it.each(["error", "close"])("preserves socket %s diagnostics", async (event) => {
    const { transcription, socket } = await live();
    const result = transcription.finish();
    const rejected = expect(result).rejects.toThrow(event === "error" ? "handshake 401" : "1008");
    if (event === "error") socket.emit("error", new Error("handshake 401"));
    else socket.emit("close", 1008, Buffer.from("policy violation"));
    await rejected;
  });

  it.each(["", "already committed"])("finishes an empty final segment after %j", async (text) => {
    const { transcription, socket, emit } = await live();
    if (text) emit({ message_type: "committed_transcript", text });
    const result = transcription.finish();
    await vi.advanceTimersByTimeAsync(0);
    emit({ message_type: "committed_transcript", text: "" });
    await vi.advanceTimersByTimeAsync(1999);
    expect(socket.close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toBe(text);
    expect(socket.close).toHaveBeenCalledOnce();
  });

  it("keeps configured vocabulary when hint extraction fails", async () => {
    expect(
      await prepareSpeechToTextKeywords({
        apiKey: "key",
        context: { messages: [{ role: "user", text: "context" }] },
        vocabulary: ["Tau"],
        fetchImpl: async () => json({}, 503),
      }),
    ).toEqual(["Tau"]);
  });

  it("filters realtime keyterms to 50 terms of at most 20 characters without changing order", async () => {
    const socket = new EventEmitter();
    socket.terminate = vi.fn();
    const factory = vi.fn(() => socket);
    const vocabulary = ["x".repeat(21), ...Array.from({ length: 60 }, (_, i) => `term-${i}`)];
    const transcription = startScribeTranscription({
      apiKey: "key",
      vocabulary,
      webSocketFactory: factory,
    });
    await vi.waitFor(() => expect(factory).toHaveBeenCalledOnce());
    expect(new URL(factory.mock.calls[0][0]).searchParams.getAll("keyterms")).toEqual(
      vocabulary.slice(1, 51),
    );
    transcription.abort();
  });

  it("buffers startup audio, replaces partials and drains late committed segments", async () => {
    const { transcription, socket, factory, emit, onProgress } = await live();
    const url = new URL(factory.mock.calls[0][0]);
    expect(url.searchParams.get("no_verbatim")).toBe("true");
    expect(url.searchParams.get("commit_strategy")).toBe("vad");
    expect(url.searchParams.getAll("keyterms")).toEqual(["Tau"]);
    expect(factory.mock.calls[0][1]).toEqual({ headers: { "xi-api-key": "key" } });
    expect(JSON.parse(socket.send.mock.calls[0][0]).audio_base_64).toBe(
      Buffer.alloc(32000).toString("base64"),
    );
    emit({ message_type: "partial_transcript", text: "first draft" });
    emit({ message_type: "partial_transcript", text: "first" });
    emit({ message_type: "committed_transcript", text: "first" });
    const result = transcription.finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(JSON.parse(socket.send.mock.calls.at(-1)[0]).commit).toBe(true);
    emit({ message_type: "committed_transcript", text: "second" });
    await vi.advanceTimersByTimeAsync(1900);
    emit({ message_type: "partial_transcript", text: "last" });
    await vi.advanceTimersByTimeAsync(2100);
    expect(socket.close).not.toHaveBeenCalled();
    emit({ message_type: "committed_transcript", text: "last word" });
    await vi.advanceTimersByTimeAsync(2000);
    await expect(result).resolves.toBe("first second last word");
    expect(onProgress.mock.calls.map(([text]) => text)).toEqual([
      "first draft",
      "first",
      "first",
      "first second",
      "first second last",
      "first second last word",
    ]);
    expect(socket.close).toHaveBeenCalledOnce();
  });

  it.each(["missing-final", "connection-loss", "abort", "malformed", "provider-error"])(
    "fails instead of accepting a partial transcript: %s",
    async (failure) => {
      const { transcription, socket, emit } = await live();
      emit({ message_type: "partial_transcript", text: "unfinished" });
      const controller = new AbortController();
      const result = transcription.finish({ signal: controller.signal });
      const rejected = expect(result).rejects.toThrow();
      await vi.advanceTimersByTimeAsync(0);
      if (failure === "connection-loss") socket.emit("close", 1006, Buffer.alloc(0));
      else if (failure === "abort") controller.abort();
      else if (failure === "malformed") socket.emit("message", "{");
      else if (failure === "provider-error")
        emit({ message_type: "quota_exceeded", error: "quota exceeded" });
      else await vi.advanceTimersByTimeAsync(30000);
      await rejected;
      expect(socket.terminate).toHaveBeenCalledOnce();
    },
  );

  it("aborts while preparing keywords without opening a connection", async () => {
    const factory = vi.fn();
    const transcription = startScribeTranscription({ apiKey: "key", webSocketFactory: factory });
    transcription.abort();
    await expect(transcription.finish()).rejects.toThrow();
    expect(factory).not.toHaveBeenCalled();
  });
});

describe("speech cleanup", () => {
  it("makes no call for off or empty speech", async () => {
    const fetchImpl = vi.fn();
    for (const [style, transcript] of [
      ["off", "hello"],
      ["default", ""],
    ]) {
      expect(await cleanupSpeechTranscript({ style, transcript, vocabulary: [], fetchImpl })).toBe(
        transcript,
      );
    }
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("cleans the whole transcript with Terra and sends transcript and vocabulary as data", async () => {
    const fetchImpl = vi.fn(async () =>
      json({
        status: "completed",
        output: [
          { type: "reasoning" },
          { type: "message", content: [{ type: "output_text", text: "Korjaa Tau. Use 5 tests." }] },
        ],
      }),
    );
    expect(
      await cleanupSpeechTranscript({
        transcript: "korjaa Tau use five tests",
        style: "default",
        apiKey: "key",
        vocabulary: ["Tau"],
        fetchImpl,
      }),
    ).toBe("Korjaa Tau. Use 5 tests.");
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.model).toBe("gpt-6.1-terra");
    expect(JSON.parse(body.input)).toEqual({
      transcript: "korjaa Tau use five tests",
      vocabulary: ["Tau"],
    });
    expect(body.store).toBe(false);
  });

  it.each([
    { status: "incomplete", output: [] },
    { status: "completed", output: [] },
  ])("rejects incomplete or empty cleanup", async (payload) => {
    await expect(
      cleanupSpeechTranscript({
        transcript: "keep me",
        style: "default",
        apiKey: "key",
        vocabulary: [],
        fetchImpl: async () => json(payload),
      }),
    ).rejects.toThrow();
  });
});
