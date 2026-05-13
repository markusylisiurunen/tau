import { Key, matchesKey, visibleWidth } from "@earendil-works/pi-tui";
import { DOUBLE_PRESS_WINDOW_MS } from "../constants.js";
import { Editor } from "./components/editor.js";
import {
  truncateFromEndByWidth,
  truncateFromEndByWidthPreserveAnsi,
} from "./components/one_line_segments.js";
import { getMentionAutocompleteToken } from "./slash_autocomplete.js";
import type { Theme } from "./theme/index.js";

const graphemeSegmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const DEFAULT_EDITOR_MAX_LINES = 22;
const MIN_EDITOR_LINES = 5;

export class CustomEditor extends Editor {
  private uiTheme: Theme;
  private headerLeft = "";
  private headerRight = "";
  private headerLeftStyle?: (text: string) => string;
  private headerRightStyle?: (text: string) => string;

  private maxVisibleLines = DEFAULT_EDITOR_MAX_LINES;
  private scrollTop = 0;
  private lastEscapeAt?: number;
  private inputEnabled = true;

  public onCtrlC?: () => void;
  public onCtrlT?: () => void;
  public onCtrlO?: () => void;
  public onEscape?: () => void;
  public onShiftTab?: () => void;
  public onCtrlF?: () => void;
  public onCtrlR?: () => void;
  public onCtrlP?: () => void;
  public onCtrlS?: () => void;
  public onCtrlY?: () => void;
  public onCtrlG?: () => void;
  public onAltUp?: () => void;
  public onAltDown?: () => void;
  public beforeSubmit?: (text: string) => boolean;

  constructor(theme: Theme) {
    super(theme.editorTheme);
    this.uiTheme = theme;
  }

  protected override cursorStyle(text: string): string {
    return this.uiTheme.text.cursor(text);
  }

  setUiTheme(theme: Theme): void {
    this.uiTheme = theme;
    super.setTheme(theme.editorTheme);
  }

  setMaxVisibleLines(lines?: number): void {
    if (!lines || !Number.isFinite(lines)) {
      this.maxVisibleLines = DEFAULT_EDITOR_MAX_LINES;
      return;
    }
    const normalized = Math.floor(lines);
    this.maxVisibleLines = normalized > 0 ? normalized : DEFAULT_EDITOR_MAX_LINES;
  }

