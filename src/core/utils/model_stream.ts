import type {
  Api,
  AssistantMessageEventStream,
  Context,
  Model,
  OpenAIResponsesOptions,
  ThinkingLevel,
} from "@mariozechner/pi-ai";
import { stream, streamSimple, supportsXhigh } from "@mariozechner/pi-ai";
import { ensureCodexSystemPrompt } from "../auth/codex_prompt.js";
import type { TauStreamOptions } from "./streaming_settings.js";

function isOpenAIResponsesModel(model: Model<Api>): model is Model<"openai-responses"> {
  return model.api === "openai-responses";
}

function isBedrockModel(model: Model<Api>): model is Model<"bedrock-converse-stream"> {
  return model.api === "bedrock-converse-stream" || model.provider === "amazon-bedrock";
}

function isBedrockAnthropicModel(model: Model<Api>): boolean {
  return isBedrockModel(model) && model.id.includes("anthropic.");
}

function clampReasoning(effort: ThinkingLevel): Exclude<ThinkingLevel, "xhigh"> {
  return effort === "xhigh" ? "high" : effort;
}

export function streamModel<TApi extends Api>(
  model: Model<TApi>,
  context: Context,
  options: TauStreamOptions,
): AssistantMessageEventStream {
  const resolvedContext =
    model.provider === "openai-codex"
      ? {
          ...context,
          systemPrompt: ensureCodexSystemPrompt(context.systemPrompt ?? ""),
        }
      : context;

  if (isOpenAIResponsesModel(model) && options.serviceTier !== undefined) {
    const { reasoning, thinkingBudgets: _thinkingBudgets, serviceTier, ...rest } = options;

    const providerOptions = {
      ...rest,
      maxTokens: rest.maxTokens || Math.min(model.maxTokens, 32000),
      ...(reasoning && {
        reasoningEffort: supportsXhigh(model) ? reasoning : clampReasoning(reasoning),
      }),
      serviceTier,
    } satisfies OpenAIResponsesOptions;

    return stream(model, resolvedContext, providerOptions);
  }

  if (isBedrockModel(model)) {
    const { serviceTier: _serviceTier, ...rest } = options;
    const providerOptions = {
      ...rest,
      maxTokens: rest.maxTokens || Math.min(model.maxTokens, 32000),
      ...(isBedrockAnthropicModel(model) ? { interleavedThinking: true } : {}),
    };

    return stream(model as Model<"bedrock-converse-stream">, resolvedContext, providerOptions as any);
  }

  return streamSimple(model, resolvedContext, options);
}
