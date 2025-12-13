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
      const raw = texts.join("");
      return [truncateFromEndByWidth(raw, minWidth)];
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
