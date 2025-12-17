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

export function truncateMiddleForModel(
  content: string,
  options: TruncateMiddleForModelOptions,
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

  const tokenCountFromBytes = (bytesTruncated: number): number => {
    if (bytesTruncated <= 0) return 0;
    const approx = Math.floor(bytesTruncated / BYTES_PER_TOKEN);
    return Math.max(1, approx);
  };

  const markerForBytes = (bytesTruncated: number): string =>
    `…${tokenCountFromBytes(bytesTruncated)} tokens truncated…`;

  if (totalLines > maxLines) {
    let headCount = Math.floor(Math.max(0, maxLines - 1) / 2);
    let tailCount = Math.max(0, maxLines - 1) - headCount;

    const build = (
      hc: number,
      tc: number,
    ): { out: string; outBytes: number; bytesTruncated: number } => {
      const headLines = lines.slice(0, hc);
      const tailLines = tc > 0 ? lines.slice(Math.max(totalLines - tc, hc)) : [];
      const kept = [...headLines, ...tailLines].join("\n");
      const keptBytes = Buffer.byteLength(kept, "utf-8");
      const bytesTruncated = Math.max(0, totalBytes - keptBytes);
      const marker = markerForBytes(bytesTruncated);
      const out = [...headLines, marker, ...tailLines].join("\n");
      return { out, outBytes: Buffer.byteLength(out, "utf-8"), bytesTruncated };
    };

    let built = build(headCount, tailCount);
    while (built.outBytes > maxBytes && (headCount > 0 || tailCount > 0)) {
      if (headCount > tailCount) {
        headCount = Math.max(0, headCount - 1);
      } else if (tailCount > headCount) {
        tailCount = Math.max(0, tailCount - 1);
      } else {
        headCount = Math.max(0, headCount - 1);
        tailCount = Math.max(0, tailCount - 1);
      }
      built = build(headCount, tailCount);
    }

    return {
      content: built.out,
      truncated: true,
      truncatedBy: built.outBytes > maxBytes ? "bytes" : "lines",
      totalLines,
      totalBytes,
      outputLines: built.out.split("\n").length,
      outputBytes: built.outBytes,
      maxLines,
      maxTokens,
    };
  }

  let marker = markerForBytes(Math.max(0, totalBytes - maxBytes));
  let out = truncateStringToBytesFromMiddle(content, maxBytes, marker);

  for (let i = 0; i < 2; i++) {
    const markerBytes = Buffer.byteLength(marker, "utf-8");
    const outBytes = Buffer.byteLength(out, "utf-8");
    const keptBytesApprox = Math.max(0, outBytes - markerBytes);
    const bytesTruncated = Math.max(0, totalBytes - keptBytesApprox);
    const nextMarker = markerForBytes(bytesTruncated);
    if (nextMarker === marker) break;
    marker = nextMarker;
    out = truncateStringToBytesFromMiddle(content, maxBytes, marker);
  }

  const finalBytes = Buffer.byteLength(out, "utf-8");
  return {
    content: out,
    truncated: true,
    truncatedBy: "bytes",
    totalLines,
    totalBytes,
    outputLines: out.split("\n").length,
    outputBytes: finalBytes,
    maxLines,
    maxTokens,
  };
}

export function truncateMiddle(content: string, options: TruncateMiddleOptions): TruncationResult {
  const { maxLines } = options;
  const maxBytes = getEffectiveMaxBytes(options);
  const maxTokens = options.maxTokens ?? Math.floor(maxBytes / BYTES_PER_TOKEN);
  const marker = options.marker ?? DEFAULT_MIDDLE_MARKER;

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

  let outputContent = content;
  let truncatedBy: "lines" | "bytes" = totalLines > maxLines ? "lines" : "bytes";

  if (totalLines > maxLines) {
    const safeMaxLines = Math.max(1, maxLines);
    const headCount = Math.floor(safeMaxLines / 2);
    const tailCount = safeMaxLines - headCount;

    const headLines = lines.slice(0, headCount);
    const tailStart = Math.max(totalLines - tailCount, headCount);
    const tailLines = lines.slice(tailStart);

    outputContent = [...headLines, ...tailLines].join("\n");
  }

  const outputBytesBefore = Buffer.byteLength(outputContent, "utf-8");
  if (outputBytesBefore > maxBytes) {
    truncatedBy = "bytes";
    outputContent = truncateStringToBytesFromMiddle(outputContent, maxBytes, marker);
  }

  const outputBytes = Buffer.byteLength(outputContent, "utf-8");
  const outputLines = outputContent.split("\n").length;

  return {
    content: outputContent,
    truncated: true,
    truncatedBy,
    totalLines,
    totalBytes,
    outputLines,
    outputBytes,
    maxLines,
    maxTokens,
  };
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
