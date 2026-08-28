import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import type { CoreDeps } from "../runtime/deps.js";
import { createDefaultCoreDeps } from "../runtime/deps.js";

export type DiffReviewFileStatus =
  | "added"
  | "modified"
  | "deleted"
  | "renamed"
  | "copied"
  | "type-changed"
  | "unmerged"
  | "unknown";

export type DiffReviewFile = {
  path: string;
  status: DiffReviewFileStatus;
  oldPath?: string;
  newPath?: string;
};

export type DiffReviewSnapshotData = {
  id: string;
  repoRoot: string;
  cwd: string;
  diffArgs: string[];
  patch: string;
  files: DiffReviewFile[];
  patchByPath: Record<string, string>;
  scopeLabel: string;
};

export type DiffReviewSnapshotSource =
  | {
      kind: "git_diff";
      diffArgs: string[];
    }
  | {
      kind: "patch_files";
      patchFiles: string[];
      scopeLabel: string;
    };

export type CaptureDiffReviewSnapshotOptions = {
  cwd: string;
  source: DiffReviewSnapshotSource;
  signal?: AbortSignal;
  deps?: Partial<DiffSnapshotDeps>;
};

type DiffSnapshotDeps = Pick<CoreDeps, "spawn"> & {
  env: Pick<CoreDeps["env"], "env">;
  fs: {
    readFile: (path: string) => string | Promise<string>;
  };
};

const GIT_TIMEOUT_MS = 30_000;
const MAX_SNAPSHOT_PATCH_BYTES = 16 * 1024 * 1024;
const MAX_UNTRACKED_TEXT_BYTES = 4 * 1024 * 1024;
const WORKING_TREE_SCOPE_LABEL = "current working tree";

export class DiffReviewSnapshot {
  readonly id: string;
  readonly repoRoot: string;
  readonly cwd: string;
  readonly diffArgs: string[];
  readonly patch: string;
  readonly files: readonly DiffReviewFile[];
  private readonly scopeLabel: string;
  private readonly patchByPath: ReadonlyMap<string, string>;

  constructor(args: {
    repoRoot: string;
    cwd: string;
    diffArgs: string[];
    patch: string;
    files: DiffReviewFile[];
    patchByPath: ReadonlyMap<string, string>;
    scopeLabel: string;
    id?: string;
  }) {
    this.id = args.id ?? `diff-${randomUUID()}`;
    this.repoRoot = args.repoRoot;
    this.cwd = args.cwd;
    this.diffArgs = [...args.diffArgs];
    this.patch = args.patch;
    this.files = args.files.map((file) => ({ ...file }));
    this.scopeLabel = args.scopeLabel;
    this.patchByPath = new Map(args.patchByPath);
  }

  getFilePatch(path: string): string | undefined {
    if (path.length === 0) {
      return undefined;
    }
    return this.patchByPath.get(path);
  }

  toDiffCommand(): string {
    return this.scopeLabel;
  }
}

export function diffReviewSnapshotToData(snapshot: DiffReviewSnapshot): DiffReviewSnapshotData {
  const patchByPath: Record<string, string> = {};
  for (const file of snapshot.files) {
    const patch = snapshot.getFilePatch(file.path);
    if (patch !== undefined) {
      patchByPath[file.path] = patch;
    }
  }

  return {
    id: snapshot.id,
    repoRoot: snapshot.repoRoot,
    cwd: snapshot.cwd,
    diffArgs: [...snapshot.diffArgs],
    patch: snapshot.patch,
    files: snapshot.files.map((file) => ({ ...file })),
    patchByPath,
    scopeLabel: snapshot.toDiffCommand(),
  };
}

export function diffReviewSnapshotFromData(data: DiffReviewSnapshotData): DiffReviewSnapshot {
  return new DiffReviewSnapshot({
    id: data.id,
    repoRoot: data.repoRoot,
    cwd: data.cwd,
    diffArgs: data.diffArgs,
    patch: data.patch,
    files: data.files,
    patchByPath: new Map(Object.entries(data.patchByPath)),
    scopeLabel: data.scopeLabel,
  });
}

export function formatDiffReviewScope(diffArgs: string[]): string {
  return diffArgs.length > 0 ? `git diff ${diffArgs.join(" ")}` : WORKING_TREE_SCOPE_LABEL;
}

