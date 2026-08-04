import { isDeepStrictEqual } from "node:util";
import type { Api, Model, ModelCost } from "@earendil-works/pi-ai";

const GPT_5_6_CODEX_MODEL_IDS = new Set(["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]);

type BaseModelCost = Omit<ModelCost, "tiers">;

function withLongContextPricing(cost: BaseModelCost): ModelCost {
  const round = (value: number) => Number(value.toFixed(6));

  return {
    ...cost,
    tiers: [
      {
        inputTokensAbove: 272_000,
        input: round(cost.input * 2),
        output: round(cost.output * 1.5),
        cacheRead: round(cost.cacheRead * 2),
        cacheWrite: round(cost.cacheWrite * 2),
      },
    ],
  };
}

const GPT_5_6_COST_OVERRIDES: Record<string, { current: ModelCost; corrected: ModelCost }> = {
  "gpt-5.6-luna": {
    current: withLongContextPricing({
      input: 1,
      output: 6,
      cacheRead: 0.1,
      cacheWrite: 1.25,
    }),
    corrected: withLongContextPricing({
      input: 0.2,
      output: 1.2,
      cacheRead: 0.02,
      cacheWrite: 0.25,
    }),
  },
  "gpt-5.6-terra": {
    current: withLongContextPricing({
      input: 2.5,
      output: 15,
      cacheRead: 0.25,
      cacheWrite: 3.125,
    }),
    corrected: withLongContextPricing({
      input: 2,
      output: 12,
      cacheRead: 0.2,
      cacheWrite: 2.5,
    }),
  },
};

export function applyTauModelOverrides(model: Model<Api>): Model<Api> {
  const costOverride =
    model.provider === "openai" || model.provider === "openai-codex"
      ? GPT_5_6_COST_OVERRIDES[model.id]
      : undefined;
  const cost =
    costOverride && isDeepStrictEqual(model.cost, costOverride.current)
      ? costOverride.corrected
      : undefined;
  const contextWindow =
    model.provider === "openai-codex" &&
    model.contextWindow === 272_000 &&
    GPT_5_6_CODEX_MODEL_IDS.has(model.id)
      ? 372_000
      : undefined;

  if (!cost && contextWindow === undefined) {
    return model;
  }

  return {
    ...model,
    ...(cost ? { cost } : {}),
    ...(contextWindow !== undefined ? { contextWindow } : {}),
  };
}
