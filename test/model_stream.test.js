import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AssistantMessageEventStream, calculateCost } from "@earendil-works/pi-ai";
import { describe, expect, test, vi } from "vitest";
import { AuthManager } from "../dist/core/auth/auth_manager.js";
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

  test.each([
    ["openai", "OPENAI_API_KEY", "gpt-5.4"],
    ["anthropic", "ANTHROPIC_API_KEY", "claude-haiku-4-5"],
    ["anthropic", "ANTHROPIC_AUTH_TOKEN", "claude-haiku-4-5"],
  ])(
    "prefers %s provider environment %s over configured keys",
    async (provider, envName, modelId) => {
      const fx = createTempAuthPath();
      try {
        const runtime = new ModelRuntime({
          authStorage: new AuthStorage(fx.authPath),
          getConfig: () => ({ apiKeys: { [provider]: "config-key" } }),
          env: { [envName]: "env-key" },
        });
        const auth = await runtime.getAuth(runtime.resolveModel(provider, modelId));
        if (envName === "ANTHROPIC_AUTH_TOKEN")
          expect(auth.auth.headers.Authorization).toBe("Bearer env-key");
        else expect(auth.auth.apiKey).toBe("env-key");
      } finally {
        fx.cleanup();
      }
    },
  );

  test("formats missing codex credentials before provider requests", async () => {
    const fx = createTempAuthPath();
    try {
      const runtime = new ModelRuntime({
        authStorage: new AuthStorage(fx.authPath),
        getConfig: () => ({}),
        authPath: fx.authPath,
        env: {},
      });
      const model = runtime.resolveModel("openai-codex", "gpt-5.6-sol");
      expect(model).toBeDefined();

      const stream = runtime.streamModel(
        model,
        { systemPrompt: "test", messages: [] },
        { sessionId: "session-1" },
      );
      const final = await stream.result();

      expect(final.stopReason).toBe("error");
      expect(final.errorMessage).toContain("tau auth use codex");
    } finally {
      fx.cleanup();
    }
  });
});

