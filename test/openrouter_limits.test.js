import { spawn, spawnSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import sharp from "sharp";
import { expect, it, vi } from "vitest";
import { createModelsCapability } from "../dist/core/code_mode/models.js";
import {
  requestOpenRouterChat,
  requestOpenRouterDecisions,
} from "../dist/core/models/openrouter.js";
import { withOpenRouterBudget } from "../dist/core/models/openrouter_budget.js";
import {
  OPENROUTER_TEXT_BYTES,
  prepareOpenRouterAttachments,
} from "../dist/core/models/openrouter_media.js";
import { createLocalToolExecutionBackend } from "../dist/core/tools/execution_backend.js";
import { createFlySpriteToolExecutionBackend } from "../dist/execution/fly_sprite_execution_environment.js";

const signal = () => new AbortController().signal;
const reply = () =>
  Response.json({
    model: "openai/gpt-6-luna",
    choices: [{ finish_reason: "stop", message: { role: "assistant", content: "ok" } }],
  });
const chat = { model: "openai/gpt-6-luna", prompt: "Describe", attachments: [] };
function options() {
  return {
    config: { apiKeys: { openrouter: "test-key" } },
    signal: signal(),
    fetchImpl: vi.fn(async () => reply()),
    mediaAdapter: { readFile: vi.fn(), probe: vi.fn() },
  };
}

it("accepts combined chat text at 20 MiB and rejects an extra UTF-8 byte or schema before media access", async () => {
  const opts = options();
  const input = {
    ...chat,
    prompt: "é".repeat(OPENROUTER_TEXT_BYTES / 4),
    system: "a".repeat(OPENROUTER_TEXT_BYTES / 2),
  };
  await requestOpenRouterChat(input, opts);
  expect(opts.fetchImpl).toHaveBeenCalledOnce();
  opts.fetchImpl.mockClear();
  for (const oversized of [
    { ...input, system: `${input.system}a` },
    { ...input, schema: {} },
  ]) {
    await expect(
      requestOpenRouterChat(
        { ...oversized, attachments: [{ kind: "image", path: "missing" }] },
        opts,
      ),
    ).rejects.toThrow();
  }
  expect(opts.mediaAdapter.readFile).not.toHaveBeenCalled();
  expect(opts.fetchImpl).not.toHaveBeenCalled();
});

it("accepts large structured decision input and bounds its serialized questions and state together", async () => {
  const opts = options();
  opts.fetchImpl.mockImplementation(async () =>
    Response.json({
      model: "openai/gpt-6-luna-decisions",
      answers: { q: { type: "noul", noul: 1 } },
      usage: { input_tokens: 1, output_tokens: 1 },
    }),
  );
  const value = {
    state: { document: "a".repeat(2 * 1024 * 1024) },
    questions: { q: { type: "noul", instructions: "Check" } },
  };
  await requestOpenRouterDecisions(
    { model: "openai/gpt-6-luna-decisions", value, attachments: [] },
    opts,
  );
  expect(opts.fetchImpl).toHaveBeenCalledOnce();
  opts.fetchImpl.mockClear();
  value.questions.q.instructions = "é".repeat(OPENROUTER_TEXT_BYTES / 2);
  await expect(
    requestOpenRouterDecisions(
      { model: "openai/gpt-6-luna-decisions", value, attachments: [] },
      opts,
    ),
  ).rejects.toThrow();
  expect(opts.fetchImpl).not.toHaveBeenCalled();
});

it("accepts 64 images and retains Jev's stricter count before reading files", async () => {
  const bytes = await sharp({ create: { width: 280, height: 280, channels: 3, background: "red" } })
    .png()
    .toBuffer();
  const adapter = { readFile: vi.fn(async () => bytes), probe: vi.fn() };
  const images = Array.from({ length: 64 }, () => ({ kind: "image", path: "image" }));
  expect(await prepareOpenRouterAttachments(images, adapter, signal())).toHaveLength(64);
  adapter.readFile.mockClear();
  await expect(
    prepareOpenRouterAttachments([...images, images[0]], adapter, signal()),
  ).rejects.toThrow();
  await expect(
    prepareOpenRouterAttachments(images.slice(0, 17), adapter, signal(), "jev"),
  ).rejects.toThrow();
  expect(adapter.readFile).not.toHaveBeenCalled();
});

it("allows multiple audio/video inputs up to two hours combined and rejects invalid codecs", async () => {
  const wav = makeWav(2);
  const mp4 = Buffer.from("000000186674797069736f6d0000020069736f6d69736f32", "hex");
  const adapter = {
    readFile: vi.fn(async (path) => (path === "audio" ? wav : mp4)),
    probe: vi.fn(async (_bytes, format) => ({
      format: { duration: "900" },
      streams:
        format === "wav"
          ? [{ codec_type: "audio", codec_name: "pcm_s16le" }]
          : [{ codec_type: "video", codec_name: "h264", width: 1920, height: 1080 }],
    })),
  };
  const attachments = [
    ...Array.from({ length: 6 }, () => ({ kind: "audio", path: "audio" })),
    ...Array.from({ length: 2 }, () => ({ kind: "video", path: "video" })),
  ];
  expect(await prepareOpenRouterAttachments(attachments, adapter, signal())).toHaveLength(8);
  await expect(
    prepareOpenRouterAttachments([...attachments, attachments[0]], adapter, signal()),
  ).rejects.toThrow();
  adapter.probe.mockResolvedValue({
    format: { duration: "1" },
    streams: [{ codec_type: "audio", codec_name: "aac" }],
  });
  await expect(prepareOpenRouterAttachments([attachments[0]], adapter, signal())).rejects.toThrow();
});

it("queues large requests before reads, cancels waiters, and releases reservations on failure", async () => {
  const first = options();
  const started = Promise.withResolvers();
  const release = Promise.withResolvers();
  first.mediaAdapter.readFile.mockImplementation(async () => {
    started.resolve();
    await release.promise;
    throw new Error("read failed");
  });
  const input = {
    ...chat,
    model: "google/gemini-3.8-flash",
    attachments: [{ kind: "video", path: "video" }],
  };
  const running = requestOpenRouterChat(input, first);
  const failed = expect(running).rejects.toThrow();
  await started.promise;
  const second = options();
  const controller = new AbortController();
  second.signal = controller.signal;
  const waiting = requestOpenRouterChat(input, second);
  const cancelled = expect(waiting).rejects.toThrow();
  await new Promise((resolve) => setImmediate(resolve));
  expect(second.mediaAdapter.readFile).not.toHaveBeenCalled();
  controller.abort();
  await cancelled;
  release.resolve();
  await failed;
  await expect(
    withOpenRouterBudget(input.attachments, 1, signal(), async () => "released"),
  ).resolves.toBe("released");
  expect(first.fetchImpl).not.toHaveBeenCalled();
  expect(second.fetchImpl).not.toHaveBeenCalled();
});

function makeWav(size) {
  const bytes = Buffer.alloc(44 + size);
  bytes.write("RIFF");
  bytes.writeUInt32LE(bytes.length - 8, 4);
  bytes.write("WAVEfmt ", 8);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(16000, 24);
  bytes.writeUInt32LE(32000, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write("data", 36);
  bytes.writeUInt32LE(size, 40);
  return bytes;
}

it.skipIf(spawnSync("ffprobe", ["-version"]).status !== 0).each(["local", "sprite"])(
  "validates a 24 MiB recording through the %s backend without large execution stdin",
  async (kind) => {
    const directory = await mkdtemp(join(tmpdir(), "tau-model-large-"));
    const backend =
      kind === "local"
        ? createLocalToolExecutionBackend({ env: { cwd: () => directory } })
        : createFlySpriteToolExecutionBackend({
            cwd: directory,
            sprite: {
              spawn: (command, args, options) =>
                spawn(command, args, { ...options, stdio: ["pipe", "pipe", "pipe"] }),
            },
          });
    const run = vi.spyOn(backend, "runNodeScript");
    const fetchImpl = vi.fn(async (_url, init) => {
      const body = JSON.parse(init.body);
      const encoded = body.messages[0].content[1].input_audio.data;
      expect(Buffer.from(encoded, "base64").equals(bytes)).toBe(true);
      return reply();
    });
    const bytes = makeWav(24 * 1024 * 1024);
    try {
      await writeFile(join(directory, "audio.wav"), bytes);
      const capability = createModelsCapability(
        backend,
        { apiKeys: { openrouter: "test-key" } },
        fetchImpl,
      );
      await capability.api.chat(
        [
          {
            model: "google/gemini-3.8-flash",
            prompt: "Describe",
            attachments: [{ type: "audio", path: "audio.wav" }],
          },
        ],
        { signal: signal() },
      );
      expect(fetchImpl).toHaveBeenCalledOnce();
      expect(run).toHaveBeenCalledOnce();
      expect(run.mock.calls[0][2].stdin.length).toBeLessThan(1024);
      const write = vi.spyOn(backend, "writeFileBinary");
      await capability.api.chat(
        [
          {
            model: "google/gemini-3.8-flash",
            prompt: "Describe",
            attachments: [{ type: "audio", data: bytes.toString("base64"), mimeType: "audio/wav" }],
          },
        ],
        { signal: signal() },
      );
      expect(fetchImpl).toHaveBeenCalledTimes(2);
      expect(write).toHaveBeenCalledOnce();
      await expect(backend.readFileBinary(write.mock.calls[0][0])).rejects.toThrow();
      for (const [, , options] of run.mock.calls)
        expect(options?.stdin?.length ?? 0).toBeLessThan(1024);
    } finally {
      await backend.dispose();
      await rm(directory, { recursive: true, force: true });
    }
  },
);

it("accepts a wide image above the former byte and edge limits, but rejects excessive edges", async () => {
  const adapter = { readFile: vi.fn(), probe: vi.fn() };
  for (const width of [9000, 32769]) {
    const png = await sharp({ create: { width, height: 1, channels: 3, background: "red" } })
      .png()
      .toBuffer();
    const padded = Buffer.alloc(6 * 1024 * 1024);
    png.copy(padded);
    adapter.readFile.mockResolvedValue(padded);
    const preparing = prepareOpenRouterAttachments(
      [{ kind: "image", path: "wide.png" }],
      adapter,
      signal(),
    );
    if (width === 9000) expect(await preparing).toHaveLength(1);
    else await expect(preparing).rejects.toThrow();
  }
});

it("accepts responses above 8 MB and cancels a response stream above 32 MiB", async () => {
  const opts = options();
  opts.fetchImpl.mockImplementationOnce(async () =>
    Response.json({
      model: chat.model,
      choices: [
        {
          finish_reason: "stop",
          message: { role: "assistant", content: "x".repeat(9 * 1024 * 1024) },
        },
      ],
    }),
  );
  expect((await requestOpenRouterChat(chat, opts)).answer.length).toBe(9 * 1024 * 1024);
  const cancel = vi.fn();
  opts.fetchImpl.mockImplementationOnce(
    async () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array(32 * 1024 * 1024 + 1));
          },
          cancel,
        }),
      ),
  );
  await expect(requestOpenRouterChat(chat, opts)).rejects.toThrow();
  expect(cancel).toHaveBeenCalledOnce();
});

