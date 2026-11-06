import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import { createSpeechToTextTranscription } from "../dist/core/utils/speech_to_text.js";
import { composeSpeechVocabulary } from "../dist/core/utils/speech_to_text_keywords.js";
import { createListenTranscription } from "../dist/tui/listen_capture.js";

describe("composeSpeechVocabulary", () => {
  it("keeps session terms first and removes duplicates", () => {
    expect(composeSpeechVocabulary(["Tau", " Shared "], ["Shared", "Personal"])).toEqual([
      "Tau",
      "Shared",
      "Personal",
    ]);
  });

  it("gives session terms priority under the term limit", () => {
    const sessionTerms = Array.from({ length: 1000 }, (_, index) => `session-${index}`);
    expect(composeSpeechVocabulary(sessionTerms, ["Personal"])).toEqual(sessionTerms);
  });
});

describe("speech-to-text transcription", () => {
  it("returns the live transcript after draining the final Scribe segment", async () => {
    vi.useFakeTimers();
    const socket = new EventEmitter();
    socket.send = vi.fn((_data, callback) => callback?.());
    socket.close = vi.fn();
    socket.terminate = vi.fn();
    const factory = vi.fn(() => socket);
    const transcription = createListenTranscription({
      mode: "streaming",
      credentials: { elevenLabsApiKey: "key" },
      vocabulary: ["Tau"],
      speechToTextDeps: { webSocketFactory: factory },
    });
    const emit = (event) => socket.emit("message", JSON.stringify(event));
    try {
      socket.emit("open");
      await vi.advanceTimersByTimeAsync(0);
      expect(new URL(factory.mock.calls[0][0]).searchParams.getAll("keyterms")).toEqual(["Tau"]);
      emit({ message_type: "session_started" });
      transcription.appendAudio(Buffer.alloc(32000));
      emit({ message_type: "partial_transcript", text: "the last" });
      const completion = transcription.finish({ audio: Buffer.alloc(32000) });
      await vi.advanceTimersByTimeAsync(0);
      emit({ message_type: "committed_transcript", text: "the last word" });
      await vi.advanceTimersByTimeAsync(2000);
      expect(socket.close).toHaveBeenCalledTimes(1);
      await expect(completion).resolves.toBe("the last word");
    } finally {
      transcription.abort();
      vi.useRealTimers();
    }
  });

  it("aborts an active Scribe file request", async () => {
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
