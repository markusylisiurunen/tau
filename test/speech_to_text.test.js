import { describe, expect, it, vi } from "vitest";
import { createSpeechToTextTranscription } from "../dist/core/utils/speech_to_text.js";

describe("speech-to-text transcription", () => {
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
      provider: "gemini",
      mode: "file",
      apiKey: "provider-key",
      deps: { fetchImpl: fetchMock },
    });

    const result = transcription.finish({
      audio: Buffer.from("audio"),
      durationMs: 1_000,
    });
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    transcription.abort();

    expect(requestSignal.aborted).toBe(true);
    await expect(result).rejects.toThrow("speech transcription was aborted");
  });

  it("rejects completed audio longer than the client limit before provider work", async () => {
    const fetchMock = vi.fn();
    const transcription = createSpeechToTextTranscription({
      provider: "gemini",
      mode: "file",
      apiKey: "provider-key",
      deps: { fetchImpl: fetchMock },
    });

    await expect(
      transcription.finish({
        audio: Buffer.from("audio"),
        durationMs: 20 * 60_000 + 1,
      }),
    ).rejects.toThrow("audio exceeds the 20-minute speech-to-text limit");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
