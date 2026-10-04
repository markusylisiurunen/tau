import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fauxAssistantMessage } from "@earendil-works/pi-ai";
import { describe, expect, it, vi } from "vitest";
import { AgentRuntime, ChatRuntime, createLocalToolExecutionBackend } from "../dist/core/index.js";
import { resolveModel } from "../dist/core/models/catalog.js";
import { personas } from "../dist/core/personas.js";
import { createDefaultCoreDeps } from "../dist/core/runtime/deps.js";
import { ToolCatalog } from "../dist/core/tools/catalog.js";
import { ModelRuntime } from "../dist/core/utils/model_stream.js";

function createPersona(overrides = {}) {
  return {
    id: "test-persona",
    label: "test persona",
    description: "test",
    model: personas[0].model,
    systemPrompt: "main system prompt",
    settings: {},
    source: "project",
    tools: personas[0].tools,
    subagentLaunchModels: ["openai/gpt-5.4:high"],
    ...overrides,
  };
}

function createPromptContext(overrides = {}) {
  return {
    cwd: "/repo",
    home: "/home/user",
    repoRoot: "/repo",
    repository: "github.com/example/repo",
    platform: "linux",
    includeAgentContext: true,
    ...overrides,
  };
}

function createRuntime(overrides = {}) {
  return ChatRuntime.create({
    sessionId: "session-1",
    createdAt: Date.parse("2026-01-01T00:00:00.000Z"),
    persona: createPersona(),
    backend: createLocalToolExecutionBackend(),
    modelResolver: resolveModel,
    promptContext: createPromptContext(),
    eventSink: async () => {},
    subagentEventSink: async () => {},
    history: {
      search: async () => ({ sessions: [] }),
      read: async () => {
        throw new Error("missing history session");
      },
    },
    config: {},
    ...overrides,
  });
}

