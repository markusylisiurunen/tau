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

function buildToolPendingView(
  theme: Theme,
  label: "preparing" | "queued",
  toolName: string,
): ToolOutputViewModel {
  const { palette, text } = theme;
  const pendingColor = (s: string) => palette.textMuted(s);

  const header = buildToolHeaderLine({
    bulletStyle: pendingColor,
    bullet: "⏵",
    label,
    labelStyle: palette.textMuted,
    accent: inlineText(toolName),
    accentStyle: palette.brandAccent,
  });

  return {
    borderColor: pendingColor,
    expanded: { title: pendingColor(text.bold(`${label} ${toolName}`)) },
    compact: { header },
  };
}

const CODE_MODE_COMPACT_CODE_LINES = 10;

type CodeModeCompactStatus = "queued" | "running" | "completed" | "failed" | "blocked";

function buildCodeModeCompactHeader(theme: Theme, status: CodeModeCompactStatus, label: string) {
  const { palette } = theme;
  const statusStyle =
    status === "completed"
      ? palette.actionSuccess
      : status === "failed" || status === "blocked"
        ? palette.actionError
        : status === "running"
          ? palette.actionRunning
          : palette.textMuted;
  const bullet =
    status === "completed" ? "✓" : status === "failed" || status === "blocked" ? "✗" : "⏵";

  return buildToolHeaderLine({
    bulletStyle: statusStyle,
    bullet,
    label: status,
    labelStyle: palette.textMuted,
    accent: label,
    accentStyle: palette.brandAccent,
  });
}

function buildCodeModeCompactPreview(theme: Theme, code: string): string | undefined {
  const trimmed = code.trim();
  if (!trimmed) return undefined;

  const lines = trimmed.split(/\r?\n/);
  const preview = lines
    .slice(0, CODE_MODE_COMPACT_CODE_LINES)
    .map((line) => `    ${theme.palette.textMuted("›")} ${theme.palette.textDim(line)}`);
  const remaining = lines.length - preview.length;
  if (remaining > 0) {
    preview.push(
      `    ${theme.palette.textMuted("›")} ${theme.palette.textDim(`… ${remaining} more line${remaining === 1 ? "" : "s"}`)}`,
    );
  }
  return preview.join("\n");
}

function joinCodeModeCompactSections(...sections: Array<string | undefined>): string | undefined {
  const present = sections.filter((section): section is string => Boolean(section?.trim()));
  return present.length > 0 ? present.join("\n\n") : undefined;
}

function buildClientToolFinishedView(args: {
  theme: Theme;
  toolName: string;
  status: "success" | "error";
  uiText: ToolUiText;
}): ToolOutputViewModel {
  const { theme, toolName, status, uiText } = args;
  const { palette, text } = theme;
  const isSuccess = status === "success";
  const borderColor = isSuccess
    ? (s: string) => palette.actionSuccess(s)
    : (s: string) => palette.actionError(s);
  const header = buildToolHeaderLine({
    bulletStyle: borderColor,
    bullet: isSuccess ? "✓" : "✗",
    label: isSuccess ? "completed" : "failed",
    labelStyle: palette.textMuted,
    accent: inlineText(toolName),
    accentStyle: palette.brandAccent,
  });
  const compactText = renderToolUiCompactText({
    uiText,
    theme,
    previewStyle: isSuccess ? palette.textDim : palette.actionError,
    statusStyle: palette.textMuted,
  });
  const fullText = renderToolUiTextLines({
    uiText,
    kind: "full",
    theme,
    baseStyle: isSuccess ? palette.actionOutput : palette.actionError,
  });

  return {
    borderColor,
    expanded: {
      title: borderColor(text.bold(`${isSuccess ? "completed" : "failed"} ${toolName}`)),
      sections: fullText ? [fullText] : [],
    },
    compact: { header, extraText: compactText },
  };
}

