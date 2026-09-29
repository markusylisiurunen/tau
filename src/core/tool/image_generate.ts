import { link, readFile, writeFile } from "node:fs/promises";
import { basename, extname, join, resolve } from "node:path";
import { fileTypeFromBuffer } from "file-type";
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

const ratios = ["1:1", "2:3", "3:2", "3:4", "4:3", "4:5", "5:4", "9:16", "16:9", "21:9"];
const wideRatios = [...ratios, "1:4", "4:1", "1:8", "8:1"];
const openaiFeatures = {
  size: [],
  quality: ["auto", "low", "medium", "high", "xhigh", "max"],
  background: ["auto", "opaque", "transparent"],
  format: ["png", "jpeg", "webp"],
  compression: [],
};
const imageModels: Record<
  string,
  {
    provider: "google" | "openai";
    features: Record<string, readonly string[]>;
    references: number;
  }
> = {
  "gemini-3-pro-image": {
    provider: "google",
    features: { "aspect-ratio": ratios, resolution: ["1K", "2K", "4K"], format: ["png"] },
    references: 14,
  },
  "gemini-3.1-flash-image": {
    provider: "google",
    features: {
      "aspect-ratio": wideRatios,
      resolution: ["512", "1K", "2K", "4K"],
      thinking: ["minimal", "high"],
      format: ["png"],
    },
    references: 14,
  },
  "gemini-3.1-flash-lite-image": {
    provider: "google",
    features: {
      "aspect-ratio": wideRatios,
      resolution: ["1K"],
      thinking: ["minimal", "high"],
      format: ["png"],
    },
    references: 14,
  },
  "gpt-image-2.5-flare": { provider: "openai", features: openaiFeatures, references: 16 },
  "gpt-image-2.5-sunburst": { provider: "openai", features: openaiFeatures, references: 16 },
};

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
      "never overwrites output or its .parts directory; see image-generation.md in tau_docs.",
    ].join("\n"),
  );
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

