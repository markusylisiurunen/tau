import { mkdtemp, rm, truncate, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { createTelegramApi } from "../dist/core/telegram/adapter.js";
import { createTelegramSendImageTool } from "../dist/core/telegram/send_image.js";
import { createLocalToolExecutionBackend } from "../dist/core/tools/execution_backend.js";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
  "base64",
);

async function withImage(run) {
  const cwd = await mkdtemp(join(tmpdir(), "tau-send-image-"));
  const backend = createLocalToolExecutionBackend();
  const controller = new AbortController();
  const exec = vi.fn((command, options) => backend.runBash(command, { ...options, cwd }));
  const sendDocument = vi.fn(async () => {});
  const tool = createTelegramSendImageTool({ sendDocument }, -123);
  const context = {
    sessionId: "session",
    agentId: "agent",
    callId: "call",
    signal: controller.signal,
    executionEnvironment: { exec },
  };
  try {
    await writeFile(join(cwd, "image.png"), png);
    await run({ cwd, exec, sendDocument, tool, context, controller });
  } finally {
    await backend.dispose();
    await rm(cwd, { recursive: true, force: true });
  }
}

describe("Telegram image delivery", () => {
  it("transfers the maximum size in bounded chunks and uploads unchanged bytes to the bound chat", async () => {
    await withImage(async ({ cwd, exec, sendDocument, tool, context }) => {
      const data = Buffer.alloc(50_000_000);
      png.copy(data);
      await writeFile(join(cwd, "image.png"), data);
      expect(await tool.execute({ path: "image.png", caption: "<b>original</b>" }, context)).toBe(
        "image sent to the current Telegram chat.",
      );
      expect(exec).toHaveBeenCalledTimes(7);
      for (const [, options] of exec.mock.calls) {
        expect(options.maxCaptureBytes).toBeLessThan(24 * 1024 * 1024);
        expect(options.signal).toBe(context.signal);
      }
      const [chatId, document, options] = sendDocument.mock.calls[0];
      expect(chatId).toBe(-123);
      expect(document.data.equals(data)).toBe(true);
      expect(document).toMatchObject({
        fileName: "image.png",
        mimeType: "image/png",
        caption: "<b>original</b>",
      });
      expect(options.signal).toBe(context.signal);
    });
  });

  it("rejects oversize, unsupported, and non-regular files without uploading", async () => {
    await withImage(async ({ cwd, sendDocument, tool, context }) => {
      await truncate(join(cwd, "image.png"), 50_000_001);
      await expect(tool.execute({ path: "image.png" }, context)).rejects.toThrow(
        "failed to read image",
      );
      await writeFile(join(cwd, "image.png"), "not an image");
      await expect(tool.execute({ path: "image.png" }, context)).rejects.toThrow(
        "only PNG and JPEG",
      );
      await expect(tool.execute({ path: cwd }, context)).rejects.toThrow("failed to read image");
      await expect(tool.execute({ path: "image.png", chatId: 456 }, context)).rejects.toThrow();
      expect(sendDocument).not.toHaveBeenCalled();
    });
  });

  it("stops on file mutation or cancellation between chunks", async () => {
    for (const cancel of [false, true]) {
      await withImage(async ({ cwd, exec, sendDocument, tool, context, controller }) => {
        await truncate(join(cwd, "image.png"), 8_000_001);
        const execute = exec.getMockImplementation();
        exec.mockImplementationOnce(async (...args) => {
          const result = await execute(...args);
          if (cancel) controller.abort(new Error("cancelled"));
          else await writeFile(join(cwd, "image.png"), png);
          return result;
        });
        await expect(tool.execute({ path: "image.png" }, context)).rejects.toThrow(
          cancel ? "cancelled" : "failed to read image",
        );
        expect(sendDocument).not.toHaveBeenCalled();
        expect(exec).toHaveBeenCalledTimes(cancel ? 1 : 2);
      });
    }
  });

  it("uploads a plain-caption document and returns Telegram failures", async () => {
    const fetchMock = vi.fn(
      async () => new Response(JSON.stringify({ ok: true, result: {} }), { status: 200 }),
    );
    vi.stubGlobal("fetch", fetchMock);
    try {
      await withImage(async ({ tool, context }) => {
        tool = createTelegramSendImageTool(createTelegramApi("test-token"), 987);
        await tool.execute({ path: "image.png", caption: "*plain*" }, context);
        const [url, init] = fetchMock.mock.calls[0];
        expect(url).toBe("https://api.telegram.org/bottest-token/sendDocument");
        expect(init.body.get("chat_id")).toBe("987");
        expect(init.body.get("caption")).toBe("*plain*");
        expect(init.body.has("parse_mode")).toBe(false);
        expect(init.body.get("disable_content_type_detection")).toBe("true");
        const document = init.body.get("document");
        expect(document.name).toBe("image.png");
        expect(Buffer.from(await document.arrayBuffer())).toEqual(png);
        expect(init.signal).toBe(context.signal);
        fetchMock.mockResolvedValueOnce(
          new Response(
            JSON.stringify({ ok: false, description: "upload refused", error_code: 400 }),
            { status: 400 },
          ),
        );
        await expect(tool.execute({ path: "image.png" }, context)).rejects.toThrow(
          "upload refused",
        );
      });
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
