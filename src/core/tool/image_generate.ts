import { link, readFile, writeFile } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import { fileTypeFromBuffer } from "file-type";
import sharp from "sharp";
import { z } from "zod";
import { getGoogleApiKey, getOpenAIApiKey } from "../config/schema.js";
import type { RunToolCommandOptions } from "./cli.js";
import { ToolCliError } from "./errors.js";
import {
  mediaRequest,
  parseMediaArgs,
  prepareMediaOutput,
  readMediaResponse,
  requiredArg,
} from "./media.js";

const ratios = ["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"] as const;
const wideRatios = [...ratios, "1:4", "4:1", "1:8", "8:1"] as const;
const googleSettings = z.strictObject({
  "aspect-ratio": z.enum(wideRatios).optional(),
  resolution: z.enum(["512", "1K", "2K", "4K"]).optional(),
  thinking: z.enum(["minimal", "high"]).optional(),
  format: z.literal("png").default("png"),
});
const openaiSettings = z
  .strictObject({
    size: z
      .string()
      .refine(isImageSize, {
        message:
          "--size requires auto or multiples of 16, edges <=3840, aspect ratio between 1:3 and 3:1, and 655360–8294400 pixels",
      })
      .optional(),
    quality: z.enum(["auto", "low", "medium", "high", "xhigh", "max"]).optional(),
    background: z.enum(["auto", "opaque", "transparent"]).optional(),
    format: z.enum(["png", "jpeg", "webp"]).default("png"),
    compression: z
      .string()
      .regex(/^\d+$/)
      .transform(Number)
      .pipe(z.number().int().min(0).max(100))
      .optional(),
  })
  .refine((settings) => settings.background !== "transparent" || settings.format !== "jpeg", {
    message: "transparent backgrounds require png or webp",
  })
  .refine((settings) => settings.compression === undefined || settings.format !== "png", {
    message: "--compression requires jpeg or webp and an integer from 0 to 100",
  });

type ImageModel =
  | { provider: "google"; settings: z.ZodType<z.infer<typeof googleSettings>> }
  | { provider: "openai"; settings: typeof openaiSettings };

const imageModels: Record<string, ImageModel> = {
  "gemini-3-pro-image": {
    provider: "google",
    settings: googleSettings.extend({
      "aspect-ratio": z.enum(ratios).optional(),
      resolution: z.enum(["1K", "2K", "4K"]).optional(),
      thinking: z.never().optional(),
    }),
  },
  "gemini-3.1-flash-image": { provider: "google", settings: googleSettings },
  "gemini-3.1-flash-lite-image": {
    provider: "google",
    settings: googleSettings.extend({ resolution: z.literal("1K").optional() }),
  },
  "gpt-image-2.5-flare": { provider: "openai", settings: openaiSettings },
  "gpt-image-2.5-sunburst": { provider: "openai", settings: openaiSettings },
};

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

export function printImageGenerateHelp(log: (line: string) => void = console.log): void {
  log(
    [
      "usage: tau tool image-generate --model <id> (--prompt <text> | --prompt-file <path>) --output <path>",
      "",
      `models: ${Object.keys(imageModels).join(", ")}`,
      "options:",
      "  --reference <path>       repeatable local PNG/JPEG/WebP reference, in prompt order.",
      "  --aspect-ratio <ratio>   model-supported ratio (Gemini).",
      "  --resolution <tier>      512, 1K, 2K, or 4K, depending on model (Gemini).",
      "  --size <WIDTHxHEIGHT>    exact dimensions, or auto (OpenAI).",
      "  --quality <level>        auto, low, medium, high, xhigh, max (OpenAI).",
      "  --background <mode>      auto, opaque, transparent (OpenAI).",
      "  --thinking <level>       minimal or high (Gemini Flash/Lite).",
      "  --format <encoding>      png (default), jpeg, webp (OpenAI); png (Gemini).",
      "  --compression <0-100>    JPEG/WebP compression (OpenAI).",
      "  --help                  show this help.",
      "",
      "one stateless generation; unsupported features fail before generation.",
      "never overwrites output or its .parts directory.",
      "requires GEMINI_API_KEY or apiKeys.google for Google; OPENAI_API_KEY or apiKeys.openai for OpenAI.",
      "",
      "documentation: https://github.com/markusylisiurunen/tau/blob/main/docs/image-generation.md",
    ].join("\n"),
  );
}

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

function parseImageArgs(argv: string[]) {
  return parseMediaArgs(argv, {
    help: { type: "boolean", short: "h" },
    model: { type: "string" },
    prompt: { type: "string" },
    "prompt-file": { type: "string" },
    reference: { type: "string", multiple: true },
    output: { type: "string" },
    "aspect-ratio": { type: "string" },
    resolution: { type: "string" },
    size: { type: "string" },
    quality: { type: "string" },
    background: { type: "string" },
    thinking: { type: "string" },
    format: { type: "string" },
    compression: { type: "string" },
  });
}

