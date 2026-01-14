import { Container, Text } from "@mariozechner/pi-tui";
import type { Theme } from "./theme.js";

export type SystemMessageKind = "success" | "warn" | "error" | "muted";

export class SystemMessageComponent extends Container {
  constructor(theme: Theme, text: string, kind: SystemMessageKind) {
    super();
    const { palette } = theme;
    const style =
      kind === "error"
        ? palette.toastError
        : kind === "warn"
          ? palette.toastWarn
          : kind === "muted"
            ? palette.textMuted
            : palette.toastSuccess;
    this.addChild(new Text(style(text), 1, 0));
  }
}
