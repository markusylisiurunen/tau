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

    const unknownArgument = await runTool(tool, {
      id: "tool-unknown-argument",
      name: TOOL_NAME_VIEW_IMAGE,
      arguments: { path: "image.png", unexpected: true },
    });
    expect(unknownArgument.toolResult.outcome).toBe("blocked");
    expect(getTextBlock(unknownArgument.toolResult.content)).toBe(
      'Invalid arguments: Unrecognized key: "unexpected"',
    );
  });

  it("downscales images to fit inside a 2000x2000 square", async () => {
    const fx = setupFixture();

    try {
      const filePath = join(fx.dir, "large.png");
      await createPng(filePath, 4096, 3072);

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

      expect(result.uiEvent.presentation.metadata).toEqual(["image/png", "2000×1500"]);
      expect(getTextBlock(result.toolResult.content)).toBe(`Successfully viewed ${filePath}.`);

      const imageBlock = getImageBlock(result.toolResult.content);
      const outputBuffer = Buffer.from(imageBlock.data, "base64");
      const outputMetadata = await sharp(outputBuffer).metadata();
      expect(outputMetadata.width).toBe(2000);
      expect(outputMetadata.height).toBe(1500);
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
      expect(result.uiEvent.presentation.metadata).toEqual(["image/png", "640×480"]);
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
      expect(Math.max(outputMetadata.width ?? 0, outputMetadata.height ?? 0)).toBeLessThanOrEqual(
        2000,
      );
      expect(getTextBlock(result.toolResult.content)).toBe(`Successfully viewed ${filePath}.`);
    } finally {
      fx.cleanup();
    }
  }, 10_000);

  it("returns focused file read failures", async () => {
    const tool = createViewImageToolDefinition(createLocalToolExecutionBackend());
    const missing = await runTool(tool, {
      id: "tool-missing",
      name: TOOL_NAME_VIEW_IMAGE,
      arguments: { path: "/missing/image.png" },
    });

    expect(missing.toolResult.outcome).toBe("blocked");
    expect(getTextBlock(missing.toolResult.content)).toBe(
      "File not found at '/missing/image.png'. Verify the path is correct.",
    );

    const failedTool = createViewImageToolDefinition({
      async readFileBinary() {
        throw new Error("storage unavailable");
      },
    });
    const failed = await runTool(failedTool, {
      id: "tool-read-failed",
      name: TOOL_NAME_VIEW_IMAGE,
      arguments: { path: "image.png" },
    });

    expect(failed.toolResult.outcome).toBe("failed");
    expect(getTextBlock(failed.toolResult.content)).toBe(
      "Could not view image: storage unavailable",
    );
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
