import { describe, expect, it } from "vitest";
import { ChatRuntime, createLocalToolExecutionBackend, ToolCatalog } from "../dist/core/index.js";
import { resolveModel } from "../dist/core/models/catalog.js";
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
        launchModels: ["openai/gpt-5.4:high"],
      },
    },
    ...overrides,
  };
}

function createStubSession(eventGenerator) {
  const setPersonaCalls = [];
  const setConfigCalls = [];
  const setPromptContextCalls = [];

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
      setConfig(config) {
        setConfigCalls.push(config);
      },
      setPromptContext(context) {
        setPromptContextCalls.push(context);
      },
    },
    calls: {
      setPersonaCalls,
      setConfigCalls,
      setPromptContextCalls,
    },
  };
}

function createEnvironment(now = Date.parse("2026-01-01T00:00:00.000Z")) {
  return { now: () => now };
}

function createPromptContext(overrides = {}) {
  return {
    cwd: "/repo",
    home: "/home/user",
    platform: "linux",
    nodeVersion: "v24.0.0",
    includeAgentContext: true,
    ...overrides,
  };
}

describe("ChatRuntime", () => {
  it("runs and interrupts turns through ConversationTurnRuntime", async () => {
    let runtime;
    let seen = 0;
    const { session } = createStubSession(async function* (signal) {
      yield { type: "notice", severity: "info", text: "tick" };
      seen += 1;
      runtime.interruptTurn();
      while (!signal.aborted) {
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    });

    runtime = new ChatRuntime({
      session,
      persona: createPersona(),
      promptContext: createPromptContext(),
      environment: createEnvironment(),
    });

    const run = runtime.runTurn();

    expect(runtime.isTurnRunning).toBe(true);
    const result = await run;

    expect(seen).toBe(1);
    expect(result).toEqual(expect.objectContaining({ aborted: true }));
    expect(runtime.isTurnRunning).toBe(false);
    expect(runtime.interruptTurn()).toBe(false);
  });

  it("creates a runtime with a concrete tool registry", () => {
    const backend = createLocalToolExecutionBackend();
    const toolRegistry = ToolCatalog.createRegistry(backend);

    const runtime = ChatRuntime.create({
      persona: createPersona(),
      toolRegistry,
      modelResolver: resolveModel,
      promptContext: createPromptContext(),
      environment: createEnvironment(),
    });

    runtime.session.addUserText("hello from create");

    expect(runtime.session.history).toHaveLength(1);
    expect(runtime.session.history[0]?.role).toBe("user");
    expect(runtime.promptComposition.baseSystemPrompt).toContain("main system prompt");
    expect(runtime.promptComposition.baseSystemPrompt).toContain("<cwd>/repo</cwd>");
    expect(runtime.promptComposition.subagentPrompts.default).toContain("<inherited-instructions>");
    expect(runtime.promptComposition.subagentPrompts.default).toContain("main system prompt");
    expect(runtime.promptComposition.subagentPrompts.default).not.toContain(
      "{{inherited_instructions}}",
    );
  });

  it("creates a runtime with an explicit initial prompt composition", () => {
    const backend = createLocalToolExecutionBackend();
    const toolRegistry = ToolCatalog.createRegistry(backend);
    const initialPromptComposition = {
      environmentTag: "<environment><datetime>persisted</datetime></environment>",
      baseSystemPrompt: "persisted system prompt",
      subagentPrompts: {
        default: "persisted subagent prompt",
      },
    };

    const runtime = ChatRuntime.create({
      persona: createPersona(),
      toolRegistry,
      modelResolver: resolveModel,
      promptContext: createPromptContext(),
      environment: createEnvironment(Date.parse("2027-01-01T00:00:00.000Z")),
      initialPromptComposition,
    });

    expect(runtime.promptComposition).toEqual(initialPromptComposition);
    expect(runtime.promptComposition.baseSystemPrompt).not.toContain("2027-01-01");
  });

  it("rebuilds full system prompts with main and subagent content", () => {
    const { session, calls } = createStubSession();
    const persona = createPersona();

    const runtime = new ChatRuntime({
      session,
      persona,
      promptContext: createPromptContext({
        skillsBlock: "### Skills\n\n- skill-a",
        projectContextBlock: '### Project context\n\n<file path="/repo/AGENTS.md">ctx</file>',
      }),
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
    expect(composition.baseSystemPrompt).toContain("Launch model overrides");
    expect(composition.baseSystemPrompt).toContain("openai/gpt-5.4:high");
    expect(composition.baseSystemPrompt).toContain(
      "By default, launch the subagent without a model override unless the user explicitly asks to use a specific model.",
    );
    expect(composition.baseSystemPrompt).toContain("<datetime>2026-01-01T00:00:00.000Z</datetime>");

    expect(composition.subagentPrompts.default).toContain("<inherited-instructions>");
    expect(composition.subagentPrompts.default).toContain("main system prompt");
    expect(composition.subagentPrompts.researcher).toContain("research subagent prompt");

    const lastSetPersona = calls.setPersonaCalls.at(-1);
    expect(lastSetPersona).toBeDefined();
    expect(lastSetPersona.persona).toBe(persona);
    expect(lastSetPersona.systemPrompt).toBe(composition.baseSystemPrompt);
    expect(lastSetPersona.subagentPrompts).toEqual(composition.subagentPrompts);
  });
});
