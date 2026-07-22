import type { ToolUiEvent, ToolUiLine, ToolUiText } from "../core/tools/registry.js";
import {
  TOOL_NAME_SEND_INPUT_TO_AGENT,
  TOOL_NAME_SPAWN_AGENT,
  TOOL_NAME_TERMINATE_AGENT,
  TOOL_NAME_WAIT_FOR_AGENTS,
} from "../core/tools/tool_names.js";
import type { ChatContainerComponent } from "./ui/chat_container.js";

type RunningBashComponent = {
  command: string;
};

type RunningSubagentTool =
  | {
      kind: typeof TOOL_NAME_SPAWN_AGENT;
      name: string;
      title: string;
    }
  | {
      kind: typeof TOOL_NAME_SEND_INPUT_TO_AGENT;
      agentId: string;
      name: string;
      title: string;
    }
  | {
      kind: typeof TOOL_NAME_WAIT_FOR_AGENTS;
      agentIds: string[];
    }
  | {
      kind: typeof TOOL_NAME_TERMINATE_AGENT;
      agentId: string;
    };

type ToolUiEventWithToolCallId = Extract<ToolUiEvent, { toolCallId: string }>;
type ToolPrunedEvent = Extract<ToolUiEvent, { type: "tool_pruned" }>;
type NonPrunedToolUiEvent = Exclude<ToolUiEventWithToolCallId, ToolPrunedEvent>;

export type ToolUiEventOrigin = "session" | "local";

type ToolUiEventType = ToolUiEvent["type"];
type BashTerminalEventType = "bash_execution" | "bash_aborted" | "bash_blocked";
type SubagentTerminalEventType =
  | "spawn_agent_finished"
  | "spawn_agent_blocked"
  | "send_input_to_agent_finished"
  | "send_input_to_agent_blocked"
  | "wait_for_agents_finished"
  | "wait_for_agents_blocked"
  | "terminate_agent_finished"
  | "terminate_agent_blocked";

const BASH_TERMINAL_EVENT_TYPES = new Set<BashTerminalEventType>([
  "bash_execution",
  "bash_aborted",
  "bash_blocked",
]);

const SUBAGENT_TERMINAL_EVENT_TYPES = new Set<SubagentTerminalEventType>([
  "spawn_agent_finished",
  "spawn_agent_blocked",
  "send_input_to_agent_finished",
  "send_input_to_agent_blocked",
  "wait_for_agents_finished",
  "wait_for_agents_blocked",
  "terminate_agent_finished",
  "terminate_agent_blocked",
]);

const PRUNED_STATUS_PREFIX = "✂ pruned";

export class ToolUiRouter {
  private readonly chatContainer: ChatContainerComponent;
  private readonly requestRender: () => void;

  private runningBashComponents: Map<string, RunningBashComponent> = new Map();
  private runningSubagentTools: Map<string, RunningSubagentTool> = new Map();
  private latestToolEventsById: Map<string, ToolUiEventWithToolCallId> = new Map();
  private sessionToolCallIds: Set<string> = new Set();

  constructor(options: { chatContainer: ChatContainerComponent; requestRender: () => void }) {
    this.chatContainer = options.chatContainer;
    this.requestRender = options.requestRender;
  }

  resetSession(): void {
    this.runningBashComponents.clear();
    this.runningSubagentTools.clear();
    this.latestToolEventsById.clear();
    this.sessionToolCallIds.clear();
  }

  reconcileSession(toolCallIds: readonly string[]): void {
    const currentIds = new Set(toolCallIds);
    const staleIds = [...this.sessionToolCallIds].filter((id) => !currentIds.has(id));
    for (const id of this.sessionToolCallIds) {
      this.runningBashComponents.delete(id);
      this.runningSubagentTools.delete(id);
      this.latestToolEventsById.delete(id);
    }
    this.sessionToolCallIds.clear();

    if (staleIds.length > 0) {
      this.chatContainer.removeMessages(staleIds);
      this.requestRender();
    }
  }

  clearTransientState(): void {
    this.runningBashComponents.clear();
    this.runningSubagentTools.clear();
  }

  finalizePending(reason: "aborted" | "interrupted"): void {
    for (const [id, running] of this.runningBashComponents.entries()) {
      const headerTarget = running.command.split(/\r?\n/)[0] ?? running.command;
      const event: ToolUiEventWithToolCallId = {
        type: "bash_aborted",
        toolCallId: id,
        command: running.command,
        headerTarget,
        reason,
      };
      this.replaceToolMessage(event);
    }

    for (const [id, running] of this.runningSubagentTools.entries()) {
      const event = this.toSubagentAbortEvent(id, running, reason);
      this.replaceToolMessage(event);
    }

    this.requestRender();
  }

  handle(uiEvent: ToolUiEvent, origin: ToolUiEventOrigin): void {
    if (uiEvent.type === "tool_pruned") {
      const updated = this.applyPrunedMutation(uiEvent);
      if (updated) {
        this.requestRender();
      }
      return;
    }

    if (origin === "session") {
      this.sessionToolCallIds.add(uiEvent.toolCallId);
    }
    this.upsertToolMessage(uiEvent);
    this.updateRunningToolState(uiEvent);
    this.requestRender();
  }

  private updateRunningToolState(uiEvent: NonPrunedToolUiEvent): void {
    const bashComponent = this.toRunningBashComponent(uiEvent);
    if (bashComponent) {
      this.runningBashComponents.set(uiEvent.toolCallId, bashComponent);
      return;
    }

    if (this.isBashTerminalType(uiEvent.type)) {
      this.runningBashComponents.delete(uiEvent.toolCallId);
      return;
    }

    const subagentTool = this.toRunningSubagentTool(uiEvent);
    if (subagentTool) {
      this.runningSubagentTools.set(uiEvent.toolCallId, subagentTool);
      return;
    }

    if (this.isSubagentTerminalType(uiEvent.type)) {
      this.runningSubagentTools.delete(uiEvent.toolCallId);
    }
  }

