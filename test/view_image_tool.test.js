import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import sharp from "sharp";
import { describe, expect, it } from "vitest";
import { createLocalToolExecutionBackend } from "../dist/core/tools/execution_backend.js";
import { TOOL_NAME_VIEW_IMAGE } from "../dist/core/tools/tool_names.js";
import { createViewImageToolDefinition } from "../dist/core/tools/view_image.js";

const VIEW_IMAGE_MODEL_MAX_BYTES = 2.5 * 1024 * 1024;

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

describe("view_image tool", () => {
  it("downscales images to fit inside a 2048x2048 square", async () => {
    const fx = setupFixture();

    try {
      const filePath = join(fx.dir, "large.png");
      await createPng(filePath, 4096, 3072);

      const backend = createLocalToolExecutionBackend();
      const tool = createViewImageToolDefinition(backend);
      const result = await tool.dispatch(
        {
          id: "tool-1",
          name: TOOL_NAME_VIEW_IMAGE,
          arguments: { path: filePath },
        },
        "read-only",
      );

      expect(result.kind).toBe("single");
      if (result.kind !== "single") {
        throw new Error("expected single dispatch result");
      }

      expect(result.uiEvent.type).toBe("view_image_success");
      if (result.uiEvent.type !== "view_image_success") {
        throw new Error("expected success ui event");
      }

      expect(result.uiEvent.uiText.statusLine).toBe("image/png");
      expect(getTextBlock(result.toolResult.content)).toBe(`viewed ${filePath} (image/png)`);

      const imageBlock = getImageBlock(result.toolResult.content);
      const outputBuffer = Buffer.from(imageBlock.data, "base64");
      const outputMetadata = await sharp(outputBuffer).metadata();
      expect(outputMetadata.width).toBe(2048);
      expect(outputMetadata.height).toBe(1536);
    } finally {
      fx.cleanup();
    }
  });

  it("keeps small images as-is", async () => {
    const fx = setupFixture();

    try {
      const filePath = join(fx.dir, "small.png");
      await createPng(filePath, 640, 480);
      const original = readFileSync(filePath);

      const backend = createLocalToolExecutionBackend();
      const tool = createViewImageToolDefinition(backend);
      const result = await tool.dispatch(
        {
          id: "tool-2",
          name: TOOL_NAME_VIEW_IMAGE,
          arguments: { path: filePath },
        },
        "read-only",
      );

      expect(result.kind).toBe("single");
      if (result.kind !== "single") {
        throw new Error("expected single dispatch result");
      }

      expect(result.uiEvent.type).toBe("view_image_success");
      if (result.uiEvent.type !== "view_image_success") {
        throw new Error("expected success ui event");
      }

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
      await createHighEntropyPng(filePath, 1536, 1536);

      const input = readFileSync(filePath);
      expect(input.byteLength).toBeGreaterThan(VIEW_IMAGE_MODEL_MAX_BYTES);

      const backend = createLocalToolExecutionBackend();
      const tool = createViewImageToolDefinition(backend);
      const result = await tool.dispatch(
        {
          id: "tool-3",
          name: TOOL_NAME_VIEW_IMAGE,
          arguments: { path: filePath },
        },
        "read-only",
      );

      expect(result.kind).toBe("single");
      if (result.kind !== "single") {
        throw new Error("expected single dispatch result");
      }

      expect(result.uiEvent.type).toBe("view_image_success");
      if (result.uiEvent.type !== "view_image_success") {
        throw new Error("expected success ui event");
      }

      const imageBlock = getImageBlock(result.toolResult.content);
      const outputBuffer = Buffer.from(imageBlock.data, "base64");
      const outputMetadata = await sharp(outputBuffer).metadata();

      expect(outputBuffer.byteLength).toBeLessThanOrEqual(VIEW_IMAGE_MODEL_MAX_BYTES);
      expect(result.uiEvent.bytes).toBe(outputBuffer.byteLength);
      expect(result.uiEvent.mimeType).toBe(imageBlock.mimeType);
      expect(Math.max(outputMetadata.width ?? 0, outputMetadata.height ?? 0)).toBeLessThanOrEqual(
        2048,
      );
      expect(getTextBlock(result.toolResult.content)).toBe(
        `viewed ${filePath} (${result.uiEvent.mimeType})`,
      );
    } finally {
      fx.cleanup();
    }
  }, 10_000);

  it("blocks unsupported image formats", async () => {
    const fx = setupFixture();

    try {
      const filePath = join(fx.dir, "unsupported.txt");
      writeFileSync(filePath, "not an image", "utf-8");

      const backend = createLocalToolExecutionBackend();
      const tool = createViewImageToolDefinition(backend);
      const result = await tool.dispatch(
        {
          id: "tool-4",
          name: TOOL_NAME_VIEW_IMAGE,
          arguments: { path: filePath },
        },
        "read-only",
      );

      expect(result.kind).toBe("single");
      if (result.kind !== "single") {
        throw new Error("expected single dispatch result");
      }

      expect(result.uiEvent.type).toBe("view_image_blocked");
      expect(getTextBlock(result.toolResult.content)).toContain("unsupported image format");
    } finally {
      fx.cleanup();
    }
  });
});