async function prepareImageGeneration(
  args: Omit<ReturnType<typeof parseImageArgs>, "help">,
  cwd: string,
): Promise<ImageGeneration> {
  const {
    model: modelArg,
    output: outputArg,
    prompt: promptArg,
    "prompt-file": promptFile,
    reference = [],
    ...controls
  } = args;
  const model = requiredArg(modelArg, "model");
  const spec = Object.hasOwn(imageModels, model) ? imageModels[model] : undefined;
  if (!spec) throw new ToolCliError(`unsupported image model: ${model}`);
  const selected: ImageSettings =
    spec.provider === "google"
      ? { provider: "google", settings: spec.settings.parse(controls) }
      : { provider: "openai", settings: spec.settings.parse(controls) };
  const output = requiredArg(outputArg, "output");
  const { format } = selected.settings;
  const extensions = { png: [".png"], jpeg: [".jpg", ".jpeg"], webp: [".webp"] };
  if (!extensions[format].includes(extname(output).toLowerCase())) {
    throw new ToolCliError(`--output extension must match --format ${format}`);
  }
  if ((promptArg === undefined) === (promptFile === undefined)) {
    throw new ToolCliError("provide exactly one of --prompt or --prompt-file");
  }
  const referenceLimit = spec.provider === "google" ? 14 : 16;
  if (reference.length > referenceLimit) {
    throw new ToolCliError(`model ${model} supports at most ${referenceLimit} references`);
  }
  const prompt =
    promptArg ?? (await readFile(resolve(cwd, requiredArg(promptFile, "prompt-file")), "utf8"));
  if (!prompt.trim()) throw new ToolCliError("prompt must not be empty");
  const references: ImageReference[] = [];
  let referenceBytes = 0;
  for (const path of reference) {
    const data = await readFile(resolve(cwd, path));
    const type = await fileTypeFromBuffer(data);
    if (!type || !["image/png", "image/jpeg", "image/webp"].includes(type.mime)) {
      throw new ToolCliError(`unsupported reference image: ${path}`);
    }
    referenceBytes += data.length;
    if (data.length > 50_000_000 || (spec.provider === "google" && referenceBytes > 19_000_000)) {
      throw new ToolCliError("reference images exceed the provider inline request limit");
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
        imageConfig: { aspectRatio: settings["aspect-ratio"], imageSize: settings.resolution },
        thinkingConfig: settings.thinking
          ? { thinkingLevel: settings.thinking.toUpperCase() }
          : undefined,
      },
    });
    if (Buffer.byteLength(body) > 19_000_000) {
      throw new ToolCliError("Gemini request exceeds the 19 MB inline request limit");
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
  const value = JSON.parse((await readMediaResponse(response, 128 * 1024 * 1024)).toString("utf8"));
  if (provider === "openai") {
    const result = openaiResponse.parse(value);
    return {
      bytes: Buffer.from(result.data[0]!.b64_json, "base64"),
      usage: result.usage ?? null,
      declaredMimeType: null,
    };
  }
  const result = googleResponse.parse(value);
  const candidate = result.candidates?.[0];
  const images = candidate?.content?.parts.filter((part) => part.inlineData && !part.thought) ?? [];
  if (candidate?.finishReason !== "STOP" || images.length !== 1) {
    throw new ToolCliError("provider did not return one completed image (possibly blocked)");
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
  destination: Awaited<ReturnType<typeof prepareMediaOutput>>,
): Promise<void> {
  await writeFile(join(destination.parts, "original.bin"), image.bytes, {
    flag: "wx",
    mode: 0o600,
  });
  await writeFile(
    join(destination.parts, "manifest.json"),
    JSON.stringify(
      {
        model: generation.model,
        output: destination.path,
        usage: image.usage,
        source: { file: "original.bin", declaredMimeType: image.declaredMimeType },
      },
      null,
      2,
    ),
    { flag: "wx" },
  );
  const { format } = generation.settings;
  const bytes =
    generation.provider === "google" && image.declaredMimeType !== "image/png"
      ? await sharp(image.bytes).png().toBuffer()
      : image.bytes;
  const artifact = join(destination.parts, `image.${format}`);
  await writeFile(artifact, bytes, { flag: "wx" });
  await link(artifact, destination.path);
}

export async function runImageGenerateCommand(
  argv: string[],
  options: RunToolCommandOptions,
): Promise<void> {
  const { help, ...args } = parseImageArgs(argv);
  const log = options.stdout ?? console.log;
  if (help) return printImageGenerateHelp(log);
  const cwd = options.cwd ?? process.cwd();
  const generation = await prepareImageGeneration(args, cwd);
  const apiKey =
    generation.provider === "google"
      ? getGoogleApiKey(options.config, options.env)
      : getOpenAIApiKey(options.config, options.env);
  if (!apiKey) {
    throw new ToolCliError(
      generation.provider === "google"
        ? "missing GEMINI_API_KEY or apiKeys.google"
        : "missing OPENAI_API_KEY or apiKeys.openai",
    );
  }
  const request = buildImageRequest(generation, apiKey);
  const destination = await prepareMediaOutput(generation.output, cwd);
  try {
    const response = await mediaRequest(options.fetchImpl ?? fetch, request.url, request.init);
    const image = await readGeneratedImage(response, generation.provider);
    await publishImage(image, generation, destination);
    log(
      JSON.stringify({
        output: destination.path,
        artifacts: destination.parts,
        usage: image.usage,
      }),
    );
  } catch (error) {
    throw new ToolCliError(
      `image generation failed; artifacts: ${destination.parts}; ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
