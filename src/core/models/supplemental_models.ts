import type { Api, Model } from "@earendil-works/pi-ai";

// GPT-6.2 Astra provisionally uses the GPT-6 Astra metadata from Pi.
export const supplementalModels: Model<Api>[] = [
  {
    id: "gpt-6.2-astra",
    name: "GPT-6.2 Astra",
    api: "openai-codex-responses",
    provider: "openai-codex",
    baseUrl: "https://chatgpt.com/backend-api",
    reasoning: true,
    thinkingLevelMap: {
      off: null,
      minimal: "low",
      low: "low",
      medium: "medium",
      high: "high",
      xhigh: "xhigh",
      max: "max",
    },
    input: ["text", "image"],
    cost: {
      input: 10,
      output: 50,
      cacheRead: 1,
      cacheWrite: 12.5,
      tiers: [
        {
          input: 20,
          output: 75,
          cacheRead: 2,
          cacheWrite: 25,
          inputTokensAbove: 272000,
        },
      ],
    },
    contextWindow: 272000,
    maxTokens: 128000,
    compat: {
      supportsOpenAIGrammarTools: true,
      supportsAdditionalTools: true,
      supportsToolSearch: true,
      supportsMidConvoSystemMessages: true,
    },
    inputLimits: {
      images: {
        resize: {
          maxWidth: 2000,
          maxHeight: 2000,
          maxBytes: 4718592,
          jpegQuality: 80,
        },
      },
    },
    type: "chat",
  },
];
