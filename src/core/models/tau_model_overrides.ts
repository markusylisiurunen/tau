import type { Api, Model } from "@earendil-works/pi-ai";

const GPT_5_6_CODEX_MODEL_IDS = new Set(["gpt-5.6-sol", "gpt-5.6-terra", "gpt-5.6-luna"]);
const GPT_5_6_PRICING_PROVIDER_IDS = new Set(["openai", "openai-codex"]);
const OPENAI_LONG_CONTEXT_INPUT_THRESHOLD = 272_000;

type ModelCost = Model<Api>["cost"];

type PricingOverride = {
  stale: ModelCost;
  current: ModelCost;
};

function roundCost(value: number): number {
  return Number(value.toFixed(6));
}

function withLongContextPricing(cost: Omit<ModelCost, "tiers">): ModelCost {
  return {
    ...cost,
    tiers: [
      {
        inputTokensAbove: OPENAI_LONG_CONTEXT_INPUT_THRESHOLD,
        input: roundCost(cost.input * 2),
        output: roundCost(cost.output * 1.5),
        cacheRead: roundCost(cost.cacheRead * 2),
        cacheWrite: roundCost(cost.cacheWrite * 2),
      },
    ],
  };
}

const GPT_5_6_PRICING_OVERRIDES: Record<string, PricingOverride> = {
  "gpt-5.6-luna": {
    stale: withLongContextPricing({
      input: 1,
      output: 6,
      cacheRead: 0.1,
      cacheWrite: 1.25,
    }),
    current: withLongContextPricing({
      input: 0.2,
      output: 1.2,
      cacheRead: 0.02,
      cacheWrite: 0.25,
    }),
  },
  "gpt-5.6-terra": {
    stale: withLongContextPricing({
      input: 2.5,
      output: 15,
      cacheRead: 0.25,
      cacheWrite: 3.125,
    }),
    current: withLongContextPricing({
      input: 2,
      output: 12,
      cacheRead: 0.2,
      cacheWrite: 2.5,
    }),
  },
};

function costsMatch(actual: ModelCost, expected: ModelCost): boolean {
  return (
    actual.input === expected.input &&
    actual.output === expected.output &&
    actual.cacheRead === expected.cacheRead &&
    actual.cacheWrite === expected.cacheWrite &&
    (actual.tiers?.length ?? 0) === (expected.tiers?.length ?? 0) &&
    (actual.tiers?.every((tier, index) => {
      const expectedTier = expected.tiers?.[index];
      return (
        expectedTier !== undefined &&
        tier.inputTokensAbove === expectedTier.inputTokensAbove &&
        tier.input === expectedTier.input &&
        tier.output === expectedTier.output &&
        tier.cacheRead === expectedTier.cacheRead &&
        tier.cacheWrite === expectedTier.cacheWrite
      );
    }) ??
      true)
  );
}

export function applyTauModelOverrides(model: Model<Api>): Model<Api> {
  let result = model;

  const pricingOverride = GPT_5_6_PRICING_OVERRIDES[model.id];
  if (
    pricingOverride &&
    GPT_5_6_PRICING_PROVIDER_IDS.has(model.provider) &&
    costsMatch(model.cost, pricingOverride.stale)
  ) {
    result = {
      ...result,
      cost: pricingOverride.current,
    };
  }

  if (
    model.provider === "openai-codex" &&
    model.contextWindow === OPENAI_LONG_CONTEXT_INPUT_THRESHOLD &&
    GPT_5_6_CODEX_MODEL_IDS.has(model.id)
  ) {
    result = { ...result, contextWindow: 372_000 };
  }

  return result;
}
