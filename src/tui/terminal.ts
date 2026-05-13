import { closeSync, openSync } from "node:fs";
import { ReadStream } from "node:tty";
import {
  ProcessTerminal,
  StdinBuffer,
  setKittyProtocolActive,
  type Terminal,
} from "@earendil-works/pi-tui";

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
  private _kittyProtocolActive = false;
  private stdinBuffer?: StdinBuffer;
  private stdinDataHandler?: (data: string) => void;

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

    this.output.on("resize", this.resizeHandler);

    if (process.platform !== "win32") {
      process.kill(process.pid, "SIGWINCH");
    }

    this.queryAndEnableKittyProtocol();
  }

  private setupStdinBuffer(): void {
    this.stdinBuffer = new StdinBuffer({ timeout: 10 });

    // biome-ignore lint/suspicious/noControlCharactersInRegex: kitty keyboard response is an ESC sequence
    const kittyResponsePattern = /^\x1b\[\?(\d+)u$/;

    this.stdinBuffer.on("data", (sequence) => {
      if (!this._kittyProtocolActive) {
        const match = sequence.match(kittyResponsePattern);
        if (match) {
          this._kittyProtocolActive = true;
          setKittyProtocolActive(true);

          this.output.write("\x1b[>7u");
          return;
        }
      }

      if (this.inputHandler) {
        this.inputHandler(sequence);
      }
    });

    this.stdinBuffer.on("paste", (content) => {
      if (this.inputHandler) {
        this.inputHandler(`\x1b[200~${content}\x1b[201~`);
      }
    });

    this.stdinDataHandler = (data: string) => {
      this.stdinBuffer!.process(data);
    };
  }

  private queryAndEnableKittyProtocol(): void {
    this.setupStdinBuffer();
    this.input.on("data", this.stdinDataHandler!);
    this.output.write("\x1b[?u");
  }

  async drainInput(maxMs = 1000, idleMs = 50): Promise<void> {
    if (this._kittyProtocolActive) {
      this.output.write("\x1b[<u");
      this._kittyProtocolActive = false;
      setKittyProtocolActive(false);
    }

    const previousHandler = this.inputHandler;
    this.inputHandler = undefined;

    let lastDataTime = Date.now();
    const onData = () => {
      lastDataTime = Date.now();
    };

    this.input.on("data", onData);
    const endTime = Date.now() + maxMs;

    try {
      while (true) {
        const now = Date.now();
        const timeLeft = endTime - now;
        if (timeLeft <= 0) break;
        if (now - lastDataTime >= idleMs) break;
        await new Promise((resolve) => setTimeout(resolve, Math.min(idleMs, timeLeft)));
      }
    } finally {
      this.input.removeListener("data", onData);
      this.inputHandler = previousHandler;
    }
  }

  stop(): void {
    this.output.write("\x1b[?2004l");

    if (this._kittyProtocolActive) {
      this.output.write("\x1b[<u");
      this._kittyProtocolActive = false;
      setKittyProtocolActive(false);
    }

    if (this.stdinBuffer) {
      this.stdinBuffer.destroy();
      this.stdinBuffer = undefined;
    }

    if (this.stdinDataHandler) {
      this.input.removeListener("data", this.stdinDataHandler);
      this.stdinDataHandler = undefined;
    }
    this.inputHandler = undefined;
    if (this.resizeHandler) {
      this.output.removeListener("resize", this.resizeHandler);
      this.resizeHandler = undefined;
    }

    this.input.pause();

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

  get kittyProtocolActive(): boolean {
    return this._kittyProtocolActive;
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

  setTitle(title: string): void {
    const safeTitle = Array.from(title)
      .filter((char) => {
        const code = char.codePointAt(0);
        return code !== undefined && !(code <= 0x1f || code === 0x7f);
      })
      .join("");
    this.output.write(`\x1b]0;${safeTitle}\x07`);
  }

  setProgress(active: boolean): void {
    if (active) {
      this.output.write("\x1b]9;4;3\x07");
    } else {
      this.output.write("\x1b]9;4;0;\x07");
    }
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
