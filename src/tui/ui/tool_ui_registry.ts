import type { ToolUiEvent, ToolUiText } from "../../core/tools/registry.js";
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
  renderToolUiTextLines,
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

function formatSubagentTitle(title: string | undefined): string {
  const trimmed = title?.trim() ?? "";
  return trimmed || "(subagent)";
}

function formatAgentIdList(ids: string[]): string {
  const cleaned = ids.map((id) => id.trim()).filter(Boolean);
  if (cleaned.length === 0) return "(no ids)";
  return cleaned.join(", ");
}

function buildSubagentRunningView(args: {
  theme: Theme;
  label: string;
  title: string;
}): ToolOutputViewModel {
  const { theme, label, title } = args;
  const { palette, text } = theme;
  const runningColor = (s: string) => palette.actionRunning(s);
  const target = formatSubagentTitle(title);

  const header = buildHeaderLine({
    bulletStyle: runningColor,
    bullet: "⏵",
    label,
    labelStyle: palette.textMuted,
    accent: inlineText(target),
    accentStyle: palette.brandAccent,
    wrapIndex: 5,
  });

  return {
    borderColor: runningColor,
    expanded: { title: runningColor(text.bold(target)) },
    compact: { header },
  };
}

function buildSubagentFinishedView(args: {
  theme: Theme;
  label: string;
  failureLabel: string;
  title: string;
  status: "success" | "error";
  uiText: ToolUiText;
}): ToolOutputViewModel {
  const { theme, label, failureLabel, title, status, uiText } = args;
  const { palette, text } = theme;
  const successColor = (s: string) => palette.actionSuccess(s);
  const errorColor = (s: string) => palette.actionError(s);
  const isSuccess = status === "success";
  const borderColor = isSuccess ? successColor : errorColor;
  const headerLabel = isSuccess ? label : failureLabel;
  const target = formatSubagentTitle(title);

  const header = buildHeaderLine({
    bulletStyle: borderColor,
    bullet: isSuccess ? "✓" : "✗",
    label: headerLabel,
    labelStyle: palette.textMuted,
    accent: inlineText(target),
    accentStyle: palette.brandAccent,
    wrapIndex: 5,
  });

  const compactParts: string[] = [];
  const previewText = renderToolUiTextLines({
    uiText,
    kind: "preview",
    theme,
    baseStyle: palette.textDim,
  });
  if (previewText) {
    compactParts.push(previewText);
  }
  if (uiText.statusLine?.trim()) {
    compactParts.push(palette.textMuted(uiText.statusLine));
  }
  const compactText = compactParts.length > 0 ? compactParts.join("\n") : undefined;
  const fullText = renderToolUiTextLines({
    uiText,
    kind: "full",
    theme,
    baseStyle: palette.actionOutput,
  });

  return {
    borderColor,
    expanded: {
      title: borderColor(text.bold(target)),
      sections: fullText ? [fullText] : [],
    },
    compact: {
      header,
      extraText: compactText,
    },
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
    return buildSubagentRunningView({
      theme: context.theme,
      label: "spawning",
      title: uiEvent.title,
    });
  });

  registry.register("spawn_agent_finished", (event, context) => {
    const uiEvent = event as Extract<ToolUiEvent, { type: "spawn_agent_finished" }>;
    const title = formatSubagentTitle(uiEvent.title);
    if (!uiEvent.uiText) {
      return buildSimpleToolFinishedView({
        theme: context.theme,
        label: "spawn",
        target: title,
        status: uiEvent.status,
        message: uiEvent.message,
      });
    }
    return buildSubagentFinishedView({
      theme: context.theme,
      label: "spawned",
      failureLabel: "spawn failed",
      title,
      status: uiEvent.status,
      uiText: uiEvent.uiText,
    });
  });

  registry.register("spawn_agent_blocked", (event, context) => {
    const uiEvent = event as Extract<ToolUiEvent, { type: "spawn_agent_blocked" }>;
    const title = formatSubagentTitle(uiEvent.title ?? uiEvent.name);
    return buildSimpleToolFinishedView({
      theme: context.theme,
      label: "spawn",
      target: title,
      status: "error",
      message: uiEvent.reason,
    });
  });

  registry.register("wait_for_agent_started", (event, context) => {
    const uiEvent = event as Extract<ToolUiEvent, { type: "wait_for_agent_started" }>;
    const title = formatAgentIdList(uiEvent.agentIds);
    return buildSubagentRunningView({
      theme: context.theme,
      label: "waiting",
      title,
    });
  });

  registry.register("wait_for_agent_finished", (event, context) => {
    const uiEvent = event as Extract<ToolUiEvent, { type: "wait_for_agent_finished" }>;
    const title = formatAgentIdList(uiEvent.agentIds);
    if (!uiEvent.uiText) {
      return buildSimpleToolFinishedView({
        theme: context.theme,
        label: "wait",
        target: title,
        status: uiEvent.status,
        message: uiEvent.message,
      });
    }
    return buildSubagentFinishedView({
      theme: context.theme,
      label: "waited",
      failureLabel: "waited",
      title,
      status: uiEvent.status,
      uiText: uiEvent.uiText,
    });
  });

  registry.register("wait_for_agent_blocked", (event, context) => {
    const uiEvent = event as Extract<ToolUiEvent, { type: "wait_for_agent_blocked" }>;
    const title = formatAgentIdList(uiEvent.agentIds ?? []);
    return buildSimpleToolFinishedView({
      theme: context.theme,
      label: "wait",
      target: title,
      status: "error",
      message: uiEvent.reason,
    });
  });

  registry.register("terminate_agent_started", (event, context) => {
    const uiEvent = event as Extract<ToolUiEvent, { type: "terminate_agent_started" }>;
    return buildSubagentRunningView({
      theme: context.theme,
      label: "terminating",
      title: uiEvent.agentId,
    });
  });

  registry.register("terminate_agent_finished", (event, context) => {
    const uiEvent = event as Extract<ToolUiEvent, { type: "terminate_agent_finished" }>;
    const title = formatSubagentTitle(uiEvent.agentId);
    if (!uiEvent.uiText) {
      const message =
        uiEvent.finalStatus && uiEvent.finalStatus !== "success"
          ? `final status: ${uiEvent.finalStatus}`
          : uiEvent.message;
      return buildSimpleToolFinishedView({
        theme: context.theme,
        label: "terminate",
        target: title,
        status: uiEvent.status,
        message,
      });
    }
    return buildSubagentFinishedView({
      theme: context.theme,
      label: "terminated",
      failureLabel: "terminated",
      title,
      status: uiEvent.status,
      uiText: uiEvent.uiText,
    });
  });

  registry.register("terminate_agent_blocked", (event, context) => {
    const uiEvent = event as Extract<ToolUiEvent, { type: "terminate_agent_blocked" }>;
    const title = formatSubagentTitle(uiEvent.agentId);
    return buildSimpleToolFinishedView({
      theme: context.theme,
      label: "terminate",
      target: title,
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
