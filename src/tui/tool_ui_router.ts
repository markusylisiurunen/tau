import type { ToolUiEvent } from "../core/tools/registry.js";
import type { ChatContainerComponent } from "./ui/chat_container.js";
import type { ToolUiTaskState } from "./ui/tool_ui_registry.js";

type RunningBashComponent = {
  command: string;
};

type RunningTaskComponent = {
  kind: "task";
  name?: string;
  title: string;
  costTotal: number;
  turns: number;
  toolCalls: number;
  events: string[];
};

export class ToolUiRouter {
  private readonly chatContainer: ChatContainerComponent;
  private readonly requestRender: () => void;
  private readonly onCostUpdated?: () => void;

  private runningBashComponents: Map<string, RunningBashComponent> = new Map();
  private runningTaskComponents: Map<string, RunningTaskComponent> = new Map();
  private subagentCostTotal = 0;

  constructor(options: {
    chatContainer: ChatContainerComponent;
    requestRender: () => void;
    onCostUpdated?: () => void;
  }) {
    this.chatContainer = options.chatContainer;
    this.requestRender = options.requestRender;
    this.onCostUpdated = options.onCostUpdated;
  }

  getSubagentCostTotal(): number {
    return this.subagentCostTotal;
  }

  resetSession(): void {
    this.runningBashComponents.clear();
    this.runningTaskComponents.clear();
    this.subagentCostTotal = 0;
  }

  clearTransientState(): void {
    this.runningBashComponents.clear();
    this.runningTaskComponents.clear();
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

    const taskStatus = reason === "aborted" ? "aborted" : "error";
    for (const [id, running] of this.runningTaskComponents.entries()) {
      const event: ToolUiEvent = {
        type: "task_finished",
        toolCallId: id,
        kind: running.kind,
        name: running.name ?? "",
        title: running.title,
        costTotal: running.costTotal,
        turns: running.turns,
        toolCalls: running.toolCalls,
        status: taskStatus,
        finalOutput: reason,
      };
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

    if (uiEvent.type === "task_started") {
      const kind = uiEvent.kind ?? "task";
      const subagentName = uiEvent.name.trim() || undefined;
      const state: RunningTaskComponent = {
        kind,
        name: subagentName,
        title: uiEvent.title,
        costTotal: 0,
        turns: 0,
        toolCalls: 0,
        events: [],
      };
      this.chatContainer.addMessage(
        { type: "tool", event: uiEvent, taskState: this.toTaskState(state) },
        uiEvent.toolCallId,
      );
      this.runningTaskComponents.set(uiEvent.toolCallId, state);
      this.requestRender();
      return;
    }

    if (uiEvent.type === "task_progress") {
      const running = this.runningTaskComponents.get(uiEvent.toolCallId);
      const kind = uiEvent.kind ?? running?.kind ?? "task";
      const subagentName = uiEvent.name.trim() || undefined;

      const state: RunningTaskComponent = running ?? {
        kind,
        name: subagentName,
        title: uiEvent.title,
        costTotal: uiEvent.costTotal,
        turns: uiEvent.turns,
        toolCalls: uiEvent.toolCalls,
        events: [],
      };

      state.events.push(uiEvent.event);
      state.kind = kind;
      state.name = subagentName;
      state.title = uiEvent.title;
      state.costTotal = uiEvent.costTotal;
      state.turns = uiEvent.turns;
      state.toolCalls = uiEvent.toolCalls;

      this.runningTaskComponents.set(uiEvent.toolCallId, state);

      this.chatContainer.replaceMessage(uiEvent.toolCallId, {
        type: "tool",
        event: uiEvent,
        taskState: this.toTaskState(state),
      });
      this.requestRender();
      return;
    }

    if (uiEvent.type === "task_finished") {
      this.chatContainer.replaceMessage(uiEvent.toolCallId, { type: "tool", event: uiEvent });
      this.runningTaskComponents.delete(uiEvent.toolCallId);
      this.subagentCostTotal += uiEvent.costTotal;
      this.onCostUpdated?.();
      this.requestRender();
      return;
    }

    if (uiEvent.type === "task_blocked") {
      const running = this.runningTaskComponents.get(uiEvent.toolCallId);
      if (running) {
        this.chatContainer.replaceMessage(uiEvent.toolCallId, { type: "tool", event: uiEvent });
      } else {
        this.chatContainer.addMessage({ type: "tool", event: uiEvent }, uiEvent.toolCallId);
      }
      this.runningTaskComponents.delete(uiEvent.toolCallId);
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

  private toTaskState(state: RunningTaskComponent): ToolUiTaskState {
    return {
      events: state.events,
      costTotal: state.costTotal,
      turns: state.turns,
      toolCalls: state.toolCalls,
      kind: state.kind,
      name: state.name,
    };
  }
}
