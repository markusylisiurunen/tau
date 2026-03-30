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

type RepoPaths = {
  oldRepoPath?: string;
  newRepoPath: string;
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
  const snapshotRepoPaths = buildSnapshotRepoPathIndex(snapshotFiles);
  let counter = 0;

  return patches.flatMap((patch) =>
    patch.files.map((file) => {
      const repoPaths = resolveRepoPaths(file, snapshotRepoPaths);

      return {
        id: file.cacheKey ?? `${file.name}::${counter++}`,
        file,
        displayPath: file.name,
        oldRepoPath: repoPaths.oldRepoPath,
        newRepoPath: repoPaths.newRepoPath,
        additions: countChanges(file, "additions"),
        deletions: countChanges(file, "deletions"),
      };
    }),
  );
}

function countChanges(
  file: FileDiffMetadata,
  changeType: "additions" | "deletions",
): number {
  return file.hunks.reduce(
    (fileTotal, hunk) =>
      fileTotal +
      hunk.hunkContent.reduce(
        (hunkTotal, block) =>
          hunkTotal + (block.type === "change" ? block[changeType] : 0),
        0,
      ),
    0,
  );
}

function buildSnapshotRepoPathIndex(
  snapshotFiles: DiffReviewFile[] | undefined,
): Map<string, RepoPaths> {
  const index = new Map<string, RepoPaths>();

  for (const file of snapshotFiles ?? []) {
    const repoPaths: RepoPaths = {
      oldRepoPath: file.oldPath,
      newRepoPath: file.newPath ?? file.path,
    };

    index.set(file.path, repoPaths);
    if (file.newPath) {
      index.set(file.newPath, repoPaths);
    }
    if (file.oldPath) {
      index.set(file.oldPath, repoPaths);
    }
  }

  return index;
}

function resolveRepoPaths(
  file: FileDiffMetadata,
  snapshotRepoPaths: Map<string, RepoPaths>,
): RepoPaths {
  const matched =
    snapshotRepoPaths.get(file.name) ||
    (file.prevName ? snapshotRepoPaths.get(file.prevName) : undefined);

  if (matched) {
    return matched;
  }

  return {
    oldRepoPath: file.prevName,
    newRepoPath: file.name,
  };
}
