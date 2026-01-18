import type { ToolUiEvent } from "../../core/tools/registry.js";
import {
  buildBashAbortedView,
  buildBashBlockedView,
  buildBashExecutionView,
  buildBashRunningView,
} from "./bash_execution.js";
import {
  buildEditBlockedView,
  buildEditSuccessView,
  buildWriteBlockedView,
  buildWriteSuccessView,
} from "./file_execution.js";
import {
  buildTaskBlockedView,
  buildTaskFinishedView,
  buildTaskRunningView,
} from "./task_execution.js";
import type { Theme } from "./theme/index.js";
import { buildHeaderLine, inlineText, type ToolOutputViewModel } from "./tool_output.js";

export type ToolUiTaskState = {
  events: string[];
  costTotal: number;
  turns: number;
  toolCalls: number;
  kind?: "task" | "fork";
  name?: string;
};

export type ToolUiRenderContext = {
  theme: Theme;
  taskState?: ToolUiTaskState;
  compact?: boolean;
  expanded?: boolean;
};

type ToolUiRenderer = (event: ToolUiEvent, context: ToolUiRenderContext) => ToolOutputViewModel;

function buildWebToolRunningView(theme: Theme, label: string, target: string): ToolOutputViewModel {
  const { palette, text } = theme;
  const runningColor = (s: string) => palette.actionRunning(s);

  const header = buildHeaderLine({
    bulletStyle: runningColor,
    label,
    labelStyle: palette.textMuted,
    accent: inlineText(target),
    accentStyle: palette.brandAccent,
    tailSegments: [
      { text: " ", style: (s) => s },
      { text: "(running)", style: palette.textMuted },
    ],
  });

  return {
    borderColor: runningColor,
    expanded: { title: runningColor(text.bold(`${label} ${target}`)) },
    compact: { header },
  };
}

function buildWebToolFinishedView(
  theme: Theme,
  label: string,
  target: string,
  status: "success" | "error",
): ToolOutputViewModel {
  const { palette, text } = theme;
  const successColor = (s: string) => palette.actionSuccess(s);
  const errorColor = (s: string) => palette.actionError(s);
  const isSuccess = status === "success";
  const borderColor = isSuccess ? successColor : errorColor;

  const header = buildHeaderLine({
    bulletStyle: borderColor,
    bullet: isSuccess ? "✓" : undefined,
    label: isSuccess ? label : `${label} failed`,
    labelStyle: palette.textMuted,
    accent: inlineText(target),
    accentStyle: palette.brandAccent,
  });

  return {
    borderColor,
    expanded: { title: borderColor(text.bold(`${label} ${target}`)) },
    compact: { header },
  };
}

export class ToolUiRegistry {
  private renderers = new Map<ToolUiEvent["type"], ToolUiRenderer>();

  register(type: ToolUiEvent["type"], renderer: ToolUiRenderer): void {
    this.renderers.set(type, renderer);
  }

  render(event: ToolUiEvent, context: ToolUiRenderContext): ToolOutputViewModel | undefined {
    return this.renderers.get(event.type)?.(event, context);
  }

  renderBashAborted(
    command: string,
    reason: "aborted" | "interrupted",
    context: ToolUiRenderContext,
  ): ToolOutputViewModel {
    return buildBashAbortedView(context.theme, command, reason);
  }
}

