import {
  type Component,
  getKeybindings,
  type SelectItem,
  type SelectListLayoutOptions,
  type SelectListTheme,
  truncateToWidth,
  visibleWidth,
} from "@earendil-works/pi-tui";
import stripAnsi from "strip-ansi";

const DEFAULT_PRIMARY_COLUMN_WIDTH = 32;
const PRIMARY_COLUMN_GAP = 2;
const MIN_DESCRIPTION_WIDTH = 10;

export type AutocompleteListTheme = SelectListTheme & {
  selectedBackground: (text: string) => string;
  selectedForeground: (text: string) => string;
};

export type AutocompleteListLayoutOptions = SelectListLayoutOptions & {
  primaryTone?: "default" | "muted";
  descriptionTone?: "default" | "muted";
  descriptionBreakpoint?: number;
  minDescriptionWidth?: number;
};

function normalizeToSingleLine(text: string): string {
  return text.replace(/[\r\n]+/g, " ").trim();
}

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(value, max));
}

export class AutocompleteList implements Component {
  private readonly items: SelectItem[];
  private selectedIndex = 0;

  public onSelect?: (item: SelectItem) => void;
  public onCancel?: () => void;

  constructor(
    items: SelectItem[],
    private readonly maxVisible: number,
    private readonly theme: AutocompleteListTheme,
    private readonly layout: AutocompleteListLayoutOptions = {},
  ) {
    this.items = items;
  }

  setSelectedIndex(index: number): void {
    this.selectedIndex = Math.max(0, Math.min(index, this.items.length - 1));
  }

  getSelectedItem(): SelectItem | null {
    return this.items[this.selectedIndex] ?? null;
  }

  handleInput(data: string): void {
    const keybindings = getKeybindings();
    if (keybindings.matches(data, "tui.select.up")) {
      this.selectedIndex =
        this.selectedIndex === 0 ? this.items.length - 1 : this.selectedIndex - 1;
    } else if (keybindings.matches(data, "tui.select.down")) {
      this.selectedIndex =
        this.selectedIndex === this.items.length - 1 ? 0 : this.selectedIndex + 1;
    } else if (keybindings.matches(data, "tui.select.confirm")) {
      const selected = this.getSelectedItem();
      if (selected) this.onSelect?.(selected);
    } else if (keybindings.matches(data, "tui.select.cancel")) {
      this.onCancel?.();
    }
  }

  invalidate(): void {}

  render(width: number): string[] {
    if (this.items.length === 0) {
      return [this.theme.noMatch("  No matching commands")];
    }

    const primaryColumnWidth = this.getPrimaryColumnWidth();
    const startIndex = Math.max(
      0,
      Math.min(
        this.selectedIndex - Math.floor(this.maxVisible / 2),
        this.items.length - this.maxVisible,
      ),
    );
    const endIndex = Math.min(startIndex + this.maxVisible, this.items.length);
    const lines: string[] = [];

    for (let index = startIndex; index < endIndex; index++) {
      const item = this.items[index];
      if (!item) continue;
      lines.push(this.renderItem(item, index === this.selectedIndex, width, primaryColumnWidth));
    }

    if (startIndex > 0 || endIndex < this.items.length) {
      const scrollText = ` (${this.selectedIndex + 1}/${this.items.length})`;
      lines.push(this.theme.scrollInfo(truncateToWidth(scrollText, width - 2, "")));
    }

    return lines;
  }

  private renderItem(
    item: SelectItem,
    selected: boolean,
    width: number,
    primaryColumnWidth: number,
  ): string {
    const prefix = " ";
    const prefixWidth = 1;
    const description = item.description ? normalizeToSingleLine(item.description) : undefined;
    let line: string;
    let lineWidth: number;

    if (description && width > (this.layout.descriptionBreakpoint ?? 40)) {
      const effectivePrimaryColumnWidth = Math.max(
        1,
        Math.min(primaryColumnWidth, width - prefixWidth - 4),
      );
      const maxPrimaryWidth = Math.max(1, effectivePrimaryColumnWidth - PRIMARY_COLUMN_GAP);
      const primary = this.truncatePrimary(
        item,
        selected,
        maxPrimaryWidth,
        effectivePrimaryColumnWidth,
      );
      const spacing = " ".repeat(Math.max(1, effectivePrimaryColumnWidth - visibleWidth(primary)));
      const remainingWidth = width - prefixWidth - visibleWidth(primary) - spacing.length - 1;

      if (remainingWidth > (this.layout.minDescriptionWidth ?? MIN_DESCRIPTION_WIDTH)) {
        const truncatedDescription = stripAnsi(truncateToWidth(description, remainingWidth, ""));
        line = `${prefix}${this.stylePrimary(primary, selected)}${this.styleDescription(
          spacing + truncatedDescription,
          selected,
        )}`;
        lineWidth =
          prefixWidth + visibleWidth(primary) + spacing.length + visibleWidth(truncatedDescription);
      } else {
        const primaryOnly = this.truncatePrimary(item, selected, width - prefixWidth - 1, width);
        line = `${prefix}${this.stylePrimary(primaryOnly, selected)}`;
        lineWidth = prefixWidth + visibleWidth(primaryOnly);
      }
    } else {
      const primaryOnly = this.truncatePrimary(item, selected, width - prefixWidth - 1, width);
      line = `${prefix}${this.stylePrimary(primaryOnly, selected)}`;
      lineWidth = prefixWidth + visibleWidth(primaryOnly);
    }

    if (!selected) return line;

    const padded = `${line}${" ".repeat(Math.max(0, width - lineWidth))}`;
    return this.theme.selectedBackground(padded);
  }

  private stylePrimary(text: string, selected: boolean): string {
    if (this.layout.primaryTone === "muted") return this.theme.description(text);
    return selected ? this.theme.selectedForeground(text) : text;
  }

  private styleDescription(text: string, selected: boolean): string {
    if ((this.layout.descriptionTone ?? "muted") === "muted") {
      return this.theme.description(text);
    }
    return selected ? this.theme.selectedForeground(text) : text;
  }

  private getPrimaryColumnWidth(): number {
    const rawMin =
      this.layout.minPrimaryColumnWidth ??
      this.layout.maxPrimaryColumnWidth ??
      DEFAULT_PRIMARY_COLUMN_WIDTH;
    const rawMax =
      this.layout.maxPrimaryColumnWidth ??
      this.layout.minPrimaryColumnWidth ??
      DEFAULT_PRIMARY_COLUMN_WIDTH;
    const min = Math.max(1, Math.min(rawMin, rawMax));
    const max = Math.max(1, Math.max(rawMin, rawMax));
    const widest = this.items.reduce(
      (current, item) =>
        Math.max(current, visibleWidth(item.label || item.value) + PRIMARY_COLUMN_GAP),
      0,
    );
    return clamp(widest, min, max);
  }

  private truncatePrimary(
    item: SelectItem,
    selected: boolean,
    maxWidth: number,
    columnWidth: number,
  ): string {
    const text = item.label || item.value;
    const truncated = this.layout.truncatePrimary
      ? this.layout.truncatePrimary({ text, maxWidth, columnWidth, item, isSelected: selected })
      : truncateToWidth(text, maxWidth, "");
    return stripAnsi(truncateToWidth(truncated, maxWidth, ""));
  }
}
