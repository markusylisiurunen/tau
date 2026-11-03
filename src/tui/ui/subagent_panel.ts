import { type Component, visibleWidth } from "@earendil-works/pi-tui";
import type {
  SubagentEvent,
  SubagentStateSnapshot,
  SubagentUsageSnapshot,
} from "../../core/subagents/types.js";
import { formatUsageSnapshot, formatUsdCost } from "../../core/utils/format.js";
import type { SessionProtocolSubagentActivity } from "../../protocol/session_protocol.js";
import {
  truncateFromEndByWidth,
  truncateFromEndByWidthPreserveAnsi,
} from "./components/one_line_segments.js";
import type { Theme } from "./theme/index.js";

type SubagentPanelEntry = {
  id: string;
  parentId: string;
  depth: number;
  title: string;
  model: SubagentStateSnapshot["model"];
  runRevision: number;
  status: SubagentStateSnapshot["run"]["status"];
  costTotal: number;
  usage: SubagentUsageSnapshot;
  activities: SessionProtocolSubagentActivity[];
};

const MAX_PANEL_LINES = 6;
const MARKER_PREFIX = "⏵ ";
const ANCESTRY_SEPARATOR = " › ";
const MIN_PARENT_TITLE_SHARE = 0.4;

export type SubagentPanelSnapshot = {
  state: SubagentStateSnapshot;
  activities: SessionProtocolSubagentActivity[];
};

export class SubagentPanelComponent implements Component {
  private theme: Theme;
  private entries = new Map<string, SubagentPanelEntry>();
  private selectedId?: string;

  constructor(theme: Theme) {
    this.theme = theme;
  }

  setTheme(theme: Theme): void {
    this.theme = theme;
  }

  reset(): void {
    this.entries.clear();
    this.selectedId = undefined;
  }

  reconcile(snapshots: readonly SubagentPanelSnapshot[]): void {
    const currentIds = new Set(snapshots.map(({ state }) => state.id));
    for (const id of this.entries.keys()) {
      if (!currentIds.has(id)) this.entries.delete(id);
    }

    for (const snapshot of snapshots) {
      let entry = this.entries.get(snapshot.state.id);
      if (entry) {
        this.applySnapshot(entry, snapshot.state);
      } else {
        entry = this.buildEntry(snapshot.state);
        this.entries.set(entry.id, entry);
      }

      entry.activities = structuredClone(snapshot.activities);
    }

    if (!this.selectedId || this.entries.get(this.selectedId)?.status !== "running") {
      this.selectedId = this.getFirstRunningId();
    }
  }

  hasActiveSubagents(): boolean {
    return this.getRunningEntries().length > 0;
  }

  handleEvent(event: SubagentEvent): void {
    if (event.type === "subagent_spawned" || event.type === "subagent_run_started") {
      const state = event.state;
      this.entries.set(state.id, this.buildEntry(state));
      if (!this.selectedId || this.entries.get(this.selectedId)?.status !== "running") {
        this.selectedId = state.id;
      }
      return;
    }

    if (event.type === "subagent_finished") {
      const entry = this.entries.get(event.state.id);
      if (!entry) return;
      this.applySnapshot(entry, event.state);
      if (this.selectedId === entry.id && entry.status !== "running") {
        this.selectedId = this.getFirstRunningId();
      }
      return;
    }

    if (event.type === "subagent_interrupt_requested") {
      const entry = this.entries.get(event.state.id);
      if (!entry) return;
      this.applySnapshot(entry, event.state);
      return;
    }

    if (event.type === "subagent_updated") {
      const entry = this.entries.get(event.state.id);
      if (!entry) return;
      this.applySnapshot(entry, event.state);
    }
  }

  getSelectedId(): string | undefined {
    if (!this.selectedId) return undefined;
    const entry = this.entries.get(this.selectedId);
    if (entry?.status !== "running") return undefined;
    return this.selectedId;
  }

  cycleSelection(direction: 1 | -1): string | undefined {
    const activeIds = this.getRunningEntries().map((entry) => entry.id);

    if (activeIds.length === 0) {
      this.selectedId = undefined;
      return undefined;
    }

    const currentIndex = this.selectedId ? activeIds.indexOf(this.selectedId) : -1;
    const nextIndex =
      currentIndex === -1 ? 0 : (currentIndex + direction + activeIds.length) % activeIds.length;
    this.selectedId = activeIds[nextIndex];
    return this.selectedId;
  }

  invalidate() {}

  render(width: number): string[] {
    if (width <= 0) return [""];
    const runningEntries = this.getRunningEntries();
    if (runningEntries.length === 0) return [];

    const { entry, index } = this.resolveSelectedEntry(runningEntries);
    const lines: string[] = [];

    lines.push(this.buildHeaderLine(entry, width));
    const outputLines = this.buildOutputLines(entry);
    lines.push(...outputLines);
    lines.push(this.buildStatusLine(entry));
    lines.push(this.buildFooterLine(entry, index + 1, runningEntries.length));

    return lines.map((line) => this.fitLine(line, width));
  }

  private resolveSelectedEntry(runningEntries: SubagentPanelEntry[]): {
    entry: SubagentPanelEntry;
    index: number;
  } {
    let index = this.selectedId
      ? runningEntries.findIndex((entry) => entry.id === this.selectedId)
      : -1;

    if (index === -1) {
      this.selectedId = runningEntries[0]?.id;
      index = 0;
    }

    return { entry: runningEntries[index]!, index };
  }

