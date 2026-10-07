import { resolve } from "node:path";
import type { Readable } from "node:stream";
import { type ParseArgsConfig, parseArgs } from "node:util";
import {
  type Operation,
  openRouterModels,
  requestOpenRouterChat,
  requestOpenRouterDecisions,
  resolveOpenRouterModel,
} from "../models/openrouter.js";
import {
  decodeOpenRouterText,
  OPENROUTER_TEXT_BYTES,
  type OpenRouterAttachment,
} from "../models/openrouter_media.js";
import { parseMediaJson } from "../utils/media_validation.js";
import { spawnWithCapture } from "../utils/spawn_capture.js";
import type { RunToolCommandOptions } from "./cli.js";
import { ToolCliError } from "./errors.js";
import { requiredArg } from "./media.js";
import {
  probeOpenRouterMedia,
  readOpenRouterFile,
  readOpenRouterStdin,
} from "./openrouter_input.js";

function modelHelp(operation: Operation): string[] {
  return openRouterModels[operation].map(
    (model) =>
      `${model.id}\n  inputs: ${model.inputs.join(", ")}; reasoning: ${model.reasoning.join(", ") || "not supported"}\n  ${model.role}`,
  );
}

async function printHelp(
  operation: Operation | undefined,
  log: (line: string) => void | Promise<void>,
): Promise<void> {
  await log(
    [
      `usage: tau tool openrouter ${operation ?? "<decisions|chat>"} [flags]`,
      "",
      "  --help, -h              show help without reading input or making a request.",
      "  --list-models           list this operation's fixed models (standalone mode).",
      "  --model <id>            required exact model ID for requests.",
      ...(operation === "decisions"
        ? [
            "  --input <path|->        required UTF-8 JSON containing state and questions; - reads stdin.",
            "  --image <path>          repeatable PNG/JPEG/WebP attachment (Luna Decisions only).",
          ]
        : operation === "chat"
          ? [
              "  --prompt <text> | --prompt-file <path>   required user prompt.",
              "  --system <text> | --system-file <path>   optional explicit system instructions.",
              "  --image <path>          repeatable PNG/JPEG/WebP attachment.",
              "  --audio <path>          repeatable WAV/MP3 attachment (Gemini only).",
              "  --video <path>          MP4 attachment (Gemini only).",
              "  --reasoning <effort>    model-supported effort; omitted uses provider default.",
            ]
          : [
              "",
              "operations: decisions (typed judgments), chat (text and media understanding).",
              "place flags after the operation; use its --help for options.",
            ]),
      ...(operation ? ["", ...modelHelp(operation)] : []),
      "",
      "one standalone request; JSON stdout; no automatic retries or Tau session context.",
      "requires OPENROUTER_API_KEY or global apiKeys.openrouter; audio/video also require ffprobe.",
      "no output token cap is sent; provider defaults and model limits apply.",
      "documentation: https://github.com/markusylisiurunen/tau/blob/main/docs/openrouter.md",
    ].join("\n"),
  );
}

function parseOptions(argv: string[], operation: Operation) {
  const shared = {
    help: { type: "boolean", short: "h" },
    "list-models": { type: "boolean" },
    model: { type: "string" },
  } as const;
  const options: NonNullable<ParseArgsConfig["options"]> =
    operation === "decisions"
      ? {
          ...shared,
          input: { type: "string" } as const,
          image: { type: "string", multiple: true } as const,
        }
      : ({
          ...shared,
          prompt: { type: "string" },
          "prompt-file": { type: "string" },
          system: { type: "string" },
          "system-file": { type: "string" },
          reasoning: { type: "string" },
          image: { type: "string", multiple: true },
          audio: { type: "string", multiple: true },
          video: { type: "string", multiple: true },
        } as const);
  try {
    const parsed = parseArgs({ args: argv, options, tokens: true, allowPositionals: false });
    const seen = new Set<string>();
    const attachments: OpenRouterAttachment[] = [];
    for (const token of parsed.tokens) {
      if (token.kind !== "option") continue;
      if (token.name === "image" || token.name === "audio" || token.name === "video") {
        attachments.push({ kind: token.name, path: requiredArg(token.value, token.name) });
      } else if (seen.has(token.name)) {
        throw new ToolCliError(`duplicate --${token.name}`);
      }
      seen.add(token.name);
    }
    return {
      values: parsed.values,
      attachments,
    };
  } catch (error) {
    throw new ToolCliError(error instanceof Error ? error.message : String(error));
  }
}

