import type { Api, Model } from "@earendil-works/pi-ai";

const GPT_5_6_CODEX_MODEL_IDS = new Set(["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]);

export function applyTauModelOverrides(model: Model<Api>): Model<Api> {
  if (
    model.provider !== "openai-codex" ||
    model.contextWindow !== 272_000 ||
    !GPT_5_6_CODEX_MODEL_IDS.has(model.id)
  ) {
    return model;
  }

  return { ...model, contextWindow: 372_000 };
}