  private toRunningBashComponent(uiEvent: NonPrunedToolUiEvent): RunningBashComponent | null {
    if (uiEvent.type !== "bash_started") {
      return null;
    }

    return { command: uiEvent.command };
  }

  private toRunningSubagentTool(uiEvent: NonPrunedToolUiEvent): RunningSubagentTool | null {
    if (uiEvent.type === "spawn_agent_started") {
      return {
        kind: TOOL_NAME_SPAWN_AGENT,
        name: uiEvent.name,
        title: uiEvent.headerTarget ?? uiEvent.title,
      };
    }

    if (uiEvent.type === "send_input_to_agent_started") {
      return {
        kind: TOOL_NAME_SEND_INPUT_TO_AGENT,
        agentId: uiEvent.agentId,
        name: uiEvent.name,
        title: uiEvent.headerTarget ?? uiEvent.title,
      };
    }

    if (uiEvent.type === "wait_for_agents_started") {
      return {
        kind: TOOL_NAME_WAIT_FOR_AGENTS,
        agentIds: uiEvent.agentIds,
      };
    }

    if (uiEvent.type === "terminate_agent_started") {
      return {
        kind: TOOL_NAME_TERMINATE_AGENT,
        agentId: uiEvent.agentId,
      };
    }

    return null;
  }

  private isBashTerminalType(type: ToolUiEventType): type is BashTerminalEventType {
    return BASH_TERMINAL_EVENT_TYPES.has(type as BashTerminalEventType);
  }

  private isSubagentTerminalType(type: ToolUiEventType): type is SubagentTerminalEventType {
    return SUBAGENT_TERMINAL_EVENT_TYPES.has(type as SubagentTerminalEventType);
  }

  private upsertToolMessage(uiEvent: ToolUiEventWithToolCallId): void {
    if (this.replaceToolMessage(uiEvent)) {
      return;
    }

    this.chatContainer.addMessage({ type: "tool", event: uiEvent }, uiEvent.toolCallId);
    this.latestToolEventsById.set(uiEvent.toolCallId, uiEvent);
  }

  private replaceToolMessage(uiEvent: ToolUiEventWithToolCallId): boolean {
    const updated = this.chatContainer.updateMessage(uiEvent.toolCallId, {
      type: "tool",
      event: uiEvent,
    });
    if (!updated) {
      this.latestToolEventsById.delete(uiEvent.toolCallId);
      return false;
    }

    this.latestToolEventsById.set(uiEvent.toolCallId, uiEvent);
    return true;
  }

  private applyPrunedMutation(uiEvent: ToolPrunedEvent): boolean {
    const existing = this.latestToolEventsById.get(uiEvent.toolCallId);
    if (!existing) {
      return false;
    }

    if ("uiText" in existing && existing.uiText) {
      const statusLine = existing.uiText.statusLine?.trim();
      const nextStatusLine = statusLine
        ? `${PRUNED_STATUS_PREFIX} · ${statusLine}`
        : PRUNED_STATUS_PREFIX;
      const nextLines = this.toToolUiLines(uiEvent.content);
      const nextUiText: ToolUiText = {
        previewLines: nextLines,
        statusLine: nextStatusLine,
        fullLines: nextLines,
      };

      const nextEvent = { ...existing, uiText: nextUiText } as ToolUiEventWithToolCallId;
      return this.replaceToolMessage(nextEvent);
    }

    if ("reason" in existing && typeof existing.reason === "string") {
      return this.replaceToolMessage({
        ...existing,
        reason: uiEvent.content,
      } as ToolUiEventWithToolCallId);
    }

    if ("message" in existing) {
      return this.replaceToolMessage({
        ...existing,
        message: uiEvent.content,
      } as ToolUiEventWithToolCallId);
    }

    return false;
  }

  private toToolUiLines(content: string): ToolUiLine[] {
    if (!content) {
      return [];
    }

    return content.split("\n").map((text) => ({ text }));
  }

  private toSubagentAbortEvent(
    toolCallId: string,
    running: RunningSubagentTool,
    reason: "aborted" | "interrupted",
  ): ToolUiEventWithToolCallId {
    if (running.kind === TOOL_NAME_SPAWN_AGENT) {
      return {
        type: "spawn_agent_finished",
        toolCallId,
        name: running.name,
        title: running.title,
        headerTarget: running.title,
        status: "error",
        message: reason,
      };
    }

    if (running.kind === TOOL_NAME_SEND_INPUT_TO_AGENT) {
      return {
        type: "send_input_to_agent_finished",
        toolCallId,
        agentId: running.agentId,
        name: running.name,
        title: running.title,
        headerTarget: running.title,
        status: "error",
        message: reason,
      };
    }

    if (running.kind === TOOL_NAME_WAIT_FOR_AGENTS) {
      const headerTarget = running.agentIds.length > 0 ? running.agentIds.join(", ") : "(no ids)";
      return {
        type: "wait_for_agents_finished",
        toolCallId,
        agentIds: running.agentIds,
        headerTarget,
        status: "error",
        message: reason,
      };
    }

    return {
      type: "terminate_agent_finished",
      toolCallId,
      agentId: running.agentId,
      headerTarget: running.agentId,
      status: "error",
      message: reason,
    };
  }
}
