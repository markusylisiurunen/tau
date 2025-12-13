import { type Component, Container, Text } from "@mariozechner/pi-tui";
import type { BashTruncationInfo } from "../tools/bash.js";
import { formatBytes } from "../utils/truncate.js";
import { theme } from "./theme.js";

class DynamicBorder implements Component {
  constructor(private color: (s: string) => string) {}

  invalidate() {}

  render(width: number) {
    return [this.color("─".repeat(Math.max(1, width)))];
  }
}

export class BashExecutionComponent extends Container {
  constructor(command: string, exitCode: number | null, truncationInfo: BashTruncationInfo) {
    super();
    const { palette } = theme;
    const bashColor = (s: string) => palette.bash(s);

    this.addChild(new DynamicBorder(bashColor));

    const content = new Container();
    this.addChild(content);

    const header = `\u001b[1m$ ${command}\u001b[22m`;
    content.addChild(new Text(bashColor(header), 1, 0));

    const out = truncationInfo.display.content.trimEnd();
    if (out) {
      content.addChild(new Text(`\n${palette.muted(out)}`, 1, 0));
    }

    const { display, model, captureTruncated } = truncationInfo;

    let truncatedNoticeAdded = false;
    if (display.truncated || captureTruncated) {
      truncatedNoticeAdded = true;
      const shown = `${display.outputLines} lines (${formatBytes(display.outputBytes)})`;
      const total = `${display.totalLines} lines (${formatBytes(display.totalBytes)})`;
      const icon = palette.warn("◆");
      const msg = palette.dim(`truncated: ${shown} of ${total}`);
      content.addChild(new Text(`\n${icon} ${msg}`, 1, 0));
    }

    if (model.truncated || captureTruncated) {
      const shown = `${model.outputLines} lines (${formatBytes(model.outputBytes)})`;
      const total = `${model.totalLines} lines (${formatBytes(model.totalBytes)})`;
      const icon = palette.warn("◆");
      const msg = palette.warn(`truncated for model: ${shown} of ${total}`);
      content.addChild(new Text(`${!truncatedNoticeAdded ? "\n" : ""}${icon} ${msg}`, 1, 0));
    }

    if (exitCode !== null && exitCode !== 0) {
      content.addChild(new Text(`\n${palette.warn(`(exit ${exitCode})`)}`, 1, 0));
    }

    this.addChild(new DynamicBorder(bashColor));
  }
}

export class BashBlockedComponent extends Container {
  constructor(command: string, reason: string) {
    super();
    const { palette } = theme;
    const errorColor = (s: string) => palette.error(s);

    this.addChild(new DynamicBorder(errorColor));

    const content = new Container();
    this.addChild(content);

    const header = `\u001b[1m$ ${command}\u001b[22m`;
    content.addChild(new Text(errorColor(header), 1, 0));

    const msg = reason.trim();
    if (msg) {
      content.addChild(new Text(`\n${errorColor(msg)}`, 1, 0));
    }

    this.addChild(new DynamicBorder(errorColor));
  }
}

export class BashRunningComponent extends Container {
  constructor(command: string) {
    super();
    const { palette } = theme;
    const runningColor = (s: string) => palette.bashRunning(s);

    this.addChild(new DynamicBorder(runningColor));

    const content = new Container();
    this.addChild(content);

    const header = `\u001b[1m$ ${command}\u001b[22m`;
    content.addChild(new Text(runningColor(header), 1, 0));

    this.addChild(new DynamicBorder(runningColor));
  }
}
