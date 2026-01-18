import { truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import type { UiComponent } from "./components/ui_component.js";
import type { Theme } from "./theme/index.js";

export type SessionDividerModel = {
  label: string;
};

export class SessionDividerComponent implements UiComponent<SessionDividerModel> {
  constructor(
    private theme: Theme,
    private model: SessionDividerModel,
  ) {}

  update(model: SessionDividerModel): void {
    this.model = model;
  }

  invalidate() {}

  render(width: number) {
    const leftDashes = "──";
    const leftWidth = Math.min(visibleWidth(leftDashes), Math.max(0, width));
    const left =
      leftWidth === visibleWidth(leftDashes)
        ? leftDashes
        : Array.from(leftDashes).slice(0, leftWidth).join("");
    const maxLabelWidth = Math.max(0, width - leftWidth - 1);
    const labelRaw = ` ${this.model.label} `;
    const label = maxLabelWidth > 0 ? truncateToWidth(labelRaw, maxLabelWidth, "…") : "";
    const remainingWidth = Math.max(0, width - leftWidth - visibleWidth(label));
    const rightDashes = "─".repeat(remainingWidth);
    const dividerText = `${left}${label}${rightDashes}`;
    return [this.theme.palette.textMuted(dividerText)];
  }
}
