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

describe("ClientToolBroker", () => {
  it("returns full client tool results with a truncated final UI event", async () => {
    const broker = new ClientToolBroker();
    const longLine = "x".repeat(200);
    const content = ["one", longLine, "three", "four", "five", "six", "seven", "eight"].join("\n");
    const sendCancel = vi.fn();
    broker.registerClient({
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

    const definition = broker.getToolDefinitions("session-1")[0];
    const result = await definition.dispatch(
      createToolCall({ choice: "a" }),
      "read-only",
      new AbortController().signal,
      {},
    );

    expect(result.kind).toBe("single");
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
});
