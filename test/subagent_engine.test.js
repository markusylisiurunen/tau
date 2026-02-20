import { describe, expect, it, vi } from "vitest";
import { personas } from "../dist/core/personas.js";

const { capturedUserMessages, runModelSubturnMock, runToolCallsMock } = vi.hoisted(() => ({
  capturedUserMessages: [],
  runModelSubturnMock: vi.fn(),
  runToolCallsMock: vi.fn(),
}));

vi.mock("../dist/core/session/runner.js", () => ({
  runModelSubturn: runModelSubturnMock,
  runToolCalls: runToolCallsMock,
}));

vi.mock("../dist/core/usage/logs.js", () => ({
  appendUsageLogEntry: vi.fn(),
  getUsageCostTotal: (usage) => usage?.cost?.total ?? 0,
  getUsageTotals: (usage) => usage,
}));

import { runSubagent } from "../dist/core/subagents/subagent_engine.js";

function createAssistantMessage(model) {
  return {
    role: "assistant",
    api: "anthropic-messages",
    provider: model.provider,
    model: model.id,
    stopReason: "stop",
    timestamp: Date.now(),
    usage: {
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      totalTokens: 0,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
    },
    content: [{ type: "text", text: "done" }],
  };
}

describe("subagent engine model notices", () => {
  it("prepends configured model notices to subagent user prompts", async () => {
    capturedUserMessages.length = 0;

    const persona = personas.find((entry) => entry.model.provider === "anthropic");
    expect(persona).toBeDefined();

    runModelSubturnMock.mockImplementationOnce(async function* ({ context }) {
      const userMessage = context.messages.find((message) => message.role === "user");
      const textBlock = userMessage?.content.find((block) => block.type === "text");
      capturedUserMessages.push(textBlock?.text ?? "");
      return createAssistantMessage(persona.model);
    });

    const result = await runSubagent({
      runtimeConfig: {
        name: "default",
        systemPrompt: "subagent system",
        model: persona.model,
        tools: [],
        riskLevel: "read-only",
      },
      prompt: "collect findings",
      config: {
        modelSystemNotices: {
          [`${persona.model.provider}/${persona.model.id}`]: "subagent notice",
        },
      },
      signal: new AbortController().signal,
      turnUserHistoryEntryId: "history-1",
    });

    expect(result.finalText).toBe("done");
    expect(capturedUserMessages).toEqual(["<system>subagent notice</system>\n\ncollect findings"]);
  });
});
