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
    const transcription = await startOpenAITranscription({
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
              delay: "low",
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

  it("decodes completed audio to PCM before replaying it through a realtime session", async () => {
    const harness = createWebSocketHarness("telegram transcript");
    const audio = Buffer.from("encoded audio");
    const pcm = Buffer.from([5, 6, 7, 8]);
    const spawnImpl = vi.fn(async (_command, _args, options) => {
      const stdout = new EventEmitter();
      options.onSpawn({ stdout });
      stdout.emit("data", pcm);
      return successfulSpawnResult();
    });

    const transcript = await transcribeOpenAIAudio({
      apiKey: "openai-key",
      audio,
      webSocketFactory: harness.factory,
      spawnImpl,
    });

    expect(transcript).toBe("telegram transcript");
    expect(spawnImpl).toHaveBeenCalledWith(
      "ffmpeg",
      expect.arrayContaining(["-i", "pipe:0", "-ar", "24000", "-f", "s16le", "pipe:1"]),
      expect.objectContaining({
        input: audio,
        captureOutput: "stderr",
        stdio: ["pipe", "pipe", "pipe"],
      }),
    );
    expect(harness.socket.sent).toContainEqual({
      type: "input_audio_buffer.append",
      audio: pcm.toString("base64"),
    });
  });

  it("rejects an empty completed transcript", async () => {
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
    const transcription = await startOpenAITranscription({
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