describe("ChatRuntime", () => {
  it("keeps startup credentials independent of reloaded config", () => {
    const apiKeys = { openai: "host-key", exa: "host-tool-key" };
    const runtime = createRuntime({ config: { apiKeys } });
    apiKeys.openai = "mutated-key";
    runtime.setRuntimeConfig(
      { apiKeys: { openai: "target-key" }, defaultPersona: "next" },
      resolveModel,
    );
    runtime.setPersona(createPersona());
    expect(runtime.config).toMatchObject({
      apiKeys: { openai: "host-key", exa: "host-tool-key" },
      defaultPersona: "next",
    });
    runtime.config.apiKeys.openai = "consumer-mutation";
    expect(runtime.config.apiKeys.openai).toBe("host-key");

    const withoutCredentials = createRuntime();
    withoutCredentials.setRuntimeConfig({ apiKeys: { openai: "target-key" } }, resolveModel);
    expect(withoutCredentials.config.apiKeys).toBeUndefined();
  });

  it.each([{}, { OPENAI_API_KEY: "environment-key" }])(
    "uses host credentials for model and tool consumers after reload with env %j",
    async (env) => {
      const home = mkdtempSync(join(tmpdir(), "tau-runtime-credentials-"));
      const deps = createDefaultCoreDeps();
      deps.env = { ...deps.env, home: () => home, env: () => env };
      const registry = vi.spyOn(ToolCatalog, "createSessionRegistry");
      let auth;
      const stream = vi
        .spyOn(ModelRuntime.prototype, "streamModel")
        .mockImplementation(function (model) {
          auth = this.getAuth(model);
        });
      try {
        const persona = createPersona({ model: resolveModel("openai", "gpt-5.4") });
        const runtime = createRuntime({
          persona,
          deps,
          config: { apiKeys: { openai: "host-key", exa: "host-tool-key" } },
        });
        runtime.setRuntimeConfig(
          { apiKeys: { openai: "target-key", exa: "target-tool-key" } },
          resolveModel,
        );
        runtime.setPersona(persona);
        runtime.agent.spec.model.stream({ messages: [] }, {});
        expect((await auth).auth.apiKey).toBe(env.OPENAI_API_KEY ?? "host-key");
        expect(registry.mock.calls.at(-1)[0].config.apiKeys.exa).toBe("host-tool-key");
      } finally {
        stream.mockRestore();
        registry.mockRestore();
        rmSync(home, { recursive: true, force: true });
      }
    },
  );

  it("binds main runtime tools and prompts", () => {
    const runtime = createRuntime();

    expect(runtime.agent).toBeInstanceOf(AgentRuntime);
    expect(runtime.agent.spec.tools.schemas.length).toBeGreaterThan(0);
    expect(runtime.agent.spec.systemPrompt).toBe(runtime.promptComposition.baseSystemPrompt);
    expect(runtime.agent.spec.systemPrompt).toContain("- Session ID: `session-1`");
    expect(runtime.agent.spec.systemPrompt).toContain("- Repository: `github.com/example/repo`");
  });

  it("requires both persona selection and config to expose Nook", () => {
    const configuredWithoutPersona = createRuntime({
      persona: createPersona({ tools: ["bash"] }),
      config: { nook: { domain: "nook.example.com" } },
    });
    const personaWithoutConfig = createRuntime({
      persona: createPersona({ tools: ["bash", "nook"] }),
    });
    const enabled = createRuntime({
      persona: createPersona({ tools: ["bash", "nook"] }),
      config: { nook: { domain: "nook.example.com" } },
    });

    expect(configuredWithoutPersona.agent.spec.tools.get("code").schema.description).not.toContain(
      "tau.nook",
    );
    expect(personaWithoutConfig.agent.spec.tools.get("code").schema.description).not.toContain(
      "tau.nook",
    );
    expect(enabled.agent.spec.tools.get("code").schema.description).toContain("tau.nook");
    expect(configuredWithoutPersona.agent.spec.tools.schemas.map((tool) => tool.name)).toEqual([
      "bash",
      "code",
      "list_bash_jobs",
      "read_bash_job",
      "stop_bash_job",
      "wait_for_bash_jobs",
      "tau_docs",
    ]);
    expect(personaWithoutConfig.agent.spec.tools.schemas.map((tool) => tool.name)).toEqual([
      "bash",
      "code",
      "list_bash_jobs",
      "read_bash_job",
      "stop_bash_job",
      "wait_for_bash_jobs",
      "tau_docs",
    ]);
    expect(enabled.agent.spec.tools.schemas.map((tool) => tool.name)).toEqual([
      "bash",
      "code",
      "list_bash_jobs",
      "read_bash_job",
      "stop_bash_job",
      "wait_for_bash_jobs",
      "tau_docs",
    ]);
  });

  it("samples with the current persona model settings without changing agent state", async () => {
    const runtime = createRuntime({
      persona: createPersona({ settings: { reasoning: "low" } }),
    });
    const sampledMessage = fauxAssistantMessage("sampled");
    const stream = vi.fn(() => ({
      async *[Symbol.asyncIterator]() {},
      async result() {
        return sampledMessage;
      },
    }));
    runtime.agent.spec.model.stream = stream;
    const stateBeforeSample = runtime.snapshot();

    await expect(
      runtime.sample({
        context: { systemPrompt: "Sample in isolation.", messages: [] },
        options: {},
      }),
    ).resolves.toEqual(sampledMessage);

    expect(stream).toHaveBeenCalledWith(
      { systemPrompt: "Sample in isolation.", messages: [] },
      expect.objectContaining({ reasoning: "low" }),
    );

    runtime.setReasoning("high");
    const updatedStream = vi.fn(() => ({
      async *[Symbol.asyncIterator]() {},
      async result() {
        return sampledMessage;
      },
    }));
    runtime.agent.spec.model.stream = updatedStream;
    await runtime.sample({
      context: { systemPrompt: "Sample again.", messages: [] },
      options: {},
    });

    expect(updatedStream).toHaveBeenCalledWith(
      { systemPrompt: "Sample again.", messages: [] },
      expect.objectContaining({ reasoning: "high" }),
    );
    expect(runtime.snapshot()).toEqual(stateBeforeSample);
  });

  it("rebuilds the main and subagent prompts and updates the next runtime spec", () => {
    const runtime = createRuntime({
      promptContext: createPromptContext({
        skillsBlock: "### Skills\n\n- skill-a",
        projectContextBlock: '### Project context\n\n<file path="/repo/AGENTS.md">ctx</file>',
      }),
    });

    runtime.updatePromptContext({ skillsBlock: "### Skills\n\n- skill-b" });

    const composition = runtime.promptComposition;
    expect(composition.baseSystemPrompt).toContain("skill-b");
    expect(composition.subagentSystemPrompt).toContain("main system prompt");
    expect(runtime.agent.spec.systemPrompt).toBe(composition.baseSystemPrompt);

    runtime.updatePromptContext({ skillsBlock: undefined });
    runtime.setPersona(createPersona());
    expect(runtime.promptComposition.baseSystemPrompt).not.toContain("skill-b");
    expect(runtime.promptComposition.subagentSystemPrompt).not.toContain("skill-b");
    expect(runtime.agent.spec.systemPrompt).toBe(runtime.promptComposition.baseSystemPrompt);
  });
});