it("bounds the complete serialized request including media and envelope overhead", async () => {
  vi.resetModules();
  vi.doMock("../dist/core/models/openrouter_media.js", async (importOriginal) => ({
    ...(await importOriginal()),
    OPENROUTER_REQUEST_BYTES: 1024,
  }));
  try {
    const { requestOpenRouterChat: request } = await import("../dist/core/models/openrouter.js");
    const bytes = await sharp({ create: { width: 1, height: 1, channels: 3, background: "red" } })
      .png()
      .toBuffer();
    const opts = options();
    opts.mediaAdapter.readFile.mockResolvedValue(bytes);
    const input = { ...chat, prompt: "a", attachments: [{ kind: "image", path: "image" }] };
    await request(input, opts);
    const overhead = Buffer.byteLength(opts.fetchImpl.mock.calls[0][1].body) - 1;
    opts.fetchImpl.mockClear();
    input.prompt = "a".repeat(1024 - overhead);
    await request(input, opts);
    expect(Buffer.byteLength(opts.fetchImpl.mock.calls[0][1].body)).toBe(1024);
    opts.fetchImpl.mockClear();
    input.prompt += "a";
    await expect(request(input, opts)).rejects.toThrow();
    expect(opts.fetchImpl).not.toHaveBeenCalled();
  } finally {
    vi.doUnmock("../dist/core/models/openrouter_media.js");
    vi.resetModules();
  }
});