export async function runImageGenerateCommand(
  argv: string[],
  options: RunToolCommandOptions,
): Promise<void> {
  const args = parseMediaArgs(argv, {
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
  const log = options.stdout ?? console.log;
  if (args.help) {
    return printImageGenerateHelp(log);
  }
  const model = requiredArg(args.model, "model");
  const spec = Object.hasOwn(imageModels, model) ? imageModels[model] : undefined;
  if (!spec) {
    throw new ToolCliError(`unsupported image model: ${model}`);
  }
  const output = requiredArg(args.output, "output");
  if ((args.prompt === undefined) === (args["prompt-file"] === undefined)) {
    throw new ToolCliError("provide exactly one of --prompt or --prompt-file");
  }
  for (const feature of [
    "aspect-ratio",
    "resolution",
    "size",
    "quality",
    "background",
    "thinking",
    "format",
    "compression",
  ] as const) {
    const value = args[feature];
    if (value === undefined) {
      continue;
    }
    const supported = spec.features[feature];
    if (!supported || (supported.length && !supported.includes(value))) {
      throw new ToolCliError(
        `model ${model} does not support ${feature} ${value}${supported?.length ? `; supported: ${supported.join(", ")}` : ""}`,
      );
    }
  }
  const format = args.format ?? "png";
  const extensions: Record<string, string[]> = {
    png: [".png"],
    jpeg: [".jpg", ".jpeg"],
    webp: [".webp"],
  };
  if (!extensions[format]?.includes(extname(output).toLowerCase())) {
    throw new ToolCliError(`--output extension must match --format ${format}`);
  }
  if (args.background === "transparent" && format === "jpeg") {
    throw new ToolCliError("transparent backgrounds require png or webp");
  }
  if (
    args.compression !== undefined &&
    (!/^\d+$/.test(args.compression) || Number(args.compression) > 100 || format === "png")
  ) {
    throw new ToolCliError("--compression requires jpeg or webp and an integer from 0 to 100");
  }
  if (args.size !== undefined && args.size !== "auto") {
    const match = /^(\d+)x(\d+)$/.exec(args.size);
    const width = Number(match?.[1]);
    const height = Number(match?.[2]);
    if (
      !match ||
      width % 16 ||
      height % 16 ||
      Math.max(width, height) > 3840 ||
      width / height > 3 ||
      height / width > 3 ||
      width * height < 655360 ||
      width * height > 8294400
    ) {
      throw new ToolCliError(
        "--size requires multiples of 16, edges <=3840, aspect ratio between 1:3 and 3:1, and 655360–8294400 pixels",
      );
    }
  }
  const referencePaths = args.reference ?? [];
  if (referencePaths.length > spec.references) {
    throw new ToolCliError(`model ${model} supports at most ${spec.references} references`);
  }
  const cwd = options.cwd ?? process.cwd();
  const prompt =
    args.prompt ??
    (await readFile(resolve(cwd, requiredArg(args["prompt-file"], "prompt-file")), "utf8"));
  if (!prompt.trim()) {
    throw new ToolCliError("prompt must not be empty");
  }
  const references = [];
  let referenceBytes = 0;
  for (const path of referencePaths) {
    const data = await readFile(resolve(cwd, path));
    const type = await fileTypeFromBuffer(data);
    if (!type || !["image/png", "image/jpeg", "image/webp"].includes(type.mime)) {
      throw new ToolCliError(`unsupported reference image: ${path}`);
    }
    referenceBytes += data.length;
    if (
      data.length > 50_000_000 ||
      (spec.provider === "google" &&
        (referenceBytes * 4) / 3 + Buffer.byteLength(prompt) > 19_000_000)
    ) {
      throw new ToolCliError("reference images exceed the provider inline request limit");
    }
    references.push({ data, mime: type.mime, name: basename(path) });
  }
  const apiKey =
    spec.provider === "google"
      ? getGoogleApiKey(options.config, options.env)
      : getOpenAIApiKey(options.config, options.env);
  if (!apiKey) {
    throw new ToolCliError(`missing ${spec.provider} API key; see credentials.md`);
  }
  const destination = await prepareMediaOutput(output, cwd);
  try {
    const fetchImpl = options.fetchImpl ?? fetch;
    let bytes: Buffer;
    let usage: unknown;
    if (spec.provider === "openai") {
      const body = {
        model,
        prompt,
        n: 1,
        output_format: format,
        size: args.size,
        quality: args.quality,
        background: args.background,
        output_compression: args.compression === undefined ? undefined : Number(args.compression),
      };
      const form = new FormData();
      if (references.length) {
        for (const [key, value] of Object.entries(body)) {
          if (value !== undefined) {
            form.set(key, String(value));
          }
        }
        for (const ref of references) {
          form.append(
            "image[]",
            new Blob([new Uint8Array(ref.data)], { type: ref.mime }),
            ref.name,
          );
        }
      }
      const response = await mediaRequest(
        fetchImpl,
        `https://api.openai.com/v1/images/${references.length ? "edits" : "generations"}`,
        {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            ...(!references.length ? { "Content-Type": "application/json" } : {}),
          },
          body: references.length ? form : JSON.stringify(body),
        },
      );
      const result = openaiResponse.parse(
        JSON.parse((await readMediaResponse(response, 128 * 1024 * 1024)).toString("utf8")),
      );
      bytes = Buffer.from(result.data[0]!.b64_json, "base64");
      usage = result.usage;
    } else {
      const response = await mediaRequest(
        fetchImpl,
        `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent`,
        {
          method: "POST",
          headers: { "x-goog-api-key": apiKey, "Content-Type": "application/json" },
          body: JSON.stringify({
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
              imageConfig: { aspectRatio: args["aspect-ratio"], imageSize: args.resolution },
              thinkingConfig: args.thinking
                ? { thinkingLevel: args.thinking.toUpperCase() }
                : undefined,
            },
          }),
        },
      );
      const result = googleResponse.parse(
        JSON.parse((await readMediaResponse(response, 128 * 1024 * 1024)).toString("utf8")),
      );
      const candidate = result.candidates?.[0];
      const images =
        candidate?.content?.parts.filter((part) => part.inlineData && !part.thought) ?? [];
      if (candidate?.finishReason !== "STOP" || images.length !== 1) {
        throw new ToolCliError("provider did not return one completed image (possibly blocked)");
      }
      bytes = Buffer.from(images[0]!.inlineData!.data, "base64");
      usage = result.usageMetadata;
    }
    const type = await fileTypeFromBuffer(bytes);
    if (type?.mime !== `image/${format}`) {
      throw new ToolCliError(
        `provider returned an invalid or unexpected image format; expected ${format}`,
      );
    }
    const artifact = join(destination.parts, `image.${format}`);
    await writeFile(artifact, bytes, { flag: "wx" });
    await writeFile(
      join(destination.parts, "manifest.json"),
      JSON.stringify({ model, output: destination.path, usage: usage ?? null }, null, 2),
      { flag: "wx" },
    );
    await link(artifact, destination.path);
    log(
      JSON.stringify({
        output: destination.path,
        artifacts: destination.parts,
        usage: usage ?? null,
      }),
    );
  } catch (error) {
    throw new ToolCliError(
      `image generation failed; artifacts: ${destination.parts}; ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
