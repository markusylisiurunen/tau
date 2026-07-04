import type { Api, Model } from "@earendil-works/pi-ai";
import type { Config } from "../config/index.js";
import { prependTauHiddenSystemMessages } from "./user_metadata.js";

export function normalizeModelNoticeKey(provider: string, modelId: string): string {
  return `${provider.trim().toLowerCase()}/${modelId.trim().toLowerCase()}`;
}

export function parseModelNoticeKey(raw: string):
  | {
      provider: string;
      modelId: string;
    }
  | undefined {
  const value = raw.trim();
  if (!value) {
    return undefined;
  }

  const separator = value.indexOf("/");
  if (separator <= 0 || separator !== value.lastIndexOf("/") || separator >= value.length - 1) {
    return undefined;
  }

  const provider = value.slice(0, separator).trim().toLowerCase();
  const modelId = value.slice(separator + 1).trim();
  if (!provider || !modelId) {
    return undefined;
  }

  return {
    provider,
    modelId,
  };
}

export function resolveModelNotice(
  config: Config | undefined,
  model: Model<Api>,
): string | undefined {
  const notices = config?.modelSystemNotices;
  if (!notices) {
    return undefined;
  }

  const notice = notices[normalizeModelNoticeKey(model.provider, model.id)];
  const trimmed = notice?.trim();
  return trimmed || undefined;
}

export function prependModelNotice(text: string, notice?: string): string {
  const trimmedNotice = notice?.trim();
  if (!trimmedNotice) {
    return text;
  }

  return prependTauHiddenSystemMessages(text, [trimmedNotice]);
}
