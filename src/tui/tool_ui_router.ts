import type { ToolUiEvent } from "../core/tools/registry.js";
import type { ChatContainerComponent } from "./ui/chat_container.js";

type RunningBashComponent = {
  command: string;
};

type RunningSubagentTool =
  | {
      kind: "spawn_agent";
      name: string;
      title: string;
    }
  | {
      kind: "send_input_to_agent";
      agentId: string;
      name: string;
      title: string;
    }
  | {
      kind: "wait_for_agent";
      agentIds: string[];
    }
  | {
      kind: "terminate_agent";
      agentId: string;
    };

export class ToolUiRouter {
  private readonly chatContainer: ChatContainerComponent;
  private readonly requestRender: () => void;

  private runningBashComponents: Map<string, RunningBashComponent> = new Map();
  private runningSubagentTools: Map<string, RunningSubagentTool> = new Map();

  constructor(options: { chatContainer: ChatContainerComponent; requestRender: () => void }) {
    this.chatContainer = options.chatContainer;
    this.requestRender = options.requestRender;
  }

  resetSession(): void {
    this.runningBashComponents.clear();
    this.runningSubagentTools.clear();
  }

  clearTransientState(): void {
    this.runningBashComponents.clear();
    this.runningSubagentTools.clear();
  }

  finalizePending(reason: "aborted" | "interrupted"): void {
    for (const [id, running] of this.runningBashComponents.entries()) {
      const event: ToolUiEvent = {
        type: "bash_aborted",
        toolCallId: id,
        command: running.command,
        reason,
      };
      this.chatContainer.replaceMessage(id, { type: "tool", event });
    }

    for (const [id, running] of this.runningSubagentTools.entries()) {
      const event = this.toSubagentAbortEvent(id, running, reason);
      this.chatContainer.replaceMessage(id, { type: "tool", event });
    }

    this.requestRender();
  }

