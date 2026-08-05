import { type Component, Text, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { ToolCardLine } from "../../core/tools/presentation.js";
import type { UiComponent } from "./components/ui_component.js";
import type { Theme } from "./theme/index.js";
import type { ToolUiModel } from "./tool_ui_model.js";

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });

function getPresentationStatus(
  status: ToolUiModel["status"],
): keyof ToolUiModel["presentation"]["actionByStatus"] {
  return status === "streaming" ? "preparing" : status;
}

function getMarker(status: ToolUiModel["status"]): string {
  switch (status) {
    case "streaming":
    case "queued":
    case "running":
      return "⏵";
    case "succeeded":
      return "✓";
    case "failed":
    case "blocked":
    case "cancelled":
      return "✗";
  }
}

function getStatusStyle(status: ToolUiModel["status"], theme: Theme): (text: string) => string {
  switch (status) {
    case "streaming":
    case "queued":
    case "running":
      return theme.palette.actionRunning;
    case "succeeded":
      return theme.palette.actionSuccess;
    case "failed":
    case "blocked":
      return theme.palette.actionError;
    case "cancelled":
      return theme.palette.statusWarn;
  }
}

function getActionText(model: ToolUiModel): string {
  const status = getPresentationStatus(model.status);
  const action = model.presentation.actionByStatus[status];
  return model.presentation.operation ? `${action} ${model.presentation.operation}` : action;
}

function styleDetail(line: ToolCardLine, theme: Theme): string {
  switch (line.tone) {
    case "added":
      return theme.palette.diffAdd(line.text);
    case "removed":
      return theme.palette.diffRemove(line.text);
    case "error":
      return theme.palette.textDim(line.text);
    case undefined:
      return theme.palette.textDim(line.text);
  }
}

function wrapByCharacter(
  text: string,
  firstLineWidth: number,
  continuationWidth: number,
): string[] {
  let availableWidth = Math.max(1, firstLineWidth);
  const nextLineWidth = Math.max(1, continuationWidth);
  const output: string[] = [];

  for (const inputLine of text.replace(/\t/g, "   ").split("\n")) {
    if (inputLine.length === 0) {
      output.push("");
      availableWidth = nextLineWidth;
      continue;
    }

    let line = "";
    let lineWidth = 0;
    for (const { segment } of graphemeSegmenter.segment(inputLine)) {
      const segmentWidth = visibleWidth(segment);
      if (line && lineWidth + segmentWidth > availableWidth) {
        output.push(line);
        line = "";
        lineWidth = 0;
        availableWidth = nextLineWidth;
      }
      line += segment;
      lineWidth += segmentWidth;
    }
    output.push(line);
    availableWidth = nextLineWidth;
  }

  return output;
}

function wrapByWord(text: string, firstLineWidth: number, continuationWidth: number): string[] {
  const inputLines = text.replace(/\t/g, "   ").split("\n");
  const output: string[] = [];
  let isFirstLine = true;

  for (const inputLine of inputLines) {
    if (!isFirstLine) {
      output.push(...wrapTextWithAnsi(inputLine, Math.max(1, continuationWidth)));
      continue;
    }

    const firstLine = wrapTextWithAnsi(inputLine, Math.max(1, firstLineWidth))[0] ?? "";
    output.push(firstLine);
    const remaining = inputLine.slice(firstLine.length).trimStart();
    if (remaining) {
      output.push(...wrapTextWithAnsi(remaining, Math.max(1, continuationWidth)));
    }
    isFirstLine = false;
  }

  return output;
}

function wrapSubject(model: ToolUiModel, width: number): string {
  const prefixWidth = visibleWidth(` ${getMarker(model.status)} ${getActionText(model)} `);
  const lines =
    model.presentation.subjectWrap === "character"
      ? wrapByCharacter(model.presentation.subject, width - prefixWidth, width - 1)
      : wrapByWord(model.presentation.subject, width - prefixWidth, width - 1);
  return lines.join("\n");
}

function renderToolCard(model: ToolUiModel, theme: Theme, subject: string, width: number): string {
  const statusStyle = getStatusStyle(model.status, theme);
  const actionText = getActionText(model);
  const subjectLines = subject.split("\n");
  const firstSubjectLine = subjectLines[0] ?? "";
  const lines = [
    ` ${statusStyle(getMarker(model.status))} ${theme.palette.textMuted(actionText)} ${theme.palette.brandAccent(firstSubjectLine)}`,
    ...subjectLines.slice(1).map((line) => ` ${theme.palette.brandAccent(line)}`),
    ...model.presentation.details.flatMap((line) => {
      const detailLines =
        line.wrap === "character" ? wrapByCharacter(line.text, width - 1, width - 1) : [line.text];
      return detailLines.map((text) => ` ${styleDetail({ ...line, text }, theme)}`);
    }),
  ];
  if (model.presentation.metadata.length > 0) {
    lines.push(` ${theme.palette.textMuted(`(${model.presentation.metadata.join(" · ")})`)}`);
  }
  return lines.join("\n");
}

export type ToolCardProps = {
  model: ToolUiModel;
  theme: Theme;
};

export class ToolCardComponent implements Component, UiComponent<ToolCardProps> {
  constructor(private props: ToolCardProps) {}

  update(props: ToolCardProps): void {
    this.props = props;
  }

  invalidate(): void {}

  render(width: number): string[] {
    const { model, theme } = this.props;
    const subject = wrapSubject(model, width);
    return new Text(renderToolCard(model, theme, subject, width), 0, 0).render(width);
  }
}
