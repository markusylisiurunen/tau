import { EventEmitter } from "node:events";
import { describe, expect, it, vi } from "vitest";
import {
  startGeminiTranscription,
  transcribeGeminiAudio,
} from "../dist/core/utils/gemini_transcription.js";

function createJsonResponse(payload, status = 200, headers = {}) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function createGeminiFetchMock({
  transcript = "ship the fix",
  interactionStatus = 200,
  keywords = ["Acme SSO", "OAuth", "oauth", "bad\nterm"],
} = {}) {
  return vi.fn(async (input, options = {}) => {
    const url = String(input);
    if (url.endsWith("/gemini-3.7-flash:generateContent")) {
      return createJsonResponse({
        candidates: [
          {
            content: {
              parts: [
                {
                  text: JSON.stringify({ keywords }),
                },
              ],
            },
          },
        ],
      });
    }
    if (url === "https://generativelanguage.googleapis.com/upload/v1beta/files") {
      return new Response(null, {
        headers: { "x-goog-upload-url": "https://upload.example.test/audio" },
      });
    }
    if (url === "https://upload.example.test/audio") {
      return createJsonResponse({
        file: {
          name: "files/audio-1",
          uri: "https://generativelanguage.googleapis.com/v1beta/files/audio-1",
        },
      });
    }
    if (url === "https://generativelanguage.googleapis.com/v1beta/interactions") {
      return interactionStatus === 200
        ? createJsonResponse({
            steps: [
              {
                type: "model_output",
                content: [{ type: "text", text: transcript }],
              },
            ],
          })
        : createJsonResponse({ error: { message: transcript } }, interactionStatus);
    }
    if (url.endsWith("/v1beta/files/audio-1") && options.method === "DELETE") {
      return new Response(null, { status: 204 });
    }
    throw new Error(`unexpected request: ${url}`);
  });
}

function getCall(fetchMock, suffix) {
  return fetchMock.mock.calls.find(([input]) => String(input).endsWith(suffix));
}

