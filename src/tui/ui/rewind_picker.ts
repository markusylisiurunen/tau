import { type Component, type SelectItem, truncateToWidth } from "@earendil-works/pi-tui";
import {
  AutocompleteList,
  type AutocompleteListLayoutOptions,
} from "./components/autocomplete_list.js";
import type { Theme } from "./theme/index.js";

const REWIND_PICKER_MAX_VISIBLE = 8;
const SELECT_LIST_LAYOUT: AutocompleteListLayoutOptions = {
  minPrimaryColumnWidth: 8,
  maxPrimaryColumnWidth: 12,
  truncatePrimary: ({ text, maxWidth }) => truncateToWidth(text, maxWidth, "…"),
  primaryTone: "muted",
  descriptionTone: "default",
  descriptionBreakpoint: 0,
  minDescriptionWidth: 0,
};

export type RewindPickerItem = {
  id: string;
  label: string;
  description: string;
};

export class RewindPickerComponent implements Component {
  private theme: Theme;
  private readonly items: RewindPickerItem[];
  private list: AutocompleteList;

  public onSelect?: (id: string) => void;
  public onCancel?: () => void;

  constructor(theme: Theme, items: RewindPickerItem[]) {
    this.theme = theme;
    this.items = items;
    this.list = this.createList(items);
  }

  setTheme(theme: Theme): void {
    const selected = this.list.getSelectedItem();
    this.theme = theme;
    this.list = this.createList(this.items);

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
    const header = truncateToWidth(" rewind · enter select · esc cancel", width, "…");
    return [this.theme.palette.textDim(header), ...this.list.render(width)];
  }

  handleInput(data: string): void {
    this.list.handleInput(data);
  }

  private createList(items: RewindPickerItem[]): AutocompleteList {
    const selectItems: SelectItem[] = items.map((item) => ({
      value: item.id,
      label: item.description,
      description: item.label,
    }));

    const list = new AutocompleteList(
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
}
