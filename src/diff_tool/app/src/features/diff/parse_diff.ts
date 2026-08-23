import { type FileDiffMetadata, parsePatchFiles } from "@pierre/diffs";
import type { DiffReviewFile } from "../../types.js";

export type DiffFile = {
  id: string;
  file: FileDiffMetadata;
  displayPath: string;
  status: DiffReviewFile["status"];
  oldRepoPath?: string;
  newRepoPath: string;
  additions: number;
  deletions: number;
};

type ResolvedFileMetadata = {
  displayPath: string;
  status: DiffReviewFile["status"];
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
      const fileMetadata = resolveFileMetadata(file, snapshotRepoPaths);

      return {
        id: file.cacheKey ?? `${file.name}::${counter++}`,
        file,
        displayPath: fileMetadata.displayPath,
        status: fileMetadata.status,
        oldRepoPath: fileMetadata.oldRepoPath,
        newRepoPath: fileMetadata.newRepoPath,
        additions: countChanges(file, "additions"),
        deletions: countChanges(file, "deletions"),
      };
    }),
  );
}

function resolveFileStatus(file: FileDiffMetadata): DiffReviewFile["status"] {
  if (file.prevName && file.prevName !== file.name) {
    return "renamed";
  }

  return "modified";
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
): Map<string, ResolvedFileMetadata> {
  const index = new Map<string, ResolvedFileMetadata>();

  for (const file of snapshotFiles ?? []) {
    const metadata: ResolvedFileMetadata = {
      displayPath:
        file.oldPath && file.newPath && file.oldPath !== file.newPath
          ? `${file.oldPath} → ${file.newPath}`
          : file.path,
      status: file.status,
      oldRepoPath: file.oldPath,
      newRepoPath: file.newPath ?? file.path,
    };

    index.set(file.path, metadata);
    if (file.newPath) {
      index.set(file.newPath, metadata);
    }
    if (file.oldPath) {
      index.set(file.oldPath, metadata);
    }
  }

  return index;
}

function resolveFileMetadata(
  file: FileDiffMetadata,
  snapshotRepoPaths: Map<string, ResolvedFileMetadata>,
): ResolvedFileMetadata {
  const matched =
    snapshotRepoPaths.get(file.name) ||
    (file.prevName ? snapshotRepoPaths.get(file.prevName) : undefined);

  if (matched) {
    return matched;
  }

  return {
    displayPath:
      file.prevName && file.prevName !== file.name
        ? `${file.prevName} → ${file.name}`
        : file.name,
    status: resolveFileStatus(file),
    oldRepoPath: file.prevName,
    newRepoPath: file.name,
  };
}
