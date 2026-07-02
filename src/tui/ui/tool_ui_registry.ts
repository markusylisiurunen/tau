import type { DiffReviewAgentActivity } from "../../core/diff_review/index.js";
import type { ToolUiEvent, ToolUiText } from "../../core/tools/registry.js";
import { formatUsageSnapshot, formatUsdCost } from "../../core/utils/format.js";
import { formatToolActivityText } from "./agent_activity_format.js";
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

function buildToolQueuedView(theme: Theme, toolName: string): ToolOutputViewModel {
  const { palette, text } = theme;
  const queuedColor = (s: string) => palette.textMuted(s);

  const header = buildToolHeaderLine({
    bulletStyle: queuedColor,
    bullet: "⏵",
    label: "queued",
    labelStyle: palette.textMuted,
    accent: inlineText(toolName),
    accentStyle: palette.brandAccent,
  });

  return {
    borderColor: queuedColor,
    expanded: { title: queuedColor(text.bold(`queued ${toolName}`)) },
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

function formatDiffReviewTitle(command: string | undefined): string {
  const trimmed = command?.trim() ?? "";
  return trimmed || "current working tree";
}

function splitDiffToolUiText(text: string | undefined): string[] {
  const trimmed = text?.trim();
  return trimmed ? trimmed.split(/\r?\n/).map((line) => line.trimEnd()) : [];
}

function buildDiffReviewAgentLines(reviewAgents: DiffReviewAgentActivity[]): string[] {
  const lines: string[] = [];
  reviewAgents.forEach((agent, index) => {
    lines.push(`${agent.threadId} (${agent.status})`);

    const activityText = formatToolActivityText(agent.lastActivityText ?? "");
    if (activityText) {
      lines.push(activityText);
    }

    lines.push(`${formatUsageSnapshot(agent.usage)} · ${formatUsdCost(agent.costTotal)}`);

    if (index < reviewAgents.length - 1) {
      lines.push("");
    }
  });
  return lines;
}

function buildDiffReviewUiText(args: {
  diffToolUiText?: string;
  reviewAgents: DiffReviewAgentActivity[];
  reviewedFiles: string[];
  message?: string;
  status: string;
}): ToolUiText {
  const diffToolLines = splitDiffToolUiText(args.diffToolUiText);
  const agentLines = buildDiffReviewAgentLines(args.reviewAgents);
  const separator = diffToolLines.length > 0 && agentLines.length > 0 ? [""] : [];
  const lines = [...diffToolLines, ...separator, ...agentLines];
  const fallbackLines = args.message ? [args.message] : [];
  const contentLines = lines.length > 0 ? lines : fallbackLines;
  const fileCount = args.reviewedFiles.length;
  const fileLabel = `${fileCount} reviewed file${fileCount === 1 ? "" : "s"}`;
  const statusLine = [args.status, fileLabel].filter(Boolean).join(" · ");

  return {
    previewLines: contentLines.map((text) => ({ text })),
    statusLine,
    fullLines: contentLines.map((text) => ({ text })),
  };
}

function buildDiffReviewRunningView(args: {
  theme: Theme;
  command: string;
  uiText?: ToolUiText;
}): ToolOutputViewModel {
  const { theme, command, uiText } = args;
  const { palette, text } = theme;
  const runningColor = (s: string) => palette.actionRunning(s);
  const title = formatDiffReviewTitle(command);

  const header = buildToolHeaderLine({
    bulletStyle: runningColor,
    bullet: "⏵",
    label: "diff review",
    labelStyle: palette.textMuted,
    accent: inlineText(title),
    accentStyle: palette.brandAccent,
  });

  const compactText = uiText
    ? renderToolUiCompactText({
        uiText,
        theme,
        previewStyle: palette.textDim,
        statusStyle: palette.textMuted,
      })
    : undefined;
  const fullText = uiText
    ? renderToolUiTextLines({
        uiText,
        kind: "full",
        theme,
        baseStyle: palette.actionOutput,
      })
    : undefined;

  return {
    borderColor: runningColor,
    expanded: {
      title: runningColor(text.bold(`diff review ${title}`)),
      sections: fullText ? [fullText] : [],
    },
    compact: { header, extraText: compactText },
  };
}

function buildDiffReviewFinishedView(args: {
  theme: Theme;
  command: string;
  status: "success" | "cancelled" | "error";
  uiText: ToolUiText;
}): ToolOutputViewModel {
  const { theme, command, status, uiText } = args;
  const { palette, text } = theme;
  const isSuccess = status === "success";
  const isCancelled = status === "cancelled";
  const borderColor = isSuccess
    ? (s: string) => palette.actionSuccess(s)
    : isCancelled
      ? (s: string) => palette.statusWarn(s)
      : (s: string) => palette.actionError(s);
  const title = formatDiffReviewTitle(command);
  const label = isSuccess
    ? "diff reviewed"
    : isCancelled
      ? "diff review cancelled"
      : "diff review failed";

  const header = buildToolHeaderLine({
    bulletStyle: borderColor,
    bullet: isSuccess ? "✓" : "✗",
    label,
    labelStyle: palette.textMuted,
    accent: inlineText(title),
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
      title: borderColor(text.bold(`diff review ${title}`)),
      sections: fullText ? [fullText] : [],
    },
    compact: { header, extraText: compactText },
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

  registry.register("tool_call_queued", (event, context) => {
    const uiEvent = event as Extract<ToolUiEvent, { type: "tool_call_queued" }>;
    return buildToolQueuedView(context.theme, uiEvent.toolName);
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

  registry.register("diff_review_started", (event, context) => {
    const uiEvent = event as Extract<ToolUiEvent, { type: "diff_review_started" }>;
    return buildDiffReviewRunningView({
      theme: context.theme,
      command: uiEvent.command,
    });
  });

  registry.register("diff_review_updated", (event, context) => {
    const uiEvent = event as Extract<ToolUiEvent, { type: "diff_review_updated" }>;
    return buildDiffReviewRunningView({
      theme: context.theme,
      command: uiEvent.command,
      uiText: buildDiffReviewUiText({
        diffToolUiText: uiEvent.diffToolUiText,
        reviewAgents: uiEvent.reviewAgents,
        reviewedFiles: uiEvent.reviewedFiles,
        status: "active",
      }),
    });
  });

  registry.register("diff_review_finished", (event, context) => {
    const uiEvent = event as Extract<ToolUiEvent, { type: "diff_review_finished" }>;
    return buildDiffReviewFinishedView({
      theme: context.theme,
      command: uiEvent.command,
      status: uiEvent.status,
      uiText:
        uiEvent.uiText ??
        buildDiffReviewUiText({
          diffToolUiText: uiEvent.diffToolUiText,
          reviewAgents: uiEvent.reviewAgents,
          reviewedFiles: uiEvent.reviewedFiles,
          message: uiEvent.message,
          status: uiEvent.status,
        }),
    });
  });

  registry.register("diff_review_blocked", (event, context) => {
    const uiEvent = event as Extract<ToolUiEvent, { type: "diff_review_blocked" }>;
    return buildSimpleToolFinishedView({
      theme: context.theme,
      label: "diff review",
      target: uiEvent.headerTarget,
      status: "error",
      message: uiEvent.reason,
    });
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

  registry.register("web_search_started", (event, context) => {
    const uiEvent = event as Extract<ToolUiEvent, { type: "web_search_started" }>;
    return buildSimpleToolRunningView(context.theme, "web search", uiEvent.headerTarget);
  });

  registry.register("web_search_finished", (event, context) => {
    const uiEvent = event as Extract<ToolUiEvent, { type: "web_search_finished" }>;
    return buildSimpleToolFinishedView({
      theme: context.theme,
      label: "web search",
      target: uiEvent.headerTarget,
      status: uiEvent.status,
      message: uiEvent.message,
    });
  });

  registry.register("web_fetch_started", (event, context) => {
    const uiEvent = event as Extract<ToolUiEvent, { type: "web_fetch_started" }>;
    return buildSimpleToolRunningView(context.theme, "web fetch", uiEvent.headerTarget);
  });

  registry.register("web_fetch_finished", (event, context) => {
    const uiEvent = event as Extract<ToolUiEvent, { type: "web_fetch_finished" }>;
    return buildSimpleToolFinishedView({
      theme: context.theme,
      label: "web fetch",
      target: uiEvent.headerTarget,
      status: uiEvent.status,
      message: uiEvent.message,
    });
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