  private buildHeaderLine(entry: SubagentPanelEntry, width: number): string {
    const { palette } = this.theme;
    const title = displayTitle(entry);
    const selected = palette.brandAccent(`${MARKER_PREFIX}${title}`);

    const parent = this.entries.get(entry.parentId);
    if (parent) {
      return `${palette.brandAccent(MARKER_PREFIX)}${this.buildAncestry(parent, title, width)}${palette.brandAccent(title)}`;
    }

    const runningChildren = this.countRunningChildren(entry);
    if (runningChildren === 0) return selected;
    const noun = runningChildren === 1 ? "child" : "children";
    return `${selected}${palette.textMuted(` · ${runningChildren} ${noun} running`)}`;
  }

  // The selected worker's title identifies the panel, so a long parent title gives way to it.
  private buildAncestry(parent: SubagentPanelEntry, title: string, width: number): string {
    const available = width - visibleWidth(MARKER_PREFIX) - visibleWidth(ANCESTRY_SEPARATOR);
    const budget = Math.max(
      Math.floor(available * MIN_PARENT_TITLE_SHARE),
      available - visibleWidth(title),
    );
    const parentTitle = truncateFromEndByWidth(displayTitle(parent), budget);
    return this.theme.palette.textMuted(`${parentTitle}${ANCESTRY_SEPARATOR}`);
  }

  private buildOutputLines(entry: SubagentPanelEntry): string[] {
    const { palette } = this.theme;
    const recentLines = entry.activities
      .map(formatSubagentActivity)
      .filter((line): line is string => Boolean(line))
      .slice(-MAX_PANEL_LINES);
    const output: string[] = [];

    for (const line of recentLines) {
      output.push(palette.actionOutput(`  · ${line}`));
    }

    for (let i = recentLines.length; i < MAX_PANEL_LINES; i++) {
      output.push("");
    }

    return output;
  }

  private buildStatusLine(entry: SubagentPanelEntry): string {
    const { palette } = this.theme;
    const contextUsage = formatUsageSnapshot(entry.usage);
    const cost = formatUsdCost(entry.costTotal);
    const model = `${entry.model.provider}/${entry.model.id}:${entry.model.reasoning}`;
    return palette.textMuted(`${model} · ${contextUsage} · ${cost}`);
  }

  private buildFooterLine(entry: SubagentPanelEntry, index: number, total: number): string {
    const { palette } = this.theme;
    const parts = [`(${index}/${total})`];
    if (total > 1) {
      parts.push("alt+down to cycle");
    }
    parts.push(
      this.countRunningChildren(entry) > 0
        ? "ctrl+g to interrupt this subagent only"
        : "ctrl+g to interrupt",
    );
    return palette.textMuted(parts.join(" · "));
  }

  private fitLine(line: string, width: number): string {
    const truncated = truncateFromEndByWidthPreserveAnsi(line, width);
    const pad = Math.max(0, width - visibleWidth(truncated));
    return `${truncated}${" ".repeat(pad)}`;
  }

  private countRunningChildren(entry: SubagentPanelEntry): number {
    return this.getRunningEntries().filter((candidate) => candidate.parentId === entry.id).length;
  }

  // Branch order keeps a worker next to its parent, so cycling walks one branch at a time. A
  // child with an idle parent keeps that parent's place, and spawn order decides the rest.
  private getRunningEntries(): SubagentPanelEntry[] {
    const spawnOrder = new Map([...this.entries.keys()].map((id, index) => [id, index]));
    const branchOrder = (entry: SubagentPanelEntry) =>
      spawnOrder.get(entry.parentId) ?? spawnOrder.get(entry.id) ?? 0;
    return [...this.entries.values()]
      .filter((entry) => entry.status === "running")
      .sort((a, b) => branchOrder(a) - branchOrder(b) || a.depth - b.depth);
  }

  private getFirstRunningId(): string | undefined {
    return this.getRunningEntries()[0]?.id;
  }

  private buildEntry(state: SubagentStateSnapshot): SubagentPanelEntry {
    return {
      id: state.id,
      parentId: state.parentId,
      depth: state.depth,
      title: state.title,
      model: state.model,
      runRevision: state.run.revision,
      status: state.run.status,
      costTotal: state.costTotal,
      usage: state.usage,
      activities: [],
    };
  }

  private applySnapshot(entry: SubagentPanelEntry, state: SubagentStateSnapshot): void {
    if (entry.runRevision !== state.run.revision) {
      entry.runRevision = state.run.revision;
      entry.activities = [];
    }
    entry.status = state.run.status;
    entry.costTotal = state.costTotal;
    entry.usage = state.usage;
    entry.title = state.title;
    entry.model = state.model;
  }
}

function displayTitle(entry: SubagentPanelEntry): string {
  return entry.title.trim() || "(subagent)";
}

function formatSubagentActivity(activity: SessionProtocolSubagentActivity): string | undefined {
  switch (activity.type) {
    case "assistant": {
      const firstLine = activity.text.trim().split(/\r?\n/, 1)[0]?.trim();
      return firstLine ? `> ${firstLine}` : undefined;
    }
    case "tool": {
      const operation = activity.presentation.operation
        ? ` ${activity.presentation.operation}`
        : "";
      const subject = activity.presentation.subject.replace(/\s+/g, " ").trim();
      return `${activity.presentation.action}${operation} ${subject}`;
    }
    case "notice":
      return activity.title;
  }
}
