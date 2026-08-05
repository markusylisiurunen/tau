import { Container, Text } from "@earendil-works/pi-tui";
import type { ToolCardLine } from "../../core/tools/presentation.js";
import type { UiComponent } from "./components/ui_component.js";
import type { Theme } from "./theme/index.js";
import type { ToolUiModel } from "./tool_ui_model.js";

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
      return theme.palette.textMuted;
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

function styleDetail(line: ToolCardLine, theme: Theme): string {
  switch (line.tone) {
    case "added":
      return theme.palette.diffAdd(line.text);
    case "removed":
      return theme.palette.diffRemove(line.text);
    case "error":
      return theme.palette.actionError(line.text);
    case undefined:
      return theme.palette.textDim(line.text);
  }
}

function renderToolCard(model: ToolUiModel, theme: Theme): string {
  const status = getPresentationStatus(model.status);
  const statusStyle = getStatusStyle(model.status, theme);
  const action = model.presentation.actionByStatus[status];
  const subjectLines = model.presentation.subject.split("\n");
  const firstSubjectLine = subjectLines[0] ?? "";
  const lines = [
    ` ${statusStyle(getMarker(model.status))} ${theme.palette.textMuted(action)} ${theme.palette.brandAccent(firstSubjectLine)}`,
    ...subjectLines.slice(1).map((line) => ` ${theme.palette.brandAccent(line)}`),
    ...model.presentation.details.map((line) => ` ${styleDetail(line, theme)}`),
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

export class ToolCardComponent extends Container implements UiComponent<ToolCardProps> {
  constructor(props: ToolCardProps) {
    super();
    this.update(props);
  }

  update(props: ToolCardProps): void {
    this.clear();
    this.addChild(new Text(renderToolCard(props.model, props.theme), 0, 0));
  }
}
