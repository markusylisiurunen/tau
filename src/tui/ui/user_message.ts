import { Container, Markdown } from "@mariozechner/pi-tui";
import type { UiComponent } from "./components/ui_component.js";
import type { Theme } from "./theme/index.js";

export type UserMessageModel = {
  text: string;
  isMemoryMode?: boolean;
};

export class UserMessageComponent extends Container implements UiComponent<UserMessageModel> {
  private theme: Theme;

  constructor(theme: Theme, model: UserMessageModel) {
    super();
    this.theme = theme;
    this.update(model);
  }

  update(model: UserMessageModel): void {
    const bgColor = model.isMemoryMode
      ? this.theme.palette.userMemorySurface
      : this.theme.palette.userSurface;
    const color = model.isMemoryMode
      ? this.theme.palette.userMemoryText
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
