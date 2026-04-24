import type { Api, AssistantMessage, Model } from "@mariozechner/pi-ai";
import { isContextOverflow } from "@mariozechner/pi-ai";

export type AutoRetryContext = {
  model: Model<Api>;
  error: unknown;
};

const RETRYABLE_ERROR_REGEX =
  /overloaded|provider.?returned.?error|high.?demand|peak.?load|maximum.?usage.?size|provisioned.?throughput|rate.?limit|too many requests|429|500|502|503|504|service.?unavailable|server.?error|internal.?error|network.?error|connection.?error|connection.?refused|connection.?lost|websocket.?error|other side closed|fetch failed|upstream.?connect|reset before headers|socket hang up|ended without|http2 request did not get a response|timed? out|timeout|terminated|retry delay/i;

function asAssistantMessage(error: unknown): AssistantMessage | undefined {
  if (!error || typeof error !== "object") {
    return undefined;
  }

  const message = error as Partial<AssistantMessage>;
  if (message.role !== "assistant" && message.stopReason !== "error") {
    return undefined;
  }

  if (typeof message.stopReason !== "string") {
    return undefined;
  }

  return message as AssistantMessage;
}

export function shouldAutoRetry({ model, error }: AutoRetryContext): boolean {
  const message = asAssistantMessage(error);
  if (!message) {
    return false;
  }

  if (message.stopReason !== "error" || !message.errorMessage) {
    return false;
  }

  if (isContextOverflow(message, model.contextWindow)) {
    return false;
  }

  return RETRYABLE_ERROR_REGEX.test(message.errorMessage);
}