  handle(uiEvent: ToolUiEvent): void {
    if (uiEvent.type === "bash_started") {
      this.chatContainer.addMessage({ type: "tool", event: uiEvent }, uiEvent.toolCallId);
      this.runningBashComponents.set(uiEvent.toolCallId, { command: uiEvent.command });
      this.requestRender();
      return;
    }

    if (uiEvent.type === "bash_execution") {
      const running = this.runningBashComponents.get(uiEvent.toolCallId);
      this.chatContainer.replaceMessage(uiEvent.toolCallId, { type: "tool", event: uiEvent });
      if (running) {
        this.runningBashComponents.delete(uiEvent.toolCallId);
      }
      this.requestRender();
      return;
    }

    if (uiEvent.type === "bash_aborted") {
      this.chatContainer.replaceMessage(uiEvent.toolCallId, { type: "tool", event: uiEvent });
      this.runningBashComponents.delete(uiEvent.toolCallId);
      this.requestRender();
      return;
    }

    if (uiEvent.type === "bash_blocked") {
      if (uiEvent.toolCallId) {
        const running = this.runningBashComponents.get(uiEvent.toolCallId);
        this.chatContainer.replaceMessage(uiEvent.toolCallId, { type: "tool", event: uiEvent });
        if (running) {
          this.runningBashComponents.delete(uiEvent.toolCallId);
        }
      } else {
        this.chatContainer.addMessage({ type: "tool", event: uiEvent });
      }
      this.requestRender();
      return;
    }

    if (uiEvent.type === "spawn_agent_started") {
      this.chatContainer.addMessage({ type: "tool", event: uiEvent }, uiEvent.toolCallId);
      this.runningSubagentTools.set(uiEvent.toolCallId, {
        kind: "spawn_agent",
        name: uiEvent.name,
        title: uiEvent.title,
      });
      this.requestRender();
      return;
    }

    if (uiEvent.type === "spawn_agent_finished") {
      this.chatContainer.replaceMessage(uiEvent.toolCallId, { type: "tool", event: uiEvent });
      this.runningSubagentTools.delete(uiEvent.toolCallId);
      this.requestRender();
      return;
    }

    if (uiEvent.type === "spawn_agent_blocked") {
      if (this.runningSubagentTools.has(uiEvent.toolCallId)) {
        this.chatContainer.replaceMessage(uiEvent.toolCallId, { type: "tool", event: uiEvent });
      } else {
        this.chatContainer.addMessage({ type: "tool", event: uiEvent }, uiEvent.toolCallId);
      }
      this.runningSubagentTools.delete(uiEvent.toolCallId);
      this.requestRender();
      return;
    }

    if (uiEvent.type === "send_input_to_agent_started") {
      this.chatContainer.addMessage({ type: "tool", event: uiEvent }, uiEvent.toolCallId);
      this.runningSubagentTools.set(uiEvent.toolCallId, {
        kind: "send_input_to_agent",
        agentId: uiEvent.agentId,
        name: uiEvent.name,
        title: uiEvent.title,
      });
      this.requestRender();
      return;
    }

    if (uiEvent.type === "send_input_to_agent_finished") {
      this.chatContainer.replaceMessage(uiEvent.toolCallId, { type: "tool", event: uiEvent });
      this.runningSubagentTools.delete(uiEvent.toolCallId);
      this.requestRender();
      return;
    }

    if (uiEvent.type === "send_input_to_agent_blocked") {
      if (this.runningSubagentTools.has(uiEvent.toolCallId)) {
        this.chatContainer.replaceMessage(uiEvent.toolCallId, { type: "tool", event: uiEvent });
      } else {
        this.chatContainer.addMessage({ type: "tool", event: uiEvent }, uiEvent.toolCallId);
      }
      this.runningSubagentTools.delete(uiEvent.toolCallId);
      this.requestRender();
      return;
    }

    if (uiEvent.type === "wait_for_agent_started") {
      this.chatContainer.addMessage({ type: "tool", event: uiEvent }, uiEvent.toolCallId);
      this.runningSubagentTools.set(uiEvent.toolCallId, {
        kind: "wait_for_agent",
        agentIds: uiEvent.agentIds,
      });
      this.requestRender();
      return;
    }

    if (uiEvent.type === "wait_for_agent_finished") {
      this.chatContainer.replaceMessage(uiEvent.toolCallId, { type: "tool", event: uiEvent });
      this.runningSubagentTools.delete(uiEvent.toolCallId);
      this.requestRender();
      return;
    }

    if (uiEvent.type === "wait_for_agent_blocked") {
      if (this.runningSubagentTools.has(uiEvent.toolCallId)) {
        this.chatContainer.replaceMessage(uiEvent.toolCallId, { type: "tool", event: uiEvent });
      } else {
        this.chatContainer.addMessage({ type: "tool", event: uiEvent }, uiEvent.toolCallId);
      }
      this.runningSubagentTools.delete(uiEvent.toolCallId);
      this.requestRender();
      return;
    }

    if (uiEvent.type === "terminate_agent_started") {
      this.chatContainer.addMessage({ type: "tool", event: uiEvent }, uiEvent.toolCallId);
      this.runningSubagentTools.set(uiEvent.toolCallId, {
        kind: "terminate_agent",
        agentId: uiEvent.agentId,
      });
      this.requestRender();
      return;
    }

    if (uiEvent.type === "terminate_agent_finished") {
      this.chatContainer.replaceMessage(uiEvent.toolCallId, { type: "tool", event: uiEvent });
      this.runningSubagentTools.delete(uiEvent.toolCallId);
      this.requestRender();
      return;
    }

    if (uiEvent.type === "terminate_agent_blocked") {
      if (this.runningSubagentTools.has(uiEvent.toolCallId)) {
        this.chatContainer.replaceMessage(uiEvent.toolCallId, { type: "tool", event: uiEvent });
      } else {
        this.chatContainer.addMessage({ type: "tool", event: uiEvent }, uiEvent.toolCallId);
      }
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
      this.chatContainer.addMessage({ type: "tool", event: uiEvent });
      this.requestRender();
      return;
    }

    if (uiEvent.type === "grep_started") {
      this.chatContainer.addMessage({ type: "tool", event: uiEvent }, uiEvent.toolCallId);
      this.requestRender();
      return;
    }

    if (uiEvent.type === "grep_finished") {
      this.chatContainer.replaceMessage(uiEvent.toolCallId, { type: "tool", event: uiEvent });
      this.requestRender();
      return;
    }

    if (uiEvent.type === "grep_blocked") {
      this.chatContainer.addMessage({ type: "tool", event: uiEvent }, uiEvent.toolCallId);
      this.requestRender();
      return;
    }

    if (uiEvent.type === "web_search_started" || uiEvent.type === "web_fetch_started") {
      this.chatContainer.addMessage({ type: "tool", event: uiEvent }, uiEvent.toolCallId);
      this.requestRender();
      return;
    }

    if (uiEvent.type === "web_search_finished" || uiEvent.type === "web_fetch_finished") {
      this.chatContainer.replaceMessage(uiEvent.toolCallId, { type: "tool", event: uiEvent });
      this.requestRender();
    }
  }

  private toSubagentAbortEvent(
    toolCallId: string,
    running: RunningSubagentTool,
    reason: "aborted" | "interrupted",
  ): ToolUiEvent {
    if (running.kind === "spawn_agent") {
      return {
        type: "spawn_agent_finished",
        toolCallId,
        name: running.name,
        title: running.title,
        status: "error",
        message: reason,
      };
    }

    if (running.kind === "send_input_to_agent") {
      return {
        type: "send_input_to_agent_finished",
        toolCallId,
        agentId: running.agentId,
        name: running.name,
        title: running.title,
        status: "error",
        message: reason,
      };
    }

    if (running.kind === "wait_for_agent") {
      return {
        type: "wait_for_agent_finished",
        toolCallId,
        agentIds: running.agentIds,
        status: "error",
        message: reason,
      };
    }

    return {
      type: "terminate_agent_finished",
      toolCallId,
      agentId: running.agentId,
      status: "error",
      message: reason,
    };
  }
}
