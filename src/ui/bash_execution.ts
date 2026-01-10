import type { BashTruncationInfo } from "../tools/bash.js";
import { formatBytes } from "../utils/truncate.js";
import { inlineText } from "./inline.js";
import type { Theme } from "./theme.js";
import {
  buildHeaderLine,
  buildSection,
  renderToolOutput,
  type ToolOutputViewModel,
} from "./tool_output_layout.js";
import { BASH_UI_MAX_LINES, BASH_UI_MAX_TOKENS, truncateForUi } from "./tool_truncation.js";

const COMPACT_OUTPUT_HEAD_LINES = 4;
const COMPACT_OUTPUT_TAIL_LINES = 4;
const BASH_UI_MAX_LINE_LENGTH: number = 256;

function truncateLineToMax(line: string): string {
  if (BASH_UI_MAX_LINE_LENGTH <= 0) return "";
  const chars = Array.from(line);
  if (chars.length <= BASH_UI_MAX_LINE_LENGTH) return line;
  if (BASH_UI_MAX_LINE_LENGTH === 1) return "…";
  return `${chars.slice(0, BASH_UI_MAX_LINE_LENGTH - 1).join("")}…`;
}

function truncateLinesForUi(text: string): string {
  if (!text) return text;
  return text
    .split("\n")
    .map((line) => truncateLineToMax(line))
    .join("\n");
}

function formatDurationMs(durationMs: number | null | undefined): string {
  if (durationMs === null || durationMs === undefined || !Number.isFinite(durationMs)) {
    return "?ms";
  }
  const ms = Math.max(0, Math.round(durationMs));
  if (ms < 1000) return `${ms}ms`;
  if (ms < 10_000) return `${(ms / 1000).toFixed(1)}s`;
  return `${Math.round(ms / 1000)}s`;
}

function buildCompactOutputLines(
  output: string,
  headCount: number = COMPACT_OUTPUT_HEAD_LINES,
  tailCount: number = COMPACT_OUTPUT_TAIL_LINES,
): string[] {
  const cleaned = output.replace(/\n+$/, "");
  if (cleaned.trim().length === 0) return [];
  const lines = cleaned.split("\n");
  const total = lines.length;
  if (total <= headCount + tailCount) return lines.map(truncateLineToMax);

  const head = lines.slice(0, headCount).map(truncateLineToMax);
  const tail = lines.slice(Math.max(total - tailCount, headCount)).map(truncateLineToMax);
  const remaining = Math.max(0, total - head.length - tail.length);
  const label = remaining === 1 ? "line" : "lines";
  return [...head, `…${remaining} more ${label}…`, ...tail];
}

function buildBashExecutionExpandedSections(
  theme: Theme,
  exitCode: number | null,
  truncationInfo: BashTruncationInfo,
  display: ReturnType<typeof truncateForUi>,
): string[] {
  const { palette } = theme;

  const sections: Array<string | undefined> = [];

  const out = truncateLinesForUi(display.content).trimEnd();
  if (out) {
    sections.push(palette.bashOutput(out));
  }

  const { model, captureTruncated } = truncationInfo;

  const truncationNotices: string[] = [];
  if (display.truncated || captureTruncated) {
    const shown = `${display.outputLines} lines (${formatBytes(display.outputBytes)})`;
    const total = `${display.totalLines} lines (${formatBytes(display.totalBytes)})`;
    const icon = palette.warn("◆");
    const msg = palette.dim(`truncated: ${shown} of ${total}`);
    truncationNotices.push(`${icon} ${msg}`);
  }

  if (model.truncated || captureTruncated) {
    const shown = `${model.outputLines} lines (${formatBytes(model.outputBytes)})`;
    const total = `${model.totalLines} lines (${formatBytes(model.totalBytes)})`;
    const icon = palette.warn("◆");
    const msg = palette.warn(`truncated for model: ${shown} of ${total}`);
    truncationNotices.push(`${icon} ${msg}`);
  }
  const truncationSection = buildSection(truncationNotices);
  if (truncationSection) {
    sections.push(truncationSection);
  }

  if (exitCode !== null && exitCode !== 0) {
    sections.push(palette.warn(`(exit ${exitCode})`));
  }

  return sections.filter((section): section is string => Boolean(section));
}

export function buildBashRunningView(theme: Theme, command: string): ToolOutputViewModel {
  const { palette, text } = theme;
  const runningColor = (s: string) => palette.bashRunning(s);

  const commandInline = inlineText(command);
  const header = buildHeaderLine({
    bulletStyle: runningColor,
    label: "running",
    labelStyle: palette.muted,
    accent: commandInline,
    accentStyle: palette.accent,
    wrapIndex: 5,
  });

  return {
    borderColor: runningColor,
    expanded: { title: runningColor(text.bold(`$ ${command}`)) },
    compact: { header },
  };
}

