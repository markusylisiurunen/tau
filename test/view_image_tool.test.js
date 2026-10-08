import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { createLocalToolExecutionBackend } from "../dist/core/tools/execution_backend.js";
import { TOOL_NAME_VIEW_IMAGE } from "../dist/core/tools/tool_names.js";
import { createViewImageToolDefinition } from "../dist/core/tools/view_image.js";

const VIEW_IMAGE_MODEL_MAX_BYTES = 3.5 * 1024 * 1024;

function setupFixture() {
  const dir = mkdtempSync(join(tmpdir(), "tau-view-image-tool-"));
  return {
    dir: resolve(dir),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

async function createPng(path, width, height) {
  await sharp({
    create: {
      width,
      height,
      channels: 3,
      background: { r: 21, g: 42, b: 84 },
    },
  })
    .png()
    .toFile(path);
}

async function createHighEntropyPng(path, width, height) {
  const raw = randomBytes(width * height * 3);
  await sharp(raw, {
    raw: {
      width,
      height,
      channels: 3,
    },
  })
    .png({ compressionLevel: 0 })
    .toFile(path);
}

function getTextBlock(content) {
  if (!Array.isArray(content)) {
    throw new Error("expected array tool result content");
  }

  const block = content.find((entry) => typeof entry !== "string" && entry.type === "text");
  if (!block || typeof block === "string") {
    throw new Error("missing text block");
  }
  return block.text;
}

function getImageBlock(content) {
  if (!Array.isArray(content)) {
    throw new Error("expected array tool result content");
  }

  const block = content.find((entry) => typeof entry !== "string" && entry.type === "image");
  if (!block || typeof block === "string") {
    throw new Error("missing image block");
  }
  return block;
}

async function runTool(tool, toolCall, signal = new AbortController().signal) {
  const activities = [];
  const outcome = await tool.execute(toolCall, {
    agentId: "test-agent",
    turnId: "test-turn",
    assistantMessageId: "test-assistant",
    signal,
    emitActivity: async (activity) => activities.push(activity),
  });
  return {
    toolResult: { ...outcome, toolCallId: toolCall.id, toolName: toolCall.name },
    uiEvent: activities.at(-1),
    activities,
  };
}

describe("view_image tool", () => {
  it("enforces a single-line path contract", async () => {
    const tool = createViewImageToolDefinition(createLocalToolExecutionBackend());

    expect(tool.schema.parameters.properties.path.pattern).toBe("^[^\\r\\n]+$");

    const result = await runTool(tool, {
      id: "tool-invalid-path",
      name: TOOL_NAME_VIEW_IMAGE,
      arguments: { path: "one\ntwo" },
    });
    expect(result.toolResult.outcome).toBe("blocked");
    expect(getTextBlock(result.toolResult.content)).toBe(
      "Invalid arguments: path must be a single line.",
    );
    expect(result.uiEvent.presentation.details[0].tone).toBeUndefined();
  });

  it("downscales images to fit inside a 4096x4096 square", async () => {
    const fx = setupFixture();

    try {
      const filePath = join(fx.dir, "large.png");
      await createPng(filePath, 4608, 3456);

      const backend = createLocalToolExecutionBackend();
      const tool = createViewImageToolDefinition(backend);
      const result = await runTool(tool, {
        id: "tool-1",
        name: TOOL_NAME_VIEW_IMAGE,
        arguments: { path: filePath },
      });

      expect(result.uiEvent.type).toBe("view_image_success");
      if (result.uiEvent.type !== "view_image_success") {
        throw new Error("expected success ui event");
      }

      expect(result.uiEvent.presentation.metadata).toEqual(["image/png", "4096×3072"]);
      expect(getTextBlock(result.toolResult.content)).toBe(`Successfully viewed ${filePath}.`);

      const imageBlock = getImageBlock(result.toolResult.content);
      const outputBuffer = Buffer.from(imageBlock.data, "base64");
      const outputMetadata = await sharp(outputBuffer).metadata();
      expect(outputMetadata.width).toBe(4096);
      expect(outputMetadata.height).toBe(3072);
    } finally {
      fx.cleanup();
    }
  });

  it("keeps 4K images as-is", async () => {
    const fx = setupFixture();

    try {
      const filePath = join(fx.dir, "small.png");
      await createPng(filePath, 3840, 2160);
      const original = readFileSync(filePath);

      const backend = createLocalToolExecutionBackend({ env: { cwd: () => fx.dir } });
      const tool = createViewImageToolDefinition(backend);
      const result = await runTool(tool, {
        id: "tool-2",
        name: TOOL_NAME_VIEW_IMAGE,
        arguments: { path: "small.png" },
      });

      expect(result.uiEvent.type).toBe("view_image_success");
      if (result.uiEvent.type !== "view_image_success") {
        throw new Error("expected success ui event");
      }

      expect(result.uiEvent.presentation.subject).toBe("small.png");
      expect(result.uiEvent.presentation.metadata).toEqual(["image/png", "3840×2160"]);
      const imageBlock = getImageBlock(result.toolResult.content);
      const outputBuffer = Buffer.from(imageBlock.data, "base64");
      expect(outputBuffer.equals(original)).toBe(true);
    } finally {
      fx.cleanup();
    }
  });

  it("compresses oversized high-entropy images under the model budget", async () => {
    const fx = setupFixture();

    try {
      const filePath = join(fx.dir, "entropy.png");
      await createHighEntropyPng(filePath, 1152, 1088);

      const input = readFileSync(filePath);
      expect(input.byteLength).toBeGreaterThan(VIEW_IMAGE_MODEL_MAX_BYTES);

      const backend = createLocalToolExecutionBackend();
      const tool = createViewImageToolDefinition(backend);
      const result = await runTool(tool, {
        id: "tool-3",
        name: TOOL_NAME_VIEW_IMAGE,
        arguments: { path: filePath },
      });

      expect(result.uiEvent.type).toBe("view_image_success");
      if (result.uiEvent.type !== "view_image_success") {
        throw new Error("expected success ui event");
      }

      const imageBlock = getImageBlock(result.toolResult.content);
      const outputBuffer = Buffer.from(imageBlock.data, "base64");
      const outputMetadata = await sharp(outputBuffer).metadata();

      expect(outputBuffer.byteLength).toBeLessThanOrEqual(VIEW_IMAGE_MODEL_MAX_BYTES);
      expect(result.uiEvent.presentation.metadata).toEqual([
        imageBlock.mimeType,
        `${outputMetadata.width}×${outputMetadata.height}`,
      ]);
      expect(outputMetadata.width).toBe(1152);
      expect(outputMetadata.height).toBe(1088);
      expect(getTextBlock(result.toolResult.content)).toBe(`Successfully viewed ${filePath}.`);
    } finally {
      fx.cleanup();
    }
  }, 10_000);

  it("losslessly recompresses oversized transparent images without resizing", async () => {
    const fx = setupFixture();

    try {
      const filePath = join(fx.dir, "transparent.png");
      const pixels = Buffer.alloc(1920 * 1080 * 4);
      for (let offset = 0; offset < pixels.length; offset += 4) {
        pixels[offset] = 21;
        pixels[offset + 1] = 42;
        pixels[offset + 2] = 84;
        pixels[offset + 3] = 128;
      }
      await sharp(pixels, { raw: { width: 1920, height: 1080, channels: 4 } })
        .png({ compressionLevel: 0 })
        .toFile(filePath);
      expect(readFileSync(filePath).byteLength).toBeGreaterThan(VIEW_IMAGE_MODEL_MAX_BYTES);

      const tool = createViewImageToolDefinition(createLocalToolExecutionBackend());
      const result = await runTool(tool, {
        id: "tool-transparent",
        name: TOOL_NAME_VIEW_IMAGE,
        arguments: { path: filePath },
      });

      expect(result.toolResult.outcome).toBe("succeeded");
      const imageBlock = getImageBlock(result.toolResult.content);
      const outputBuffer = Buffer.from(imageBlock.data, "base64");
      expect(outputBuffer.byteLength).toBeLessThanOrEqual(VIEW_IMAGE_MODEL_MAX_BYTES);
      const metadata = await sharp(outputBuffer).metadata();
      expect([metadata.width, metadata.height, metadata.hasAlpha]).toEqual([1920, 1080, true]);
      const outputPixels = await sharp(outputBuffer).raw().toBuffer();
      expect(outputPixels.equals(pixels)).toBe(true);
    } finally {
      fx.cleanup();
    }
  });

  it("returns a focused missing-file result", async () => {
    const tool = createViewImageToolDefinition(createLocalToolExecutionBackend());
    const missing = await runTool(tool, {
      id: "tool-missing",
      name: TOOL_NAME_VIEW_IMAGE,
      arguments: { path: "/missing/image.png" },
    });

    expect([missing.toolResult.outcome, getTextBlock(missing.toolResult.content)]).toEqual([
      "blocked",
      "File not found at '/missing/image.png'. Verify the path is correct.",
    ]);
  });

  it("blocks unsupported image formats", async () => {
    const fx = setupFixture();

    try {
      const filePath = join(fx.dir, "unsupported.txt");
      writeFileSync(filePath, "not an image", "utf-8");

      const backend = createLocalToolExecutionBackend();
      const tool = createViewImageToolDefinition(backend);
      const result = await runTool(tool, {
        id: "tool-4",
        name: TOOL_NAME_VIEW_IMAGE,
        arguments: { path: filePath },
      });

      expect(result.uiEvent.type).toBe("view_image_blocked");
      expect(getTextBlock(result.toolResult.content)).toContain("Unsupported image format");
    } finally {
      fx.cleanup();
    }
  });
});
