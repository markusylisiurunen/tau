import { describe, expect, it, vi } from "vitest";
import { transcribeGeminiAudio } from "../dist/core/utils/gemini_transcription.js";

describe("gemini transcription", () => {
  it("transcribes audio with low thinking", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [
                    {
                      text: JSON.stringify({
                        transcription: "ship the fix",
                      }),
                    },
                  ],
                },
              },
            ],
          }),
          { status: 200, headers: { "Content-Type": "application/json" } },
        ),
    );

    const transcript = await transcribeGeminiAudio({
      apiKey: "gemini-key",
      audio: Buffer.from("audio payload"),
      mimeType: "audio/ogg",
      fetchImpl: fetchMock,
      context: {
        messages: [
          { role: "user", text: "Can we support OAuth for Acme SSO?" },
          { role: "assistant", text: "Yes, the Acme SSO flow can reuse the callback handler." },
        ],
      },
    });

    expect(transcript).toEqual({ text: "ship the fix", usedFallback: false });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toContain(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.7-flash:generateContent",
    );
    expect(fetchMock.mock.calls[0][1].headers["x-goog-api-key"]).toBe("gemini-key");

    const request = JSON.parse(fetchMock.mock.calls[0][1].body);
    expect(request.systemInstruction.parts[0].text).toContain("You are a speech-to-text engine.");
    expect(request.systemInstruction.parts[0].text).toContain(
      "Transcribe the speaker's intended message for insertion into a chat input.",
    );
    expect(request.systemInstruction.parts[0].text).toContain(
      "Detect the speaker's language and transcribe in that same language",
    );
    expect(request.systemInstruction.parts[0].text).toContain(
      "do not normalize informal speech into formal standard language",
    );
    expect(request.systemInstruction.parts[0].text).toContain(
      "Lightly clean only speech artifacts that do not affect meaning",
    );
    expect(request.contents[0].parts[0].text).toContain(
      "Transcribe the attached audio into the transcription field.",
    );
    expect(request.contents[0].parts[0].text).toContain(
      "Use the recent conversation context below only to resolve likely words, names, acronyms, terminology, and references in the audio.",
    );
    expect(request.contents[0].parts[0].text).toContain(
      "Do not transcribe the context itself, and do not add words from the context that were not spoken.",
    );
    expect(request.contents[0].parts[0].text).toContain("<speech-to-text-context>");
    expect(request.contents[0].parts[0].text).toContain(
      '<message index="1" role="user">\nCan we support OAuth',
    );
    expect(request.contents[0].parts[0].text).toContain(
      '<message index="2" role="assistant">\nYes, the Acme SSO flow',
    );
    expect(request.contents[0].parts[0].text).toContain("</speech-to-text-context>");
    expect(request.contents[0].parts[1].inlineData.mimeType).toBe("audio/ogg");
    expect(request.contents[0].parts[1].inlineData.data).toBe(
      Buffer.from("audio payload").toString("base64"),
    );
    expect(request.generationConfig.responseMimeType).toBe("application/json");
    expect(request.generationConfig.responseSchema).toEqual({
      type: "OBJECT",
      properties: {
        transcription: { type: "STRING" },
      },
      required: ["transcription"],
    });
    expect(request.generationConfig.thinkingConfig.thinkingLevel).toBe("low");
  });

  it("retries a transient failure on the primary model", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: { message: "service unavailable" } }), {
          status: 503,
          headers: { "Retry-After": "0" },
        }),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [{ text: JSON.stringify({ transcription: "recovered transcript" }) }],
                },
              },
            ],
          }),
        ),
      );
    const onProgress = vi.fn();

    const result = await transcribeGeminiAudio({
      apiKey: "gemini-key",
      audio: Buffer.from("audio payload"),
      fetchImpl: fetchMock,
      onProgress,
    });

    expect(result).toEqual({ text: "recovered transcript", usedFallback: false });
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
      expect.stringContaining("gemini-3.7-flash"),
      expect.stringContaining("gemini-3.7-flash"),
    ]);
    expect(onProgress).toHaveBeenCalledWith("retrying");
  });

  it("uses Gemini 3.6 with minimal thinking after primary attempts fail", async () => {
    const unavailable = () =>
      new Response(
        JSON.stringify({ error: { message: "model unavailable", status: "UNAVAILABLE" } }),
        { status: 503, headers: { "Retry-After": "0" } },
      );
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(unavailable())
      .mockResolvedValueOnce(unavailable())
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [{ text: JSON.stringify({ transcription: "fallback transcript" }) }],
                },
              },
            ],
          }),
        ),
      );
    const onProgress = vi.fn();

    const result = await transcribeGeminiAudio({
      apiKey: "gemini-key",
      audio: Buffer.from("audio payload"),
      fetchImpl: fetchMock,
      onProgress,
    });

    expect(result).toEqual({ text: "fallback transcript", usedFallback: true });
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[2][0]).toContain("gemini-3.6-flash");
    const fallbackRequest = JSON.parse(fetchMock.mock.calls[2][1].body);
    expect(fallbackRequest.generationConfig.thinkingConfig.thinkingLevel).toBe("minimal");
    expect(onProgress.mock.calls.map(([progress]) => progress)).toEqual([
      "retrying",
      "trying-fallback",
    ]);
  });

  it("advances through the fallback chain for malformed successful responses", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ candidates: [] })));

    await expect(
      transcribeGeminiAudio({
        apiKey: "gemini-key",
        audio: Buffer.from("audio payload"),
        fetchImpl: fetchMock,
      }),
    ).rejects.toThrow("transcription result was empty or malformed");
    expect(fetchMock).toHaveBeenCalledTimes(3);
    expect(fetchMock.mock.calls[2][0]).toContain("gemini-3.6-flash");
  });

  it("does not retry permanent request failures", async () => {
    const fetchMock = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: { message: "invalid API key" } }), { status: 401 }),
    );

    await expect(
      transcribeGeminiAudio({
        apiKey: "gemini-key",
        audio: Buffer.from("audio payload"),
        fetchImpl: fetchMock,
      }),
    ).rejects.toThrow("invalid API key");
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});
