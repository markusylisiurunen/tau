import type { ToolUiEvent, ToolUiLine, ToolUiText } from "../core/tools/registry.js";
import {
  TOOL_NAME_SEND_INPUT_TO_AGENT,
  TOOL_NAME_SPAWN_AGENT,
  TOOL_NAME_TERMINATE_AGENT,
  TOOL_NAME_WAIT_FOR_AGENT,
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
      kind: typeof TOOL_NAME_WAIT_FOR_AGENT;
      agentIds: string[];
    }
  | {
      kind: typeof TOOL_NAME_TERMINATE_AGENT;
      agentId: string;
    };

type ToolUiEventWithToolCallId = Extract<ToolUiEvent, { toolCallId: string }>;
type ToolPrunedEvent = Extract<ToolUiEvent, { type: "tool_pruned" }>;

const PRUNED_STATUS_PREFIX = "✂ pruned";

export class ToolUiRouter {
  private readonly chatContainer: ChatContainerComponent;
  private readonly requestRender: () => void;

  private runningBashComponents: Map<string, RunningBashComponent> = new Map();
  private runningSubagentTools: Map<string, RunningSubagentTool> = new Map();
  private latestToolEventsById: Map<string, ToolUiEventWithToolCallId> = new Map();

  constructor(options: { chatContainer: ChatContainerComponent; requestRender: () => void }) {
    this.chatContainer = options.chatContainer;
    this.requestRender = options.requestRender;
  }