describe("gemini transcription", () => {
  it("transcribes uploaded audio with Gemini 3.5 Transcribe smart mode and context keywords", async () => {
    const fetchMock = createGeminiFetchMock();

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

    expect(transcript).toBe("ship the fix");

    const keywordCall = getCall(fetchMock, "/gemini-3.7-flash:generateContent");
    const keywordRequest = JSON.parse(keywordCall[1].body);
    expect(keywordRequest.systemInstruction.parts[0].text).toContain(
      "Extract words and short phrases",
    );
    expect(keywordRequest.contents[0].parts[0].text).toContain("<speech-to-text-context>");
    expect(keywordRequest.generationConfig.thinkingConfig.thinkingLevel).toBe("low");

    const uploadStartCall = getCall(fetchMock, "/upload/v1beta/files");
    expect(uploadStartCall[1].headers["X-Goog-Upload-Protocol"]).toBe("resumable");
    expect(uploadStartCall[1].headers["X-Goog-Upload-Header-Content-Type"]).toBe("audio/ogg");

    const interactionCall = getCall(fetchMock, "/v1beta/interactions");
    const interactionRequest = JSON.parse(interactionCall[1].body);
    expect(interactionRequest).toMatchObject({
      model: "gemini-3.5-transcribe",
      input: [
        {
          type: "audio",
          uri: "https://generativelanguage.googleapis.com/v1beta/files/audio-1",
          mime_type: "audio/ogg",
        },
      ],
      generation_config: {
        transcription_config: {
          language_codes: [],
          custom_vocabulary: ["Acme SSO", "OAuth"],
          mode: "smart",
        },
      },
      store: false,
    });
    expect(getCall(fetchMock, "/v1beta/files/audio-1")[1].method).toBe("DELETE");
  });

  it("preserves Gemini custom vocabulary beyond the OpenAI aggregate limit", async () => {
    const keywords = Array.from({ length: 20 }, (_, index) => `keyword-${index}-${"x".repeat(70)}`);
    const fetchMock = createGeminiFetchMock({ keywords });

    await transcribeGeminiAudio({
      apiKey: "gemini-key",
      audio: Buffer.from("audio payload"),
      context: { messages: [{ role: "user", text: "Use the project vocabulary" }] },
      fetchImpl: fetchMock,
    });

    const interactionCall = getCall(fetchMock, "/v1beta/interactions");
    const interactionRequest = JSON.parse(interactionCall[1].body);
    const customVocabulary =
      interactionRequest.generation_config.transcription_config.custom_vocabulary;
    expect(customVocabulary).toEqual(keywords);
    expect(customVocabulary.join("").length).toBeGreaterThan(1_024);
  });

  it("streams microphone audio through Gemini 3.5 Transcribe Live in smart mode", async () => {
    const fetchMock = createGeminiFetchMock();
    const socket = new EventEmitter();
    const sent = [];
    socket.send = vi.fn((data, callback) => {
      sent.push(JSON.parse(data));
      callback?.();
    });
    socket.close = vi.fn();
    socket.terminate = vi.fn();
    const webSocketFactory = vi.fn(() => socket);
    const transcription = startGeminiTranscription({
      apiKey: "gemini key",
      context: { messages: [{ role: "user", text: "Configure Acme SSO" }] },
      fetchImpl: fetchMock,
      webSocketFactory,
    });
    const audio = Buffer.from([1, 2, 3, 4]);
    transcription.appendAudio(audio);

    socket.emit("open");
    await vi.waitFor(() => expect(sent).toHaveLength(1));
    expect(webSocketFactory).toHaveBeenCalledWith(expect.stringContaining("BidiGenerateContent"));
    expect(webSocketFactory.mock.calls[0][0]).toContain("key=gemini%20key");
    expect(sent[0]).toEqual({
      setup: {
        model: "models/gemini-3.5-transcribe-live",
        generationConfig: { responseModalities: ["TEXT"] },
        inputAudioTranscription: {
          languageCodes: [],
          customVocabulary: ["Acme SSO", "OAuth"],
          mode: "SMART",
        },
        realtimeInputConfig: {
          automaticActivityDetection: { disabled: true },
        },
      },
    });

    socket.emit("message", JSON.stringify({ setupComplete: {} }));
    await vi.waitFor(() => expect(sent).toHaveLength(3));
    expect(sent[1]).toEqual({ realtimeInput: { activityStart: {} } });
    expect(sent[2]).toEqual({
      realtimeInput: {
        audio: {
          data: audio.toString("base64"),
          mimeType: "audio/pcm;rate=16000",
        },
      },
    });

    const completion = transcription.finish();
    await vi.waitFor(() => expect(sent).toHaveLength(4));
    expect(sent[3]).toEqual({ realtimeInput: { activityEnd: {} } });
    socket.emit(
      "message",
      JSON.stringify({
        serverContent: {
          inputTranscription: { text: "live transcript" },
        },
      }),
    );

    await expect(completion).resolves.toBe("live transcript");
    expect(socket.close).toHaveBeenCalledTimes(1);
  });

  it("starts the session readiness timeout after keyword extraction", async () => {
    vi.useFakeTimers();
    const keywordResponse = Promise.withResolvers();
    const setupSent = Promise.withResolvers();
    const socket = new EventEmitter();
    socket.send = vi.fn((data, callback) => {
      const event = JSON.parse(data);
      if (event.setup) setupSent.resolve(event);
      callback?.();
    });
    socket.close = vi.fn();
    socket.terminate = vi.fn();
    let transcription;

    try {
      transcription = startGeminiTranscription({
        apiKey: "gemini-key",
        context: { messages: [{ role: "user", text: "Configure Acme SSO" }] },
        fetchImpl: vi.fn(() => keywordResponse.promise),
        webSocketFactory: vi.fn(() => socket),
      });
      socket.emit("open");

      await vi.advanceTimersByTimeAsync(14_900);
      keywordResponse.resolve(
        createJsonResponse({
          candidates: [
            {
              content: {
                parts: [{ text: JSON.stringify({ keywords: ["Acme SSO"] }) }],
              },
            },
          ],
        }),
      );
      await setupSent.promise;
      await vi.advanceTimersByTimeAsync(200);

      expect(socket.terminate).not.toHaveBeenCalled();
      socket.emit("message", JSON.stringify({ setupComplete: {} }));
    } finally {
      transcription?.abort();
      vi.useRealTimers();
    }
  });

  it("reports provider failures and deletes the uploaded file", async () => {
    const fetchMock = createGeminiFetchMock({
      transcript: "service unavailable",
      interactionStatus: 503,
    });

    await expect(
      transcribeGeminiAudio({
        apiKey: "gemini-key",
        audio: Buffer.from("audio payload"),
        fetchImpl: fetchMock,
      }),
    ).rejects.toThrow("service unavailable");
    expect(getCall(fetchMock, "/v1beta/files/audio-1")[1].method).toBe("DELETE");
  });
});
