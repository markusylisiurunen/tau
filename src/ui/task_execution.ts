import type { Component } from "@mariozechner/pi-tui";
import { Text, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { formatAdaptiveNumber } from "../utils/format.js";
import { PaddedContainer } from "./components/padded_container.js";
import type { Theme } from "./theme.js";
import {
  buildHeaderLine,
  buildSection,
  renderToolOutput,
  type ToolOutputViewModel,
} from "./tool_output_layout.js";

type TaskKind = "task" | "fork";

type TaskRenderOptions = {
  kind?: TaskKind;
  subagentName?: string;
};

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
    // Show web tool calls like shell commands
    else if (trimmed.startsWith("web search:")) {
      const objective = trimmed
        .replace(/^web search:\s*/, "")
        .replace(/\s+/g, " ")
        .trim();
      filtered.push(`? ${objective}`);
    } else if (trimmed.startsWith("web fetch:")) {
      const url = trimmed
        .replace(/^web fetch:\s*/, "")
        .replace(/\s+/g, " ")
        .trim();
      filtered.push(`? ${url}`);
    }
    // Surface failures and blocked tool calls
    else if (trimmed.startsWith("bash blocked:")) {
      const msg = trimmed.replace(/^bash blocked:\s*/, "").trim();
      if (msg) filtered.push(`! ${msg}`);
    } else if (trimmed.startsWith("bash failed:")) {
      const msg = trimmed.replace(/^bash failed:\s*/, "").trim();
      if (msg) filtered.push(`! ${msg}`);
    } else if (trimmed.startsWith("web search failed:")) {
      const msg = trimmed
        .replace(/^web search failed:\s*/, "")
        .replace(/\s+/g, " ")
        .trim();
      if (msg) filtered.push(`! ${msg}`);
    } else if (trimmed.startsWith("web fetch failed:")) {
      const msg = trimmed
        .replace(/^web fetch failed:\s*/, "")
        .replace(/\s+/g, " ")
        .trim();
      if (msg) filtered.push(`! ${msg}`);
    } else if (trimmed.startsWith("tool blocked:")) {
      const msg = trimmed
        .replace(/^tool blocked:\s*/, "")
        .replace(/\s+/g, " ")
        .trim();
      if (msg) filtered.push(`! ${msg}`);
    } else if (trimmed.startsWith("tool error:")) {
      const msg = trimmed
        .replace(/^tool error:\s*/, "")
        .replace(/\s+/g, " ")
        .trim();
      if (msg) filtered.push(`! ${msg}`);
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
  constructor(
    private text: string,
    private theme: Theme,
  ) {}

  invalidate() {}

  render(width: number): string[] {
    const { palette } = this.theme;
    const lines = this.text.split("\n");
    return lines.map((line) => {
      if (visibleWidth(line) > width) {
        return truncateToWidth(line, Math.max(1, width - 1), palette.textDim("…"));
      }
      return line;
    });
  }
}

export function buildTaskRunningView(
  theme: Theme,
  title: string,
  lastEvents: string[],
  costTotal: number,
  turns: number,
  toolCalls: number,
  opts?: TaskRenderOptions,
): ToolOutputViewModel {
  const { palette, text } = theme;
  const runningColor = (s: string) => palette.actionRunning(s);

  const kind = opts?.kind ?? "task";
  const subagentName = opts?.subagentName;

  const header = buildHeaderLine({
    bulletStyle: runningColor,
    label: `${kind} running`,
    labelStyle: palette.textMuted,
    accent: title.trim(),
    accentStyle: palette.brandAccent,
  });

  const stats = `turns: ${turns}, tool calls: ${toolCalls}`;
  const eventLines = formatEventsForDisplay(lastEvents).slice(-8);
  const costPart = formatCost(costTotal);
  const costLine = subagentName
    ? palette.textMuted(`${subagentName} · ${costPart} (${stats})`)
    : palette.textMuted(`${costPart} (${stats})`);

  const extraParts: string[] = [];
  if (eventLines.length > 0) {
    extraParts.push(palette.textDim(eventLines.join("\n")));
  }
  extraParts.push(costLine);

  const expandedCostLine = subagentName
    ? palette.textMuted(`${subagentName} · ${formatCost(costTotal)} (${stats})`)
    : palette.textMuted(`${formatCost(costTotal)} (${stats})`);

  const extraComponent =
    extraParts.length > 0
      ? new PaddedContainer(new TruncatedText(extraParts.join("\n"), theme), 4)
      : undefined;

  const expandedTitle = subagentName
    ? `${runningColor(text.bold(`${kind}: ${title}`))}\n${palette.textDim(`subagent: ${subagentName}`)}`
    : runningColor(text.bold(`${kind}: ${title}`));
  const expandedSections: Array<string | undefined> = [];
  if (eventLines.length > 0) {
    expandedSections.push(palette.textDim(eventLines.join("\n")));
  }
  expandedSections.push(expandedCostLine);

  return {
    borderColor: runningColor,
    expanded: {
      title: expandedTitle,
      sections: expandedSections,
    },
    compact: {
      header,
      extraComponent,
    },
  };
}

export function buildTaskFinishedView(
  theme: Theme,
  title: string,
  costTotal: number,
  turns: number,
  toolCalls: number,
  status: "success" | "error" | "aborted",
  finalOutput: string,
  opts?: TaskRenderOptions,
): ToolOutputViewModel {
  const { palette, text } = theme;
  const successBullet = (s: string) => palette.actionSuccess(s);
  const isSuccess = status === "success";

  const kind = opts?.kind ?? "task";
  const subagentName = opts?.subagentName;

  const borderColor =
    status === "success"
      ? (s: string) => palette.actionSuccess(s)
      : status === "aborted"
        ? (s: string) => palette.statusWarn(s)
        : (s: string) => palette.actionError(s);

  const statusText =
    status === "success"
      ? `${kind} finished`
      : status === "aborted"
        ? `${kind} aborted`
        : `${kind} failed`;

  const header = buildHeaderLine({
    bulletStyle: isSuccess ? successBullet : borderColor,
    bullet: isSuccess ? "✓" : undefined,
    label: statusText,
    labelStyle: palette.textMuted,
    accent: title.trim(),
    accentStyle: palette.brandAccent,
  });

  const stats = `turns: ${turns}, tool calls: ${toolCalls}`;
  const outputTrimmed = finalOutput.trim();
  const outputPreview = outputTrimmed.split("\n").slice(0, 8).join("\n").trim();
  const costLine = subagentName
    ? palette.textMuted(`${subagentName} · ${formatCost(costTotal)} (${stats})`)
    : palette.textMuted(`${formatCost(costTotal)} (${stats})`);

  const extraParts: string[] = [];
  if (outputPreview) {
    extraParts.push(palette.textDim(outputPreview));
  }
  extraParts.push(costLine);

  const expandedTitleLines = [borderColor(text.bold(`${kind}: ${title}`))];
  if (subagentName) {
    expandedTitleLines.push(palette.textDim(`subagent: ${subagentName}`));
  }
  const expandedTitle = expandedTitleLines.join("\n");

  const expandedSections: Array<string | undefined> = [];
  if (outputTrimmed) {
    expandedSections.push(palette.textDim(outputTrimmed));
  }
  const expandedCostLine = subagentName
    ? palette.textMuted(`${subagentName} · ${formatCost(costTotal)} (${stats})`)
    : palette.textMuted(`${formatCost(costTotal)} (${stats})`);
  expandedSections.push(expandedCostLine);

  return {
    borderColor,
    expanded: {
      title: expandedTitle,
      sections: expandedSections,
    },
    compact: {
      header,
      extraComponent: new PaddedContainer(new Text(extraParts.join("\n"), 0, 0), 4),
    },
  };
}

export function buildTaskBlockedView(
  theme: Theme,
  title: string,
  reason: string,
  opts?: TaskRenderOptions,
): ToolOutputViewModel {
  const { palette, text } = theme;
  const errorColor = (s: string) => palette.actionError(s);

  const kind = opts?.kind ?? "task";
  const subagentName = opts?.subagentName;

  const why = reason.trim();

  const header = buildHeaderLine({
    bulletStyle: errorColor,
    label: `${kind} blocked`,
    labelStyle: palette.textMuted,
    accent: title.trim(),
    accentStyle: palette.brandAccent,
  });

  const expandedTitle = subagentName
    ? `${errorColor(text.bold(`${kind}: ${title}`))}\n${palette.textDim(`subagent: ${subagentName}`)}`
    : errorColor(text.bold(`${kind}: ${title}`));

  const expandedSections: Array<string | undefined> = [];
  const whySection = buildSection(why ? [errorColor(why)] : []);
  if (whySection) {
    expandedSections.push(whySection);
  }

  return {
    borderColor: errorColor,
    expanded: {
      title: expandedTitle,
      sections: expandedSections,
    },
    compact: {
      header,
      extraText: why ? `    ${errorColor(why)}` : undefined,
    },
  };
}

export function renderTaskRunning(
  theme: Theme,
  title: string,
  lastEvents: string[],
  costTotal: number,
  turns: number,
  toolCalls: number,
  compact: boolean,
  opts?: TaskRenderOptions,
): ReturnType<typeof renderToolOutput> {
  return renderToolOutput(
    buildTaskRunningView(theme, title, lastEvents, costTotal, turns, toolCalls, opts),
    compact,
  );
}

export function renderTaskFinished(
  theme: Theme,
  title: string,
  costTotal: number,
  turns: number,
  toolCalls: number,
  status: "success" | "error" | "aborted",
  finalOutput: string,
  compact: boolean,
  opts?: TaskRenderOptions,
): ReturnType<typeof renderToolOutput> {
  return renderToolOutput(
    buildTaskFinishedView(theme, title, costTotal, turns, toolCalls, status, finalOutput, opts),
    compact,
  );
}

export function renderTaskBlocked(
  theme: Theme,
  title: string,
  reason: string,
  compact: boolean,
  opts?: TaskRenderOptions,
): ReturnType<typeof renderToolOutput> {
  return renderToolOutput(buildTaskBlockedView(theme, title, reason, opts), compact);
}
