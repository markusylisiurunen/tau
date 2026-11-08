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

  it("redacts credentials in file API diagnostics", async () => {
    await expect(
      transcribeScribeAudio({
        apiKey: "secret-key",
        audio: Buffer.from("audio"),
        fetchImpl: async () => json({ detail: "invalid key secret-key" }, 401),
      }),
    ).rejects.toThrow("invalid key [redacted]");
  });

  it("redacts credentials from provider error events", async () => {
    const { transcription, emit } = await live();
    const result = transcription.finish();
    const rejected = expect(result).rejects.toThrow("invalid credential [redacted]");
    emit({ message_type: "auth_error", error: "invalid credential key" });
    await rejected;
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

  it("stops queued audio and timers after a send failure", async () => {
    const { transcription, socket } = await live();
    transcription.appendAudio(Buffer.alloc(320_000));
    const result = transcription.finish();
    const rejected = expect(result).rejects.toThrow();
    socket.send.mockImplementation((_data, callback) => callback(new Error("send failed")));
    await vi.advanceTimersByTimeAsync(100);
    await rejected;
    const sends = socket.send.mock.calls.length;
    await vi.advanceTimersByTimeAsync(60_000);
    expect(socket.send).toHaveBeenCalledTimes(sends);
    expect(socket.terminate).toHaveBeenCalledOnce();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects a partial transcript after connection loss", async () => {
    const { transcription, socket, emit } = await live();
    emit({ message_type: "partial_transcript", text: "unfinished" });
    const controller = new AbortController();
    const result = transcription.finish({ signal: controller.signal });
    const rejected = expect(result).rejects.toThrow();
    await vi.advanceTimersByTimeAsync(0);
    socket.emit("close", 1006, Buffer.alloc(0));
    await rejected;
    expect(socket.terminate).toHaveBeenCalledOnce();
  });

  it("returns committed and partial text after the final-commit deadline", async () => {
    const { transcription, socket, emit } = await live();
    emit({ message_type: "committed_transcript", text: "first" });
    const result = transcription.finish();
    await vi.advanceTimersByTimeAsync(0);
    await vi.advanceTimersByTimeAsync(1500);
    emit({ message_type: "partial_transcript", text: "partial" });
    await vi.advanceTimersByTimeAsync(499);
    expect(socket.close).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    await expect(result).resolves.toBe("first partial");
    expect(socket.close).toHaveBeenCalledOnce();
    expect(socket.terminate).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it("aborts while preparing keywords without opening a connection", async () => {
    const factory = vi.fn();
    const transcription = startScribeTranscription({ apiKey: "key", webSocketFactory: factory });
    transcription.abort();
    await expect(transcription.finish()).rejects.toThrow();
    expect(factory).not.toHaveBeenCalled();
  });
});

describe("speech cleanup", () => {
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
        context: { messages: [{ role: "user", text: "We are fixing Tau." }] },
        fetchImpl,
      }),
    ).toBe("Korjaa Tau. Use 5 tests.");
    const body = JSON.parse(fetchImpl.mock.calls[0][1].body);
    expect(body.model).toBe("gpt-6.1-terra");
    expect(JSON.parse(body.input)).toEqual({
      transcript: "korjaa Tau use five tests",
      vocabulary: ["Tau"],
      context: "user: We are fixing Tau.",
    });
    expect(body.store).toBe(false);
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
    const result = prepared.finish({
      transcript: "original",
      vocabulary: ["Tau"],
      context: { messages: [{ role: "assistant", text: "Use Scribe." }] },
    });
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
    expect(JSON.parse(finalRequest.input)).toEqual({
      transcript: "original",
      vocabulary: ["Tau"],
      context: "assistant: Use Scribe.",
    });
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

  it("cancels active cleanup and ignores its late response", async () => {
    const { socket, prepared, warm, emit } = prepare();
    socket.emit("open");
    warm();
    const controller = new AbortController();
    const result = prepared.finish({
      transcript: "original",
      vocabulary: [],
      signal: controller.signal,
    });
    const rejected = expect(result).rejects.toThrow();
    await vi.waitFor(() => expect(socket.send).toHaveBeenCalledTimes(2));
    controller.abort();
    emit({ type: "response.completed", response: { status: "completed", output: [] } });
    await rejected;
    expect(socket.terminate).toHaveBeenCalledOnce();
    expect(socket.send).toHaveBeenCalledTimes(2);
  });

  it("rejects cleanup after its warmup deadline without generating", async () => {
    vi.useFakeTimers();
    const { socket, prepared } = prepare();
    socket.emit("open");
    await vi.advanceTimersByTimeAsync(30000);
    await expect(prepared.finish({ transcript: "original", vocabulary: [] })).rejects.toThrow();
    expect(socket.send).toHaveBeenCalledTimes(1);
    expect(socket.terminate).toHaveBeenCalledOnce();
  });

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
