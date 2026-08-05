import { type Component, visibleWidth } from "@earendil-works/pi-tui";
import {
  truncateFromEndByWidth,
  truncateFromEndByWidthPreserveAnsi,
} from "./components/one_line_segments.js";
import type { CustomEditor } from "./custom_editor.js";
import type { SubagentPanelComponent } from "./subagent_panel.js";
import type { Theme } from "./theme/index.js";

const SUBAGENT_HEADER_LABEL = "subagents";
const SUBAGENT_PADDING_X = 1;

export class SubagentEditorPaneComponent implements Component {
  constructor(
    private theme: Theme,
    private subagentPanel: SubagentPanelComponent,
    private editor: CustomEditor,
  ) {}

  setTheme(theme: Theme): void {
    this.theme = theme;
  }

  invalidate(): void {
    this.subagentPanel.invalidate();
    this.editor.invalidate();
  }

  render(width: number): string[] {
    if (!this.subagentPanel.hasActiveSubagents()) {
      return this.editor.render(width);
    }

    const editorLines = this.editor.render(width);
    if (editorLines.length === 0) return editorLines;

    const innerWidth = Math.max(0, width - 2);
    const contentWidth = Math.max(0, innerWidth - SUBAGENT_PADDING_X * 2);
    const panelLines = this.subagentPanel.render(contentWidth);

    const borderedPanelLines = panelLines.map((line) =>
      this.wrapPanelLine(line, contentWidth, SUBAGENT_PADDING_X),
    );

    const headerLine = this.renderSubagentHeaderLine(width);
    const dividerLine = this.editor.renderDividerLineWithCornerStyle(
      width,
      this.theme.palette.editorSubagentBorder,
    );

    return [headerLine, ...borderedPanelLines, dividerLine, ...editorLines.slice(1)];
  }

  private wrapPanelLine(line: string, contentWidth: number, paddingX: number): string {
    const border = this.theme.palette.editorSubagentBorder;
    const vertical = border("│");
    const pad = " ".repeat(Math.max(0, paddingX));
    const truncated = truncateFromEndByWidthPreserveAnsi(line, contentWidth);
    const padded = this.padToWidth(truncated, contentWidth);
    return `${vertical}${pad}${padded}${pad}${vertical}`;
  }

  private padToWidth(line: string, width: number): string {
    const pad = Math.max(0, width - visibleWidth(line));
    return `${line}${" ".repeat(pad)}`;
  }

  private renderSubagentHeaderLine(width: number): string {
    const border = this.theme.palette.editorSubagentBorder;
    if (width <= 1) return border("─").repeat(Math.max(0, width));
    if (width === 2) {
      return `${border("┌")}${border("┐")}`;
    }

    const innerWidth = width - 2;
    const dash = border("─");
    const leftCorner = border("┌");
    const rightCorner = border("┐");
    const labelWidth = Math.max(0, innerWidth - 4);
    const label = labelWidth > 0 ? truncateFromEndByWidth(SUBAGENT_HEADER_LABEL, labelWidth) : "";
    const labelSegment = label ? ` ${this.theme.palette.textDim(label)} ` : "";
    const fillWidth = Math.max(0, innerWidth - 2 - visibleWidth(labelSegment));
    const fill = dash.repeat(fillWidth);

    return `${leftCorner}${dash}${labelSegment}${fill}${dash}${rightCorner}`;
  }
}
