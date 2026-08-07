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

  const tools = overrides.tools ?? {};
  const timelineInput =
    overrides.timeline ??
    messages
      .filter((entry) => entry.id !== "system")
      .map((entry) => ({
        type: "message",
        id: `timeline-${entry.id}`,
        messageId: entry.id,
      }));
  const { timeline, operations } = normalizeFixtureTimeline(
    timelineInput,
    messages,
    tools,
    overrides.operations,
  );

  const snapshot = {
    sessionId: overrides.sessionId ?? "session-1",
    attributes: overrides.attributes ?? { source: "test" },
    createdAt: overrides.createdAt ?? 0,
    revision: overrides.revision ?? 1,
    agentState: overrides.agentState ?? {
      revision: historyEntries.length,
      modelContextKey: "fixture-context",
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
    turns: overrides.turns ?? {},
    timeline,
    tools,
    operations,
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

function normalizeFixtureTimeline(input, messages, tools, operationOverrides) {
  if (!Array.isArray(input)) {
    return { timeline: input, operations: operationOverrides ?? {} };
  }

  const messagesById = new Map(messages.map((message) => [message.id, message]));
  const embeddedOperations = Object.fromEntries(
    input.flatMap((item) =>
      item.type === "operation" && item.operation
        ? [[item.operation.id ?? item.id, { id: item.operation.id ?? item.id, ...item.operation }]]
        : [],
    ),
  );
  const operations = operationOverrides ?? embeddedOperations;
  const toolIdsByMessageId = new Map();
  for (const [toolId, tool] of Object.entries(tools)) {
    const position = tool.status === "streaming" ? tool.origin : tool.call;
    const ids = toolIdsByMessageId.get(position.messageId) ?? [];
    ids.push(toolId);
    ids.sort((leftId, rightId) => {
      const left = tools[leftId];
      const right = tools[rightId];
      const leftPosition = left.status === "streaming" ? left.origin : left.call;
      const rightPosition = right.status === "streaming" ? right.origin : right.call;
      return leftPosition.contentIndex - rightPosition.contentIndex;
    });
    toolIdsByMessageId.set(position.messageId, ids);
  }

  let sequence = 0;
  const items = [];
  const append = (item, createdAt = 0) => {
    sequence += 1;
    items.push({ ...item, sequence, createdAt });
  };
  for (const item of input) {
    if (item.type === "operation") {
      const operationId = item.operationId ?? item.operation?.id ?? item.id;
      append(
        { type: "operation", id: item.id, operationId },
        item.createdAt ?? item.operation?.startedAt,
      );
      continue;
    }
    if (item.type === "notice" && !("kind" in item.notice)) {
      append(
        {
          type: "notice",
          id: item.id,
          notice: {
            kind: "tau.test.notice",
            version: 1,
            severity: item.notice.severity,
            subject: item.notice.subject ?? { type: "session" },
            presentation: {
              title: item.notice.title ?? item.notice.text ?? "test notice",
              ...(item.notice.content ? { content: item.notice.content } : {}),
            },
            data: {},
          },
        },
        item.createdAt ?? item.notice.timestamp,
      );
      continue;
    }
    const createdAt =
      item.createdAt ??
      (item.type === "message" ? messagesById.get(item.messageId)?.message.timestamp : 0);
    append(item, createdAt);
    if (item.type === "message") {
      for (const toolId of toolIdsByMessageId.get(item.messageId) ?? []) {
        append({ type: "tool", id: `timeline-tool-${toolId}`, toolId }, createdAt);
      }
    }
  }
  for (const [toolId, tool] of Object.entries(tools)) {
    if (items.some((item) => item.type === "tool" && item.toolId === toolId)) {
      continue;
    }
    const position = tool.status === "streaming" ? tool.origin : tool.call;
    append(
      { type: "tool", id: `timeline-tool-${toolId}`, toolId },
      messagesById.get(position.messageId)?.message.timestamp,
    );
  }
  return { timeline: { epoch: 1, sequence, items }, operations };
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
