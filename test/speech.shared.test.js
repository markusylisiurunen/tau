import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { generateSpeechAudio, streamSpeechPcm } from "../dist/core/utils/speech.js";

const recorded = JSON.parse(
  readFileSync(new URL("./fixtures/elevenlabs_voice_responses.json", import.meta.url), "utf8"),
);
const unavailableVoice = () =>
  Response.json(recorded.unavailable.body, { status: recorded.unavailable.status });

const maisie = "QtY3JBOUKEB5xzrRfOKc";
const caleb = "AaOhDHYJ1XLZk74lXhdE";
const delivery = "[Brisk but relaxed, speaking naturally to a colleague] ";
const credentials = { openAIApiKey: "openai-key", elevenLabsApiKey: "eleven-key" };

function audioResponse(body) {
  return new Response(body, { headers: { "Content-Type": "audio/pcm" } });
}

function rewriteResponse(text) {
  return Response.json({
    status: "completed",
    output: [{ type: "message", status: "completed", content: [{ type: "output_text", text }] }],
  });
}

function speechFetch(text = "Spoken response.", handlers = {}) {
  return vi.fn(async (url, init) => {
    if (url.includes("api.openai.com"))
      return handlers.rewrite ? handlers.rewrite(url, init) : rewriteResponse(text);
    if (url.includes("/voices/")) {
      const voiceId = decodeURIComponent(url.split("/").at(-1));
      return handlers.voice ? handlers.voice(voiceId, init) : Response.json({ voice_id: voiceId });
    }
    return handlers.audio ? handlers.audio(url, init) : audioResponse(Buffer.from([1, 2, 3, 4]));
  });
}

