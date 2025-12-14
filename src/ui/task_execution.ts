import type { Component } from "@mariozechner/pi-tui";
import { Text, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { formatAdaptiveNumber } from "../utils/format.js";
import type { OneLineSegment } from "./components/one_line_segments.js";
import { PaddedContainer } from "./components/padded_container.js";
import { palette, theme } from "./theme.js";
import { ToolOutputComponent } from "./tool_output.js";

function bold(text: string): string {
  return `\u001b[1m${text}\u001b[22m`;
}

function formatCost(costTotal: number): string {
  return `$${formatAdaptiveNumber(costTotal, 2, 5)}`;
}

function formatEventsForDisplay(lastEvents: string[]): string[] {
  const filtered: string[] = [];
  for (const event of lastEvents) {
    const trimmed = event.trim();
    // Show bash running: events as "$ command"
    if (trimmed.startsWith("bash running:")) {
      const cmd = trimmed.replace(/^bash running:\s*/, "");
      filtered.push(`$ ${cmd}`);
    }
    // Show agent text output as "> first line only"
    else if (trimmed.startsWith("agent:")) {
      const text = trimmed.replace(/^agent:\s*/, "");
      const firstLine = text.split("\n")[0];
      if (firstLine) filtered.push(`> ${firstLine}`);
    }
  }
  return filtered;
}

class TruncatedText implements Component {
  constructor(private text: string) {}

  invalidate() {}

  render(width: number): string[] {
    const lines = this.text.split("\n");
    return lines.map((line) => {
      if (visibleWidth(line) > width) {
        return truncateToWidth(line, Math.max(1, width - 1), palette.taskPreview("…"));
      }
      return line;
    });
  }
}

export function renderTaskRunning(
  title: string,
  lastEvents: string[],
  costTotal: number,
  turns: number,
  toolCalls: number,
  compact: boolean,
  subagentName?: string,
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
  const eventLines = formatEventsForDisplay(lastEvents);
  const costPart = `cost: ${formatCost(costTotal)}`;
  const costLine = subagentName
    ? palette.dim(`${subagentName} · ${costPart} (${stats})`)
    : palette.dim(`${costPart} (${stats})`);

  const extraParts: string[] = [];
  if (eventLines.length > 0) {
    extraParts.push(palette.taskPreview(eventLines.join("\n")));
  }
  extraParts.push(costLine);

  const expandedParts: string[] = [runningColor(bold(`task: ${title}`))];
  if (subagentName) {
    expandedParts.push(palette.dim(`subagent: ${subagentName}`));
  }
  if (eventLines.length > 0) {
    expandedParts.push("");
    expandedParts.push(palette.taskPreview(eventLines.join("\n")));
  }
  expandedParts.push("");
  const expandedCostLine = subagentName
    ? palette.dim(`${subagentName} · cost: ${formatCost(costTotal)}, ${stats}`)
    : palette.dim(`cost: ${formatCost(costTotal)}, ${stats}`);
  expandedParts.push(expandedCostLine);

  return new ToolOutputComponent({
    compact,
    expanded: { borderColor: runningColor, text: expandedParts.join("\n") },
    compactView: {
      segments,
      flexIndices: [7],
      extraComponent: new PaddedContainer(new TruncatedText(extraParts.join("\n")), 4),
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
  subagentName?: string,
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
  const outputTrimmed = finalOutput.trim();
  const outputPreview = outputTrimmed.split("\n").slice(0, 8).join("\n").trim();
  const costLine = subagentName
    ? palette.dim(`${subagentName} · cost: ${formatCost(costTotal)} (`) +
      statusLabel +
      palette.dim(`, ${stats})`)
    : palette.dim(`cost: ${formatCost(costTotal)} (`) + statusLabel + palette.dim(`, ${stats})`);

  const extraParts: string[] = [];
  if (outputPreview) {
    extraParts.push(palette.taskPreview(outputPreview));
  }
  extraParts.push(costLine);

  const expandedParts: string[] = [borderColor(bold(`task: ${title}`))];
  if (subagentName) {
    expandedParts.push(palette.dim(`subagent: ${subagentName}`));
  }
  expandedParts.push(palette.dim(`status: `) + statusLabel);
  if (outputTrimmed) {
    expandedParts.push("");
    expandedParts.push(outputTrimmed);
  }
  expandedParts.push("");
  const expandedCostLine = subagentName
    ? palette.dim(`${subagentName} · cost: ${formatCost(costTotal)}, ${stats}`)
    : palette.dim(`cost: ${formatCost(costTotal)}, ${stats}`);
  expandedParts.push(expandedCostLine);

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
  subagentName?: string,
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
  if (subagentName) {
    expandedParts.push(palette.dim(`subagent: ${subagentName}`));
  }
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
