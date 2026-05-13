import { Container, Markdown } from "@earendil-works/pi-tui";
import type { UiComponent } from "./components/ui_component.js";
import type { Theme } from "./theme/index.js";

export type UserMessageKind = "memory" | "review";

export type UserMessageModel = {
  text: string;
  kind?: UserMessageKind;
};

export class UserMessageComponent extends Container implements UiComponent<UserMessageModel> {
  private theme: Theme;

  constructor(theme: Theme, model: UserMessageModel) {
    super();
    this.theme = theme;
    this.update(model);
  }

  update(model: UserMessageModel): void {
    const bgColor =
      model.kind === "memory"
        ? this.theme.palette.userMemorySurface
        : model.kind === "review"
          ? this.theme.palette.userReviewSurface
          : this.theme.palette.userSurface;
    const color =
      model.kind === "memory"
        ? this.theme.palette.userMemoryText
        : model.kind === "review"
          ? this.theme.palette.userReviewText
          : this.theme.palette.textDefault;

    this.clear();
    this.addChild(
      new Markdown(model.text, 1, 1, this.theme.markdownTheme, {
        bgColor: (t: string) => bgColor(t),
        color: (t: string) => color(t),
      }),
    );
  }
}
