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
  it("emits phased intermediate tool UI events before the final tool result", async () => {
    const signal = new AbortController().signal;
    const toolCall = {
      id: "tool-call-1",
      type: "toolCall",
      name: "fake_tool",
      arguments: {},
    };

    async function* uiEvents() {
      yield {
        type: "bash_execution",
        toolCallId: "tool-call-1",
        command: "echo progress",
        headerTarget: "echo progress",
        exitCode: 0,
        truncationInfo: {
          output: "progress",
          model: {
            content: "progress",
            truncated: false,
            totalBytes: 8,
            totalLines: 1,
            outputBytes: 8,
            outputLines: 1,
          },
          captureTruncated: false,
        },
        uiText: {
          previewLines: [{ text: "progress" }],
          fullLines: [{ text: "progress" }],
        },
      };
    }

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
      async dispatch(call) {
        return {
          kind: "phased",
          startedUiEvent: {
            type: "bash_started",
            toolCallId: call.id,
            command: "echo start",
            headerTarget: "echo start",
          },
          uiEvents: uiEvents(),
          run: new Promise((resolve) => {
            setTimeout(() => {
              resolve({
                kind: "single",
                toolResult: createToolResult(call, "ok"),
                uiEvent: {
                  type: "bash_blocked",
                  toolCallId: call.id,
                  command: "echo done",
                  headerTarget: "echo done",
                  reason: "done",
                },
              });
            }, 0);
          }),
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

    expect(events.map((event) => event.type)).toEqual([
      "tool_ui",
      "tool_ui",
      "tool_ui",
      "tool_result",
    ]);
    expect(events[0].uiEvent.type).toBe("bash_started");
    expect(events[1].uiEvent.type).toBe("bash_execution");
    expect(events[2].uiEvent.type).toBe("bash_blocked");
  });

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
