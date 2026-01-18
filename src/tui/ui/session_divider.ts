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
    const labelWithSpace = ` ${this.model.label} `;
    const leftDashes = "──";
    const remainingWidth = Math.max(1, width - labelWithSpace.length - leftDashes.length);
    const rightDashes = "─".repeat(remainingWidth);
    const dividerText = `${leftDashes}${labelWithSpace}${rightDashes}`;
    return [this.theme.palette.textMuted(dividerText)];
  }
}
