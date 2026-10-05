import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { createSpeechToTextTranscription } from "../dist/core/utils/speech_to_text.js";

describe("speech-to-text transcription", () => {
  it("returns the live transcript without a quiet delay when the final activity covers the recording", async () => {
    vi.useFakeTimers();
    const socket = new EventEmitter();
    socket.send = vi.fn((_data, callback) => callback?.());
    socket.close = vi.fn();
    socket.terminate = vi.fn();
    const transcription = createSpeechToTextTranscription({
      mode: "streaming",
      apiKey: "key",
      deps: { webSocketFactory: () => socket },
    });
    const emit = (event) => socket.emit("message", JSON.stringify(event));
    try {
      socket.emit("open");
      await vi.advanceTimersByTimeAsync(0);
      emit({ setupComplete: {} });
      transcription.appendAudio(Buffer.alloc(32000));
      emit({ serverContent: { interimInputTranscription: { text: "the last" } } });
      const completion = transcription.finish({ audio: Buffer.alloc(32000) });
      await vi.advanceTimersByTimeAsync(0);
      emit({ serverContent: { inputTranscription: { text: "the last word" } } });
      emit({ serverContent: { generationComplete: true } });
      emit({ voiceActivity: { type: "ACTIVITY_END", audioOffset: "1s" } });
      expect(socket.close).toHaveBeenCalledTimes(1);
      await expect(completion).resolves.toBe("the last word");
    } finally {
      transcription.abort();
      vi.useRealTimers();
    }
  });

  it("aborts an active Gemini file upload", async () => {
    let requestSignal;
    const fetchMock = vi.fn(
      async (_url, options) =>
        await new Promise((_resolve, reject) => {
          requestSignal = options.signal;
          options.signal.addEventListener("abort", () => reject(options.signal.reason), {
            once: true,
          });
        }),
    );
    const transcription = createSpeechToTextTranscription({
      mode: "file",
      apiKey: "provider-key",
      deps: { fetchImpl: fetchMock },
    });

    const result = transcription.finish({ audio: Buffer.from("audio") });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    transcription.abort();

    expect(requestSignal.aborted).toBe(true);
    await expect(result).rejects.toThrow("speech transcription was aborted");
  });
});
