import type { Component } from "@mariozechner/pi-tui";
import { visibleWidth } from "@mariozechner/pi-tui";

export type OneLineSegment = { text: string; style: (s: string) => string };

function iterateGraphemes(text: string): string[] {
  if (typeof Intl !== "undefined" && typeof Intl.Segmenter !== "undefined") {
    const seg = new Intl.Segmenter(undefined, { granularity: "grapheme" });
    return Array.from(seg.segment(text), (s) => s.segment);
  }
  return Array.from(text);
}

export function truncateFromEndByWidth(text: string, maxCols: number): string {
  if (maxCols <= 0) return "";
  if (visibleWidth(text) <= maxCols) return text;
  if (maxCols === 1) return "…";

  const ellipsis = "…";
  const targetCols = Math.max(0, maxCols - visibleWidth(ellipsis));
  if (targetCols <= 0) return ellipsis;

  const graphemes = iterateGraphemes(text);
  let out = "";
  let outCols = 0;
  for (const g of graphemes) {
    const gCols = visibleWidth(g);
    if (outCols + gCols > targetCols) break;
    out += g;
    outCols += gCols;
  }
  return `${out}${ellipsis}`;
}

function normalizeInlineTextPreservePadding(text: string): string {
  // Keep this strictly single-line but preserve intentional padding segments (e.g. " ").
  // Callers should trim user-provided segments (e.g. commands) as needed.
  return text.replace(/[\r\n\t]+/g, " ").replace(/ {2,}/g, " ");
}

function wrapTextByWidth(text: string, maxCols: number): string[] {
  if (maxCols <= 0) return [""];
  if (text.length === 0) return [""];

  const graphemes = iterateGraphemes(text);
  const lines: string[] = [];
  let line = "";
  let lineCols = 0;

  for (const g of graphemes) {
    const gCols = visibleWidth(g);
    if (lineCols + gCols > maxCols && line.length > 0) {
      lines.push(line);
      line = "";
      lineCols = 0;
    }
    if (gCols > maxCols && line.length === 0) {
      lines.push(g);
      continue;
    }
    line += g;
    lineCols += gCols;
  }

  if (line.length > 0) {
    lines.push(line);
  }

  return lines;
}

export class OneLineSegmentsComponent implements Component {
  constructor(
    private segments: OneLineSegment[],
    private flexIndices: number[] = [],
  ) {}

  invalidate() {}

  render(width: number) {
    const minWidth = Math.max(0, width);
    const texts = this.segments.map((s) => normalizeInlineTextPreservePadding(s.text));
    const total = (): number => texts.reduce((acc, t) => acc + visibleWidth(t), 0);

    let excess = total() - minWidth;
    if (excess > 0) {
      for (const idx of this.flexIndices) {
        if (excess <= 0) break;
        const original = texts[idx] ?? "";
        const originalCols = visibleWidth(original);
        if (originalCols <= 1) continue;

        const targetCols = Math.max(1, originalCols - excess);
        texts[idx] = truncateFromEndByWidth(original, targetCols);
        excess = total() - minWidth;
      }
    }

    // Last resort: width smaller than fixed parts; hard truncate the fully rendered line.
    if (excess > 0) {
      let remaining = minWidth;
      let usedWidth = 0;
      const styledParts: string[] = [];
      for (let i = 0; i < texts.length && remaining > 0; i++) {
        const segmentText = texts[i] ?? "";
        const segmentWidth = visibleWidth(segmentText);
        const style = this.segments[i]?.style ?? ((s: string) => s);

        if (segmentWidth <= remaining) {
          styledParts.push(style(segmentText));
          remaining -= segmentWidth;
          usedWidth += segmentWidth;
        } else {
          const truncated = truncateFromEndByWidth(segmentText, remaining);
          const truncatedWidth = visibleWidth(truncated);
          styledParts.push(style(truncated));
          usedWidth += truncatedWidth;
          remaining = Math.max(0, remaining - truncatedWidth);
        }
      }

      const pad = Math.max(0, minWidth - usedWidth);
      return [`${styledParts.join("")}${" ".repeat(pad)}`];
    }

    const rendered = texts
      .map((t, i) => {
        const style = this.segments[i]?.style ?? ((s: string) => s);
        return style(t);
      })
      .join("");

    const visibleLen = total();
    const pad = Math.max(0, minWidth - visibleLen);
    return [`${rendered}${" ".repeat(pad)}`];
  }
}

export class WrappedSegmentsComponent implements Component {
  constructor(
    private segments: OneLineSegment[],
    private wrapIndex?: number,
  ) {}

  invalidate() {}

  render(width: number): string[] {
    const minWidth = Math.max(0, width);
    if (this.segments.length === 0) {
      return [" ".repeat(minWidth)];
    }

    const texts = this.segments.map((s) => normalizeInlineTextPreservePadding(s.text));
    const wrapAt = this.wrapIndex ?? texts.length - 1;

    if (wrapAt < 0 || wrapAt >= texts.length || wrapAt !== texts.length - 1) {
      return new OneLineSegmentsComponent(this.segments, []).render(width);
    }

    const prefixTexts = texts.slice(0, wrapAt);
    const wrapText = texts[wrapAt] ?? "";
    const prefixWidth = visibleWidth(prefixTexts.join(""));
    if (prefixWidth >= minWidth || minWidth <= 0) {
      return new OneLineSegmentsComponent(this.segments, []).render(width);
    }

    const availableWidth = Math.max(1, minWidth - prefixWidth);
    const wrapped = wrapTextByWidth(wrapText, availableWidth);
    const prefixRendered = prefixTexts
      .map((t, i) => {
        const style = this.segments[i]?.style ?? ((s: string) => s);
        return style(t);
      })
      .join("");
    const wrapStyle = this.segments[wrapAt]?.style ?? ((s: string) => s);

    return wrapped.map((line, index) => {
      const leading = index === 0 ? prefixRendered : "";
      const lineWidth = (index === 0 ? prefixWidth : 0) + visibleWidth(line);
      const pad = Math.max(0, minWidth - lineWidth);
      return `${leading}${wrapStyle(line)}${" ".repeat(pad)}`;
    });
  }
}
