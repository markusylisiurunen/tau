import { resolve } from "node:path";
import type { Readable } from "node:stream";
import { type ParseArgsConfig, parseArgs } from "node:util";
import { z } from "zod";
import { getApiKeyForProvider } from "../config/schema.js";
import { spawnWithCapture } from "../utils/spawn_capture.js";
import type { RunToolCommandOptions } from "./cli.js";
import { ToolCliError } from "./errors.js";
import { parseMediaJson, readMediaResponse, requiredArg } from "./media.js";
import {
  decisionResponse,
  parseDecisionInput,
  validateDecisionAnswers,
} from "./openrouter_decisions.js";
import {
  decodeOpenRouterText,
  OPENROUTER_REQUEST_BYTES,
  OPENROUTER_TEXT_BYTES,
  type OpenRouterAttachment,
  prepareOpenRouterAttachments,
  readOpenRouterFile,
  readOpenRouterStdin,
} from "./openrouter_media.js";

type Operation = "decisions" | "chat";
type Model = { id: string; inputs: string[]; reasoning: string[]; role: string };
const models: Record<Operation, Model[]> = {
  decisions: [
    {
      id: "typesafe/jev-1.13",
      inputs: ["state", "questions"],
      reasoning: [],
      role: "Typed classification, scoring, and verification with probabilities.",
    },
  ],
  chat: [
    {
      id: "google/gemini-3.8-flash",
      inputs: ["text", "image", "audio", "video"],
      reasoning: ["low", "medium", "high"],
      role: "Audio/video understanding and image-heavy analysis.",
    },
    {
      id: "openai/gpt-6-luna",
      inputs: ["text", "image"],
      reasoning: ["none", "low", "medium", "high", "xhigh", "max"],
      role: "Cheap everyday extraction, summarization, and routine image understanding.",
    },
    {
      id: "openai/gpt-6.1-sol",
      inputs: ["text", "image"],
      reasoning: ["low", "medium", "high", "xhigh", "max"],
      role: "Coding, debugging, and technical reasoning.",
    },
    {
      id: "anthropic/claude-opus-5.5",
      inputs: ["text", "image"],
      reasoning: ["low", "medium", "high", "xhigh", "max"],
      role: "Premium generalist for writing, synthesis, and difficult second opinions.",
    },
  ],
};

