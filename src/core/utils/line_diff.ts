const DEFAULT_LCS_MAX_LINES = 1024;

export interface LineDiffResult {
  lines: string[];
  added: number;
  removed: number;
}

function* iterateTextLinesForDiff(text: string): Iterable<string> {
  if (text.length === 0) return;

  let start = 0;
  while (true) {
    const idx = text.indexOf("\n", start);
    if (idx === -1) {
      yield text.slice(start);
      break;
    }
    yield text.slice(start, idx);
    start = idx + 1;
    if (start === text.length) {
      yield "";
      break;
    }
  }
}

export function buildLineDiff(
  oldText: string,
  newText: string,
  options?: { lcsMaxLines?: number },
): LineDiffResult {
  const oldLines = [...iterateTextLinesForDiff(oldText)];
  const newLines = [...iterateTextLinesForDiff(newText)];
  const oldLen = oldLines.length;
  const newLen = newLines.length;
  const lcsMaxLines = options?.lcsMaxLines ?? DEFAULT_LCS_MAX_LINES;

  const lines: string[] = [];
  let added = 0;
  let removed = 0;

  if (oldLen === 0 && newLen === 0) {
    return { lines, added, removed };
  }

  if (oldLen === 0) {
    for (const line of newLines) {
      lines.push(`+ ${line}`);
      added++;
    }
    return { lines, added, removed };
  }

  if (newLen === 0) {
    for (const line of oldLines) {
      lines.push(`- ${line}`);
      removed++;
    }
    return { lines, added, removed };
  }

  if (oldLen + newLen > lcsMaxLines) {
    for (const line of oldLines) {
      lines.push(`- ${line}`);
      removed++;
    }
    for (const line of newLines) {
      lines.push(`+ ${line}`);
      added++;
    }
    return { lines, added, removed };
  }

  const dp: number[][] = Array.from({ length: oldLen + 1 }, () =>
    new Array<number>(newLen + 1).fill(0),
  );

  for (let i = oldLen - 1; i >= 0; i--) {
    const row = dp[i]!;
    const nextRow = dp[i + 1]!;
    for (let j = newLen - 1; j >= 0; j--) {
      if (oldLines[i] === newLines[j]) {
        row[j] = (nextRow[j + 1] ?? 0) + 1;
      } else {
        row[j] = Math.max(nextRow[j] ?? 0, row[j + 1] ?? 0);
      }
    }
  }

  let i = 0;
  let j = 0;
  while (i < oldLen && j < newLen) {
    if (oldLines[i] === newLines[j]) {
      lines.push(`  ${oldLines[i]}`);
      i++;
      j++;
      continue;
    }

    const down = dp[i + 1]?.[j] ?? 0;
    const right = dp[i]?.[j + 1] ?? 0;
    if (down >= right) {
      lines.push(`- ${oldLines[i]}`);
      removed++;
      i++;
    } else {
      lines.push(`+ ${newLines[j]}`);
      added++;
      j++;
    }
  }

  for (; i < oldLen; i++) {
    lines.push(`- ${oldLines[i]}`);
    removed++;
  }

  for (; j < newLen; j++) {
    lines.push(`+ ${newLines[j]}`);
    added++;
  }

  return { lines, added, removed };
}

export function collapseLongUnchangedDiffRuns(args: {
  diffLines: readonly string[];
  maxUnchangedLines: number;
}): string[] {
  const { diffLines, maxUnchangedLines } = args;
  if (maxUnchangedLines <= 0) {
    return diffLines.filter((line) => !line.startsWith("  "));
  }

  const out: string[] = [];
  const maxBefore = Math.ceil(maxUnchangedLines / 2);
  const maxAfter = maxUnchangedLines - maxBefore;

  let index = 0;
  while (index < diffLines.length) {
    const line = diffLines[index]!;
    if (!line.startsWith("  ")) {
      out.push(line);
      index += 1;
      continue;
    }

    const start = index;
    while (index < diffLines.length && diffLines[index]!.startsWith("  ")) {
      index += 1;
    }
    const end = index;
    const run = diffLines.slice(start, end);

    const hasChangeBefore = start > 0 && !diffLines[start - 1]!.startsWith("  ");
    const hasChangeAfter = end < diffLines.length && !diffLines[end]!.startsWith("  ");

    if (run.length <= maxUnchangedLines) {
      out.push(...run);
      continue;
    }

    const omitted = run.length - maxUnchangedLines;
    if (!hasChangeBefore && hasChangeAfter) {
      out.push(`… ${omitted} unchanged line(s) omitted …`);
      out.push(...run.slice(run.length - maxUnchangedLines));
      continue;
    }

    if (hasChangeBefore && !hasChangeAfter) {
      out.push(...run.slice(0, maxUnchangedLines));
      out.push(`… ${omitted} unchanged line(s) omitted …`);
      continue;
    }

    if (hasChangeBefore && hasChangeAfter) {
      out.push(...run.slice(0, maxBefore));
      out.push(`… ${omitted} unchanged line(s) omitted …`);
      out.push(...run.slice(run.length - maxAfter));
      continue;
    }

    out.push(...run.slice(0, maxUnchangedLines));
    out.push(`… ${omitted} unchanged line(s) omitted …`);
  }

  return out;
}
