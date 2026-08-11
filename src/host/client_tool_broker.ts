import { randomUUID } from "node:crypto";
import type { Tool, ToolCall } from "@earendil-works/pi-ai";
import type { ToolActivity } from "../core/tools/activity.js";
import {
  buildToolRunPresentation,
  formatToolDurationMs,
  parseToolRunPresentation,
  type ToolRunPresentation,
} from "../core/tools/presentation.js";
import {
  type AgentTool,
  createTextToolOutcome,
  executeTool,
  type ToolExecutionContext,
  type ToolExecutionOutcome,
} from "../core/tools/registry.js";
import { HOST_TOOL_NAMES } from "../core/tools/tool_names.js";
import { formatTokenEstimate } from "../core/utils/token.js";
import type {
  SessionProtocolClientToolCallMessage,
  SessionProtocolClientToolCancelMessage,
  SessionProtocolClientToolDefinition,
} from "../protocol/session_protocol.js";
import { SESSION_PROTOCOL_VERSION } from "../protocol/session_protocol.js";

const DEFAULT_ACK_TIMEOUT_MS = 5_000;
const DEFAULT_EXECUTION_TIMEOUT_MS = 60_000;
const HOST_TOOL_NAME_SET = new Set<string>(HOST_TOOL_NAMES);

export type ClientToolExecutionOutcome = (message: SessionProtocolClientToolCallMessage) => void;
export type ClientToolCancelDispatch = (message: SessionProtocolClientToolCancelMessage) => void;

type ClientToolClient = {
  id: string;
  tools: Map<string, SessionProtocolClientToolDefinition>;
  sessionIds: Set<string>;
  sendCall: ClientToolExecutionOutcome;
  sendCancel: ClientToolCancelDispatch;
};

type ClientToolDispatchResult = {
  outcome: ToolExecutionOutcome;
  presentation: ToolRunPresentation;
};

type PendingClientToolCall = {
  sessionId: string;
  clientId: string;
  toolCall: ToolCall;
  ackTimer: NodeJS.Timeout;
  executionTimer: NodeJS.Timeout;
  signal: AbortSignal;
  abortListener: () => void;
  emitActivity: ToolExecutionContext["emitActivity"];
  presentation: ToolRunPresentation;
  acknowledged: boolean;
  settled: boolean;
  resolve: (result: ClientToolDispatchResult) => void;
};

export class ClientToolBroker {
  private readonly clients = new Map<string, ClientToolClient>();
  private readonly pendingCalls = new Map<string, PendingClientToolCall>();

