import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterEach, describe, expect, it, vi } from "vitest";
import { printToolHelp, runToolCommand } from "../dist/core/tool/cli.js";
import { printImageGenerateHelp } from "../dist/core/tool/image_generate.js";
import { printPdfUnpackHelp } from "../dist/core/tool/pdf_unpack.js";
import { assembleSpeechWav, printSpeechGenerateHelp } from "../dist/core/tool/speech_generate.js";

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

function geminiImageResponse(image, format) {
  return Response.json({
    candidates: [
      {
        finishReason: "STOP",
        content: {
          parts: [{ inlineData: { mimeType: `image/${format}`, data: image.toString("base64") } }],
        },
      },
    ],
    usageMetadata: { candidatesTokenCount: 1120 },
  });
}

async function readManifest(options, output) {
  return JSON.parse(await readFile(join(options.cwd, `${output}.parts`, "manifest.json"), "utf8"));
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

describe("standalone tool help", () => {
  it.each([
    [printToolHelp, "tools.md"],
    [printPdfUnpackHelp, "pdf-unpacking.md"],
    [printImageGenerateHelp, "image-generation.md"],
    [printSpeechGenerateHelp, "speech-generation.md"],
  ])("provides usage and public documentation for %s", (printHelp, guide) => {
    const log = vi.fn();
    printHelp(log);
    const text = log.mock.calls.map(([line]) => line).join("\n");
    expect(text).toContain("usage:");
    expect(text).toContain(`https://github.com/markusylisiurunen/tau/blob/main/docs/${guide}`);
    expect(text).not.toContain("tau_docs");
  });
});

describe("media output preparation", () => {
  it.each([imageArgs, speechArgs])(
    "protects output and artifacts before requests: %s",
    async (...args) => {
      const options = await fixture();
      await script(options, [[{ speaker: "host", text: "hello" }]]);
      const output = join(options.cwd, args.at(-1));
      await writeFile(output, "existing output");
      await expect(runToolCommand(args, options)).rejects.toThrow();
      expect(await readFile(output, "utf8")).toBe("existing output");
      const freshArgs = [...args.slice(0, -1), `fresh-${args.at(-1)}`];
      const parts = join(options.cwd, `${freshArgs.at(-1)}.parts`);
      await mkdir(parts);
      await writeFile(join(parts, "recovery"), "retained");
      await expect(runToolCommand(freshArgs, options)).rejects.toThrow();
      expect(await readFile(join(parts, "recovery"), "utf8")).toBe("retained");
      await expect(
        runToolCommand([...args.slice(0, -1), `missing/${args.at(-1)}`], options),
      ).rejects.toThrow();
      expect(options.fetchImpl).not.toHaveBeenCalled();
      expect(options.stdout).not.toHaveBeenCalled();
    },
  );

  it("rejects unreadable input before requests or artifact creation", async () => {
    const options = await fixture();
    await expect(
      runToolCommand(
        [...imageArgs.slice(0, 3), "--prompt-file", "missing.txt", ...imageArgs.slice(5)],
        options,
      ),
    ).rejects.toThrow();
    expect(options.fetchImpl).not.toHaveBeenCalled();
    expect(await readdir(options.cwd)).toEqual([]);
  });
});

describe("image generation CLI", () => {
  it("requires an explicit model before generating or creating artifacts", async () => {
    const options = await fixture();
    await expect(runToolCommand([imageArgs[0], ...imageArgs.slice(3)], options)).rejects.toThrow();
    expect(options.fetchImpl).not.toHaveBeenCalled();
    expect(await readdir(options.cwd)).toEqual([]);
  });

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
    await expect(runToolCommand(imageArgs, options)).rejects.toThrow();
    expect(options.fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("normalizes OpenAI encoding controls before building the provider request", async () => {
    const options = await fixture();
    const image = await sharp(await png())
      .jpeg()
      .toBuffer();
    options.fetchImpl.mockResolvedValue(
      Response.json({ data: [{ b64_json: image.toString("base64") }] }),
    );
    await runToolCommand(
      [
        ...imageArgs.slice(0, -1),
        "image.jpg",
        "--size",
        "auto",
        "--quality",
        "low",
        "--format",
        "jpeg",
        "--compression",
        "100",
      ],
      options,
    );
    expect(JSON.parse(options.fetchImpl.mock.calls[0][1].body)).toMatchObject({
      size: "auto",
      quality: "low",
      output_format: "jpeg",
      output_compression: 100,
    });
    expect(await readFile(join(options.cwd, "image.jpg"))).toEqual(image);
  });

  it("preserves ordered reference bytes through the edit endpoint without resizing", async () => {
    const options = await fixture();
    const first = await png();
    const second = await png("blue");
    await writeFile(join(options.cwd, "a.png"), first);
    await writeFile(join(options.cwd, "b.png"), second);
    const result = await sharp(first).ensureAlpha(0.5).png().toBuffer();
    options.fetchImpl.mockResolvedValue(
      Response.json({ data: [{ b64_json: result.toString("base64") }] }),
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

  it.each(["png", "jpeg", "webp"])(
    "normalizes Gemini %s images to PNG while retaining the original and usage",
    async (format) => {
      const options = await fixture();
      const image = await sharp(await png())
        .toFormat(format)
        .toBuffer();
      options.fetchImpl.mockResolvedValue(geminiImageResponse(image, format));
      await runToolCommand(
        [...imageArgs.slice(0, 2), "gemini-3.1-flash-lite-image", ...imageArgs.slice(3)],
        options,
      );
      const output = await readFile(join(options.cwd, "image.png"));
      expect((await sharp(output).metadata()).format).toBe("png");
      expect(await sharp(output).raw().toBuffer()).toEqual(await sharp(image).raw().toBuffer());
      expect(await readFile(join(options.cwd, "image.png.parts", "original.bin"))).toEqual(image);
      const manifest = await readManifest(options, "image.png");
      expect(manifest.source).toEqual({
        file: "original.bin",
        declaredMimeType: `image/${format}`,
      });
      expect(manifest.usage).toEqual({ candidatesTokenCount: 1120 });
      expect(JSON.parse(options.stdout.mock.calls[0][0]).usage).toEqual(manifest.usage);
      expect(options.fetchImpl).toHaveBeenCalledTimes(1);
    },
  );

  it("retains the original and usage if Gemini PNG conversion fails", async () => {
    const options = await fixture();
    const image = Buffer.from("incomplete image data");
    options.fetchImpl.mockResolvedValue(geminiImageResponse(image, "jpeg"));
    await expect(
      runToolCommand(
        [...imageArgs.slice(0, 2), "gemini-3.1-flash-lite-image", ...imageArgs.slice(3)],
        options,
      ),
    ).rejects.toThrow();
    await expect(stat(join(options.cwd, "image.png"))).rejects.toThrow();
    expect(await readFile(join(options.cwd, "image.png.parts", "original.bin"))).toEqual(image);
    const manifest = await readManifest(options, "image.png");
    expect(manifest.usage).toEqual({ candidatesTokenCount: 1120 });
    expect(options.fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("writes OpenAI image bytes as returned by the provider", async () => {
    const options = await fixture();
    const image = Buffer.from("provider image bytes");
    options.fetchImpl.mockResolvedValue(
      Response.json({
        data: [{ b64_json: image.toString("base64") }],
        usage: { output_tokens: 100 },
      }),
    );
    await runToolCommand(imageArgs, options);
    expect(await readFile(join(options.cwd, "image.png"))).toEqual(image);
    expect(JSON.parse(options.stdout.mock.calls[0][0]).usage).toEqual({ output_tokens: 100 });
    expect(options.fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each(["plain", "escaped"])(
    "rejects oversized serialized Gemini %s prompts without references or paid calls",
    async (kind) => {
      const options = await fixture();
      const prompt = kind === "plain" ? "a".repeat(19_000_000) : `x${"\n".repeat(9_500_000)}`;
      await writeFile(join(options.cwd, "prompt.txt"), prompt);
      await expect(
        runToolCommand(
          [
            "image-generate",
            "--model",
            "gemini-3.1-flash-lite-image",
            "--prompt-file",
            "prompt.txt",
            "--output",
            "image.png",
          ],
          options,
        ),
      ).rejects.toThrow();
      expect(options.fetchImpl).not.toHaveBeenCalled();
      expect(await readdir(options.cwd)).toEqual(["prompt.txt"]);
    },
  );

  it("rejects unsupported capabilities, invalid dimensions, and excluded options without paid calls", async () => {
    const options = await fixture();
    for (const args of [
      [...imageArgs, "--resolution", "4K"],
      [...imageArgs, "--size", "2048x2049"],
      [...imageArgs, "--compression", "50"],
      [...imageArgs, "--compression", "101", "--format", "jpeg"],
      [...imageArgs, "--mask", "mask.png"],
      [...imageArgs, "--continue", "state.json"],
      [...imageArgs, "--grounding"],
      [...imageArgs, "--background", "transparent", "--format", "jpeg", "--output", "image.jpg"],
      [
        ...imageArgs.slice(0, 2),
        "gemini-3.1-flash-lite-image",
        ...imageArgs.slice(3),
        "--background",
        "transparent",
      ],
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

  it.each([
    ["gemini-3-pro-image", "--resolution", "512"],
    ["gemini-3-pro-image", "--aspect-ratio", "8:1"],
    ["gemini-3-pro-image", "--thinking", "high"],
    ["gemini-3.1-flash-lite-image", "--resolution", "2K"],
    ["gemini-3.1-flash-image", "--quality", "high"],
    ["gpt-image-2.5-flare", "--thinking", "minimal"],
  ])("rejects %s %s %s at the model settings boundary", async (model, flag, value) => {
    const options = await fixture();
    await expect(
      runToolCommand(
        [...imageArgs.slice(0, 2), model, ...imageArgs.slice(3), flag, value],
        options,
      ),
    ).rejects.toThrow();
    expect(options.fetchImpl).not.toHaveBeenCalled();
    expect(await readdir(options.cwd)).toEqual([]);
  });

  it.each(["not json", JSON.stringify({ data: [{}] })])(
    "rejects malformed provider responses without publishing output or retrying",
    async (body) => {
      const options = await fixture();
      options.fetchImpl.mockResolvedValue(new Response(body));
      await expect(runToolCommand(imageArgs, options)).rejects.toThrow();
      expect(options.fetchImpl).toHaveBeenCalledTimes(1);
      expect(options.stdout).not.toHaveBeenCalled();
      await expect(stat(join(options.cwd, "image.png"))).rejects.toThrow();
    },
  );

  it("does not retry failures or publish refusals and cannot clobber a concurrently created output", async () => {
    const options = await fixture();
    options.fetchImpl.mockImplementation(async () => {
      await writeFile(join(options.cwd, "image.png"), "other writer");
      return Response.json({ data: [{ b64_json: (await png()).toString("base64") }] });
    });
    await expect(runToolCommand(imageArgs, options)).rejects.toThrow();
    expect(await readFile(join(options.cwd, "image.png"), "utf8")).toBe("other writer");
    expect(await stat(join(options.cwd, "image.png.parts", "image.png"))).toBeDefined();
    expect(options.fetchImpl).toHaveBeenCalledTimes(1);
    const failed = await fixture();
    failed.fetchImpl.mockResolvedValue(new Response("private error", { status: 429 }));
    await expect(runToolCommand(imageArgs, failed)).rejects.toThrow();
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
    ).rejects.toThrow();
    await expect(stat(join(blocked.cwd, "image.png"))).rejects.toThrow();
    expect(blocked.fetchImpl).toHaveBeenCalledTimes(1);
  });
});

describe("speech generation CLI", () => {
  it.each(["eleven_v4_turbo", "eleven_v4"])(
    "generates %s with ordered chunks, request stitching, and valid WAV",
    async (model) => {
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
      await runToolCommand([...speechArgs.slice(0, 2), model, ...speechArgs.slice(3)], options);
      const calls = options.fetchImpl.mock.calls.map(([url, request]) => {
        expect(url).toContain("output_format=pcm_24000");
        expect(request.headers["xi-api-key"]).toBe("eleven-key");
        return JSON.parse(request.body);
      });
      expect(calls).toEqual([
        {
          model_id: model,
          inputs: [
            { voice_id: "host-id", text: chunks[0][0].text },
            { voice_id: "guest-id", text: chunks[1][0].text },
          ],
        },
        {
          model_id: model,
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
      const manifest = await readManifest(options, "speech.wav");
      expect(manifest.model).toBe(model);
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
    },
  );

  it("requires an explicit supported model before generating or creating artifacts", async () => {
    const options = await fixture();
    await expect(
      runToolCommand([speechArgs[0], ...speechArgs.slice(3)], options),
    ).rejects.toThrow();
    await expect(
      runToolCommand([...speechArgs.slice(0, 2), "unknown", ...speechArgs.slice(3)], options),
    ).rejects.toThrow();
    expect(options.fetchImpl).not.toHaveBeenCalled();
    expect(await readdir(options.cwd)).toEqual([]);
  });

  it("validates every chunk before generating or creating artifacts", async () => {
    const options = await fixture();
    await script(options, [
      [{ speaker: "host", text: "valid" }],
      [{ speaker: "guest", text: "x".repeat(2001) }],
    ]);
    await expect(runToolCommand(speechArgs, options)).rejects.toThrow();
    await script(options, [
      [{ speaker: "host", text: "valid" }],
      [{ speaker: "missing", text: "hi" }],
    ]);
    await expect(runToolCommand(speechArgs, options)).rejects.toThrow();
    expect(options.fetchImpl).not.toHaveBeenCalled();
    expect(await readdir(options.cwd)).toEqual(["script.json"]);
  });

  it.each([
    "{broken",
    JSON.stringify({ voices: { host: "voice" }, chunks: [[{ speaker: "host" }]] }),
  ])("rejects malformed scripts before requests or artifact creation", async (text) => {
    const options = await fixture();
    await writeFile(join(options.cwd, "script.json"), text);
    await expect(runToolCommand(speechArgs, options)).rejects.toThrow();
    expect(options.fetchImpl).not.toHaveBeenCalled();
    expect(await readdir(options.cwd)).toEqual(["script.json"]);
  });

  it("retains the completed WAV without overwriting concurrently created output", async () => {
    const options = await fixture();
    await script(options, [[{ speaker: "host", text: "hello" }]]);
    options.fetchImpl.mockImplementation(async () => {
      await writeFile(join(options.cwd, "speech.wav"), "other writer");
      return pcmResponse([42], "first");
    });
    await expect(runToolCommand(speechArgs, options)).rejects.toThrow();
    expect(await readFile(join(options.cwd, "speech.wav"), "utf8")).toBe("other writer");
    expect(
      (await readFile(join(options.cwd, "speech.wav.parts", "assembled.wav")))
        .subarray(0, 4)
        .toString(),
    ).toBe("RIFF");
    expect(options.fetchImpl).toHaveBeenCalledTimes(1);
    expect(options.stdout).not.toHaveBeenCalled();
  });

  it("rejects malformed voice listings without emitting invalid JSON lines", async () => {
    const options = await fixture();
    options.fetchImpl.mockResolvedValue(Response.json({ voices: [{}] }));
    await expect(runToolCommand(["speech-generate", "--list-voices"], options)).rejects.toThrow();
    expect(options.stdout).not.toHaveBeenCalled();
    expect(options.fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("stitches only the last three completed requests and counts Unicode code points", async () => {
    const options = await fixture();
    await script(
      options,
      Array.from({ length: 5 }, () => [{ speaker: "host", text: "🌲".repeat(1001) }]),
    );
    let calls = 0;
    options.fetchImpl.mockImplementation(async () => pcmResponse([42], `request-${++calls}`));
    await runToolCommand(speechArgs, options);
    expect(
      options.fetchImpl.mock.calls.map(
        ([, request]) => JSON.parse(request.body).previous_request_ids ?? [],
      ),
    ).toEqual([
      [],
      ["request-1"],
      ["request-1", "request-2"],
      ["request-1", "request-2", "request-3"],
      ["request-2", "request-3", "request-4"],
    ]);
    const manifest = await readManifest(options, "speech.wav");
    expect(
      manifest.batches.map(({ characters, characterCost }) => ({ characters, characterCost })),
    ).toEqual(Array.from({ length: 5 }, () => ({ characters: 1001, characterCost: "100" })));
  });

  it("retains the completed batch but stops before another paid request when its ID is missing", async () => {
    const options = await fixture();
    await script(options, [
      [{ speaker: "host", text: "a".repeat(1500) }],
      [{ speaker: "guest", text: "b".repeat(1500) }],
    ]);
    const response = pcmResponse([42], "first");
    response.headers.delete("request-id");
    options.fetchImpl.mockResolvedValue(response);
    await expect(runToolCommand(speechArgs, options)).rejects.toThrow();
    expect(options.fetchImpl).toHaveBeenCalledTimes(1);
    const manifest = await readManifest(options, "speech.wav");
    expect(manifest.batches[0]).toMatchObject({
      completed: true,
      requestId: null,
      characterCost: "100",
    });
    expect(manifest.batches[1].completed).toBe(false);
    expect(await readFile(join(options.cwd, "speech.wav.parts", "batch-0001.pcm"))).toEqual(
      Buffer.from([42, 0]),
    );
    await expect(stat(join(options.cwd, "speech.wav"))).rejects.toThrow();
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
    await expect(runToolCommand(speechArgs, options)).rejects.toThrow();
    expect(options.fetchImpl).toHaveBeenCalledTimes(2);
    await expect(stat(join(options.cwd, "speech.wav"))).rejects.toThrow();
    expect(
      (await readFile(join(options.cwd, "speech.wav.parts", "batch-0001.pcm"))).readInt16LE(),
    ).toBe(42);
    const manifest = await readManifest(options, "speech.wav");
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
        { headers: { "request-id": "interrupted", "character-cost": "83" } },
      ),
    );
    await expect(runToolCommand(speechArgs, options)).rejects.toThrow();
    await expect(stat(join(options.cwd, "speech.wav"))).rejects.toThrow();
    await expect(stat(join(options.cwd, "speech.wav.parts", "batch-0001.pcm"))).rejects.toThrow();
    const manifest = await readManifest(options, "speech.wav");
    expect(manifest.batches[0]).toMatchObject({
      completed: false,
      requestId: "interrupted",
      characterCost: "83",
    });
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
