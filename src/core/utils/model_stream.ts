import type { Api, AssistantMessageEventStream, Context, Model } from "@mariozechner/pi-ai";
import { stream, streamSimple } from "@mariozechner/pi-ai";
import type { TauStreamOptions } from "./streaming_settings.js";

function isBedrockModel(model: Model<Api>): model is Model<"bedrock-converse-stream"> {
  return model.api === "bedrock-converse-stream" || model.provider === "amazon-bedrock";
}

function isBedrockAnthropicModel(model: Model<Api>): boolean {
  return isBedrockModel(model) && model.id.includes("anthropic.");
}

export function streamModel<TApi extends Api>(
  model: Model<TApi>,
  context: Context,
  options: TauStreamOptions,
): AssistantMessageEventStream {
  if (isBedrockModel(model)) {
    const providerOptions = {
      ...options,
      maxTokens: options.maxTokens || Math.min(model.maxTokens, 32000),
      ...(isBedrockAnthropicModel(model) ? { interleavedThinking: true } : {}),
    };

    return stream(model as Model<"bedrock-converse-stream">, context, providerOptions as any);
  }

  return streamSimple(model, context, options);
}
