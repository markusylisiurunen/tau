import type { Component } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { DiffReviewAgentActivity } from "../../core/diff_review/index.js";
import { formatUsageSnapshot, formatUsdCost } from "../../core/utils/format.js";
import { formatAgentActivityText } from "./agent_activity_format.js";
import {
  type OneLineSegment,
  truncateFromEndByWidthPreserveAnsi,
} from "./components/one_line_segments.js";
import type { UiComponent } from "./components/ui_component.js";
import type { Theme } from "./theme/index.js";

export type DiffReviewMessageReviewAgent = DiffReviewAgentActivity;

export type DiffReviewMessageStatus = "preparing" | "active" | "returned" | "cancelled" | "failed";

export type DiffReviewMessageModel = {
  status: DiffReviewMessageStatus;
  command: string;
  uiText?: string;
  detail?: string;
  reviewAgents?: DiffReviewMessageReviewAgent[];
};

type DiffReviewLine = OneLineSegment[];

export class DiffReviewMessageComponent implements Component, UiComponent<DiffReviewMessageModel> {
  private theme: Theme;
  private model: DiffReviewMessageModel;

  constructor(theme: Theme, model: DiffReviewMessageModel) {
    this.theme = theme;
    this.model = model;
  }

  setTheme(theme: Theme): void {
    this.theme = theme;
  }

  update(model: DiffReviewMessageModel): void {
    this.model = model;
  }

  invalidate() {}

  render(width: number): string[] {
    if (width <= 0) {
      return [""];
    }

    const lines = buildDiffReviewLines(this.theme, this.model);
    const contentWidth = Math.max(0, width - 2);
    return [
      this.renderBlankLine(width),
      ...lines.map((line) => this.renderLine(line, width, contentWidth)),
      this.renderBlankLine(width),
    ];
  }

  private renderBlankLine(width: number): string {
    if (width < 2) {
      return "";
    }
    return this.theme.palette.userReviewSurface(" ".repeat(width));
  }

  private renderLine(line: DiffReviewLine, width: number, contentWidth: number): string {
    const truncatedLine = truncateLineSegments(line, contentWidth);
    const usedWidth = truncatedLine.reduce((sum, segment) => sum + visibleWidth(segment.text), 0);
    const body = truncatedLine.map((segment) => segment.style(segment.text)).join("");

    if (width < 2) {
      return truncateFromEndByWidthPreserveAnsi(body, width);
    }

    const rightPad = this.theme.palette.userReviewSurface(
      " ".repeat(Math.max(0, contentWidth - usedWidth) + 1),
    );
    return `${this.theme.palette.userReviewSurface(" ")}${body}${rightPad}`;
  }
}

function buildDiffReviewLines(theme: Theme, model: DiffReviewMessageModel): DiffReviewLine[] {
  const lines: DiffReviewLine[] = [
    [
      reviewMain(theme, `diff tool ${getStatusLabel(model.status)}`),
      reviewMuted(theme, ` (${model.command})`),
    ],
  ];

  if (model.status === "active" || model.status === "preparing") {
    const diffToolLines = splitUiText(model.uiText).map((line) => [reviewDim(theme, line)]);
    if (diffToolLines.length > 0) {
      lines.push(...diffToolLines);
    }

    const reviewAgentLines = buildReviewAgentLines(theme, model.reviewAgents);
    if (reviewAgentLines.length > 0) {
      if (diffToolLines.length > 0) {
        lines.push([]);
      }
      lines.push(...reviewAgentLines);
    }
  } else if (model.status === "failed" && model.detail?.trim()) {
    lines.push([reviewMuted(theme, model.detail.trim())]);
  }

  return trimTrailingBlankLines(lines);
}

function buildReviewAgentLines(
  theme: Theme,
  reviewAgents: DiffReviewMessageReviewAgent[] | undefined,
): DiffReviewLine[] {
  if (!reviewAgents || reviewAgents.length === 0) {
    return [];
  }

  const lines: DiffReviewLine[] = [];
  reviewAgents.forEach((agent, index) => {
    lines.push([reviewMain(theme, agent.threadId), reviewMuted(theme, ` (${agent.status})`)]);

    const activityText = formatAgentActivityText(agent.lastActivityText ?? "");
    if (activityText) {
      lines.push([reviewDim(theme, activityText)]);
    }

    lines.push([
      reviewMuted(theme, `${formatUsageSnapshot(agent.usage)} · ${formatUsdCost(agent.costTotal)}`),
    ]);

    if (index < reviewAgents.length - 1) {
      lines.push([]);
    }
  });

  return lines;
}

function reviewMain(theme: Theme, text: string): OneLineSegment {
  return createReviewSegment(theme, theme.palette.userReviewText, text);
}

function reviewMuted(theme: Theme, text: string): OneLineSegment {
  return createReviewSegment(theme, theme.palette.userReviewTextMuted, text);
}

function reviewDim(theme: Theme, text: string): OneLineSegment {
  return createReviewSegment(theme, theme.palette.userReviewTextDim, text);
}

function createReviewSegment(
  theme: Theme,
  textColor: (text: string) => string,
  text: string,
): OneLineSegment {
  return {
    text,
    style: (value) => theme.palette.userReviewSurface(textColor(value)),
  };
}

function getStatusLabel(status: DiffReviewMessageStatus): string {
  switch (status) {
    case "preparing":
      return "preparing";
    case "active":
      return "active";
    case "returned":
      return "completed";
    case "cancelled":
      return "cancelled";
    case "failed":
      return "failed";
  }
}

function splitUiText(text: string | undefined): string[] {
  const trimmed = text?.trim();
  if (!trimmed) {
    return [];
  }

  return trimmed.split(/\r?\n/).map((line) => line.trimEnd());
}

function truncateLineSegments(segments: DiffReviewLine, maxWidth: number): DiffReviewLine {
  if (maxWidth <= 0 || segments.length === 0) {
    return [];
  }

  const totalWidth = segments.reduce((sum, segment) => sum + visibleWidth(segment.text), 0);
  if (totalWidth <= maxWidth) {
    return segments;
  }

  const contentWidth = Math.max(0, maxWidth - 1);
  const truncated: DiffReviewLine = [];
  let usedWidth = 0;

  for (const segment of segments) {
    if (usedWidth >= contentWidth) {
      break;
    }

    const remainingWidth = contentWidth - usedWidth;
    const segmentWidth = visibleWidth(segment.text);
    if (segmentWidth <= remainingWidth) {
      truncated.push(segment);
      usedWidth += segmentWidth;
      continue;
    }

    const partial = truncateToWidth(segment.text, remainingWidth, "");
    if (partial.length > 0) {
      truncated.push({ ...segment, text: partial });
    }
    break;
  }

  const ellipsisSegment = truncated[truncated.length - 1] ?? segments[0];
  return ellipsisSegment ? [...truncated, { ...ellipsisSegment, text: "…" }] : [];
}

function trimTrailingBlankLines(lines: DiffReviewLine[]): DiffReviewLine[] {
  let end = lines.length;
  while (end > 0 && lines[end - 1]?.length === 0) {
    end -= 1;
  }
  return lines.slice(0, end);
}
