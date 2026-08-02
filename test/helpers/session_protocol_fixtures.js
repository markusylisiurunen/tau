const model = {
  id: "gpt-5.5",
  name: "GPT 5.5",
  api: "openai-responses",
  provider: "openai",
  baseUrl: "",
  reasoning: true,
  input: ["text"],
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
  contextWindow: 128000,
  maxTokens: 32000,
};

export function createProtocolBootstrap(overrides = {}) {
  return {
    persona: {
      id: "persona-1",
      label: "Persona 1",
      model,
      systemPrompt: "system prompt",
      settings: { reasoning: "none" },
      skills: "*",
      source: "builtin",
    },
    prompt: {
      environmentTag: "<environment></environment>",
      baseSystemPrompt: "system prompt",
      subagentPrompts: {},
    },
    ...overrides,
  };
}

export function createProtocolCatalog(overrides = {}) {
  return {
    personas: [createProtocolBootstrap().persona],
    prompts: [
      {
        id: "prompt-1",
        label: "Prompt 1",
        template: "prompt template",
      },
    ],
    themes: [{ id: "gold" }],
    skills: [],
    ...overrides,
  };
}

export function createProtocolSnapshot(overrides = {}) {
  const bootstrap = overrides.bootstrap ?? createProtocolBootstrap();
  const catalog = overrides.catalog ?? createProtocolCatalog();
  const historyEntries = overrides.historyEntries ?? [];
  const systemPrompt =
    bootstrap.prompt?.baseSystemPrompt ?? bootstrap.persona?.systemPrompt ?? "system prompt";
  const messages = overrides.messages ?? [
    {
      id: "system",
      state: "committed",
      modelVisible: true,
      message: { role: "system", content: systemPrompt, timestamp: 0 },
    },
    ...historyEntries.map((entry) => ({
      id: entry.id,
      state: "committed",
      modelVisible: true,
      message: addMissingMessageDefaults(entry.message),
    })),
  ];

  const snapshot = {
    sessionId: overrides.sessionId ?? "session-1",
    revision: overrides.revision ?? 1,
    agentState: overrides.agentState ?? {
      revision: historyEntries.length,
      contextEpoch: "fixture-context",
    },
    lifecycle: overrides.lifecycle ?? "idle",
    goal: overrides.goal ?? null,
    costTotal: overrides.costTotal ?? 0,
    settings: overrides.settings ?? {
      personaId: bootstrap.persona?.id ?? "persona-1",
      ...(bootstrap.persona?.settings?.reasoning !== undefined
        ? { reasoning: bootstrap.persona.settings.reasoning }
        : {}),
      ...(bootstrap.persona?.settings?.serviceTier !== undefined
        ? { serviceTier: bootstrap.persona.settings.serviceTier }
        : {}),
    },
    bootstrap: {
      model: bootstrap.model ?? bootstrap.persona?.model ?? model,
      prompt: {
        environmentTag: bootstrap.prompt?.environmentTag ?? "<environment></environment>",
        subagentPrompts: bootstrap.prompt?.subagentPrompts ?? {},
      },
    },
    catalog: {
      personas: (catalog.personas ?? []).map((persona) => ({
        id: persona.id,
        label: persona.label,
        ...(persona.description !== undefined ? { description: persona.description } : {}),
        ...(persona.allowedReasoningLevels
          ? { allowedReasoningLevels: [...persona.allowedReasoningLevels] }
          : {}),
        ...(persona.subagents ? { subagents: persona.subagents } : {}),
        ...(persona.tools ? { tools: [...persona.tools] } : {}),
        skills: Array.isArray(persona.skills) ? [...persona.skills] : (persona.skills ?? "*"),
        source: persona.source ?? "builtin",
      })),
      prompts: (catalog.prompts ?? []).map((prompt) => ({
        id: prompt.id,
        ...(prompt.label !== undefined ? { label: prompt.label } : {}),
        ...(prompt.description !== undefined ? { description: prompt.description } : {}),
      })),
      skills: catalog.skills ?? [],
    },
    executionEnvironment: overrides.executionEnvironment ?? {
      kind: "local",
      cwd: "/repo",
      home: "/home/user",
    },
    messages,
    timeline:
      overrides.timeline ??
      messages
        .filter((entry) => entry.id !== "system")
        .map((entry) => ({
          type: "message",
          id: `timeline-${entry.id}`,
          messageId: entry.id,
        })),
    tools: overrides.tools ?? {},
    agents: overrides.agents ?? {},
    facets: overrides.facets ?? {},
  };

  Object.defineProperty(snapshot, "historyEntries", {
    enumerable: false,
    get() {
      return snapshot.messages
        .filter((entry) => entry.id !== "system")
        .map((entry) => ({ id: entry.id, message: entry.message }));
    },
  });

  return snapshot;
}

export function createProtocolExecResult(overrides = {}) {
  const { command: _command, ...resultOverrides } = overrides;
  const output = resultOverrides.output ?? "/repo\n";
  const stdout = resultOverrides.stdout ?? output;
  const stderr = resultOverrides.stderr ?? "";
  return {
    output,
    stdout,
    stderr,
    exitCode: 0,
    truncated: false,
    timedOut: false,
    aborted: false,
    closeSignal: null,
    ...resultOverrides,
  };
}

function addMissingMessageDefaults(message) {
  if (message.role !== "assistant") {
    return {
      timestamp: message.timestamp ?? 0,
      ...message,
    };
  }
  return {
    api: message.api ?? "openai-responses",
    usage: message.usage ?? {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    timestamp: message.timestamp ?? Date.now(),
    ...message,
  };
}
