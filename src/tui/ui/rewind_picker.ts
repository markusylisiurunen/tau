import {
  type Component,
  type SelectItem,
  SelectList,
  type SelectListLayoutOptions,
  visibleWidth,
} from "@earendil-works/pi-tui";
import type { Theme } from "./theme/index.js";

const REWIND_PICKER_MAX_VISIBLE = 8;
const SELECT_LIST_LAYOUT: SelectListLayoutOptions = {
  minPrimaryColumnWidth: 12,
  maxPrimaryColumnWidth: 32,
};

export type RewindPickerItem = {
  id: string;
  label: string;
  description?: string;
};

export class RewindPickerComponent implements Component {
  private theme: Theme;
  private readonly items: RewindPickerItem[];
  private list: SelectList;

  public onSelect?: (id: string) => void;
  public onCancel?: () => void;

  constructor(theme: Theme, items: RewindPickerItem[]) {
    this.theme = theme;
    this.items = items;
    this.list = this.createSelectList(items);
  }

  setTheme(theme: Theme): void {
    const selected = this.list.getSelectedItem();
    this.theme = theme;
    this.list = this.createSelectList(this.items);

    if (selected) {
      const index = this.items.findIndex((item) => item.id === selected.value);
      if (index >= 0) {
        this.list.setSelectedIndex(index);
      }
    }
  }

  invalidate(): void {
    this.list.invalidate();
  }

  render(width: number): string[] {
    if (width <= 1) {
      return [this.borderColor()("─").repeat(Math.max(0, width))];
    }

    const innerWidth = Math.max(0, width - 2);
    const header = this.renderHeaderLine(width, innerWidth);
    const footer = this.renderFooterLine(innerWidth);
    const vertical = this.borderColor()("│");
    const listLines = this.list
      .render(innerWidth)
      .map((line) => `${vertical}${this.pad(line, innerWidth)}${vertical}`);

    return [header, ...listLines, footer];
  }

  handleInput(data: string): void {
    this.list.handleInput(data);
  }

  private createSelectList(items: RewindPickerItem[]): SelectList {
    const selectItems: SelectItem[] = items.map((item) => ({
      value: item.id,
      label: item.label,
      description: item.description,
    }));

    const list = new SelectList(
      selectItems,
      REWIND_PICKER_MAX_VISIBLE,
      this.theme.editorTheme.selectList,
      SELECT_LIST_LAYOUT,
    );
    list.setSelectedIndex(Math.max(0, selectItems.length - 1));
    list.onSelect = (item) => this.onSelect?.(item.value);
    list.onCancel = () => this.onCancel?.();
    return list;
  }

  private borderColor(): (text: string) => string {
    return this.theme.editorBorderForReasoning("none");
  }

  private renderHeaderLine(width: number, innerWidth: number): string {
    const borderColor = this.borderColor();
    if (width === 2) {
      return `${borderColor("╭")}${borderColor("╮")}`;
    }

    const leftCorner = borderColor("╭");
    const rightCorner = borderColor("╮");
    const dash = borderColor("─");
    const label = this.theme.palette.textDim(" rewind ");

    if (innerWidth <= 0 || innerWidth < visibleWidth(label)) {
      return `${leftCorner}${dash.repeat(innerWidth)}${rightCorner}`;
    }

    const fillWidth = Math.max(0, innerWidth - visibleWidth(label));
    return `${leftCorner}${label}${dash.repeat(fillWidth)}${rightCorner}`;
  }

  private renderFooterLine(innerWidth: number): string {
    const borderColor = this.borderColor();
    return `${borderColor("╰")}${borderColor("─").repeat(innerWidth)}${borderColor("╯")}`;
  }

  private pad(text: string, width: number): string {
    const padding = Math.max(0, width - visibleWidth(text));
    return `${text}${" ".repeat(padding)}`;
  }
}
