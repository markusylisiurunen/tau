import { formatAdaptiveNumber } from "../utils/format.js";
import type { OneLineSegment } from "./components/one_line_segments.js";
import { theme } from "./theme.js";
import { ToolOutputComponent } from "./tool_output.js";

function bold(text: string): string {
  return `\u001b[1m${text}\u001b[22m`;
}

function inline(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function formatCost(costTotal: number): string {
  return `$${formatAdaptiveNumber(costTotal, 2, 5)}`;
}

function buildEventsLines(lastEvents: string[], prefix: string): string[] {
  return lastEvents.map((e) => `${prefix}${e}`);
}

function buildOutputLines(output: string, maxLines: number, prefix: string): string[] {
  const lines = output.split("\n");
  return lines.slice(0, maxLines).map((l) => `${prefix}${l}`);
}

export function renderTaskRunning(
  title: string,
  lastEvents: string[],
  costTotal: number,
  compact: boolean,
): ToolOutputComponent {
  const { palette } = theme;
  const runningColor = (s: string) => palette.noticeSuccess(s);

  const titleInline = inline(title);
  const segments: OneLineSegment[] = [
    { text: " ", style: (s) => s },
    { text: "▪", style: runningColor },
    { text: " ", style: (s) => s },
    { text: "task", style: palette.muted },
    { text: " ", style: (s) => s },
    { text: "running", style: palette.muted },
    { text: " ", style: (s) => s },
    { text: titleInline, style: palette.accent },
  ];

  const extraLines = [
    ...buildEventsLines(lastEvents, palette.taskPreview("    ")),
    `    ${palette.dim("cost:")} ${palette.dim(formatCost(costTotal))}`,
  ].filter((l) => l.trim() !== "");

  const expandedParts: string[] = [runningColor(bold(`task: ${title}`))];
  if (lastEvents.length > 0) {
    expandedParts.push("");
    expandedParts.push(...buildEventsLines(lastEvents, palette.taskPreview("• ")));
  }
  expandedParts.push("");
  expandedParts.push(palette.dim(`cost: ${formatCost(costTotal)}`));

  return new ToolOutputComponent({
    compact,
    expanded: { borderColor: runningColor, text: expandedParts.join("\n") },
    compactView: {
      segments,
      flexIndices: [7],
      extraText: extraLines.length > 0 ? extraLines.join("\n") : undefined,
    },
  });
}

export function renderTaskFinished(
  title: string,
  costTotal: number,
  status: "success" | "error" | "aborted",
  finalOutput: string,
  compact: boolean,
): ToolOutputComponent {
  const { palette } = theme;
  const okColor = (s: string) => palette.toolFileRan(s);
  const warnColor = (s: string) => palette.warn(s);
  const errorColor = (s: string) => palette.error(s);

  const borderColor =
    status === "success" ? okColor : status === "aborted" ? warnColor : errorColor;

  const statusLabel =
    status === "success"
      ? palette.muted("done")
      : status === "aborted"
        ? palette.warn("aborted")
        : palette.error("error");

  const titleInline = inline(title);
  const segments: OneLineSegment[] = [
    { text: " ", style: (s) => s },
    { text: "▪", style: borderColor },
    { text: " ", style: (s) => s },
    { text: "task", style: palette.muted },
    { text: " ", style: (s) => s },
    { text: "finished", style: palette.muted },
    { text: " ", style: (s) => s },
    { text: titleInline, style: palette.accent },
  ];

  const outputLines = buildOutputLines(finalOutput, 16, palette.taskPreview("    "));
  const extraLines = [
    ...outputLines,
    `    ${palette.dim("cost:")} ${palette.dim(formatCost(costTotal))} ${palette.dim("(")}${statusLabel}${palette.dim(")")}`,
  ].filter((l) => l.trim() !== "");

  const expandedParts: string[] = [borderColor(bold(`task: ${title}`))];
  expandedParts.push(palette.dim(`status: `) + statusLabel);
  if (finalOutput) {
    expandedParts.push("");
    expandedParts.push(...buildOutputLines(finalOutput, 16, palette.taskPreview("• ")));
  }
  expandedParts.push("");
  expandedParts.push(palette.dim(`cost: ${formatCost(costTotal)}`));

  return new ToolOutputComponent({
    compact,
    expanded: { borderColor, text: expandedParts.join("\n") },
    compactView: {
      segments,
      flexIndices: [7],
      extraText: extraLines.length > 0 ? extraLines.join("\n") : undefined,
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

  const titleInline = inline(title);
  const why = inline(reason);

  const segments: OneLineSegment[] = [
    { text: " ", style: (s) => s },
    { text: "▪", style: errorColor },
    { text: " ", style: (s) => s },
    { text: "task", style: palette.muted },
    { text: " ", style: (s) => s },
    { text: "blocked", style: palette.muted },
    { text: " ", style: (s) => s },
    { text: titleInline, style: palette.accent },
  ];

  const expandedParts: string[] = [errorColor(bold(`task: ${title}`))];
  if (why) {
    expandedParts.push("");
    expandedParts.push(errorColor(why));
  }

  const extraText = why
    ? `    ${palette.muted("(")}${palette.error(why)}${palette.muted(")")}`
    : undefined;

  return new ToolOutputComponent({
    compact,
    expanded: { borderColor: errorColor, text: expandedParts.join("\n") },
    compactView: { segments, flexIndices: [7], extraText },
  });
}
