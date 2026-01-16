import { Key, matchesKey, visibleWidth } from "@mariozechner/pi-tui";
import { Editor } from "./components/editor.js";
import { truncateFromEndByWidth } from "./components/one_line_segments.js";
import { getSkillAutocompleteToken } from "./slash_autocomplete.js";
import type { Theme } from "./theme/index.js";

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const DEFAULT_EDITOR_MAX_LINES = 22;
const MIN_EDITOR_LINES = 3;

export class CustomEditor extends Editor {
  private uiTheme: Theme;
  private headerLeft = "";
  private headerRight = "";
  private headerLeftStyle?: (text: string) => string;
  private headerRightStyle?: (text: string) => string;

  private maxVisibleLines = DEFAULT_EDITOR_MAX_LINES;
  private scrollTop = 0;

  public onCtrlC?: () => void;
  public onCtrlT?: () => void;
  public onCtrlO?: () => void;
  public onEscape?: () => void;
  public onShiftTab?: () => void;
  public onCtrlF?: () => void;
  public onCtrlR?: () => void;
  public onCtrlP?: () => void;
  public onCtrlS?: () => void;
  public onAltUp?: () => void;
  public beforeSubmit?: (text: string) => boolean;

  constructor(theme: Theme) {
    super(theme.editorTheme);
    this.uiTheme = theme;
  }

  setMaxVisibleLines(lines?: number): void {
    if (!lines || !Number.isFinite(lines)) {
      this.maxVisibleLines = DEFAULT_EDITOR_MAX_LINES;
      return;
    }
    const normalized = Math.floor(lines);
    this.maxVisibleLines = normalized > 0 ? normalized : DEFAULT_EDITOR_MAX_LINES;
  }

  setHeader(
    left: string,
    right: string,
    styles?: { leftStyle?: (text: string) => string; rightStyle?: (text: string) => string },
  ): void {
    this.headerLeft = left;
    this.headerRight = right;
    this.headerLeftStyle = styles?.leftStyle;
    this.headerRightStyle = styles?.rightStyle;
  }

  render(width: number): string[] {
    if (width <= 0) return [""];
    if (width === 1) return [this.borderColor("─")];
    if (width === 2) return [this.renderHeaderLine(width)];

    const innerWidth = width - 2;
    this.lastWidth = innerWidth;

    const maxVisibleLines = this.getMaxVisibleLines();
    const maxContentLines = Math.max(1, maxVisibleLines - 2);
    const contentLines = this.renderEditorContent(innerWidth, maxContentLines);
    const autocompleteLines = this.renderAutocompleteLines(innerWidth);

    const vertical = this.borderColor("│");
    const rendered: string[] = [];
    rendered.push(this.renderHeaderLine(width));

    if (contentLines.length === 0) {
      rendered.push(`${vertical}${" ".repeat(innerWidth)}${vertical}`);
    } else {
      for (const line of contentLines) {
        rendered.push(`${vertical}${this.fitContentLine(line, innerWidth)}${vertical}`);
      }
    }

    rendered.push(this.renderFooterLine(width));

    if (autocompleteLines.length > 0) {
      for (const line of autocompleteLines) {
        const padded = this.padToWidth(line, width - 1);
        rendered.push(` ${padded}`);
      }
    }

    return rendered;
  }

