import { Container, Text } from "@earendil-works/pi-tui";
import type { UiComponent } from "./components/ui_component.js";
import type { Theme } from "./theme/index.js";

export type SystemMessageKind = "success" | "warn" | "error" | "muted";

export type SystemMessageModel = {
  text: string;
  kind: SystemMessageKind;
};

export class SystemMessageComponent extends Container implements UiComponent<SystemMessageModel> {
  private theme: Theme;

  constructor(theme: Theme, model: SystemMessageModel) {
    super();
    this.theme = theme;
    this.update(model);
  }

  update(model: SystemMessageModel): void {
    const { palette } = this.theme;
    const style =
      model.kind === "error"
        ? palette.toastError
        : model.kind === "warn"
          ? palette.toastWarn
          : model.kind === "muted"
            ? palette.textMuted
            : palette.toastSuccess;
    this.clear();
    this.addChild(new Text(style(model.text), 1, 0));
  }
}
