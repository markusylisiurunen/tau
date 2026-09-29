import { mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createTelegramApi } from "../dist/core/telegram/adapter.js";
import { createTelegramFileTools } from "../dist/core/telegram/send_file.js";
import { createLocalToolExecutionBackend } from "../dist/core/tools/execution_backend.js";

const deliveries = [
  ["photo", "sendPhoto", "image.png", 10_000_000],
  ["video", "sendVideo", "video.mp4", 50_000_000],
  ["audio", "sendAudio", "audio.mp3", 50_000_000],
  ["document", "sendDocument", "report.csv", 50_000_000],
];

async function withFiles(run) {
  const cwd = await mkdtemp(join(tmpdir(), "tau-send-file-"));
  const backend = createLocalToolExecutionBackend();
  const controller = new AbortController();
  const exec = vi.fn((command, options) => backend.runBash(command, { ...options, cwd }));
  const api = Object.fromEntries(deliveries.map(([, method]) => [method, vi.fn(async () => {})]));
  const tools = createTelegramFileTools(api, -123);
  const context = {
    sessionId: "session",
    agentId: "agent",
    callId: "call",
    signal: controller.signal,
    executionEnvironment: { exec },
  };
  try {
    await run({ cwd, exec, api, tools, context, controller });
  } finally {
    await backend.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
}

function getTool(tools, kind) {
  return tools.find((tool) => tool.schema.name === `send_${kind}_to_telegram`);
}

describe("Telegram file delivery", () => {
  it.each(deliveries)(
    "transfers maximum-size %s files in bounded chunks without changing bytes",
    async (kind, method, fileName, limit) => {
      await withFiles(async ({ cwd, exec, api, tools, context }) => {
        const data = Buffer.alloc(limit, 42);
        await writeFile(join(cwd, fileName), data);
        const tool = getTool(tools, kind);
        expect(await tool.execute({ path: fileName, caption: "<b>original</b>" }, context)).toBe(
          `${kind} sent to the current Telegram chat.`,
        );
        expect(exec).toHaveBeenCalledTimes(Math.ceil(limit / 8_000_000));
        for (const [, options] of exec.mock.calls) {
          expect(options.maxCaptureBytes).toBeLessThan(24 * 1024 * 1024);
          expect(options.signal).toBe(context.signal);
        }
        expect(api[method]).toHaveBeenCalledOnce();
        const [chatId, file, options] = api[method].mock.calls[0];
        expect(chatId).toBe(-123);
        expect(file.data.equals(data)).toBe(true);
        expect(file).toMatchObject({
          fileName,
          mimeType: "application/octet-stream",
          caption: "<b>original</b>",
        });
        expect(options.signal).toBe(context.signal);
        for (const [, otherMethod] of deliveries) {
          if (otherMethod !== method) expect(api[otherMethod]).not.toHaveBeenCalled();
        }
      });
    },
  );

  it.each(deliveries)(
    "rejects oversized, empty, missing, and non-regular %s files before uploading",
    async (kind, method, fileName, limit) => {
      await withFiles(async ({ cwd, api, tools, context }) => {
        const tool = getTool(tools, kind);
        const path = join(cwd, fileName);
        await writeFile(path, "");
        await expect(tool.execute({ path }, context)).rejects.toThrow("failed to read file");
        await truncate(path, limit + 1);
        await expect(tool.execute({ path }, context)).rejects.toThrow(
          `between 1 and ${limit} bytes`,
        );
        await expect(tool.execute({ path: cwd }, context)).rejects.toThrow("failed to read file");
        await expect(tool.execute({ path: "missing" }, context)).rejects.toThrow(
          "failed to read file",
        );
        expect(api[method]).not.toHaveBeenCalled();
      });
    },
  );

  it("validates arguments before reading and accepts the caption boundary", async () => {
    await withFiles(async ({ cwd, exec, api, tools, context }) => {
      for (const tool of tools) {
        for (const args of [
          { path: "" },
          { path: "a\nb" },
          { path: "a\rb" },
          { path: "a\0b" },
          { path: "file", caption: "a".repeat(1025) },
          { path: "file", chatId: 456 },
        ]) {
          await expect(tool.execute(args, context)).rejects.toThrow();
        }
      }
      expect(exec).not.toHaveBeenCalled();
      const path = join(cwd, "report.csv");
      await writeFile(path, "a,b\n1,2\n");
      await getTool(tools, "document").execute({ path, caption: "a".repeat(1024) }, context);
      expect(api.sendDocument).toHaveBeenCalledOnce();
    });
  });

  it("stops on file mutation or cancellation between chunks", async () => {
    for (const cancel of [false, true]) {
      await withFiles(async ({ cwd, exec, api, tools, context, controller }) => {
        const path = join(cwd, "file");
        await writeFile(path, "content");
        await truncate(path, 8_000_001);
        const execute = exec.getMockImplementation();
        exec.mockImplementationOnce(async (...args) => {
          const result = await execute(...args);
          if (cancel) controller.abort(new Error("cancelled"));
          else await writeFile(path, "changed");
          return result;
        });
        await expect(getTool(tools, "document").execute({ path }, context)).rejects.toThrow(
          cancel ? "cancelled" : "failed to read file",
        );
        expect(api.sendDocument).not.toHaveBeenCalled();
        expect(exec).toHaveBeenCalledTimes(cancel ? 1 : 2);
      });
    }
  });

  it("does not read or upload when already cancelled", async () => {
    await withFiles(async ({ exec, api, tools, context, controller }) => {
      controller.abort(new Error("cancelled"));
      for (const tool of tools) {
        await expect(tool.execute({ path: "file" }, context)).rejects.toThrow("cancelled");
      }
      expect(exec).not.toHaveBeenCalled();
      for (const method of Object.values(api)) expect(method).not.toHaveBeenCalled();
    });
  });

  it("rejects malformed, oversized, and incomplete execution-environment responses", async () => {
    await withFiles(async ({ exec, api, tools, context }) => {
      const valid = { identity: "stable", size: 1, content: "YQ==" };
      for (const result of [
        { stdout: "not json" },
        { stdout: JSON.stringify({ ...valid, identity: "" }) },
        { stdout: JSON.stringify({ ...valid, size: 10_000_001 }) },
        { stdout: JSON.stringify({ ...valid, content: "" }) },
        { stdout: JSON.stringify(valid), truncated: true },
        { stdout: JSON.stringify(valid), timedOut: true },
        { stdout: JSON.stringify(valid), aborted: true },
      ]) {
        exec.mockResolvedValueOnce({ exitCode: 0, ...result });
        await expect(
          getTool(tools, "photo").execute({ path: "/remote/image.png" }, context),
        ).rejects.toThrow();
      }
      expect(api.sendPhoto).not.toHaveBeenCalled();
    });
  });

  it.each(deliveries)(
    "uploads %s with the correct endpoint and plain caption, without retries or fallback",
    async (kind, method, fileName) => {
      const fetchMock = vi.fn(
        async () => new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 }),
      );
      vi.stubGlobal("fetch", fetchMock);
      try {
        const tool = getTool(createTelegramFileTools(createTelegramApi("test-token"), 987), kind);
        const data = Buffer.from("remote file bytes");
        const context = {
          signal: new AbortController().signal,
          executionEnvironment: {
            exec: vi.fn(async () => ({
              exitCode: 0,
              stdout: JSON.stringify({
                identity: "stable",
                size: data.length,
                content: data.toString("base64"),
              }),
            })),
          },
        };
        await tool.execute({ path: `/remote/${fileName}`, caption: "*plain*" }, context);
        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toBe(`https://api.telegram.org/bottest-token/${method}`);
        expect(init.body.get("chat_id")).toBe("987");
        expect(init.body.get("caption")).toBe("*plain*");
        expect(init.body.has("parse_mode")).toBe(false);
        expect(init.body.get("disable_content_type_detection")).toBe(
          kind === "document" ? "true" : null,
        );
        const upload = init.body.get(kind);
        expect(upload.name).toBe(fileName);
        expect(Buffer.from(await upload.arrayBuffer())).toEqual(data);
        expect(init.signal).toBe(context.signal);
        await tool.execute({ path: `/remote/${fileName}` }, context);
        expect(fetchMock.mock.calls[1][1].body.has("caption")).toBe(false);
        fetchMock.mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              ok: false,
              description: "upload refused",
              error_code: 429,
              parameters: { retry_after: 1 },
            }),
            { status: 429 },
          ),
        );
        await expect(tool.execute({ path: `/remote/${fileName}` }, context)).rejects.toThrow(
          "upload refused",
        );
        expect(fetchMock).toHaveBeenCalledTimes(3);
      } finally {
        vi.unstubAllGlobals();
      }
    },
  );
});
