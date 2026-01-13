import { BYTES_PER_TOKEN } from "./token.js";

export interface TruncationResult {
  content: string;
  truncated: boolean;
  truncatedBy: "lines" | "bytes" | null;
  totalLines: number;
  totalBytes: number;
  outputLines: number;
  outputBytes: number;
  maxLines: number;
  maxTokens: number;
}

export interface TruncateMiddleOptions {
  maxLines: number;
  maxBytes?: number;
  maxTokens?: number;
  marker?: string;
}

export interface TruncateMiddleForModelOptions {
  maxLines: number;
  maxBytes?: number;
  maxTokens?: number;
}

const DEFAULT_MIDDLE_MARKER = "… (truncated) …";

type MarkerStrategy =
  | { type: "none" }
  | { type: "static"; marker: string }
  | { type: "dynamic"; build: (bytesTruncated: number) => string };

function getEffectiveMaxBytes(options: { maxBytes?: number; maxTokens?: number }): number {
  if (options.maxTokens !== undefined) {
    return options.maxTokens * BYTES_PER_TOKEN;
  }
  return options.maxBytes ?? Number.POSITIVE_INFINITY;
}

function truncateStringToBytesFromMiddle(str: string, maxBytes: number, marker: string): string {
  const markerBytes = Buffer.byteLength(marker, "utf-8");
  if (maxBytes <= markerBytes) {
    return truncateToBytesFromStart(marker, maxBytes);
  }

  const remainingBytes = maxBytes - markerBytes;
  const headBytes = Math.floor(remainingBytes / 2);
  const tailBytes = remainingBytes - headBytes;

  const head = truncateToBytesFromStart(str, headBytes);
  const tail = truncateStringToBytesFromEnd(str, tailBytes);
  return `${head}${marker}${tail}`;
}

function getMarkerForBytes(strategy: MarkerStrategy, bytesTruncated: number): string | undefined {
  if (strategy.type === "none") return undefined;
  if (strategy.type === "static") return strategy.marker;
  return strategy.build(bytesTruncated);
}

function buildLineTruncation(args: {
  lines: string[];
  totalLines: number;
  totalBytes: number;
  headCount: number;
  tailCount: number;
  marker: MarkerStrategy;
}): { out: string; outBytes: number; bytesTruncated: number } {
  const { lines, totalLines, totalBytes, headCount, tailCount, marker } = args;
  const headLines = lines.slice(0, headCount);
  const tailLines = tailCount > 0 ? lines.slice(Math.max(totalLines - tailCount, headCount)) : [];
  const kept = [...headLines, ...tailLines].join("\n");
  const keptBytes = Buffer.byteLength(kept, "utf-8");
  const bytesTruncated = Math.max(0, totalBytes - keptBytes);
  const markerText = getMarkerForBytes(marker, bytesTruncated);
  const outLines = markerText
    ? [...headLines, markerText, ...tailLines]
    : [...headLines, ...tailLines];
  const out = outLines.join("\n");
  return { out, outBytes: Buffer.byteLength(out, "utf-8"), bytesTruncated };
}

function truncateBytesWithMarker(args: {
  content: string;
  totalBytes: number;
  maxBytes: number;
  marker: MarkerStrategy;
}): string {
  const { content, totalBytes, maxBytes, marker } = args;
  const initialMarker =
    getMarkerForBytes(marker, Math.max(0, totalBytes - maxBytes)) ?? DEFAULT_MIDDLE_MARKER;
  let currentMarker = initialMarker;
  let out = truncateStringToBytesFromMiddle(content, maxBytes, currentMarker);

  if (marker.type !== "dynamic") {
    return out;
  }

  for (let i = 0; i < 2; i++) {
    const markerBytes = Buffer.byteLength(currentMarker, "utf-8");
    const outBytes = Buffer.byteLength(out, "utf-8");
    const keptBytesApprox = Math.max(0, outBytes - markerBytes);
    const bytesTruncated = Math.max(0, totalBytes - keptBytesApprox);
    const nextMarker = marker.build(bytesTruncated);
    if (nextMarker === currentMarker) break;
    currentMarker = nextMarker;
    out = truncateStringToBytesFromMiddle(content, maxBytes, currentMarker);
  }

  return out;
}

