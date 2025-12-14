import { Text } from "@mariozechner/pi-tui";
import { formatAdaptiveNumber } from "../utils/format.js";
import type { OneLineSegment } from "./components/one_line_segments.js";
import { PaddedContainer } from "./components/padded_container.js";
import { theme } from "./theme.js";
import { ToolOutputComponent } from "./tool_output.js";

function bold(text: string): string {
  return `\u001b[1m${text}\u001b[22m`;
}

function formatCost(costTotal: number): string {
  return `$${formatAdaptiveNumber(costTotal, 2, 5)}`;
}

function lastLines(text: string, maxLines: number): string {
  const lines = text.trim().split("\n");
  return lines.slice(-maxLines).join("\n").trim();
}

export function renderTaskRunning(
  title: string,
  lastEvents: string[],
  costTotal: number,
  turns: number,
  toolCalls: number,
  compact: boolean,
): ToolOutputComponent {
  const { palette } = theme;
  const runningColor = (s: string) => palette.taskRunning(s);

  const segments: OneLineSegment[] = [
    { text: " ", style: (s) => s },
    { text: "▪", style: runningColor },
    { text: " ", style: (s) => s },
    { text: "task", style: palette.muted },
    { text: " ", style: (s) => s },
    { text: "running", style: palette.muted },
    { text: " ", style: (s) => s },
    { text: title.trim(), style: palette.accent },
  ];

  const stats = `turns: ${turns}, tool calls: ${toolCalls}`;
  const eventsText = lastEvents.map((e) => e.trim()).join("\n");
  const costLine = palette.dim(`cost: ${formatCost(costTotal)} (${stats})`);

  const extraParts: string[] = [];
  if (eventsText) {
    extraParts.push(palette.taskPreview(eventsText));
  }
  extraParts.push(costLine);

  const expandedParts: string[] = [runningColor(bold(`task: ${title}`))];
  if (eventsText) {
    expandedParts.push("");
    expandedParts.push(palette.taskPreview(eventsText));
  }
  expandedParts.push("");
  expandedParts.push(palette.dim(`cost: ${formatCost(costTotal)} (${stats})`));

  return new ToolOutputComponent({
    compact,
    expanded: { borderColor: runningColor, text: expandedParts.join("\n") },
    compactView: {
      segments,
      flexIndices: [7],
      extraComponent: new PaddedContainer(new Text(extraParts.join("\n"), 0, 0), 4),
    },
  });
}

export function renderTaskFinished(
  title: string,
  costTotal: number,
  turns: number,
  toolCalls: number,
  status: "success" | "error" | "aborted",
  finalOutput: string,
  compact: boolean,
): ToolOutputComponent {
  const { palette } = theme;

  const borderColor =
    status === "success"
      ? (s: string) => palette.taskRan(s)
      : status === "aborted"
        ? (s: string) => palette.warn(s)
        : (s: string) => palette.error(s);

  const statusLabel =
    status === "success"
      ? palette.muted("done")
      : status === "aborted"
        ? palette.warn("aborted")
        : palette.error("error");

  const segments: OneLineSegment[] = [
    { text: " ", style: (s) => s },
    { text: "▪", style: borderColor },
    { text: " ", style: (s) => s },
    { text: "task", style: palette.muted },
    { text: " ", style: (s) => s },
    { text: "finished", style: palette.muted },
    { text: " ", style: (s) => s },
    { text: title.trim(), style: palette.accent },
  ];

  const stats = `turns: ${turns}, tool calls: ${toolCalls}`;
  const outputPreview = finalOutput.trim().split("\n").slice(0, 8).join("\n").trim();
  const costLine =
    palette.dim(`cost: ${formatCost(costTotal)} (`) + statusLabel + palette.dim(`, ${stats})`);

  const extraParts: string[] = [];
  if (outputPreview) {
    extraParts.push(palette.taskPreview(outputPreview));
  }
  extraParts.push(costLine);

  const expandedParts: string[] = [borderColor(bold(`task: ${title}`))];
  expandedParts.push(palette.dim(`status: `) + statusLabel);
  if (outputPreview) {
    expandedParts.push("");
    expandedParts.push(outputPreview);
  }
  expandedParts.push("");
  expandedParts.push(palette.dim(`cost: ${formatCost(costTotal)}, ${stats}`));

  return new ToolOutputComponent({
    compact,
    expanded: { borderColor, text: expandedParts.join("\n") },
    compactView: {
      segments,
      flexIndices: [7],
      extraComponent: new PaddedContainer(new Text(extraParts.join("\n"), 0, 0), 4),
    },
  });
}

export function renderTaskBlocked(
  title: string,
  reason: string,
  compact: boolean,
): ToolOutputComponent {
  const { palette } = theme;
  const errorColor = (s: string) => palette.error(s);

  const why = reason.trim();

  const segments: OneLineSegment[] = [
    { text: " ", style: (s) => s },
    { text: "▪", style: errorColor },
    { text: " ", style: (s) => s },
    { text: "task", style: palette.muted },
    { text: " ", style: (s) => s },
    { text: "blocked", style: palette.muted },
    { text: " ", style: (s) => s },
    { text: title.trim(), style: palette.accent },
  ];

  const expandedParts: string[] = [errorColor(bold(`task: ${title}`))];
  if (why) {
    expandedParts.push("");
    expandedParts.push(errorColor(why));
  }

  const extraContent = why
    ? `${palette.muted("(")}${palette.error(why)}${palette.muted(")")}`
    : undefined;

  return new ToolOutputComponent({
    compact,
    expanded: { borderColor: errorColor, text: expandedParts.join("\n") },
    compactView: {
      segments,
      flexIndices: [7],
      extraComponent: extraContent
        ? new PaddedContainer(new Text(extraContent, 0, 0), 4)
        : undefined,
    },
  });
}
