import type { ToolUiEvent } from "../core/tools/registry.js";
import type { ChatContainerComponent } from "./ui/chat_container.js";
import type { Theme } from "./ui/theme/index.js";
import { createToolUiRegistry, type ToolUiRegistry } from "./ui/tool_ui_registry.js";

type RunningBashComponent = {
  command: string;
};

type RunningTaskComponent = {
  kind: "task" | "fork";
  name?: string;
  title: string;
  costTotal: number;
  turns: number;
  toolCalls: number;
  events: string[];
};

export class ToolUiRouter {
  private readonly theme: Theme;
  private readonly chatContainer: ChatContainerComponent;
  private readonly requestRender: () => void;
  private readonly onCostUpdated?: () => void;
  private readonly registry: ToolUiRegistry;

  private runningBashComponents: Map<string, RunningBashComponent> = new Map();
  private runningTaskComponents: Map<string, RunningTaskComponent> = new Map();
  private subagentCostTotal = 0;

  constructor(options: {
    theme: Theme;
    chatContainer: ChatContainerComponent;
    requestRender: () => void;
    onCostUpdated?: () => void;
    registry?: ToolUiRegistry;
  }) {
    this.theme = options.theme;
    this.chatContainer = options.chatContainer;
    this.requestRender = options.requestRender;
    this.onCostUpdated = options.onCostUpdated;
    this.registry = options.registry ?? createToolUiRegistry();
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
      this.chatContainer.replaceMessage(id, {
        type: "tool",
        view: this.registry.renderBashAborted(running.command, reason, { theme: this.theme }),
      });
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
      const view = this.registry.render(event, { theme: this.theme });
      if (view) {
        this.chatContainer.replaceMessage(id, { type: "tool", view });
      }
    }

    this.requestRender();
  }

  handle(uiEvent: ToolUiEvent): void {
    const render = (event: ToolUiEvent, context?: { taskState?: RunningTaskComponent }) =>
      this.registry.render(event, {
        theme: this.theme,
        taskState: context?.taskState && {
          events: context.taskState.events,
          costTotal: context.taskState.costTotal,
          turns: context.taskState.turns,
          toolCalls: context.taskState.toolCalls,
          kind: context.taskState.kind,
          name: context.taskState.name,
        },
      });

    if (uiEvent.type === "bash_started") {
      const view = render(uiEvent);
      if (!view) return;
      this.chatContainer.addMessage({ type: "tool", view }, uiEvent.toolCallId);
      this.runningBashComponents.set(uiEvent.toolCallId, { command: uiEvent.command });
      this.requestRender();
      return;
    }

    if (uiEvent.type === "bash_execution") {
      const running = this.runningBashComponents.get(uiEvent.toolCallId);
      const view = render(uiEvent);
      if (view) {
        this.chatContainer.replaceMessage(uiEvent.toolCallId, { type: "tool", view });
      }
      if (running) {
        this.runningBashComponents.delete(uiEvent.toolCallId);
      }
      this.requestRender();
      return;
    }

    if (uiEvent.type === "bash_blocked") {
      const view = render(uiEvent);
      if (!view) return;
      if (uiEvent.toolCallId) {
        const running = this.runningBashComponents.get(uiEvent.toolCallId);
        this.chatContainer.replaceMessage(uiEvent.toolCallId, { type: "tool", view });
        if (running) {
          this.runningBashComponents.delete(uiEvent.toolCallId);
        }
      } else {
        this.chatContainer.addMessage({ type: "tool", view });
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
      const view = render(uiEvent, { taskState: state });
      if (view) {
        this.chatContainer.addMessage({ type: "tool", view }, uiEvent.toolCallId);
      }
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

      const view = render(uiEvent, { taskState: state });
      if (view) {
        this.chatContainer.replaceMessage(uiEvent.toolCallId, { type: "tool", view });
      }
      this.requestRender();
      return;
    }

    if (uiEvent.type === "task_finished") {
      const view = render(uiEvent);
      if (view) {
        this.chatContainer.replaceMessage(uiEvent.toolCallId, { type: "tool", view });
      }

      this.runningTaskComponents.delete(uiEvent.toolCallId);
      this.subagentCostTotal += uiEvent.costTotal;
      this.onCostUpdated?.();
      this.requestRender();
      return;
    }

    if (uiEvent.type === "task_blocked") {
      const running = this.runningTaskComponents.get(uiEvent.toolCallId);
      const view = render(uiEvent, { taskState: running });
      if (view) {
        if (running) {
          this.chatContainer.replaceMessage(uiEvent.toolCallId, { type: "tool", view });
        } else {
          this.chatContainer.addMessage({ type: "tool", view }, uiEvent.toolCallId);
        }
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
      const view = render(uiEvent);
      if (view) {
        this.chatContainer.addMessage({ type: "tool", view });
        this.requestRender();
      }
      return;
    }

    if (uiEvent.type === "grep_started") {
      const view = render(uiEvent);
      if (view) {
        this.chatContainer.addMessage({ type: "tool", view }, uiEvent.toolCallId);
        this.requestRender();
      }
      return;
    }

    if (uiEvent.type === "grep_finished") {
      const view = render(uiEvent);
      if (view) {
        this.chatContainer.replaceMessage(uiEvent.toolCallId, { type: "tool", view });
        this.requestRender();
      }
      return;
    }

    if (uiEvent.type === "grep_blocked") {
      const view = render(uiEvent);
      if (view) {
        this.chatContainer.addMessage({ type: "tool", view }, uiEvent.toolCallId);
        this.requestRender();
      }
      return;
    }

    if (uiEvent.type === "web_search_started" || uiEvent.type === "web_fetch_started") {
      const view = render(uiEvent);
      if (view) {
        this.chatContainer.addMessage({ type: "tool", view }, uiEvent.toolCallId);
        this.requestRender();
      }
      return;
    }

    if (uiEvent.type === "web_search_finished" || uiEvent.type === "web_fetch_finished") {
      const view = render(uiEvent);
      if (view) {
        this.chatContainer.replaceMessage(uiEvent.toolCallId, { type: "tool", view });
        this.requestRender();
      }
    }
  }
}
