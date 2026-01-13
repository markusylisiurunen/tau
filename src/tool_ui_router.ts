import type { ToolUiEvent } from "./tools/registry.js";
import {
  buildBashAbortedView,
  buildBashBlockedView,
  buildBashExecutionView,
  buildBashRunningView,
} from "./ui/bash_execution.js";
import type { ChatContainerComponent } from "./ui/chat_container.js";
import {
  buildEditBlockedView,
  buildEditSuccessView,
  buildWriteBlockedView,
  buildWriteSuccessView,
} from "./ui/file_execution.js";
import {
  buildGrepBlockedView,
  buildGrepFinishedView,
  buildGrepRunningView,
  buildListBlockedView,
  buildListSuccessView,
  buildReadBlockedView,
  buildReadSuccessView,
} from "./ui/restricted_execution.js";
import {
  buildTaskBlockedView,
  buildTaskFinishedView,
  buildTaskRunningView,
} from "./ui/task_execution.js";
import type { Theme } from "./ui/theme.js";

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
};

export class ToolUiRouter {
  private readonly theme: Theme;
  private readonly chatContainer: ChatContainerComponent;
  private readonly requestRender: () => void;
  private readonly onCostUpdated?: () => void;

  private runningBashComponents: Map<string, RunningBashComponent> = new Map();
  private runningTaskComponents: Map<string, RunningTaskComponent> = new Map();
  private taskEvents: Map<string, string[]> = new Map();
  private subagentCostTotal = 0;

  constructor(options: {
    theme: Theme;
    chatContainer: ChatContainerComponent;
    requestRender: () => void;
    onCostUpdated?: () => void;
  }) {
    this.theme = options.theme;
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
    this.taskEvents.clear();
    this.subagentCostTotal = 0;
  }

  clearTransientState(): void {
    this.runningBashComponents.clear();
    this.runningTaskComponents.clear();
    this.taskEvents.clear();
  }

  finalizePending(reason: "aborted" | "interrupted"): void {
    for (const [id, running] of this.runningBashComponents.entries()) {
      this.chatContainer.replaceMessage(id, {
        type: "tool",
        view: buildBashAbortedView(this.theme, running.command, reason),
      });
    }

    const taskStatus = reason === "aborted" ? "aborted" : "error";
    for (const [id, running] of this.runningTaskComponents.entries()) {
      this.chatContainer.replaceMessage(id, {
        type: "tool",
        view: buildTaskFinishedView(
          this.theme,
          running.title,
          running.costTotal,
          running.turns,
          running.toolCalls,
          taskStatus,
          reason,
          { kind: running.kind, subagentName: running.name },
        ),
      });
    }

    this.requestRender();
  }

