import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";
import { resolveConfigLevels } from "../dist/core/config/index.js";
import { personas } from "../dist/core/personas.js";

const { capturedUserMessages, runModelSubturnMock, runToolCallsMock } = vi.hoisted(() => ({
  capturedUserMessages: [],
  runModelSubturnMock: vi.fn(),
  runToolCallsMock: vi.fn(),
}));

vi.mock("../dist/core/session/runner.js", () => ({
  MAX_MODEL_SUBTURNS: 1024,
  runModelSubturn: runModelSubturnMock,
  runToolCalls: runToolCallsMock,
}));

vi.mock("../dist/core/usage/logs.js", () => ({
  appendUsageLogEntry: vi.fn(),
  getUsageCostTotal: (usage) => usage?.cost?.total ?? 0,
  getUsageTotals: (usage) => usage,
}));

import { loadModelResolver } from "../dist/core/models/catalog.js";
import { runSubagent } from "../dist/core/subagents/subagent_engine.js";

function createModelResolver(cwd = process.cwd(), home = process.env.HOME ?? cwd) {
  const deps = {
    fs: {
      readFile: (path) => readFileSync(path, "utf-8"),
      exists: (path) => existsSync(path),
      listDir: (path) => readdirSync(path),
      stat: (path) => statSync(path),
    },
    env: {
      getEnv: () => ({}),
      cwd: () => cwd,
      home: () => home,
    },
  };
  const levels = resolveConfigLevels(deps, { cwd });

  return loadModelResolver({ deps, levels }).resolveModel;
}

function createAssistantMessage(model, overrides = {}) {
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
    ...overrides,
  };
}

function createToolResult(toolCall, text) {
  return {
    role: "tool",
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    timestamp: Date.now(),
    isError: false,
    content: [{ type: "text", text }],
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
        workingDirectory: "/repo/current",
      },
      prompt: "collect findings",
      config: {
        modelSystemNotices: {
          [`${persona.model.provider}/${persona.model.id}`]: "subagent notice",
        },
      },
      modelResolver: createModelResolver(),
      signal: new AbortController().signal,
      originHistoryEntryId: "history-1",
    });

    expect(result.finalText).toBe("done");
    expect(capturedUserMessages).toEqual(["<system>subagent notice</system>\ncollect findings"]);
  });

  it("passes subagent workingDirectory as dispatch context cwd", async () => {
    runModelSubturnMock.mockReset();
    runToolCallsMock.mockReset();

    const persona = personas.find((entry) => entry.model.provider === "anthropic");
    expect(persona).toBeDefined();

    const toolCall = {
      id: "tool-call-1",
      type: "toolCall",
      name: "bash",
      arguments: {
        command: "pwd",
      },
    };

    runModelSubturnMock
      .mockImplementationOnce(async function* () {
        yield* [];
        return createAssistantMessage(persona.model, {
          stopReason: "toolUse",
          content: [toolCall],
        });
      })
      .mockImplementationOnce(async function* () {
        yield* [];
        return createAssistantMessage(persona.model);
      });

    runToolCallsMock.mockImplementationOnce(async function* ({ dispatchContext }) {
      expect(dispatchContext.cwd).toBe("/repo/subdir");
      yield {
        type: "tool_result",
        message: createToolResult(toolCall, "/repo/subdir"),
      };
    });

    const result = await runSubagent({
      runtimeConfig: {
        name: "default",
        systemPrompt: "subagent system",
        model: persona.model,
        tools: ["bash"],
        workingDirectory: "/repo/subdir",
      },
      prompt: "collect findings",
      config: {},
      modelResolver: createModelResolver(),
      signal: new AbortController().signal,
      originHistoryEntryId: "history-1",
    });

    expect(result.finalText).toBe("done");
    expect(runToolCallsMock).toHaveBeenCalledTimes(1);
  });
});
