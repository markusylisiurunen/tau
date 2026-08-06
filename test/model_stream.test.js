import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { calculateCost } from "@earendil-works/pi-ai";
import { describe, expect, test } from "vitest";
import { AuthStorage } from "../dist/core/auth/auth_storage.js";
import {
  ModelRuntime,
  resolveOpenAIResponsesOptions,
  resolveSimpleStreamOptions,
} from "../dist/core/utils/model_stream.js";

function createTempAuthPath() {
  const dir = mkdtempSync(join(tmpdir(), "tau-model-runtime-"));
  return {
    authPath: join(dir, "auth.json"),
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
  };
}

describe("model stream option resolution", () => {
  test("drops disabled reasoning for simple stream options", () => {
    expect(
      resolveSimpleStreamOptions({
        reasoning: "none",
        maxTokens: 123,
        interleavedThinking: true,
      }),
    ).toEqual({
      maxTokens: 123,
      interleavedThinking: true,
    });
  });

  test("builds openai responses options with disabled reasoning and service tier", () => {
    expect(
      resolveOpenAIResponsesOptions(
        {
          api: "openai-responses",
          provider: "openai",
          id: "gpt-5.4",
        },
        {
          reasoning: "none",
          serviceTier: "priority",
          maxTokens: 123,
        },
      ),
    ).toEqual({
      reasoningEffort: "none",
      serviceTier: "priority",
      maxTokens: 123,
    });
  });

  test("builds openai codex options with disabled reasoning and service tier", () => {
    expect(
      resolveOpenAIResponsesOptions(
        {
          api: "openai-codex-responses",
          provider: "openai-codex",
          id: "gpt-5.4",
        },
        {
          reasoning: "none",
          serviceTier: "flex",
          maxTokens: 456,
        },
      ),
    ).toEqual({
      transport: "websocket-cached",
      reasoningEffort: "none",
      serviceTier: "flex",
      maxTokens: 456,
    });
  });

  test("preserves explicit openai codex transport", () => {
    expect(
      resolveOpenAIResponsesOptions(
        {
          api: "openai-codex-responses",
          provider: "openai-codex",
          id: "gpt-5.4",
        },
        {
          transport: "sse",
        },
      ),
    ).toEqual({
      transport: "sse",
    });
  });

  test.each(["xhigh", "max"])(
    "clamps unsupported openai %s reasoning in response options",
    (reasoning) => {
      expect(
        resolveOpenAIResponsesOptions(
          {
            api: "openai-codex-responses",
            provider: "openai-codex",
            id: "gpt-5-mini",
          },
          {
            reasoning,
            serviceTier: "priority",
          },
        ),
      ).toEqual({
        transport: "websocket-cached",
        reasoningEffort: "high",
        serviceTier: "priority",
      });
    },
  );

  test("resolves GPT-5.6 models through the pi-ai models runtime", () => {
    const runtime = new ModelRuntime();

    const openaiModel = runtime.resolveModel("openai", "gpt-5.6-luna");
    expect(openaiModel).toBeDefined();
    expect(openaiModel.api).toBe("openai-responses");
    expect(openaiModel.cost).toEqual({
      input: 0.2,
      output: 1.2,
      cacheRead: 0.02,
      cacheWrite: 0.25,
      tiers: [
        {
          inputTokensAbove: 272000,
          input: 0.4,
          output: 1.8,
          cacheRead: 0.04,
          cacheWrite: 0.5,
        },
      ],
    });
    expect(openaiModel.contextWindow).toBe(272000);

    const codexModel = runtime.resolveModel("openai-codex", "gpt-5.6-sol");
    expect(codexModel).toBeDefined();
    expect(codexModel.api).toBe("openai-codex-responses");
    expect(codexModel.contextWindow).toBe(272000);
  });

  test("calculates request cost with the highest matching input tier", () => {
    const runtime = new ModelRuntime();
    const model = runtime.resolveModel("openai", "gpt-5.6-luna");
    expect(model).toBeDefined();

    const cost = calculateCost(model, {
      input: 273000,
      output: 1000,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 274000,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    });

    expect(cost.input).toBeCloseTo(0.1092);
    expect(cost.output).toBeCloseTo(0.0018);
    expect(cost.cacheRead).toBe(0);
    expect(cost.cacheWrite).toBe(0);
    expect(cost.total).toBeCloseTo(0.111);
  });

  test("resolves configured api keys through the pi-ai models runtime", async () => {
    const fx = createTempAuthPath();
    try {
      const runtime = new ModelRuntime({
        authStorage: new AuthStorage(fx.authPath),
        getConfig: () => ({ apiKeys: { openai: "config-key" } }),
        env: {},
      });
      const model = runtime.resolveModel("openai", "gpt-5.4");
      expect(model).toBeDefined();

      const auth = await runtime.getAuth(model);
      expect(auth?.auth.apiKey).toBe("config-key");
    } finally {
      fx.cleanup();
    }
  });

  test("resolves environment api keys through injected runtime env", async () => {
    const runtime = new ModelRuntime({
      env: { OPENAI_API_KEY: "env-key" },
    });
    const model = runtime.resolveModel("openai", "gpt-5.4");
    expect(model).toBeDefined();

    const auth = await runtime.getAuth(model);
    expect(auth?.auth.apiKey).toBe("env-key");
  });

  test("formats missing codex credentials before provider requests", async () => {
    const fx = createTempAuthPath();
    try {
      const runtime = new ModelRuntime({
        authStorage: new AuthStorage(fx.authPath),
        getConfig: () => ({}),
        authPath: fx.authPath,
        env: {},
      });
      const model = runtime.resolveModel("openai-codex", "gpt-5.4");
      expect(model).toBeDefined();

      const stream = runtime.streamModel(
        model,
        { systemPrompt: "test", messages: [] },
        { sessionId: "session-1" },
      );
      const final = await stream.result();

      expect(final.stopReason).toBe("error");
      expect(final.errorMessage).toBe(
        `OpenAI Codex credentials are missing or expired. run "tau auth login codex" to authenticate and store tokens in ${fx.authPath}.`,
      );
    } finally {
      fx.cleanup();
    }
  });
});
