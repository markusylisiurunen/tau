import { describe, expect, it, vi } from "vitest";
import { HOST_TOOL_NAMES } from "../src/core/tools/tool_names.ts";
import { ClientToolBroker } from "../src/host/client_tool_broker.ts";

function createToolCall(args = {}) {
  return {
    id: "tool-call-1",
    type: "toolCall",
    name: "local_picker",
    arguments: args,
  };
}

async function runTool(tool, toolCall, signal = new AbortController().signal, emitActivity) {
  const activities = [];
  const outcome = await tool.execute(toolCall, {
    agentId: "test-agent",
    turnId: "test-turn",
    assistantMessageId: "test-assistant",
    signal,
    emitActivity: async (activity) => {
      activities.push(activity);
      await emitActivity?.(activity);
    },
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
        void broker.ack(message.sessionId, message.callId, { subject: "choice a" }).then(() => {
          broker.result(message.sessionId, message.callId, {
            ok: true,
            content,
            presentation: { subject: "choice a" },
          });
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
      presentation: {
        operation: "local_picker",
        subject: "choice a",
        actionByStatus: { running: "running", succeeded: "completed" },
      },
    });
    expect(result.uiEvent).toMatchObject({
      type: "tool_call_finished",
      toolCallId: "tool-call-1",
      toolName: "local_picker",
      status: "success",
      presentation: {
        operation: "local_picker",
        subject: "choice a",
        actionByStatus: { running: "running", succeeded: "completed" },
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
        void broker.ack(message.sessionId, message.callId, { subject: "empty choice" }).then(() => {
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

  it("lets terminal presentation suppress generated details and metadata", async () => {
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
        void broker.ack(message.sessionId, message.callId).then(() => {
          broker.result(message.sessionId, message.callId, {
            ok: true,
            content: "hidden result",
            presentation: { subject: "local_picker", details: [], metadata: [] },
          });
        });
      },
      sendCancel: vi.fn(),
    });
    registration.attachSession("session-1");

    const definition = broker.getToolDefinitions("session-1")[0];
    const result = await runTool(definition, createToolCall());

    expect(result.activities[0].presentation).toMatchObject({
      subject: "local_picker",
      details: [],
      metadata: [],
    });
    expect(result.uiEvent.presentation).toMatchObject({
      operation: "local_picker",
      subject: "local_picker",
      details: [],
      metadata: [],
    });
  });

  it("preserves explicit presentation up to protocol safety limits", async () => {
    const broker = new ClientToolBroker();
    const subject = Array.from({ length: 9 }, (_, index) => `${index}:${"s".repeat(600)}`).join(
      "\n",
    );
    const details = Array.from({ length: 9 }, (_, index) => ({
      text: `${index}:${"d".repeat(600)}`,
    }));
    const metadata = [`  ${"m".repeat(600)}  `];
    const presentation = { subject, details, metadata };
    const registration = broker.registerClient({
      tools: [
        {
          name: "local_picker",
          description: "Pick a local item.",
          parameters: { type: "object", properties: {}, additionalProperties: false },
        },
      ],
      sendCall: (message) => {
        void broker.ack(message.sessionId, message.callId, presentation).then(() => {
          broker.result(message.sessionId, message.callId, {
            ok: true,
            content: "result",
            presentation,
          });
        });
      },
      sendCancel: vi.fn(),
    });
    registration.attachSession("session-1");

    const definition = broker.getToolDefinitions("session-1")[0];
    const result = await runTool(definition, createToolCall());
    const expected = {
      operation: "local_picker",
      subject,
      details: details.map((line) => ({ ...line, wrap: "word" })),
      metadata,
    };

    expect(result.activities[0].presentation).toMatchObject(expected);
    expect(result.uiEvent.presentation).toMatchObject(expected);
  });

  it("rejects successful results until acknowledgement completes", async () => {
    const broker = new ClientToolBroker();
    let acknowledgement;
    let callMessage;
    let releaseActivity = () => {};
    const activityGate = new Promise((resolve) => {
      releaseActivity = resolve;
    });
    const registration = broker.registerClient({
      tools: [
        {
          name: "local_picker",
          description: "Pick a local item.",
          parameters: { type: "object", properties: {}, additionalProperties: false },
        },
      ],
      sendCall: (message) => {
        callMessage = message;
        acknowledgement = broker.ack(message.sessionId, message.callId, {
          subject: "choice a",
        });
      },
      sendCancel: vi.fn(),
    });
    registration.attachSession("session-1");

    const definition = broker.getToolDefinitions("session-1")[0];
    const execution = runTool(
      definition,
      createToolCall({ choice: "a" }),
      new AbortController().signal,
      async (activity) => {
        if (activity.type === "tool_call_started") await activityGate;
      },
    );
    await vi.waitFor(() => expect(acknowledgement).toBeDefined());

    expect(
      broker.result(callMessage.sessionId, callMessage.callId, {
        ok: true,
        content: "too early",
      }),
    ).toBe(false);

    releaseActivity();
    await expect(acknowledgement).resolves.toBe(true);
    expect(
      broker.result(callMessage.sessionId, callMessage.callId, {
        ok: true,
        content: "accepted",
      }),
    ).toBe(true);

    const result = await execution;
    expect(result.toolResult.outcome).toBe("succeeded");
    expect(result.toolResult.content[0].text).toBe("accepted");
    expect(result.activities.map((activity) => activity.type)).toEqual([
      "tool_call_started",
      "tool_call_finished",
    ]);
  });

  it("accepts preparation failures before acknowledgement", async () => {
    const broker = new ClientToolBroker();
    let accepted;
    const registration = broker.registerClient({
      tools: [
        {
          name: "local_picker",
          description: "Pick a local item.",
          parameters: { type: "object", properties: {}, additionalProperties: false },
        },
      ],
      sendCall: (message) => {
        accepted = broker.result(message.sessionId, message.callId, {
          ok: false,
          error: "description failed",
        });
      },
      sendCancel: vi.fn(),
    });
    registration.attachSession("session-1");

    const definition = broker.getToolDefinitions("session-1")[0];
    const result = await runTool(definition, createToolCall({ choice: "a" }));

    expect(accepted).toBe(true);
    expect(result.toolResult.outcome).toBe("failed");
    expect(result.toolResult.content[0].text).toBe("description failed");
    expect(result.activities.map((activity) => activity.type)).toEqual(["tool_call_finished"]);
    expect(result.uiEvent.presentation.subject).toBe("local_picker");
  });

  it("cancels prepared client work and uses fallback presentation when acknowledgement fails", async () => {
    const broker = new ClientToolBroker();
    const sendCancel = vi.fn();
    let acknowledgement;
    const registration = broker.registerClient({
      tools: [
        {
          name: "local_picker",
          description: "Pick a local item.",
          parameters: { type: "object", properties: {}, additionalProperties: false },
        },
      ],
      sendCall: (message) => {
        acknowledgement = broker.ack(message.sessionId, message.callId, {
          subject: "choice a",
        });
      },
      sendCancel,
    });
    registration.attachSession("session-1");

    const definition = broker.getToolDefinitions("session-1")[0];
    let activityCount = 0;
    const result = await runTool(
      definition,
      createToolCall({ choice: "a" }),
      new AbortController().signal,
      async () => {
        activityCount += 1;
        if (activityCount === 1) throw new Error("presentation persistence failed");
      },
    );

    await expect(acknowledgement).rejects.toThrow("presentation persistence failed");
    expect(sendCancel).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "session.clientTool.cancel",
        reason: "host-failed",
      }),
    );
    expect(result.toolResult.outcome).toBe("failed");
    expect(result.uiEvent.presentation.subject).toBe("local_picker");
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