export function createToolUiRegistry(): ToolUiRegistry {
  const registry = new ToolUiRegistry();

  registry.register("bash_started", (event, context) => {
    const uiEvent = event as Extract<ToolUiEvent, { type: "bash_started" }>;
    return buildBashRunningView(context.theme, uiEvent.command);
  });

  registry.register("bash_execution", (event, context) => {
    const uiEvent = event as Extract<ToolUiEvent, { type: "bash_execution" }>;
    return buildBashExecutionView(context.theme, uiEvent.command, uiEvent.exitCode, uiEvent.uiText);
  });

  registry.register("bash_blocked", (event, context) => {
    const uiEvent = event as Extract<ToolUiEvent, { type: "bash_blocked" }>;
    return buildBashBlockedView(context.theme, uiEvent.command, uiEvent.reason);
  });

  registry.register("task_started", (event, context) => {
    const uiEvent = event as Extract<ToolUiEvent, { type: "task_started" }>;
    const taskState = context.taskState ?? {
      events: [],
      costTotal: 0,
      turns: 0,
      toolCalls: 0,
      kind: uiEvent.kind,
      name: uiEvent.name,
    };
    return buildTaskRunningView(
      context.theme,
      uiEvent.title,
      taskState.events,
      taskState.costTotal,
      taskState.turns,
      taskState.toolCalls,
      {
        kind: taskState.kind ?? uiEvent.kind ?? "task",
        subagentName: uiEvent.name.trim() || undefined,
      },
    );
  });

  registry.register("task_progress", (event, context) => {
    const uiEvent = event as Extract<ToolUiEvent, { type: "task_progress" }>;
    const taskState = context.taskState ?? {
      events: [uiEvent.event],
      costTotal: uiEvent.costTotal,
      turns: uiEvent.turns,
      toolCalls: uiEvent.toolCalls,
      kind: uiEvent.kind,
      name: uiEvent.name,
    };
    return buildTaskRunningView(
      context.theme,
      uiEvent.title,
      taskState.events,
      taskState.costTotal,
      taskState.turns,
      taskState.toolCalls,
      {
        kind: taskState.kind ?? uiEvent.kind ?? "task",
        subagentName: uiEvent.name.trim() || undefined,
      },
    );
  });

  registry.register("task_finished", (event, context) => {
    const uiEvent = event as Extract<ToolUiEvent, { type: "task_finished" }>;
    return buildTaskFinishedView(
      context.theme,
      uiEvent.title,
      uiEvent.costTotal,
      uiEvent.turns,
      uiEvent.toolCalls,
      uiEvent.status,
      uiEvent.finalOutput,
      { kind: uiEvent.kind ?? "task", subagentName: uiEvent.name.trim() || undefined },
    );
  });

  registry.register("task_blocked", (event, context) => {
    const uiEvent = event as Extract<ToolUiEvent, { type: "task_blocked" }>;
    return buildTaskBlockedView(context.theme, uiEvent.title, uiEvent.reason, {
      kind: uiEvent.kind ?? "task",
      subagentName: uiEvent.name?.trim() || undefined,
    });
  });

  registry.register("web_search_started", (event, context) => {
    const uiEvent = event as Extract<ToolUiEvent, { type: "web_search_started" }>;
    return buildWebToolRunningView(context.theme, "web search", uiEvent.objective);
  });

  registry.register("web_search_finished", (event, context) => {
    const uiEvent = event as Extract<ToolUiEvent, { type: "web_search_finished" }>;
    return buildWebToolFinishedView(context.theme, "web search", uiEvent.objective, uiEvent.status);
  });

  registry.register("web_fetch_started", (event, context) => {
    const uiEvent = event as Extract<ToolUiEvent, { type: "web_fetch_started" }>;
    return buildWebToolRunningView(context.theme, "web fetch", uiEvent.url);
  });

  registry.register("web_fetch_finished", (event, context) => {
    const uiEvent = event as Extract<ToolUiEvent, { type: "web_fetch_finished" }>;
    return buildWebToolFinishedView(context.theme, "web fetch", uiEvent.url, uiEvent.status);
  });

  registry.register("write_success", (event, context) => {
    const uiEvent = event as Extract<ToolUiEvent, { type: "write_success" }>;
    return buildWriteSuccessView(context.theme, uiEvent.path, uiEvent.uiText);
  });

  registry.register("write_blocked", (event, context) => {
    const uiEvent = event as Extract<ToolUiEvent, { type: "write_blocked" }>;
    return buildWriteBlockedView(context.theme, uiEvent.path, uiEvent.reason);
  });

  registry.register("edit_success", (event, context) => {
    const uiEvent = event as Extract<ToolUiEvent, { type: "edit_success" }>;
    return buildEditSuccessView(context.theme, uiEvent.path, uiEvent.uiText);
  });

  registry.register("edit_blocked", (event, context) => {
    const uiEvent = event as Extract<ToolUiEvent, { type: "edit_blocked" }>;
    return buildEditBlockedView(context.theme, uiEvent.path, uiEvent.reason);
  });

  return registry;
}