  handleInput(data: string): void {
    if (matchesKey(data, Key.shift("tab")) && this.onShiftTab) {
      this.onShiftTab();
      return;
    }

    if (matchesKey(data, Key.ctrl("c")) && this.onCtrlC) {
      this.onCtrlC();
      return;
    }

    if (matchesKey(data, Key.ctrl("t")) && this.onCtrlT) {
      this.onCtrlT();
      return;
    }

    if (matchesKey(data, Key.ctrl("o")) && this.onCtrlO && !this.isShowingAutocomplete()) {
      this.onCtrlO();
      return;
    }

    if (matchesKey(data, Key.ctrl("f")) && this.onCtrlF && !this.isShowingAutocomplete()) {
      this.onCtrlF();
      return;
    }

    if (matchesKey(data, Key.ctrl("r")) && this.onCtrlR && !this.isShowingAutocomplete()) {
      this.onCtrlR();
      return;
    }

    if (matchesKey(data, Key.ctrl("p")) && this.onCtrlP && !this.isShowingAutocomplete()) {
      this.onCtrlP();
      return;
    }

    if (matchesKey(data, Key.ctrl("s")) && this.onCtrlS && !this.isShowingAutocomplete()) {
      this.onCtrlS();
      return;
    }

    if (matchesKey(data, Key.alt("up")) && this.onAltUp && !this.isShowingAutocomplete()) {
      this.onAltUp();
      return;
    }

    if (matchesKey(data, Key.enter) && this.beforeSubmit && !this.isShowingAutocomplete()) {
      if (!this.beforeSubmit(this.getText())) {
        return;
      }
    }

    if (matchesKey(data, Key.escape) && this.onEscape && !this.isShowingAutocomplete()) {
      this.onEscape();
      return;
    }

    if (matchesKey(data, Key.up) && !this.isShowingAutocomplete()) {
      this.handleCursorUp();
      return;
    }

    if (matchesKey(data, Key.down) && !this.isShowingAutocomplete()) {
      this.handleCursorDown();
      return;
    }

    super.handleInput(data);

    this.tryTriggerSkillAutocomplete(data);
  }

  private tryTriggerSkillAutocomplete(data: string): void {
    if (this.isShowingAutocomplete()) return;
    if (!this.shouldTriggerAutocompleteForInput(data)) return;

    const { line, col } = this.getCursor();
    const current = this.getLines()[line] ?? "";
    const beforeCursor = current.slice(0, col);

    if (!getSkillAutocompleteToken(beforeCursor)) return;

    this.tryTriggerAutocomplete();
  }

  private shouldTriggerAutocompleteForInput(data: string): boolean {
    if (!data) return false;
    if (data.startsWith("\u001b")) return false;

    const lastChar = data[data.length - 1];
    if (!lastChar || /\s/.test(lastChar)) return false;

    return true;
  }

  private handleCursorUp(): void {
    this.handleCursorVertical(-1);
  }

  private handleCursorDown(): void {
    this.handleCursorVertical(1);
  }

  private handleCursorVertical(direction: 1 | -1): void {
    const lines = this.getLines();
    const cursor = this.getCursor();
    const historyIndex = this.historyIndex;
    const isEmpty = lines.length === 1 && (lines[0] ?? "") === "";

    if (isEmpty) {
      this.navigateHistory(direction);
      return;
    }

    if (historyIndex > -1) {
      if (direction === -1 && this.isOnFirstVisualLinePreserveIndent()) {
        this.navigateHistory(-1);
        return;
      }

      if (direction === 1 && this.isOnLastVisualLinePreserveIndent()) {
        this.navigateHistory(1);
        return;
      }
    }

    const width = Math.max(1, this.lastWidth);
    const visualLines = this.buildVisualLineMapPreserveIndent(width);
    if (visualLines.length === 0) return;

    const currentVisualLine = this.findCurrentVisualLinePreserveIndent(
      visualLines,
      cursor.line,
      cursor.col,
    );
    const currentVL = visualLines[currentVisualLine];
    if (!currentVL) return;

    const visualCol = cursor.col - currentVL.startCol;
    const targetVisualLine = currentVisualLine + direction;
    if (targetVisualLine < 0 || targetVisualLine >= visualLines.length) return;

    const targetVL = visualLines[targetVisualLine];
    if (!targetVL) return;

    const logicalLine = lines[targetVL.logicalLine] ?? "";
    const targetCol = targetVL.startCol + Math.min(visualCol, targetVL.length);

    this.state.cursorLine = targetVL.logicalLine;
    this.state.cursorCol = Math.min(targetCol, logicalLine.length);
  }

  private isOnFirstVisualLinePreserveIndent(): boolean {
    const width = Math.max(1, this.lastWidth);
    const visualLines = this.buildVisualLineMapPreserveIndent(width);
    const cursor = this.getCursor();
    const currentVisualLine = this.findCurrentVisualLinePreserveIndent(
      visualLines,
      cursor.line,
      cursor.col,
    );
    return currentVisualLine === 0;
  }

  private isOnLastVisualLinePreserveIndent(): boolean {
    const width = Math.max(1, this.lastWidth);
    const visualLines = this.buildVisualLineMapPreserveIndent(width);
    const cursor = this.getCursor();
    const currentVisualLine = this.findCurrentVisualLinePreserveIndent(
      visualLines,
      cursor.line,
      cursor.col,
    );
    return currentVisualLine === visualLines.length - 1;
  }

