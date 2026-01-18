import { Container, Text } from "@mariozechner/pi-tui";
import type { UiComponent } from "./components/ui_component.js";
import type { Theme } from "./theme/index.js";

export type AppIntroModel = {
  appName: string;
  version: string;
  helpText: string;
};

export class AppIntroComponent extends Container implements UiComponent<AppIntroModel> {
  private theme: Theme;

  constructor(theme: Theme, model: AppIntroModel) {
    super();
    this.theme = theme;
    this.update(model);
  }

  update(model: AppIntroModel): void {
    const { palette } = this.theme;
    const headerLine = `${palette.brandAccent(model.appName)} ${palette.textMuted(
      `– terminal chat (v${model.version})`,
    )}`;
    const body = palette.textMuted(model.helpText);
    const content = `\n${headerLine}\n\n${body}`;
    this.clear();
    this.addChild(new Text(content, 1, 0));
  }
}