  registerClient(options: {
    tools: SessionProtocolClientToolDefinition[];
    sendCall: ClientToolExecutionOutcome;
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
      if (HOST_TOOL_NAME_SET.has(tool.name)) {
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

  getToolDefinitions(sessionId: string): AgentTool[] {
    return [...this.clients.values()].flatMap((client) =>
      client.sessionIds.has(sessionId)
        ? [...client.tools.values()].map((tool) =>
            createClientToolDefinition(sessionId, client.id, tool, this),
          )
        : [],
    );
  }

  async ack(
    sessionId: string,
    callId: string,
    presentation: ToolRunPresentation,
  ): Promise<boolean> {
    const pending = this.pendingCalls.get(callId);
    if (!pending || pending.sessionId !== sessionId || pending.acknowledged || pending.settled) {
      return false;
    }

    const parsedPresentation = parseToolRunPresentation(presentation);
    clearTimeout(pending.ackTimer);
    pending.acknowledged = true;
    try {
      await pending.emitActivity({
        type: "tool_call_started",
        toolCallId: pending.toolCall.id,
        toolName: pending.toolCall.name,
        presentation: parsedPresentation,
      });
      if (pending.settled || this.pendingCalls.get(callId) !== pending) {
        return false;
      }
      pending.presentation = parsedPresentation;
      return true;
    } catch (error) {
      this.complete(
        callId,
        createTextToolOutcome(error instanceof Error ? error.message : String(error), "failed"),
      );
      throw error;
    }
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
      this.complete(callId, createTextToolOutcome(result.content, "succeeded"));
    } else {
      this.complete(callId, createTextToolOutcome(result.error, "failed"));
    }
    return true;
  }

  dispatch(options: {
    sessionId: string;
    agentId: string;
    clientId: string;
    tool: SessionProtocolClientToolDefinition;
    toolCall: ToolCall;
    signal: AbortSignal;
    emitActivity: ToolExecutionContext["emitActivity"];
  }): Promise<ClientToolDispatchResult> {
    const client = this.clients.get(options.clientId);
    if (!client?.tools.has(options.tool.name) || !client.sessionIds.has(options.sessionId)) {
      return Promise.resolve({
        outcome: createTextToolOutcome(
          `Client tool '${options.tool.name}' is unavailable because its owning client detached.`,
          "blocked",
        ),
        presentation: buildToolRunPresentation({
          toolName: options.tool.name,
          subject: options.tool.name,
        }),
      });
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
            "timeout",
            "blocked",
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
        emitActivity: options.emitActivity,
        presentation: buildToolRunPresentation({
          toolName: options.tool.name,
          subject: options.tool.name,
        }),
        acknowledged: false,
        settled: false,
        resolve,
      };
      options.signal.addEventListener("abort", pending.abortListener, { once: true });
      this.pendingCalls.set(callId, pending);

      client.sendCall({
        version: SESSION_PROTOCOL_VERSION,
        type: "session.clientTool.call",
        sessionId: options.sessionId,
        agentId: options.agentId,
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
    outcome: ToolExecutionOutcome["outcome"] = "cancelled",
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
    this.complete(callId, createTextToolOutcome(message, outcome));
  }

  private complete(callId: string, result: ToolExecutionOutcome): void {
    const pending = this.pendingCalls.get(callId);
    if (!pending || pending.settled) {
      return;
    }

    pending.settled = true;
    clearTimeout(pending.ackTimer);
    clearTimeout(pending.executionTimer);
    pending.signal.removeEventListener("abort", pending.abortListener);
    this.pendingCalls.delete(callId);
    pending.resolve({ outcome: result, presentation: pending.presentation });
  }
}

function createClientToolFinishedUiEvent(
  toolCall: ToolCall,
  outcome: ToolExecutionOutcome,
  presentation: ToolRunPresentation,
  durationMs: number,
): ToolActivity {
  const isError = outcome.outcome !== "succeeded";
  return {
    type: "tool_call_finished",
    toolCallId: toolCall.id,
    toolName: toolCall.name,
    presentation: createClientToolPresentation(
      toolCall.name,
      presentation,
      extractToolOutcomeText(outcome),
      durationMs,
    ),
    status: isError ? "error" : "success",
  };
}

function createClientToolPresentation(
  toolName: string,
  presentation: ToolRunPresentation,
  content: string,
  durationMs: number,
) {
  const trimmed = content.trimEnd();
  const lineCount = trimmed ? trimmed.split("\n").length : 0;
  const contentBytes = Buffer.byteLength(trimmed, "utf8");
  const details = trimmed
    ? trimmed
        .replace(/\r\n?/g, "\n")
        .split("\n")
        .map((text) => ({ text }))
    : [];
  const outcomePresentation = buildToolRunPresentation({
    toolName,
    subject: presentation.subject,
    details,
    metadata: [
      formatToolDurationMs(durationMs),
      contentBytes > 0 ? formatTokenEstimate(contentBytes) : undefined,
      formatLineCount(lineCount),
    ].filter((part): part is string => part !== undefined),
  });
  return parseToolRunPresentation({
    ...presentation,
    details: outcomePresentation.details,
    metadata: outcomePresentation.metadata,
  });
}

function extractToolOutcomeText(outcome: ToolExecutionOutcome): string {
  return outcome.content
    .filter(
      (part): part is Extract<(typeof outcome.content)[number], { type: "text" }> =>
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
): AgentTool {
  const schema: Tool = {
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters as Tool["parameters"],
  };

  return {
    schema,
    describe: () => ({
      presentation: buildToolRunPresentation({ toolName: tool.name, subject: tool.name }),
    }),
    async execute(
      toolCall: ToolCall,
      context: ToolExecutionContext,
    ): Promise<ToolExecutionOutcome> {
      const { signal } = context;
      return executeTool(context, async () => {
        const startedAt = Date.now();
        const toolResult = await broker.dispatch({
          sessionId,
          agentId: context.agentId,
          clientId,
          tool,
          toolCall,
          signal,
          emitActivity: context.emitActivity,
        });
        const durationMs = Math.max(0, Date.now() - startedAt);
        return {
          content: toolResult.outcome.content,
          outcome: toolResult.outcome.outcome,
          uiEvent: createClientToolFinishedUiEvent(
            toolCall,
            toolResult.outcome,
            toolResult.presentation,
            durationMs,
          ),
        };
      });
    },
  };
}
