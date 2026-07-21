import { randomUUID } from "node:crypto";
import type { Tool, ToolCall, ToolResultMessage } from "@earendil-works/pi-ai";
import type {
  ToolDefinition,
  ToolDispatch,
  ToolDispatchContext,
  ToolUiEvent,
  ToolUiText,
} from "../core/tools/registry.js";
import { createToolDispatch } from "../core/tools/registry.js";
import { createToolError, createToolResult } from "../core/utils/messages.js";
import { formatTokenEstimate } from "../core/utils/token.js";
import { buildHeadTailPreviewLines } from "../core/utils/tool_preview.js";
import { formatBytes } from "../core/utils/truncate.js";
import type {
  SessionProtocolClientToolCallMessage,
  SessionProtocolClientToolCancelMessage,
  SessionProtocolClientToolDefinition,
} from "../protocol/session_protocol.js";
import { SESSION_PROTOCOL_VERSION } from "../protocol/session_protocol.js";

const DEFAULT_ACK_TIMEOUT_MS = 5_000;
const DEFAULT_EXECUTION_TIMEOUT_MS = 60_000;
const CLIENT_TOOL_UI_HEAD_LINES = 3;
const CLIENT_TOOL_UI_TAIL_LINES = 3;
const CLIENT_TOOL_UI_MAX_LINE_CHARS = 160;
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

type ClientToolClient = {
  id: string;
  tools: Map<string, SessionProtocolClientToolDefinition>;
  sessionIds: Set<string>;
  sendCall: ClientToolDispatch;
  sendCancel: ClientToolCancelDispatch;
};

type PendingClientToolCall = {
  sessionId: string;
  clientId: string;
  toolCall: ToolCall;
  ackTimer: NodeJS.Timeout;
  executionTimer: NodeJS.Timeout;
  signal: AbortSignal;
  abortListener: () => void;
  settled: boolean;
  resolve: (message: ToolResultMessage) => void;
};

export class ClientToolBroker {
  private readonly clients = new Map<string, ClientToolClient>();
  private readonly pendingCalls = new Map<string, PendingClientToolCall>();

  registerClient(options: {
    tools: SessionProtocolClientToolDefinition[];
    sendCall: ClientToolDispatch;
    sendCancel: ClientToolCancelDispatch;
  }): {
    clientId: string;
    attachSession: (sessionId: string) => void;
    detachSession: (sessionId: string) => void;
    unregister: () => void;
  } {
    const names = new Set<string>();
    for (const tool of options.tools) {
      if (names.has(tool.name)) {
        throw new Error(`duplicate client tool '${tool.name}'`);
      }
      if (HOST_TOOL_NAMES.has(tool.name)) {
        throw new Error(`client tool '${tool.name}' duplicates a host tool`);
      }
      names.add(tool.name);
    }

    const clientId = randomUUID();
    const client: ClientToolClient = {
      id: clientId,
      tools: new Map(options.tools.map((tool) => [tool.name, tool])),
      sessionIds: new Set(),
      sendCall: options.sendCall,
      sendCancel: options.sendCancel,
    };
    this.clients.set(clientId, client);
    return {
      clientId,
      attachSession: (sessionId) => this.attachClientToSession(clientId, sessionId),
      detachSession: (sessionId) => this.detachClientFromSession(clientId, sessionId),
      unregister: () => this.unregisterClient(clientId),
    };
  }

  getToolDefinitions(sessionId: string): ToolDefinition[] {
    return [...this.clients.values()].flatMap((client) =>
      client.sessionIds.has(sessionId)
        ? [...client.tools.values()].map((tool) =>
            createClientToolDefinition(sessionId, client.id, tool, this),
          )
        : [],
    );
  }