  resetSession(): void {
    this.runningBashComponents.clear();
    this.runningSubagentTools.clear();
    this.latestToolEventsById.clear();
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

  handle(uiEvent: ToolUiEvent): void {
    if (uiEvent.type === "tool_pruned") {
      const updated = this.applyPrunedMutation(uiEvent);
      if (updated) {
        this.requestRender();
      }
      return;
    }

    if (uiEvent.type === "bash_started") {
      this.upsertToolMessage(uiEvent);
      this.runningBashComponents.set(uiEvent.toolCallId, { command: uiEvent.command });
      this.requestRender();
      return;
    }

    if (uiEvent.type === "bash_execution") {
      this.upsertToolMessage(uiEvent);
      this.runningBashComponents.delete(uiEvent.toolCallId);
      this.requestRender();
      return;
    }

    if (uiEvent.type === "bash_aborted") {
      this.upsertToolMessage(uiEvent);
      this.runningBashComponents.delete(uiEvent.toolCallId);
      this.requestRender();
      return;
    }

    if (uiEvent.type === "bash_blocked") {
      this.upsertToolMessage(uiEvent);
      this.runningBashComponents.delete(uiEvent.toolCallId);
      this.requestRender();
      return;
    }

    if (uiEvent.type === "spawn_agent_started") {
      this.upsertToolMessage(uiEvent);
      this.runningSubagentTools.set(uiEvent.toolCallId, {
        kind: TOOL_NAME_SPAWN_AGENT,
        name: uiEvent.name,
        title: uiEvent.headerTarget ?? uiEvent.title,
      });
      this.requestRender();
      return;
    }

    if (uiEvent.type === "spawn_agent_finished") {
      this.upsertToolMessage(uiEvent);
      this.runningSubagentTools.delete(uiEvent.toolCallId);
      this.requestRender();
      return;
    }

    if (uiEvent.type === "spawn_agent_blocked") {
      this.upsertToolMessage(uiEvent);
      this.runningSubagentTools.delete(uiEvent.toolCallId);
      this.requestRender();
      return;
    }

    if (uiEvent.type === "send_input_to_agent_started") {
      this.upsertToolMessage(uiEvent);
      this.runningSubagentTools.set(uiEvent.toolCallId, {
        kind: TOOL_NAME_SEND_INPUT_TO_AGENT,
        agentId: uiEvent.agentId,
        name: uiEvent.name,
        title: uiEvent.headerTarget ?? uiEvent.title,
      });
      this.requestRender();
      return;
    }

    if (uiEvent.type === "send_input_to_agent_finished") {
      this.upsertToolMessage(uiEvent);
      this.runningSubagentTools.delete(uiEvent.toolCallId);
      this.requestRender();
      return;
    }

    if (uiEvent.type === "send_input_to_agent_blocked") {
      this.upsertToolMessage(uiEvent);
      this.runningSubagentTools.delete(uiEvent.toolCallId);
      this.requestRender();
      return;
    }

    if (uiEvent.type === "wait_for_agent_started") {
      this.upsertToolMessage(uiEvent);
      this.runningSubagentTools.set(uiEvent.toolCallId, {
        kind: TOOL_NAME_WAIT_FOR_AGENT,
        agentIds: uiEvent.agentIds,
      });
      this.requestRender();
      return;
    }

    if (uiEvent.type === "wait_for_agent_finished") {
      this.upsertToolMessage(uiEvent);
      this.runningSubagentTools.delete(uiEvent.toolCallId);
      this.requestRender();
      return;
    }

    if (uiEvent.type === "wait_for_agent_blocked") {
      this.upsertToolMessage(uiEvent);
      this.runningSubagentTools.delete(uiEvent.toolCallId);
      this.requestRender();
      return;
    }

    if (uiEvent.type === "terminate_agent_started") {
      this.upsertToolMessage(uiEvent);
      this.runningSubagentTools.set(uiEvent.toolCallId, {
        kind: TOOL_NAME_TERMINATE_AGENT,
        agentId: uiEvent.agentId,
      });
      this.requestRender();
      return;
    }

    if (uiEvent.type === "terminate_agent_finished") {
      this.upsertToolMessage(uiEvent);
      this.runningSubagentTools.delete(uiEvent.toolCallId);
      this.requestRender();
      return;
    }

    if (uiEvent.type === "terminate_agent_blocked") {
      this.upsertToolMessage(uiEvent);
      this.runningSubagentTools.delete(uiEvent.toolCallId);
      this.requestRender();
      return;
    }

    if (
      uiEvent.type === "write_success" ||
      uiEvent.type === "write_blocked" ||
      uiEvent.type === "edit_success" ||
      uiEvent.type === "edit_blocked" ||
      uiEvent.type === "read_success" ||
      uiEvent.type === "read_blocked" ||
      uiEvent.type === "view_image_success" ||
      uiEvent.type === "view_image_blocked" ||
      uiEvent.type === "list_success" ||
      uiEvent.type === "list_blocked"
    ) {
      this.upsertToolMessage(uiEvent);
      this.requestRender();
      return;
    }

    if (uiEvent.type === "grep_started") {
      this.upsertToolMessage(uiEvent);
      this.requestRender();
      return;
    }

    if (uiEvent.type === "grep_finished") {
      this.upsertToolMessage(uiEvent);
      this.requestRender();
      return;
    }

    if (uiEvent.type === "grep_blocked") {
      this.upsertToolMessage(uiEvent);
      this.requestRender();
      return;
    }

    if (uiEvent.type === "web_search_started" || uiEvent.type === "web_fetch_started") {
      this.upsertToolMessage(uiEvent);
      this.requestRender();
      return;
    }

    if (uiEvent.type === "web_search_finished" || uiEvent.type === "web_fetch_finished") {
      this.upsertToolMessage(uiEvent);
      this.requestRender();
    }
  }

  private upsertToolMessage(uiEvent: ToolUiEventWithToolCallId): void {
    if (this.replaceToolMessage(uiEvent)) {
      return;
    }

    this.chatContainer.addMessage({ type: "tool", event: uiEvent }, uiEvent.toolCallId);
    this.latestToolEventsById.set(uiEvent.toolCallId, uiEvent);
  }

  private replaceToolMessage(uiEvent: ToolUiEventWithToolCallId): boolean {
    const replaced = this.chatContainer.replaceMessage(uiEvent.toolCallId, {
      type: "tool",
      event: uiEvent,
    });
    if (!replaced) {
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

    if (!("uiText" in existing) || !existing.uiText) {
      return false;
    }

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

    if (running.kind === TOOL_NAME_WAIT_FOR_AGENT) {
      const headerTarget = running.agentIds.length > 0 ? running.agentIds.join(", ") : "(no ids)";
      return {
        type: "wait_for_agent_finished",
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
