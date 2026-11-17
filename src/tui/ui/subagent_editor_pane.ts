import type { Component } from "@earendil-works/pi-tui";
import { renderHorizontalRule } from "./components/horizontal_rule.js";
import type { CustomEditor } from "./custom_editor.js";
import type { SubagentPanelComponent } from "./subagent_panel.js";
import type { Theme } from "./theme/index.js";

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
    if (width <= 2) return [" ".repeat(Math.max(0, width))];

    const contentWidth = width - 2;
    const lines: string[] = [];
    if (this.subagentPanel.hasActiveSubagents()) {
      lines.push(
        renderHorizontalRule(contentWidth, {
          style: this.theme.palette.editorSubagentBorder,
          left: "subagents",
        }),
        ...this.subagentPanel.render(contentWidth),
      );
    }
    lines.push(...this.editor.render(contentWidth));
    return lines.map((line) => ` ${line} `);
  }
}
