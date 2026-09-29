import { createInterface } from "node:readline";
import { createProtocolImage } from "../helpers/session_protocol_fixtures.js";

let calls = 0;
let cancelled = 0;
let catalogVersion = 0;
const pending = new Map();
const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const reply = (id, result) => send({ jsonrpc: "2.0", id, result });
const tools = () => [
  {
    name: "echo",
    description: "Echo a message",
    inputSchema: {
      type: "object",
      properties: { message: { type: "string" } },
      required: ["message"],
      additionalProperties: false,
    },
    outputSchema: { type: "object" },
    annotations: { readOnlyHint: true },
  },
  ...["fail", "slow", "refresh", "exit", "screenshot", ...(catalogVersion ? ["added"] : [])].map(
    (name) => ({
      name,
      inputSchema: { type: "object", properties: {}, additionalProperties: false },
    }),
  ),
];

const input = createInterface({ input: process.stdin });
input.on("line", (line) => {
  const request = JSON.parse(line);
  if (request.method === "initialize") {
    if (process.env.MCP_TEST_NO_INITIALIZE === "1") return;
    reply(request.id, {
      protocolVersion: request.params.protocolVersion,
      capabilities: { tools: { listChanged: true } },
      serverInfo: { name: "test", version: "1" },
      instructions: "Test service usage guidance",
    });
  } else if (request.method === "tools/list") {
    reply(request.id, { tools: tools() });
  } else if (request.method === "tools/call") {
    calls++;
    const { name, arguments: args } = request.params;
    if (name === "exit") {
      process.exit(0);
    } else if (name === "slow") {
      pending.set(
        request.id,
        setTimeout(() => reply(request.id, { content: [] }), 60_000),
      );
    } else if (name === "refresh") {
      catalogVersion++;
      send({ jsonrpc: "2.0", method: "notifications/tools/list_changed" });
      reply(request.id, { content: [] });
    } else if (name === "screenshot") {
      reply(request.id, { content: [createProtocolImage({ annotations: { title: "screen" } })] });
    } else if (name === "fail") {
      reply(request.id, {
        content: [{ type: "text", text: "service rejected the operation" }],
        isError: true,
      });
    } else {
      reply(request.id, {
        content: [{ type: "text", text: "raw service response" }],
        structuredContent: {
          message: args.message,
          calls,
          cancelled,
          pending: pending.size,
          cwd: process.cwd(),
          pid: process.pid,
          authenticated: process.env.MCP_TEST_SECRET === "test-secret",
        },
        _meta: { private: "not for the agent" },
      });
    }
  } else if (request.method === "notifications/cancelled") {
    cancelled++;
    clearTimeout(pending.get(request.params.requestId));
    pending.delete(request.params.requestId);
  }
});
input.on("close", () => {
  for (const timer of pending.values()) clearTimeout(timer);
});