export async function captureDiffReviewSnapshot(
  options: CaptureDiffReviewSnapshotOptions,
): Promise<DiffReviewSnapshot> {
  const deps = createDiffSnapshotDeps(options.deps);
  const cwd = resolve(options.cwd);
  const signal = options.signal;
  const repoRoot = await resolveGitRepoRoot(cwd, deps, signal);
  const source = options.source;
  const captured =
    source.kind === "patch_files"
      ? await capturePatchFilesSnapshot(cwd, source.patchFiles, deps, signal)
      : source.diffArgs.length > 0
        ? await captureExplicitDiffSnapshot(cwd, source.diffArgs, deps, signal)
        : await captureWorkingTreeSnapshot(repoRoot, deps, signal);
  assertSnapshotPatchBytesWithinLimit(Buffer.byteLength(captured.patch, "utf-8"));
  const diffArgs = source.kind === "git_diff" ? [...source.diffArgs] : [];

  return new DiffReviewSnapshot({
    repoRoot,
    cwd,
    diffArgs,
    patch: captured.patch,
    files: captured.files,
    patchByPath: captured.patchByPath,
    scopeLabel:
      source.kind === "patch_files" ? source.scopeLabel : formatDiffReviewScope(source.diffArgs),
  });
}

type CapturedSnapshotData = {
  patch: string;
  files: DiffReviewFile[];
  patchByPath: ReadonlyMap<string, string>;
};

function throwIfSnapshotAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new Error("diff review start aborted");
  }
}

function assertSnapshotPatchBytesWithinLimit(bytes: number): void {
  if (bytes > MAX_SNAPSHOT_PATCH_BYTES) {
    throw new Error(
      `diff review snapshot patch exceeds the ${MAX_SNAPSHOT_PATCH_BYTES}-byte limit; narrow the review scope`,
    );
  }
}

function createDiffSnapshotDeps(deps?: Partial<DiffSnapshotDeps>): DiffSnapshotDeps {
  const defaults = createDefaultCoreDeps();
  return {
    spawn: deps?.spawn ?? defaults.spawn,
    env: deps?.env ?? defaults.env,
    fs: deps?.fs ?? defaults.fs,
  };
}

async function resolveGitRepoRoot(
  cwd: string,
  deps: Pick<DiffSnapshotDeps, "spawn" | "env">,
  signal?: AbortSignal,
): Promise<string> {
  const output = await runGitCommand(
    cwd,
    ["rev-parse", "--show-toplevel"],
    deps,
    {
      invalidRepoMessage: "diff review requires a git repository",
    },
    signal,
  );
  const repoRoot = output.trim();
  if (!repoRoot) {
    throw new Error("failed to resolve git repository root");
  }
  return resolve(repoRoot);
}

async function capturePatchFilesSnapshot(
  cwd: string,
  patchFiles: string[],
  deps: Pick<DiffSnapshotDeps, "fs">,
  signal?: AbortSignal,
): Promise<CapturedSnapshotData> {
  const sections: string[] = [];
  let totalBytes = 0;
  for (const patchFile of patchFiles) {
    throwIfSnapshotAborted(signal);
    const patchPath = resolve(cwd, patchFile);
    const patch = await deps.fs.readFile(patchPath);
    totalBytes += Buffer.byteLength(patch, "utf-8");
    assertSnapshotPatchBytesWithinLimit(totalBytes);

    const patchSections = splitPatchSections(patch);
    if (patchSections.length === 0 && patch.trim().length > 0) {
      throw new Error(`patch file ${patchFile} does not contain git unified diff sections`);
    }
    sections.push(...patchSections);
  }

  const files = sections.map((section) => parsePatchSectionFile(section));
  const patchByPath = pairFilePatches(files, sections);

  return {
    patch: joinPatchSections(sections),
    files: dedupeFilesByPath(files),
    patchByPath,
  };
}

async function captureExplicitDiffSnapshot(
  cwd: string,
  diffArgs: string[],
  deps: Pick<DiffSnapshotDeps, "spawn" | "env">,
  signal?: AbortSignal,
): Promise<CapturedSnapshotData> {
  const patch = await runGitCommand(cwd, ["diff", ...diffArgs], deps, {}, signal);
  const files = parseNameStatusOutput(
    await runGitCommand(cwd, ["diff", "--name-status", "-z", ...diffArgs], deps, {}, signal),
  );
  const patchSections = splitPatchSections(
    await runGitCommand(cwd, ["diff", ...withForcedPatch(diffArgs)], deps, {}, signal),
  );

  return {
    patch,
    files,
    patchByPath: pairFilePatches(files, patchSections),
  };
}

