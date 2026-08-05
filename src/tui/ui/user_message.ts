import { type Component, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import type { UiComponent } from "./components/ui_component.js";
import type { Theme } from "./theme/index.js";

export type UserMessageModel = {
  text: string;
  kind?: "review";
};

export class UserMessageComponent implements Component, UiComponent<UserMessageModel> {
  private model: UserMessageModel;

  constructor(
    private theme: Theme,
    model: UserMessageModel,
  ) {
    this.model = model;
  }

  update(model: UserMessageModel): void {
    this.model = model;
  }

  invalidate(): void {}

  render(width: number): string[] {
    if (width <= 0) return [""];

    const bgColor =
      this.model.kind === "review"
        ? this.theme.palette.userReviewSurface
        : this.theme.palette.userSurface;
    const color =
      this.model.kind === "review"
        ? this.theme.palette.userReviewText
        : this.theme.palette.userText;
    const innerWidth = Math.max(1, width - 2);
    const textWidth = Math.max(1, innerWidth - 2);
    const lines = wrapTextWithAnsi(this.model.text.replace(/\t/g, "   "), textWidth);

    return lines.map((line, index) => {
      const content = `${index === 0 ? "> " : "  "}${line}`;
      const trailingPadding = " ".repeat(Math.max(0, width - 1 - visibleWidth(content)));
      const styledContent = this.theme.text.bold(color(content));
      return bgColor(` ${styledContent}${trailingPadding}`);
    });
  }
}
