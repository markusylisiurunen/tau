import { Container, Text } from "@earendil-works/pi-tui";
import type { UiComponent } from "./components/ui_component.js";
import type { Theme } from "./theme/index.js";

export type TranscriptTextModel = {
  text: string;
};

export class TranscriptTextComponent extends Container implements UiComponent<TranscriptTextModel> {
  private theme: Theme;

  constructor(theme: Theme, model: TranscriptTextModel) {
    super();
    this.theme = theme;
    this.update(model);
  }

  update(model: TranscriptTextModel): void {
    this.clear();
    this.addChild(new Text(this.theme.palette.textMuted(model.text), 1, 0));
  }
}
