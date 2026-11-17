import type { Api, Model } from "@earendil-works/pi-ai";

// https://developers.openai.com/api/docs/models/gpt-6.2-astra
// https://developers.openai.com/api/docs/models/gpt-6.2-sol
export const supplementalModels: Model<Api>[] = [
  {
    id: "gpt-6.2-astra",
    name: "GPT-6.2 Astra",
    input: 8,
    output: 40,
    cacheRead: 0.4,
    cacheWrite: 10,
  },
  { id: "gpt-6.2-sol", name: "GPT-6.2 Sol", input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
].flatMap((spec) =>
  ["openai", "openai-codex"].map((provider): Model<Api> => {
    const codex = provider === "openai-codex";
    return {
      id: spec.id,
      name: spec.name,
      api: codex ? "openai-codex-responses" : "openai-responses",
      provider,
      baseUrl: codex ? "https://chatgpt.com/backend-api" : "https://api.openai.com/v1",
      reasoning: true,
      thinkingLevelMap: {
        off: null,
        minimal: codex ? "low" : null,
        low: "low",
        medium: "medium",
        high: "high",
        xhigh: "xhigh",
        max: "max",
      },
      input: ["text", "image"],
      cost: {
        input: spec.input,
        output: spec.output,
        cacheRead: spec.cacheRead,
        cacheWrite: spec.cacheWrite,
        tiers: [
          {
            inputTokensAbove: 272000,
            input: spec.input * 2,
            output: spec.output * 1.5,
            cacheRead: spec.cacheRead * 2,
            cacheWrite: spec.cacheWrite * 2,
          },
        ],
      },
      // Keep Codex's conservative working window until its catalog publishes the limits.
      contextWindow: codex ? 272000 : 1050000,
      maxTokens: 128000,
      compat: {
        supportsOpenAIGrammarTools: true,
        supportsAdditionalTools: true,
        supportsToolSearch: true,
        supportsMidConvoSystemMessages: true,
        ...(!codex
          ? {
              supportsStrictMode: true,
              supportsExplicitPromptCacheMode: true,
              supportsMidConvoEffort: true,
            }
          : {}),
      },
      inputLimits: {
        ...(!codex ? { maxRequestBytes: 536870912 } : {}),
        images: {
          ...(!codex ? { maxPerRequest: 1500 } : {}),
          resize: {
            maxWidth: 2000,
            maxHeight: 2000,
            maxBytes: 4718592,
            jpegQuality: 80,
          },
        },
      },
      type: "chat",
    };
  }),
);