function deferred() {
  let resolve;
  const promise = new Promise((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function createCodexRuntime(authPath, expires = Number.MAX_SAFE_INTEGER) {
  writeFileSync(
    authPath,
    JSON.stringify({
      providers: {
        "openai-codex": {
          activeAccountId: "a",
          accounts: ["a", "b"].map((id) => ({
            type: "oauth",
            accountId: id,
            providerAccountId: id,
            access: `access-${id}`,
            refresh: `refresh-${id}`,
            expires,
          })),
        },
      },
    }),
  );
  const storage = new AuthStorage(authPath);
  const runtime = new ModelRuntime({
    authStorage: storage,
    getConfig: () => ({}),
    authPath,
    env: {},
  });
  const model = runtime.resolveModel("openai-codex", "gpt-6.1-sol");
  const provider = runtime.models.getProvider("openai-codex");
  const refresh = vi.fn(async (credential) => ({
    ...credential,
    expires: Number.MAX_SAFE_INTEGER,
  }));
  const toAuth = vi.fn(async (credential) => ({ apiKey: credential.access }));
  const stream = vi.fn((requestModel) => {
    const result = new AssistantMessageEventStream();
    const message = {
      role: "assistant",
      content: [],
      api: requestModel.api,
      provider: requestModel.provider,
      model: requestModel.id,
      usage: {
        input: 0,
        output: 0,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 0,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
      },
      stopReason: "stop",
      timestamp: 0,
    };
    result.push({ type: "done", reason: "stop", message });
    result.end(message);
    return result;
  });
  runtime.models.setProvider({
    ...provider,
    auth: { oauth: { ...provider.auth.oauth, refresh, toAuth } },
    stream,
  });
  return { runtime, model, refresh, toAuth, stream, manager: new AuthManager(storage) };
}

const requestContext = { systemPrompt: "test instructions", messages: [] };

describe("request-scoped Codex auth", () => {
  test.each([0, 60_000])(
    "keeps the captured account through refresh with %s ms remaining",
    async (remaining) => {
      const fx = createTempAuthPath();
      try {
        const { runtime, model, refresh, toAuth, stream, manager } = createCodexRuntime(
          fx.authPath,
          Date.now() + remaining,
        );
        const started = deferred();
        const release = deferred();
        refresh.mockImplementation(async (credential) => {
          if (credential.accountId === "b") throw new Error("other account refresh failed");
          started.resolve();
          await release.promise;
          return { ...credential, access: "refreshed-a", expires: Number.MAX_SAFE_INTEGER };
        });
        const result = runtime.streamModel(model, requestContext, { sessionId: "first" }).result();
        await started.promise;
        manager.useAccount("openai-codex", "b");
        release.resolve();
        expect((await result).stopReason).toBe("stop");
        expect(refresh).toHaveBeenCalledTimes(1);
        expect(toAuth).toHaveBeenCalledTimes(1);
        expect(stream.mock.calls[0][2].apiKey).toBe("refreshed-a");
        expect(
          (await runtime.streamModel(model, requestContext, { sessionId: "second" }).result())
            .stopReason,
        ).toBe("error");
        expect(stream).toHaveBeenCalledTimes(1);
        expect(refresh.mock.calls[1][0].accountId).toBe("b");
        expect(
          JSON.parse(readFileSync(fx.authPath, "utf8")).providers["openai-codex"].activeAccountId,
        ).toBe("b");
      } finally {
        fx.cleanup();
      }
    },
  );

  test("authenticates once and preserves resolved request auth after an account switch", async () => {
    const fx = createTempAuthPath();
    try {
      const { runtime, model, refresh, toAuth, stream, manager } = createCodexRuntime(fx.authPath);
      const started = deferred();
      const release = deferred();
      toAuth.mockImplementation(async (credential) => {
        if (credential.accountId === "b") throw new Error("other account auth failed");
        started.resolve();
        await release.promise;
        return {
          apiKey: credential.access,
          baseUrl: "https://request.example",
          headers: { "request-account": credential.accountId, Originator: "provider" },
        };
      });
      const signal = new AbortController().signal;
      const first = runtime
        .streamModel(model, requestContext, {
          sessionId: "first",
          signal,
          headers: { originator: "tau" },
        })
        .result();
      await started.promise;
      manager.useAccount("openai-codex", "b");
      release.resolve();
      expect((await first).stopReason).toBe("stop");
      expect(toAuth).toHaveBeenCalledTimes(1);
      expect(refresh).not.toHaveBeenCalled();
      expect(stream.mock.calls[0][0].baseUrl).toBe("https://request.example");
      expect(stream.mock.calls[0][1].messages[0]).toMatchObject({
        role: "system",
        content: "test instructions",
      });
      expect(stream.mock.calls[0][2]).toMatchObject({
        apiKey: "access-a",
        signal,
        headers: { "request-account": "a", originator: "tau" },
      });
      expect(stream.mock.calls[0][2].headers).toEqual({
        "request-account": "a",
        originator: "tau",
      });
      expect(
        (await runtime.streamModel(model, requestContext, { sessionId: "second" }).result())
          .stopReason,
      ).toBe("error");
      expect(stream).toHaveBeenCalledTimes(1);
    } finally {
      fx.cleanup();
    }
  });

  test("cancels a blocked OAuth refresh without persisting or starting provider work", async () => {
    const fx = createTempAuthPath();
    try {
      const { runtime, model, refresh, stream } = createCodexRuntime(fx.authPath, 0);
      const started = deferred();
      const release = deferred();
      let refreshSignal;
      refresh.mockImplementation(async (credential, signal) => {
        refreshSignal = signal;
        started.resolve();
        await release.promise;
        return { ...credential, refresh: "must-not-persist", expires: Number.MAX_SAFE_INTEGER };
      });
      const controller = new AbortController();
      const result = runtime
        .streamModel(model, requestContext, { sessionId: "cancelled", signal: controller.signal })
        .result();
      await started.promise;
      controller.abort();
      expect(refreshSignal.aborted).toBe(true);
      expect((await result).stopReason).toBe("error");
      release.resolve();
      await vi.waitFor(() =>
        expect(
          JSON.parse(readFileSync(fx.authPath, "utf8")).providers["openai-codex"].accounts[0]
            .refresh,
        ).toBe("refresh-a"),
      );
      expect(stream).not.toHaveBeenCalled();
    } finally {
      fx.cleanup();
    }
  });

  test("does not restore an account logged out during refresh", async () => {
    const fx = createTempAuthPath();
    try {
      const { runtime, model, refresh, stream, manager } = createCodexRuntime(fx.authPath, 0);
      const started = deferred();
      const release = deferred();
      refresh.mockImplementation(async (credential) => {
        started.resolve();
        await release.promise;
        return { ...credential, expires: Number.MAX_SAFE_INTEGER };
      });
      const result = runtime.streamModel(model, requestContext, { sessionId: "logout" }).result();
      await started.promise;
      manager.removeAccount("openai-codex", "a");
      release.resolve();
      expect((await result).stopReason).toBe("error");
      expect(stream).not.toHaveBeenCalled();
      const data = JSON.parse(readFileSync(fx.authPath, "utf8")).providers["openai-codex"];
      expect(data.activeAccountId).toBeNull();
      expect(data.accounts.map((account) => account.accountId)).toEqual(["b"]);
    } finally {
      fx.cleanup();
    }
  });

  test("deduplicates concurrent refreshes across runtimes", async () => {
    const fx = createTempAuthPath();
    try {
      const { runtime, model, refresh, stream } = createCodexRuntime(fx.authPath, 0);
      const other = new ModelRuntime({
        authStorage: new AuthStorage(fx.authPath),
        getConfig: () => ({}),
        env: {},
      });
      other.models.setProvider(runtime.models.getProvider("openai-codex"));
      const started = deferred();
      const release = deferred();
      refresh.mockImplementation(async (credential) => {
        started.resolve();
        await release.promise;
        return { ...credential, access: "new-token", expires: Number.MAX_SAFE_INTEGER };
      });
      const first = runtime.streamModel(model, requestContext, { sessionId: "one" }).result();
      await started.promise;
      const second = other.streamModel(model, requestContext, { sessionId: "two" }).result();
      release.resolve();
      expect((await first).stopReason).toBe("stop");
      expect((await second).stopReason).toBe("stop");
      expect(refresh).toHaveBeenCalledTimes(1);
      expect(stream.mock.calls.map((call) => call[2].apiKey)).toEqual(["new-token", "new-token"]);
    } finally {
      fx.cleanup();
    }
  });
  test("keeps Pi's OAuth refresh timeout and never falls back to another stored account", async () => {
    const fx = createTempAuthPath();
    const timeoutController = new AbortController();
    const timeout = vi.spyOn(AbortSignal, "timeout").mockReturnValue(timeoutController.signal);
    try {
      const { runtime, model, refresh, stream } = createCodexRuntime(fx.authPath, 0);
      const started = deferred();
      refresh.mockImplementation(
        (_credential, signal) =>
          new Promise((_resolve, reject) => {
            started.resolve();
            signal.addEventListener("abort", () => reject(signal.reason), { once: true });
          }),
      );
      const result = runtime.streamModel(model, requestContext, { sessionId: "timeout" }).result();
      await started.promise;
      expect(timeout).toHaveBeenCalledWith(15_000);
      timeoutController.abort(new Error("refresh timed out"));
      expect((await result).stopReason).toBe("error");
      expect(refresh).toHaveBeenCalledTimes(1);
      expect(stream).not.toHaveBeenCalled();
      expect(
        JSON.parse(readFileSync(fx.authPath, "utf8")).providers["openai-codex"].activeAccountId,
      ).toBe("a");
    } finally {
      timeout.mockRestore();
      fx.cleanup();
    }
  });

  test("cancels a request waiting for another account refresh", async () => {
    const fx = createTempAuthPath();
    try {
      const { runtime, model, refresh, stream } = createCodexRuntime(fx.authPath, 0);
      const other = new ModelRuntime({
        authStorage: new AuthStorage(fx.authPath),
        getConfig: () => ({}),
        env: {},
      });
      other.models.setProvider(runtime.models.getProvider("openai-codex"));
      const started = deferred();
      const release = deferred();
      refresh.mockImplementation(async (credential) => {
        started.resolve();
        await release.promise;
        return { ...credential, expires: Number.MAX_SAFE_INTEGER };
      });
      const first = runtime.streamModel(model, requestContext, { sessionId: "first" }).result();
      await started.promise;
      const controller = new AbortController();
      const second = other
        .streamModel(model, requestContext, { sessionId: "waiting", signal: controller.signal })
        .result();
      controller.abort();
      expect((await second).stopReason).toBe("error");
      expect(refresh).toHaveBeenCalledTimes(1);
      release.resolve();
      expect((await first).stopReason).toBe("stop");
      expect(stream).toHaveBeenCalledTimes(1);
      expect(
        (await other.streamModel(model, requestContext, { sessionId: "later" }).result())
          .stopReason,
      ).toBe("stop");
      expect(refresh).toHaveBeenCalledTimes(1);
    } finally {
      fx.cleanup();
    }
  });
});
