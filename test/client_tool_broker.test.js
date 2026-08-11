import { describe, expect, it, vi } from "vitest";
import { HOST_TOOL_NAMES } from "../src/core/tools/tool_names.ts";
import { ClientToolBroker } from "../src/host/client_tool_broker.ts";
import { buildTauClientToolPresentation } from "../src/sdk/client_tool_presentation.ts";

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
    activities,
    uiEvent: activities.at(-1),
  };
}

describe("ClientToolBroker", () => {
  it("reserves history and tau_docs for the host", () => {
    expect(HOST_TOOL_NAMES).toEqual(expect.arrayContaining(["history", "tau_docs"]));
  });

  it.each(HOST_TOOL_NAMES)("rejects client tools that duplicate the %s host tool", (name) => {
    const broker = new ClientToolBroker();

    expect(() =>
      broker.registerClient({
        tools: [
          {
            name,
            description: `Conflicting ${name} tool.`,
            parameters: { type: "object", properties: {}, additionalProperties: false },
          },
        ],
        sendCall: vi.fn(),
        sendCancel: vi.fn(),
      }),
    ).toThrow(`client tool '${name}' duplicates a host tool`);
  });

  it("returns full client tool results with a truncated final UI event", async () => {
    const broker = new ClientToolBroker();
    const longLine = "x".repeat(200);
    const content = [
      "one",
      longLine,
      "three",
      "four",
      "five",
      "six",
      "seven",
      "eight",
      "nine",
    ].join("\n");
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
        expect(message.agentId).toBe("test-agent");
        void broker
          .ack(
            message.sessionId,
            message.callId,
            buildTauClientToolPresentation({
              toolName: "local_picker",
              subject: "choice a",
            }),
          )
          .then(() => {
            broker.result(message.sessionId, message.callId, { ok: true, content });
          });
      },
      sendCancel,
    });
    registration.attachSession("session-1");

    const definition = broker.getToolDefinitions("session-1")[0];
    const result = await runTool(definition, createToolCall({ choice: "a" }));

    expect(result.toolResult.content[0].text).toBe(content);
    expect(result.activities[0]).toMatchObject({
      type: "tool_call_started",
      presentation: { subject: "choice a" },
    });
    expect(result.uiEvent).toMatchObject({
      type: "tool_call_finished",
      toolCallId: "tool-call-1",
      toolName: "local_picker",
      status: "success",
      presentation: {
        subject: "choice a",
        metadata: [expect.stringMatching(/^(?:\d+ms|\d+(?:\.\d+)?s)$/), "~40 tokens", "9 lines"],
      },
    });
    expect(result.uiEvent.presentation.details.map((line) => line.text)).toEqual([
      "one",
      "x".repeat(200),
      "three",
      "…3 more lines…",
      "seven",
      "eight",
      "nine",
    ]);
    expect(sendCancel).not.toHaveBeenCalled();
  });

  it("does not synthesize details for empty client tool results", async () => {
    const broker = new ClientToolBroker();
    const registration = broker.registerClient({
      tools: [
        {
          name: "local_picker",
          description: "Pick a local item.",
          parameters: { type: "object", properties: {}, additionalProperties: false },
        },
      ],
      sendCall: (message) => {
        void broker
          .ack(
            message.sessionId,
            message.callId,
            buildTauClientToolPresentation({
              toolName: "local_picker",
              subject: "empty choice",
            }),
          )
          .then(() => {
            broker.result(message.sessionId, message.callId, { ok: true, content: "" });
          });
      },
      sendCancel: vi.fn(),
    });
    registration.attachSession("session-1");

    const definition = broker.getToolDefinitions("session-1")[0];
    const result = await runTool(definition, createToolCall({ choice: "a" }));

    expect(result.uiEvent.presentation.details).toEqual([]);
    expect(result.uiEvent.presentation.metadata).toEqual([
      expect.stringMatching(/^(?:\d+ms|\d+(?:\.\d+)?s)$/),
    ]);
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

    const result = await runTool(definition, createToolCall({ choice: "a" }));

    expect(result.toolResult.outcome).toBe("blocked");
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

      expect(result.outcome).toBe("blocked");
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