function modelHelp(operation: Operation): string[] {
  return models[operation].map(
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
      ? { ...shared, input: { type: "string" } as const }
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

const chatResponse = z.object({
  model: z.string().min(1),
  id: z.string().optional(),
  provider: z.string().optional(),
  usage: z
    .looseObject({
      prompt_tokens: z.number().int().nonnegative(),
      completion_tokens: z.number().int().nonnegative(),
      total_tokens: z.number().int().nonnegative(),
      cost: z.number().nonnegative().nullable().optional(),
    })
    .optional(),
  choices: z.tuple([
    z.object({
      finish_reason: z.enum(["stop", "length", "content_filter"]),
      native_finish_reason: z.string().nullable().optional(),
      message: z.object({
        role: z.literal("assistant"),
        content: z
          .union([z.string(), z.array(z.object({ type: z.literal("text"), text: z.string() }))])
          .nullish()
          .transform((content) =>
            typeof content === "string"
              ? content
              : (content?.map((part) => part.text).join("") ?? null),
          ),
        refusal: z.string().nullable().optional(),
        tool_calls: z.array(z.unknown()).max(0).optional(),
      }),
    }),
  ]),
});

function requestFailure(status: number): ToolCliError {
  const kind =
    status === 401
      ? "authentication failed; check OPENROUTER_API_KEY or global apiKeys.openrouter"
      : status === 402
        ? "insufficient credits; check OpenRouter billing"
        : status === 403
          ? "request forbidden; check key permissions and content policy"
          : status === 429
            ? "rate limited; wait before deciding whether to retry"
            : status >= 500
              ? "provider or OpenRouter service failure"
              : "request rejected";
  return new ToolCliError(`OpenRouter ${kind} (status ${status}); no automatic retry`);
}

async function request(
  operation: Operation,
  body: unknown,
  options: RunToolCommandOptions,
): Promise<unknown> {
  const payload = JSON.stringify(body);
  if (Buffer.byteLength(payload) > OPENROUTER_REQUEST_BYTES)
    throw new ToolCliError("encoded request exceeds 20 MB; reduce text or attachments");
  const key =
    (options.env ?? process.env).OPENROUTER_API_KEY?.trim() ||
    getApiKeyForProvider(options.config, "openrouter");
  if (!key)
    throw new ToolCliError(
      "configure OPENROUTER_API_KEY or global apiKeys.openrouter on this machine",
    );
  if (!/^[\x21-\x7e]+$/.test(key))
    throw new ToolCliError(
      "OpenRouter API key must contain only printable ASCII without whitespace",
    );
  const response = await (options.fetchImpl ?? fetch)(
    `https://openrouter.ai/api/${operation === "decisions" ? "alpha/decisions" : "v1/chat/completions"}`,
    {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.timeout(10 * 60 * 1000),
      headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
      body: payload,
    },
  );
  if (!response.ok) {
    await response.body?.cancel();
    throw requestFailure(response.status);
  }
  const value = parseMediaJson(
    decodeOpenRouterText(await readMediaResponse(response, 8_000_000)),
    "OpenRouter response",
  );
  if (value && typeof value === "object" && "error" in value) {
    const error = z.object({ code: z.number().int() }).safeParse(value.error);
    if (error.success) throw requestFailure(error.data.code);
    throw new ToolCliError("OpenRouter returned a provider error; no automatic retry");
  }
  return value;
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
    await log(JSON.stringify({ models: models[operation] }));
    return;
  }
  const requestedModel = requiredArg(values.model, "model");
  const spec = models[operation].find((model) => model.id === requestedModel);
  if (!spec)
    throw new ToolCliError(`unsupported ${operation} model; use ${operation} --list-models`);
  const cwd = options.cwd ?? process.cwd();
  if (operation === "decisions") {
    const path = requiredArg(values.input, "input");
    const bytes =
      path === "-"
        ? await readOpenRouterStdin(options.stdin ?? process.stdin)
        : await readOpenRouterFile(resolve(cwd, path), OPENROUTER_TEXT_BYTES);
    const input = parseDecisionInput(
      parseMediaJson(decodeOpenRouterText(bytes), "decisions input"),
    );
    const result = decisionResponse.safeParse(
      await request(operation, { model: requestedModel, ...input }, options),
    );
    if (!result.success)
      throw new ToolCliError("OpenRouter returned an invalid decisions response");
    validateDecisionAnswers(input, result.data);
    await log(JSON.stringify({ requested_model: requestedModel, ...result.data }));
    return;
  }
  if (
    values.reasoning !== undefined &&
    !spec.reasoning.includes(requiredArg(values.reasoning, "reasoning"))
  )
    throw new ToolCliError(
      `unsupported reasoning effort for ${requestedModel}; use chat --list-models`,
    );
  if (attachments.some((item) => !spec.inputs.includes(item.kind)))
    throw new ToolCliError(
      "audio and video require google/gemini-3.8-flash; no model substitution is performed",
    );
  const prompt = await textInput(values.prompt, values["prompt-file"], "prompt", cwd);
  const system =
    values.system === undefined && values["system-file"] === undefined
      ? undefined
      : await textInput(values.system, values["system-file"], "system", cwd);
  const media = await prepareOpenRouterAttachments(
    attachments.map((item) => ({ ...item, path: resolve(cwd, item.path) })),
    options.spawnImpl ?? spawnWithCapture,
  );
  const messages: unknown[] = [];
  if (system !== undefined) messages.push({ role: "system", content: system });
  messages.push({ role: "user", content: [{ type: "text", text: prompt }, ...media] });
  const result = chatResponse.safeParse(
    await request(
      operation,
      {
        model: requestedModel,
        messages,
        stream: false,
        ...(values.reasoning === undefined ? {} : { reasoning: { effort: values.reasoning } }),
        provider: { require_parameters: true },
      },
      options,
    ),
  );
  if (!result.success)
    throw new ToolCliError("OpenRouter returned an invalid or unsupported chat response");
  const { choices, ...metadata } = result.data;
  const { message, finish_reason, native_finish_reason } = choices[0];
  if (finish_reason === "stop" && !message.content?.trim() && !message.refusal)
    throw new ToolCliError("OpenRouter returned no answer or refusal");
  await log(
    JSON.stringify({
      requested_model: requestedModel,
      ...metadata,
      answer: message.content,
      finish_reason,
      native_finish_reason,
      refusal: message.refusal,
    }),
  );
}
