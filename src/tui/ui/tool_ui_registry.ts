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
  buildViewImageBlockedView,
  buildViewImageSuccessView,
  buildWriteBlockedView,
  buildWriteSuccessView,
} from "./file_execution.js";
import type { Theme } from "./theme/index.js";
import {
  buildSection,
  buildToolHeaderLine,
  inlineText,
  renderToolUiCompactText,
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

  const header = buildToolHeaderLine({
    bulletStyle: runningColor,
    bullet: "⏵",
    label: `${label} (running)`,
    labelStyle: palette.textMuted,
    accent: inlineText(target),
    accentStyle: palette.brandAccent,
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

  const header = buildToolHeaderLine({
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

  const header = buildToolHeaderLine({
    bulletStyle: runningColor,
    bullet: "⏵",
    label,
    labelStyle: palette.textMuted,
    accent: inlineText(target),
    accentStyle: palette.brandAccent,
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

  const header = buildToolHeaderLine({
    bulletStyle: borderColor,
    bullet: isSuccess ? "✓" : "✗",
    label: headerLabel,
    labelStyle: palette.textMuted,
    accent: inlineText(target),
    accentStyle: palette.brandAccent,
  });

  const compactText = renderToolUiCompactText({
    uiText,
    theme,
    previewStyle: palette.textDim,
    statusStyle: palette.textMuted,
  });
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
    return buildBashRunningView(
      context.theme,
      uiEvent.command,
      uiEvent.headerTarget ?? uiEvent.command,
    );
  });

  registry.register("bash_execution", (event, context) => {
    const uiEvent = event as Extract<ToolUiEvent, { type: "bash_execution" }>;
    return buildBashExecutionView(
      context.theme,
      uiEvent.command,
      uiEvent.exitCode,
      uiEvent.uiText,
      uiEvent.labelOverride,
      uiEvent.headerTarget ?? uiEvent.command,
    );
  });

  registry.register("bash_aborted", (event, context) => {
    const uiEvent = event as Extract<ToolUiEvent, { type: "bash_aborted" }>;
    return buildBashAbortedView(
      context.theme,
      uiEvent.command,
      uiEvent.reason,
      uiEvent.headerTarget ?? uiEvent.command,
    );
  });

  registry.register("bash_blocked", (event, context) => {
    const uiEvent = event as Extract<ToolUiEvent, { type: "bash_blocked" }>;
    return buildBashBlockedView(
      context.theme,
      uiEvent.command,
      uiEvent.reason,
      uiEvent.headerTarget ?? uiEvent.command,
    );
  });

  registry.register("spawn_agent_started", (event, context) => {
    const uiEvent = event as Extract<ToolUiEvent, { type: "spawn_agent_started" }>;
    return buildSubagentRunningView({
      theme: context.theme,
      label: "spawning",
      title: uiEvent.headerTarget ?? uiEvent.title,
    });
  });

  registry.register("spawn_agent_finished", (event, context) => {
    const uiEvent = event as Extract<ToolUiEvent, { type: "spawn_agent_finished" }>;
    const title = formatSubagentTitle(uiEvent.headerTarget ?? uiEvent.title);
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
    const title = formatSubagentTitle(uiEvent.headerTarget ?? uiEvent.title ?? uiEvent.name);
    return buildSimpleToolFinishedView({
      theme: context.theme,
      label: "spawn",
      target: title,
      status: "error",
      message: uiEvent.reason,
    });
  });

  registry.register("send_input_to_agent_started", (event, context) => {
    const uiEvent = event as Extract<ToolUiEvent, { type: "send_input_to_agent_started" }>;
    const title = formatSubagentTitle(uiEvent.headerTarget ?? uiEvent.title ?? uiEvent.agentId);
    return buildSubagentRunningView({
      theme: context.theme,
      label: "sending",
      title,
    });
  });

  registry.register("send_input_to_agent_finished", (event, context) => {
    const uiEvent = event as Extract<ToolUiEvent, { type: "send_input_to_agent_finished" }>;
    const title = formatSubagentTitle(uiEvent.headerTarget ?? uiEvent.title ?? uiEvent.agentId);
    if (!uiEvent.uiText) {
      return buildSimpleToolFinishedView({
        theme: context.theme,
        label: "send input",
        target: title,
        status: uiEvent.status,
        message: uiEvent.message,
      });
    }
    return buildSubagentFinishedView({
      theme: context.theme,
      label: "sent input",
      failureLabel: "send failed",
      title,
      status: uiEvent.status,
      uiText: uiEvent.uiText,
    });
  });

  registry.register("send_input_to_agent_blocked", (event, context) => {
    const uiEvent = event as Extract<ToolUiEvent, { type: "send_input_to_agent_blocked" }>;
    const title = formatSubagentTitle(
      uiEvent.headerTarget ?? uiEvent.title ?? uiEvent.agentId ?? uiEvent.name,
    );
    return buildSimpleToolFinishedView({
      theme: context.theme,
      label: "send input",
      target: title,
      status: "error",
      message: uiEvent.reason,
    });
  });

  registry.register("wait_for_agent_started", (event, context) => {
    const uiEvent = event as Extract<ToolUiEvent, { type: "wait_for_agent_started" }>;
    const title = uiEvent.headerTarget ?? formatAgentIdList(uiEvent.agentIds);
    return buildSubagentRunningView({
      theme: context.theme,
      label: "waiting",
      title,
    });
  });

  registry.register("wait_for_agent_finished", (event, context) => {
    const uiEvent = event as Extract<ToolUiEvent, { type: "wait_for_agent_finished" }>;
    const title = uiEvent.headerTarget ?? formatAgentIdList(uiEvent.agentIds);
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
    const title = uiEvent.headerTarget ?? formatAgentIdList(uiEvent.agentIds ?? []);
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
      title: uiEvent.headerTarget ?? uiEvent.agentId,
    });
  });

  registry.register("terminate_agent_finished", (event, context) => {
    const uiEvent = event as Extract<ToolUiEvent, { type: "terminate_agent_finished" }>;
    const title = formatSubagentTitle(uiEvent.headerTarget ?? uiEvent.agentId);
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
    const title = formatSubagentTitle(uiEvent.headerTarget ?? uiEvent.agentId);
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
    return buildSimpleToolRunningView(
      context.theme,
      "web search",
      uiEvent.headerTarget ?? uiEvent.objective,
    );
  });

  registry.register("web_search_finished", (event, context) => {
    const uiEvent = event as Extract<ToolUiEvent, { type: "web_search_finished" }>;
    return buildSimpleToolFinishedView({
      theme: context.theme,
      label: "web search",
      target: uiEvent.headerTarget ?? uiEvent.objective,
      status: uiEvent.status,
    });
  });

  registry.register("web_fetch_started", (event, context) => {
    const uiEvent = event as Extract<ToolUiEvent, { type: "web_fetch_started" }>;
    return buildSimpleToolRunningView(
      context.theme,
      "web fetch",
      uiEvent.headerTarget ?? uiEvent.url,
    );
  });

  registry.register("web_fetch_finished", (event, context) => {
    const uiEvent = event as Extract<ToolUiEvent, { type: "web_fetch_finished" }>;
    return buildSimpleToolFinishedView({
      theme: context.theme,
      label: "web fetch",
      target: uiEvent.headerTarget ?? uiEvent.url,
      status: uiEvent.status,
    });
  });

  registry.register("write_success", (event, context) => {
    const uiEvent = event as Extract<ToolUiEvent, { type: "write_success" }>;
    return buildWriteSuccessView(
      context.theme,
      uiEvent.path,
      uiEvent.uiText,
      uiEvent.headerTarget ?? uiEvent.path,
    );
  });

  registry.register("write_blocked", (event, context) => {
    const uiEvent = event as Extract<ToolUiEvent, { type: "write_blocked" }>;
    return buildWriteBlockedView(
      context.theme,
      uiEvent.path,
      uiEvent.reason,
      uiEvent.headerTarget ?? uiEvent.path,
    );
  });

  registry.register("edit_success", (event, context) => {
    const uiEvent = event as Extract<ToolUiEvent, { type: "edit_success" }>;
    return buildEditSuccessView(
      context.theme,
      uiEvent.path,
      uiEvent.uiText,
      uiEvent.headerTarget ?? uiEvent.path,
    );
  });

  registry.register("edit_blocked", (event, context) => {
    const uiEvent = event as Extract<ToolUiEvent, { type: "edit_blocked" }>;
    return buildEditBlockedView(
      context.theme,
      uiEvent.path,
      uiEvent.reason,
      uiEvent.headerTarget ?? uiEvent.path,
    );
  });

  registry.register("view_image_success", (event, context) => {
    const uiEvent = event as Extract<ToolUiEvent, { type: "view_image_success" }>;
    return buildViewImageSuccessView(
      context.theme,
      uiEvent.path,
      uiEvent.uiText,
      uiEvent.headerTarget ?? uiEvent.path,
    );
  });

  registry.register("view_image_blocked", (event, context) => {
    const uiEvent = event as Extract<ToolUiEvent, { type: "view_image_blocked" }>;
    return buildViewImageBlockedView(
      context.theme,
      uiEvent.path,
      uiEvent.reason,
      uiEvent.headerTarget ?? uiEvent.path,
    );
  });

  return registry;
}