  handle(uiEvent: ToolUiEvent): void {
    if (uiEvent.type === "bash_started") {
      this.chatContainer.addMessage(
        {
          type: "tool",
          view: buildBashRunningView(this.theme, uiEvent.command),
        },
        uiEvent.toolCallId,
      );
      this.runningBashComponents.set(uiEvent.toolCallId, {
        command: uiEvent.command,
      });
      this.requestRender();
      return;
    }

    if (uiEvent.type === "bash_execution") {
      const running = this.runningBashComponents.get(uiEvent.toolCallId);
      this.chatContainer.replaceMessage(uiEvent.toolCallId, {
        type: "tool",
        view: buildBashExecutionView(
          this.theme,
          uiEvent.command,
          uiEvent.exitCode,
          uiEvent.truncationInfo,
          uiEvent.durationMs,
        ),
      });
      if (running) {
        this.runningBashComponents.delete(uiEvent.toolCallId);
      }
      this.requestRender();
      return;
    }

    if (uiEvent.type === "bash_blocked") {
      if (uiEvent.toolCallId) {
        const running = this.runningBashComponents.get(uiEvent.toolCallId);
        this.chatContainer.replaceMessage(uiEvent.toolCallId, {
          type: "tool",
          view: buildBashBlockedView(this.theme, uiEvent.command, uiEvent.reason),
        });
        if (running) {
          this.runningBashComponents.delete(uiEvent.toolCallId);
        }
      } else {
        this.chatContainer.addMessage({
          type: "tool",
          view: buildBashBlockedView(this.theme, uiEvent.command, uiEvent.reason),
        });
      }
      this.requestRender();
      return;
    }

    if (uiEvent.type === "task_started") {
      if (!this.taskEvents.has(uiEvent.toolCallId)) {
        this.taskEvents.set(uiEvent.toolCallId, []);
      }
      const kind = uiEvent.kind ?? "task";
      const subagentName = uiEvent.name.trim() || undefined;

      this.chatContainer.addMessage(
        {
          type: "tool",
          view: buildTaskRunningView(this.theme, uiEvent.title, [], 0, 0, 0, {
            kind,
            subagentName,
          }),
        },
        uiEvent.toolCallId,
      );
      this.runningTaskComponents.set(uiEvent.toolCallId, {
        kind,
        name: subagentName,
        title: uiEvent.title,
        costTotal: 0,
        turns: 0,
        toolCalls: 0,
      });
      this.requestRender();
      return;
    }

    if (uiEvent.type === "task_progress") {
      let events = this.taskEvents.get(uiEvent.toolCallId);
      if (!events) {
        events = [];
        this.taskEvents.set(uiEvent.toolCallId, events);
      }
      events.push(uiEvent.event);

      const running = this.runningTaskComponents.get(uiEvent.toolCallId);
      const kind = uiEvent.kind ?? running?.kind ?? "task";
      const subagentName = uiEvent.name.trim() || undefined;

      if (running) {
        running.kind = kind;
        running.name = subagentName;
        running.title = uiEvent.title;
        running.costTotal = uiEvent.costTotal;
        running.turns = uiEvent.turns;
        running.toolCalls = uiEvent.toolCalls;
      }

      this.chatContainer.replaceMessage(uiEvent.toolCallId, {
        type: "tool",
        view: buildTaskRunningView(
          this.theme,
          uiEvent.title,
          events,
          uiEvent.costTotal,
          uiEvent.turns,
          uiEvent.toolCalls,
          { kind, subagentName },
        ),
      });
      this.requestRender();
      return;
    }

    if (uiEvent.type === "task_finished") {
      const running = this.runningTaskComponents.get(uiEvent.toolCallId);
      const kind = uiEvent.kind ?? running?.kind ?? "task";
      const subagentName = uiEvent.name.trim() || undefined;

      this.chatContainer.replaceMessage(uiEvent.toolCallId, {
        type: "tool",
        view: buildTaskFinishedView(
          this.theme,
          uiEvent.title,
          uiEvent.costTotal,
          uiEvent.turns,
          uiEvent.toolCalls,
          uiEvent.status,
          uiEvent.finalOutput,
          { kind, subagentName },
        ),
      });

      this.runningTaskComponents.delete(uiEvent.toolCallId);
      this.taskEvents.delete(uiEvent.toolCallId);
      this.subagentCostTotal += uiEvent.costTotal;
      this.onCostUpdated?.();
      this.requestRender();
      return;
    }

    if (uiEvent.type === "task_blocked") {
      const running = this.runningTaskComponents.get(uiEvent.toolCallId);
      const kind = uiEvent.kind ?? running?.kind ?? "task";
      const subagentName = uiEvent.name?.trim() || undefined;

      if (running) {
        this.chatContainer.replaceMessage(uiEvent.toolCallId, {
          type: "tool",
          view: buildTaskBlockedView(this.theme, uiEvent.title, uiEvent.reason, {
            kind,
            subagentName,
          }),
        });
      } else {
        this.chatContainer.addMessage(
          {
            type: "tool",
            view: buildTaskBlockedView(this.theme, uiEvent.title, uiEvent.reason, {
              kind,
              subagentName,
            }),
          },
          uiEvent.toolCallId,
        );
      }

      this.runningTaskComponents.delete(uiEvent.toolCallId);
      this.taskEvents.delete(uiEvent.toolCallId);
      this.requestRender();
      return;
    }

    if (uiEvent.type === "write_success") {
      this.chatContainer.addMessage({
        type: "tool",
        view: buildWriteSuccessView(
          this.theme,
          uiEvent.path,
          uiEvent.bytes,
          uiEvent.lines,
          uiEvent.content,
        ),
      });
      this.requestRender();
      return;
    }

    if (uiEvent.type === "write_blocked") {
      this.chatContainer.addMessage({
        type: "tool",
        view: buildWriteBlockedView(this.theme, uiEvent.path, uiEvent.reason),
      });
      this.requestRender();
      return;
    }

    if (uiEvent.type === "edit_success") {
      this.chatContainer.addMessage({
        type: "tool",
        view: buildEditSuccessView(
          this.theme,
          uiEvent.path,
          uiEvent.oldLength,
          uiEvent.newLength,
          uiEvent.oldText,
          uiEvent.newText,
        ),
      });
      this.requestRender();
      return;
    }

    if (uiEvent.type === "edit_blocked") {
      this.chatContainer.addMessage({
        type: "tool",
        view: buildEditBlockedView(this.theme, uiEvent.path, uiEvent.reason),
      });
      this.requestRender();
      return;
    }

    if (uiEvent.type === "read_success") {
      this.chatContainer.addMessage({
        type: "tool",
        view: buildReadSuccessView(
          this.theme,
          uiEvent.path,
          uiEvent.startLine,
          uiEvent.endLine,
          uiEvent.content,
          uiEvent.modelTruncation,
        ),
      });
      this.requestRender();
      return;
    }

    if (uiEvent.type === "read_blocked") {
      this.chatContainer.addMessage({
        type: "tool",
        view: buildReadBlockedView(this.theme, uiEvent.path, uiEvent.reason),
      });
      this.requestRender();
      return;
    }

    if (uiEvent.type === "list_success") {
      this.chatContainer.addMessage({
        type: "tool",
        view: buildListSuccessView(
          this.theme,
          uiEvent.path,
          uiEvent.offset,
          uiEvent.limit,
          uiEvent.total,
          uiEvent.returned,
          uiEvent.entries,
        ),
      });
      this.requestRender();
      return;
    }

    if (uiEvent.type === "list_blocked") {
      this.chatContainer.addMessage({
        type: "tool",
        view: buildListBlockedView(this.theme, uiEvent.path, uiEvent.reason),
      });
      this.requestRender();
      return;
    }

    if (uiEvent.type === "grep_started") {
      this.chatContainer.addMessage(
        {
          type: "tool",
          view: buildGrepRunningView(this.theme, uiEvent.pattern),
        },
        uiEvent.toolCallId,
      );
      this.requestRender();
      return;
    }

    if (uiEvent.type === "grep_finished") {
      this.chatContainer.replaceMessage(uiEvent.toolCallId, {
        type: "tool",
        view: buildGrepFinishedView(
          this.theme,
          uiEvent.pattern,
          uiEvent.status,
          uiEvent.exitCode,
          uiEvent.stdout,
          uiEvent.stderr,
          uiEvent.captureTruncated,
        ),
      });
      this.requestRender();
      return;
    }

    if (uiEvent.type === "grep_blocked") {
      this.chatContainer.addMessage(
        {
          type: "tool",
          view: buildGrepBlockedView(this.theme, uiEvent.pattern, uiEvent.reason),
        },
        uiEvent.toolCallId,
      );
      this.requestRender();
    }
  }
}
