import { describe, expect, it, vi } from "vitest";
import { streamGeminiSpeechAudio } from "../dist/core/utils/gemini_speech.js";

describe("gemini speech", () => {
  it("rewrites text, requests TTS audio, and returns a wav buffer", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [{ text: "Use src slash app dot t s, line 42, for the fix." }],
                },
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [
                    {
                      inlineData: {
                        data: Buffer.from([1, 2, 3, 4]).toString("base64"),
                      },
                    },
                  ],
                },
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );

    const stages = [];
    const chunkProgress = [];
    const chunks = [];
    for await (const chunk of streamGeminiSpeechAudio({
      apiKey: "gemini-key",
      sourceText: "Use src/app.ts:42 for the fix.",
      fetchImpl: fetchMock,
      onStageChange: (stage) => {
        stages.push(stage);
      },
      onChunkProgress: (progress) => {
        chunkProgress.push(progress);
      },
    })) {
      chunks.push(chunk);
    }

    expect(chunks).toHaveLength(1);
    const result = chunks[0];
    expect(stages).toEqual(["rewriting", "generating"]);
    expect(chunkProgress).toEqual([
      { ready: 0, total: 1 },
      { ready: 1, total: 1 },
    ]);
    expect(result.mimeType).toBe("audio/wav");
    expect(result.audio.subarray(0, 4).toString()).toBe("RIFF");
    expect(result.audio.subarray(8, 12).toString()).toBe("WAVE");

    expect(fetchMock).toHaveBeenCalledTimes(2);

    const rewriteRequest = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(rewriteRequest.contents[0].parts[0].text).toContain(
      "Rewrite the assistant response below so it sounds natural when spoken aloud.",
    );
    expect(rewriteRequest.contents[0].parts[0].text).toContain("Use src/app.ts:42 for the fix.");
    expect(rewriteRequest.contents[0].parts[0].text).toContain(
      "Keep prose unchanged. Only rewrite spans that are awkward to say aloud",
    );
    expect(rewriteRequest.contents[0].parts[0].text).toContain(
      "Do not drop, condense, or add content.",
    );
    expect(rewriteRequest.contents[0].parts[0].text).toContain(
      "Things that typically need rewriting: file paths, shell commands, code identifiers",
    );
    expect(rewriteRequest.contents[0].parts[0].text).toContain(
      "Do not add location detail that was not in the original",
    );
    expect(rewriteRequest.contents[0].parts[0].text).toContain(
      "Say code identifiers and version strings as natural words",
    );
    expect(rewriteRequest.contents[0].parts[0].text).toContain("Examples of good rewrites:");
    expect(rewriteRequest.contents[0].parts[0].text).toContain(
      'gemini_speech.ts:372` → "gemini_speech.ts, line 372"',
    );
    expect(rewriteRequest.contents[0].parts[0].text).toContain('compaction.ts` → "compaction.ts"');
    expect(rewriteRequest.generationConfig.thinkingConfig.thinkingLevel).toBe("minimal");

    const ttsRequest = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(ttsRequest.generationConfig.responseModalities).toEqual(["AUDIO"]);
    expect(ttsRequest.generationConfig.temperature).toBe(1);
    expect(ttsRequest.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName).toBe(
      "Despina",
    );
    expect(ttsRequest.contents[0].parts[0].text).toContain("### TRANSCRIPT");
    expect(ttsRequest.contents[0].parts[0].text).toContain(
      "Use src slash app dot t s, line 42, for the fix.",
    );
  });

  it("retries transient TTS failures", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [{ text: "Spoken version." }],
                },
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            error: {
              message: "internal error",
            },
          }),
          { status: 500, headers: { "Content-Type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [
                    {
                      inlineData: {
                        data: Buffer.from([5, 6]).toString("base64"),
                      },
                    },
                  ],
                },
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      );

    const chunks = [];
    for await (const chunk of streamGeminiSpeechAudio({
      apiKey: "gemini-key",
      sourceText: "Original text.",
      fetchImpl: fetchMock,
      maxTtsAttempts: 2,
    })) {
      chunks.push(chunk);
    }

    expect(chunks).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
