import { type Component, visibleWidth } from "@earendil-works/pi-tui";
import type {
  SubagentStateSnapshot,
  SubagentUiEvent,
  SubagentUsageSnapshot,
} from "../../core/subagents/types.js";
import { formatUsageSnapshot, formatUsdCost } from "../../core/utils/format.js";
import { formatAgentActivityText, formatAgentOutputText } from "./agent_activity_format.js";
import { truncateFromEndByWidthPreserveAnsi } from "./components/one_line_segments.js";
import type { Theme } from "./theme/index.js";

type SubagentPanelLine = {
  kind: "progress" | "output";
  text: string;
};

type SubagentPanelEntry = {
  id: string;
  name: string;
  title: string;
  status: SubagentStateSnapshot["status"];
  abortRequested: boolean;
  costTotal: number;
  turns: number;
  toolCalls: number;
  usage: SubagentUsageSnapshot;
  lines: SubagentPanelLine[];
};

const MAX_PANEL_LINES = 6;
const MAX_PANEL_HISTORY = 200;

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

  hasActiveSubagents(): boolean {
    return this.getRunningEntries().length > 0;
  }

  handleEvent(event: SubagentUiEvent): void {
    if (event.type === "subagent_spawned") {
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
      const finalText = event.state.finalText?.trim();
      if (finalText && !this.hasOutputLine(entry, finalText)) {
        entry.lines.push({ kind: "output", text: event.state.finalText ?? finalText });
        if (entry.lines.length > MAX_PANEL_HISTORY) {
          entry.lines.shift();
        }
      }
      if (this.selectedId === entry.id && entry.status !== "running") {
        this.selectedId = this.getFirstRunningId();
      }
      return;
    }

    if (event.type === "subagent_abort_requested") {
      const entry = this.entries.get(event.id);
      if (!entry) return;
      entry.abortRequested = true;
      return;
    }

    if (event.type === "subagent_progress") {
      const entry = this.entries.get(event.id);
      if (!entry) return;
      entry.costTotal = event.costTotal;
      entry.turns = event.turns;
      entry.toolCalls = event.toolCalls;
      entry.usage = event.usage;
      const text = event.text.trim();
      if (text) {
        entry.lines.push({ kind: "progress", text });
        if (entry.lines.length > MAX_PANEL_HISTORY) {
          entry.lines.shift();
        }
      }
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
    const formattedLines = entry.lines
      .map((line) =>
        line.kind === "output"
          ? formatAgentOutputText(line.text)
          : formatAgentActivityText(line.text),
      )
      .filter((line): line is string => Boolean(line?.length));
    const recentLines = formattedLines.slice(-MAX_PANEL_LINES);
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
    parts.push("ctrl+g to terminate");
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

  private hasOutputLine(entry: SubagentPanelEntry, text: string): boolean {
    const trimmed = text.trim();
    if (!trimmed) return true;
    return entry.lines.some((line) => line.kind === "output" && line.text.trim() === trimmed);
  }

  private buildEntry(state: SubagentStateSnapshot): SubagentPanelEntry {
    return {
      id: state.id,
      name: state.name,
      title: state.title,
      status: state.status,
      abortRequested: Boolean(state.abortRequested),
      costTotal: state.costTotal,
      turns: state.turns,
      toolCalls: state.toolCalls,
      usage: state.usage,
      lines: [],
    };
  }

  private applySnapshot(entry: SubagentPanelEntry, state: SubagentStateSnapshot): void {
    entry.status = state.status;
    entry.abortRequested = Boolean(state.abortRequested);
    entry.costTotal = state.costTotal;
    entry.turns = state.turns;
    entry.toolCalls = state.toolCalls;
    entry.usage = state.usage;
    entry.name = state.name;
    entry.title = state.title;
  }
}
