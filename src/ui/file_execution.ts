import { type Component, Container, Text } from "@mariozechner/pi-tui";
import { theme } from "./theme.js";

class DynamicBorder implements Component {
  constructor(private color: (s: string) => string) {}

  invalidate() {}

  render(width: number) {
    return [this.color("─".repeat(Math.max(1, width)))];
  }
}

export class WriteSuccessComponent extends Container {
  constructor(path: string, bytes: number, lines: number) {
    super();
    const { palette } = theme;
    const writeColor = (s: string) => palette.accessAll(s);

    this.addChild(new DynamicBorder(writeColor));

    const content = new Container();
    this.addChild(content);

    const header = `\u001b[1mwrite ${path}\u001b[22m`;
    content.addChild(new Text(writeColor(header), 1, 0));

    const msg = `${bytes} bytes (${lines} lines)`;
    content.addChild(new Text(`\n${palette.muted(msg)}`, 1, 0));

    this.addChild(new DynamicBorder(writeColor));
  }
}

export class WriteBlockedComponent extends Container {
  constructor(path: string, reason: string) {
    super();
    const { palette } = theme;
    const errorColor = (s: string) => palette.error(s);

    this.addChild(new DynamicBorder(errorColor));

    const content = new Container();
    this.addChild(content);

    const header = `\u001b[1mwrite ${path}\u001b[22m`;
    content.addChild(new Text(errorColor(header), 1, 0));

    const msg = reason.trim();
    if (msg) {
      content.addChild(new Text(`\n${errorColor(msg)}`, 1, 0));
    }

    this.addChild(new DynamicBorder(errorColor));
  }
}

export class EditSuccessComponent extends Container {
  constructor(path: string, oldLength: number, newLength: number) {
    super();
    const { palette } = theme;
    const editColor = (s: string) => palette.accessAll(s);

    this.addChild(new DynamicBorder(editColor));

    const content = new Container();
    this.addChild(content);

    const header = `\u001b[1medit ${path}\u001b[22m`;
    content.addChild(new Text(editColor(header), 1, 0));

    const diff = newLength - oldLength;
    const diffStr = diff === 0 ? "same size" : diff > 0 ? `+${diff} chars` : `${diff} chars`;
    const msg = `replaced ${oldLength} → ${newLength} chars (${diffStr})`;
    content.addChild(new Text(`\n${palette.muted(msg)}`, 1, 0));

    this.addChild(new DynamicBorder(editColor));
  }
}

export class EditBlockedComponent extends Container {
  constructor(path: string, reason: string) {
    super();
    const { palette } = theme;
    const errorColor = (s: string) => palette.error(s);

    this.addChild(new DynamicBorder(errorColor));

    const content = new Container();
    this.addChild(content);

    const header = `\u001b[1medit ${path}\u001b[22m`;
    content.addChild(new Text(errorColor(header), 1, 0));

    const msg = reason.trim();
    if (msg) {
      content.addChild(new Text(`\n${errorColor(msg)}`, 1, 0));
    }

    this.addChild(new DynamicBorder(errorColor));
  }
}