async function collect(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

function requestedTranscripts(fetchMock) {
  return fetchMock.mock.calls
    .filter(([url]) => url.includes("/text-to-speech/"))
    .map(([, init]) => JSON.parse(init.body).text.slice(delivery.length));
}

function voiceRequests(fetchMock) {
  return fetchMock.mock.calls.filter(([url]) => url.includes("/voices/"));
}

function generate(fetchImpl, options = {}) {
  return collect(
    generateSpeechAudio({
      ...credentials,
      sourceText: "Original response.",
      fetchImpl,
      ...options,
    }),
  );
}

function pcm(fetchImpl, options = {}) {
  return streamSpeechPcm({
    ...credentials,
    sourceText: "Original response.",
    fetchImpl,
    ...options,
  });
}

describe("speech synthesis", () => {
  it("rewrites with Luna without reasoning and selects Maisie once before ElevenLabs synthesis", async () => {
    const fetchMock = speechFetch(undefined, {
      voice: () => Response.json(recorded.available.body),
    });
    const stages = [];
    const progress = [];
    const chunks = await generate(fetchMock, {
      onStageChange: (stage) => stages.push(stage),
      onSegmentProgress: (value) => progress.push(value),
    });
    expect(stages).toEqual(["rewriting", "generating"]);
    expect(progress).toEqual([
      { ready: 0, total: 1 },
      { ready: 1, total: 1 },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(3);
    const [rewriteUrl, rewrite] = fetchMock.mock.calls[0];
    expect(rewriteUrl).toBe("https://api.openai.com/v1/responses");
    expect(rewrite.headers.Authorization).toBe("Bearer openai-key");
    expect(JSON.parse(rewrite.body)).toEqual({
      model: "gpt-6-luna",
      reasoning: { effort: "none" },
      store: false,
      input: expect.stringContaining("Original response."),
    });
    const [url, init] = fetchMock.mock.calls[2];
    expect(url).toBe(
      `https://api.elevenlabs.io/v1/text-to-speech/${maisie}/stream?output_format=pcm_24000`,
    );
    expect(init.headers["xi-api-key"]).toBe("eleven-key");
    expect(JSON.parse(init.body)).toEqual({
      model_id: "eleven_v4_turbo",
      text: `${delivery}Spoken response.`,
    });
    expect(chunks).toHaveLength(1);
    expect(chunks[0].audio.toString("ascii", 0, 4)).toBe("RIFF");
    expect(chunks[0].audio.readUInt32LE(24)).toBe(24000);
    expect(chunks[0].audio.subarray(44)).toEqual(Buffer.from([1, 2, 3, 4]));
  });

  it("rejects an incomplete rewrite before starting synthesis", async () => {
    const fetchMock = speechFetch(undefined, {
      rewrite: () => Response.json({ status: "incomplete", output: [] }),
    });
    await expect(generate(fetchMock)).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("falls back only during lookup and locks Caleb for every segment", async () => {
    const fetchMock = speechFetch("A long sentence. ".repeat(300), {
      voice: (id) => (id === maisie ? unavailableVoice() : Response.json({ voice_id: id })),
    });
    const chunks = await generate(fetchMock);
    expect(chunks.length).toBeGreaterThan(1);
    expect(voiceRequests(fetchMock).map(([url]) => url.split("/").at(-1))).toEqual([maisie, caleb]);
    expect(
      fetchMock.mock.calls
        .filter(([url]) => url.includes("/text-to-speech/"))
        .every(([url]) => url.includes(caleb)),
    ).toBe(true);
  });

  it("does not treat a recorded missing-permission response as an unavailable voice", async () => {
    const fetchMock = speechFetch(undefined, {
      voice: () =>
        Response.json(recorded.missingPermission.body, {
          status: recorded.missingPermission.status,
        }),
    });
    await expect(generate(fetchMock)).rejects.toThrow();
    expect(voiceRequests(fetchMock)).toHaveLength(1);
    expect(requestedTranscripts(fetchMock)).toEqual([]);
  });

  it("buffers initial PCM and preserves sample alignment across network chunks", async () => {
    const fetchMock = speechFetch(undefined, {
      audio: () =>
        audioResponse(
          new ReadableStream({
            start(controller) {
              controller.enqueue(Uint8Array.from([1]));
              controller.enqueue(Uint8Array.from([2, 3, 4]));
              controller.enqueue(Uint8Array.from([5, 6]));
              controller.close();
            },
          }),
        ),
    });
    const chunks = await collect(pcm(fetchMock, { initialBufferBytes: 4 }));
    expect(chunks.map((chunk) => chunk.audio)).toEqual([
      Buffer.from([1, 2, 3, 4]),
      Buffer.from([5, 6]),
    ]);
  });

  it("cancels the body on early consumption and does not replay partial audio", async () => {
    const cancel = vi.fn();
    let controller;
    const fetchMock = speechFetch(undefined, {
      audio: () =>
        audioResponse(
          new ReadableStream({
            start(value) {
              controller = value;
              value.enqueue(Buffer.from([1, 2]));
            },
            cancel,
          }),
        ),
    });
    const stream = pcm(fetchMock);
    expect((await stream.next()).value.audio).toEqual(Buffer.from([1, 2]));
    await stream.return();
    expect(cancel).toHaveBeenCalledOnce();
    expect(requestedTranscripts(fetchMock)).toHaveLength(1);

    const failingFetch = speechFetch(undefined, {
      audio: () =>
        audioResponse(
          new ReadableStream({
            start(value) {
              controller = value;
              value.enqueue(Buffer.from([3, 4]));
            },
          }),
        ),
    });
    const failing = pcm(failingFetch);
    await failing.next();
    controller.error(new Error("stream interrupted"));
    await expect(failing.next()).rejects.toThrow();
    expect(voiceRequests(failingFetch)).toHaveLength(1);
    expect(requestedTranscripts(failingFetch)).toHaveLength(1);
  });

  it("aborts active generation when cancelled", async () => {
    const controller = new AbortController();
    const fetchMock = speechFetch(undefined, {
      audio: (_url, init) =>
        audioResponse(
          new ReadableStream({
            start(stream) {
              stream.enqueue(Buffer.from([1, 2]));
              init.signal.addEventListener("abort", () => stream.error(init.signal.reason), {
                once: true,
              });
            },
          }),
        ),
    });
    const stream = pcm(fetchMock, { signal: controller.signal });
    await stream.next();
    const pending = stream.next();
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: "AbortError" });
    expect(requestedTranscripts(fetchMock)).toHaveLength(1);
  });

  it("rejects misaligned PCM before producing audio", async () => {
    const fetchMock = speechFetch(undefined, { audio: () => audioResponse(Buffer.from([1])) });
    await expect(generate(fetchMock)).rejects.toThrow();
    expect(requestedTranscripts(fetchMock)).toHaveLength(1);
  });

  it("rejects successful non-PCM responses before playback", async () => {
    const fetchMock = speechFetch(undefined, {
      audio: () => Response.json({ error: "not audio" }),
    });
    await expect(collect(pcm(fetchMock))).rejects.toThrow();
    expect(requestedTranscripts(fetchMock)).toHaveLength(1);
  });

  it("bounds cumulative PCM across segments", async () => {
    const fetchMock = speechFetch("A long sentence. ".repeat(300), {
      audio: () => audioResponse(Buffer.alloc(17 * 1024 * 1024)),
    });
    await expect(
      collect(
        streamSpeechPcm({ ...credentials, sourceText: "Original response.", fetchImpl: fetchMock }),
      ),
    ).rejects.toThrow();
  });

  it("bounds source and rewritten Unicode text before synthesis", async () => {
    const sourceFetch = vi.fn();
    await expect(generate(sourceFetch, { sourceText: "😀".repeat(10001) })).rejects.toThrow();
    expect(sourceFetch).not.toHaveBeenCalled();
    const fetchMock = speechFetch("語".repeat(10001));
    await expect(generate(fetchMock)).rejects.toThrow();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("cancels a rewrite after one minute", async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi.fn(
        (_url, init) =>
          new Promise((_, reject) => {
            init.signal.addEventListener("abort", () => reject(init.signal.reason), { once: true });
          }),
      );
      const rejection = expect(generate(fetchMock)).rejects.toThrow();
      await vi.advanceTimersByTimeAsync(60000);
      await rejection;
      expect(fetchMock).toHaveBeenCalledTimes(1);
    } finally {
      vi.useRealTimers();
    }
  });
});
