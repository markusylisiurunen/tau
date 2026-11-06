import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  startScribeTranscription,
  transcribeScribeAudio,
} from "../dist/core/utils/scribe_transcription.js";
import {
  cleanupSpeechTranscript,
  prepareSpeechCleanup,
} from "../dist/core/utils/speech_cleanup.js";
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
  await vi.advanceTimersByTimeAsync(500);
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
    expect(request.body.get("no_verbatim")).toBe("false");
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
    expect(socket.close).not.toHaveBeenCalled();
    emit({ message_type: "partial_transcript", text: "" });
    await vi.advanceTimersByTimeAsync(1500);
    expect(socket.close).not.toHaveBeenCalled();
    emit({ message_type: "committed_transcript", text: "" });
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

  it("paces delayed startup and live audio at 2x, then commits after draining all audio", async () => {
    vi.useFakeTimers();
    const keywords = Promise.withResolvers();
    const socket = new EventEmitter();
    const sent = [];
    socket.send = vi.fn((data, callback) => {
      sent.push({ time: Date.now(), ...JSON.parse(data) });
      callback?.();
    });
    socket.close = vi.fn();
    socket.terminate = vi.fn();
    const factory = vi.fn(() => socket);
    const transcription = startScribeTranscription({
      apiKey: "key",
      openAIApiKey: "openai",
      context: { messages: [{ role: "user", text: "context" }] },
      fetchImpl: () => keywords.promise,
      webSocketFactory: factory,
    });
    const startup = Buffer.alloc(160_000, 1);
    // Pipe reads may split samples and need not match the outbound chunk size.
    transcription.appendAudio(startup.subarray(0, 3));
    transcription.appendAudio(startup.subarray(3));
    await vi.advanceTimersByTimeAsync(5000);
    expect(factory).not.toHaveBeenCalled();
    keywords.resolve(json({}, 503));
    await vi.advanceTimersByTimeAsync(0);
    socket.emit("message", JSON.stringify({ message_type: "session_started" }));
    expect(sent).toHaveLength(1);
    const liveAudio = [];
    for (let i = 0; i < 50; i++) {
      const audio = Buffer.alloc(3200, i + 2);
      liveAudio.push(audio);
      transcription.appendAudio(audio);
      await vi.advanceTimersByTimeAsync(100);
    }
    // Ten seconds of speech have been sent in five seconds; the backlog is gone.
    expect(sent).toHaveLength(50);
    expect(sent.every((event) => !event.commit)).toBe(true);
    const tail = Buffer.alloc(42, 99);
    transcription.appendAudio(tail);
    const result = transcription.finish();
    await vi.advanceTimersByTimeAsync(1100);
    expect(sent.filter((event) => event.commit)).toEqual([sent.at(-1)]);
    expect(sent.at(-1).commit).toBe(true);
    for (let i = 1; i < sent.length; i++) {
      expect(sent[i].time - sent[i - 1].time).toBeGreaterThanOrEqual(100);
    }
    const chunks = sent.map((event) => Buffer.from(event.audio_base_64, "base64"));
    expect(chunks.every((audio) => audio.length <= 6400)).toBe(true);
    expect(Buffer.concat(chunks)).toEqual(Buffer.concat([startup, ...liveAudio, tail]));
    socket.emit("message", JSON.stringify({ message_type: "committed_transcript", text: "done" }));
    await vi.advanceTimersByTimeAsync(2000);
    await expect(result).resolves.toBe("done");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("starts the finalization deadline only after a long queue has drained", async () => {
    const { transcription, socket, emit } = await live();
    transcription.appendAudio(Buffer.alloc(32_000 * 70));
    const result = transcription.finish();
    await vi.advanceTimersByTimeAsync(30_000);
    expect(socket.terminate).not.toHaveBeenCalled();
    expect(JSON.parse(socket.send.mock.calls.at(-1)[0]).commit).toBe(false);
    emit({ message_type: "committed_transcript", text: "first" });
    await vi.advanceTimersByTimeAsync(6000);
    expect(socket.close).not.toHaveBeenCalled();
    expect(JSON.parse(socket.send.mock.calls.at(-1)[0]).commit).toBe(true);
    emit({ message_type: "committed_transcript", text: "last" });
    await vi.advanceTimersByTimeAsync(2000);
    await expect(result).resolves.toBe("first last");
  });

  it.each(["abort", "send-error"])("stops queued audio on %s", async (failure) => {
    const { transcription, socket } = await live();
    transcription.appendAudio(Buffer.alloc(320_000));
    const result = transcription.finish();
    const rejected = expect(result).rejects.toThrow();
    if (failure === "abort") transcription.abort();
    else socket.send.mockImplementation((_data, callback) => callback(new Error("send failed")));
    await vi.advanceTimersByTimeAsync(100);
    await rejected;
    const sends = socket.send.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(socket.send).toHaveBeenCalledTimes(sends);
    expect(socket.terminate).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
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

  it("buffers startup audio and finishes on the first commit after the final request", async () => {
    const { transcription, socket, factory, emit, onProgress } = await live();
    const url = new URL(factory.mock.calls[0][0]);
    expect(url.searchParams.get("no_verbatim")).toBe("false");
    expect(url.searchParams.get("commit_strategy")).toBe("vad");
    expect(url.searchParams.getAll("keyterms")).toEqual(["Tau"]);
    expect(factory.mock.calls[0][1]).toEqual({ headers: { "xi-api-key": "key" } });
    expect(JSON.parse(socket.send.mock.calls[0][0]).audio_base_64).toBe(
      Buffer.alloc(6400).toString("base64"),
    );
    emit({ message_type: "partial_transcript", text: "first draft" });
    emit({ message_type: "partial_transcript", text: "first" });
    emit({ message_type: "committed_transcript", text: "first" });
    const result = transcription.finish();
    await vi.advanceTimersByTimeAsync(0);
    expect(JSON.parse(socket.send.mock.calls.at(-1)[0])).toEqual({
      message_type: "input_audio_chunk",
      audio_base_64: "",
      sample_rate: 16000,
      commit: true,
    });
    emit({ message_type: "partial_transcript", text: "second draft" });
    expect(socket.close).not.toHaveBeenCalled();
    emit({ message_type: "committed_transcript", text: "second" });
    await expect(result).resolves.toBe("first second");
    emit({ message_type: "partial_transcript", text: "late" });
    emit({ message_type: "committed_transcript", text: "late segment" });
    expect(onProgress.mock.calls.map(([text]) => text)).toEqual([
      "first draft",
      "first",
      "first",
      "first second draft",
      "first second",
    ]);
    expect(socket.close).toHaveBeenCalledOnce();
  });

  it.each(["connection-loss", "abort", "malformed", "provider-error"])(
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
      await rejected;
      expect(socket.terminate).toHaveBeenCalledOnce();
    },
  );

  it.each([
    ["", "", ""],
    ["first", "", "first"],
    ["", "partial", "partial"],
    ["first", "partial", "first partial"],
  ])(
    "returns available text after two seconds without a final commit: %j %j",
    async (committed, partial, expected) => {
      const { transcription, socket, emit } = await live();
      if (committed) emit({ message_type: "committed_transcript", text: committed });
      const result = transcription.finish();
      await vi.advanceTimersByTimeAsync(0);
      await vi.advanceTimersByTimeAsync(1500);
      emit({ message_type: "partial_transcript", text: partial });
      await vi.advanceTimersByTimeAsync(499);
      expect(socket.close).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1);
      await expect(result).resolves.toBe(expected);
      expect(socket.close).toHaveBeenCalledOnce();
      expect(socket.terminate).not.toHaveBeenCalled();
      expect(vi.getTimerCount()).toBe(0);
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

describe("prepared speech cleanup", () => {
  function prepare() {
    const socket = new EventEmitter();
    socket.send = vi.fn((_data, callback) => callback?.());
    socket.close = vi.fn();
    socket.terminate = vi.fn();
    const factory = vi.fn(() => socket);
    const prepared = prepareSpeechCleanup({
      style: "default",
      apiKey: "secret",
      webSocketFactory: factory,
    });
    const emit = (event) => socket.emit("message", JSON.stringify(event));
    const warm = () =>
      emit({
        type: "response.completed",
        response: { id: "warm", status: "completed", output: [] },
      });
    return { socket, prepared, emit, warm, factory };
  }

  it("prepares instructions without generating and continues on the same socket", async () => {
    const { socket, prepared, emit, warm, factory } = prepare();
    const result = prepared.finish({ transcript: "original", vocabulary: ["Tau"] });
    expect(socket.send).not.toHaveBeenCalled();
    socket.emit("open");
    const warmRequest = JSON.parse(socket.send.mock.calls[0][0]);
    expect(warmRequest).toMatchObject({
      type: "response.create",
      generate: false,
      input: [],
      store: false,
    });
    warm();
    await vi.waitFor(() => expect(socket.send).toHaveBeenCalledTimes(2));
    const finalRequest = JSON.parse(socket.send.mock.calls[1][0]);
    expect(finalRequest).toMatchObject({
      previous_response_id: "warm",
      instructions: warmRequest.instructions,
      store: false,
    });
    expect(finalRequest).not.toHaveProperty("generate");
    expect(JSON.parse(finalRequest.input)).toEqual({ transcript: "original", vocabulary: ["Tau"] });
    emit({
      type: "response.completed",
      response: {
        status: "completed",
        output: [{ type: "message", content: [{ type: "output_text", text: "Cleaned." }] }],
      },
    });
    await expect(result).resolves.toBe("Cleaned.");
    prepared.dispose();
    expect(factory).toHaveBeenCalledOnce();
    expect(socket.close).toHaveBeenCalledOnce();
    expect(socket.terminate).not.toHaveBeenCalled();
  });

  it.each(["warming", "ready", "generating"])("cancels cleanup while %s", async (phase) => {
    const { socket, prepared, warm, emit } = prepare();
    socket.emit("open");
    if (phase !== "warming") warm();
    const controller = new AbortController();
    const result = prepared.finish({
      transcript: "original",
      vocabulary: [],
      signal: controller.signal,
    });
    const rejected = expect(result).rejects.toThrow();
    if (phase === "generating")
      await vi.waitFor(() => expect(socket.send).toHaveBeenCalledTimes(2));
    controller.abort();
    emit({ type: "response.completed", response: { status: "completed", output: [] } });
    await rejected;
    expect(socket.terminate).toHaveBeenCalledOnce();
    if (phase !== "generating") expect(socket.send).toHaveBeenCalledTimes(1);
  });

  it.each(["timeout", "close", "error", "incomplete", "malformed", "dispose"])(
    "rejects %s without generating after failed warmup",
    async (failure) => {
      vi.useFakeTimers();
      const { socket, prepared, emit } = prepare();
      socket.emit("open");
      if (failure === "timeout") await vi.advanceTimersByTimeAsync(30000);
      else if (failure === "close") socket.emit("close", 1006, Buffer.alloc(0));
      else if (failure === "error") emit({ type: "error", error: { message: "secret" } });
      else if (failure === "incomplete") emit({ type: "response.incomplete" });
      else if (failure === "malformed") socket.emit("message", "{");
      else prepared.dispose();
      await expect(prepared.finish({ transcript: "original", vocabulary: [] })).rejects.toThrow();
      expect(socket.send).toHaveBeenCalledTimes(1);
      expect(socket.terminate).toHaveBeenCalledOnce();
    },
  );

  it("bounds generation independently of recording duration", async () => {
    vi.useFakeTimers();
    const { socket, prepared, warm } = prepare();
    socket.emit("open");
    warm();
    await vi.advanceTimersByTimeAsync(60000);
    expect(socket.terminate).not.toHaveBeenCalled();
    const result = prepared.finish({ transcript: "original", vocabulary: [] });
    const rejected = expect(result).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(30000);
    await rejected;
    expect(socket.terminate).toHaveBeenCalledOnce();
  });
});
