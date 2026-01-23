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
import type { Theme } from "./theme/index.js";
import {
  buildHeaderLine,
  buildSection,
  inlineText,
  type ToolOutputViewModel,
} from "./tool_output.js";

export type ToolUiRenderContext = {
  theme: Theme;
  compact?: boolean;
  expanded?: boolean;
};

type ToolUiRenderer = (event: ToolUiEvent, context: ToolUiRenderContext) => ToolOutputViewModel;

function buildSimpleToolRunningView(
  theme: Theme,
  label: string,
  target: string,
): ToolOutputViewModel {
  const { palette, text } = theme;
  const runningColor = (s: string) => palette.actionRunning(s);

  const header = buildHeaderLine({
    bulletStyle: runningColor,
    bullet: "⏵",
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

function buildSimpleToolFinishedView(args: {
  theme: Theme;
  label: string;
  target: string;
  status: "success" | "error";
  message?: string;
}): ToolOutputViewModel {
  const { theme, label, target, status, message } = args;
  const { palette, text } = theme;
  const successColor = (s: string) => palette.actionSuccess(s);
  const errorColor = (s: string) => palette.actionError(s);
  const isSuccess = status === "success";
  const borderColor = isSuccess ? successColor : errorColor;

  const header = buildHeaderLine({
    bulletStyle: borderColor,
    bullet: isSuccess ? "✓" : "✗",
    label: isSuccess ? label : `${label} failed`,
    labelStyle: palette.textMuted,
    accent: inlineText(target),
    accentStyle: palette.brandAccent,
  });

  const messageLine = message
    ? isSuccess
      ? palette.textMuted(message)
      : errorColor(message)
    : undefined;
  const section = buildSection(messageLine ? [messageLine] : []);

  return {
    borderColor,
    expanded: {
      title: borderColor(text.bold(`${label} ${target}`)),
      sections: section ? [section] : [],
    },
    compact: {
      header,
      extraText: messageLine ? `    ${messageLine}` : undefined,
    },
  };
}

function formatSubagentTarget(args: {
  name?: string;
  title?: string;
  agentId?: string;
}): string {
  const name = args.name?.trim();
  const title = args.title?.trim();
  const base = name ? `${name}: ${title ?? ""}`.trim() : (title ?? "").trim();
  const finalLabel = base || "(subagent)";
  return args.agentId ? `${finalLabel} (${args.agentId})` : finalLabel;
}

function formatAgentIds(ids: string[]): string {
  const cleaned = ids.map((id) => id.trim()).filter(Boolean);
  if (cleaned.length === 0) return "(no ids)";
  if (cleaned.length <= 2) return cleaned.join(", ");
  return `${cleaned.slice(0, 2).join(", ")}, +${cleaned.length - 2} more`;
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
    return buildBashExecutionView(
      context.theme,
      uiEvent.command,
      uiEvent.exitCode,
      uiEvent.uiText,
      uiEvent.labelOverride,
    );
  });

  registry.register("bash_aborted", (event, context) => {
    const uiEvent = event as Extract<ToolUiEvent, { type: "bash_aborted" }>;
    return buildBashAbortedView(context.theme, uiEvent.command, uiEvent.reason);
  });

  registry.register("bash_blocked", (event, context) => {
    const uiEvent = event as Extract<ToolUiEvent, { type: "bash_blocked" }>;
    return buildBashBlockedView(context.theme, uiEvent.command, uiEvent.reason);
  });

  registry.register("spawn_agent_started", (event, context) => {
    const uiEvent = event as Extract<ToolUiEvent, { type: "spawn_agent_started" }>;
    const target = formatSubagentTarget({ name: uiEvent.name, title: uiEvent.title });
    return buildSimpleToolRunningView(context.theme, "spawn agent", target);
  });

  registry.register("spawn_agent_finished", (event, context) => {
    const uiEvent = event as Extract<ToolUiEvent, { type: "spawn_agent_finished" }>;
    const target = formatSubagentTarget({
      name: uiEvent.name,
      title: uiEvent.title,
      agentId: uiEvent.agentId,
    });
    return buildSimpleToolFinishedView({
      theme: context.theme,
      label: "spawn agent",
      target,
      status: uiEvent.status,
      message: uiEvent.message,
    });
  });

  registry.register("spawn_agent_blocked", (event, context) => {
    const uiEvent = event as Extract<ToolUiEvent, { type: "spawn_agent_blocked" }>;
    const target = formatSubagentTarget({ name: uiEvent.name, title: uiEvent.title });
    return buildSimpleToolFinishedView({
      theme: context.theme,
      label: "spawn agent",
      target,
      status: "error",
      message: uiEvent.reason,
    });
  });

  registry.register("wait_for_agent_started", (event, context) => {
    const uiEvent = event as Extract<ToolUiEvent, { type: "wait_for_agent_started" }>;
    const target = formatAgentIds(uiEvent.agentIds);
    return buildSimpleToolRunningView(context.theme, "wait for agents", target);
  });

  registry.register("wait_for_agent_finished", (event, context) => {
    const uiEvent = event as Extract<ToolUiEvent, { type: "wait_for_agent_finished" }>;
    const target = formatAgentIds(uiEvent.agentIds);
    return buildSimpleToolFinishedView({
      theme: context.theme,
      label: "wait for agents",
      target,
      status: uiEvent.status,
      message: uiEvent.message,
    });
  });

  registry.register("wait_for_agent_blocked", (event, context) => {
    const uiEvent = event as Extract<ToolUiEvent, { type: "wait_for_agent_blocked" }>;
    const target = formatAgentIds(uiEvent.agentIds ?? []);
    return buildSimpleToolFinishedView({
      theme: context.theme,
      label: "wait for agents",
      target,
      status: "error",
      message: uiEvent.reason,
    });
  });

  registry.register("terminate_agent_started", (event, context) => {
    const uiEvent = event as Extract<ToolUiEvent, { type: "terminate_agent_started" }>;
    return buildSimpleToolRunningView(context.theme, "terminate agent", uiEvent.agentId);
  });

  registry.register("terminate_agent_finished", (event, context) => {
    const uiEvent = event as Extract<ToolUiEvent, { type: "terminate_agent_finished" }>;
    const message =
      uiEvent.finalStatus && uiEvent.finalStatus !== "success"
        ? `final status: ${uiEvent.finalStatus}`
        : uiEvent.message;
    return buildSimpleToolFinishedView({
      theme: context.theme,
      label: "terminate agent",
      target: uiEvent.agentId,
      status: uiEvent.status,
      message,
    });
  });

  registry.register("terminate_agent_blocked", (event, context) => {
    const uiEvent = event as Extract<ToolUiEvent, { type: "terminate_agent_blocked" }>;
    return buildSimpleToolFinishedView({
      theme: context.theme,
      label: "terminate agent",
      target: uiEvent.agentId ?? "(unknown)",
      status: "error",
      message: uiEvent.reason,
    });
  });

  registry.register("web_search_started", (event, context) => {
    const uiEvent = event as Extract<ToolUiEvent, { type: "web_search_started" }>;
    return buildSimpleToolRunningView(context.theme, "web search", uiEvent.objective);
  });

  registry.register("web_search_finished", (event, context) => {
    const uiEvent = event as Extract<ToolUiEvent, { type: "web_search_finished" }>;
    return buildSimpleToolFinishedView({
      theme: context.theme,
      label: "web search",
      target: uiEvent.objective,
      status: uiEvent.status,
    });
  });

  registry.register("web_fetch_started", (event, context) => {
    const uiEvent = event as Extract<ToolUiEvent, { type: "web_fetch_started" }>;
    return buildSimpleToolRunningView(context.theme, "web fetch", uiEvent.url);
  });

  registry.register("web_fetch_finished", (event, context) => {
    const uiEvent = event as Extract<ToolUiEvent, { type: "web_fetch_finished" }>;
    return buildSimpleToolFinishedView({
      theme: context.theme,
      label: "web fetch",
      target: uiEvent.url,
      status: uiEvent.status,
    });
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
