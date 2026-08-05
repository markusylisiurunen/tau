import { Container, Text } from "@earendil-works/pi-tui";
import type { UiComponent } from "./components/ui_component.js";
import type { Theme } from "./theme/index.js";

export type UserMessageModel = {
  text: string;
  kind?: "review";
};

export class UserMessageComponent extends Container implements UiComponent<UserMessageModel> {
  constructor(
    private theme: Theme,
    model: UserMessageModel,
  ) {
    super();
    this.update(model);
  }

  update(model: UserMessageModel): void {
    const bgColor =
      model.kind === "review"
        ? this.theme.palette.userReviewSurface
        : this.theme.palette.userSurface;
    const color =
      model.kind === "review" ? this.theme.palette.userReviewText : this.theme.palette.userText;

    this.clear();
    this.addChild(new Text(this.theme.text.bold(color(model.text)), 1, 0, bgColor));
  }
}
