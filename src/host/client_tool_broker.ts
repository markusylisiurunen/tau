import { randomUUID } from "node:crypto";
import type { Tool, ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import type {
  ToolDefinition,
  ToolDispatchContext,
  ToolDispatchResult,
} from "../core/tools/registry.js";
import type { RiskLevel } from "../core/types.js";
import { createToolError, createToolResult } from "../core/utils/messages.js";
import type {
  SessionProtocolClientToolCallMessage,
  SessionProtocolClientToolCancelMessage,
  SessionProtocolClientToolDefinition,
} from "../protocol/session_protocol.js";
import { SESSION_PROTOCOL_VERSION } from "../protocol/session_protocol.js";

const DEFAULT_ACK_TIMEOUT_MS = 5_000;
const DEFAULT_EXECUTION_TIMEOUT_MS = 60_000;
const HOST_TOOL_NAMES = new Set([
  "bash",
  "write",
  "edit",
  "view_image",
  "spawn_agent",
  "send_input_to_agent",
  "wait_for_agents",
  "terminate_agent",
]);

export type ClientToolDispatch = (message: SessionProtocolClientToolCallMessage) => void;
export type ClientToolCancelDispatch = (message: SessionProtocolClientToolCancelMessage) => void;

export type RegisteredClientTool = SessionProtocolClientToolDefinition & {
  clientId: string;
};

type ClientToolClient = {
  id: string;
  tools: Map<string, SessionProtocolClientToolDefinition>;
  sendCall: ClientToolDispatch;
  sendCancel: ClientToolCancelDispatch;
};

type PendingClientToolCall = {
  sessionId: string;
  clientId: string;
  toolCall: ToolCall;
  ackTimer: NodeJS.Timeout;
  executionTimer?: NodeJS.Timeout;
  signal: AbortSignal;
  abortListener: () => void;
  settled: boolean;
  acknowledged: boolean;
  resolve: (message: ToolResultMessage) => void;
};

export class ClientToolBroker {
  private readonly clients = new Map<string, ClientToolClient>();
  private readonly pendingCalls = new Map<string, PendingClientToolCall>();

  registerClient(options: {
    tools: SessionProtocolClientToolDefinition[];
    sendCall: ClientToolDispatch;
    sendCancel: ClientToolCancelDispatch;
  }): { clientId: string; unregister: () => void } {
    const names = new Set<string>();
    for (const tool of options.tools) {
      if (names.has(tool.name)) {
        throw new Error(`duplicate client tool '${tool.name}'`);
      }
      if (HOST_TOOL_NAMES.has(tool.name)) {
        throw new Error(`client tool '${tool.name}' duplicates a host tool`);
      }
      if (this.findTool(tool.name)) {
        throw new Error(`client tool '${tool.name}' is already advertised by another client`);
      }
      names.add(tool.name);
    }

    const clientId = randomUUID();
    const client: ClientToolClient = {
      id: clientId,
      tools: new Map(options.tools.map((tool) => [tool.name, tool])),
      sendCall: options.sendCall,
      sendCancel: options.sendCancel,
    };
    this.clients.set(clientId, client);
    return {
      clientId,
      unregister: () => this.unregisterClient(clientId),
    };
  }

  getToolDefinitions(sessionId: string): ToolDefinition[] {
    return [...this.clients.values()].flatMap((client) =>
      [...client.tools.values()].map((tool) =>
        createClientToolDefinition(sessionId, client.id, tool, this),
      ),
    );
  }

  ack(sessionId: string, callId: string): boolean {
    const pending = this.pendingCalls.get(callId);
    if (!pending || pending.sessionId !== sessionId || pending.settled) {
      return false;
    }

    pending.acknowledged = true;
    clearTimeout(pending.ackTimer);
    return true;
  }

  result(
    sessionId: string,
    callId: string,
    result: { ok: true; content: string } | { ok: false; error: string },
  ): boolean {
    const pending = this.pendingCalls.get(callId);
    if (!pending || pending.sessionId !== sessionId || pending.settled) {
      return false;
    }

    if (result.ok) {
      this.complete(callId, createToolResult(pending.toolCall, result.content, false));
    } else {
      this.complete(callId, createToolError(pending.toolCall, result.error));
    }
    return true;
  }

  dispatch(options: {
    sessionId: string;
    clientId: string;
    tool: SessionProtocolClientToolDefinition;
    toolCall: ToolCall;
    signal: AbortSignal;
  }): Promise<ToolResultMessage> {
    const client = this.clients.get(options.clientId);
    if (!client?.tools.has(options.tool.name)) {
      return Promise.resolve(
        createToolError(
          options.toolCall,
          `client tool '${options.tool.name}' is unavailable because the owning client detached`,
        ),
      );
    }

    const callId = randomUUID();
    return new Promise((resolve) => {
      const pending: PendingClientToolCall = {
        sessionId: options.sessionId,
        clientId: options.clientId,
        toolCall: options.toolCall,
        ackTimer: setTimeout(() => {
          this.fail(callId, "client tool unavailable: client did not acknowledge the tool call");
        }, DEFAULT_ACK_TIMEOUT_MS),
        signal: options.signal,
        abortListener: () => this.abort(callId),
        settled: false,
        acknowledged: false,
        resolve,
      };
      pending.executionTimer = setTimeout(() => {
        this.fail(callId, `client tool '${options.tool.name}' timed out`);
      }, options.tool.executionTimeoutMs ?? DEFAULT_EXECUTION_TIMEOUT_MS);
      options.signal.addEventListener("abort", pending.abortListener, { once: true });
      this.pendingCalls.set(callId, pending);

      client.sendCall({
        version: SESSION_PROTOCOL_VERSION,
        type: "session.clientTool.call",
        sessionId: options.sessionId,
        callId,
        toolName: options.tool.name,
        arguments: options.toolCall.arguments,
        ackDeadlineMs: DEFAULT_ACK_TIMEOUT_MS,
        executionDeadlineMs: options.tool.executionTimeoutMs ?? DEFAULT_EXECUTION_TIMEOUT_MS,
      });
    });
  }

  private unregisterClient(clientId: string): void {
    if (!this.clients.delete(clientId)) {
      return;
    }

    for (const [callId, pending] of [...this.pendingCalls]) {
      if (pending.clientId === clientId) {
        this.fail(callId, "client tool unavailable: the owning client detached", "client-detached");
      }
    }
  }

  private findTool(name: string): RegisteredClientTool | undefined {
    for (const client of this.clients.values()) {
      const tool = client.tools.get(name);
      if (tool) {
        return { ...tool, clientId: client.id };
      }
    }
    return undefined;
  }

  private abort(callId: string): void {
    this.fail(callId, "client tool call was aborted", "aborted");
  }

  private fail(
    callId: string,
    message: string,
    reason: SessionProtocolClientToolCancelMessage["reason"] = "timeout",
  ): void {
    const pending = this.pendingCalls.get(callId);
    if (!pending || pending.settled) {
      return;
    }

    const client = this.clients.get(pending.clientId);
    client?.sendCancel({
      version: SESSION_PROTOCOL_VERSION,
      type: "session.clientTool.cancel",
      sessionId: pending.sessionId,
      callId,
      reason,
    });
    this.complete(callId, createToolError(pending.toolCall, message));
  }

  private complete(callId: string, result: ToolResultMessage): void {
    const pending = this.pendingCalls.get(callId);
    if (!pending || pending.settled) {
      return;
    }

    pending.settled = true;
    clearTimeout(pending.ackTimer);
    if (pending.executionTimer) {
      clearTimeout(pending.executionTimer);
    }
    pending.signal.removeEventListener("abort", pending.abortListener);
    this.pendingCalls.delete(callId);
    pending.resolve(result);
  }
}

function createClientToolDefinition(
  sessionId: string,
  clientId: string,
  tool: SessionProtocolClientToolDefinition,
  broker: ClientToolBroker,
): ToolDefinition {
  const schema: Tool = {
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters as Tool["parameters"],
  };

  return {
    schema,
    async dispatch(
      toolCall: ToolCall,
      _riskLevel: RiskLevel,
      signal: AbortSignal,
      _context: ToolDispatchContext,
    ): Promise<ToolDispatchResult> {
      const toolResult = await broker.dispatch({ sessionId, clientId, tool, toolCall, signal });
      return { kind: "single", toolResult };
    },
  };
}
