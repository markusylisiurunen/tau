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
  interactionPayload,
  keywords = ["Acme SSO", "OAuth", "oauth", "bad\nterm"],
} = {}) {
  return vi.fn(async (input, options = {}) => {
    const url = String(input);
    if (url.endsWith("https://api.openai.com/v1/responses")) {
      return createJsonResponse({
        status: "completed",
        output: [
          {
            type: "message",
            status: "completed",
            content: [{ type: "output_text", text: JSON.stringify({ keywords }) }],
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
        ? createJsonResponse(
            interactionPayload ?? {
              steps: [
                {
                  type: "model_output",
                  content: [{ type: "text", text: transcript }],
                },
              ],
            },
          )
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
  it.each(["mid-speech", "paused", "silent", "late-activity"])(
    "drains the live transcript after stopping %s without a second transcription request",
    async (state) => {
      vi.useFakeTimers();
      const socket = new EventEmitter();
      const sent = [];
      socket.send = (data, callback) => {
        sent.push(JSON.parse(data));
        callback?.();
      };
      socket.close = vi.fn(() => socket.emit("close", 1000, Buffer.alloc(0)));
      socket.terminate = vi.fn();
      const fetchImpl = vi.fn();
      const onProgress = vi.fn();
      const transcription = startGeminiTranscription({
        apiKey: "key",
        fetchImpl,
        webSocketFactory: () => socket,
        onProgress,
      });
      const emit = (event) => socket.emit("message", JSON.stringify(event));
      try {
        socket.emit("open");
        await vi.advanceTimersByTimeAsync(0);
        emit({ setupComplete: {} });
        transcription.appendAudio(Buffer.alloc(3200));
        if (state === "paused" || state === "late-activity") {
          emit({
            serverContent: {
              inputTranscription: { text: "first segment" },
              generationComplete: true,
            },
          });
        }
        if (state === "mid-speech")
          emit({ serverContent: { interimInputTranscription: { text: "partial" } } });
        const completion = transcription.finish();
        await vi.advanceTimersByTimeAsync(0);
        expect(sent.at(-1)).toEqual({ realtimeInput: { audioStreamEnd: true } });
        await vi.advanceTimersByTimeAsync(1999);
        expect(socket.close).not.toHaveBeenCalled();
        if (state === "late-activity") {
          emit({ voiceActivity: { type: "ACTIVITY_START", audioOffset: "1s" } });
          expect(sent.filter((event) => event.realtimeInput?.audioStreamEnd)).toHaveLength(2);
          emit({ serverContent: { interimInputTranscription: { text: "next" } } });
        }
        if (state === "mid-speech" || state === "late-activity") {
          await vi.advanceTimersByTimeAsync(3000);
          expect(socket.close).not.toHaveBeenCalled();
          emit({ serverContent: { generationComplete: true } });
          await vi.advanceTimersByTimeAsync(1000);
          expect(socket.close).not.toHaveBeenCalled();
          emit({ serverContent: { inputTranscription: { text: "final segment" } } });
          await vi.advanceTimersByTimeAsync(1999);
          expect(socket.close).not.toHaveBeenCalled();
        }
        await vi.advanceTimersByTimeAsync(1);
        const expected =
          state === "silent"
            ? ""
            : state === "paused"
              ? "first segment"
              : state === "late-activity"
                ? "first segment final segment"
                : "final segment";
        await expect(completion).resolves.toBe(expected);
        await expect(transcription.finish()).resolves.toBe(expected);
        expect(fetchImpl).not.toHaveBeenCalled();
        const progressCount = onProgress.mock.calls.length;
        emit({ serverContent: { inputTranscription: { text: "late" } } });
        expect(onProgress).toHaveBeenCalledTimes(progressCount);
        expect(socket.close).toHaveBeenCalledTimes(1);
        expect(socket.terminate).not.toHaveBeenCalled();
      } finally {
        transcription.abort();
        vi.useRealTimers();
      }
    },
  );

  it.each([
    ["transcript", "generation", "activity"],
    ["transcript", "activity", "generation"],
    ["generation", "transcript", "activity"],
    ["generation", "activity", "transcript"],
    ["activity", "transcript", "generation"],
    ["activity", "generation", "transcript"],
  ])("finishes covered audio after %s, %s, %s", async (...order) => {
    vi.useFakeTimers();
    const socket = new EventEmitter();
    socket.send = vi.fn((_data, callback) => callback?.());
    socket.close = vi.fn();
    socket.terminate = vi.fn();
    const transcription = startGeminiTranscription({
      apiKey: "key",
      webSocketFactory: () => socket,
    });
    const emit = (event) => socket.emit("message", JSON.stringify(event));
    try {
      // Include buffered audio and a previous finalized segment in the stream offset.
      transcription.appendAudio(Buffer.alloc(160000));
      socket.emit("open");
      await vi.advanceTimersByTimeAsync(0);
      emit({ setupComplete: {} });
      emit({ serverContent: { inputTranscription: { text: "first" }, generationComplete: true } });
      transcription.appendAudio(Buffer.alloc(154710));
      emit({ voiceActivity: { type: "ACTIVITY_START" } });
      emit({ serverContent: { interimInputTranscription: { text: "sec" } } });
      const completion = transcription.finish();
      await vi.advanceTimersByTimeAsync(0);
      const events = {
        transcript: { serverContent: { inputTranscription: { text: "second" } } },
        generation: { serverContent: { generationComplete: true } },
        activity: { voiceActivity: { type: "ACTIVITY_END", audioOffset: "9.834687500s" } },
      };
      for (const name of order) {
        expect(socket.close).not.toHaveBeenCalled();
        emit(events[name]);
      }
      expect(socket.close).toHaveBeenCalledTimes(1);
      await expect(completion).resolves.toBe("first second");
      await vi.advanceTimersByTimeAsync(30000);
      expect(socket.terminate).not.toHaveBeenCalled();
    } finally {
      transcription.abort();
      vi.useRealTimers();
    }
  });

  it.each([undefined, "0.099937500s", "0.100062500s", "invalid", "-0.1s", "0.1000000001s"])(
    "uses the quiet window for an uncovered or unusable offset %s",
    async (audioOffset) => {
      vi.useFakeTimers();
      const socket = new EventEmitter();
      socket.send = vi.fn((_data, callback) => callback?.());
      socket.close = vi.fn();
      socket.terminate = vi.fn();
      const transcription = startGeminiTranscription({
        apiKey: "key",
        webSocketFactory: () => socket,
      });
      const emit = (event) => socket.emit("message", JSON.stringify(event));
      try {
        socket.emit("open");
        await vi.advanceTimersByTimeAsync(0);
        emit({ setupComplete: {} });
        transcription.appendAudio(Buffer.alloc(3200));
        const completion = transcription.finish();
        await vi.advanceTimersByTimeAsync(0);
        emit({
          serverContent: { inputTranscription: { text: "first" }, generationComplete: true },
        });
        emit({ voiceActivity: { type: "ACTIVITY_END", audioOffset } });
        await vi.advanceTimersByTimeAsync(1999);
        expect(socket.close).not.toHaveBeenCalled();
        emit({ voiceActivity: { type: "ACTIVITY_START" } });
        emit({ voiceActivity: { type: "ACTIVITY_END", audioOffset: "0.1s" } });
        emit({ serverContent: { generationComplete: true } });
        expect(socket.close).not.toHaveBeenCalled();
        emit({ serverContent: { inputTranscription: { text: "last words" } } });
        await expect(completion).resolves.toBe("first last words");
        expect(socket.close).toHaveBeenCalledTimes(1);
      } finally {
        transcription.abort();
        vi.useRealTimers();
      }
    },
  );

  it.each(["abort", "signal", "timeout", "error", "close"])(
    "rejects live finalization on %s",
    async (outcome) => {
      vi.useFakeTimers();
      const socket = new EventEmitter();
      socket.send = vi.fn((_data, callback) => callback?.());
      socket.close = vi.fn();
      socket.terminate = vi.fn();
      const transcription = startGeminiTranscription({
        apiKey: "key",
        webSocketFactory: () => socket,
      });
      try {
        socket.emit("open");
        await vi.advanceTimersByTimeAsync(0);
        socket.emit("message", JSON.stringify({ setupComplete: {} }));
        transcription.appendAudio(Buffer.alloc(3200));
        socket.emit(
          "message",
          JSON.stringify({ serverContent: { interimInputTranscription: { text: "unfinished" } } }),
        );
        const controller = new AbortController();
        const completion = transcription.finish({ signal: controller.signal });
        void completion.catch(() => {});
        await vi.advanceTimersByTimeAsync(0);
        if (outcome === "timeout") await vi.advanceTimersByTimeAsync(30000);
        else if (outcome === "signal") controller.abort();
        else if (outcome === "error") socket.emit("error", new Error("disconnected"));
        else if (outcome === "close") socket.emit("close", 1006, Buffer.alloc(0));
        else transcription.abort();
        await expect(completion).rejects.toThrow();
        await vi.advanceTimersByTimeAsync(30000);
      } finally {
        transcription.abort();
        vi.useRealTimers();
      }
    },
  );

  it("restarts the quiet window for trailing segments without extending the completion deadline", async () => {
    vi.useFakeTimers();
    const socket = new EventEmitter();
    socket.send = vi.fn((_data, callback) => callback?.());
    socket.close = vi.fn();
    socket.terminate = vi.fn();
    const transcription = startGeminiTranscription({
      apiKey: "key",
      webSocketFactory: () => socket,
    });
    try {
      socket.emit("open");
      await vi.advanceTimersByTimeAsync(0);
      socket.emit("message", JSON.stringify({ setupComplete: {} }));
      transcription.appendAudio(Buffer.alloc(3200));
      const completion = transcription.finish();
      void completion.catch(() => {});
      await vi.advanceTimersByTimeAsync(0);
      for (let i = 0; i < 29; i++) {
        await vi.advanceTimersByTimeAsync(1000);
        socket.emit(
          "message",
          JSON.stringify({ serverContent: { inputTranscription: { text: "segment" } } }),
        );
        expect(socket.close).not.toHaveBeenCalled();
      }
      await vi.advanceTimersByTimeAsync(1000);
      await expect(completion).rejects.toThrow();
      expect(socket.terminate).toHaveBeenCalled();
    } finally {
      transcription.abort();
      vi.useRealTimers();
    }
  });

  it("accepts an explicitly empty file transcript and deletes the upload", async () => {
    const fetchImpl = createGeminiFetchMock({ transcript: "" });
    await expect(
      transcribeGeminiAudio({ apiKey: "key", audio: Buffer.alloc(2048), fetchImpl }),
    ).resolves.toBe("");
    expect(getCall(fetchImpl, "/v1beta/files/audio-1")[1].method).toBe("DELETE");
  });

  it.each([
    {},
    { status: "in_progress", usage: { total_output_tokens: 0 } },
    { status: "completed", usage: { total_output_tokens: 1 } },
    {
      status: "completed",
      usage: { total_output_tokens: 0 },
      steps: [{ type: "model_output", content: [{ type: "text", text: null }] }],
    },
  ])(
    "rejects a missing transcript without an explicit completed empty result (%j)",
    async (interactionPayload) => {
      const fetchImpl = createGeminiFetchMock({ interactionPayload });
      await expect(
        transcribeGeminiAudio({ apiKey: "key", audio: Buffer.alloc(2048), fetchImpl }),
      ).rejects.toThrow();
      expect(getCall(fetchImpl, "/v1beta/files/audio-1")[1].method).toBe("DELETE");
    },
  );

  it.each(["missing key", "provider error", "incomplete", "refusal", "malformed"])(
    "transcribes without hints after keyword extraction %s",
    async (outcome) => {
      const providerFetch = createGeminiFetchMock();
      const fetchMock = vi.fn(async (url, options) => {
        if (url !== "https://api.openai.com/v1/responses") return providerFetch(url, options);
        if (outcome === "provider error") return new Response(null, { status: 503 });
        return createJsonResponse({
          status: outcome === "incomplete" ? "incomplete" : "completed",
          output: [
            {
              type: "message",
              status: "completed",
              content: [
                outcome === "refusal"
                  ? { type: "refusal", refusal: "declined" }
                  : {
                      type: "output_text",
                      text: outcome === "malformed" ? "not JSON" : '{"keywords":["Tau"]}',
                    },
              ],
            },
          ],
        });
      });
      await expect(
        transcribeGeminiAudio({
          apiKey: "google-key",
          openAIApiKey: outcome === "missing key" ? undefined : "openai-key",
          audio: Buffer.from("audio"),
          context: { messages: [{ role: "user", text: "Use Tau" }] },
          fetchImpl: fetchMock,
        }),
      ).resolves.toBe("ship the fix");
      const request = JSON.parse(getCall(providerFetch, "/v1beta/interactions")[1].body);
      expect(request.generation_config.transcription_config.custom_vocabulary).toBeUndefined();
      expect(getCall(fetchMock, "https://api.openai.com/v1/responses") !== undefined).toBe(
        outcome !== "missing key",
      );
    },
  );

  it("transcribes uploaded audio with Gemini 3.5 Transcribe verbatim mode and context keywords", async () => {
    const fetchMock = createGeminiFetchMock();

    const transcript = await transcribeGeminiAudio({
      apiKey: "gemini-key",
      openAIApiKey: "openai-key",
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

    const keywordCall = getCall(fetchMock, "https://api.openai.com/v1/responses");
    const keywordRequest = JSON.parse(keywordCall[1].body);
    expect(keywordRequest.instructions).toContain("Extract words and short phrases");
    expect(keywordRequest.input).toContain("<speech-to-text-context>");
    expect(keywordRequest).toMatchObject({
      model: "gpt-6-luna",
      reasoning: { effort: "none" },
      store: false,
      max_output_tokens: 2048,
      text: { format: { type: "json_schema", strict: true } },
    });
    expect(keywordCall[1].headers.Authorization).toBe("Bearer openai-key");

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
          language_codes: ["en-US", "fi-FI"],
          custom_vocabulary: ["Acme SSO", "OAuth"],
          mode: { type: "verbatim" },
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
      openAIApiKey: "openai-key",
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

  it("streams microphone audio through Gemini 3.5 Transcribe Live in verbatim mode", async () => {
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
    const onProgress = vi.fn();
    const transcription = startGeminiTranscription({
      apiKey: "gemini key",
      openAIApiKey: "openai-key",
      onProgress,
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
          languageCodes: ["en-US", "fi-FI"],
          customVocabulary: ["Acme SSO", "OAuth"],
          mode: "VERBATIM",
        },
      },
    });

    socket.emit("message", JSON.stringify({ setupComplete: {} }));
    await vi.waitFor(() => expect(sent).toHaveLength(2));
    expect(sent[1]).toEqual({
      realtimeInput: {
        audio: {
          data: audio.toString("base64"),
          mimeType: "audio/pcm;rate=16000",
        },
      },
    });

    for (const text of ["Hey", "Hey, um", "Hey, um This is", "Hey, um this is"]) {
      socket.emit(
        "message",
        JSON.stringify({ serverContent: { interimInputTranscription: { text } } }),
      );
    }
    expect(onProgress.mock.calls.map(([text]) => text)).toEqual([
      "Hey",
      "Hey, um",
      "Hey, um This is",
      "Hey, um this is",
    ]);
    socket.emit("message", JSON.stringify({ setupComplete: {} }));
    expect(sent).toHaveLength(2);
    for (const text of ["first segment", "second segment"]) {
      socket.emit("message", JSON.stringify({ serverContent: { inputTranscription: { text } } }));
      socket.emit("message", JSON.stringify({ serverContent: { generationComplete: true } }));
    }
    expect(onProgress).toHaveBeenLastCalledWith("first segment second segment");
    socket.emit(
      "message",
      JSON.stringify({ serverContent: { interimInputTranscription: { text: "third" } } }),
    );
    expect(onProgress).toHaveBeenLastCalledWith("first segment second segment third");
    transcription.appendAudio(audio);
    expect(sent).toHaveLength(3);
    expect(socket.close).not.toHaveBeenCalled();
    const completion = transcription.finish();
    await vi.waitFor(() => expect(sent).toHaveLength(4));
    expect(sent[3]).toEqual({ realtimeInput: { audioStreamEnd: true } });
    socket.emit(
      "message",
      JSON.stringify({
        serverContent: { inputTranscription: { text: "third segment" }, generationComplete: true },
      }),
    );
    await expect(completion).resolves.toBe("first segment second segment third segment");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls.filter(([url]) => String(url).endsWith("/responses"))).toHaveLength(
      1,
    );
    socket.emit(
      "message",
      JSON.stringify({ serverContent: { interimInputTranscription: { text: "late" } } }),
    );
    expect(onProgress).toHaveBeenLastCalledWith("first segment second segment third segment");
    expect(socket.close).toHaveBeenCalledTimes(1);
  });

  it.each(["abort", "error"])("ignores late previews after %s", async (outcome) => {
    const socket = new EventEmitter();
    socket.send = vi.fn((_data, callback) => callback?.());
    socket.close = vi.fn();
    socket.terminate = vi.fn();
    const onProgress = vi.fn();
    const transcription = startGeminiTranscription({
      apiKey: "key",
      onProgress,
      webSocketFactory: () => socket,
    });
    if (outcome === "abort") transcription.abort();
    else socket.emit("error", new Error("disconnected"));
    socket.emit(
      "message",
      JSON.stringify({ serverContent: { interimInputTranscription: { text: "late" } } }),
    );
    expect(onProgress).not.toHaveBeenCalled();
    await expect(transcription.finish()).rejects.toThrow();
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
        openAIApiKey: "openai-key",
        context: { messages: [{ role: "user", text: "Configure Acme SSO" }] },
        fetchImpl: vi.fn(() => keywordResponse.promise),
        webSocketFactory: vi.fn(() => socket),
      });
      socket.emit("open");

      await vi.advanceTimersByTimeAsync(14_900);
      keywordResponse.resolve(
        createJsonResponse({
          status: "completed",
          output: [
            {
              type: "message",
              status: "completed",
              content: [{ type: "output_text", text: JSON.stringify({ keywords: ["Acme SSO"] }) }],
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
        openAIApiKey: "openai-key",
        audio: Buffer.from("audio payload"),
        fetchImpl: fetchMock,
      }),
    ).rejects.toThrow("service unavailable");
    expect(getCall(fetchMock, "/v1beta/files/audio-1")[1].method).toBe("DELETE");
  });
});
