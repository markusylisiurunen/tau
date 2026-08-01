import type { ToolActivity, ToolUiText } from "../../core/tools/activity.js";
import {
  TOOL_NAME_BASH,
  TOOL_NAME_EDIT,
  TOOL_NAME_SEND_INPUT_TO_AGENT,
  TOOL_NAME_SPAWN_AGENT,
  TOOL_NAME_TERMINATE_AGENT,
  TOOL_NAME_VIEW_IMAGE,
  TOOL_NAME_WAIT_FOR_AGENTS,
  TOOL_NAME_WRITE,
} from "../../core/tools/tool_names.js";
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
import type { ToolUiModel } from "./tool_ui_model.js";

export type ToolUiRenderContext = {
  theme: Theme;
  compact?: boolean;
  expanded?: boolean;
};

type ToolUiRenderer = (event: ToolActivity, context: ToolUiRenderContext) => ToolOutputViewModel;

type ToolUiLifecycleStatus = Exclude<ToolUiModel["status"], "streaming">;

type ToolUiLanguage = {
  name: string;
  labels: Record<ToolUiLifecycleStatus, string>;
};

const TOOL_UI_LANGUAGE: Record<string, ToolUiLanguage> = {
  [TOOL_NAME_BASH]: {
    name: "bash",
    labels: {
      queued: "queued",
      running: "running",
      succeeded: "ran",
      failed: "failed",
      blocked: "blocked",
      cancelled: "cancelled",
    },
  },
  [TOOL_NAME_WRITE]: {
    name: "write",
    labels: {
      queued: "queued write",
      running: "writing",
      succeeded: "wrote",
      failed: "failed to write",
      blocked: "write blocked",
      cancelled: "write cancelled",
    },
  },
  [TOOL_NAME_EDIT]: {
    name: "edit",
    labels: {
      queued: "queued edit",
      running: "editing",
      succeeded: "edited",
      failed: "failed to edit",
      blocked: "edit blocked",
      cancelled: "edit cancelled",
    },
  },
  [TOOL_NAME_VIEW_IMAGE]: {
    name: "view image",
    labels: {
      queued: "queued view image",
      running: "viewing",
      succeeded: "viewed",
      failed: "failed to view",
      blocked: "view image blocked",
      cancelled: "view image cancelled",
    },
  },
  [TOOL_NAME_SPAWN_AGENT]: {
    name: "spawn agent",
    labels: {
      queued: "queued spawn",
      running: "spawning",
      succeeded: "spawned",
      failed: "spawn failed",
      blocked: "spawn blocked",
      cancelled: "spawn cancelled",
    },
  },
  [TOOL_NAME_SEND_INPUT_TO_AGENT]: {
    name: "send input",
    labels: {
      queued: "queued input",
      running: "sending input",
      succeeded: "sent input",
      failed: "failed to send input",
      blocked: "send input blocked",
      cancelled: "send input cancelled",
    },
  },
  [TOOL_NAME_WAIT_FOR_AGENTS]: {
    name: "wait for agents",
    labels: {
      queued: "queued wait",
      running: "waiting",
      succeeded: "finished waiting",
      failed: "wait failed",
      blocked: "wait blocked",
      cancelled: "wait cancelled",
    },
  },
  [TOOL_NAME_TERMINATE_AGENT]: {
    name: "terminate agent",
    labels: {
      queued: "queued termination",
      running: "terminating",
      succeeded: "terminated",
      failed: "failed to terminate",
      blocked: "termination blocked",
      cancelled: "termination cancelled",
    },
  },
};

const GENERIC_TOOL_STATUS_LABELS: Record<ToolUiLifecycleStatus, string> = {
  queued: "queued",
  running: "running",
  succeeded: "completed",
  failed: "failed",
  blocked: "blocked",
  cancelled: "cancelled",
};

function getToolUiLanguage(toolName: string): ToolUiLanguage | undefined {
  return Object.hasOwn(TOOL_UI_LANGUAGE, toolName) ? TOOL_UI_LANGUAGE[toolName] : undefined;
}

function getToolStatusLabel(toolName: string, status: ToolUiModel["status"]): string {
  if (status === "streaming") return "preparing";
  return getToolUiLanguage(toolName)?.labels[status] ?? GENERIC_TOOL_STATUS_LABELS[status];
}

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
    label,
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

