import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
  startOpenAITranscription,
  transcribeOpenAIAudio,
} from "../dist/core/utils/openai_transcription.js";

class FakeOpenAISocket extends EventEmitter {
  sent = [];
  closed = false;
  terminated = false;

  constructor(transcript = "streamed transcript") {
    super();
    this.transcript = transcript;
  }

  open() {
    this.emit("open");
  }

  send(data, callback) {
    const event = JSON.parse(data);
    this.sent.push(event);
    callback?.();

    if (event.type === "session.update") {
      queueMicrotask(() =>
        this.emit("message", Buffer.from(JSON.stringify({ type: "session.updated" }))),
      );
    }
    if (event.type === "input_audio_buffer.commit") {
      queueMicrotask(() =>
        this.emit(
          "message",
          Buffer.from(
            JSON.stringify({
              type: "conversation.item.input_audio_transcription.completed",
              item_id: "item-1",
              content_index: 0,
              transcript: this.transcript,
            }),
          ),
        ),
      );
    }
  }

  close() {
    this.closed = true;
  }

  terminate() {
    this.terminated = true;
  }
}

function createWebSocketHarness(transcript) {
  const socket = new FakeOpenAISocket(transcript);
  const factory = vi.fn((_url, _options) => {
    queueMicrotask(() => socket.open());
    return socket;
  });
  return { socket, factory };
}

function successfulSpawnResult() {
  return {
    stdout: "",
    stderr: "",
    output: undefined,
    exitCode: 0,
    captureLimitExceeded: false,
    timedOut: false,
    aborted: false,
    closeSignal: null,
  };
}

