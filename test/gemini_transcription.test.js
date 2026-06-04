import { describe, expect, it, vi } from "vitest";
import { transcribeGeminiAudio } from "../dist/core/utils/gemini_transcription.js";

describe("gemini transcription", () => {
  it("transcribes audio with minimal thinking", async () => {
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
    });

    expect(transcript).toBe("ship the fix");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toContain(
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-3.5-flash:generateContent",
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
    expect(request.generationConfig.thinkingConfig.thinkingLevel).toBe("minimal");
  });
});
