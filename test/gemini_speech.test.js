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
      deliveryMode: "progressive",
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
    expect(fetchMock.mock.calls[0][0]).toContain(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.6-flash:generateContent",
    );

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
      "Remove formatting. Convert headings, lists, tables, and code blocks into plain spoken prose.",
    );
    expect(rewriteRequest.contents[0].parts[0].text).toContain(
      "Do not add location detail that was not in the original",
    );
    expect(rewriteRequest.contents[0].parts[0].text).toContain(
      "Preserve numbers exactly as written",
    );
    expect(rewriteRequest.contents[0].parts[0].text).toContain(
      "Preserve established technical names, acronyms, initialisms, commands, program names",
    );
    expect(rewriteRequest.contents[0].parts[0].text).toContain(
      '`24 kHz PCM with ffmpeg` → "24 kHz PCM with ffmpeg"',
    );
    expect(rewriteRequest.contents[0].parts[0].text).toContain("Examples of good rewrites:");
    expect(rewriteRequest.contents[0].parts[0].text).toContain(
      'gemini_speech.ts:372` → "gemini_speech.ts, line 372"',
    );
    expect(rewriteRequest.contents[0].parts[0].text).toContain('compaction.ts` → "compaction.ts"');
    expect(rewriteRequest.generationConfig.thinkingConfig.thinkingLevel).toBe("minimal");

    const ttsRequest = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(ttsRequest.generationConfig.responseModalities).toEqual(["AUDIO"]);
    expect(ttsRequest.generationConfig.temperature).toBeUndefined();
    expect(ttsRequest.generationConfig.maxOutputTokens).toBe(1024);
    expect(ttsRequest.generationConfig.speechConfig.voiceConfig.prebuiltVoiceConfig.voiceName).toBe(
      "Despina",
    );
    expect(ttsRequest.contents[0].parts[0].text).toContain("### TRANSCRIPT");
    expect(ttsRequest.contents[0].parts[0].text).toContain(
      "Pacing: Brisk conversational speed. Keep it clear, confident, and energetic without sounding rushed.",
    );
    expect(ttsRequest.contents[0].parts[0].text).toContain(
      "Use src slash app dot t s, line 42, for the fix.",
    );
  });

  it("merges short rewritten paragraphs into one TTS chunk", async () => {
    const rewrittenText = [
      "Setup.",
      "First short point.",
      "Second short point.",
      "This wraps the setup and short points in enough surrounding prose that the speech request stays natural instead of isolating structural fragments as separate audio chunks.",
    ].join("\n\n");
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [{ text: rewrittenText }],
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
                        data: Buffer.from([1, 2]).toString("base64"),
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

    const chunkProgress = [];
    const chunks = [];
    for await (const chunk of streamGeminiSpeechAudio({
      apiKey: "gemini-key",
      sourceText: "## Setup\n\n- First short point.\n- Second short point.",
      deliveryMode: "progressive",
      fetchImpl: fetchMock,
      onChunkProgress: (progress) => {
        chunkProgress.push(progress);
      },
    })) {
      chunks.push(chunk);
    }

    expect(chunks).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(chunkProgress).toEqual([
      { ready: 0, total: 1 },
      { ready: 1, total: 1 },
    ]);

    const ttsRequest = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(ttsRequest.contents[0].parts[0].text).toContain(rewrittenText.replace(/\s+/g, " "));
  });

  it.each([
    {
      name: "short",
      rewrittenText: "A short response stays in one complete-audio chunk.",
      expectedChunks: 1,
    },
    {
      name: "medium",
      rewrittenText: Array.from(
        { length: 14 },
        (_, index) =>
          `Sentence ${index + 1} explains a distinct implementation detail while keeping the transcript natural and complete.`,
      ).join(" "),
      expectedChunks: 2,
    },
    {
      name: "long",
      rewrittenText: Array.from(
        { length: 30 },
        (_, index) =>
          `Sentence ${index + 1} explains a distinct implementation detail while keeping the transcript natural and complete.`,
      ).join(" "),
      expectedChunks: 4,
    },
  ])("bounds complete-audio chunks for $name responses", async (testCase) => {
    let requestIndex = 0;
    const fetchMock = vi.fn(async () => {
      if (requestIndex++ === 0) {
        return new Response(
          JSON.stringify({
            candidates: [{ content: { parts: [{ text: testCase.rewrittenText }] } }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        );
      }

      return new Response(
        JSON.stringify({
          candidates: [
            {
              content: {
                parts: [{ inlineData: { data: Buffer.from([1, 2]).toString("base64") } }],
              },
            },
          ],
        }),
        { status: 200, headers: { "Content-Type": "application/json" } },
      );
    });

    const chunks = [];
    for await (const chunk of streamGeminiSpeechAudio({
      apiKey: "gemini-key",
      sourceText: "Original response.",
      deliveryMode: "complete",
      fetchImpl: fetchMock,
    })) {
      chunks.push(chunk);
    }

    expect(chunks).toHaveLength(testCase.expectedChunks);
    const ttsRequests = fetchMock.mock.calls.slice(1).map(([, init]) => JSON.parse(init.body));
    const transcripts = ttsRequests.map((request) =>
      request.contents[0].parts[0].text.split("### TRANSCRIPT\n")[1].trim(),
    );
    expect(transcripts.every((transcript) => transcript.length <= 1000)).toBe(true);
    expect(transcripts.join(" ")).toBe(testCase.rewrittenText);
    for (const request of ttsRequests) {
      expect(request.contents[0].parts[0].text).toContain(
        "Pacing: Brisk conversational speed. Keep it clear, confident, and energetic without sounding rushed.",
      );
      expect(request.generationConfig.maxOutputTokens).toBeGreaterThanOrEqual(1024);
      expect(request.generationConfig.maxOutputTokens).toBeLessThanOrEqual(8192);
      expect(request.generationConfig.maxOutputTokens % 256).toBe(0);
      expect(request.generationConfig.temperature).toBeUndefined();
    }
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
      deliveryMode: "progressive",
      fetchImpl: fetchMock,
      maxTtsAttempts: 2,
    })) {
      chunks.push(chunk);
    }

    expect(chunks).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});