  private buildVisualLineMapPreserveIndent(
    width: number,
  ): Array<{ logicalLine: number; startCol: number; length: number }> {
    const lines = this.getLines();
    const visualLines: Array<{ logicalLine: number; startCol: number; length: number }> = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? "";
      const lineVisWidth = visibleWidth(line);

      if (line.length === 0) {
        visualLines.push({ logicalLine: i, startCol: 0, length: 0 });
        continue;
      }

      if (lineVisWidth <= width) {
        visualLines.push({ logicalLine: i, startCol: 0, length: line.length });
        continue;
      }

      const chunks = this.wordWrapLinePreserveIndent(line, width);
      for (const chunk of chunks) {
        visualLines.push({
          logicalLine: i,
          startCol: chunk.startIndex,
          length: chunk.endIndex - chunk.startIndex,
        });
      }
    }

    return visualLines;
  }

  private findCurrentVisualLinePreserveIndent(
    visualLines: Array<{ logicalLine: number; startCol: number; length: number }>,
    cursorLine: number,
    cursorCol: number,
  ): number {
    if (visualLines.length === 0) return 0;

    for (let i = 0; i < visualLines.length; i++) {
      const vl = visualLines[i];
      if (!vl) continue;

      if (vl.logicalLine === cursorLine) {
        const colInSegment = cursorCol - vl.startCol;
        const isLastSegmentOfLine =
          i === visualLines.length - 1 || visualLines[i + 1]?.logicalLine !== vl.logicalLine;

        if (
          colInSegment >= 0 &&
          (colInSegment < vl.length || (isLastSegmentOfLine && colInSegment <= vl.length))
        ) {
          return i;
        }
      }
    }

    return visualLines.length - 1;
  }

  private renderHeaderLine(width: number): string {
    if (width <= 1) return this.borderColor("─").repeat(Math.max(0, width));
    if (width === 2) {
      return `${this.borderColor("╭")}${this.borderColor("╮")}`;
    }

    const innerWidth = width - 2;
    const dash = this.borderColor("─");
    const leftCorner = this.borderColor("╭");
    const rightCorner = this.borderColor("╮");

    let left = this.headerLeft.trim();
    let right = this.headerRight.trim();

    const measure = () => {
      const leftWidth = left ? visibleWidth(left) : 0;
      const rightWidth = right ? visibleWidth(right) : 0;
      const leftPad = left ? 2 : 0;
      const rightPad = right ? 2 : 0;
      const fixed = 1 + 1 + leftPad + rightPad + leftWidth + rightWidth;
      return { leftWidth, rightWidth, leftPad, rightPad, fixed };
    };

    let metrics = measure();

    if (metrics.fixed > innerWidth && left) {
      const allowed = Math.max(0, innerWidth - (1 + 1 + (right ? visibleWidth(right) + 2 : 0) + 2));
      left = truncateFromEndByWidth(left, allowed);
      if (visibleWidth(left) === 0) left = "";
      metrics = measure();
    }

    if (metrics.fixed > innerWidth && right) {
      const allowed = Math.max(0, innerWidth - (1 + 1 + (left ? visibleWidth(left) + 2 : 0) + 2));
      right = truncateFromEndByWidth(right, allowed);
      if (visibleWidth(right) === 0) right = "";
      metrics = measure();
    }

    if (metrics.fixed > innerWidth) {
      left = "";
      right = "";
      metrics = measure();
    }

    const fillWidth = Math.max(0, innerWidth - metrics.fixed);
    const leftStyle = this.headerLeftStyle ?? this.uiTheme.palette.textDim;
    const rightStyle = this.headerRightStyle ?? this.uiTheme.palette.textDim;
    const leftSegment = left ? ` ${leftStyle(left)} ` : "";
    const rightSegment = right ? ` ${rightStyle(right)} ` : "";
    const fill = dash.repeat(fillWidth);

    return `${leftCorner}${dash}${leftSegment}${fill}${rightSegment}${dash}${rightCorner}`;
  }

  private renderFooterLine(width: number): string {
    if (width <= 1) return this.borderColor("─").repeat(Math.max(0, width));
    const innerWidth = Math.max(0, width - 2);
    return `${this.borderColor("╰")}${this.borderColor("─").repeat(innerWidth)}${this.borderColor("╯")}`;
  }

  private padToWidth(line: string, width: number): string {
    const pad = Math.max(0, width - visibleWidth(line));
    return `${line}${" ".repeat(pad)}`;
  }

  private fitContentLine(line: string, width: number): string {
    const lineWidth = visibleWidth(line);
    if (lineWidth === width) return line;
    if (lineWidth > width) {
      return this.padToWidth(this.truncateFromEndByWidthPreserveAnsi(line, width), width);
    }
    return this.padToWidth(line, width);
  }

  private truncateFromEndByWidthPreserveAnsi(text: string, maxCols: number): string {
    if (!text.includes("\x1b")) {
      return truncateFromEndByWidth(text, maxCols);
    }

    if (maxCols <= 0) return "";
    if (visibleWidth(text) <= maxCols) return text;
    if (maxCols === 1) return "…";

    const ellipsis = "…";
    const targetCols = Math.max(0, maxCols - visibleWidth(ellipsis));
    if (targetCols <= 0) return ellipsis;

    const parts = this.splitAnsiParts(text);

    let out = "";
    let outCols = 0;

    outer: for (const part of parts) {
      if (part.type === "ansi") {
        out += part.value;
        continue;
      }

      for (const g of this.segmentGraphemes(part.value)) {
        const gCols = visibleWidth(g);
        if (outCols + gCols > targetCols) break outer;
        out += g;
        outCols += gCols;
      }
    }

    // If we truncated, ensure we reset any active SGR to avoid leaking styles.
    if (!out.endsWith("\x1b[0m")) {
      out += `${ellipsis}\x1b[0m`;
      return out;
    }

    return `${out}${ellipsis}`;
  }

  private splitAnsiParts(text: string): Array<{ type: "ansi" | "text"; value: string }> {
    const parts: Array<{ type: "ansi" | "text"; value: string }> = [];
    let i = 0;

    while (i < text.length) {
      const escIndex = text.indexOf("\x1b", i);
      if (escIndex === -1) {
        const tail = text.slice(i);
        if (tail) parts.push({ type: "text", value: tail });
        break;
      }

      if (escIndex > i) {
        const chunk = text.slice(i, escIndex);
        if (chunk) parts.push({ type: "text", value: chunk });
      }

      const parsed = this.parseAnsiSequence(text, escIndex);
      if (parsed) {
        parts.push({ type: "ansi", value: parsed.sequence });
        i = parsed.nextIndex;
      } else {
        parts.push({ type: "text", value: "\x1b" });
        i = escIndex + 1;
      }
    }

    return parts;
  }

  private parseAnsiSequence(
    text: string,
    start: number,
  ): { sequence: string; nextIndex: number } | null {
    if (text[start] !== "\x1b") return null;

    const next = text[start + 1];

    if (next === "[") {
      let i = start + 2;
      while (i < text.length) {
        const code = text.charCodeAt(i);
        if (code >= 0x40 && code <= 0x7e) {
          i++;
          return { sequence: text.slice(start, i), nextIndex: i };
        }
        i++;
      }
      return { sequence: text.slice(start), nextIndex: text.length };
    }

    if (next === "]") {
      // OSC: terminate on BEL or ST (ESC backslash)
      let i = start + 2;
      while (i < text.length) {
        const c = text[i];
        if (c === "\x07") {
          i++;
          return { sequence: text.slice(start, i), nextIndex: i };
        }

        if (c === "\x1b" && text[i + 1] === "\\") {
          i += 2;
          return { sequence: text.slice(start, i), nextIndex: i };
        }

        i++;
      }
      return { sequence: text.slice(start), nextIndex: text.length };
    }

    return null;
  }

  private renderEditorContent(width: number, maxContentLines: number): string[] {
    if (width <= 0) return [""];
    const layoutLines = this.layoutTextPreserveIndent(width);
    const visibleLines = this.sliceVisibleLayoutLines(layoutLines, maxContentLines);
    const lines: string[] = [];
    for (const layoutLine of visibleLines) {
      let displayText = layoutLine.text;
      let lineVisibleWidth = visibleWidth(layoutLine.text);

      if (layoutLine.hasCursor && layoutLine.cursorPos !== undefined) {
        const before = displayText.slice(0, layoutLine.cursorPos);
        const after = displayText.slice(layoutLine.cursorPos);
        if (after.length > 0) {
          const firstGrapheme = this.getFirstGrapheme(after);
          const restAfter = after.slice(firstGrapheme.length);
          const cursor = `\x1b[7m${firstGrapheme}\x1b[0m`;
          displayText = before + cursor + restAfter;
        } else {
          if (lineVisibleWidth < width) {
            const cursor = "\x1b[7m \x1b[0m";
            displayText = before + cursor;
            lineVisibleWidth = lineVisibleWidth + 1;
          } else {
            const lastGrapheme = this.getLastGrapheme(before);
            if (lastGrapheme) {
              const beforeWithoutLast = this.sliceWithoutLastGrapheme(before);
              const cursor = `\x1b[7m${lastGrapheme}\x1b[0m`;
              displayText = beforeWithoutLast + cursor;
            }
          }
        }
      }

      const padding = " ".repeat(Math.max(0, width - lineVisibleWidth));
      lines.push(displayText + padding);
    }

    return lines.length > 0 ? lines : [""];
  }

  private renderAutocompleteLines(width: number): string[] {
    if (!this.isShowingAutocomplete() || !this.autocompleteList) return [];
    return this.autocompleteList.render(width);
  }

  private sliceVisibleLayoutLines(
    layoutLines: Array<{ text: string; hasCursor: boolean; cursorPos?: number }>,
    maxContentLines: number,
  ): Array<{ text: string; hasCursor: boolean; cursorPos?: number }> {
    if (maxContentLines <= 0) return layoutLines.slice(0, 1);
    if (layoutLines.length <= maxContentLines) {
      this.scrollTop = 0;
      return layoutLines;
    }

    const cursorIndex = layoutLines.findIndex((line) => line.hasCursor);
    let nextScrollTop = this.scrollTop;
    if (cursorIndex >= 0) {
      if (cursorIndex < nextScrollTop) {
        nextScrollTop = cursorIndex;
      } else if (cursorIndex >= nextScrollTop + maxContentLines) {
        nextScrollTop = cursorIndex - maxContentLines + 1;
      }
    }

    const maxScrollTop = Math.max(0, layoutLines.length - maxContentLines);
    nextScrollTop = Math.max(0, Math.min(nextScrollTop, maxScrollTop));
    this.scrollTop = nextScrollTop;
    return layoutLines.slice(nextScrollTop, nextScrollTop + maxContentLines);
  }

  private getMaxVisibleLines(): number {
    const configured = this.maxVisibleLines > 0 ? this.maxVisibleLines : DEFAULT_EDITOR_MAX_LINES;
    const terminalRows =
      typeof process !== "undefined" && process.stdout?.rows ? process.stdout.rows : undefined;
    const terminalCap = terminalRows && terminalRows > 0 ? terminalRows : configured;
    const minLines = Math.min(MIN_EDITOR_LINES, terminalCap);
    return Math.max(minLines, Math.min(configured, terminalCap));
  }

  private layoutTextPreserveIndent(
    contentWidth: number,
  ): Array<{ text: string; hasCursor: boolean; cursorPos?: number }> {
    if (contentWidth <= 0) {
      return [{ text: "", hasCursor: true, cursorPos: 0 }];
    }

    const lines = this.getLines();
    const cursor = this.getCursor();
    if (lines.length === 0 || (lines.length === 1 && lines[0] === "")) {
      return [{ text: "", hasCursor: true, cursorPos: 0 }];
    }

    const layoutLines: Array<{ text: string; hasCursor: boolean; cursorPos?: number }> = [];

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] ?? "";
      const isCurrentLine = i === cursor.line;
      const lineVisibleWidth = visibleWidth(line);

      if (lineVisibleWidth <= contentWidth) {
        if (isCurrentLine) {
          layoutLines.push({ text: line, hasCursor: true, cursorPos: cursor.col });
        } else {
          layoutLines.push({ text: line, hasCursor: false });
        }
        continue;
      }

      const chunks = this.wordWrapLinePreserveIndent(line, contentWidth);
      for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
        const chunk = chunks[chunkIndex];
        if (!chunk || chunk.text.length === 0) continue;

        let hasCursorInChunk = false;
        let adjustedCursorPos = 0;
        const isLastChunk = chunkIndex === chunks.length - 1;

        if (isCurrentLine) {
          if (isLastChunk) {
            hasCursorInChunk = cursor.col >= chunk.startIndex;
            adjustedCursorPos = cursor.col - chunk.startIndex;
          } else {
            hasCursorInChunk = cursor.col >= chunk.startIndex && cursor.col < chunk.endIndex;
            if (hasCursorInChunk) {
              adjustedCursorPos = cursor.col - chunk.startIndex;
              if (adjustedCursorPos > chunk.text.length) {
                adjustedCursorPos = chunk.text.length;
              }
            }
          }
        }

        if (hasCursorInChunk) {
          layoutLines.push({
            text: chunk.text,
            hasCursor: true,
            cursorPos: adjustedCursorPos,
          });
        } else {
          layoutLines.push({ text: chunk.text, hasCursor: false });
        }
      }
    }

    return layoutLines;
  }

  private wordWrapLinePreserveIndent(
    line: string,
    maxWidth: number,
  ): Array<{ text: string; startIndex: number; endIndex: number }> {
    if (!line || maxWidth <= 0) {
      return [{ text: "", startIndex: 0, endIndex: 0 }];
    }

    const lineWidth = visibleWidth(line);
    if (lineWidth <= maxWidth) {
      return [{ text: line, startIndex: 0, endIndex: line.length }];
    }

    const tokens: Array<{
      text: string;
      startIndex: number;
      endIndex: number;
      isWhitespace: boolean;
    }> = [];
    let currentToken = "";
    let tokenStart = 0;
    let inWhitespace = false;
    let charIndex = 0;

    for (const seg of this.segmentGraphemes(line)) {
      const grapheme = seg;
      const graphemeIsWhitespace = this.isWhitespace(grapheme);
      if (currentToken === "") {
        inWhitespace = graphemeIsWhitespace;
        tokenStart = charIndex;
      } else if (graphemeIsWhitespace !== inWhitespace) {
        tokens.push({
          text: currentToken,
          startIndex: tokenStart,
          endIndex: charIndex,
          isWhitespace: inWhitespace,
        });
        currentToken = "";
        tokenStart = charIndex;
        inWhitespace = graphemeIsWhitespace;
      }
      currentToken += grapheme;
      charIndex += grapheme.length;
    }

    if (currentToken) {
      tokens.push({
        text: currentToken,
        startIndex: tokenStart,
        endIndex: charIndex,
        isWhitespace: inWhitespace,
      });
    }

    const chunks: Array<{ text: string; startIndex: number; endIndex: number }> = [];
    let currentChunk = "";
    let currentWidth = 0;
    let chunkStartIndex = 0;
    let atLineStart = true;
    let firstChunk = true;

    const takeByWidth = (
      text: string,
      maxCols: number,
    ): { text: string; width: number; length: number } => {
      if (maxCols <= 0) return { text: "", width: 0, length: 0 };
      let chunk = "";
      let chunkWidth = 0;
      let chunkLength = 0;
      for (const grapheme of this.segmentGraphemes(text)) {
        const graphemeWidth = visibleWidth(grapheme);
        if (chunkWidth + graphemeWidth > maxCols) break;
        chunk += grapheme;
        chunkWidth += graphemeWidth;
        chunkLength += grapheme.length;
      }
      return { text: chunk, width: chunkWidth, length: chunkLength };
    };

    for (const token of tokens) {
      let tokenText = token.text;
      let tokenStartIndex = token.startIndex;
      const tokenIsWhitespace = token.isWhitespace;

      while (tokenText) {
        const tokenWidth = visibleWidth(tokenText);

        if (atLineStart && tokenIsWhitespace) {
          if (firstChunk) {
            // Preserve leading indentation for the first visual chunk.
            currentChunk += tokenText;
            currentWidth += tokenWidth;
            chunkStartIndex = tokenStartIndex;
            atLineStart = false;
            break;
          }
          const tokenEndIndex = tokenStartIndex + tokenText.length;
          tokenText = "";
          chunkStartIndex = tokenEndIndex;
          break;
        }

        atLineStart = false;

        if (
          firstChunk &&
          currentChunk &&
          currentChunk.trim().length === 0 &&
          !tokenIsWhitespace &&
          currentWidth < maxWidth &&
          currentWidth + tokenWidth > maxWidth
        ) {
          const remainingWidth = maxWidth - currentWidth;
          const head = takeByWidth(tokenText, remainingWidth);
          if (head.text) {
            currentChunk += head.text;
            currentWidth += head.width;
            chunks.push({
              text: currentChunk,
              startIndex: chunkStartIndex,
              endIndex: tokenStartIndex + head.length,
            });
            firstChunk = false;
          }
          tokenText = tokenText.slice(head.length);
          tokenStartIndex += head.length;
          currentChunk = "";
          currentWidth = 0;
          chunkStartIndex = tokenStartIndex;
          atLineStart = true;
          if (!tokenText) break;
        }

        if (tokenWidth > maxWidth) {
          if (currentChunk) {
            chunks.push({
              text: currentChunk,
              startIndex: chunkStartIndex,
              endIndex: tokenStartIndex,
            });
            currentChunk = "";
            currentWidth = 0;
            chunkStartIndex = tokenStartIndex;
            firstChunk = false;
          }

          let tokenChunk = "";
          let tokenChunkWidth = 0;
          let tokenChunkStart = tokenStartIndex;
          let tokenCharIndex = tokenStartIndex;

          for (const grapheme of this.segmentGraphemes(tokenText)) {
            const graphemeWidth = visibleWidth(grapheme);
            if (tokenChunkWidth + graphemeWidth > maxWidth && tokenChunk) {
              chunks.push({
                text: tokenChunk,
                startIndex: tokenChunkStart,
                endIndex: tokenCharIndex,
              });
              tokenChunk = grapheme;
              tokenChunkWidth = graphemeWidth;
              tokenChunkStart = tokenCharIndex;
              firstChunk = false;
            } else {
              tokenChunk += grapheme;
              tokenChunkWidth += graphemeWidth;
            }
            tokenCharIndex += grapheme.length;
          }

          if (tokenChunk) {
            currentChunk = tokenChunk;
            currentWidth = tokenChunkWidth;
            chunkStartIndex = tokenChunkStart;
          }
          break;
        }

        if (currentWidth + tokenWidth > maxWidth) {
          const trimmedChunk = currentChunk.trimEnd();
          const chunkText = trimmedChunk.length === 0 ? currentChunk : trimmedChunk;
          if (chunkText || chunks.length === 0) {
            chunks.push({
              text: chunkText,
              startIndex: chunkStartIndex,
              endIndex: chunkStartIndex + currentChunk.length,
            });
            firstChunk = false;
          }

          atLineStart = true;
          if (tokenIsWhitespace) {
            currentChunk = "";
            currentWidth = 0;
            chunkStartIndex = tokenStartIndex + tokenText.length;
            break;
          }

          currentChunk = tokenText;
          currentWidth = tokenWidth;
          chunkStartIndex = tokenStartIndex;
          atLineStart = false;
          break;
        }

        currentChunk += tokenText;
        currentWidth += tokenWidth;
        break;
      }
    }

    if (currentChunk) {
      chunks.push({
        text: currentChunk,
        startIndex: chunkStartIndex,
        endIndex: line.length,
      });
    }

    return chunks.length > 0 ? chunks : [{ text: "", startIndex: 0, endIndex: 0 }];
  }

  private segmentGraphemes(text: string): string[] {
    if (graphemeSegmenter) {
      return Array.from(graphemeSegmenter.segment(text), (s) => s.segment);
    }
    return Array.from(text);
  }

  private getFirstGrapheme(text: string): string {
    const segments = this.segmentGraphemes(text);
    return segments[0] ?? "";
  }

  private getLastGrapheme(text: string): string {
    const segments = this.segmentGraphemes(text);
    return segments.length > 0 ? (segments[segments.length - 1] ?? "") : "";
  }

  private sliceWithoutLastGrapheme(text: string): string {
    const segments = this.segmentGraphemes(text);
    if (segments.length === 0) return text;
    segments.pop();
    return segments.join("");
  }

  private isWhitespace(char: string): boolean {
    return /\s/.test(char);
  }
}