async function captureWorkingTreeSnapshot(
  repoRoot: string,
  deps: DiffSnapshotDeps,
  signal?: AbortSignal,
): Promise<CapturedSnapshotData> {
  const hasHead = await gitRefExists(repoRoot, "HEAD", deps, signal);
  const tracked = hasHead
    ? await captureTrackedWorkingTreeSnapshot(repoRoot, deps, signal)
    : await captureTrackedWorkingTreeSnapshotWithoutHead(repoRoot, deps, signal);
  const untracked = await captureUntrackedFilePatches(repoRoot, deps, signal);
  const patchByPath = new Map(tracked.patchByPath);
  for (const [path, patch] of untracked.patchByPath) {
    patchByPath.set(path, patch);
  }

  return sortCapturedSnapshotDataByPath({
    patch: joinPatchSections([tracked.patch, ...untracked.patches]),
    files: dedupeFilesByPath([...tracked.files, ...untracked.files]),
    patchByPath,
  });
}

async function captureTrackedWorkingTreeSnapshot(
  repoRoot: string,
  deps: Pick<DiffSnapshotDeps, "spawn" | "env">,
  signal?: AbortSignal,
): Promise<CapturedSnapshotData> {
  const patch = await runGitCommand(repoRoot, ["diff", "HEAD"], deps, {}, signal);
  const files = parseNameStatusOutput(
    await runGitCommand(repoRoot, ["diff", "--name-status", "-z", "HEAD"], deps, {}, signal),
  );
  const patchSections = splitPatchSections(
    await runGitCommand(repoRoot, ["diff", "HEAD", "--patch"], deps, {}, signal),
  );

  return {
    patch,
    files,
    patchByPath: pairFilePatches(files, patchSections),
  };
}

async function captureTrackedWorkingTreeSnapshotWithoutHead(
  repoRoot: string,
  deps: Pick<DiffSnapshotDeps, "spawn" | "env">,
  signal?: AbortSignal,
): Promise<CapturedSnapshotData> {
  const unstagedPatch = await runGitCommand(repoRoot, ["diff"], deps, {}, signal);
  const stagedPatch = await runGitCommand(
    repoRoot,
    ["diff", "--cached", "--root"],
    deps,
    {},
    signal,
  );
  const unstagedFiles = parseNameStatusOutput(
    await runGitCommand(repoRoot, ["diff", "--name-status", "-z"], deps, {}, signal),
  );
  const stagedFiles = parseNameStatusOutput(
    await runGitCommand(
      repoRoot,
      ["diff", "--cached", "--name-status", "-z", "--root"],
      deps,
      {},
      signal,
    ),
  );
  const patch = joinPatchSections([unstagedPatch, stagedPatch]);
  const files = dedupeFilesByPath([...unstagedFiles, ...stagedFiles]);

  return {
    patch,
    files,
    patchByPath: pairFilePatches(files, splitPatchSections(patch)),
  };
}

async function captureUntrackedFilePatches(
  repoRoot: string,
  deps: DiffSnapshotDeps,
  signal?: AbortSignal,
): Promise<{
  files: DiffReviewFile[];
  patches: string[];
  patchByPath: ReadonlyMap<string, string>;
}> {
  const paths = parseNullSeparatedPaths(
    await runGitCommand(
      repoRoot,
      ["ls-files", "--others", "--exclude-standard", "-z"],
      deps,
      {},
      signal,
    ),
  );
  const files: DiffReviewFile[] = [];
  const patches: string[] = [];
  const patchByPath = new Map<string, string>();

  for (const path of paths) {
    const filePath = resolve(repoRoot, path);
    let content: string;
    try {
      content = await deps.fs.readFile(filePath);
    } catch {
      continue;
    }

    if (Buffer.byteLength(content, "utf-8") > MAX_UNTRACKED_TEXT_BYTES || content.includes("\0")) {
      continue;
    }

    const patch = createUntrackedFilePatch(path, content);
    files.push({
      path,
      status: "added",
      newPath: path,
    });
    patches.push(patch);
    patchByPath.set(path, patch);
  }

  return {
    files,
    patches,
    patchByPath,
  };
}

