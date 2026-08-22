import type { DiffFile } from "./parse_diff.js";

export function toLookup(ids: string[]): Record<string, boolean> {
  return Object.fromEntries(ids.map((id) => [id, true]));
}

export function toggleId(ids: string[], id: string): string[] {
  return ids.includes(id) ? ids.filter((value) => value !== id) : [...ids, id];
}

export function uniqueIds(ids: string[]): string[] {
  return [...new Set(ids)];
}

export function sumFileChanges(
  totals: { additions: number; deletions: number },
  file: DiffFile,
): { additions: number; deletions: number } {
  return {
    additions: totals.additions + file.additions,
    deletions: totals.deletions + file.deletions,
  };
}
