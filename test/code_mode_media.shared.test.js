import { spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { createFilesPackage } from "../dist/core/code_mode/files.js";
import { createModelsPackage } from "../dist/core/code_mode/models.js";
import { createPdfPackage } from "../dist/core/code_mode/pdf.js";
import { createFlySpriteToolExecutionBackend } from "../dist/execution/fly_sprite_execution_environment.js";

const context = { signal: new AbortController().signal };
let backend, root, files, models, fetchImpl;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "tau-media-"));
  backend = createFlySpriteToolExecutionBackend({
    cwd: root,
    sprite: { spawn: (cmd, args, opts) => spawn(cmd, args, { ...opts, stdio: "pipe" }) },
  });
  fetchImpl = vi.fn();
  files = createFilesPackage(backend).api;
  models = createModelsPackage(
    backend,
    { apiKeys: { openai: "test", google: "test", elevenlabs: "test" } },
    { available: false, reason: "no OpenRouter key" },
    fetchImpl,
  ).api;
});
afterEach(async () => {
  await backend.dispose();
  await rm(root, { recursive: true, force: true });
});
it("publishes an image through the Sprite backend without requiring OpenRouter and refuses to overwrite it", async () => {
  const png = await sharp({ create: { width: 1, height: 1, channels: 3, background: "red" } })
    .png()
    .toBuffer();
  const args = ["otter", { model: "gpt-image-2.6-flare", outputPath: "otter.png" }];
  fetchImpl.mockResolvedValueOnce(
    Response.json({ data: [{ b64_json: png.toString("base64") }], usage: { output_tokens: 10 } }),
  );
  const result = await models.generateImage(args, context);
  expect(result.usage).toEqual({ output_tokens: 10 });
  expect(Array.from(await files.readBytes([result.outputPath], context))).toEqual([...png]);
  await expect(models.generateImage(args, context)).rejects.toThrow();
  expect(fetchImpl).toHaveBeenCalledTimes(1);
});
it("rejects incompatible image settings before creating recovery artifacts", async () => {
  await expect(
    models.generateImage(
      [
        "otter",
        { model: "gpt-image-2.6-flare", outputPath: "otter.png", settings: { resolution: "4K" } },
      ],
      context,
    ),
  ).rejects.toMatchObject({ code: "invalid_arguments" });
  expect((await backend.listDir(".")).entries).toEqual([]);
  expect(fetchImpl).not.toHaveBeenCalled();
});
it("reports operations without a key as unavailable before any request or output", async () => {
  const unconfigured = createModelsPackage(
    backend,
    { apiKeys: {} },
    { available: false, reason: "no OpenRouter key" },
    fetchImpl,
  ).api;
  const pdf = createPdfPackage(backend, { apiKeys: {} }).api;
  await backend.writeFile("doc.pdf", "%PDF-1.4");
  const calls = [
    () =>
      unconfigured.generateImage(
        ["otter", { model: "gpt-image-2.6-flare", outputPath: "a.png" }],
        context,
      ),
    () =>
      unconfigured.generateImage(
        ["otter", { model: "gemini-nano-banana-2.1", outputPath: "b.png" }],
        context,
      ),
    () => unconfigured.generateSpeech([script, options], context),
    () => unconfigured.listVoices([{ model: "eleven_v4" }], context),
    () => pdf.unpack(["doc.pdf"], context),
  ];
  for (const call of calls) await expect(call()).rejects.toMatchObject({ code: "unavailable" });
  expect((await backend.listDir(".")).entries.map(({ name }) => name)).toEqual(["doc.pdf"]);
  expect(fetchImpl).not.toHaveBeenCalled();
});
const script = { voices: { host: "voice" }, chunks: [[{ speaker: "host", text: "one" }]] };
const options = { model: "eleven_v4", outputPath: "speech.wav" };
it("writes mono PCM to a WAV in the session directory", async () => {
  const chunk = Buffer.alloc(64 * 1024, 1);
  const pcm = Buffer.concat([...Array(17).fill(chunk), Buffer.from([2, 3])]);
  const writes = vi.spyOn(backend, "runNodeScript");
  fetchImpl.mockResolvedValueOnce(
    new Response(
      new ReadableStream({
        start(controller) {
          for (let offset = 0; offset < pcm.length; offset += chunk.length) {
            controller.enqueue(pcm.subarray(offset, offset + chunk.length));
          }
          controller.close();
        },
      }),
    ),
  );
  const result = await models.generateSpeech([script, options], context);
  const wav = Buffer.from(await files.readBytes([result.outputPath], context));
  expect(wav.toString("ascii", 0, 4)).toBe("RIFF");
  expect(wav.readUInt32LE(24)).toBe(24000);
  expect(wav.subarray(44).equals(pcm)).toBe(true);
  expect(
    writes.mock.calls
      .filter(([script]) => script.includes("fs.appendFileSync"))
      .map(([, , options]) => options.stdin.length),
  ).toEqual([1024 * 1024, chunk.length + 2]);
});
it("retains completed speech batches after a later provider failure", async () => {
  fetchImpl
    .mockResolvedValueOnce(
      new Response(Uint8Array.of(1, 2), { headers: { "request-id": "first" } }),
    )
    .mockResolvedValueOnce(new Response(null, { status: 503 }));
  await expect(
    models.generateSpeech(
      [
        { ...script, chunks: [[{ speaker: "host", text: "a".repeat(2000) }], ...script.chunks] },
        options,
      ],
      context,
    ),
  ).rejects.toThrow();
  expect(fetchImpl).toHaveBeenCalledTimes(2);
  expect(JSON.parse(fetchImpl.mock.calls[1][1].body).previous_request_ids).toEqual(["first"]);
  const manifest = JSON.parse(await files.readText(["speech.wav.parts/manifest.json"], context));
  expect(manifest.batches[0]).toMatchObject({ requestId: "first", bytes: 2 });
  expect([
    ...(await files.readBytes([`speech.wav.parts/${manifest.batches[0].file}`], context)),
  ]).toEqual([1, 2]);
  await expect(files.readBytes(["speech.wav"], context)).rejects.toThrow();
});
it("keeps downloaded PCM bytes and provider metadata when a batch stream fails", async () => {
  let sent = false;
  fetchImpl.mockResolvedValueOnce(
    new Response(
      new ReadableStream(
        {
          pull(controller) {
            if (sent) controller.error(new Error("download interrupted"));
            else {
              controller.enqueue(Uint8Array.of(4, 5));
              sent = true;
            }
          },
        },
        { highWaterMark: 0 },
      ),
      { headers: { "request-id": "interrupted", "character-cost": "3" } },
    ),
  );
  await expect(models.generateSpeech([script, options], context)).rejects.toThrow();
  expect([
    ...(await files.readBytes(["speech.wav.parts/batch-0001.pcm.partial"], context)),
  ]).toEqual([4, 5]);
  await expect(files.readBytes(["speech.wav.parts/batch-0001.pcm"], context)).rejects.toThrow();
  const manifest = JSON.parse(await files.readText(["speech.wav.parts/manifest.json"], context));
  expect(manifest.batches[0]).toMatchObject({
    requestId: "interrupted",
    characterCost: "3",
    bytes: 0,
  });
});
it("returns one page of provider voices", async () => {
  fetchImpl.mockResolvedValueOnce(
    Response.json({
      voices: [{ voice_id: "a", name: "A" }],
      has_more: true,
      next_page_token: "next",
    }),
  );
  expect(
    await models.listVoices([{ model: "eleven_v4", cursor: "start", limit: 5 }], context),
  ).toEqual({
    voices: [{ id: "a", name: "A" }],
    nextCursor: "next",
  });
  expect(new URL(fetchImpl.mock.calls[0][0]).searchParams.get("next_page_token")).toBe("start");
});

