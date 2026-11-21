import { basename, extname, join } from "node:path";
import { fileTypeFromBuffer } from "file-type";
import sharp from "sharp";
import { z } from "zod";
import { getGoogleApiKey, getOpenAIApiKey } from "../config/schema.js";
import { describeMediaError, mediaRequest, readMediaJsonResponse } from "./media.js";
import { type MediaContext, prepareOutput, publish, writeNew } from "./target.js";

const ratios = ["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"] as const;
const wideRatios = [...ratios, "1:4", "4:1", "1:8", "8:1"] as const;
const googleSettings = z.strictObject({
  aspectRatio: z.enum(wideRatios).optional(),
  resolution: z.enum(["1K", "2K", "4K"]).optional(),
  thinking: z.enum(["minimal", "medium", "high"]).optional(),
  format: z.literal("png").default("png"),
});
const openaiSettings = z
  .strictObject({
    size: z
      .string()
      .refine(isImageSize, {
        message:
          "size requires auto or multiples of 16, edges <=3840, aspect ratio between 1:3 and 3:1, and 655360–8294400 pixels",
      })
      .optional(),
    quality: z.enum(["auto", "low", "medium", "high", "xhigh", "max"]).optional(),
    complexity: z.enum(["low", "medium", "high"]).optional(),
    background: z.enum(["auto", "opaque", "transparent"]).optional(),
    format: z.enum(["png", "jpeg", "webp"]).default("png"),
    compression: z.number().int().min(0).max(100).optional(),
  })
  .refine((settings) => settings.background !== "transparent" || settings.format !== "jpeg", {
    message: "background transparent requires format png or webp; use background opaque for jpeg",
  })
  .refine((settings) => settings.compression === undefined || settings.format !== "png", {
    message: "compression requires jpeg or webp and an integer from 0 to 100",
  });

const googleModel = "gemini-nano-banana-2.1";
const openAIModels = ["gpt-image-2.6-flare", "gpt-image-2.6-sunburst"] as const;
export const imageModels = [googleModel, ...openAIModels];
const commonOptions = {
  outputPath: z.string().min(1),
  references: z.array(z.string().min(1)).default([]),
};
export const imageOptions = z.discriminatedUnion("model", [
  z.strictObject({
    ...commonOptions,
    model: z.literal(googleModel),
    settings: googleSettings.prefault({}),
  }),
  z.strictObject({
    ...commonOptions,
    model: z.enum(openAIModels),
    settings: openaiSettings.prefault({}),
  }),
]);
type ImageOptions = z.infer<typeof imageOptions>;
type ImageReference = { data: Buffer; mime: string; name: string };
type ImageSettings =
  | { provider: "google"; settings: z.infer<typeof googleSettings> }
  | { provider: "openai"; settings: z.infer<typeof openaiSettings> };
type ImageGeneration = ImageSettings & {
  model: string;
  output: string;
  prompt: string;
  references: ImageReference[];
};
type GeneratedImage = { bytes: Buffer; usage: unknown; declaredMimeType: string | null };

function isImageSize(value: string): boolean {
  if (value === "auto") return true;
  const match = /^(\d+)x(\d+)$/.exec(value);
  if (!match) return false;
  const width = Number(match[1]);
  const height = Number(match[2]);
  return (
    width % 16 === 0 &&
    height % 16 === 0 &&
    Math.max(width, height) <= 3840 &&
    width / height <= 3 &&
    height / width <= 3 &&
    width * height >= 655360 &&
    width * height <= 8294400
  );
}

async function prepareImageGeneration(
  prompt: string,
  options: ImageOptions,
  ctx: MediaContext,
): Promise<ImageGeneration> {
  const { model, outputPath: output, references: reference } = options;
  const selected: ImageSettings =
    options.model === googleModel
      ? { provider: "google", settings: options.settings }
      : { provider: "openai", settings: options.settings };
  const { format } = selected.settings;
  const extensions = { png: [".png"], jpeg: [".jpg", ".jpeg"], webp: [".webp"] };
  if (!extensions[format].includes(extname(output).toLowerCase())) {
    throw new Error(`output extension must match format ${format}`);
  }
  const referenceLimit = selected.provider === "google" ? 14 : 16;
  if (reference.length > referenceLimit) {
    throw new Error(`model ${model} supports at most ${referenceLimit} references`);
  }

  const references: ImageReference[] = [];
  let referenceBytes = 0;
  for (const path of reference) {
    const data = (await ctx.backend.readFileBinary(path, { maxBytes: 50_000_000 })).content;
    const type = await fileTypeFromBuffer(data);
    if (!type || !["image/png", "image/jpeg", "image/webp"].includes(type.mime)) {
      throw new Error(`unsupported reference image: ${path}`);
    }
    referenceBytes += data.length;
    if (selected.provider === "google" && referenceBytes > 19_000_000) {
      throw new Error("reference images exceed the provider inline request limit");
    }
    references.push({ data, mime: type.mime, name: basename(path) });
  }
  return { model, output, prompt, references, ...selected };
}

