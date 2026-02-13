import { describe, expect, it } from "vitest";
import { ChatRuntime, createLocalToolExecutionBackend, ToolCatalog } from "../dist/core/index.js";
import { personas } from "../dist/core/personas.js";

function createPersona(overrides = {}) {
  return {
    id: "test-persona",
    label: "test persona",
    description: "test",
    model: personas[0].model,
    systemPrompt: "main system prompt",
    settings: {},
    source: "project",
    subagents: {
      default: {},
      researcher: {
        systemPrompt: "research subagent prompt",
        description: "deep research helper",
        riskLevel: "read-write",
        launchModels: ["openai/gpt-5.2:high"],
      },
    },
    ...overrides,
  };
}

function createStubSession(eventGenerator) {
  const setPersonaCalls = [];
  const setRiskLevelCalls = [];
  const setConfigCalls = [];

  return {
    session: {
      async *events(signal) {
        if (!eventGenerator) {
          return;
        }
        yield* eventGenerator(signal);
      },
      setPersona(persona, systemPrompt, subagentPrompts) {
        setPersonaCalls.push({ persona, systemPrompt, subagentPrompts });
      },
      setRiskLevel(level) {
        setRiskLevelCalls.push(level);
      },
      setConfig(config) {
        setConfigCalls.push(config);
      },
    },
    calls: {
      setPersonaCalls,
      setRiskLevelCalls,
      setConfigCalls,
    },
  };
}

function createEnvironment(now = Date.parse("2026-01-01T00:00:00.000Z")) {
  return {
    now: () => now,
    platform: () => "darwin",
    nodeVersion: () => "v24.0.0",
  };
}

describe("ChatRuntime", () => {
  it("runs and interrupts turns through ConversationTurnRuntime", async () => {
    const { session } = createStubSession(async function* (signal) {
      yield { type: "notice", severity: "info", text: "tick" };
      while (!signal.aborted) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    });

    const runtime = new ChatRuntime({
      session,
      persona: createPersona(),
      riskLevel: "read-only",
      promptContext: {
        cwd: "/repo",
        sandboxEnabled: false,
      },
      environment: createEnvironment(),
    });

    const received = [];
    const run = runtime.runTurn((event) => {
      if (event.type === "notice") {
        received.push(event.text);
      }
      runtime.interruptTurn();
    });

    expect(runtime.isTurnRunning).toBe(true);
    const result = await run;

    expect(received).toEqual(["tick"]);
    expect(result).toEqual(expect.objectContaining({ aborted: true }));
    expect(runtime.isTurnRunning).toBe(false);
    expect(runtime.interruptTurn()).toBe(false);
  });

  it("creates a runtime with a concrete tool registry", () => {
    const backend = createLocalToolExecutionBackend();
    const toolRegistry = ToolCatalog.createRegistry(backend);

    const runtime = ChatRuntime.create({
      persona: createPersona(),
      riskLevel: "read-only",
      toolRegistry,
      promptContext: {
        cwd: "/repo",
        sandboxEnabled: false,
      },
      environment: createEnvironment(),
      config: {
        defaultRisk: "read-only",
      },
    });

    runtime.session.addUserText("hello from create");

    expect(runtime.session.history).toHaveLength(1);
    expect(runtime.session.history[0]?.role).toBe("user");
    expect(runtime.promptComposition.baseSystemPrompt).toContain("main system prompt");
    expect(runtime.promptComposition.baseSystemPrompt).toContain("<cwd>/repo</cwd>");
    expect(runtime.promptComposition.subagentPrompts.default).toContain(
      '<risk-level level="read-only">',
    );
  });

  it("rebuilds full system prompts with main and subagent content", () => {
    const { session, calls } = createStubSession();
    const persona = createPersona();

    const runtime = new ChatRuntime({
      session,
      persona,
      riskLevel: "read-only",
      promptContext: {
        cwd: "/repo",
        skillsBlock: "### Skills\n\n- skill-a",
        projectContextBlock: '### Project context\n\n<file path="/repo/AGENTS.md">ctx</file>',
        sandboxEnabled: true,
        sandboxEnvironmentInfo: "ubuntu container",
      },
      environment: createEnvironment(),
    });

    runtime.rebuildSystemPrompts({ skillsBlock: "### Skills\n\n- skill-b" });

    const composition = runtime.promptComposition;
    expect(composition.baseSystemPrompt).toContain("main system prompt");
    expect(composition.baseSystemPrompt).toContain("### Skills");
    expect(composition.baseSystemPrompt).toContain("skill-b");
    expect(composition.baseSystemPrompt).toContain("### Project context");
    expect(composition.baseSystemPrompt).toContain("### Available sub-agents");
    expect(composition.baseSystemPrompt).toContain("`researcher`");
    expect(composition.baseSystemPrompt).toContain("launch models");
    expect(composition.baseSystemPrompt).toContain("openai/gpt-5.2:high");
    expect(composition.baseSystemPrompt).toContain("<sandbox-info>");
    expect(composition.baseSystemPrompt).toContain("<datetime>2026-01-01T00:00:00.000Z</datetime>");

    expect(composition.subagentPrompts.default).toContain('<risk-level level="read-only">');
    expect(composition.subagentPrompts.researcher).toContain("research subagent prompt");
    expect(composition.subagentPrompts.researcher).toContain('<risk-level level="read-write">');
    expect(composition.subagentPrompts.researcher).toContain("<sandbox-info>");

    const lastSetPersona = calls.setPersonaCalls.at(-1);
    expect(lastSetPersona).toBeDefined();
    expect(lastSetPersona.persona).toBe(persona);
    expect(lastSetPersona.systemPrompt).toBe(composition.baseSystemPrompt);
    expect(lastSetPersona.subagentPrompts).toEqual(composition.subagentPrompts);
  });

  it("rebuilds only subagent prompts while preserving the main system prompt", () => {
    const { session, calls } = createStubSession();

    const runtime = new ChatRuntime({
      session,
      persona: createPersona(),
      riskLevel: "read-only",
      promptContext: {
        cwd: "/repo/start",
        sandboxEnabled: false,
        skillsBlock: "### Skills\n\n- initial",
      },
      environment: createEnvironment(),
    });

    const mainBefore = runtime.promptComposition.baseSystemPrompt;
    const subagentBefore = runtime.promptComposition.subagentPrompts.researcher;

    runtime.updatePromptContext({ cwd: "/repo/next" });
    runtime.rebuildSubagentPrompts();

    const composition = runtime.promptComposition;
    expect(composition.baseSystemPrompt).toBe(mainBefore);
    expect(composition.baseSystemPrompt).toContain("<cwd>/repo/start</cwd>");
    expect(composition.subagentPrompts.researcher).toContain("<cwd>/repo/next</cwd>");
    expect(composition.subagentPrompts.researcher).not.toBe(subagentBefore);

    const lastSetPersona = calls.setPersonaCalls.at(-1);
    expect(lastSetPersona).toBeDefined();
    expect(lastSetPersona.systemPrompt).toBe(mainBefore);
    expect(lastSetPersona.subagentPrompts).toEqual(composition.subagentPrompts);
  });
});