it("sends the original references in order and retains the completed edit when the output appears during generation", async () => {
  const images = await Promise.all(
    ["red", "blue"].map((background) =>
      sharp({ create: { width: 2, height: 2, channels: 3, background } })
        .png()
        .toBuffer(),
    ),
  );
  for (const [i, image] of images.entries()) await backend.writeFileBinary(`${i}.png`, image);
  fetchImpl.mockImplementationOnce(async (url, request) => {
    expect(url).toBe("https://api.openai.com/v1/images/edits");
    const refs = request.body.getAll("image[]");
    expect(
      await Promise.all(refs.map(async (ref) => Buffer.from(await ref.arrayBuffer()))),
    ).toEqual(images);
    await backend.writeFile("edit.png", "existing");
    return Response.json({ data: [{ b64_json: images[0].toString("base64") }] });
  });
  await expect(
    models.generateImage(
      [
        "edit",
        { model: "gpt-image-2.6-flare", outputPath: "edit.png", references: ["0.png", "1.png"] },
      ],
      context,
    ),
  ).rejects.toThrow();
  expect(await files.readText(["edit.png"], context)).toBe("existing");
  expect(Buffer.from(await files.readBytes(["edit.png.parts/image.png"], context))).toEqual(
    images[0],
  );
  expect(fetchImpl).toHaveBeenCalledTimes(1);
});
it("retains the paid Gemini response and usage when conversion fails", async () => {
  fetchImpl.mockResolvedValueOnce(
    Response.json({
      candidates: [
        {
          finishReason: "STOP",
          content: { parts: [{ inlineData: { mimeType: "image/png", data: "AQID" } }] },
        },
      ],
      usageMetadata: { candidatesTokenCount: 17 },
    }),
  );
  await expect(
    models.generateImage(
      ["edit", { model: "gemini-nano-banana-2.1", outputPath: "edit.png" }],
      context,
    ),
  ).rejects.toThrow();
  await expect(files.readBytes(["edit.png"], context)).rejects.toThrow();
  expect([...(await files.readBytes(["edit.png.parts/original.bin"], context))]).toEqual([1, 2, 3]);
  expect(
    JSON.parse(await files.readText(["edit.png.parts/manifest.json"], context)).usage
      .candidatesTokenCount,
  ).toBe(17);
  expect(fetchImpl).toHaveBeenCalledTimes(1);
});