describe("OpenAI transcription", () => {
  it("streams live PCM and returns only the completed transcript", async () => {
    const harness = createWebSocketHarness("final transcript");
    const transcription = startOpenAITranscription({
      apiKey: "openai-key",
      context: {
        messages: [{ role: "assistant", text: "The repository is called Tau." }],
      },
      webSocketFactory: harness.factory,
    });

    transcription.appendAudio(Buffer.from([1, 2, 3, 4]));
    const transcript = await transcription.finish();

    expect(transcript).toBe("final transcript");
    expect(harness.factory).toHaveBeenCalledWith(
      "wss://api.openai.com/v1/realtime?intent=transcription",
      { headers: { Authorization: "Bearer openai-key" } },
    );
    expect(harness.socket.sent[0]).toMatchObject({
      type: "session.update",
      session: {
        type: "transcription",
        audio: {
          input: {
            format: { type: "audio/pcm", rate: 24000 },
            transcription: {
              model: "gpt-live-transcribe",
              delay: "medium",
              prompt: expect.stringContaining("The repository is called Tau."),
            },
            turn_detection: null,
          },
        },
      },
    });
    expect(harness.socket.sent.slice(1)).toEqual([
      {
        type: "input_audio_buffer.append",
        audio: Buffer.from([1, 2, 3, 4]).toString("base64"),
      },
      { type: "input_audio_buffer.commit" },
    ]);
    expect(harness.socket.closed).toBe(true);
  });

  it("uploads completed audio through OpenAI file transcription", async () => {
    const audio = Buffer.from("encoded audio");
    const pcm = Buffer.from([5, 6, 7, 8]);
    const spawnImpl = vi.fn(async (_command, _args, options) => {
      const stdout = new EventEmitter();
      options.onSpawn({ stdout });
      stdout.emit("data", pcm);
      return successfulSpawnResult();
    });
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ text: "file transcript", languages: [{ code: "en" }] })),
    );

    const transcript = await transcribeOpenAIAudio({
      apiKey: "openai-key",
      audio,
      context: {
        messages: [{ role: "user", text: "We are discussing Tau." }],
      },
      fetchImpl,
      spawnImpl,
    });

    expect(transcript).toBe("file transcript");
    expect(spawnImpl).toHaveBeenCalledWith(
      "ffmpeg",
      expect.arrayContaining(["-i", "pipe:0", "-ar", "16000", "-f", "s16le", "pipe:1"]),
      expect.objectContaining({
        input: audio,
        captureOutput: "stderr",
        stdio: ["pipe", "pipe", "pipe"],
      }),
    );
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://api.openai.com/v1/audio/transcriptions",
      expect.objectContaining({
        method: "POST",
        headers: { Authorization: "Bearer openai-key" },
        body: expect.any(FormData),
      }),
    );
    const form = fetchImpl.mock.calls[0][1].body;
    expect(form.get("model")).toBe("gpt-transcribe");
    expect(form.get("prompt")).toContain("We are discussing Tau.");
    const file = form.get("file");
    expect(file.name).toBe("speech.wav");
    expect(file.type).toBe("audio/wav");
    const wav = Buffer.from(await file.arrayBuffer());
    expect(wav.subarray(0, 4).toString("ascii")).toBe("RIFF");
    expect(wav.subarray(8, 12).toString("ascii")).toBe("WAVE");
    expect(wav.readUInt32LE(24)).toBe(16_000);
    expect(wav.subarray(44)).toEqual(pcm);
  });

  it("cancels completed-audio decoding when the owner aborts", async () => {
    const abortController = new AbortController();
    let decoderSignal;
    const spawnImpl = vi.fn(async (_command, _args, options) => {
      decoderSignal = options.signal;
      options.onSpawn({ stdout: new EventEmitter() });
      return await new Promise((resolve) => {
        options.signal.addEventListener("abort", () => {
          resolve({ ...successfulSpawnResult(), aborted: true });
        });
      });
    });

    const transcription = transcribeOpenAIAudio({
      apiKey: "openai-key",
      audio: Buffer.from("encoded audio"),
      signal: abortController.signal,
      fetchImpl: vi.fn(),
      spawnImpl,
    });
    await vi.waitFor(() => expect(spawnImpl).toHaveBeenCalledOnce());

    abortController.abort(new Error("owner stopped"));

    await expect(transcription).rejects.toThrow("owner stopped");
    expect(decoderSignal.aborted).toBe(true);
  });

  it("rejects decoded audio longer than five minutes", async () => {
    const spawnImpl = vi.fn(async (_command, _args, options) => {
      const stdout = new EventEmitter();
      options.onSpawn({ stdout });
      const completion = new Promise((resolve) => {
        options.signal.addEventListener("abort", () => {
          resolve({ ...successfulSpawnResult(), aborted: true });
        });
      });
      stdout.emit("data", Buffer.alloc(16_000 * 2 * 300 + 1));
      return await completion;
    });

    await expect(
      transcribeOpenAIAudio({
        apiKey: "openai-key",
        audio: Buffer.from("encoded audio"),
        fetchImpl: vi.fn(),
        spawnImpl,
      }),
    ).rejects.toThrow("audio exceeds the five-minute OpenAI transcription limit");
  });

  it("reports OpenAI file transcription errors", async () => {
    const spawnImpl = vi.fn(async (_command, _args, options) => {
      const stdout = new EventEmitter();
      options.onSpawn({ stdout });
      stdout.emit("data", Buffer.from([1, 2]));
      return successfulSpawnResult();
    });
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: { message: "invalid audio" } }), { status: 400 }),
    );

    await expect(
      transcribeOpenAIAudio({
        apiKey: "openai-key",
        audio: Buffer.from("encoded audio"),
        fetchImpl,
        spawnImpl,
      }),
    ).rejects.toThrow("invalid audio");
  });

  it("rejects an empty file transcript", async () => {
    const spawnImpl = vi.fn(async (_command, _args, options) => {
      const stdout = new EventEmitter();
      options.onSpawn({ stdout });
      stdout.emit("data", Buffer.from([1, 2]));
      return successfulSpawnResult();
    });

    await expect(
      transcribeOpenAIAudio({
        apiKey: "openai-key",
        audio: Buffer.from("encoded audio"),
        fetchImpl: vi.fn(async () => new Response(JSON.stringify({ text: "" }))),
        spawnImpl,
      }),
    ).rejects.toThrow("transcription result was empty or malformed");
  });

  it("rejects an empty completed realtime transcript", async () => {
    const socket = new FakeOpenAISocket();
    socket.send = function send(data, callback) {
      const event = JSON.parse(data);
      this.sent.push(event);
      callback?.();
      if (event.type === "session.update") {
        queueMicrotask(() => this.emit("message", JSON.stringify({ type: "session.updated" })));
      }
      if (event.type === "input_audio_buffer.commit") {
        queueMicrotask(() =>
          this.emit(
            "message",
            JSON.stringify({
              type: "conversation.item.input_audio_transcription.completed",
              transcript: "",
            }),
          ),
        );
      }
    };
    const factory = () => {
      queueMicrotask(() => socket.open());
      return socket;
    };
    const transcription = startOpenAITranscription({
      apiKey: "openai-key",
      webSocketFactory: factory,
    });
    transcription.appendAudio(Buffer.from([1, 2]));

    await expect(transcription.finish()).rejects.toThrow(
      "transcription result was empty or malformed",
    );
    expect(socket.terminated).toBe(true);
  });
});
