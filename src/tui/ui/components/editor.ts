import {
  type AutocompleteProvider,
  type CombinedAutocompleteProvider,
  type Component,
  decodeKittyPrintable,
  getEditorKeybindings,
  matchesKey,
  SelectList,
  type SelectListLayoutOptions,
  type SelectListTheme,
  truncateToWidth,
  visibleWidth,
} from "@mariozechner/pi-tui";

const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
const PASTE_MARKER_REGEX = /\[paste #(\d+)( (\+\d+ lines|\d+ chars))?\]/g;
const PASTE_MARKER_SINGLE = /^\[paste #(\d+)( (\+\d+ lines|\d+ chars))?\]$/;
const PUNCTUATION_REGEX = /[(){}[\]<>.,;:'"!?+\-=*/\\|&%^$#@~`]/;
const CSI_PATTERN = "\\x1b\\[[0-9;]*[A-Za-z]";
const OSC_PATTERN = "\\x1b\\][^\\x07]*(?:\\x07|\\x1b\\\\)";
const APC_PATTERN = "\\x1b_[^\\x07\\x1b]*(?:\\x07|\\x1b\\\\)";
const CSI_REGEX = new RegExp(CSI_PATTERN, "g");
const OSC_REGEX = new RegExp(OSC_PATTERN, "g");
const APC_REGEX = new RegExp(APC_PATTERN, "g");

function isWhitespaceChar(char: string): boolean {
  return /\s/.test(char);
}

function isPunctuationChar(char: string): boolean {
  return PUNCTUATION_REGEX.test(char);
}

function isPasteMarker(segment: string): boolean {
  return segment.length >= 10 && PASTE_MARKER_SINGLE.test(segment);
}

function segmentWithMarkers(text: string, validIds: Set<number>): Iterable<Intl.SegmentData> {
  if (validIds.size === 0 || !text.includes("[paste #")) {
    return segmenter.segment(text);
  }

  const markers: Array<{ start: number; end: number }> = [];
  for (const match of text.matchAll(PASTE_MARKER_REGEX)) {
    const id = Number.parseInt(match[1] ?? "", 10);
    if (!validIds.has(id)) continue;
    markers.push({ start: match.index ?? 0, end: (match.index ?? 0) + match[0].length });
  }
  if (markers.length === 0) {
    return segmenter.segment(text);
  }

  const baseSegments = segmenter.segment(text);
  const result: Intl.SegmentData[] = [];
  let markerIndex = 0;

  for (const seg of baseSegments) {
    while (markerIndex < markers.length && (markers[markerIndex]?.end ?? 0) <= seg.index) {
      markerIndex++;
    }

    const marker = markerIndex < markers.length ? markers[markerIndex] : null;
    if (marker && seg.index >= marker.start && seg.index < marker.end) {
      if (seg.index === marker.start) {
        result.push({
          segment: text.slice(marker.start, marker.end),
          index: marker.start,
          input: text,
        });
      }
      continue;
    }

    result.push(seg);
  }

  return result;
}

function stripAnsiSequences(text: string): string {
  if (!text.includes("\x1b")) return text;
  return text
    .replace(CSI_REGEX, "")
    .replace(OSC_REGEX, "")
    .replace(APC_REGEX, "")
    .replaceAll("\x1b", "");
}

function sanitizeInputText(text: string): string {
  return text ? stripAnsiSequences(text) : text;
}

const SLASH_COMMAND_SELECT_LIST_LAYOUT: SelectListLayoutOptions = {
  minPrimaryColumnWidth: 12,
  maxPrimaryColumnWidth: 40,
  truncatePrimary: ({ text, maxWidth }) => truncateToWidth(text, maxWidth, "…"),
};

/**
 * Represents a chunk of text for word-wrap layout.
 * Tracks both the text content and its position in the original line.
 */
interface TextChunk {
  text: string;
  startIndex: number;
  endIndex: number;
}

/**
 * Split a line into word-wrapped chunks.
 * Wraps at word boundaries when possible, falling back to character-level
 * wrapping for words longer than the available width.
 *
 * @param line - The text line to wrap
 * @param maxWidth - Maximum visible width per chunk
 * @returns Array of chunks with text and position information
 */
function wordWrapLine(
  line: string,
  maxWidth: number,
  preSegmented?: Intl.SegmentData[],
): TextChunk[] {
  if (!line || maxWidth <= 0) {
    return [{ text: "", startIndex: 0, endIndex: 0 }];
  }

  const lineWidth = visibleWidth(line);
  if (lineWidth <= maxWidth) {
    return [{ text: line, startIndex: 0, endIndex: line.length }];
  }

  const chunks: TextChunk[] = [];
  const segments = preSegmented ?? [...segmenter.segment(line)];

  let currentWidth = 0;
  let chunkStart = 0;
  let wrapOppIndex = -1;
  let wrapOppWidth = 0;

  for (let i = 0; i < segments.length; i++) {
    const seg = segments[i];
    if (!seg) continue;

    const grapheme = seg.segment;
    const graphemeWidth = visibleWidth(grapheme);
    const charIndex = seg.index;
    const isWhitespace = !isPasteMarker(grapheme) && isWhitespaceChar(grapheme);

    if (currentWidth + graphemeWidth > maxWidth) {
      if (wrapOppIndex >= 0 && currentWidth - wrapOppWidth + graphemeWidth <= maxWidth) {
        chunks.push({
          text: line.slice(chunkStart, wrapOppIndex),
          startIndex: chunkStart,
          endIndex: wrapOppIndex,
        });
        chunkStart = wrapOppIndex;
        currentWidth -= wrapOppWidth;
      } else if (chunkStart < charIndex) {
        chunks.push({
          text: line.slice(chunkStart, charIndex),
          startIndex: chunkStart,
          endIndex: charIndex,
        });
        chunkStart = charIndex;
        currentWidth = 0;
      }
      wrapOppIndex = -1;
    }

    if (graphemeWidth > maxWidth) {
      const subChunks = wordWrapLine(grapheme, maxWidth);
      for (let j = 0; j < subChunks.length - 1; j++) {
        const subChunk = subChunks[j];
        if (!subChunk) continue;
        chunks.push({
          text: subChunk.text,
          startIndex: charIndex + subChunk.startIndex,
          endIndex: charIndex + subChunk.endIndex,
        });
      }
      const lastSubChunk = subChunks[subChunks.length - 1];
      if (lastSubChunk) {
        chunkStart = charIndex + lastSubChunk.startIndex;
        currentWidth = visibleWidth(lastSubChunk.text);
      }
      wrapOppIndex = -1;
      continue;
    }

    currentWidth += graphemeWidth;

    const next = segments[i + 1];
    if (isWhitespace && next && (isPasteMarker(next.segment) || !isWhitespaceChar(next.segment))) {
      wrapOppIndex = next.index;
      wrapOppWidth = currentWidth;
    }
  }

  chunks.push({ text: line.slice(chunkStart), startIndex: chunkStart, endIndex: line.length });
  return chunks;
}

interface EditorState {
  lines: string[];
  cursorLine: number;
  cursorCol: number;
}

interface LayoutLine {
  text: string;
  hasCursor: boolean;
  cursorPos?: number;
}

export interface EditorTheme {
  borderColor: (str: string) => string;
  selectList: SelectListTheme;
}

export class Editor implements Component {
  protected state: EditorState = {
    lines: [""],
    cursorLine: 0,
    cursorCol: 0,
  };

  private theme: EditorTheme;

  // Store last render width for cursor navigation
  protected lastWidth: number = 80;

  // Border color (can be changed dynamically)
  public borderColor: (str: string) => string;

  // Autocomplete support
  private autocompleteProvider?: AutocompleteProvider;
  protected autocompleteList?: SelectList;
  private autocompleteState: "regular" | "force" | null = null;
  private autocompletePrefix: string = "";

  // Paste tracking for large pastes
  protected pastes: Map<number, string> = new Map();
  private pasteCounter: number = 0;

  // Bracketed paste mode buffering
  private pasteBuffer: string = "";
  protected isInPaste: boolean = false;

  // Prompt history for up/down navigation
  private history: string[] = [];
  protected historyIndex: number = -1; // -1 = not browsing, 0 = most recent, 1 = older, etc.

  public onSubmit?: (text: string) => void;
  public onChange?: (text: string) => void;
  public disableSubmit: boolean = false;

  constructor(theme: EditorTheme) {
    this.theme = theme;
    this.borderColor = theme.borderColor;
  }

  private validPasteIds(): Set<number> {
    return new Set(this.pastes.keys());
  }

  protected segment(text: string): Iterable<Intl.SegmentData> {
    return segmentWithMarkers(text, this.validPasteIds());
  }

  private normalizeText(text: string): string {
    return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").replace(/\t/g, "    ");
  }

  /** Wraps text in cursor styling (inverse video). Override in subclasses for theme-aware cursor. */
  protected cursorStyle(text: string): string {
    return `\x1b[7m${text}\x1b[0m`;
  }

  setAutocompleteProvider(provider: AutocompleteProvider): void {
    this.autocompleteProvider = provider;
  }

  setTheme(theme: EditorTheme): void {
    this.theme = theme;
    this.borderColor = theme.borderColor;
    this.cancelAutocomplete();
  }

  /**
   * Add a prompt to history for up/down arrow navigation.
   * Called after successful submission.
   */
  addToHistory(text: string): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    // Don't add consecutive duplicates
    if (this.history.length > 0 && this.history[0] === trimmed) return;
    this.history.unshift(trimmed);
    // Limit history size
    if (this.history.length > 100) {
      this.history.pop();
    }
  }

  private isEditorEmpty(): boolean {
    return this.state.lines.length === 1 && this.state.lines[0] === "";
  }

  private isOnFirstVisualLine(): boolean {
    const visualLines = this.buildVisualLineMap(this.lastWidth);
    const currentVisualLine = this.findCurrentVisualLine(visualLines);
    return currentVisualLine === 0;
  }

  private isOnLastVisualLine(): boolean {
    const visualLines = this.buildVisualLineMap(this.lastWidth);
    const currentVisualLine = this.findCurrentVisualLine(visualLines);
    return currentVisualLine === visualLines.length - 1;
  }

  protected navigateHistory(direction: 1 | -1): void {
    if (this.history.length === 0) return;

    const newIndex = this.historyIndex - direction; // Up(-1) increases index, Down(1) decreases
    if (newIndex < -1 || newIndex >= this.history.length) return;

    this.historyIndex = newIndex;

    if (this.historyIndex === -1) {
      // Returned to "current" state - clear editor
      this.setTextInternal("");
    } else {
      this.setTextInternal(this.history[this.historyIndex] || "");
    }
  }

  /** Internal setText that doesn't reset history state - used by navigateHistory */
  private setTextInternal(text: string): void {
    const lines = text.replace(/\r\n/g, "\n").replace(/\r/g, "\n").split("\n");
    this.state.lines = lines.length === 0 ? [""] : lines;
    this.state.cursorLine = this.state.lines.length - 1;
    this.state.cursorCol = this.state.lines[this.state.cursorLine]?.length || 0;

    if (this.onChange) {
      this.onChange(this.getText());
    }
  }

  invalidate(): void {
    // No cached state to invalidate currently
  }

  render(width: number): string[] {
    // Store width for cursor navigation
    this.lastWidth = width;

    const horizontal = this.borderColor("─");

    // Layout the text - use full width
    const layoutLines = this.layoutText(width);

    const result: string[] = [];

    // Render top border
    result.push(horizontal.repeat(width));

    // Render each layout line
    for (const layoutLine of layoutLines) {
      let displayText = layoutLine.text;
      let lineVisibleWidth = visibleWidth(layoutLine.text);

      // Add cursor if this line has it
      if (layoutLine.hasCursor && layoutLine.cursorPos !== undefined) {
        const before = displayText.slice(0, layoutLine.cursorPos);
        const after = displayText.slice(layoutLine.cursorPos);

        if (after.length > 0) {
          // Cursor is on a character (grapheme) - replace it with highlighted version
          // Get the first segment from 'after'
          const afterSegments = [...this.segment(after)];
          const firstSegment = afterSegments[0]?.segment || "";
          const restAfter = after.slice(firstSegment.length);
          displayText = before + this.cursorStyle(firstSegment) + restAfter;
          // lineVisibleWidth stays the same - we're replacing, not adding
        } else {
          // Cursor is at the end - check if we have room for the space
          if (lineVisibleWidth < width) {
            // We have room - add highlighted space
            displayText = before + this.cursorStyle(" ");
            // lineVisibleWidth increases by 1 - we're adding a space
            lineVisibleWidth = lineVisibleWidth + 1;
          } else {
            // Line is at full width - use reverse video on last segment if possible
            // or just show cursor at the end without adding space
            const beforeSegments = [...this.segment(before)];
            if (beforeSegments.length > 0) {
              const lastSegment = beforeSegments[beforeSegments.length - 1]?.segment || "";
              // Rebuild 'before' without the last segment
              const beforeWithoutLast = beforeSegments
                .slice(0, -1)
                .map((g) => g.segment)
                .join("");
              displayText = beforeWithoutLast + this.cursorStyle(lastSegment);
            }
            // lineVisibleWidth stays the same
          }
        }
      }

      // Calculate padding based on actual visible width
      const padding = " ".repeat(Math.max(0, width - lineVisibleWidth));

      // Render the line (no side borders, just horizontal lines above and below)
      result.push(displayText + padding);
    }

    // Render bottom border
    result.push(horizontal.repeat(width));

    // Add autocomplete list if active
    if (this.autocompleteState && this.autocompleteList) {
      const autocompleteResult = this.autocompleteList.render(width);
      result.push(...autocompleteResult);
    }

    return result;
  }

  handleInput(data: string): void {
    const kb = getEditorKeybindings();

    // Handle bracketed paste mode
    if (data.includes("\x1b[200~")) {
      this.isInPaste = true;
      this.pasteBuffer = "";
      data = data.replace("\x1b[200~", "");
    }

    if (this.isInPaste) {
      this.pasteBuffer += data;
      const endIndex = this.pasteBuffer.indexOf("\x1b[201~");
      if (endIndex !== -1) {
        const pasteContent = this.pasteBuffer.substring(0, endIndex);
        if (pasteContent.length > 0) {
          this.handlePaste(pasteContent);
        }
        this.isInPaste = false;
        const remaining = this.pasteBuffer.substring(endIndex + 6);
        this.pasteBuffer = "";
        if (remaining.length > 0) {
          this.handleInput(remaining);
        }
        return;
      }
      return;
    }

    if (data === "\\") {
      this.insertCharacter("\\");
      return;
    }

    // Ctrl+C - let parent handle (exit/clear)
    if (kb.matches(data, "copy")) {
      return;
    }

    // Handle autocomplete mode
    if (this.autocompleteState && this.autocompleteList) {
      if (kb.matches(data, "selectCancel")) {
        this.cancelAutocomplete();
        return;
      }

      if (kb.matches(data, "selectUp") || kb.matches(data, "selectDown")) {
        this.autocompleteList.handleInput(data);
        return;
      }

      if (kb.matches(data, "tab")) {
        const selected = this.autocompleteList.getSelectedItem();
        if (selected && this.autocompleteProvider) {
          const result = this.autocompleteProvider.applyCompletion(
            this.state.lines,
            this.state.cursorLine,
            this.state.cursorCol,
            selected,
            this.autocompletePrefix,
          );
          this.state.lines = result.lines;
          this.state.cursorLine = result.cursorLine;
          this.state.cursorCol = result.cursorCol;
          const shouldRetrigger =
            this.autocompletePrefix.startsWith("@") &&
            this.shouldRetriggerMentionAutocomplete(
              result.lines,
              result.cursorLine,
              result.cursorCol,
            );
          this.cancelAutocomplete();
          if (this.onChange) this.onChange(this.getText());
          if (shouldRetrigger) {
            this.tryTriggerAutocomplete();
          }
        }
        return;
      }

      if (kb.matches(data, "selectConfirm")) {
        const selected = this.autocompleteList.getSelectedItem();
        if (selected && this.autocompleteProvider) {
          const result = this.autocompleteProvider.applyCompletion(
            this.state.lines,
            this.state.cursorLine,
            this.state.cursorCol,
            selected,
            this.autocompletePrefix,
          );
          this.state.lines = result.lines;
          this.state.cursorLine = result.cursorLine;
          this.state.cursorCol = result.cursorCol;

          if (this.autocompletePrefix.startsWith("/")) {
            this.cancelAutocomplete();
            // Fall through to submit
          } else {
            const shouldRetrigger =
              this.autocompletePrefix.startsWith("@") &&
              this.shouldRetriggerMentionAutocomplete(
                result.lines,
                result.cursorLine,
                result.cursorCol,
              );
            this.cancelAutocomplete();
            if (this.onChange) this.onChange(this.getText());
            if (shouldRetrigger) {
              this.tryTriggerAutocomplete();
            }
            return;
          }
        }
      }
    }

    // Tab - trigger completion
    if (kb.matches(data, "tab") && !this.autocompleteState) {
      this.handleTabCompletion();
      return;
    }

    // Deletion actions
    if (kb.matches(data, "deleteToLineEnd")) {
      this.deleteToEndOfLine();
      return;
    }
    if (kb.matches(data, "deleteToLineStart")) {
      this.deleteToStartOfLine();
      return;
    }
    if (kb.matches(data, "deleteWordBackward")) {
      this.deleteWordBackwards();
      return;
    }
    if (kb.matches(data, "deleteCharBackward") || matchesKey(data, "shift+backspace")) {
      this.handleBackspace();
      return;
    }
    if (kb.matches(data, "deleteCharForward") || matchesKey(data, "shift+delete")) {
      this.handleForwardDelete();
      return;
    }

    // Cursor movement actions
    if (kb.matches(data, "cursorLineStart")) {
      this.moveToLineStart();
      return;
    }
    if (kb.matches(data, "cursorLineEnd")) {
      this.moveToLineEnd();
      return;
    }
    if (kb.matches(data, "cursorWordLeft")) {
      this.moveWordBackwards();
      return;
    }
    if (kb.matches(data, "cursorWordRight")) {
      this.moveWordForwards();
      return;
    }

    // New line (Shift+Enter, Alt+Enter, etc.)
    if (
      kb.matches(data, "newLine") ||
      (data.charCodeAt(0) === 10 && data.length > 1) ||
      data === "\x1b\r" ||
      data === "\x1b[13;2~" ||
      (data.length > 1 && data.includes("\x1b") && data.includes("\r")) ||
      (data === "\n" && data.length === 1) ||
      data === "\\\r"
    ) {
      this.addNewLine();
      return;
    }

    // Submit (Enter)
    if (kb.matches(data, "submit")) {
      if (this.disableSubmit) return;

      let result = this.state.lines.join("\n").trim();
      result = this.expandPasteMarkers(result);

      this.state = { lines: [""], cursorLine: 0, cursorCol: 0 };
      this.pastes.clear();
      this.pasteCounter = 0;
      this.historyIndex = -1;

      if (this.onChange) this.onChange("");
      if (this.onSubmit) this.onSubmit(result);
      return;
    }

    // Arrow key navigation (with history support)
    if (kb.matches(data, "cursorUp")) {
      if (this.isEditorEmpty()) {
        this.navigateHistory(-1);
      } else if (this.historyIndex > -1 && this.isOnFirstVisualLine()) {
        this.navigateHistory(-1);
      } else {
        this.moveCursor(-1, 0);
      }
      return;
    }
    if (kb.matches(data, "cursorDown")) {
      if (this.historyIndex > -1 && this.isOnLastVisualLine()) {
        this.navigateHistory(1);
      } else {
        this.moveCursor(1, 0);
      }
      return;
    }
    if (kb.matches(data, "cursorRight")) {
      this.moveCursor(0, 1);
      return;
    }
    if (kb.matches(data, "cursorLeft")) {
      this.moveCursor(0, -1);
      return;
    }

    // Shift+Space - insert regular space
    if (matchesKey(data, "shift+space")) {
      this.insertCharacter(" ");
      return;
    }

    const kittyPrintable = decodeKittyPrintable(data);
    if (kittyPrintable !== undefined) {
      this.insertCharacter(kittyPrintable);
      return;
    }

    // Regular characters
    if (data.charCodeAt(0) >= 32) {
      this.insertCharacter(data);
    }
  }

  private layoutText(contentWidth: number): LayoutLine[] {
    const layoutLines: LayoutLine[] = [];

    if (
      this.state.lines.length === 0 ||
      (this.state.lines.length === 1 && this.state.lines[0] === "")
    ) {
      // Empty editor
      layoutLines.push({
        text: "",
        hasCursor: true,
        cursorPos: 0,
      });
      return layoutLines;
    }

    // Process each logical line
    for (let i = 0; i < this.state.lines.length; i++) {
      const line = this.state.lines[i] || "";
      const isCurrentLine = i === this.state.cursorLine;
      const lineVisibleWidth = visibleWidth(line);

      if (lineVisibleWidth <= contentWidth) {
        // Line fits in one layout line
        if (isCurrentLine) {
          layoutLines.push({
            text: line,
            hasCursor: true,
            cursorPos: this.state.cursorCol,
          });
        } else {
          layoutLines.push({
            text: line,
            hasCursor: false,
          });
        }
      } else {
        // Line needs wrapping - use word-aware wrapping
        const chunks = wordWrapLine(line, contentWidth, [...this.segment(line)]);

        for (let chunkIndex = 0; chunkIndex < chunks.length; chunkIndex++) {
          const chunk = chunks[chunkIndex];
          if (!chunk) continue;

          const cursorPos = this.state.cursorCol;
          const isLastChunk = chunkIndex === chunks.length - 1;

          // Determine if cursor is in this chunk
          // For word-wrapped chunks, we need to handle the case where
          // cursor might be in trimmed whitespace at end of chunk
          let hasCursorInChunk = false;
          let adjustedCursorPos = 0;

          if (isCurrentLine) {
            if (isLastChunk) {
              // Last chunk: cursor belongs here if >= startIndex
              hasCursorInChunk = cursorPos >= chunk.startIndex;
              adjustedCursorPos = cursorPos - chunk.startIndex;
            } else {
              // Non-last chunk: cursor belongs here if in range [startIndex, endIndex)
              // But we need to handle the visual position in the trimmed text
              hasCursorInChunk = cursorPos >= chunk.startIndex && cursorPos < chunk.endIndex;
              if (hasCursorInChunk) {
                adjustedCursorPos = cursorPos - chunk.startIndex;
                // Clamp to text length (in case cursor was in trimmed whitespace)
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
            layoutLines.push({
              text: chunk.text,
              hasCursor: false,
            });
          }
        }
      }
    }

    return layoutLines;
  }

  getText(): string {
    return this.state.lines.join("\n");
  }

  /**
   * Get text with paste markers expanded to their actual content.
   * Use this when you need the full content (e.g., for external editor).
   */
  getExpandedText(): string {
    return this.expandPasteMarkers(this.state.lines.join("\n"));
  }

  private expandPasteMarkers(text: string): string {
    let result = text;
    for (const [pasteId, pasteContent] of this.pastes) {
      const markerRegex = new RegExp(
        `\\[paste #${pasteId}(?: (?:\\+\\d+ lines|\\d+ chars))?\\]`,
        "g",
      );
      result = result.replace(markerRegex, () => pasteContent);
    }
    return result;
  }

  getLines(): string[] {
    return [...this.state.lines];
  }

  getCursor(): { line: number; col: number } {
    return { line: this.state.cursorLine, col: this.state.cursorCol };
  }

  setText(text: string): void {
    this.historyIndex = -1; // Exit history browsing mode
    this.setTextInternal(text);
  }

  /**
   * Insert text at the current cursor position.
   * Used for programmatic insertion (e.g., clipboard image markers).
   */
  insertTextAtCursor(text: string): void {
    this.insertTextAtCursorInternal(text);
  }

  private insertTextAtCursorInternal(text: string): void {
    if (!text) return;

    const sanitized = sanitizeInputText(text);
    if (!sanitized) return;

    this.historyIndex = -1;

    const normalized = this.normalizeText(sanitized);
    const insertedLines = normalized.split("\n");
    const currentLine = this.state.lines[this.state.cursorLine] || "";
    const beforeCursor = currentLine.slice(0, this.state.cursorCol);
    const afterCursor = currentLine.slice(this.state.cursorCol);

    if (insertedLines.length === 1) {
      this.state.lines[this.state.cursorLine] = beforeCursor + normalized + afterCursor;
      this.state.cursorCol += normalized.length;
    } else {
      this.state.lines = [
        ...this.state.lines.slice(0, this.state.cursorLine),
        beforeCursor + (insertedLines[0] || ""),
        ...insertedLines.slice(1, -1),
        (insertedLines[insertedLines.length - 1] || "") + afterCursor,
        ...this.state.lines.slice(this.state.cursorLine + 1),
      ];
      this.state.cursorLine += insertedLines.length - 1;
      this.state.cursorCol = (insertedLines[insertedLines.length - 1] || "").length;
    }

    if (this.onChange) {
      this.onChange(this.getText());
    }

    if (this.autocompleteState) {
      this.updateAutocomplete();
    }
  }

  // All the editor methods from before...
  protected insertCharacter(char: string): void {
    const sanitized = sanitizeInputText(char);
    if (!sanitized) return;

    this.historyIndex = -1; // Exit history browsing mode

    const line = this.state.lines[this.state.cursorLine] || "";

    const before = line.slice(0, this.state.cursorCol);
    const after = line.slice(this.state.cursorCol);

    this.state.lines[this.state.cursorLine] = before + sanitized + after;
    this.state.cursorCol += sanitized.length; // Fix: increment by the length of the inserted string

    if (this.onChange) {
      this.onChange(this.getText());
    }

    // Check if we should trigger or update autocomplete
    if (!this.autocompleteState) {
      // Auto-trigger for "/" at the start of a line (slash commands)
      if (sanitized === "/" && this.isAtStartOfMessage()) {
        this.tryTriggerAutocomplete();
      }
      // Auto-trigger for "@" mention tags
      else if (sanitized === "@") {
        const currentLine = this.state.lines[this.state.cursorLine] || "";
        const textBeforeCursor = currentLine.slice(0, this.state.cursorCol);
        // Only trigger if @ is after whitespace or at start of line
        const charBeforeAt = textBeforeCursor[textBeforeCursor.length - 2];
        if (textBeforeCursor.length === 1 || charBeforeAt === " " || charBeforeAt === "\t") {
          this.tryTriggerAutocomplete();
        }
      }
      // Also auto-trigger when typing letters in a slash command context
      else if (/[a-zA-Z0-9.\-_]/.test(sanitized)) {
        const currentLine = this.state.lines[this.state.cursorLine] || "";
        const textBeforeCursor = currentLine.slice(0, this.state.cursorCol);
        if (this.isInSlashCommandContext(textBeforeCursor)) {
          this.tryTriggerAutocomplete();
        } else if (this.isMentionAutocompleteContext(textBeforeCursor)) {
          this.tryTriggerAutocomplete();
        }
      }
    } else {
      this.updateAutocomplete();
    }
  }

  private handlePaste(pastedText: string): void {
    this.historyIndex = -1; // Exit history browsing mode

    // Clean the pasted text
    const sanitizedText = sanitizeInputText(pastedText);
    const cleanText = this.normalizeText(sanitizedText);

    // Filter out non-printable characters except newlines
    let filteredText = cleanText
      .split("")
      .filter((char) => char === "\n" || char.charCodeAt(0) >= 32)
      .join("");

    // If pasting a file path (starts with /, ~, or .) and the character before
    // the cursor is a word character, prepend a space for better readability
    if (/^[/~.]/.test(filteredText)) {
      const currentLine = this.state.lines[this.state.cursorLine] || "";
      const charBeforeCursor =
        this.state.cursorCol > 0 ? currentLine[this.state.cursorCol - 1] : "";
      if (charBeforeCursor && /\w/.test(charBeforeCursor)) {
        filteredText = ` ${filteredText}`;
      }
    }

    // Split into lines
    const pastedLines = filteredText.split("\n");

    // Check if this is a large paste (> 32 lines or > 2000 characters)
    const totalChars = filteredText.length;
    if (pastedLines.length > 32 || totalChars > 2000) {
      // Store the paste and insert a marker
      this.pasteCounter++;
      const pasteId = this.pasteCounter;
      this.pastes.set(pasteId, filteredText);

      // Insert marker like "[paste #1 +123 lines]" or "[paste #1 1234 chars]"
      const marker =
        pastedLines.length > 32
          ? `[paste #${pasteId} +${pastedLines.length} lines]`
          : `[paste #${pasteId} ${totalChars} chars]`;
      this.insertTextAtCursorInternal(marker);
      return;
    }

    this.insertTextAtCursorInternal(filteredText);
  }

  private addNewLine(): void {
    this.historyIndex = -1; // Exit history browsing mode

    const currentLine = this.state.lines[this.state.cursorLine] || "";

    const before = currentLine.slice(0, this.state.cursorCol);
    const after = currentLine.slice(this.state.cursorCol);

    // Split current line
    this.state.lines[this.state.cursorLine] = before;
    this.state.lines.splice(this.state.cursorLine + 1, 0, after);

    // Move cursor to start of new line
    this.state.cursorLine++;
    this.state.cursorCol = 0;

    if (this.onChange) {
      this.onChange(this.getText());
    }
  }

  private handleBackspace(): void {
    this.historyIndex = -1; // Exit history browsing mode

    if (this.state.cursorCol > 0) {
      // Delete grapheme before cursor (handles emojis, combining characters, etc.)
      const line = this.state.lines[this.state.cursorLine] || "";
      const beforeCursor = line.slice(0, this.state.cursorCol);

      // Find the last grapheme in the text before cursor
      const graphemes = [...this.segment(beforeCursor)];
      const lastGrapheme = graphemes[graphemes.length - 1];
      const graphemeLength = lastGrapheme ? lastGrapheme.segment.length : 1;

      const before = line.slice(0, this.state.cursorCol - graphemeLength);
      const after = line.slice(this.state.cursorCol);

      this.state.lines[this.state.cursorLine] = before + after;
      this.state.cursorCol -= graphemeLength;
    } else if (this.state.cursorLine > 0) {
      // Merge with previous line
      const currentLine = this.state.lines[this.state.cursorLine] || "";
      const previousLine = this.state.lines[this.state.cursorLine - 1] || "";

      this.state.lines[this.state.cursorLine - 1] = previousLine + currentLine;
      this.state.lines.splice(this.state.cursorLine, 1);

      this.state.cursorLine--;
      this.state.cursorCol = previousLine.length;
    }

    if (this.onChange) {
      this.onChange(this.getText());
    }

    // Update or re-trigger autocomplete after backspace
    if (this.autocompleteState) {
      this.updateAutocomplete();
    } else {
      // If autocomplete was cancelled (no matches), re-trigger if we're in a completable context
      const currentLine = this.state.lines[this.state.cursorLine] || "";
      const textBeforeCursor = currentLine.slice(0, this.state.cursorCol);
      if (this.isInSlashCommandContext(textBeforeCursor)) {
        this.tryTriggerAutocomplete();
      } else if (this.isMentionAutocompleteContext(textBeforeCursor)) {
        this.tryTriggerAutocomplete();
      }
    }
  }

  private moveToLineStart(): void {
    this.state.cursorCol = 0;
  }

  private moveToLineEnd(): void {
    const currentLine = this.state.lines[this.state.cursorLine] || "";
    this.state.cursorCol = currentLine.length;
  }

  private deleteToStartOfLine(): void {
    this.historyIndex = -1; // Exit history browsing mode

    const currentLine = this.state.lines[this.state.cursorLine] || "";

    if (this.state.cursorCol > 0) {
      // Delete from start of line up to cursor
      this.state.lines[this.state.cursorLine] = currentLine.slice(this.state.cursorCol);
      this.state.cursorCol = 0;
    } else if (this.state.cursorLine > 0) {
      // At start of line - merge with previous line
      const previousLine = this.state.lines[this.state.cursorLine - 1] || "";
      this.state.lines[this.state.cursorLine - 1] = previousLine + currentLine;
      this.state.lines.splice(this.state.cursorLine, 1);
      this.state.cursorLine--;
      this.state.cursorCol = previousLine.length;
    }

    if (this.onChange) {
      this.onChange(this.getText());
    }
  }

  private deleteToEndOfLine(): void {
    this.historyIndex = -1; // Exit history browsing mode

    const currentLine = this.state.lines[this.state.cursorLine] || "";

    if (this.state.cursorCol < currentLine.length) {
      // Delete from cursor to end of line
      this.state.lines[this.state.cursorLine] = currentLine.slice(0, this.state.cursorCol);
    } else if (this.state.cursorLine < this.state.lines.length - 1) {
      // At end of line - merge with next line
      const nextLine = this.state.lines[this.state.cursorLine + 1] || "";
      this.state.lines[this.state.cursorLine] = currentLine + nextLine;
      this.state.lines.splice(this.state.cursorLine + 1, 1);
    }

    if (this.onChange) {
      this.onChange(this.getText());
    }
  }

  private deleteWordBackwards(): void {
    this.historyIndex = -1; // Exit history browsing mode

    const currentLine = this.state.lines[this.state.cursorLine] || "";

    // If at start of line, behave like backspace at column 0 (merge with previous line)
    if (this.state.cursorCol === 0) {
      if (this.state.cursorLine > 0) {
        const previousLine = this.state.lines[this.state.cursorLine - 1] || "";
        this.state.lines[this.state.cursorLine - 1] = previousLine + currentLine;
        this.state.lines.splice(this.state.cursorLine, 1);
        this.state.cursorLine--;
        this.state.cursorCol = previousLine.length;
      }
    } else {
      const oldCursorCol = this.state.cursorCol;
      this.moveWordBackwards();
      const deleteFrom = this.state.cursorCol;
      this.state.cursorCol = oldCursorCol;

      this.state.lines[this.state.cursorLine] =
        currentLine.slice(0, deleteFrom) + currentLine.slice(this.state.cursorCol);
      this.state.cursorCol = deleteFrom;
    }

    if (this.onChange) {
      this.onChange(this.getText());
    }
  }

  private handleForwardDelete(): void {
    this.historyIndex = -1; // Exit history browsing mode

    const currentLine = this.state.lines[this.state.cursorLine] || "";

    if (this.state.cursorCol < currentLine.length) {
      // Delete grapheme at cursor position (handles emojis, combining characters, etc.)
      const afterCursor = currentLine.slice(this.state.cursorCol);

      // Find the first grapheme at cursor
      const graphemes = [...this.segment(afterCursor)];
      const firstGrapheme = graphemes[0];
      const graphemeLength = firstGrapheme ? firstGrapheme.segment.length : 1;

      const before = currentLine.slice(0, this.state.cursorCol);
      const after = currentLine.slice(this.state.cursorCol + graphemeLength);
      this.state.lines[this.state.cursorLine] = before + after;
    } else if (this.state.cursorLine < this.state.lines.length - 1) {
      // At end of line - merge with next line
      const nextLine = this.state.lines[this.state.cursorLine + 1] || "";
      this.state.lines[this.state.cursorLine] = currentLine + nextLine;
      this.state.lines.splice(this.state.cursorLine + 1, 1);
    }

    if (this.onChange) {
      this.onChange(this.getText());
    }

    // Update or re-trigger autocomplete after forward delete
    if (this.autocompleteState) {
      this.updateAutocomplete();
    } else {
      const currentLine = this.state.lines[this.state.cursorLine] || "";
      const textBeforeCursor = currentLine.slice(0, this.state.cursorCol);
      if (this.isInSlashCommandContext(textBeforeCursor)) {
        this.tryTriggerAutocomplete();
      } else if (this.isMentionAutocompleteContext(textBeforeCursor)) {
        this.tryTriggerAutocomplete();
      }
    }
  }

  /**
   * Build a mapping from visual lines to logical positions.
   * Returns an array where each element represents a visual line with:
   * - logicalLine: index into this.state.lines
   * - startCol: starting column in the logical line
   * - length: length of this visual line segment
   */
  private buildVisualLineMap(
    width: number,
  ): Array<{ logicalLine: number; startCol: number; length: number }> {
    const visualLines: Array<{ logicalLine: number; startCol: number; length: number }> = [];

    for (let i = 0; i < this.state.lines.length; i++) {
      const line = this.state.lines[i] || "";
      const lineVisWidth = visibleWidth(line);
      if (line.length === 0) {
        // Empty line still takes one visual line
        visualLines.push({ logicalLine: i, startCol: 0, length: 0 });
      } else if (lineVisWidth <= width) {
        visualLines.push({ logicalLine: i, startCol: 0, length: line.length });
      } else {
        // Line needs wrapping - use word-aware wrapping
        const chunks = wordWrapLine(line, width, [...this.segment(line)]);
        for (const chunk of chunks) {
          visualLines.push({
            logicalLine: i,
            startCol: chunk.startIndex,
            length: chunk.endIndex - chunk.startIndex,
          });
        }
      }
    }

    return visualLines;
  }

  /**
   * Find the visual line index for the current cursor position.
   */
  private findCurrentVisualLine(
    visualLines: Array<{ logicalLine: number; startCol: number; length: number }>,
  ): number {
    for (let i = 0; i < visualLines.length; i++) {
      const vl = visualLines[i];
      if (!vl) continue;
      if (vl.logicalLine === this.state.cursorLine) {
        const colInSegment = this.state.cursorCol - vl.startCol;
        // Cursor is in this segment if it's within range
        // For the last segment of a logical line, cursor can be at length (end position)
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
    // Fallback: return last visual line
    return visualLines.length - 1;
  }

  protected snapCursorToSegmentBoundary(logicalLine: string, movingUp: boolean): void {
    for (const seg of this.segment(logicalLine)) {
      if (seg.index > this.state.cursorCol) break;
      if (seg.segment.length <= 1) continue;
      if (this.state.cursorCol < seg.index + seg.segment.length) {
        this.state.cursorCol = movingUp ? seg.index : seg.index + seg.segment.length;
        break;
      }
    }
  }

  private moveCursor(deltaLine: number, deltaCol: number): void {
    const width = this.lastWidth;

    if (deltaLine !== 0) {
      // Build visual line map for navigation
      const visualLines = this.buildVisualLineMap(width);
      const currentVisualLine = this.findCurrentVisualLine(visualLines);

      // Calculate column position within current visual line
      const currentVL = visualLines[currentVisualLine];
      const visualCol = currentVL ? this.state.cursorCol - currentVL.startCol : 0;

      // Move to target visual line
      const targetVisualLine = currentVisualLine + deltaLine;

      if (targetVisualLine >= 0 && targetVisualLine < visualLines.length) {
        const targetVL = visualLines[targetVisualLine];
        if (targetVL) {
          this.state.cursorLine = targetVL.logicalLine;
          // Try to maintain visual column position, clamped to line length
          const targetCol = targetVL.startCol + Math.min(visualCol, targetVL.length);
          const logicalLine = this.state.lines[targetVL.logicalLine] || "";
          this.state.cursorCol = Math.min(targetCol, logicalLine.length);
          this.snapCursorToSegmentBoundary(logicalLine, deltaLine < 0);
        }
      }
    }

    if (deltaCol !== 0) {
      const currentLine = this.state.lines[this.state.cursorLine] || "";

      if (deltaCol > 0) {
        // Moving right - move by one grapheme (handles emojis, combining characters, etc.)
        if (this.state.cursorCol < currentLine.length) {
          const afterCursor = currentLine.slice(this.state.cursorCol);
          const graphemes = [...this.segment(afterCursor)];
          const firstGrapheme = graphemes[0];
          this.state.cursorCol += firstGrapheme ? firstGrapheme.segment.length : 1;
        } else if (this.state.cursorLine < this.state.lines.length - 1) {
          // Wrap to start of next logical line
          this.state.cursorLine++;
          this.state.cursorCol = 0;
        }
      } else {
        // Moving left - move by one grapheme (handles emojis, combining characters, etc.)
        if (this.state.cursorCol > 0) {
          const beforeCursor = currentLine.slice(0, this.state.cursorCol);
          const graphemes = [...this.segment(beforeCursor)];
          const lastGrapheme = graphemes[graphemes.length - 1];
          this.state.cursorCol -= lastGrapheme ? lastGrapheme.segment.length : 1;
        } else if (this.state.cursorLine > 0) {
          // Wrap to end of previous logical line
          this.state.cursorLine--;
          const prevLine = this.state.lines[this.state.cursorLine] || "";
          this.state.cursorCol = prevLine.length;
        }
      }
    }
  }

  private moveWordBackwards(): void {
    const currentLine = this.state.lines[this.state.cursorLine] || "";

    // If at start of line, move to end of previous line
    if (this.state.cursorCol === 0) {
      if (this.state.cursorLine > 0) {
        this.state.cursorLine--;
        const prevLine = this.state.lines[this.state.cursorLine] || "";
        this.state.cursorCol = prevLine.length;
      }
      return;
    }

    const textBeforeCursor = currentLine.slice(0, this.state.cursorCol);
    const graphemes = [...this.segment(textBeforeCursor)];
    let newCol = this.state.cursorCol;

    // Skip trailing whitespace
    while (
      graphemes.length > 0 &&
      !isPasteMarker(graphemes[graphemes.length - 1]?.segment || "") &&
      isWhitespaceChar(graphemes[graphemes.length - 1]?.segment || "")
    ) {
      newCol -= graphemes.pop()?.segment.length || 0;
    }

    if (graphemes.length > 0) {
      const lastGrapheme = graphemes[graphemes.length - 1]?.segment || "";
      if (isPasteMarker(lastGrapheme)) {
        newCol -= graphemes.pop()?.segment.length || 0;
      } else if (isPunctuationChar(lastGrapheme)) {
        // Skip punctuation run
        while (
          graphemes.length > 0 &&
          isPunctuationChar(graphemes[graphemes.length - 1]?.segment || "") &&
          !isPasteMarker(graphemes[graphemes.length - 1]?.segment || "")
        ) {
          newCol -= graphemes.pop()?.segment.length || 0;
        }
      } else {
        // Skip word run
        while (
          graphemes.length > 0 &&
          !isWhitespaceChar(graphemes[graphemes.length - 1]?.segment || "") &&
          !isPunctuationChar(graphemes[graphemes.length - 1]?.segment || "") &&
          !isPasteMarker(graphemes[graphemes.length - 1]?.segment || "")
        ) {
          newCol -= graphemes.pop()?.segment.length || 0;
        }
      }
    }

    this.state.cursorCol = newCol;
  }

  private moveWordForwards(): void {
    const currentLine = this.state.lines[this.state.cursorLine] || "";

    // If at end of line, move to start of next line
    if (this.state.cursorCol >= currentLine.length) {
      if (this.state.cursorLine < this.state.lines.length - 1) {
        this.state.cursorLine++;
        this.state.cursorCol = 0;
      }
      return;
    }

    const textAfterCursor = currentLine.slice(this.state.cursorCol);
    const segments = this.segment(textAfterCursor);
    const iterator = segments[Symbol.iterator]();
    let next = iterator.next();
    let newCol = this.state.cursorCol;

    // Skip leading whitespace
    while (
      !next.done &&
      !isPasteMarker(next.value.segment) &&
      isWhitespaceChar(next.value.segment)
    ) {
      newCol += next.value.segment.length;
      next = iterator.next();
    }

    if (!next.done) {
      const firstGrapheme = next.value.segment;
      if (isPasteMarker(firstGrapheme)) {
        newCol += firstGrapheme.length;
      } else if (isPunctuationChar(firstGrapheme)) {
        // Skip punctuation run
        while (
          !next.done &&
          isPunctuationChar(next.value.segment) &&
          !isPasteMarker(next.value.segment)
        ) {
          newCol += next.value.segment.length;
          next = iterator.next();
        }
      } else {
        // Skip word run
        while (
          !next.done &&
          !isWhitespaceChar(next.value.segment) &&
          !isPunctuationChar(next.value.segment) &&
          !isPasteMarker(next.value.segment)
        ) {
          newCol += next.value.segment.length;
          next = iterator.next();
        }
      }
    }

    this.state.cursorCol = newCol;
  }

  private isSlashMenuAllowed(): boolean {
    return this.state.lines.length === 1 && this.state.cursorLine === 0;
  }

  // Helper method to check if cursor is at start of message (for slash command detection)
  private isAtStartOfMessage(): boolean {
    if (!this.isSlashMenuAllowed()) return false;

    const currentLine = this.state.lines[this.state.cursorLine] || "";
    const beforeCursor = currentLine.slice(0, this.state.cursorCol);
    return beforeCursor.trim() === "" || beforeCursor.trim() === "/";
  }

  private isInSlashCommandContext(textBeforeCursor: string): boolean {
    return this.isSlashMenuAllowed() && textBeforeCursor.trimStart().startsWith("/");
  }

  private isMentionAutocompleteContext(textBeforeCursor: string): boolean {
    return /(?:^|[\s])@[^\s]*$/.test(textBeforeCursor);
  }

  private shouldRetriggerMentionAutocomplete(
    lines: string[],
    cursorLine: number,
    cursorCol: number,
  ): boolean {
    const line = lines[cursorLine] ?? "";
    const beforeCursor = line.slice(0, cursorCol);
    return /(?:^|[\s])@@[a-z-]+:$/.test(beforeCursor);
  }

  private getAutocompleteMatchPrefix(prefix: string): string {
    if (prefix.startsWith("@@")) {
      const mentionMatch = prefix.match(/^@@[^:\s]+:(.*)$/);
      return mentionMatch ? (mentionMatch[1] ?? "") : prefix.slice(2);
    }
    if (prefix.startsWith("@") || prefix.startsWith("/")) {
      return prefix.slice(1);
    }
    return prefix;
  }

  private getBestAutocompleteMatchIndex(
    items: Array<{ value: string; label: string }>,
    prefix: string,
  ): number {
    const matchPrefix = this.getAutocompleteMatchPrefix(prefix);
    if (!matchPrefix) return -1;

    let firstPrefixIndex = -1;
    for (let i = 0; i < items.length; i++) {
      const value = items[i]?.value;
      if (!value) continue;
      if (value === matchPrefix) {
        return i;
      }
      if (firstPrefixIndex === -1 && value.startsWith(matchPrefix)) {
        firstPrefixIndex = i;
      }
    }

    return firstPrefixIndex;
  }

  private createAutocompleteList(
    prefix: string,
    items: Array<{ value: string; label: string; description?: string }>,
  ): SelectList {
    const layout = this.isInSlashCommandContext(prefix)
      ? SLASH_COMMAND_SELECT_LIST_LAYOUT
      : undefined;
    return new SelectList(items, 5, this.theme.selectList, layout);
  }

  // Autocomplete methods
  protected tryTriggerAutocomplete(explicitTab: boolean = false): void {
    if (!this.autocompleteProvider) return;

    if (explicitTab) {
      const provider = this.autocompleteProvider as CombinedAutocompleteProvider;
      const shouldTrigger =
        !provider.shouldTriggerFileCompletion ||
        provider.shouldTriggerFileCompletion(
          this.state.lines,
          this.state.cursorLine,
          this.state.cursorCol,
        );
      if (!shouldTrigger) {
        return;
      }
    }

    const suggestions = this.autocompleteProvider.getSuggestions(
      this.state.lines,
      this.state.cursorLine,
      this.state.cursorCol,
    );

    if (suggestions && suggestions.items.length > 0) {
      this.autocompletePrefix = suggestions.prefix;
      this.autocompleteList = this.createAutocompleteList(suggestions.prefix, suggestions.items);

      const bestMatchIndex = this.getBestAutocompleteMatchIndex(
        suggestions.items,
        suggestions.prefix,
      );
      if (bestMatchIndex >= 0) {
        this.autocompleteList.setSelectedIndex(bestMatchIndex);
      }

      this.autocompleteState = "regular";
    } else {
      this.cancelAutocomplete();
    }
  }

  private handleTabCompletion(): void {
    if (!this.autocompleteProvider) return;

    const currentLine = this.state.lines[this.state.cursorLine] || "";
    const beforeCursor = currentLine.slice(0, this.state.cursorCol);

    if (this.isInSlashCommandContext(beforeCursor) && !beforeCursor.trimStart().includes(" ")) {
      this.handleSlashCommandCompletion();
    } else {
      this.forceFileAutocomplete(true);
    }
  }

  private handleSlashCommandCompletion(): void {
    this.tryTriggerAutocomplete(true);
  }

  /*
https://github.com/EsotericSoftware/spine-runtimes/actions/runs/19536643416/job/559322883
17 this job fails with https://github.com/EsotericSoftware/spine-runtimes/actions/runs/19
536643416/job/55932288317 havea  look at .gi
	 */
  private forceFileAutocomplete(explicitTab: boolean = false): void {
    if (!this.autocompleteProvider) return;

    const provider = this.autocompleteProvider as {
      getForceFileSuggestions?: CombinedAutocompleteProvider["getForceFileSuggestions"];
    };
    if (typeof provider.getForceFileSuggestions !== "function") {
      this.tryTriggerAutocomplete(true);
      return;
    }

    const suggestions = provider.getForceFileSuggestions(
      this.state.lines,
      this.state.cursorLine,
      this.state.cursorCol,
    );

    if (suggestions && suggestions.items.length > 0) {
      if (explicitTab && suggestions.items.length === 1) {
        const item = suggestions.items[0];
        if (!item) {
          this.cancelAutocomplete();
          return;
        }

        const result = this.autocompleteProvider.applyCompletion(
          this.state.lines,
          this.state.cursorLine,
          this.state.cursorCol,
          item,
          suggestions.prefix,
        );
        this.state.lines = result.lines;
        this.state.cursorLine = result.cursorLine;
        this.state.cursorCol = result.cursorCol;
        if (this.onChange) this.onChange(this.getText());
        return;
      }

      this.autocompletePrefix = suggestions.prefix;
      this.autocompleteList = this.createAutocompleteList(suggestions.prefix, suggestions.items);

      const bestMatchIndex = this.getBestAutocompleteMatchIndex(
        suggestions.items,
        suggestions.prefix,
      );
      if (bestMatchIndex >= 0) {
        this.autocompleteList.setSelectedIndex(bestMatchIndex);
      }

      this.autocompleteState = "force";
    } else {
      this.cancelAutocomplete();
    }
  }

  private cancelAutocomplete(): void {
    this.autocompleteState = null;
    this.autocompleteList = undefined;
    this.autocompletePrefix = "";
  }

  public isShowingAutocomplete(): boolean {
    return this.autocompleteState !== null;
  }

  private updateAutocomplete(): void {
    if (!this.autocompleteState || !this.autocompleteProvider) return;

    if (this.autocompleteState === "force") {
      this.forceFileAutocomplete();
      return;
    }

    const suggestions = this.autocompleteProvider.getSuggestions(
      this.state.lines,
      this.state.cursorLine,
      this.state.cursorCol,
    );

    if (suggestions && suggestions.items.length > 0) {
      this.autocompletePrefix = suggestions.prefix;
      this.autocompleteList = this.createAutocompleteList(suggestions.prefix, suggestions.items);

      const bestMatchIndex = this.getBestAutocompleteMatchIndex(
        suggestions.items,
        suggestions.prefix,
      );
      if (bestMatchIndex >= 0) {
        this.autocompleteList.setSelectedIndex(bestMatchIndex);
      }
    } else {
      this.cancelAutocomplete();
    }
  }
}