async function textInput(
  inline: unknown,
  file: unknown,
  name: string,
  cwd: string,
): Promise<string> {
  if ((inline === undefined) === (file === undefined))
    throw new ToolCliError(`provide exactly one of --${name} or --${name}-file`);
  const text =
    inline === undefined
      ? decodeOpenRouterText(
          await readOpenRouterFile(
            resolve(cwd, requiredArg(file, `${name}-file`)),
            OPENROUTER_TEXT_BYTES,
          ),
        )
      : requiredArg(inline, name);
  if (!text.trim() || Buffer.byteLength(text) > OPENROUTER_TEXT_BYTES)
    throw new ToolCliError(
      `${name} must be nonblank and at most ${OPENROUTER_TEXT_BYTES} UTF-8 bytes`,
    );
  return text;
}

export async function runOpenRouterCommand(
  argv: string[],
  options: RunToolCommandOptions & {
    stdin?: Readable & { isTTY?: boolean };
    spawnImpl?: typeof spawnWithCapture;
  },
): Promise<void> {
  const [operation, ...flags] = argv;
  const log =
    options.stdout ??
    ((line: string) =>
      new Promise<void>((resolve, reject) => {
        process.stdout.write(`${line}\n`, (error) => {
          if (error) reject(error);
          else resolve();
        });
      }));
  if ((operation === "--help" || operation === "-h") && !flags.length) {
    await printHelp(undefined, log);
    return;
  }
  if (operation !== "decisions" && operation !== "chat")
    throw new ToolCliError("use tau tool openrouter <decisions|chat> --help");
  const { values, attachments } = parseOptions(flags, operation);
  if (values.help) {
    await printHelp(operation, log);
    return;
  }
  if (values["list-models"]) {
    if (Object.keys(values).length !== 1)
      throw new ToolCliError("--list-models cannot be combined with request flags");
    await log(JSON.stringify({ models: openRouterModels[operation] }));
    return;
  }
  const requestedModel = requiredArg(values.model, "model");
  resolveOpenRouterModel(operation, requestedModel);
  const cwd = options.cwd ?? process.cwd();
  if (operation === "decisions") {
    const path = requiredArg(values.input, "input");
    const bytes =
      path === "-"
        ? await readOpenRouterStdin(options.stdin ?? process.stdin)
        : await readOpenRouterFile(resolve(cwd, path), OPENROUTER_TEXT_BYTES);
    const result = await requestOpenRouterDecisions(
      {
        model: requestedModel,
        value: parseMediaJson(decodeOpenRouterText(bytes), "decisions input"),
        attachments: attachments.map((item) => ({
          kind: item.kind,
          path: resolve(cwd, item.path!),
        })),
      },
      {
        ...options,
        signal: new AbortController().signal,
        mediaAdapter: {
          readFile: readOpenRouterFile,
          probe: (bytes, format) =>
            probeOpenRouterMedia(bytes, format, options.spawnImpl ?? spawnWithCapture),
        },
      },
    );
    await log(JSON.stringify(result));
    return;
  }
  const prompt = await textInput(values.prompt, values["prompt-file"], "prompt", cwd);
  const system =
    values.system === undefined && values["system-file"] === undefined
      ? undefined
      : await textInput(values.system, values["system-file"], "system", cwd);
  const result = await requestOpenRouterChat(
    {
      model: requestedModel,
      prompt,
      system,
      reasoning: values.reasoning as string | undefined,
      attachments: attachments.map((item) => ({ kind: item.kind, path: resolve(cwd, item.path!) })),
    },
    {
      ...options,
      signal: new AbortController().signal,
      mediaAdapter: {
        readFile: readOpenRouterFile,
        probe: (bytes, format) =>
          probeOpenRouterMedia(bytes, format, options.spawnImpl ?? spawnWithCapture),
      },
    },
  );
  await log(JSON.stringify(result));
}
