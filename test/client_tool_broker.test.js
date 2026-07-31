import { describe, expect, it, vi } from "vitest";
import { ClientToolBroker } from "../src/host/client_tool_broker.ts";

function createToolCall(args = {}) {
  return {
    id: "tool-call-1",
    type: "toolCall",
    name: "local_picker",
    arguments: args,
  };
}

async function runTool(tool, toolCall, signal = new AbortController().signal) {
  const activities = [];
  const outcome = await tool.execute(toolCall, {
    agentId: "test-agent",
    turnId: "test-turn",
    assistantMessageId: "test-assistant",
    signal,
    emitActivity: async (activity) => activities.push(activity),
  });
  return {
    toolResult: { ...outcome, toolCallId: toolCall.id, toolName: toolCall.name },
    uiEvent: activities.at(-1),
    activities,
  };
}

describe("ClientToolBroker", () => {
  it("returns full client tool results with a truncated final UI event", async () => {
    const broker = new ClientToolBroker();
    const longLine = "x".repeat(200);
    const content = ["one", longLine, "three", "four", "five", "six", "seven", "eight"].join("\n");
    const sendCancel = vi.fn();
    const registration = broker.registerClient({
      tools: [
        {
          name: "local_picker",
          description: "Pick a local item.",
          parameters: { type: "object", properties: {}, additionalProperties: false },
        },
      ],
      sendCall: (message) => {
        broker.ack(message.sessionId, message.callId);
        broker.result(message.sessionId, message.callId, { ok: true, content });
      },
      sendCancel,
    });
    registration.attachSession("session-1");

    const definition = broker.getToolDefinitions("session-1")[0];
    expect(definition.describe(createToolCall({ choice: "a" }))).toEqual({
      headerTarget: "local_picker",
    });
    const result = await runTool(
      definition,
      createToolCall({ choice: "a" }),
      new AbortController().signal,
      {},
    );

    expect(result.toolResult.content[0].text).toBe(content);
    expect(result.uiEvent).toMatchObject({
      type: "client_tool_finished",
      toolCallId: "tool-call-1",
      toolName: "local_picker",
      headerTarget: "local_picker",
      status: "success",
      uiText: {
        statusLine: "success · 8 lines · ~39 tokens · 236 B",
      },
    });
    expect(result.uiEvent.uiText.previewLines.map((line) => line.text)).toEqual([
      "one",
      `${"x".repeat(159)}…`,
      "three",
      "…2 more lines…",
      "six",
      "seven",
      "eight",
    ]);
    expect(result.uiEvent.uiText.fullLines).toEqual(result.uiEvent.uiText.previewLines);
    expect(sendCancel).not.toHaveBeenCalled();
  });

  it("returns clear errors when client tools become unavailable", async () => {
    const broker = new ClientToolBroker();
    const registration = broker.registerClient({
      tools: [
        {
          name: "local_picker",
          description: "Pick a local item.",
          parameters: { type: "object", properties: {}, additionalProperties: false },
        },
      ],
      sendCall: vi.fn(),
      sendCancel: vi.fn(),
    });
    registration.attachSession("session-1");
    const definition = broker.getToolDefinitions("session-1")[0];
    registration.detachSession("session-1");

    const result = await runTool(
      definition,
      createToolCall({ choice: "a" }),
      new AbortController().signal,
      {},
    );

    expect(result.toolResult.isError).toBe(true);
    expect(result.toolResult.content[0].text).toBe(
      "Client tool 'local_picker' is unavailable because its owning client detached.",
    );
  });

  it("reports client tool acknowledgement timeouts with the tool name", async () => {
    vi.useFakeTimers();
    try {
      const broker = new ClientToolBroker();
      const sendCancel = vi.fn();
      const registration = broker.registerClient({
        tools: [
          {
            name: "local_picker",
            description: "Pick a local item.",
            parameters: { type: "object", properties: {}, additionalProperties: false },
          },
        ],
        sendCall: vi.fn(),
        sendCancel,
      });
      registration.attachSession("session-1");
      const definition = broker.getToolDefinitions("session-1")[0];

      const execution = definition.execute(createToolCall({ choice: "a" }), {
        agentId: "test-agent",
        turnId: "test-turn",
        assistantMessageId: "test-assistant",
        signal: new AbortController().signal,
        emitActivity: async () => {},
      });
      await vi.advanceTimersByTimeAsync(5000);
      const result = await execution;

      expect(result.isError).toBe(true);
      expect(result.content[0].text).toBe(
        "Client tool 'local_picker' is unavailable because its owning client did not acknowledge the tool call within 5000ms.",
      );
      expect(sendCancel).toHaveBeenCalledWith(expect.objectContaining({ reason: "timeout" }));
    } finally {
      vi.useRealTimers();
    }
  });

  it("scopes client tools to attached sessions", () => {
    const broker = new ClientToolBroker();
    const first = broker.registerClient({
      tools: [
        {
          name: "local_picker",
          description: "Pick a local item.",
          parameters: { type: "object", properties: {}, additionalProperties: false },
        },
      ],
      sendCall: vi.fn(),
      sendCancel: vi.fn(),
    });
    const second = broker.registerClient({
      tools: [
        {
          name: "local_picker",
          description: "Pick a local item.",
          parameters: { type: "object", properties: {}, additionalProperties: false },
        },
      ],
      sendCall: vi.fn(),
      sendCancel: vi.fn(),
    });

    first.attachSession("session-1");
    second.attachSession("session-2");

    expect(broker.getToolDefinitions("session-1")).toHaveLength(1);
    expect(broker.getToolDefinitions("session-2")).toHaveLength(1);
    expect(broker.getToolDefinitions("session-3")).toHaveLength(0);
    expect(() => second.attachSession("session-1")).toThrow(
      "client tool 'local_picker' is already advertised for this session",
    );

    first.detachSession("session-1");
    expect(broker.getToolDefinitions("session-1")).toHaveLength(0);
  });
});
