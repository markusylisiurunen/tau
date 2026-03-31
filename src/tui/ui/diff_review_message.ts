import type { Theme } from "./theme/index.js";
import {
  buildSection,
  buildToolHeaderLine,
  inlineText,
  type ToolOutputViewModel,
} from "./tool_output.js";

export type DiffReviewMessageReviewAgent =
  | {
      status: "idle";
    }
  | {
      status: "running";
      threadId: string;
    };

export type DiffReviewMessageStatus = "preparing" | "active" | "returned" | "cancelled" | "failed";

export type DiffReviewMessageModel = {
  status: DiffReviewMessageStatus;
  command: string;
  uiText?: string;
  detail?: string;
  reviewAgent?: DiffReviewMessageReviewAgent;
};

export function buildDiffReviewMessageView(
  theme: Theme,
  model: DiffReviewMessageModel,
): ToolOutputViewModel {
  const { palette, text } = theme;
  const statusMeta = getStatusMeta(theme, model.status);
  const title = statusMeta.color(text.bold(`diff review ${statusMeta.label}`));
  const commandSection = buildSection([palette.textMuted(`command: ${model.command}`)]);
  const uiSection = buildSection(
    splitUiText(model.uiText).map((line) => palette.actionOutput(line)),
  );
  const reviewAgentSection = buildSection([
    model.reviewAgent?.status === "running"
      ? palette.actionRunning(
          `review agent: answering ${formatThreadId(model.reviewAgent.threadId)}`,
        )
      : undefined,
  ]);
  const detailSection = buildSection([
    model.detail?.trim() ? statusMeta.color(model.detail.trim()) : undefined,
  ]);
  const sections = [commandSection, uiSection, reviewAgentSection, detailSection].filter(
    (section): section is string => Boolean(section),
  );

  return {
    borderColor: statusMeta.color,
    expanded: {
      title,
      sections,
    },
    compact: {
      header: buildToolHeaderLine({
        bulletStyle: statusMeta.color,
        bullet: "◈",
        label: "diff review",
        labelStyle: palette.textMuted,
        accent: inlineText(statusMeta.label),
        accentStyle: statusMeta.color,
      }),
      extraText: sections.join("\n"),
    },
  };
}

function getStatusMeta(
  theme: Theme,
  status: DiffReviewMessageStatus,
): {
  label: string;
  color: (text: string) => string;
} {
  switch (status) {
    case "preparing":
      return {
        label: "preparing",
        color: theme.palette.actionRunning,
      };
    case "active":
      return {
        label: "active",
        color: theme.palette.actionRunning,
      };
    case "returned":
      return {
        label: "completed",
        color: theme.palette.actionSuccess,
      };
    case "cancelled":
      return {
        label: "cancelled",
        color: theme.palette.statusWarn,
      };
    case "failed":
      return {
        label: "failed",
        color: theme.palette.actionError,
      };
  }
}

function splitUiText(text: string | undefined): string[] {
  const trimmed = text?.trim();
  if (!trimmed) {
    return [];
  }

  return trimmed
    .split(/\r?\n/)
    .map((line) => line.trimEnd())
    .filter((line) => line.length > 0);
}

function formatThreadId(threadId: string): string {
  const trimmed = threadId.trim();
  if (trimmed.length <= 24) {
    return trimmed;
  }
  return `${trimmed.slice(0, 21)}...`;
}