function createUntrackedFilePatch(path: string, content: string): string {
  const lines = splitPatchContentLines(content);
  const patch = [
    `diff --git ${formatPatchPath(`a/${path}`)} ${formatPatchPath(`b/${path}`)}`,
    "new file mode 100644",
    "--- /dev/null",
    `+++ ${formatPatchPath(`b/${path}`)}`,
  ];

  if (lines.length === 0) {
    return patch.join("\n");
  }

  patch.push(`@@ -0,0 +1,${lines.length} @@`);
  patch.push(...lines.map((line) => `+${line}`));

  if (!content.endsWith("\n")) {
    patch.push("\\ No newline at end of file");
  }

  return patch.join("\n");
}

function splitPatchContentLines(content: string): string[] {
  if (content.length === 0) {
    return [];
  }

  const normalized = content.replaceAll("\r\n", "\n");
  const withoutTrailingNewline = normalized.endsWith("\n") ? normalized.slice(0, -1) : normalized;
  if (withoutTrailingNewline.length === 0) {
    return [];
  }
  return withoutTrailingNewline.split("\n");
}

function formatPatchPath(path: string): string {
  return pathNeedsQuoting(path) ? JSON.stringify(path) : path;
}

function pathNeedsQuoting(path: string): boolean {
  for (let index = 0; index < path.length; index += 1) {
    const code = path.charCodeAt(index);
    if (code <= 0x20 || code === 0x22 || code === 0x5c || code === 0x7f) {
      return true;
    }
  }
  return false;
}

function joinPatchSections(sections: string[]): string {
  return sections.filter((section) => section.trim().length > 0).join("\n");
}

function sortCapturedSnapshotDataByPath(data: CapturedSnapshotData): CapturedSnapshotData {
  const files = [...data.files].sort((left, right) => left.path.localeCompare(right.path));
  const orderedPatches: string[] = [];
  const patchByPath = new Map<string, string>();

  for (const file of files) {
    const patch =
      data.patchByPath.get(file.path) ??
      (file.oldPath ? data.patchByPath.get(file.oldPath) : undefined) ??
      (file.newPath ? data.patchByPath.get(file.newPath) : undefined);
    if (!patch) {
      continue;
    }

    orderedPatches.push(patch);
    patchByPath.set(file.path, patch);
    if (file.oldPath) {
      patchByPath.set(file.oldPath, patch);
    }
    if (file.newPath) {
      patchByPath.set(file.newPath, patch);
    }
  }

  return {
    patch: joinPatchSections(orderedPatches),
    files,
    patchByPath,
  };
}

function dedupeFilesByPath(files: DiffReviewFile[]): DiffReviewFile[] {
  const byPath = new Map<string, DiffReviewFile>();
  for (const file of files) {
    if (!byPath.has(file.path)) {
      byPath.set(file.path, file);
    }
  }
  return [...byPath.values()];
}

function parseNullSeparatedPaths(output: string): string[] {
  if (!output) {
    return [];
  }

  const tokens = output.split("\0");
  if (tokens[tokens.length - 1] === "") {
    tokens.pop();
  }

  return tokens.filter((value) => value.length > 0);
}

async function gitRefExists(
  cwd: string,
  ref: string,
  deps: Pick<DiffSnapshotDeps, "spawn" | "env">,
  signal?: AbortSignal,
): Promise<boolean> {
  const result = await deps.spawn("git", ["rev-parse", "--verify", ref], {
    cwd,
    env: buildGitEnv(deps),
    timeoutMs: GIT_TIMEOUT_MS,
    signal,
    captureOutput: "combined",
    maxCaptureBytes: MAX_SNAPSHOT_PATCH_BYTES,
    maxCaptureMode: "ignore",
  });

  if (result.captureLimitExceeded) {
    throw new Error(
      `git rev-parse --verify ${ref} output exceeded ${MAX_SNAPSHOT_PATCH_BYTES} bytes while capturing diff review snapshot`,
    );
  }

  if (result.exitCode === 0) {
    return true;
  }

  if (result.aborted) {
    throw new Error("diff review start aborted");
  }

  const message = (result.output ?? "").trim();
  if (/not a git repository/i.test(message)) {
    throw new Error("diff review requires a git repository");
  }

  return false;
}