function buildSimpleToolFinishedView(args: {
  theme: Theme;
  label: string;
  target: string;
  status: "success" | "error" | "blocked";
  message?: string;
}): ToolOutputViewModel {
  const { theme, label, target, status, message } = args;
  const { palette, text } = theme;
  const successColor = (s: string) => palette.actionSuccess(s);
  const errorColor = (s: string) => palette.actionError(s);
  const isSuccess = status === "success";
  const borderColor = isSuccess ? successColor : errorColor;
  const statusLabel = isSuccess
    ? label
    : status === "blocked"
      ? `${label} blocked`
      : `${label} failed`;

  const header = buildToolHeaderLine({
    bulletStyle: borderColor,
    bullet: isSuccess ? "✓" : "✗",
    label: statusLabel,
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

function ensureSubagentUiText(args: {
  uiText?: ToolUiText;
  status: "success" | "error";
  message?: string;
  statusLine?: string;
}): ToolUiText {
  if (args.uiText) {
    return args.uiText;
  }

  const fallbackLine = args.message?.trim() || (args.status === "success" ? "ok" : "failed");
  return {
    previewLines: [{ text: fallbackLine }],
    statusLine: args.statusLine,
    fullLines: [{ text: fallbackLine }],
  };
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

  render(event: ToolUiEvent, context: ToolUiRenderContext): ToolOutputViewModel {
    const renderer = this.renderers.get(event.type);
    if (!renderer) {
      throw new Error(`missing tool ui renderer for event type '${event.type}'.`);
    }
    return renderer(event, context);
  }

  renderBashAborted(
    command: string,
    reason: "aborted" | "interrupted",
    context: ToolUiRenderContext,
  ): ToolOutputViewModel {
    const headerTarget = command.split(/\r?\n/)[0] ?? command;
    return buildBashAbortedView(context.theme, command, reason, headerTarget);
  }
}

export function createToolUiRegistry(): ToolUiRegistry {
  const registry = new ToolUiRegistry();

  registry.register("tool_call_streaming", (event, context) => {
    const uiEvent = event as Extract<ToolUiEvent, { type: "tool_call_streaming" }>;
    return buildToolPendingView(context.theme, "preparing", uiEvent.toolName);
  });

  registry.register("tool_call_queued", (event, context) => {
    const uiEvent = event as Extract<ToolUiEvent, { type: "tool_call_queued" }>;
    const view = buildToolPendingView(context.theme, "queued", uiEvent.headerTarget);
    if (uiEvent.code === undefined) return view;

    return {
      ...view,
      compact: {
        header: buildCodeModeCompactHeader(context.theme, "queued", uiEvent.toolName),
        extraText: buildCodeModeCompactPreview(context.theme, uiEvent.code),
      },
    };
  });

  registry.register("tool_call_blocked", (event, context) => {
    const uiEvent = event as Extract<ToolUiEvent, { type: "tool_call_blocked" }>;
    return buildSimpleToolFinishedView({
      theme: context.theme,
      label: "tool call",
      target: uiEvent.toolName,
      status: "blocked",
      message: uiEvent.reason,
    });
  });

  registry.register("client_tool_finished", (event, context) => {
    const uiEvent = event as Extract<ToolUiEvent, { type: "client_tool_finished" }>;
    return buildClientToolFinishedView({
      theme: context.theme,
      toolName: uiEvent.toolName,
      status: uiEvent.status,
      uiText: uiEvent.uiText,
    });
  });

  registry.register("bash_started", (event, context) => {
    const uiEvent = event as Extract<ToolUiEvent, { type: "bash_started" }>;
    return buildBashRunningView(context.theme, uiEvent.command, uiEvent.headerTarget);
  });

  registry.register("bash_execution", (event, context) => {
    const uiEvent = event as Extract<ToolUiEvent, { type: "bash_execution" }>;
    return buildBashExecutionView(
      context.theme,
      uiEvent.command,
      uiEvent.exitCode,
      uiEvent.uiText,
      uiEvent.labelOverride,
      uiEvent.headerTarget,
    );
  });

  registry.register("bash_aborted", (event, context) => {
    const uiEvent = event as Extract<ToolUiEvent, { type: "bash_aborted" }>;
    return buildBashAbortedView(
      context.theme,
      uiEvent.command,
      uiEvent.reason,
      uiEvent.headerTarget,
    );
  });

  registry.register("bash_blocked", (event, context) => {
    const uiEvent = event as Extract<ToolUiEvent, { type: "bash_blocked" }>;
    return buildBashBlockedView(
      context.theme,
      uiEvent.command,
      uiEvent.reason,
      uiEvent.headerTarget,
    );
  });

  registry.register("spawn_agent_started", (event, context) => {
    const uiEvent = event as Extract<ToolUiEvent, { type: "spawn_agent_started" }>;
    return buildSubagentRunningView({
      theme: context.theme,
      label: "spawning",
      title: uiEvent.headerTarget,
    });
  });

  registry.register("spawn_agent_finished", (event, context) => {
    const uiEvent = event as Extract<ToolUiEvent, { type: "spawn_agent_finished" }>;
    const title = formatSubagentTitle(uiEvent.headerTarget);
    return buildSubagentFinishedView({
      theme: context.theme,
      label: "spawned",
      failureLabel: "spawn failed",
      title,
      status: uiEvent.status,
      uiText: ensureSubagentUiText({
        uiText: uiEvent.uiText,
        status: uiEvent.status,
        message: uiEvent.message,
      }),
    });
  });

  registry.register("spawn_agent_blocked", (event, context) => {
    const uiEvent = event as Extract<ToolUiEvent, { type: "spawn_agent_blocked" }>;
    const title = formatSubagentTitle(uiEvent.headerTarget);
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
    const title = formatSubagentTitle(uiEvent.headerTarget);
    return buildSubagentRunningView({
      theme: context.theme,
      label: "sending",
      title,
    });
  });

  registry.register("send_input_to_agent_finished", (event, context) => {
    const uiEvent = event as Extract<ToolUiEvent, { type: "send_input_to_agent_finished" }>;
    const title = formatSubagentTitle(uiEvent.headerTarget);
    return buildSubagentFinishedView({
      theme: context.theme,
      label: "sent input",
      failureLabel: "send failed",
      title,
      status: uiEvent.status,
      uiText: ensureSubagentUiText({
        uiText: uiEvent.uiText,
        status: uiEvent.status,
        message: uiEvent.message,
      }),
    });
  });

  registry.register("send_input_to_agent_blocked", (event, context) => {
    const uiEvent = event as Extract<ToolUiEvent, { type: "send_input_to_agent_blocked" }>;
    const title = formatSubagentTitle(uiEvent.headerTarget);
    return buildSimpleToolFinishedView({
      theme: context.theme,
      label: "send input",
      target: title,
      status: "error",
      message: uiEvent.reason,
    });
  });

  registry.register("wait_for_agents_started", (event, context) => {
    const uiEvent = event as Extract<ToolUiEvent, { type: "wait_for_agents_started" }>;
    const title = uiEvent.headerTarget;
    return buildSubagentRunningView({
      theme: context.theme,
      label: "waiting",
      title,
    });
  });

  registry.register("wait_for_agents_finished", (event, context) => {
    const uiEvent = event as Extract<ToolUiEvent, { type: "wait_for_agents_finished" }>;
    const title = uiEvent.headerTarget;
    return buildSubagentFinishedView({
      theme: context.theme,
      label: "waited",
      failureLabel: "wait failed",
      title,
      status: uiEvent.status,
      uiText: ensureSubagentUiText({
        uiText: uiEvent.uiText,
        status: uiEvent.status,
        message: uiEvent.message,
      }),
    });
  });

  registry.register("wait_for_agents_blocked", (event, context) => {
    const uiEvent = event as Extract<ToolUiEvent, { type: "wait_for_agents_blocked" }>;
    const title = uiEvent.headerTarget;
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
      title: uiEvent.headerTarget,
    });
  });

  registry.register("terminate_agent_finished", (event, context) => {
    const uiEvent = event as Extract<ToolUiEvent, { type: "terminate_agent_finished" }>;
    const title = formatSubagentTitle(uiEvent.headerTarget);
    const fallbackMessage =
      uiEvent.finalStatus && uiEvent.finalStatus !== "success"
        ? `final status: ${uiEvent.finalStatus}`
        : uiEvent.message;
    return buildSubagentFinishedView({
      theme: context.theme,
      label: "terminated",
      failureLabel: "terminate failed",
      title,
      status: uiEvent.status,
      uiText: ensureSubagentUiText({
        uiText: uiEvent.uiText,
        status: uiEvent.status,
        message: fallbackMessage,
      }),
    });
  });

  registry.register("terminate_agent_blocked", (event, context) => {
    const uiEvent = event as Extract<ToolUiEvent, { type: "terminate_agent_blocked" }>;
    const title = formatSubagentTitle(uiEvent.headerTarget);
    return buildSimpleToolFinishedView({
      theme: context.theme,
      label: "terminate",
      target: title,
      status: "error",
      message: uiEvent.reason,
    });
  });

  registry.register("code_mode_started", (event, context) => {
    const uiEvent = event as Extract<ToolUiEvent, { type: "code_mode_started" }>;
    const view = buildSimpleToolRunningView(context.theme, uiEvent.label, uiEvent.headerTarget);
    return {
      ...view,
      compact: {
        header: buildCodeModeCompactHeader(context.theme, "running", uiEvent.label),
        extraText: buildCodeModeCompactPreview(context.theme, uiEvent.code),
      },
    };
  });

  registry.register("code_mode_finished", (event, context) => {
    const uiEvent = event as Extract<ToolUiEvent, { type: "code_mode_finished" }>;
    const view = buildClientToolFinishedView({
      theme: context.theme,
      toolName: uiEvent.label,
      status: uiEvent.status,
      uiText: uiEvent.uiText,
    });
    const status = uiEvent.status === "success" ? "completed" : "failed";
    return {
      ...view,
      compact: {
        header: buildCodeModeCompactHeader(context.theme, status, uiEvent.label),
        extraText: joinCodeModeCompactSections(
          buildCodeModeCompactPreview(context.theme, uiEvent.code),
          view.compact.extraText,
        ),
      },
    };
  });

  registry.register("code_mode_blocked", (event, context) => {
    const uiEvent = event as Extract<ToolUiEvent, { type: "code_mode_blocked" }>;
    const view = buildSimpleToolFinishedView({
      theme: context.theme,
      label: uiEvent.label,
      target: uiEvent.headerTarget,
      status: "error",
      message: uiEvent.reason,
    });
    return {
      ...view,
      compact: {
        header: buildCodeModeCompactHeader(context.theme, "blocked", uiEvent.label),
        extraText: joinCodeModeCompactSections(
          buildCodeModeCompactPreview(context.theme, uiEvent.code),
          view.compact.extraText,
        ),
      },
    };
  });

  registry.register("write_success", (event, context) => {
    const uiEvent = event as Extract<ToolUiEvent, { type: "write_success" }>;
    return buildWriteSuccessView(context.theme, uiEvent.path, uiEvent.uiText, uiEvent.headerTarget);
  });

  registry.register("write_blocked", (event, context) => {
    const uiEvent = event as Extract<ToolUiEvent, { type: "write_blocked" }>;
    return buildWriteBlockedView(context.theme, uiEvent.path, uiEvent.reason, uiEvent.headerTarget);
  });

  registry.register("edit_success", (event, context) => {
    const uiEvent = event as Extract<ToolUiEvent, { type: "edit_success" }>;
    return buildEditSuccessView(context.theme, uiEvent.path, uiEvent.uiText, uiEvent.headerTarget);
  });

  registry.register("edit_blocked", (event, context) => {
    const uiEvent = event as Extract<ToolUiEvent, { type: "edit_blocked" }>;
    return buildEditBlockedView(context.theme, uiEvent.path, uiEvent.reason, uiEvent.headerTarget);
  });

  registry.register("view_image_success", (event, context) => {
    const uiEvent = event as Extract<ToolUiEvent, { type: "view_image_success" }>;
    return buildViewImageSuccessView(
      context.theme,
      uiEvent.path,
      uiEvent.uiText,
      uiEvent.headerTarget,
    );
  });

  registry.register("view_image_blocked", (event, context) => {
    const uiEvent = event as Extract<ToolUiEvent, { type: "view_image_blocked" }>;
    return buildViewImageBlockedView(
      context.theme,
      uiEvent.path,
      uiEvent.reason,
      uiEvent.headerTarget,
    );
  });

  return registry;
}
