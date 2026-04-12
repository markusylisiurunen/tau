import type {
  Api,
  AssistantMessageEventStream,
  Context,
  Model,
  ProviderStreamOptions,
  SimpleStreamOptions,
  ThinkingLevel,
} from "@mariozechner/pi-ai";
import { stream, streamSimple, supportsXhigh } from "@mariozechner/pi-ai";
import type { ReasoningEffort } from "../types.js";
import type { TauStreamOptions } from "./streaming_settings.js";

type BedrockStreamOptions = ProviderStreamOptions & {
  reasoning?: ThinkingLevel;
  thinkingBudgets?: TauStreamOptions["thinkingBudgets"];
  interleavedThinking?: boolean;
};

type CodexStreamOptions = ProviderStreamOptions & {
  reasoningEffort?: ReasoningEffort;
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

export function resolveCodexReasoningEffort(
  model: Model<"openai-codex-responses">,
  reasoning: TauStreamOptions["reasoning"],
): ReasoningEffort | undefined {
  if (reasoning === undefined || reasoning === "none") {
    return reasoning;
  }

  if (supportsXhigh(model) || reasoning !== "xhigh") {
    return reasoning;
  }

  return "high";
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

  if (isOpenAICodexModel(model)) {
    const reasoningEffort = resolveCodexReasoningEffort(model, options.reasoning);
    const { reasoning: _reasoning, ...baseOptions } = options;
    const providerOptions = {
      ...baseOptions,
      // TODO: Enable websocket transport by default once pi-ai fixes the WebSocket transport bug.
      // ...(options.transport === undefined ? { transport: "websocket" as const } : {}),
      ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
    } satisfies CodexStreamOptions;

    return stream(model, context, providerOptions);
  }

  return streamSimple(model, context, resolveSimpleStreamOptions(options));
}