function truncateMiddleCore(args: {
  content: string;
  maxLines: number;
  maxBytes: number;
  maxTokens: number;
  lineMarker: MarkerStrategy;
  bytesMarker: MarkerStrategy;
  adjustLineToBytes: boolean;
}): TruncationResult {
  const { content, maxLines, maxBytes, maxTokens, lineMarker, bytesMarker, adjustLineToBytes } =
    args;

  const totalBytes = Buffer.byteLength(content, "utf-8");
  const lines = content.split("\n");
  const totalLines = lines.length;

  if (totalLines <= maxLines && totalBytes <= maxBytes) {
    return {
      content,
      truncated: false,
      truncatedBy: null,
      totalLines,
      totalBytes,
      outputLines: totalLines,
      outputBytes: totalBytes,
      maxLines,
      maxTokens,
    };
  }

  if (totalLines > maxLines) {
    const markerLineCount = lineMarker.type === "none" ? 0 : 1;
    const availableLines = Math.max(0, maxLines - markerLineCount);
    let headCount = Math.floor(availableLines / 2);
    let tailCount = availableLines - headCount;

    let built = buildLineTruncation({
      lines,
      totalLines,
      totalBytes,
      headCount,
      tailCount,
      marker: lineMarker,
    });

    if (adjustLineToBytes) {
      while (built.outBytes > maxBytes && (headCount > 0 || tailCount > 0)) {
        if (headCount > tailCount) {
          headCount = Math.max(0, headCount - 1);
        } else if (tailCount > headCount) {
          tailCount = Math.max(0, tailCount - 1);
        } else {
          headCount = Math.max(0, headCount - 1);
          tailCount = Math.max(0, tailCount - 1);
        }
        built = buildLineTruncation({
          lines,
          totalLines,
          totalBytes,
          headCount,
          tailCount,
          marker: lineMarker,
        });
      }
    }

    let outputContent = built.out;
    let outputBytes = built.outBytes;
    let truncatedBy: "lines" | "bytes" = built.outBytes > maxBytes ? "bytes" : "lines";

    if (!adjustLineToBytes && built.outBytes > maxBytes) {
      outputContent = truncateBytesWithMarker({
        content: built.out,
        totalBytes: built.outBytes,
        maxBytes,
        marker: bytesMarker,
      });
      outputBytes = Buffer.byteLength(outputContent, "utf-8");
      truncatedBy = "bytes";
    }

    return {
      content: outputContent,
      truncated: true,
      truncatedBy,
      totalLines,
      totalBytes,
      outputLines: outputContent.split("\n").length,
      outputBytes,
      maxLines,
      maxTokens,
    };
  }

  const outputContent = truncateBytesWithMarker({
    content,
    totalBytes,
    maxBytes,
    marker: bytesMarker,
  });
  const outputBytes = Buffer.byteLength(outputContent, "utf-8");

  return {
    content: outputContent,
    truncated: true,
    truncatedBy: "bytes",
    totalLines,
    totalBytes,
    outputLines: outputContent.split("\n").length,
    outputBytes,
    maxLines,
    maxTokens,
  };
}

export function truncateMiddleForModel(
  content: string,
  options: TruncateMiddleForModelOptions,
): TruncationResult {
  const tokenCountFromBytes = (bytesTruncated: number): number => {
    if (bytesTruncated <= 0) return 0;
    const approx = Math.floor(bytesTruncated / BYTES_PER_TOKEN);
    return Math.max(1, approx);
  };

  const markerForBytes = (bytesTruncated: number): string =>
    `…${tokenCountFromBytes(bytesTruncated)} tokens truncated…`;
  const maxBytes = getEffectiveMaxBytes(options);
  const maxTokens = options.maxTokens ?? Math.floor(maxBytes / BYTES_PER_TOKEN);

  return truncateMiddleCore({
    content,
    maxLines: options.maxLines,
    maxBytes,
    maxTokens,
    lineMarker: { type: "dynamic", build: markerForBytes },
    bytesMarker: { type: "dynamic", build: markerForBytes },
    adjustLineToBytes: true,
  });
}

export function truncateMiddle(content: string, options: TruncateMiddleOptions): TruncationResult {
  const maxBytes = getEffectiveMaxBytes(options);
  const maxTokens = options.maxTokens ?? Math.floor(maxBytes / BYTES_PER_TOKEN);
  const marker = options.marker ?? DEFAULT_MIDDLE_MARKER;

  return truncateMiddleCore({
    content,
    maxLines: options.maxLines,
    maxBytes,
    maxTokens,
    lineMarker: { type: "none" },
    bytesMarker: { type: "static", marker },
    adjustLineToBytes: false,
  });
}

