import { type Component, visibleWidth } from "@earendil-works/pi-tui";
import {
  iterateGraphemes,
  normalizeInlineTextPreservePadding,
  type OneLineSegment,
} from "./one_line_segments.js";

export interface HeaderLineModel {
  segments: OneLineSegment[];
}

type WrappedLineSegment = { index: number; text: string };

function appendWrappedLineSegment(chunks: WrappedLineSegment[], index: number, text: string): void {
  const last = chunks.at(-1);
  if (last?.index === index) {
    last.text += text;
    return;
  }
  chunks.push({ index, text });
}

export class HeaderLineComponent implements Component {
  constructor(private model: HeaderLineModel) {}

  invalidate() {}

  render(width: number): string[] {
    const minWidth = Math.max(0, width);
    if (minWidth <= 0) return [""];

    const texts = this.model.segments.map((segment) =>
      normalizeInlineTextPreservePadding(segment.text),
    );
    const lines: WrappedLineSegment[][] = [];
    let currentLine: WrappedLineSegment[] = [];
    let currentWidth = 0;

    const flushLine = () => {
      lines.push(currentLine);
      currentLine = [];
      currentWidth = 0;
    };

    for (let index = 0; index < texts.length; index++) {
      const text = texts[index] ?? "";
      for (const grapheme of iterateGraphemes(text)) {
        const graphemeWidth = visibleWidth(grapheme);
        if (currentWidth + graphemeWidth > minWidth && currentLine.length > 0) {
          flushLine();
        }

        appendWrappedLineSegment(currentLine, index, grapheme);
        currentWidth += graphemeWidth;

        if (currentWidth >= minWidth) {
          flushLine();
        }
      }
    }

    if (currentLine.length > 0 || lines.length === 0) {
      flushLine();
    }

    return lines.map((line) => this.renderLine(line, minWidth));
  }

  private renderLine(line: WrappedLineSegment[], width: number): string {
    const rendered = line
      .map((chunk) => {
        const style = this.model.segments[chunk.index]?.style ?? ((s: string) => s);
        return style(chunk.text);
      })
      .join("");
    const lineWidth = line.reduce((acc, chunk) => acc + visibleWidth(chunk.text), 0);
    return `${rendered}${" ".repeat(Math.max(0, width - lineWidth))}`;
  }
}
