import { describe, expect, it, vi } from "vitest";
import {
  generateGeminiSpeechAudio,
  streamGeminiSpeechPcm,
} from "../dist/core/utils/gemini_speech.js";

function createSseResponse(payloads) {
  const encoder = new TextEncoder();
  const body = payloads.map((payload) => `data: ${JSON.stringify(payload)}\n\n`).join("");
  const midpoint = Math.floor(body.length / 2);
  return new Response(
    new ReadableStream({
      start(controller) {
        controller.enqueue(encoder.encode(body.slice(0, midpoint)));
        controller.enqueue(encoder.encode(body.slice(midpoint)));
        controller.close();
      },
    }),
    { status: 200, headers: { "Content-Type": "text/event-stream" } },
  );
}

function createStreamingAudioPayload(audio, finishReason) {
  return {
    candidates: [
      {
        ...(finishReason ? { finishReason } : {}),
        content: {
          parts: [{ inlineData: { data: Buffer.from(audio).toString("base64") } }],
        },
      },
    ],
  };
}

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
    for await (const chunk of generateGeminiSpeechAudio({
      apiKey: "gemini-key",
      sourceText: "Use src/app.ts:42 for the fix.",
      fetchImpl: fetchMock,
      onStageChange: (stage) => {
        stages.push(stage);
      },
      onSegmentProgress: (progress) => {
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
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.7-flash:generateContent",
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
    expect(rewriteRequest.generationConfig.thinkingConfig.thinkingLevel).toBe("low");

    const ttsRequest = JSON.parse(fetchMock.mock.calls[1][1].body);
    expect(ttsRequest.generationConfig.responseModalities).toEqual(["AUDIO"]);
    expect(ttsRequest.generationConfig.temperature).toBeUndefined();
    expect(ttsRequest.generationConfig.maxOutputTokens).toBe(8192);
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
    for await (const chunk of generateGeminiSpeechAudio({
      apiKey: "gemini-key",
      sourceText: "## Setup\n\n- First short point.\n- Second short point.",
      fetchImpl: fetchMock,
      onSegmentProgress: (progress) => {
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
    expect(ttsRequest.contents[0].parts[0].text).toContain(rewrittenText);
  });

  it("balances segments under the estimated two-minute maximum", async () => {
    const sentences = Array.from(
      { length: 10 },
      (_, index) => `Sentence ${index + 1} ${"A".repeat(238)}.`,
    );
    const rewrittenText = sentences.join(" ");
    let requestIndex = 0;
    const fetchMock = vi.fn(async () => {
      if (requestIndex++ === 0) {
        return new Response(
          JSON.stringify({
            candidates: [{ content: { parts: [{ text: rewrittenText }] } }],
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

    for await (const _chunk of generateGeminiSpeechAudio({
      apiKey: "gemini-key",
      sourceText: "Original response.",
      fetchImpl: fetchMock,
    })) {
      void _chunk;
    }

    const transcripts = fetchMock.mock.calls
      .slice(1)
      .map(([, init]) =>
        JSON.parse(init.body).contents[0].parts[0].text.split("### TRANSCRIPT\n")[1].trim(),
      );
    expect(transcripts).toHaveLength(2);
    expect(transcripts[0]).toBe(sentences.slice(0, 5).join(" "));
    expect(transcripts[1]).toBe(sentences.slice(5).join(" "));
  });

  it("balances several segments at natural paragraph boundaries", async () => {
    const paragraphs = Array.from(
      { length: 9 },
      (_, index) => `Paragraph ${index + 1} ${"A".repeat(485)}.`,
    );
    const rewrittenText = paragraphs.join("\n\n");
    let requestIndex = 0;
    const fetchMock = vi.fn(async () => {
      if (requestIndex++ === 0) {
        return new Response(
          JSON.stringify({
            candidates: [{ content: { parts: [{ text: rewrittenText }] } }],
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

    for await (const _chunk of generateGeminiSpeechAudio({
      apiKey: "gemini-key",
      sourceText: "Original response.",
      fetchImpl: fetchMock,
    })) {
      void _chunk;
    }

    const transcripts = fetchMock.mock.calls
      .slice(1)
      .map(([, init]) =>
        JSON.parse(init.body).contents[0].parts[0].text.split("### TRANSCRIPT\n")[1].trim(),
      );
    expect(transcripts).toHaveLength(3);
    expect(transcripts).toEqual([
      paragraphs.slice(0, 3).join("\n\n"),
      paragraphs.slice(3, 6).join("\n\n"),
      paragraphs.slice(6).join("\n\n"),
    ]);
  });

  it("weights no-space CJK text and preserves Unicode boundaries", async () => {
    const firstSentence = `${"語".repeat(499)}。`;
    const secondSentence = `${"文".repeat(499)}。`;
    const rewrittenText = `${firstSentence}${secondSentence}`;
    let requestIndex = 0;
    const fetchMock = vi.fn(async () => {
      if (requestIndex++ === 0) {
        return new Response(
          JSON.stringify({
            candidates: [{ content: { parts: [{ text: rewrittenText }] } }],
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

    for await (const _chunk of generateGeminiSpeechAudio({
      apiKey: "gemini-key",
      sourceText: "Original response.",
      fetchImpl: fetchMock,
    })) {
      void _chunk;
    }

    const transcripts = fetchMock.mock.calls
      .slice(1)
      .map(([, init]) =>
        JSON.parse(init.body).contents[0].parts[0].text.split("### TRANSCRIPT\n")[1].trim(),
      );
    expect(transcripts).toEqual([firstSentence, secondSentence]);
  });

  it("streams incremental PCM and validates the terminal response", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            candidates: [{ content: { parts: [{ text: "Spoken version." }] } }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        createSseResponse([
          createStreamingAudioPayload([1, 2]),
          createStreamingAudioPayload([3, 4], "STOP"),
        ]),
      );
    const progress = [];
    const chunks = [];

    for await (const chunk of streamGeminiSpeechPcm({
      apiKey: "gemini-key",
      sourceText: "Original response.",
      fetchImpl: fetchMock,
      onSegmentProgress: (value) => progress.push(value),
    })) {
      chunks.push(chunk);
    }

    expect(chunks.map((chunk) => chunk.audio)).toEqual([Buffer.from([1, 2]), Buffer.from([3, 4])]);
    expect(chunks.every((chunk) => chunk.index === 0 && chunk.total === 1)).toBe(true);
    expect(progress).toEqual([
      { ready: 0, total: 1 },
      { ready: 1, total: 1 },
    ]);
    expect(fetchMock.mock.calls[1][0]).toContain(
      "gemini-3.1-flash-tts-preview:streamGenerateContent?alt=sse",
    );
  });

  it("prefetches the next balanced segment while streaming the first", async () => {
    const sentences = Array.from(
      { length: 10 },
      (_, index) => `Sentence ${index + 1} ${"A".repeat(238)}.`,
    );
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            candidates: [{ content: { parts: [{ text: sentences.join(" ") }] } }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(createSseResponse([createStreamingAudioPayload([1, 2], "STOP")]))
      .mockResolvedValueOnce(createSseResponse([createStreamingAudioPayload([3, 4], "STOP")]));
    const stream = streamGeminiSpeechPcm({
      apiKey: "gemini-key",
      sourceText: "Original response.",
      fetchImpl: fetchMock,
    });

    const first = await stream.next();

    expect(first.value).toMatchObject({ index: 0, total: 2, audio: Buffer.from([1, 2]) });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const remaining = [];
    for await (const chunk of stream) {
      remaining.push(chunk);
    }
    expect(remaining).toEqual([{ index: 1, total: 2, audio: Buffer.from([3, 4]) }]);
    const transcripts = fetchMock.mock.calls
      .slice(1)
      .map(([, init]) =>
        JSON.parse(init.body).contents[0].parts[0].text.split("### TRANSCRIPT\n")[1].trim(),
      );
    expect(transcripts).toEqual([sentences.slice(0, 5).join(" "), sentences.slice(5).join(" ")]);
  });

  it("retries a stream failure only before audio has been emitted", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            candidates: [{ content: { parts: [{ text: "Spoken version." }] } }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { message: "temporary failure" } }), {
          status: 500,
          headers: { "Content-Type": "application/json" },
        }),
      )
      .mockResolvedValueOnce(createSseResponse([createStreamingAudioPayload([1, 2], "STOP")]));
    const chunks = [];

    for await (const chunk of streamGeminiSpeechPcm({
      apiKey: "gemini-key",
      sourceText: "Original response.",
      fetchImpl: fetchMock,
      maxTtsAttempts: 2,
    })) {
      chunks.push(chunk);
    }

    expect(chunks.map((chunk) => chunk.audio)).toEqual([Buffer.from([1, 2])]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it("does not replay a stream after audio has been emitted", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            candidates: [{ content: { parts: [{ text: "Spoken version." }] } }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        createSseResponse([
          createStreamingAudioPayload([1, 2]),
          { candidates: [{ finishReason: "OTHER" }] },
        ]),
      );
    const stream = streamGeminiSpeechPcm({
      apiKey: "gemini-key",
      sourceText: "Original response.",
      fetchImpl: fetchMock,
      maxTtsAttempts: 3,
    });

    await expect(stream.next()).resolves.toMatchObject({
      value: { audio: Buffer.from([1, 2]) },
    });
    await expect(stream.next()).rejects.toThrow("Gemini TTS stopped with finish reason 'OTHER'");
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("cancels an active speech stream", async () => {
    const abortController = new AbortController();
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            candidates: [{ content: { parts: [{ text: "Spoken version." }] } }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      )
      .mockImplementationOnce(async (_url, init) => {
        await new Promise((_, reject) => {
          init.signal.addEventListener(
            "abort",
            () => {
              const error = new Error("aborted");
              error.name = "AbortError";
              reject(error);
            },
            { once: true },
          );
        });
      });
    const stream = streamGeminiSpeechPcm({
      apiKey: "gemini-key",
      sourceText: "Original response.",
      fetchImpl: fetchMock,
      signal: abortController.signal,
    });
    const next = stream.next();

    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    abortController.abort();

    await expect(next).rejects.toMatchObject({ name: "AbortError" });
  });

  it("aborts speech rewriting after one minute", async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi.fn(async (_url, init) => {
        await new Promise((_, reject) => {
          init.signal.addEventListener(
            "abort",
            () => {
              const error = new Error("aborted");
              error.name = "AbortError";
              reject(error);
            },
            { once: true },
          );
        });
      });
      const nextChunk = generateGeminiSpeechAudio({
        apiKey: "gemini-key",
        sourceText: "Original text.",
        fetchImpl: fetchMock,
      }).next();
      const rejection = expect(nextChunk).rejects.toThrow(
        "speech rewrite timed out after 1 minute",
      );

      await vi.advanceTimersByTimeAsync(60_000);
      await rejection;
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });

  it("rejects oversized source and rewritten speech text", async () => {
    const sourceFetch = vi.fn();
    await expect(async () => {
      for await (const _chunk of generateGeminiSpeechAudio({
        apiKey: "gemini-key",
        sourceText: "😀".repeat(10_001),
        fetchImpl: sourceFetch,
      })) {
        void _chunk;
      }
    }).rejects.toThrow("speech source text exceeds 10,000 characters");
    expect(sourceFetch).not.toHaveBeenCalled();

    const rewrittenFetch = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            candidates: [{ content: { parts: [{ text: "語".repeat(10_001) }] } }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    );
    await expect(async () => {
      for await (const _chunk of generateGeminiSpeechAudio({
        apiKey: "gemini-key",
        sourceText: "Original text.",
        fetchImpl: rewrittenFetch,
      })) {
        void _chunk;
      }
    }).rejects.toThrow("rewritten speech text exceeds 10,000 characters");
    expect(rewrittenFetch).toHaveBeenCalledTimes(1);
  });

  it("rejects generated speech above the cumulative PCM limit", async () => {
    const oversizedAudio = Buffer.alloc(32 * 1024 * 1024 + 1).toString("base64");
    const ttsPayload = JSON.stringify({
      candidates: [{ content: { parts: [{ inlineData: { data: oversizedAudio } }] } }],
    });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            candidates: [{ content: { parts: [{ text: "Spoken version." }] } }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => ttsPayload,
      });

    await expect(async () => {
      for await (const _chunk of generateGeminiSpeechAudio({
        apiKey: "gemini-key",
        sourceText: "Original text.",
        fetchImpl: fetchMock,
        maxTtsAttempts: 1,
      })) {
        void _chunk;
      }
    }).rejects.toThrow("generated speech audio exceeds the 32 MiB limit");
  });

  it("rejects audio truncated by the TTS output token limit", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            candidates: [{ content: { parts: [{ text: "Spoken version." }] } }],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            candidates: [
              {
                finishReason: "MAX_TOKENS",
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

    await expect(async () => {
      for await (const _chunk of generateGeminiSpeechAudio({
        apiKey: "gemini-key",
        sourceText: "Original text.",
        fetchImpl: fetchMock,
        maxTtsAttempts: 3,
      })) {
        void _chunk;
      }
    }).rejects.toThrow("Gemini TTS reached its output token limit");
    expect(fetchMock).toHaveBeenCalledTimes(2);
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
    for await (const chunk of generateGeminiSpeechAudio({
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
