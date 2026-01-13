import type {
  Api,
  AssistantMessageEventStream,
  Context,
  Model,
  OpenAIResponsesOptions,
  ThinkingLevel,
} from "@mariozechner/pi-ai";
import { stream, streamSimple, supportsXhigh } from "@mariozechner/pi-ai";
import type { TauStreamOptions } from "./streaming_settings.js";

function isOpenAIResponsesModel(model: Model<Api>): model is Model<"openai-responses"> {
  return model.api === "openai-responses";
}

function clampReasoning(effort: ThinkingLevel): Exclude<ThinkingLevel, "xhigh"> {
  return effort === "xhigh" ? "high" : effort;
}

export function streamModel<TApi extends Api>(
  model: Model<TApi>,
  context: Context,
  options: TauStreamOptions,
): AssistantMessageEventStream {
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

    return stream(model, context, providerOptions);
  }

  return streamSimple(model, context, options);
}