  setInputEnabled(enabled: boolean): void {
    this.inputEnabled = enabled;
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

    const { minLines, maxLines } = this.getVisibleLineBounds();
    const maxContentLines = Math.max(1, maxLines - 2);
    const minContentLines = Math.max(1, minLines - 2);
    const contentLines = this.renderEditorContent(innerWidth, maxContentLines, minContentLines);
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

  setText(text: string): void {
    this.scrollTop = 0;
    super.setText(text);
  }

  handleInput(data: string): void {
    const previousText = this.getText();
    const isEscape = matchesKey(data, Key.escape);
    const isAltUp = matchesKey(data, Key.alt("up")) || data === "\x1b[1;3A";
    const isAltDown = matchesKey(data, Key.alt("down")) || data === "\x1b[1;3B";

    if (!isEscape) {
      this.lastEscapeAt = undefined;
    } else if (this.isShowingAutocomplete()) {
      this.lastEscapeAt = undefined;
    }

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

    if (matchesKey(data, Key.ctrl("g")) && this.onCtrlG && !this.isShowingAutocomplete()) {
      this.onCtrlG();
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

    if (matchesKey(data, Key.ctrl("y")) && this.onCtrlY && !this.isShowingAutocomplete()) {
      this.onCtrlY();
      return;
    }

    if (isAltUp && this.onAltUp && !this.isShowingAutocomplete()) {
      this.onAltUp();
      return;
    }

    if (isAltDown && this.onAltDown && !this.isShowingAutocomplete()) {
      this.onAltDown();
      return;
    }

    if (matchesKey(data, Key.enter) && this.beforeSubmit && !this.isShowingAutocomplete()) {
      if (!this.beforeSubmit(this.getText())) {
        return;
      }
    }

    if (isEscape && !this.isShowingAutocomplete()) {
      const now = Date.now();
      if (this.lastEscapeAt !== undefined && now - this.lastEscapeAt <= DOUBLE_PRESS_WINDOW_MS) {
        this.lastEscapeAt = undefined;
        this.setText("");
        return;
      }
      this.lastEscapeAt = now;
      if (this.onEscape) {
        this.onEscape();
      }
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

    if (matchesKey(data, Key.pageUp) && !this.isShowingAutocomplete()) {
      this.handlePageScroll(-1);
      return;
    }

    if (matchesKey(data, Key.pageDown) && !this.isShowingAutocomplete()) {
      this.handlePageScroll(1);
      return;
    }

    if (!this.inputEnabled) {
      return;
    }

    super.handleInput(data);

    if (previousText && this.getText() === "") {
      this.scrollTop = 0;
    }

    this.tryTriggerMentionAutocomplete(data);
  }

  private tryTriggerMentionAutocomplete(data: string): void {
    if (this.isShowingAutocomplete()) return;
    if (!this.shouldTriggerAutocompleteForInput(data)) return;

    const { line, col } = this.getCursor();
    const current = this.getLines()[line] ?? "";
    const beforeCursor = current.slice(0, col);

    if (!getMentionAutocompleteToken(beforeCursor)) return;

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

  private handlePageScroll(direction: -1 | 1): void {
    const { maxLines } = this.getVisibleLineBounds();
    const maxContentLines = Math.max(1, maxLines - 2);
    const width = Math.max(1, this.lastWidth);
    const visualLines = this.buildVisualLineMapPreserveIndent(width);
    if (visualLines.length === 0) return;

    const cursor = this.getCursor();
    const currentVisualLine = this.findCurrentVisualLinePreserveIndent(
      visualLines,
      cursor.line,
      cursor.col,
    );
    const targetVisualLine = Math.max(
      0,
      Math.min(visualLines.length - 1, currentVisualLine + direction * maxContentLines),
    );
    const targetVL = visualLines[targetVisualLine];
    if (!targetVL) return;

    const currentVL = visualLines[currentVisualLine];
    const visualCol = currentVL ? cursor.col - currentVL.startCol : 0;
    const targetCol = targetVL.startCol + Math.min(visualCol, targetVL.length);
    const logicalLine = this.getLines()[targetVL.logicalLine] ?? "";
    this.state.cursorLine = targetVL.logicalLine;
    this.state.cursorCol = Math.min(targetCol, logicalLine.length);
    this.snapCursorToSegmentBoundary(logicalLine, direction < 0);
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
    this.snapCursorToSegmentBoundary(logicalLine, direction < 0);
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

  renderDividerLine(width: number): string {
    return this.renderHeaderLineWithCorners(width, "├", "┤");
  }

  renderDividerLineWithCornerStyle(width: number, cornerStyle: (text: string) => string): string {
    return this.renderHeaderLineWithCorners(width, "├", "┤", cornerStyle);
  }

  private renderHeaderLine(width: number): string {
    return this.renderHeaderLineWithCorners(width, "╭", "╮");
  }

  private renderHeaderLineWithCorners(
    width: number,
    leftCornerChar: string,
    rightCornerChar: string,
    cornerStyle?: (text: string) => string,
  ): string {
    if (width <= 1) return this.borderColor("─").repeat(Math.max(0, width));
    const corner = cornerStyle ?? this.borderColor;
    if (width === 2) {
      return `${corner(leftCornerChar)}${corner(rightCornerChar)}`;
    }

    const innerWidth = width - 2;
    const dash = this.borderColor("─");
    const leftCorner = corner(leftCornerChar);
    const rightCorner = corner(rightCornerChar);

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
      return this.padToWidth(truncateFromEndByWidthPreserveAnsi(line, width), width);
    }
    return this.padToWidth(line, width);
  }

  private renderEditorContent(
    width: number,
    maxContentLines: number,
    minContentLines: number,
  ): string[] {
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
          displayText = before + this.cursorStyle(firstGrapheme) + restAfter;
        } else {
          if (lineVisibleWidth < width) {
            displayText = before + this.cursorStyle(" ");
            lineVisibleWidth = lineVisibleWidth + 1;
          } else {
            const lastGrapheme = this.getLastGrapheme(before);
            if (lastGrapheme) {
              const beforeWithoutLast = this.sliceWithoutLastGrapheme(before);
              displayText = beforeWithoutLast + this.cursorStyle(lastGrapheme);
            }
          }
        }
      }

      const padding = " ".repeat(Math.max(0, width - lineVisibleWidth));
      lines.push(displayText + padding);
    }

    if (lines.length === 0) {
      lines.push(" ".repeat(width));
    }

    while (lines.length < minContentLines) {
      lines.push(" ".repeat(width));
    }

    return lines;
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

  private getVisibleLineBounds(): { minLines: number; maxLines: number } {
    const configured = this.maxVisibleLines > 0 ? this.maxVisibleLines : DEFAULT_EDITOR_MAX_LINES;
    const terminalRows =
      typeof process !== "undefined" && process.stdout?.rows ? process.stdout.rows : undefined;
    const terminalCap = terminalRows && terminalRows > 0 ? terminalRows : configured;
    const minLines = Math.min(MIN_EDITOR_LINES, terminalCap);
    const maxLines = Math.max(minLines, Math.min(configured, terminalCap));
    return { minLines, maxLines };
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

    for (const seg of this.segment(line)) {
      const grapheme = seg.segment;
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
    const segments = [...this.segment(text)];
    return segments[0]?.segment ?? "";
  }

  private getLastGrapheme(text: string): string {
    const segments = [...this.segment(text)];
    return segments.length > 0 ? (segments[segments.length - 1]?.segment ?? "") : "";
  }

  private sliceWithoutLastGrapheme(text: string): string {
    const segments = [...this.segment(text)];
    if (segments.length === 0) return text;
    segments.pop();
    return segments.map((segment) => segment.segment).join("");
  }

  private isWhitespace(char: string): boolean {
    return /\s/.test(char);
  }
}
