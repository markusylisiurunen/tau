import { closeSync, openSync } from "node:fs";
import { ReadStream } from "node:tty";
import { ProcessTerminal, type Terminal } from "@mariozechner/pi-tui";

type InputStream = NodeJS.ReadStream & {
  isRaw?: boolean;
  setRawMode?: (mode: boolean) => void;
};

type OutputStream = NodeJS.WriteStream & {
  columns?: number;
  rows?: number;
};

export class TauTerminal implements Terminal {
  private wasRaw = false;
  private inputHandler?: (data: string) => void;
  private resizeHandler?: () => void;

  constructor(
    private input: InputStream,
    private output: OutputStream,
    private cleanupInput?: () => void,
  ) {}

  start(onInput: (data: string) => void, onResize: () => void): void {
    this.inputHandler = onInput;
    this.resizeHandler = onResize;

    this.wasRaw = this.input.isRaw || false;
    if (this.input.setRawMode) {
      this.input.setRawMode(true);
    }
    this.input.setEncoding("utf8");
    this.input.resume();

    this.output.write("\x1b[?2004h");

    this.input.on("data", this.inputHandler);
    this.output.on("resize", this.resizeHandler);
  }

  stop(): void {
    this.output.write("\x1b[?2004l");

    if (this.inputHandler) {
      this.input.removeListener("data", this.inputHandler);
      this.inputHandler = undefined;
    }
    if (this.resizeHandler) {
      this.output.removeListener("resize", this.resizeHandler);
      this.resizeHandler = undefined;
    }

    if (this.input.setRawMode) {
      this.input.setRawMode(this.wasRaw);
    }

    if (this.cleanupInput) {
      this.cleanupInput();
      this.cleanupInput = undefined;
    }
  }

  write(data: string): void {
    this.output.write(data);
  }

  get columns(): number {
    return this.output.columns || 80;
  }

  get rows(): number {
    return this.output.rows || 24;
  }

  moveBy(lines: number): void {
    if (lines > 0) {
      this.output.write(`\x1b[${lines}B`);
    } else if (lines < 0) {
      this.output.write(`\x1b[${-lines}A`);
    }
  }

  hideCursor(): void {
    this.output.write("\x1b[?25l");
  }

  showCursor(): void {
    this.output.write("\x1b[?25h");
  }

  clearLine(): void {
    this.output.write("\x1b[K");
  }

  clearFromCursor(): void {
    this.output.write("\x1b[J");
  }

  clearScreen(): void {
    this.output.write("\x1b[2J\x1b[H");
  }
}

/**
 * Create a terminal for Tau. If stdin is piped and we're still running in a TTY,
 * we fall back to reading input from /dev/tty so the chat remains interactive.
 */
export function createAppTerminal(): Terminal {
  // Normal mode: stdin is a TTY, use upstream ProcessTerminal.
  if (process.stdin.isTTY) {
    return new ProcessTerminal();
  }

  // If stdin is not a TTY but we're still in an interactive terminal,
  // try to read input from /dev/tty so the UI stays interactive.
  if (process.stdout.isTTY) {
    try {
      const fd = openSync("/dev/tty", "r");
      const input = new ReadStream(fd);
      return new TauTerminal(input, process.stdout, () => {
        input.destroy();
        try {
          closeSync(fd);
        } catch {
          // ignore
        }
      });
    } catch {
      // Fall through
    }
  }

  return new ProcessTerminal();
}
