import type { Api, Model } from "@earendil-works/pi-ai";
import type { Config } from "../config/index.js";
import { prependTauHiddenSystemMessages } from "./user_metadata.js";

export function normalizeModelNoticeKey(provider: string, modelId: string): string {
  return `${provider.trim().toLowerCase()}/${modelId.trim().toLowerCase()}`;
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
