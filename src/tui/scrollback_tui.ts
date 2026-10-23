import { type Terminal, TuiMainScreen } from "@earendil-works/pi-tui";

/** A main-screen renderer whose offscreen rows belong to the terminal. */
export class ScrollbackTui extends TuiMainScreen {
  private redraw = false;
  private readonly viewport: { rows: number };

  constructor(private readonly sourceTerminal: Terminal) {
    const terminal = sourceTerminal;
    const viewport = { rows: terminal.rows };
    super({
      start: (onInput, onResize) => terminal.start(onInput, onResize),
      stop: () => terminal.stop(),
      drainInput: (maxMs, idleMs) => terminal.drainInput(maxMs, idleMs),
      write: (data) => terminal.write(data),
      get columns() {
        return terminal.columns;
      },
      get rows() {
        // Growth can expose terminal-owned history above our working area. Keep that
        // area anchored until detachment establishes a new origin at the screen top.
        viewport.rows = Math.min(viewport.rows, terminal.rows);
        return viewport.rows;
      },
      get kittyProtocolActive() {
        return terminal.kittyProtocolActive;
      },
      moveBy: (lines) => terminal.moveBy(lines),
      hideCursor: () => terminal.hideCursor(),
      showCursor: () => terminal.showCursor(),
      clearLine: () => terminal.clearLine(),
      clearFromCursor: () => terminal.clearFromCursor(),
      clearScreen: () => terminal.clearScreen(),
      setTitle: (title) => terminal.setTitle(title),
      setProgress: (active) => terminal.setProgress(active),
      setProgramStatus: (status) => terminal.setProgramStatus(status),
    });
    this.viewport = viewport;
  }

  get screenRows(): number {
    return this.sourceTerminal.rows;
  }

  resetViewport(rows: number): void {
    this.viewport.rows = rows;
  }

  protected override resetRenderState(): void {
    this.redraw = true;
  }

  protected override doRender(): void {
    if (this.stopped) return;
    const state = this.captureRenderState();
    const width = this.terminal.columns;
    const height = this.terminal.rows;
    let lines = this.render(width);
    if (this.hasOverlayEntries) lines = this.compositeOverlays(lines, width, height);
    const cursor = this.extractCursorPosition(lines, height);
    lines = this.applyLineResets(lines);
    let viewportTop = Math.max(state.previousViewportTop, state.hardwareCursorRow - height + 1);
    let first = lines.findIndex((line, index) => line !== state.previousLines[index]);
    if (first < 0 && lines.length !== state.previousLines.length) {
      first = Math.min(lines.length, state.previousLines.length);
    }
    if (this.redraw || state.previousWidth !== width || state.previousHeight !== height) {
      first = viewportTop;
    }
    this.redraw = false;
    let hardwareCursorRow = state.hardwareCursorRow;
    const moveTo = (row: number) => {
      const delta = row - hardwareCursorRow;
      if (delta > 0) this.terminal.write(`\x1b[${delta}B`);
      else if (delta < 0) this.terminal.write(`\x1b[${-delta}A`);
      hardwareCursorRow = row;
    };

    this.terminal.write("\x1b[?2026h");
    if (first >= 0) {
      first = Math.max(first, viewportTop);
      if (lines.length <= viewportTop) {
        moveTo(viewportTop);
        const start = Math.max(0, lines.length - height);
        hardwareCursorRow = start;
        viewportTop = start;
        first = start;
      }
      const start = Math.min(first, Math.max(0, state.previousLines.length - 1));
      moveTo(Math.max(viewportTop, start));
      this.terminal.write("\r");
      if (first > start) {
        this.terminal.write("\r\n".repeat(first - start));
        hardwareCursorRow = first;
      }
      this.terminal.write("\x1b[J");
      for (let index = first; index < lines.length; index += 1) {
        if (index > first) this.terminal.write("\r\n");
        this.terminal.write(lines[index]!);
        hardwareCursorRow = index;
      }
      viewportTop = Math.max(viewportTop, hardwareCursorRow - height + 1);
    }
    if (cursor) {
      moveTo(cursor.row);
      this.terminal.write(`\x1b[${cursor.col + 1}G`);
      if (this.getShowHardwareCursor()) this.terminal.showCursor();
      else this.terminal.hideCursor();
    } else {
      this.terminal.hideCursor();
    }
    this.terminal.write("\x1b[?2026l");
    this.restoreRenderState({
      previousLines: lines,
      previousWidth: width,
      previousHeight: height,
      cursorRow: Math.max(0, lines.length - 1),
      hardwareCursorRow,
      maxLinesRendered: lines.length,
      previousViewportTop: viewportTop,
    });
  }
}
