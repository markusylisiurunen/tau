import { describe, expect, it } from "vitest";
import { runToolCalls } from "../dist/core/session/runner.js";
import { ToolRegistry } from "../dist/core/tools/registry.js";

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

describe("session runner tool dispatch context", () => {
  it("passes dispatchContext to tool definitions", async () => {
    const signal = new AbortController().signal;
    const toolCall = {
      id: "tool-call-1",
      type: "toolCall",
      name: "fake_tool",
      arguments: {},
    };

    let receivedContext;
    let receivedSignal;

    const definition = {
      schema: {
        name: "fake_tool",
        description: "test",
        parameters: {
          type: "object",
          properties: {},
          additionalProperties: false,
        },
      },
      async dispatch(call, _riskLevel, dispatchSignal, context) {
        receivedSignal = dispatchSignal;
        receivedContext = context;
        return {
          kind: "single",
          toolResult: createToolResult(call, "ok"),
        };
      },
    };

    const toolRegistry = new ToolRegistry([definition]);
    const dispatchContext = {
      scope: "subagent",
      config: {},
      toolRegistry,
      authPath: "/tmp/auth.json",
      originHistoryEntryId: "history-1",
      cwd: "/repo/subagent",
      subagentContext: {
        id: "subagent-1",
        name: "default",
        title: "default",
        originHistoryEntryId: "history-1",
        controlPlane: { recordEmitOutput: () => {} },
      },
    };

    const events = [];
    for await (const event of runToolCalls({
      toolCalls: [toolCall],
      toolRegistry,
      enabledTools: toolRegistry.schemas,
      riskLevel: "read-only",
      signal,
      dispatchContext,
    })) {
      events.push(event);
    }

    expect(receivedSignal).toBe(signal);
    expect(receivedContext).toBe(dispatchContext);
    expect(events).toEqual([
      {
        type: "tool_result",
        message: expect.objectContaining({
          role: "tool",
          toolCallId: "tool-call-1",
          toolName: "fake_tool",
          isError: false,
        }),
      },
    ]);
  });
});
