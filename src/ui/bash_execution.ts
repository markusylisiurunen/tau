import type { BashTruncationInfo } from "../tools/bash.js";
import { formatBytes } from "../utils/truncate.js";
import type { OneLineSegment } from "./components/one_line_segments.js";
import { theme } from "./theme.js";
import { ToolOutputComponent } from "./tool_output.js";

function bold(text: string): string {
  return `\u001b[1m${text}\u001b[22m`;
}

function inline(text: string): string {
  return text.replace(/\s+/g, " ").trim();
}

function buildBashExecutionExpandedText(
  command: string,
  exitCode: number | null,
  truncationInfo: BashTruncationInfo,
): string {
  const { palette } = theme;
  const bashColor = (s: string) => palette.bashRan(s);

  const parts: string[] = [];
  parts.push(bashColor(bold(`$ ${command}`)));

  const out = truncationInfo.display.content.trimEnd();
  if (out) {
    parts.push("");
    parts.push(palette.bashOutput(out));
  }

  const { display, model, captureTruncated } = truncationInfo;

  let truncatedNoticeAdded = false;
  if (display.truncated || captureTruncated) {
    truncatedNoticeAdded = true;
    const shown = `${display.outputLines} lines (${formatBytes(display.outputBytes)})`;
    const total = `${display.totalLines} lines (${formatBytes(display.totalBytes)})`;
    const icon = palette.warn("◆");
    const msg = palette.dim(`truncated: ${shown} of ${total}`);
    parts.push("");
    parts.push(`${icon} ${msg}`);
  }

  if (model.truncated || captureTruncated) {
    const shown = `${model.outputLines} lines (${formatBytes(model.outputBytes)})`;
    const total = `${model.totalLines} lines (${formatBytes(model.totalBytes)})`;
    const icon = palette.warn("◆");
    const msg = palette.warn(`truncated for model: ${shown} of ${total}`);
    if (!truncatedNoticeAdded) {
      parts.push("");
    }
    parts.push(`${icon} ${msg}`);
  }

  if (exitCode !== null && exitCode !== 0) {
    parts.push("");
    parts.push(palette.warn(`(exit ${exitCode})`));
  }

  return parts.join("\n");
}

export function renderBashRunning(command: string, compact: boolean): ToolOutputComponent {
  const { palette } = theme;
  const runningColor = (s: string) => palette.bashRunning(s);

  const header = runningColor(bold(`$ ${command}`));

  const commandInline = inline(command);
  const segments: OneLineSegment[] = [
    { text: " ", style: (s) => s },
    { text: "▪", style: runningColor },
    { text: " ", style: (s) => s },
    { text: "running", style: palette.muted },
    { text: " ", style: (s) => s },
    { text: commandInline, style: palette.accent },
  ];

  return new ToolOutputComponent({
    compact,
    expanded: { borderColor: runningColor, text: header },
    compactView: { segments, flexIndices: [5] },
  });
}

export function renderBashExecution(
  command: string,
  exitCode: number | null,
  truncationInfo: BashTruncationInfo,
  compact: boolean,
): ToolOutputComponent {
  const { palette } = theme;
  const bashColor = (s: string) => palette.bashRan(s);

  const commandInline = inline(command);

  const { display, model, captureTruncated } = truncationInfo;
  const hasOutput = model.totalBytes > 0;
  const showTotals = display.truncated || model.truncated || captureTruncated;
  const outputLines = showTotals ? model.totalLines : model.outputLines;
  const outputBytes = showTotals ? model.totalBytes : model.outputBytes;
  const outSummary = hasOutput ? `${outputLines} lines, ${formatBytes(outputBytes)}` : "no output";
  const outSummaryInline = inline(outSummary);

  const segments: OneLineSegment[] = [
    { text: " ", style: (s) => s },
    { text: "▪", style: bashColor },
    { text: " ", style: (s) => s },
    { text: "ran", style: palette.muted },
    { text: " ", style: (s) => s },
    { text: commandInline, style: palette.accent },
  ];

  const exitSummary = exitCode === null ? "exit ?" : `exit ${exitCode}`;
  const exitStyle = exitCode !== null && exitCode !== 0 ? palette.error : palette.muted;

  const details = [
    palette.muted("("),
    exitStyle(exitSummary),
    palette.muted(`, ${outSummaryInline})`),
  ].join("");

  return new ToolOutputComponent({
    compact,
    expanded: {
      borderColor: bashColor,
      text: buildBashExecutionExpandedText(command, exitCode, truncationInfo),
    },
    compactView: { segments, flexIndices: [5], extraText: `    ${details}` },
  });
}

export function renderBashBlocked(
  command: string,
  reason: string,
  compact: boolean,
): ToolOutputComponent {
  const { palette } = theme;
  const errorColor = (s: string) => palette.error(s);

  const parts: string[] = [errorColor(bold(`$ ${command}`))];
  const msg = reason.trim();
  if (msg) {
    parts.push("");
    parts.push(errorColor(msg));
  }

  const commandInline = inline(command);
  const why = inline(reason);

  const segments: OneLineSegment[] = [
    { text: " ", style: (s) => s },
    { text: "▪", style: errorColor },
    { text: " ", style: (s) => s },
    { text: "blocked", style: palette.muted },
    { text: " ", style: (s) => s },
    { text: commandInline, style: palette.accent },
  ];

  const details = why ? palette.muted(`(${why})`) : undefined;

  return new ToolOutputComponent({
    compact,
    expanded: { borderColor: errorColor, text: parts.join("\n") },
    compactView: { segments, flexIndices: [5], extraText: details ? `    ${details}` : undefined },
  });
}

export function renderBashAborted(
  command: string,
  reason: string,
  compact: boolean,
): ToolOutputComponent {
  const { palette } = theme;
  const warnColor = (s: string) => palette.warn(s);

  const parts: string[] = [warnColor(bold(`$ ${command}`))];
  const msg = reason.trim();
  if (msg) {
    parts.push("");
    parts.push(warnColor(msg));
  }

  const commandInline = inline(command);
  const why = inline(reason);

  const segments: OneLineSegment[] = [
    { text: " ", style: (s) => s },
    { text: "▪", style: warnColor },
    { text: " ", style: (s) => s },
    { text: inline(reason) || "aborted", style: palette.muted },
    { text: " ", style: (s) => s },
    { text: commandInline, style: palette.accent },
  ];

  const details = why ? palette.muted(`(${why})`) : undefined;

  return new ToolOutputComponent({
    compact,
    expanded: { borderColor: warnColor, text: parts.join("\n") },
    compactView: { segments, flexIndices: [5], extraText: details ? `    ${details}` : undefined },
  });
}