async function runGitCommand(
  cwd: string,
  args: string[],
  deps: Pick<DiffSnapshotDeps, "spawn" | "env">,
  options: { invalidRepoMessage?: string } = {},
  signal?: AbortSignal,
): Promise<string> {
  const result = await deps.spawn("git", args, {
    cwd,
    env: buildGitEnv(deps),
    timeoutMs: GIT_TIMEOUT_MS,
    signal,
    captureOutput: "combined-and-split",
    maxCaptureBytes: MAX_SNAPSHOT_PATCH_BYTES,
    maxCaptureMode: "ignore",
  });

  if (result.captureLimitExceeded) {
    throw new Error(
      `git ${args.join(" ")} output exceeded ${MAX_SNAPSHOT_PATCH_BYTES} bytes while capturing diff review snapshot`,
    );
  }

  if (result.exitCode === 0) {
    return result.stdout;
  }

  if (result.aborted) {
    throw new Error("diff review start aborted");
  }

  const message = (result.stderr || result.stdout || result.output || "").trim();
  if (options.invalidRepoMessage && /not a git repository/i.test(message)) {
    throw new Error(options.invalidRepoMessage);
  }

  throw new Error(message || `git ${args.join(" ")} failed`);
}

function buildGitEnv(deps: Pick<DiffSnapshotDeps, "env">): Record<string, string> {
  return {
    ...deps.env.env(),
    GIT_TERMINAL_PROMPT: "0",
    GIT_EDITOR: "true",
    GIT_SEQUENCE_EDITOR: "true",
    GIT_PAGER: "cat",
    GIT_ASKPASS: "true",
    GIT_SSH_COMMAND: "ssh -o BatchMode=yes",
  };
}

function withForcedPatch(diffArgs: string[]): string[] {
  const separatorIndex = diffArgs.indexOf("--");
  if (separatorIndex < 0) {
    return [...diffArgs, "--patch"];
  }

  return [...diffArgs.slice(0, separatorIndex), "--patch", ...diffArgs.slice(separatorIndex)];
}

function parseNameStatusOutput(output: string): DiffReviewFile[] {
  if (!output) {
    return [];
  }

  const tokens = output.split("\0");
  if (tokens[tokens.length - 1] === "") {
    tokens.pop();
  }

  const files: DiffReviewFile[] = [];
  let index = 0;
  while (index < tokens.length) {
    const statusToken = tokens[index++]?.trim();
    if (!statusToken) {
      continue;
    }

    const statusCode = statusToken[0] ?? "";
    if (statusCode === "R" || statusCode === "C") {
      const oldPath = tokens[index++];
      const newPath = tokens[index++];
      if (!oldPath || !newPath) {
        break;
      }
      files.push({
        path: newPath,
        status: mapNameStatus(statusCode),
        oldPath,
        newPath,
      });
      continue;
    }

    const path = tokens[index++];
    if (!path) {
      break;
    }

    files.push({
      path,
      status: mapNameStatus(statusCode),
      ...(statusCode === "D" ? { oldPath: path } : { newPath: path }),
    });
  }

  return files;
}

function mapNameStatus(statusCode: string): DiffReviewFileStatus {
  switch (statusCode) {
    case "A":
      return "added";
    case "M":
      return "modified";
    case "D":
      return "deleted";
    case "R":
      return "renamed";
    case "C":
      return "copied";
    case "T":
      return "type-changed";
    case "U":
      return "unmerged";
    default:
      return "unknown";
  }
}

function splitPatchSections(patch: string): string[] {
  if (!patch.trim()) {
    return [];
  }

  const matches = [...patch.matchAll(/^diff --git .*$/gm)];
  if (matches.length === 0) {
    return [];
  }

  const sections: string[] = [];
  for (let index = 0; index < matches.length; index += 1) {
    const start = matches[index]?.index;
    if (start === undefined) {
      continue;
    }
    const end = matches[index + 1]?.index ?? patch.length;
    sections.push(patch.slice(start, end));
  }
  return sections;
}

function pairFilePatches(
  files: DiffReviewFile[],
  patchSections: string[],
): ReadonlyMap<string, string> {
  const byPath = new Map<string, string>();
  if (files.length === 0 || patchSections.length === 0) {
    return byPath;
  }

  if (files.length === patchSections.length) {
    for (let index = 0; index < files.length; index += 1) {
      const file = files[index];
      const patch = patchSections[index];
      if (!file || patch === undefined) {
        continue;
      }
      addFilePatchByPath(byPath, file, patch);
    }
    return byPath;
  }

  for (const patch of patchSections) {
    const paths = extractPatchPaths(patch);
    if (!paths) {
      continue;
    }
    const file = files.find((entry) => {
      if (entry.path === paths.newPath || entry.path === paths.oldPath) {
        return true;
      }
      return entry.oldPath === paths.oldPath || entry.newPath === paths.newPath;
    });
    if (!file) {
      continue;
    }
    addFilePatchByPath(byPath, file, patch);
  }

  return byPath;
}

