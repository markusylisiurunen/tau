import type {
  Api,
  AssistantMessageEventStream,
  Context,
  Model,
  ProviderStreamOptions,
  ThinkingLevel,
} from "@mariozechner/pi-ai";
import { stream, streamSimple, supportsXhigh } from "@mariozechner/pi-ai";
import type { TauStreamOptions } from "./streaming_settings.js";

type BedrockStreamOptions = ProviderStreamOptions & {
  reasoning?: TauStreamOptions["reasoning"];
  thinkingBudgets?: TauStreamOptions["thinkingBudgets"];
  interleavedThinking?: boolean;
};

type CodexStreamOptions = ProviderStreamOptions & {
  reasoningEffort?: ThinkingLevel;
};

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
  return {
    ...options,
    maxTokens: options.maxTokens || Math.min(model.maxTokens, 32000),
    ...(isBedrockAnthropicModel(model) ? { interleavedThinking: true } : {}),
  };
}

function resolveCodexReasoningEffort(
  model: Model<"openai-codex-responses">,
  reasoning: TauStreamOptions["reasoning"],
): ThinkingLevel | undefined {
  if (reasoning === undefined) {
    return undefined;
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

  return streamSimple(model, context, options);
}