export function buildBashExecutionView(
  theme: Theme,
  command: string,
  exitCode: number | null,
  truncationInfo: BashTruncationInfo,
  durationMs?: number,
  labelOverride?: string,
  compactHeadLines?: number,
  compactTailLines?: number,
): ToolOutputViewModel {
  const { palette } = theme;
  const bashColor = (s: string) => palette.bashRan(s);
  const successBullet = (s: string) => palette.diffAdded(s);
  const isSuccess = exitCode === 0;

  const display = truncateForUi(truncationInfo.output, {
    maxLines: BASH_UI_MAX_LINES,
    maxTokens: BASH_UI_MAX_TOKENS,
    strategy: "middle",
  });

  const commandInline = inlineText(command);

  const { model, captureTruncated } = truncationInfo;
  const hasOutput = model.totalBytes > 0;
  const showTotals = display.truncated || model.truncated || captureTruncated;
  const outputLines = showTotals ? model.totalLines : model.outputLines;
  const outputBytes = showTotals ? model.totalBytes : model.outputBytes;
  const header = buildHeaderLine({
    bulletStyle: isSuccess ? successBullet : bashColor,
    bullet: isSuccess ? "✓" : undefined,
    label: labelOverride ?? "ran",
    labelStyle: palette.muted,
    accent: commandInline,
    accentStyle: palette.accent,
    wrapIndex: 5,
  });

  const exitSummary = exitCode === null ? "exit ?" : `exit ${exitCode}`;
  const exitStyle = exitCode !== null && exitCode !== 0 ? palette.error : palette.muted;
  const durationLabel = formatDurationMs(durationMs);
  const lineLabel = hasOutput
    ? `${outputLines} line${outputLines === 1 ? "" : "s"}`
    : "no output";
  const bytesLabel = hasOutput ? formatBytes(outputBytes).toLowerCase() : undefined;
  const infoParts = bytesLabel ? [durationLabel, lineLabel, bytesLabel] : [durationLabel, lineLabel];
  const infoText = infoParts.join(" · ");
  const details = [
    palette.muted("("),
    exitStyle(exitSummary),
    palette.muted(` · ${inlineText(infoText)}`),
    palette.muted(")"),
  ].join("");

  const outputLinesPreview = buildCompactOutputLines(
    truncationInfo.output,
    compactHeadLines,
    compactTailLines,
  );
  const outputBlock =
    outputLinesPreview.length > 0
      ? outputLinesPreview
          .map((line) => palette.dim(`    ${line}`))
          .join("\n")
      : undefined;
  const summaryLine = `    ${details}`;
  const compactText = [outputBlock, summaryLine].filter(Boolean).join("\n");

  const sections = buildBashExecutionExpandedSections(theme, exitCode, truncationInfo, display);
  return {
    borderColor: bashColor,
    expanded: {
      title: bashColor(theme.text.bold(`$ ${command}`)),
      sections,
    },
    compact: {
      header,
      extraText: compactText,
    },
  };
}

export function buildBashBlockedView(
  theme: Theme,
  command: string,
  reason: string,
): ToolOutputViewModel {
  const { palette, text } = theme;
  const errorColor = (s: string) => palette.error(s);

  const msg = reason.trim();
  const sections = buildSection(msg ? [errorColor(msg)] : []);

  const commandInline = inlineText(command);
  const why = inlineText(reason);

  const details = why ? palette.muted(`(${why})`) : undefined;

  const header = buildHeaderLine({
    bulletStyle: errorColor,
    label: "blocked",
    labelStyle: palette.muted,
    accent: commandInline,
    accentStyle: palette.accent,
    wrapIndex: 5,
  });

  return {
    borderColor: errorColor,
    expanded: {
      title: errorColor(text.bold(`$ ${command}`)),
      sections: sections ? [sections] : [],
    },
    compact: {
      header,
      extraText: details ? `    ${details}` : undefined,
    },
  };
}

export function buildBashAbortedView(
  theme: Theme,
  command: string,
  reason: string,
): ToolOutputViewModel {
  const { palette, text } = theme;
  const warnColor = (s: string) => palette.warn(s);

  const msg = reason.trim();
  const sections = buildSection(msg ? [warnColor(msg)] : []);

  const commandInline = inlineText(command);
  const why = inlineText(reason);

  const details = why ? palette.muted(`(${why})`) : undefined;

  const header = buildHeaderLine({
    bulletStyle: warnColor,
    label: inlineText(reason) || "aborted",
    labelStyle: palette.muted,
    accent: commandInline,
    accentStyle: palette.accent,
    wrapIndex: 5,
  });

  return {
    borderColor: warnColor,
    expanded: {
      title: warnColor(text.bold(`$ ${command}`)),
      sections: sections ? [sections] : [],
    },
    compact: {
      header,
      extraText: details ? `    ${details}` : undefined,
    },
  };
}

export function renderBashRunning(
  theme: Theme,
  command: string,
  compact: boolean,
): ReturnType<typeof renderToolOutput> {
  return renderToolOutput(buildBashRunningView(theme, command), compact);
}

export function renderBashExecution(
  theme: Theme,
  command: string,
  exitCode: number | null,
  truncationInfo: BashTruncationInfo,
  durationMs: number | undefined,
  compact: boolean,
): ReturnType<typeof renderToolOutput> {
  return renderToolOutput(
    buildBashExecutionView(theme, command, exitCode, truncationInfo, durationMs),
    compact,
  );
}

export function renderBashBlocked(
  theme: Theme,
  command: string,
  reason: string,
  compact: boolean,
): ReturnType<typeof renderToolOutput> {
  return renderToolOutput(buildBashBlockedView(theme, command, reason), compact);
}

export function renderBashAborted(
  theme: Theme,
  command: string,
  reason: string,
  compact: boolean,
): ReturnType<typeof renderToolOutput> {
  return renderToolOutput(buildBashAbortedView(theme, command, reason), compact);
}