function buildImageRequest(
  generation: ImageGeneration,
  apiKey: string,
): { url: string; init: RequestInit } {
  const { model, prompt, references } = generation;
  if (generation.provider === "google") {
    const settings = generation.settings;
    const body = JSON.stringify({
      contents: [
        {
          role: "user",
          parts: [
            { text: prompt },
            ...references.map((ref) => ({
              inlineData: { mimeType: ref.mime, data: ref.data.toString("base64") },
            })),
          ],
        },
      ],
      generationConfig: {
        responseModalities: ["TEXT", "IMAGE"],
        imageConfig: { aspectRatio: settings.aspectRatio, imageSize: settings.resolution },
        thinkingConfig: settings.thinking
          ? { thinkingLevel: settings.thinking.toUpperCase() }
          : undefined,
      },
    });
    if (Buffer.byteLength(body) > 19_000_000) {
      throw new Error("Gemini request exceeds the 19 MB inline request limit");
    }
    return {
      url: `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
      init: {
        method: "POST",
        headers: { "x-goog-api-key": apiKey, "Content-Type": "application/json" },
        body,
      },
    };
  }
  const { settings } = generation;
  const body = {
    model,
    prompt,
    n: 1,
    output_format: settings.format,
    size: settings.size,
    quality: settings.quality,
    complexity: settings.complexity,
    background: settings.background,
    output_compression: settings.compression,
  };
  if (references.length) {
    const form = new FormData();
    for (const [key, value] of Object.entries(body)) {
      if (value !== undefined) form.set(key, String(value));
    }
    for (const ref of references) {
      form.append("image[]", new Blob([new Uint8Array(ref.data)], { type: ref.mime }), ref.name);
    }
    return {
      url: "https://api.openai.com/v1/images/edits",
      init: { method: "POST", headers: { Authorization: `Bearer ${apiKey}` }, body: form },
    };
  }
  return {
    url: "https://api.openai.com/v1/images/generations",
    init: {
      method: "POST",
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    },
  };
}

const openaiResponse = z.object({
  data: z.array(z.object({ b64_json: z.string().min(1) })).length(1),
  usage: z.unknown().optional(),
});
const googleResponse = z.object({
  candidates: z
    .array(
      z.object({
        finishReason: z.string().optional(),
        content: z
          .object({
            parts: z.array(
              z.object({
                thought: z.boolean().optional(),
                inlineData: z.object({ mimeType: z.string(), data: z.string().min(1) }).optional(),
              }),
            ),
          })
          .optional(),
      }),
    )
    .optional(),
  usageMetadata: z.unknown().optional(),
});

async function readGeneratedImage(
  response: Response,
  provider: ImageGeneration["provider"],
): Promise<GeneratedImage> {
  if (provider === "openai") {
    const result = await readMediaJsonResponse(
      response,
      128 * 1024 * 1024,
      openaiResponse,
      "OpenAI image response",
    );
    return {
      bytes: Buffer.from(result.data[0]!.b64_json, "base64"),
      usage: result.usage ?? null,
      declaredMimeType: null,
    };
  }
  const result = await readMediaJsonResponse(
    response,
    128 * 1024 * 1024,
    googleResponse,
    "Google image response",
  );
  const candidate = result.candidates?.[0];
  const images = candidate?.content?.parts.filter((part) => part.inlineData && !part.thought) ?? [];
  if (candidate?.finishReason !== "STOP" || images.length !== 1) {
    throw new Error("provider did not return one completed image (possibly blocked)");
  }
  const image = images[0]!.inlineData!;
  return {
    bytes: Buffer.from(image.data, "base64"),
    usage: result.usageMetadata ?? null,
    declaredMimeType: image.mimeType,
  };
}

async function publishImage(
  image: GeneratedImage,
  generation: ImageGeneration,
  destination: Awaited<ReturnType<typeof prepareOutput>>,
  ctx: MediaContext,
): Promise<void> {
  await writeNew(ctx, join(destination.parts, "original.bin"), image.bytes);
  await writeNew(
    ctx,
    join(destination.parts, "manifest.json"),
    Buffer.from(
      JSON.stringify({
        model: generation.model,
        output: destination.path,
        usage: image.usage,
        source: { file: "original.bin", declaredMimeType: image.declaredMimeType },
      }),
    ),
  );
  const { format } = generation.settings;
  const actual = (await sharp(image.bytes).metadata()).format;
  await sharp(image.bytes).stats();
  if (actual !== format && generation.provider !== "google")
    throw new Error(`expected ${format}, received ${actual}`);
  const bytes =
    generation.provider === "google" && actual !== "png"
      ? await sharp(image.bytes).png().toBuffer()
      : image.bytes;
  const artifact = join(destination.parts, `image.${format}`);
  await writeNew(ctx, artifact, bytes);
  await publish(ctx, artifact, destination.path);
}

export async function generateImage(prompt: string, args: ImageOptions, options: MediaContext) {
  const apiKey =
    args.model === googleModel ? getGoogleApiKey(options.config) : getOpenAIApiKey(options.config);
  if (!apiKey) {
    throw new Error(
      args.model === googleModel
        ? "missing GEMINI_API_KEY or apiKeys.google"
        : "missing OPENAI_API_KEY or apiKeys.openai",
    );
  }
  const generation = await prepareImageGeneration(prompt, args, options);
  const request = buildImageRequest(generation, apiKey);
  const destination = await prepareOutput(options, generation.output);
  let stage = "requesting an image";
  try {
    const response = await mediaRequest(options, request.url, request.init);
    stage = "reading the provider image response";
    const image = await readGeneratedImage(response, generation.provider);
    stage = "saving or converting the generated image";
    await publishImage(image, generation, destination, options);
    return { outputPath: destination.path, artifacts: destination.parts, usage: image.usage };
  } catch (error) {
    throw new Error(
      `image generation failed while ${stage}: ${describeMediaError(error)}; retained artifacts: ${destination.parts} (may be incomplete; inspect original.bin, manifest.json, and image.${generation.settings.format} if present); no automatic retry; another generation request may incur another charge`,
    );
  }
}