function addFilePatchByPath(
  byPath: Map<string, string>,
  file: DiffReviewFile,
  patch: string,
): void {
  const keys = new Set(
    [file.path, file.oldPath, file.newPath].filter((path): path is string => Boolean(path)),
  );
  for (const key of keys) {
    const existing = byPath.get(key);
    byPath.set(key, existing ? joinPatchSections([existing, patch]) : patch);
  }
}

function parsePatchSectionFile(patch: string): DiffReviewFile {
  const paths = extractPatchPaths(patch);
  if (!paths) {
    throw new Error("patch section is missing a valid diff --git header");
  }

  const lines = patch.split(/\r?\n/);
  const isAdded = lines.some((line) => line === "--- /dev/null");
  const isDeleted = lines.some((line) => line === "+++ /dev/null");
  const isRenamed = lines.some((line) => line.startsWith("rename from "));
  const isCopied = lines.some((line) => line.startsWith("copy from "));

  if (isAdded) {
    return { path: paths.newPath, status: "added", newPath: paths.newPath };
  }
  if (isDeleted) {
    return { path: paths.oldPath, status: "deleted", oldPath: paths.oldPath };
  }
  if (isRenamed) {
    return {
      path: paths.newPath,
      status: "renamed",
      oldPath: paths.oldPath,
      newPath: paths.newPath,
    };
  }
  if (isCopied) {
    return {
      path: paths.newPath,
      status: "copied",
      oldPath: paths.oldPath,
      newPath: paths.newPath,
    };
  }
  return {
    path: paths.newPath,
    status: "modified",
    oldPath: paths.oldPath,
    newPath: paths.newPath,
  };
}

function extractPatchPaths(patch: string): { oldPath: string; newPath: string } | undefined {
  const firstLine = patch.split(/\r?\n/, 1)[0]?.trim();
  if (!firstLine?.startsWith("diff --git ")) {
    return undefined;
  }

  const raw = firstLine.slice("diff --git ".length);
  const match = /^a\/(.+) b\/(.+)$/.exec(raw);
  if (match) {
    return {
      oldPath: match[1] ?? "",
      newPath: match[2] ?? "",
    };
  }

  const oldPath = readGitDiffHeaderPath(raw, 0, "a/");
  if (!oldPath) {
    return undefined;
  }

  let index = oldPath.nextIndex;
  while (index < raw.length && raw[index] === " ") {
    index += 1;
  }

  const newPath = readGitDiffHeaderPath(raw, index, "b/");
  if (!newPath || newPath.nextIndex !== raw.length) {
    return undefined;
  }

  return {
    oldPath: oldPath.path,
    newPath: newPath.path,
  };
}

function readGitDiffHeaderPath(
  input: string,
  startIndex: number,
  prefix: "a/" | "b/",
): { path: string; nextIndex: number } | undefined {
  if (input[startIndex] !== '"') {
    return undefined;
  }

  let path = "";
  let index = startIndex + 1;
  while (index < input.length) {
    const char = input[index];
    if (char === '"') {
      if (!path.startsWith(prefix)) {
        return undefined;
      }
      return {
        path: path.slice(prefix.length),
        nextIndex: index + 1,
      };
    }

    if (char !== "\\") {
      path += char;
      index += 1;
      continue;
    }

    const next = input[index + 1];
    if (next === undefined) {
      return undefined;
    }

    const octal = input.slice(index + 1, index + 4);
    if (/^[0-7]{3}$/.test(octal)) {
      path += String.fromCharCode(Number.parseInt(octal, 8));
      index += 4;
      continue;
    }

    path += decodeGitQuotedEscape(next);
    index += 2;
  }

  return undefined;
}

function decodeGitQuotedEscape(char: string): string {
  switch (char) {
    case "a":
      return "\u0007";
    case "b":
      return "\b";
    case "f":
      return "\f";
    case "n":
      return "\n";
    case "r":
      return "\r";
    case "t":
      return "\t";
    case "v":
      return "\v";
    case "\\":
      return "\\";
    case '"':
      return '"';
    default:
      return char;
  }
}