  ack(sessionId: string, callId: string): boolean {
    const pending = this.pendingCalls.get(callId);
    if (!pending || pending.sessionId !== sessionId || pending.settled) {
      return false;
    }

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
    if (!client?.tools.has(options.tool.name) || !client.sessionIds.has(options.sessionId)) {
      return Promise.resolve(
        createToolError(
          options.toolCall,
          `Client tool '${options.tool.name}' is unavailable because its owning client detached.`,
        ),
      );
    }

    const callId = randomUUID();
    return new Promise((resolve) => {
      const executionTimeoutMs = options.tool.executionTimeoutMs ?? DEFAULT_EXECUTION_TIMEOUT_MS;
      const pending: PendingClientToolCall = {
        sessionId: options.sessionId,
        clientId: options.clientId,
        toolCall: options.toolCall,
        ackTimer: setTimeout(() => {
          this.fail(
            callId,
            `Client tool '${options.tool.name}' is unavailable because its owning client did not acknowledge the tool call within ${DEFAULT_ACK_TIMEOUT_MS}ms.`,
          );
        }, DEFAULT_ACK_TIMEOUT_MS),
        executionTimer: setTimeout(() => {
          this.fail(
            callId,
            `Client tool '${options.tool.name}' timed out after ${executionTimeoutMs}ms.`,
          );
        }, executionTimeoutMs),
        signal: options.signal,
        abortListener: () => this.abort(callId),
        settled: false,
        resolve,
      };
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
        executionDeadlineMs: executionTimeoutMs,
      });
    });
  }

  private attachClientToSession(clientId: string, sessionId: string): void {
    const client = this.clients.get(clientId);
    if (!client) {
      return;
    }

    for (const existing of this.clients.values()) {
      if (existing.id === clientId || !existing.sessionIds.has(sessionId)) {
        continue;
      }
      for (const toolName of client.tools.keys()) {
        if (existing.tools.has(toolName)) {
          throw new Error(`client tool '${toolName}' is already advertised for this session`);
        }
      }
    }

    client.sessionIds.add(sessionId);
  }

  private detachClientFromSession(clientId: string, sessionId: string): void {
    const client = this.clients.get(clientId);
    if (!client?.sessionIds.delete(sessionId)) {
      return;
    }

    for (const [callId, pending] of [...this.pendingCalls]) {
      if (pending.clientId === clientId && pending.sessionId === sessionId) {
        this.fail(
          callId,
          `Client tool '${pending.toolCall.name}' stopped because its owning client detached.`,
          "client-detached",
        );
      }
    }
  }

  private unregisterClient(clientId: string): void {
    if (!this.clients.delete(clientId)) {
      return;
    }

    for (const [callId, pending] of [...this.pendingCalls]) {
      if (pending.clientId === clientId) {
        this.fail(
          callId,
          `Client tool '${pending.toolCall.name}' stopped because its owning client detached.`,
          "client-detached",
        );
      }
    }
  }

  private abort(callId: string): void {
    const pending = this.pendingCalls.get(callId);
    const toolName = pending?.toolCall.name ?? "unknown";
    this.fail(
      callId,
      `Client tool '${toolName}' was cancelled because the assistant turn was interrupted.`,
      "aborted",
    );
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
    clearTimeout(pending.executionTimer);
    pending.signal.removeEventListener("abort", pending.abortListener);
    this.pendingCalls.delete(callId);
    pending.resolve(result);
  }
}

function createClientToolFinishedUiEvent(toolResult: ToolResultMessage): ToolUiEvent {
  return {
    type: "client_tool_finished",
    toolCallId: toolResult.toolCallId,
    toolName: toolResult.toolName,
    headerTarget: toolResult.toolName,
    status: toolResult.isError ? "error" : "success",
    uiText: createClientToolUiText(extractToolResultText(toolResult), toolResult.isError),
  };
}

function createClientToolUiText(content: string, isError: boolean): ToolUiText {
  const trimmed = content.trimEnd();
  const lineCount = trimmed ? trimmed.split("\n").length : 0;
  const contentBytes = Buffer.byteLength(trimmed, "utf8");
  const previewLines = buildHeadTailPreviewLines(trimmed || (isError ? "failed" : "ok"), {
    headLines: CLIENT_TOOL_UI_HEAD_LINES,
    tailLines: CLIENT_TOOL_UI_TAIL_LINES,
    maxLineChars: CLIENT_TOOL_UI_MAX_LINE_CHARS,
  }).map((text) => ({ text }));
  const statusLine = [
    isError ? "error" : "success",
    formatLineCount(lineCount),
    contentBytes > 0 ? formatTokenEstimate(contentBytes) : undefined,
    contentBytes > 0 ? formatBytes(contentBytes) : undefined,
  ]
    .filter(Boolean)
    .join(" · ");

  return {
    previewLines,
    statusLine,
    fullLines: previewLines,
  };
}

function extractToolResultText(toolResult: ToolResultMessage): string {
  return toolResult.content
    .filter(
      (part): part is Extract<(typeof toolResult.content)[number], { type: "text" }> =>
        part.type === "text",
    )
    .map((part) => part.text)
    .join("\n");
}

function formatLineCount(lineCount: number): string | undefined {
  if (lineCount <= 0) {
    return undefined;
  }
  return `${lineCount} ${lineCount === 1 ? "line" : "lines"}`;
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
    getDisplayTarget: () => tool.name,
    async dispatch(
      toolCall: ToolCall,
      signal: AbortSignal,
      _context: ToolDispatchContext,
    ): Promise<ToolDispatch> {
      return createToolDispatch(async () => {
        const toolResult = await broker.dispatch({ sessionId, clientId, tool, toolCall, signal });
        return { toolResult, uiEvent: createClientToolFinishedUiEvent(toolResult) };
      });
    },
  };
}
