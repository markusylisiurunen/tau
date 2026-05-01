import type {
  Api,
  AssistantMessage,
  AssistantMessageEventStream,
  Context,
  Model,
  ProviderStreamOptions,
  SimpleStreamOptions,
  ThinkingLevel,
} from "@mariozechner/pi-ai";
import { stream, streamSimple, supportsXhigh } from "@mariozechner/pi-ai";
import type { ReasoningEffort, ServiceTier } from "../types.js";
import type { TauStreamOptions } from "./streaming_settings.js";

type BedrockStreamOptions = ProviderStreamOptions & {
  reasoning?: ThinkingLevel;
  thinkingBudgets?: TauStreamOptions["thinkingBudgets"];
  interleavedThinking?: boolean;
};

type OpenAIResponsesStreamOptions = ProviderStreamOptions & {
  reasoningEffort?: ReasoningEffort;
  serviceTier?: ServiceTier;
};

function normalizeSimpleReasoning(
  reasoning: TauStreamOptions["reasoning"],
): ThinkingLevel | undefined {
  if (reasoning === undefined || reasoning === "none") {
    return undefined;
  }

  return reasoning;
}

export function resolveSimpleStreamOptions(options: TauStreamOptions): SimpleStreamOptions {
  const { reasoning, ...baseOptions } = options;
  const normalizedReasoning = normalizeSimpleReasoning(reasoning);

  if (normalizedReasoning === undefined) {
    return baseOptions;
  }

  return {
    ...baseOptions,
    reasoning: normalizedReasoning,
  };
}

function isBedrockModel(model: Model<Api>): model is Model<"bedrock-converse-stream"> {
  return model.api === "bedrock-converse-stream" || model.provider === "amazon-bedrock";
}

function isBedrockAnthropicModel(model: Model<Api>): boolean {
  return isBedrockModel(model) && model.id.includes("anthropic.");
}

function isOpenAIResponsesModel(model: Model<Api>): model is Model<"openai-responses"> {
  return model.api === "openai-responses" && model.provider === "openai";
}

function isOpenAICodexModel(model: Model<Api>): model is Model<"openai-codex-responses"> {
  return model.api === "openai-codex-responses" && model.provider === "openai-codex";
}

function resolveBedrockOptions(
  model: Model<"bedrock-converse-stream">,
  options: TauStreamOptions,
): BedrockStreamOptions {
  const { reasoning, ...baseOptions } = options;
  const normalizedReasoning = normalizeSimpleReasoning(reasoning);

  return {
    ...baseOptions,
    ...(normalizedReasoning !== undefined ? { reasoning: normalizedReasoning } : {}),
    maxTokens: options.maxTokens || Math.min(model.maxTokens, 32000),
    ...(isBedrockAnthropicModel(model) ? { interleavedThinking: true } : {}),
  };
}

export function resolveOpenAIReasoningEffort(
  model: Model<"openai-responses"> | Model<"openai-codex-responses">,
  reasoning: TauStreamOptions["reasoning"],
): ReasoningEffort | undefined {
  if (reasoning === undefined) {
    return undefined;
  }

  if (reasoning === "none") {
    return reasoning;
  }

  if (supportsXhigh(model) || reasoning !== "xhigh") {
    return reasoning;
  }

  return "high";
}

export function resolveOpenAIResponsesOptions(
  model: Model<"openai-responses"> | Model<"openai-codex-responses">,
  options: TauStreamOptions,
): OpenAIResponsesStreamOptions {
  const reasoningEffort = resolveOpenAIReasoningEffort(model, options.reasoning);
  const { reasoning: _reasoning, serviceTier: _serviceTier, ...baseOptions } = options;

  return {
    ...baseOptions,
    ...(isOpenAICodexModel(model) && options.transport === undefined
      ? { transport: "websocket-cached" as const }
      : {}),
    ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
    ...(options.serviceTier !== undefined ? { serviceTier: options.serviceTier } : {}),
  } satisfies OpenAIResponsesStreamOptions;
}

export function resolveOpenAICodexCachedWebSocketFallbackOptions(args: {
  model: Model<Api>;
  options: TauStreamOptions;
  result: AssistantMessage;
  receivedProviderEvent: boolean;
}): TauStreamOptions | undefined {
  if (!isOpenAICodexModel(args.model)) {
    return undefined;
  }

  if (args.options.transport !== "websocket-cached") {
    return undefined;
  }

  if (args.receivedProviderEvent || args.result.stopReason !== "error") {
    return undefined;
  }

  return {
    ...args.options,
    transport: "sse",
  };
}

export function streamModel<TApi extends Api>(
  model: Model<TApi>,
  context: Context,
  options: TauStreamOptions,
): AssistantMessageEventStream {
  if (isBedrockModel(model)) {
    const providerOptions = resolveBedrockOptions(model, options);
    return stream(model, context, providerOptions);
  }

  if (isOpenAIResponsesModel(model)) {
    return stream(model, context, resolveOpenAIResponsesOptions(model, options));
  }

  if (isOpenAICodexModel(model)) {
    return stream(model, context, resolveOpenAIResponsesOptions(model, options));
  }

  return streamSimple(model, context, resolveSimpleStreamOptions(options));
}
