import { type Component, Container, Spacer, Text } from "@mariozechner/pi-tui";
import { formatBytes, type TruncationResult } from "../utils/truncate.js";
import { theme } from "./theme.js";

class DynamicBorder implements Component {
  constructor(private color: (s: string) => string) {}

  invalidate(): void {}

  render(width: number): string[] {
    return [this.color("─".repeat(Math.max(1, width)))];
  }
}

/**
 * Non-streaming bash execution block.
 * Shows a bash-colored border, the command, and captured output.
 */
export class BashExecutionComponent extends Container {
  constructor(
    command: string,
    output: string,
    exitCode: number | null,
    truncation: TruncationResult,
    captureTruncated = false,
    modelTruncation?: TruncationResult,
    modelCaptureTruncated = false,
  ) {
    super();
    const { palette } = theme;
    const bashColor = (s: string) => palette.bash(s);

    this.addChild(new Spacer(1));
    this.addChild(new DynamicBorder(bashColor));

    const content = new Container();
    this.addChild(content);

    const header = `\u001b[1m$ ${command}\u001b[22m`;
    content.addChild(new Text(bashColor(header), 1, 0));

    const out = output.trimEnd();
    if (out) {
      content.addChild(new Text(`\n${palette.muted(out)}`, 1, 0));
    }

    if (truncation.truncated || captureTruncated) {
      const shown = `${truncation.outputLines} lines / ${formatBytes(truncation.outputBytes)}`;
      const total = `${truncation.totalLines} lines / ${formatBytes(truncation.totalBytes)}`;
      const reason = captureTruncated
        ? "capture limit reached"
        : `truncated by ${truncation.truncatedBy}`;
      content.addChild(
        new Text(
          `\n${palette.dim(`… output truncated (${reason}; showing first ${shown} of ${total})`)}`,
          1,
          0,
        ),
      );
    }

    if (modelTruncation && (modelTruncation.truncated || modelCaptureTruncated)) {
      const shown = `${modelTruncation.outputLines} lines / ${formatBytes(
        modelTruncation.outputBytes,
      )}`;
      const total = `${modelTruncation.totalLines} lines / ${formatBytes(modelTruncation.totalBytes)}`;
      const reason = modelCaptureTruncated
        ? "capture limit reached"
        : `truncated by ${modelTruncation.truncatedBy}`;
      content.addChild(
        new Text(
          `\n${palette.dim(
            `… model context truncated (${reason}; first ${shown} sent of ${total})`,
          )}`,
          1,
          0,
        ),
      );
    }

    if (exitCode !== null && exitCode !== 0) {
      content.addChild(new Text(`\n${palette.warn(`(exit ${exitCode})`)}`, 1, 0));
    }

    this.addChild(new DynamicBorder(bashColor));
  }
}