export function truncateTail(
  content: string,
  options: { maxLines: number; maxBytes?: number; maxTokens?: number },
): TruncationResult {
  const { maxLines } = options;
  const maxBytes = getEffectiveMaxBytes(options);
  const maxTokens = options.maxTokens ?? Math.floor(maxBytes / BYTES_PER_TOKEN);

  const totalBytes = Buffer.byteLength(content, "utf-8");
  const lines = content.split("\n");
  const totalLines = lines.length;

  if (totalLines <= maxLines && totalBytes <= maxBytes) {
    return {
      content,
      truncated: false,
      truncatedBy: null,
      totalLines,
      totalBytes,
      outputLines: totalLines,
      outputBytes: totalBytes,
      maxLines,
      maxTokens,
    };
  }

  const outputLinesArr: string[] = [];
  let outputBytesCount = 0;
  let truncatedBy: "lines" | "bytes" = "lines";

  for (let i = lines.length - 1; i >= 0 && outputLinesArr.length < maxLines; i--) {
    const line = lines[i] ?? "";
    const lineBytes = Buffer.byteLength(line, "utf-8") + (outputLinesArr.length > 0 ? 1 : 0);

    if (outputBytesCount + lineBytes > maxBytes) {
      truncatedBy = "bytes";
      if (outputLinesArr.length === 0) {
        const truncatedLine = truncateStringToBytesFromEnd(line, maxBytes);
        outputLinesArr.unshift(truncatedLine);
        outputBytesCount = Buffer.byteLength(truncatedLine, "utf-8");
      }
      break;
    }

    outputLinesArr.unshift(line);
    outputBytesCount += lineBytes;
  }

  if (outputLinesArr.length >= maxLines && outputBytesCount <= maxBytes) {
    truncatedBy = "lines";
  }

  const outputContent = outputLinesArr.join("\n");
  const finalOutputBytes = Buffer.byteLength(outputContent, "utf-8");

  return {
    content: outputContent,
    truncated: true,
    truncatedBy,
    totalLines,
    totalBytes,
    outputLines: outputLinesArr.length,
    outputBytes: finalOutputBytes,
    maxLines,
    maxTokens,
  };
}

function truncateStringToBytesFromEnd(str: string, maxBytes: number): string {
  const buf = Buffer.from(str, "utf-8");
  if (buf.length <= maxBytes) return str;

  let start = buf.length - maxBytes;
  while (start < buf.length && (buf[start]! & 0xc0) === 0x80) {
    start++;
  }
  return buf.slice(start).toString("utf-8");
}

export function truncateHead(
  content: string,
  options: { maxLines: number; maxBytes?: number; maxTokens?: number },
): TruncationResult {
  const { maxLines } = options;
  const maxBytes = getEffectiveMaxBytes(options);
  const maxTokens = options.maxTokens ?? Math.floor(maxBytes / BYTES_PER_TOKEN);

  const totalBytes = Buffer.byteLength(content, "utf-8");
  const lines = content.split("\n");
  const totalLines = lines.length;

  if (totalLines <= maxLines && totalBytes <= maxBytes) {
    return {
      content,
      truncated: false,
      truncatedBy: null,
      totalLines,
      totalBytes,
      outputLines: totalLines,
      outputBytes: totalBytes,
      maxLines,
      maxTokens,
    };
  }

  const outputLinesArr: string[] = [];
  let outputBytesCount = 0;
  let truncatedBy: "lines" | "bytes" = "lines";

  for (let i = 0; i < lines.length && outputLinesArr.length < maxLines; i++) {
    const line = lines[i] ?? "";
    const lineBytes = Buffer.byteLength(line, "utf-8") + (outputLinesArr.length > 0 ? 1 : 0);

    if (outputBytesCount + lineBytes > maxBytes) {
      truncatedBy = "bytes";
      if (outputLinesArr.length === 0) {
        const truncatedLine = truncateToBytesFromStart(line, maxBytes);
        outputLinesArr.push(truncatedLine);
        outputBytesCount = Buffer.byteLength(truncatedLine, "utf-8");
      }
      break;
    }

    outputLinesArr.push(line);
    outputBytesCount += lineBytes;
  }

  if (outputLinesArr.length >= maxLines && outputBytesCount <= maxBytes) {
    truncatedBy = "lines";
  }

  const outputContent = outputLinesArr.join("\n");
  const finalOutputBytes = Buffer.byteLength(outputContent, "utf-8");

  return {
    content: outputContent,
    truncated: true,
    truncatedBy,
    totalLines,
    totalBytes,
    outputLines: outputLinesArr.length,
    outputBytes: finalOutputBytes,
    maxLines,
    maxTokens,
  };
}

export function truncateToBytesFromStart(str: string, maxBytes: number): string {
  const buf = Buffer.from(str, "utf-8");
  if (buf.length <= maxBytes) return str;

  let end = maxBytes;
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) {
    end--;
  }
  return buf.slice(0, end).toString("utf-8");
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes}B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)}KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
}

export function truncateInline(text: string, maxChars: number): string {
  const singleLine = text.replace(/\s+/g, " ").trim();
  if (maxChars <= 0) return "";

  const chars = Array.from(singleLine);
  if (chars.length <= maxChars) return singleLine;
  if (maxChars === 1) return "…";
  return `${chars.slice(0, maxChars - 1).join("")}…`;
}
