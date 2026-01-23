import { type Component, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import type { SubagentStateSnapshot, SubagentUiEvent } from "../../core/subagents/types.js";
import { formatAdaptiveNumber } from "../../core/utils/format.js";
import { HeaderBox } from "./components/header_box.js";
import type { Theme } from "./theme/index.js";

type SubagentPanelLine = {
  kind: "progress" | "communicate";
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
  lines: SubagentPanelLine[];
};

const MAX_PANEL_LINES = 6;
const MAX_PANEL_HISTORY = 200;

class SubagentPanelContent implements Component {
  constructor(
    private lines: string[],
    private theme: Theme,
  ) {}

  invalidate() {}

  render(width: number): string[] {
    if (width <= 0) return [""];
    const ellipsis = this.theme.palette.textDim("…");
    return this.lines.map((line) =>
      visibleWidth(line) > width ? truncateToWidth(line, width, ellipsis) : line,
    );
  }
}

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

  handleEvent(event: SubagentUiEvent): void {
    if (event.type === "subagent_spawned") {
      const state = event.state;
      this.entries.set(state.id, this.buildEntry(state));
      return;
    }

    if (event.type === "subagent_finished") {
      const entry = this.entries.get(event.state.id);
      if (!entry) return;
      this.applySnapshot(entry, event.state);
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
      const text = event.text.trim();
      if (text) {
        entry.lines.push({ kind: "progress", text });
        if (entry.lines.length > MAX_PANEL_HISTORY) {
          entry.lines.shift();
        }
      }
      return;
    }

    if (event.type === "subagent_communicate") {
      const entry = this.entries.get(event.id);
      if (!entry) return;
      const text = event.text.trim();
      if (text) {
        entry.lines.push({ kind: "communicate", text });
        if (entry.lines.length > MAX_PANEL_HISTORY) {
          entry.lines.shift();
        }
      }
    }
  }

  getCostTotal(): number {
    let total = 0;
    for (const entry of this.entries.values()) {
      total += entry.costTotal;
    }
    return total;
  }

  getSelectedId(): string | undefined {
    return this.selectedId;
  }

  cycleSelection(direction: 1 | -1): string | undefined {
    const activeIds = [...this.entries.values()]
      .filter((entry) => entry.status === "running")
      .map((entry) => entry.id);

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
    if (this.entries.size === 0) return [];

    const { palette } = this.theme;
    const entries = [...this.entries.values()];
    const activeCount = entries.filter((entry) => entry.status === "running").length;
    const headerLeft = `subagents (${activeCount}/${entries.length})`;
    const headerRight = activeCount > 0 ? "alt+down select · ctrl+g stop" : undefined;
    const borderColor = activeCount > 0 ? palette.actionRunning : palette.textMuted;

    const contentLines: string[] = [];

    for (const entry of entries) {
      const entryLines = this.buildEntryLines(entry);
      contentLines.push(...entryLines);

      const recentLines = entry.lines.slice(-MAX_PANEL_LINES);
      for (const line of recentLines) {
        const prefix = line.kind === "communicate" ? ">" : "·";
        const styledText =
          line.kind === "communicate" ? palette.textDefault(line.text) : palette.textDim(line.text);
        contentLines.push(`  ${prefix} ${styledText}`);
      }
    }

    const content = new SubagentPanelContent(contentLines, this.theme);
    const box = new HeaderBox(content, {
      borderColor,
      headerLeft,
      headerRight,
      headerLeftStyle: palette.textMuted,
      headerRightStyle: palette.textDim,
      paddingX: 1,
    });

    return box.render(width);
  }

  private buildEntryLines(entry: SubagentPanelEntry): string[] {
    const { palette } = this.theme;
    const isSelected = entry.id === this.selectedId;
    const selector = isSelected ? palette.brandAccent("▸") : " ";

    const statusLabel =
      entry.status === "running"
        ? entry.abortRequested
          ? "stopping"
          : "running"
        : entry.status === "success"
          ? "done"
          : entry.status === "aborted"
            ? "aborted"
            : "failed";

    const bullet =
      entry.status === "running"
        ? entry.abortRequested
          ? palette.statusWarn("■")
          : palette.actionRunning("⏵")
        : entry.status === "success"
          ? palette.actionSuccess("✓")
          : entry.status === "aborted"
            ? palette.statusWarn("■")
            : palette.actionError("✗");

    const name = entry.name.trim();
    const title = entry.title.trim();
    const label = name
      ? `${palette.textMuted(name)}: ${palette.brandAccent(title)}`
      : palette.brandAccent(title);

    const cost = `$${formatAdaptiveNumber(entry.costTotal, 2, 5)}`;
    const stats = palette.textDim(
      `${statusLabel} · ${cost} · ${entry.turns}t · ${entry.toolCalls} tools`,
    );

    return [`${selector} ${bullet} ${label}`, `  ${stats}`];
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
      lines: [],
    };
  }

  private applySnapshot(entry: SubagentPanelEntry, state: SubagentStateSnapshot): void {
    entry.status = state.status;
    entry.abortRequested = Boolean(state.abortRequested);
    entry.costTotal = state.costTotal;
    entry.turns = state.turns;
    entry.toolCalls = state.toolCalls;
    entry.name = state.name;
    entry.title = state.title;
  }
}
