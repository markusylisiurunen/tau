import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runToolCommand } from "../dist/core/tool/cli.js";
import { assembleSpeechWav } from "../dist/core/tool/speech_generate.js";

const roots = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixture() {
  const cwd = await mkdtemp(join(tmpdir(), "tau-media-test-"));
  roots.push(cwd);
  const stdout = vi.fn();
  const fetchImpl = vi.fn();
  return {
    cwd,
    stdout,
    fetchImpl,
    env: {},
    config: { apiKeys: { openai: "openai-key", google: "google-key", elevenlabs: "eleven-key" } },
  };
}

async function png(color = "red") {
  return sharp({ create: { width: 8, height: 8, channels: 3, background: color } })
    .png()
    .toBuffer();
}

const imageArgs = [
  "image-generate",
  "--model",
  "gpt-image-2.5-flare",
  "--prompt",
  "an otter",
  "--output",
  "image.png",
];
const speechArgs = [
  "speech-generate",
  "--model",
  "eleven_v4",
  "--input",
  "script.json",
  "--output",
  "speech.wav",
];

async function script(options, chunks) {
  await writeFile(
    join(options.cwd, "script.json"),
    JSON.stringify({ voices: { host: "host-id", guest: "guest-id" }, chunks }),
  );
}

function pcmResponse(samples, id) {
  const data = Buffer.alloc(samples.length * 2);
  samples.forEach((sample, index) => {
    data.writeInt16LE(sample, index * 2);
  });
  return new Response(data, {
    headers: {
      "content-type": "application/octet-stream",
      "request-id": id,
      "character-cost": "100",
    },
  });
}

