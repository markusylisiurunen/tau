import { visibleWidth } from "@earendil-works/pi-tui";

export type OneLineSegment = { text: string; style: (s: string) => string };

export function iterateGraphemes(text: string): string[] {
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

export function truncateFromEndByWidthPreserveAnsi(text: string, maxCols: number): string {
  if (!text.includes("\x1b")) {
    return truncateFromEndByWidth(text, maxCols);
  }

  if (maxCols <= 0) return "";
  if (visibleWidth(text) <= maxCols) return text;
  if (maxCols === 1) return "…";

  const ellipsis = "…";
  const targetCols = Math.max(0, maxCols - visibleWidth(ellipsis));
  if (targetCols <= 0) return ellipsis;

  const parts = splitAnsiParts(text);

  let out = "";
  let outCols = 0;

  outer: for (const part of parts) {
    if (part.type === "ansi") {
      out += part.value;
      continue;
    }

    for (const g of iterateGraphemes(part.value)) {
      const gCols = visibleWidth(g);
      if (outCols + gCols > targetCols) break outer;
      out += g;
      outCols += gCols;
    }
  }

  if (!out.endsWith("\x1b[0m")) {
    return `${out}${ellipsis}\x1b[0m`;
  }

  return `${out}${ellipsis}`;
}

function splitAnsiParts(text: string): Array<{ type: "ansi" | "text"; value: string }> {
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

    const parsed = parseAnsiSequence(text, escIndex);
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

function parseAnsiSequence(
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