function buildToolPendingView(theme: Theme, label: string, target: string): ToolOutputViewModel {
  const { palette, text } = theme;
  const pendingColor = (s: string) => palette.textMuted(s);

  const header = buildToolHeaderLine({
    bulletStyle: pendingColor,
    bullet: "⏵",
    label,
    labelStyle: palette.textMuted,
    accent: inlineText(target),
    accentStyle: palette.brandAccent,
  });

  return {
    borderColor: pendingColor,
    expanded: { title: pendingColor(text.bold(`${label} ${target}`)) },
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
  statusLabel?: string;
  message?: string;
}): ToolOutputViewModel {
  const { theme, label, target, status, statusLabel, message } = args;
  const { palette, text } = theme;
  const successColor = (s: string) => palette.actionSuccess(s);
  const errorColor = (s: string) => palette.actionError(s);
  const isSuccess = status === "success";
  const borderColor = isSuccess ? successColor : errorColor;
  const headerLabel =
    statusLabel ??
    (isSuccess ? label : status === "blocked" ? `${label} blocked` : `${label} failed`);

  const header = buildToolHeaderLine({
    bulletStyle: borderColor,
    bullet: isSuccess ? "✓" : "✗",
    label: headerLabel,
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

const TOOL_STARTED_ACTIVITY_TYPES = new Set<ToolActivity["type"]>([
  "bash_started",
  "spawn_agent_started",
  "send_input_to_agent_started",
  "wait_for_agents_started",
  "terminate_agent_started",
  "code_mode_started",
]);

function isStartedActivity(activity: ToolActivity | undefined): activity is ToolActivity {
  return Boolean(activity && TOOL_STARTED_ACTIVITY_TYPES.has(activity.type));
}

function terminalStatusFromActivity(
  activity: ToolActivity,
): "succeeded" | "failed" | "blocked" | "cancelled" | undefined {
  switch (activity.type) {
    case "tool_call_streaming":
    case "tool_call_queued":
    case "bash_started":
    case "spawn_agent_started":
    case "send_input_to_agent_started":
    case "wait_for_agents_started":
    case "terminate_agent_started":
    case "code_mode_started":
      return undefined;
    case "tool_call_blocked":
    case "bash_blocked":
    case "spawn_agent_blocked":
    case "send_input_to_agent_blocked":
    case "wait_for_agents_blocked":
    case "terminate_agent_blocked":
    case "code_mode_blocked":
    case "view_image_blocked":
    case "write_blocked":
    case "edit_blocked":
      return "blocked";
    case "bash_aborted":
      return "cancelled";
    case "bash_execution":
      return activity.exitCode === 0 ? "succeeded" : "failed";
    case "client_tool_finished":
    case "spawn_agent_finished":
    case "send_input_to_agent_finished":
    case "wait_for_agents_finished":
    case "terminate_agent_finished":
    case "code_mode_finished":
      return activity.status === "success" ? "succeeded" : "failed";
    case "view_image_success":
    case "write_success":
    case "edit_success":
      return "succeeded";
  }
}

function addCodePreview(
  view: ToolOutputViewModel,
  model: ToolUiModel,
  theme: Theme,
  status: "queued" | "running",
): ToolOutputViewModel {
  if (model.code === undefined) return view;
  return {
    ...view,
    compact: {
      header: buildCodeModeCompactHeader(theme, status, model.toolName),
      extraText: buildCodeModeCompactPreview(theme, model.code),
    },
  };
}

function buildGenericTerminalView(theme: Theme, model: ToolUiModel): ToolOutputViewModel {
  const { palette, text } = theme;
  const succeeded = model.status === "succeeded";
  const borderColor = succeeded
    ? (value: string) => palette.actionSuccess(value)
    : (value: string) => palette.actionError(value);
  const label = getToolStatusLabel(model.toolName, model.status);
  const target = model.code === undefined ? model.headerTarget : model.toolName;
  const resultText = model.resultText?.trim();
  const compactResult = resultText
    ? resultText
        .split(/\r?\n/)
        .slice(0, 8)
        .map((line) => `    ${palette.textDim(line)}`)
        .join("\n")
    : undefined;

  return {
    borderColor,
    expanded: {
      title: borderColor(text.bold(`${label} ${target}`)),
      sections: resultText ? [palette.actionOutput(resultText)] : [],
    },
    compact: {
      header: buildToolHeaderLine({
        bulletStyle: borderColor,
        bullet: succeeded ? "✓" : "✗",
        label,
        labelStyle: palette.textMuted,
        accent: inlineText(target),
        accentStyle: palette.brandAccent,
      }),
      extraText: compactResult,
    },
  };
}

export class ToolUiRegistry {
  private renderers = new Map<ToolActivity["type"], ToolUiRenderer>();

  register(type: ToolActivity["type"], renderer: ToolUiRenderer): void {
    this.renderers.set(type, renderer);
  }

  render(event: ToolActivity, context: ToolUiRenderContext): ToolOutputViewModel {
    const renderer = this.renderers.get(event.type);
    if (!renderer) {
      throw new Error(`missing tool ui renderer for event type '${event.type}'.`);
    }
    return renderer(event, context);
  }

  renderModel(model: ToolUiModel, context: ToolUiRenderContext): ToolOutputViewModel {
    if (model.status === "streaming") {
      const target = getToolUiLanguage(model.toolName)?.name ?? model.toolName;
      return buildToolPendingView(context.theme, "preparing", target);
    }
    if (model.status === "queued") {
      return addCodePreview(
        buildToolPendingView(
          context.theme,
          getToolStatusLabel(model.toolName, model.status),
          model.headerTarget,
        ),
        model,
        context.theme,
        "queued",
      );
    }
    if (model.status === "running") {
      if (isStartedActivity(model.activity)) {
        return this.render(model.activity, context);
      }
      return addCodePreview(
        buildSimpleToolRunningView(
          context.theme,
          getToolStatusLabel(model.toolName, model.status),
          model.headerTarget,
        ),
        model,
        context.theme,
        "running",
      );
    }
    if (model.activity && terminalStatusFromActivity(model.activity) === model.status) {
      return this.render(model.activity, context);
    }
    return buildGenericTerminalView(context.theme, model);
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
    const uiEvent = event as Extract<ToolActivity, { type: "tool_call_streaming" }>;
    const target = getToolUiLanguage(uiEvent.toolName)?.name ?? uiEvent.toolName;
    return buildToolPendingView(context.theme, "preparing", target);
  });

  registry.register("tool_call_queued", (event, context) => {
    const uiEvent = event as Extract<ToolActivity, { type: "tool_call_queued" }>;
    const view = buildToolPendingView(
      context.theme,
      getToolStatusLabel(uiEvent.toolName, "queued"),
      uiEvent.headerTarget,
    );
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
    const uiEvent = event as Extract<ToolActivity, { type: "tool_call_blocked" }>;
    return buildSimpleToolFinishedView({
      theme: context.theme,
      label: uiEvent.toolName,
      target: uiEvent.toolName,
      status: "blocked",
      statusLabel: getToolStatusLabel(uiEvent.toolName, "blocked"),
      message: uiEvent.reason,
    });
  });

  registry.register("client_tool_finished", (event, context) => {
    const uiEvent = event as Extract<ToolActivity, { type: "client_tool_finished" }>;
    return buildClientToolFinishedView({
      theme: context.theme,
      toolName: uiEvent.toolName,
      status: uiEvent.status,
      uiText: uiEvent.uiText,
    });
  });

  registry.register("bash_started", (event, context) => {
    const uiEvent = event as Extract<ToolActivity, { type: "bash_started" }>;
    return buildBashRunningView(context.theme, uiEvent.command, uiEvent.headerTarget);
  });

  registry.register("bash_execution", (event, context) => {
    const uiEvent = event as Extract<ToolActivity, { type: "bash_execution" }>;
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
    const uiEvent = event as Extract<ToolActivity, { type: "bash_aborted" }>;
    return buildBashAbortedView(
      context.theme,
      uiEvent.command,
      uiEvent.reason,
      uiEvent.headerTarget,
    );
  });

  registry.register("bash_blocked", (event, context) => {
    const uiEvent = event as Extract<ToolActivity, { type: "bash_blocked" }>;
    return buildBashBlockedView(
      context.theme,
      uiEvent.command,
      uiEvent.reason,
      uiEvent.headerTarget,
    );
  });

  registry.register("spawn_agent_started", (event, context) => {
    const uiEvent = event as Extract<ToolActivity, { type: "spawn_agent_started" }>;
    return buildSubagentRunningView({
      theme: context.theme,
      label: getToolStatusLabel(TOOL_NAME_SPAWN_AGENT, "running"),
      title: uiEvent.headerTarget,
    });
  });

  registry.register("spawn_agent_finished", (event, context) => {
    const uiEvent = event as Extract<ToolActivity, { type: "spawn_agent_finished" }>;
    const title = formatSubagentTitle(uiEvent.headerTarget);
    return buildSubagentFinishedView({
      theme: context.theme,
      label: getToolStatusLabel(TOOL_NAME_SPAWN_AGENT, "succeeded"),
      failureLabel: getToolStatusLabel(TOOL_NAME_SPAWN_AGENT, "failed"),
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
    const uiEvent = event as Extract<ToolActivity, { type: "spawn_agent_blocked" }>;
    const title = formatSubagentTitle(uiEvent.headerTarget);
    return buildSimpleToolFinishedView({
      theme: context.theme,
      label: "spawn",
      target: title,
      status: "blocked",
      statusLabel: getToolStatusLabel(TOOL_NAME_SPAWN_AGENT, "blocked"),
      message: uiEvent.reason,
    });
  });

  registry.register("send_input_to_agent_started", (event, context) => {
    const uiEvent = event as Extract<ToolActivity, { type: "send_input_to_agent_started" }>;
    const title = formatSubagentTitle(uiEvent.headerTarget);
    return buildSubagentRunningView({
      theme: context.theme,
      label: getToolStatusLabel(TOOL_NAME_SEND_INPUT_TO_AGENT, "running"),
      title,
    });
  });

  registry.register("send_input_to_agent_finished", (event, context) => {
    const uiEvent = event as Extract<ToolActivity, { type: "send_input_to_agent_finished" }>;
    const title = formatSubagentTitle(uiEvent.headerTarget);
    return buildSubagentFinishedView({
      theme: context.theme,
      label: getToolStatusLabel(TOOL_NAME_SEND_INPUT_TO_AGENT, "succeeded"),
      failureLabel: getToolStatusLabel(TOOL_NAME_SEND_INPUT_TO_AGENT, "failed"),
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
    const uiEvent = event as Extract<ToolActivity, { type: "send_input_to_agent_blocked" }>;
    const title = formatSubagentTitle(uiEvent.headerTarget);
    return buildSimpleToolFinishedView({
      theme: context.theme,
      label: "send input",
      target: title,
      status: "blocked",
      statusLabel: getToolStatusLabel(TOOL_NAME_SEND_INPUT_TO_AGENT, "blocked"),
      message: uiEvent.reason,
    });
  });

  registry.register("wait_for_agents_started", (event, context) => {
    const uiEvent = event as Extract<ToolActivity, { type: "wait_for_agents_started" }>;
    const title = uiEvent.headerTarget;
    return buildSubagentRunningView({
      theme: context.theme,
      label: getToolStatusLabel(TOOL_NAME_WAIT_FOR_AGENTS, "running"),
      title,
    });
  });

  registry.register("wait_for_agents_finished", (event, context) => {
    const uiEvent = event as Extract<ToolActivity, { type: "wait_for_agents_finished" }>;
    const title = uiEvent.headerTarget;
    return buildSubagentFinishedView({
      theme: context.theme,
      label: getToolStatusLabel(TOOL_NAME_WAIT_FOR_AGENTS, "succeeded"),
      failureLabel: getToolStatusLabel(TOOL_NAME_WAIT_FOR_AGENTS, "failed"),
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
    const uiEvent = event as Extract<ToolActivity, { type: "wait_for_agents_blocked" }>;
    const title = uiEvent.headerTarget;
    return buildSimpleToolFinishedView({
      theme: context.theme,
      label: "wait",
      target: title,
      status: "blocked",
      statusLabel: getToolStatusLabel(TOOL_NAME_WAIT_FOR_AGENTS, "blocked"),
      message: uiEvent.reason,
    });
  });

  registry.register("terminate_agent_started", (event, context) => {
    const uiEvent = event as Extract<ToolActivity, { type: "terminate_agent_started" }>;
    return buildSubagentRunningView({
      theme: context.theme,
      label: getToolStatusLabel(TOOL_NAME_TERMINATE_AGENT, "running"),
      title: uiEvent.headerTarget,
    });
  });

  registry.register("terminate_agent_finished", (event, context) => {
    const uiEvent = event as Extract<ToolActivity, { type: "terminate_agent_finished" }>;
    const title = formatSubagentTitle(uiEvent.headerTarget);
    const fallbackMessage =
      uiEvent.finalStatus && uiEvent.finalStatus !== "success"
        ? `final status: ${uiEvent.finalStatus}`
        : uiEvent.message;
    return buildSubagentFinishedView({
      theme: context.theme,
      label: getToolStatusLabel(TOOL_NAME_TERMINATE_AGENT, "succeeded"),
      failureLabel: getToolStatusLabel(TOOL_NAME_TERMINATE_AGENT, "failed"),
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
    const uiEvent = event as Extract<ToolActivity, { type: "terminate_agent_blocked" }>;
    const title = formatSubagentTitle(uiEvent.headerTarget);
    return buildSimpleToolFinishedView({
      theme: context.theme,
      label: "terminate",
      target: title,
      status: "blocked",
      statusLabel: getToolStatusLabel(TOOL_NAME_TERMINATE_AGENT, "blocked"),
      message: uiEvent.reason,
    });
  });

  registry.register("code_mode_started", (event, context) => {
    const uiEvent = event as Extract<ToolActivity, { type: "code_mode_started" }>;
    const view = buildSimpleToolRunningView(context.theme, uiEvent.toolName, uiEvent.headerTarget);
    return {
      ...view,
      compact: {
        header: buildCodeModeCompactHeader(context.theme, "running", uiEvent.toolName),
        extraText: buildCodeModeCompactPreview(context.theme, uiEvent.code),
      },
    };
  });

  registry.register("code_mode_finished", (event, context) => {
    const uiEvent = event as Extract<ToolActivity, { type: "code_mode_finished" }>;
    const view = buildClientToolFinishedView({
      theme: context.theme,
      toolName: uiEvent.toolName,
      status: uiEvent.status,
      uiText: uiEvent.uiText,
    });
    const status = uiEvent.status === "success" ? "completed" : "failed";
    return {
      ...view,
      compact: {
        header: buildCodeModeCompactHeader(context.theme, status, uiEvent.toolName),
        extraText: joinCodeModeCompactSections(
          buildCodeModeCompactPreview(context.theme, uiEvent.code),
          view.compact.extraText,
        ),
      },
    };
  });

  registry.register("code_mode_blocked", (event, context) => {
    const uiEvent = event as Extract<ToolActivity, { type: "code_mode_blocked" }>;
    const view = buildSimpleToolFinishedView({
      theme: context.theme,
      label: uiEvent.toolName,
      target: uiEvent.headerTarget,
      status: "blocked",
      message: uiEvent.reason,
    });
    return {
      ...view,
      compact: {
        header: buildCodeModeCompactHeader(context.theme, "blocked", uiEvent.toolName),
        extraText: joinCodeModeCompactSections(
          buildCodeModeCompactPreview(context.theme, uiEvent.code),
          view.compact.extraText,
        ),
      },
    };
  });

  registry.register("write_success", (event, context) => {
    const uiEvent = event as Extract<ToolActivity, { type: "write_success" }>;
    return buildWriteSuccessView(context.theme, uiEvent.path, uiEvent.uiText, uiEvent.headerTarget);
  });

  registry.register("write_blocked", (event, context) => {
    const uiEvent = event as Extract<ToolActivity, { type: "write_blocked" }>;
    return buildWriteBlockedView(context.theme, uiEvent.path, uiEvent.reason, uiEvent.headerTarget);
  });

  registry.register("edit_success", (event, context) => {
    const uiEvent = event as Extract<ToolActivity, { type: "edit_success" }>;
    return buildEditSuccessView(context.theme, uiEvent.path, uiEvent.uiText, uiEvent.headerTarget);
  });

  registry.register("edit_blocked", (event, context) => {
    const uiEvent = event as Extract<ToolActivity, { type: "edit_blocked" }>;
    return buildEditBlockedView(context.theme, uiEvent.path, uiEvent.reason, uiEvent.headerTarget);
  });

  registry.register("view_image_success", (event, context) => {
    const uiEvent = event as Extract<ToolActivity, { type: "view_image_success" }>;
    return buildViewImageSuccessView(
      context.theme,
      uiEvent.path,
      uiEvent.uiText,
      uiEvent.headerTarget,
    );
  });

  registry.register("view_image_blocked", (event, context) => {
    const uiEvent = event as Extract<ToolActivity, { type: "view_image_blocked" }>;
    return buildViewImageBlockedView(
      context.theme,
      uiEvent.path,
      uiEvent.reason,
      uiEvent.headerTarget,
    );
  });

  return registry;
}