describe("image generation CLI", () => {
  it("dispatches native generation with command-local credentials and publishes only a complete image", async () => {
    const options = await fixture();
    options.env.OPENAI_API_KEY = "env-key";
    const image = await png();
    options.fetchImpl.mockResolvedValue(
      Response.json({
        data: [{ b64_json: image.toString("base64") }],
        usage: { output_tokens: 1000 },
      }),
    );
    await runToolCommand([...imageArgs, "--quality", "max", "--size", "1536x1024"], options);
    const [url, request] = options.fetchImpl.mock.calls[0];
    expect(url).toBe("https://api.openai.com/v1/images/generations");
    expect(request.headers.Authorization).toBe("Bearer env-key");
    expect(JSON.parse(request.body)).toEqual({
      model: "gpt-image-2.5-flare",
      prompt: "an otter",
      n: 1,
      output_format: "png",
      quality: "max",
      size: "1536x1024",
    });
    expect(await readFile(join(options.cwd, "image.png"))).toEqual(image);
    expect(JSON.parse(options.stdout.mock.calls[0][0]).usage).toEqual({ output_tokens: 1000 });
    await expect(runToolCommand(imageArgs, options)).rejects.toThrow("already exists");
    expect(options.fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("preserves ordered reference bytes through the edit endpoint without resizing", async () => {
    const options = await fixture();
    const first = await png();
    const second = await png("blue");
    await writeFile(join(options.cwd, "a.png"), first);
    await writeFile(join(options.cwd, "b.png"), second);
    options.fetchImpl.mockResolvedValue(
      Response.json({ data: [{ b64_json: first.toString("base64") }] }),
    );
    await runToolCommand(
      [...imageArgs, "--reference", "a.png", "--reference", "b.png", "--background", "transparent"],
      options,
    );
    const [url, { body }] = options.fetchImpl.mock.calls[0];
    expect(url).toBe("https://api.openai.com/v1/images/edits");
    expect(body.get("background")).toBe("transparent");
    expect(
      await Promise.all(
        body.getAll("image[]").map(async (file) => Buffer.from(await file.arrayBuffer())),
      ),
    ).toEqual([first, second]);
  });

  it("maps Gemini capabilities and ignores thought images when selecting the final artifact", async () => {
    const options = await fixture();
    const image = await png();
    options.fetchImpl.mockResolvedValue(
      Response.json({
        candidates: [
          {
            finishReason: "STOP",
            content: {
              parts: [
                {
                  thought: true,
                  inlineData: {
                    mimeType: "image/png",
                    data: (await png("blue")).toString("base64"),
                  },
                },
                { inlineData: { mimeType: "image/png", data: image.toString("base64") } },
              ],
            },
          },
        ],
        usageMetadata: { candidatesTokenCount: 1120 },
      }),
    );
    await runToolCommand(
      [
        "image-generate",
        "--model",
        "gemini-3.1-flash-image",
        "--prompt",
        "landscape",
        "--aspect-ratio",
        "16:9",
        "--resolution",
        "2K",
        "--thinking",
        "high",
        "--output",
        "image.png",
      ],
      options,
    );
    const [url, request] = options.fetchImpl.mock.calls[0];
    expect(url).toContain("/models/gemini-3.1-flash-image:generateContent");
    expect(JSON.parse(request.body).generationConfig).toEqual({
      responseModalities: ["TEXT", "IMAGE"],
      imageConfig: { aspectRatio: "16:9", imageSize: "2K" },
      thinkingConfig: { thinkingLevel: "HIGH" },
    });
    expect(await readFile(join(options.cwd, "image.png"))).toEqual(image);
  });

  it("rejects unsupported capabilities, invalid dimensions, and excluded options without paid calls", async () => {
    const options = await fixture();
    for (const args of [
      [...imageArgs, "--resolution", "4K"],
      [...imageArgs, "--size", "2048x2049"],
      [...imageArgs, "--compression", "50"],
      [...imageArgs, "--mask", "mask.png"],
      [...imageArgs, "--continue", "state.json"],
      [...imageArgs, "--grounding"],
      [
        "image-generate",
        "--model",
        "gemini-3.1-flash-lite-image",
        "--prompt",
        "a",
        "--output",
        "image.png",
        "--resolution",
        "4K",
      ],
    ]) {
      await expect(runToolCommand(args, options)).rejects.toThrow();
    }
    expect(options.fetchImpl).not.toHaveBeenCalled();
    expect(await readdir(options.cwd)).toEqual([]);
  });

  it("does not retry failures or publish refusals and cannot clobber a concurrently created output", async () => {
    const options = await fixture();
    options.fetchImpl.mockImplementation(async () => {
      await writeFile(join(options.cwd, "image.png"), "other writer");
      return Response.json({ data: [{ b64_json: (await png()).toString("base64") }] });
    });
    await expect(runToolCommand(imageArgs, options)).rejects.toThrow("artifacts:");
    expect(await readFile(join(options.cwd, "image.png"), "utf8")).toBe("other writer");
    expect(await stat(join(options.cwd, "image.png.parts", "image.png"))).toBeDefined();
    expect(options.fetchImpl).toHaveBeenCalledTimes(1);
    const failed = await fixture();
    failed.fetchImpl.mockResolvedValue(new Response("private error", { status: 429 }));
    await expect(runToolCommand(imageArgs, failed)).rejects.toThrow("HTTP 429");
    expect(failed.fetchImpl).toHaveBeenCalledTimes(1);
    await expect(stat(join(failed.cwd, "image.png"))).rejects.toThrow();
    const blocked = await fixture();
    blocked.fetchImpl.mockResolvedValue(
      Response.json({ promptFeedback: { blockReason: "SAFETY" } }),
    );
    await expect(
      runToolCommand(
        [
          "image-generate",
          "--model",
          "gemini-3-pro-image",
          "--prompt",
          "blocked prompt",
          "--output",
          "image.png",
        ],
        blocked,
      ),
    ).rejects.toThrow("did not return one completed image");
    await expect(stat(join(blocked.cwd, "image.png"))).rejects.toThrow();
    expect(blocked.fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("speech generation CLI", () => {
  it("packs whole chunks, preserves speaker/text order, stitches completed requests, and writes valid ordered WAV", async () => {
    const options = await fixture();
    const chunks = [
      [{ speaker: "host", text: `[calm] ${"a".repeat(893)}` }],
      [{ speaker: "guest", text: "b".repeat(900) }],
      [{ speaker: "host", text: "c".repeat(900) }],
    ];
    await script(options, chunks);
    options.fetchImpl
      .mockResolvedValueOnce(pcmResponse([1, -2], "first"))
      .mockResolvedValueOnce(pcmResponse([3, -4], "second"));
    await runToolCommand(speechArgs, options);
    const calls = options.fetchImpl.mock.calls.map(([url, request]) => {
      expect(url).toContain("output_format=pcm_24000");
      expect(request.headers["xi-api-key"]).toBe("eleven-key");
      return JSON.parse(request.body);
    });
    expect(calls).toEqual([
      {
        model_id: "eleven_v4",
        inputs: [
          { voice_id: "host-id", text: chunks[0][0].text },
          { voice_id: "guest-id", text: chunks[1][0].text },
        ],
      },
      {
        model_id: "eleven_v4",
        inputs: [{ voice_id: "host-id", text: chunks[2][0].text }],
        previous_request_ids: ["first"],
      },
    ]);
    const wav = await readFile(join(options.cwd, "speech.wav"));
    expect(wav.subarray(0, 4).toString()).toBe("RIFF");
    expect(wav.readUInt32LE(4)).toBe(wav.length - 8);
    expect(wav.readUInt32LE(24)).toBe(24000);
    expect(wav.readUInt32LE(40)).toBe(8);
    expect([44, 46, 48, 50].map((offset) => wav.readInt16LE(offset))).toEqual([1, -2, 3, -4]);
    const manifest = JSON.parse(
      await readFile(join(options.cwd, "speech.wav.parts", "manifest.json"), "utf8"),
    );
    expect(
      manifest.batches.map(({ chunks, completed, requestId }) => ({
        chunks,
        completed,
        requestId,
      })),
    ).toEqual([
      { chunks: [1, 2], completed: true, requestId: "first" },
      { chunks: [3], completed: true, requestId: "second" },
    ]);
  });

  it("validates every chunk before generating or creating artifacts", async () => {
    const options = await fixture();
    await script(options, [
      [{ speaker: "host", text: "valid" }],
      [{ speaker: "guest", text: "x".repeat(2001) }],
    ]);
    await expect(runToolCommand(speechArgs, options)).rejects.toThrow("chunk 2 has 2001");
    await script(options, [
      [{ speaker: "host", text: "valid" }],
      [{ speaker: "missing", text: "hi" }],
    ]);
    await expect(runToolCommand(speechArgs, options)).rejects.toThrow("unknown speaker");
    expect(options.fetchImpl).not.toHaveBeenCalled();
    expect(await readdir(options.cwd)).toEqual(["script.json"]);
  });

  it("retains completed PCM and the batch plan on later failure without publishing a partial WAV or retrying", async () => {
    const options = await fixture();
    await script(options, [
      [{ speaker: "host", text: "x".repeat(1500) }],
      [{ speaker: "guest", text: "y".repeat(1500) }],
    ]);
    options.fetchImpl
      .mockResolvedValueOnce(pcmResponse([42], "first"))
      .mockResolvedValueOnce(new Response("error", { status: 503 }));
    await expect(runToolCommand(speechArgs, options)).rejects.toThrow(
      "completed batches and manifest retained",
    );
    expect(options.fetchImpl).toHaveBeenCalledTimes(2);
    await expect(stat(join(options.cwd, "speech.wav"))).rejects.toThrow();
    expect(
      (await readFile(join(options.cwd, "speech.wav.parts", "batch-0001.pcm"))).readInt16LE(),
    ).toBe(42);
    const manifest = JSON.parse(
      await readFile(join(options.cwd, "speech.wav.parts", "manifest.json"), "utf8"),
    );
    expect(manifest.batches.map((batch) => batch.completed)).toEqual([true, false]);
    await expect(runToolCommand(speechArgs, options)).rejects.toThrow();
    expect(options.fetchImpl).toHaveBeenCalledTimes(2);
  });

  it("does not mark an interrupted response as reusable", async () => {
    const options = await fixture();
    await script(options, [[{ speaker: "host", text: "hello" }]]);
    let reads = 0;
    options.fetchImpl.mockResolvedValue(
      new Response(
        new ReadableStream({
          pull(controller) {
            if (reads++ === 0) {
              controller.enqueue(new Uint8Array([1, 0]));
            } else {
              controller.error(new Error("connection lost"));
            }
          },
        }),
      ),
    );
    await expect(runToolCommand(speechArgs, options)).rejects.toThrow();
    await expect(stat(join(options.cwd, "speech.wav"))).rejects.toThrow();
    await expect(stat(join(options.cwd, "speech.wav.parts", "batch-0001.pcm"))).rejects.toThrow();
  });

  it("assembles thirty minutes of disk-backed PCM beyond the existing speech helper's 32 MiB cap", async () => {
    const options = await fixture();
    const chunk = Buffer.alloc(24000 * 2 * 60, 7);
    const paths = [];
    for (let index = 0; index < 30; index++) {
      const path = join(options.cwd, `${index}.pcm`);
      await writeFile(path, chunk);
      paths.push(path);
    }
    const output = join(options.cwd, "long.wav");
    await assembleSpeechWav(paths, output);
    expect((await stat(output)).size).toBe(24000 * 2 * 60 * 30 + 44);
  });

  it("lists all voice pages without generation and uses environment credential precedence", async () => {
    const options = await fixture();
    options.env.ELEVENLABS_API_KEY = "env-eleven";
    options.fetchImpl
      .mockResolvedValueOnce(
        Response.json({
          voices: [{ voice_id: "a", name: "A" }],
          has_more: true,
          next_page_token: "next",
        }),
      )
      .mockResolvedValueOnce(
        Response.json({ voices: [{ voice_id: "b", name: "B" }], has_more: false }),
      );
    await runToolCommand(["speech-generate", "--list-voices"], options);
    expect(options.fetchImpl.mock.calls[1][0]).toContain("next_page_token=next");
    expect(options.fetchImpl.mock.calls[0][1].headers["xi-api-key"]).toBe("env-eleven");
    expect(options.stdout.mock.calls.map(([line]) => JSON.parse(line).voice_id)).toEqual([
      "a",
      "b",
    ]);
  });
});
