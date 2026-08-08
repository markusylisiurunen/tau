import { type Component, visibleWidth } from "@earendil-works/pi-tui";
import type {
  SubagentEvent,
  SubagentStateSnapshot,
  SubagentUsageSnapshot,
} from "../../core/subagents/types.js";
import { formatUsageSnapshot, formatUsdCost } from "../../core/utils/format.js";
import type { SessionProtocolSubagentActivity } from "../../protocol/session_protocol.js";
import { truncateFromEndByWidthPreserveAnsi } from "./components/one_line_segments.js";
import type { Theme } from "./theme/index.js";

type SubagentPanelEntry = {
  id: string;
  name: string;
  title: string;
  runRevision: number;
  status: SubagentStateSnapshot["run"]["status"];
  costTotal: number;
  usage: SubagentUsageSnapshot;
  activities: SessionProtocolSubagentActivity[];
};

const MAX_PANEL_LINES = 6;

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

    lines.push(this.buildHeaderLine(entry));
    const outputLines = this.buildOutputLines(entry);
    lines.push(...outputLines);
    lines.push(this.buildStatusLine(entry));
    lines.push(this.buildFooterLine(index + 1, runningEntries.length));

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

  private buildHeaderLine(entry: SubagentPanelEntry): string {
    const { palette } = this.theme;
    const name = entry.name.trim();
    const title = entry.title.trim();
    const arrowStyle = name ? palette.textDim : palette.brandAccent;
    const arrow = arrowStyle("⏵");

    if (name && title) {
      return `${arrow} ${palette.textDim(name)} ${palette.brandAccent(title)}`;
    }
    if (name) {
      return `${arrow} ${palette.textDim(name)}`;
    }
    return `${arrow} ${palette.brandAccent(title || "(subagent)")}`;
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
    return palette.textMuted(`${contextUsage} · ${cost}`);
  }

  private buildFooterLine(index: number, total: number): string {
    const { palette } = this.theme;
    const parts = [`(${index}/${total})`];
    if (total > 1) {
      parts.push("alt+down to cycle");
    }
    parts.push("ctrl+g to interrupt");
    return palette.textMuted(parts.join(" · "));
  }

  private fitLine(line: string, width: number): string {
    const truncated = truncateFromEndByWidthPreserveAnsi(line, width);
    const pad = Math.max(0, width - visibleWidth(truncated));
    return `${truncated}${" ".repeat(pad)}`;
  }

  private getRunningEntries(): SubagentPanelEntry[] {
    return [...this.entries.values()].filter((entry) => entry.status === "running");
  }

  private getFirstRunningId(): string | undefined {
    for (const entry of this.entries.values()) {
      if (entry.status === "running") return entry.id;
    }
    return undefined;
  }

  private buildEntry(state: SubagentStateSnapshot): SubagentPanelEntry {
    return {
      id: state.id,
      name: state.name,
      title: state.title,
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
    entry.name = state.name;
    entry.title = state.title;
  }
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
