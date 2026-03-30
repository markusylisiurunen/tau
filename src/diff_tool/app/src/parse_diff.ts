import { type FileDiffMetadata, parsePatchFiles } from "@pierre/diffs";
import type { DiffReviewFile } from "./types.js";

export type DiffFile = {
  id: string;
  file: FileDiffMetadata;
  displayPath: string;
  oldRepoPath?: string;
  newRepoPath: string;
  additions: number;
  deletions: number;
};

export function parseDiff(
  raw: string,
  snapshotFiles?: DiffReviewFile[],
  cacheKeyPrefix?: string,
): DiffFile[] {
  if (!raw.trim()) {
    return [];
  }

  const patches = parsePatchFiles(raw, cacheKeyPrefix);
  let counter = 0;

  return patches.flatMap((patch) =>
    patch.files.map((file) => {
      const additions = file.hunks.reduce(
        (sum, hunk) =>
          sum +
          hunk.hunkContent.reduce(
            (hunkSum, block) =>
              hunkSum + (block.type === "change" ? block.additions : 0),
            0,
          ),
        0,
      );
      const deletions = file.hunks.reduce(
        (sum, hunk) =>
          sum +
          hunk.hunkContent.reduce(
            (hunkSum, block) =>
              hunkSum + (block.type === "change" ? block.deletions : 0),
            0,
          ),
        0,
      );
      const displayPath =
        file.prevName && file.prevName !== file.name
          ? `${file.prevName} → ${file.name}`
          : file.name;
      const repoPaths = resolveRepoPaths(file, snapshotFiles);

      return {
        id: file.cacheKey ?? `${file.name}::${counter++}`,
        file,
        displayPath,
        oldRepoPath: repoPaths.oldRepoPath,
        newRepoPath: repoPaths.newRepoPath,
        additions,
        deletions,
      };
    }),
  );
}

function resolveRepoPaths(
  file: FileDiffMetadata,
  snapshotFiles: DiffReviewFile[] | undefined,
): { oldRepoPath?: string; newRepoPath: string } {
  const matched = snapshotFiles?.find((entry) =>
    matchesSnapshotFile(entry, file),
  );
  if (!matched) {
    return {
      oldRepoPath: file.prevName,
      newRepoPath: file.name,
    };
  }

  return {
    oldRepoPath: matched.oldPath,
    newRepoPath: matched.newPath ?? matched.path,
  };
}

function matchesSnapshotFile(
  entry: DiffReviewFile,
  file: FileDiffMetadata,
): boolean {
  if (entry.path === file.name) {
    return true;
  }
  if (entry.newPath === file.name) {
    return true;
  }
  if (entry.oldPath && entry.oldPath === file.prevName) {
    return true;
  }
  return entry.path === file.prevName;
}
