import { Container, Text } from "@mariozechner/pi-tui";
import type { Theme } from "./theme.js";

export class AppIntroComponent extends Container {
  constructor(theme: Theme, appName: string, version: string, helpText: string) {
    super();
    const { palette } = theme;
    const headerLine = `${palette.brandAccent(appName)} ${palette.textMuted(
      `– terminal chat (v${version})`,
    )}`;
    const body = palette.textMuted(helpText);
    const content = `\n${headerLine}\n\n${body}`;
    this.addChild(new Text(content, 1, 0));
  }
}
