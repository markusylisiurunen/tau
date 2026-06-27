import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

  test("clamps unsupported openai xhigh reasoning in response options", () => {
    expect(
      resolveOpenAIResponsesOptions(
        {
          api: "openai-codex-responses",
          provider: "openai-codex",
          id: "gpt-5-mini",
        },
        {
          reasoning: "xhigh",
          serviceTier: "priority",
        },
      ),
    ).toEqual({
      transport: "websocket-cached",
      reasoningEffort: "high",
      serviceTier: "priority",
    });
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
