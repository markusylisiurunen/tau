import { z } from "zod";
import type { Config } from "../config/index.js";
import { getApiKeyForProvider } from "../config/schema.js";
import { parseMediaJson, readMediaResponse } from "../utils/media_validation.js";
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
  type OpenRouterMediaAdapter,
  type OpenRouterMediaPart,
  prepareOpenRouterAttachments,
} from "./openrouter_media.js";

export type OpenRouterRequestOptions = {
  config: Config;
  signal: AbortSignal;
  env?: NodeJS.ProcessEnv;
  fetchImpl?: typeof fetch;
};

export type OpenRouterChatInput = {
  model: string;
  prompt: string;
  system?: string;
  reasoning?: string;
  attachments: OpenRouterAttachment[];
};

export type OpenRouterDecisionsInput = {
  model: string;
  value: unknown;
  attachments: OpenRouterAttachment[];
};

export type Operation = "decisions" | "chat";
export type OpenRouterModel = { id: string; inputs: string[]; reasoning: string[]; role: string };
export const openRouterModels: Record<Operation, OpenRouterModel[]> = {
  decisions: [
    {
      id: "openai/gpt-6-luna-decisions",
      inputs: ["state", "questions", "image"],
      reasoning: [],
      role: "Fast, input-only-priced classification, scoring, and verification with probabilities.",
    },
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

export function resolveOpenRouterModel(operation: Operation, id: string): OpenRouterModel {
  const model = openRouterModels[operation].find((model) => model.id === id);
  if (!model) throw new Error(`unsupported ${operation} model; use ${operation} --list-models`);
  return model;
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

function requestFailure(status: number): Error {
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
  return new Error(`OpenRouter ${kind} (status ${status}); no automatic retry`);
}

async function requestOpenRouter(
  operation: Operation,
  body: unknown,
  options: OpenRouterRequestOptions,
): Promise<unknown> {
  const payload = JSON.stringify(body);
  if (Buffer.byteLength(payload) > OPENROUTER_REQUEST_BYTES)
    throw new Error("encoded request exceeds 20 MB; reduce text or attachments");
  const key =
    (options.env ?? process.env).OPENROUTER_API_KEY?.trim() ||
    getApiKeyForProvider(options.config, "openrouter");
  if (!key)
    throw new Error("configure OPENROUTER_API_KEY or global apiKeys.openrouter on this machine");
  if (!/^[\x21-\x7e]+$/.test(key))
    throw new Error("OpenRouter API key must contain only printable ASCII without whitespace");
  const response = await (options.fetchImpl ?? fetch)(
    `https://openrouter.ai/api/${operation === "decisions" ? "alpha/decisions" : "v1/chat/completions"}`,
    {
      method: "POST",
      redirect: "error",
      signal: AbortSignal.any([options.signal, AbortSignal.timeout(10 * 60 * 1000)]),
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
    throw new Error("OpenRouter returned a provider error; no automatic retry");
  }
  return value;
}

export async function requestOpenRouterDecisions(
  { model, value, attachments }: OpenRouterDecisionsInput,
  options: OpenRouterRequestOptions & { mediaAdapter: OpenRouterMediaAdapter },
) {
  options.signal.throwIfAborted();
  const spec = resolveOpenRouterModel("decisions", model);
  if (attachments.some((item) => item.kind !== "image" || !spec.inputs.includes(item.kind)))
    throw new Error("unsupported attachment modality for the selected decision model");
  const input = parseDecisionInput(model, value);
  if (Buffer.byteLength(JSON.stringify(input)) > OPENROUTER_TEXT_BYTES)
    throw new Error("decisions input exceeds its byte limit");
  const media = await prepareOpenRouterAttachments(
    attachments,
    options.mediaAdapter,
    options.signal,
  );
  const text = typeof input.state === "string" ? input.state : JSON.stringify(input.state);
  const state = media.length ? [{ type: "text", text }, ...media] : text;
  const result = decisionResponse.safeParse(
    await requestOpenRouter("decisions", { model, state, questions: input.questions }, options),
  );
  if (!result.success) throw new Error("OpenRouter returned an invalid decisions response");
  validateDecisionAnswers(input, result.data);
  return { requested_model: model, ...result.data };
}

export async function requestOpenRouterChat(
  input: OpenRouterChatInput,
  options: OpenRouterRequestOptions & { mediaAdapter: OpenRouterMediaAdapter },
) {
  options.signal.throwIfAborted();
  const spec = resolveOpenRouterModel("chat", input.model);
  if (input.reasoning !== undefined && !spec.reasoning.includes(input.reasoning))
    throw new Error("unsupported reasoning effort");
  if (input.attachments.some((attachment) => !spec.inputs.includes(attachment.kind)))
    throw new Error("unsupported attachment modality for the selected model");
  for (const value of [input.prompt, ...(input.system === undefined ? [] : [input.system])]) {
    if (!value.trim() || Buffer.byteLength(value) > OPENROUTER_TEXT_BYTES)
      throw new Error("prompt and system must be nonblank and within their byte limit");
  }
  const media = await prepareOpenRouterAttachments(
    input.attachments,
    options.mediaAdapter,
    options.signal,
  );
  const messages: Array<
    | { role: "system"; content: string }
    | { role: "user"; content: Array<{ type: "text"; text: string } | OpenRouterMediaPart> }
  > = [];
  if (input.system !== undefined) messages.push({ role: "system", content: input.system });
  messages.push({ role: "user", content: [{ type: "text", text: input.prompt }, ...media] });
  const result = chatResponse.safeParse(
    await requestOpenRouter(
      "chat",
      {
        model: input.model,
        messages,
        stream: false,
        ...(input.reasoning === undefined ? {} : { reasoning: { effort: input.reasoning } }),
        provider: { require_parameters: true },
      },
      options,
    ),
  );
  if (!result.success)
    throw new Error("OpenRouter returned an invalid or unsupported chat response");
  const { choices, ...metadata } = result.data;
  const { message, finish_reason, native_finish_reason } = choices[0];
  if (finish_reason === "stop" && !message.content?.trim() && !message.refusal)
    throw new Error("OpenRouter returned no answer or refusal");
  return {
    requested_model: input.model,
    ...metadata,
    answer: message.content,
    finish_reason,
    ...(native_finish_reason === undefined ? {} : { native_finish_reason }),
    ...(message.refusal === undefined ? {} : { refusal: message.refusal }),
  };
}
