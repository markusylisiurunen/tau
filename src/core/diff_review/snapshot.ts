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

export type CaptureDiffReviewSnapshotOptions = {
  cwd: string;
  diffArgs?: string[];
  signal?: AbortSignal;
  deps?: Partial<Pick<CoreDeps, "spawn" | "env">>;
};

const GIT_TIMEOUT_MS = 30_000;
const GIT_MAX_CAPTURE_BYTES = 1024 * 1024;

export class DiffReviewSnapshot {
  readonly id: string;
  readonly repoRoot: string;
  readonly cwd: string;
  readonly diffArgs: string[];
  readonly patch: string;
  readonly files: readonly DiffReviewFile[];
  private readonly patchByPath: ReadonlyMap<string, string>;

  constructor(args: {
    repoRoot: string;
    cwd: string;
    diffArgs: string[];
    patch: string;
    files: DiffReviewFile[];
    patchByPath: ReadonlyMap<string, string>;
    id?: string;
  }) {
    this.id = args.id ?? `tau-diff-${randomUUID()}`;
    this.repoRoot = args.repoRoot;
    this.cwd = args.cwd;
    this.diffArgs = [...args.diffArgs];
    this.patch = args.patch;
    this.files = args.files.map((file) => ({ ...file }));
    this.patchByPath = new Map(args.patchByPath);
  }

  getFilePatch(path: string): string | undefined {
    if (path.length === 0) {
      return undefined;
    }
    return this.patchByPath.get(path);
  }

  toDiffCommand(): string {
    return this.diffArgs.length > 0 ? `git diff ${this.diffArgs.join(" ")}` : "git diff";
  }
}

export async function captureDiffReviewSnapshot(
  options: CaptureDiffReviewSnapshotOptions,
): Promise<DiffReviewSnapshot> {
  const deps = createDiffSnapshotDeps(options.deps);
  const cwd = resolve(options.cwd);
  const diffArgs = [...(options.diffArgs ?? [])];
  const signal = options.signal;
  const repoRoot = await resolveGitRepoRoot(cwd, deps, signal);
  const patch = await runGitCommand(cwd, ["diff", ...diffArgs], deps, {}, signal);
  const files = parseNameStatusOutput(
    await runGitCommand(cwd, ["diff", "--name-status", "-z", ...diffArgs], deps, {}, signal),
  );
  const patchSections = splitPatchSections(
    await runGitCommand(cwd, ["diff", ...withForcedPatch(diffArgs)], deps, {}, signal),
  );
  const patchByPath = pairFilePatches(files, patchSections);

  return new DiffReviewSnapshot({
    repoRoot,
    cwd,
    diffArgs,
    patch,
    files,
    patchByPath,
  });
}

function createDiffSnapshotDeps(
  deps?: Partial<Pick<CoreDeps, "spawn" | "env">>,
): Pick<CoreDeps, "spawn" | "env"> {
  const defaults = createDefaultCoreDeps();
  return {
    spawn: deps?.spawn ?? defaults.spawn,
    env: deps?.env ?? defaults.env,
  };
}

async function resolveGitRepoRoot(
  cwd: string,
  deps: Pick<CoreDeps, "spawn" | "env">,
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

async function runGitCommand(
  cwd: string,
  args: string[],
  deps: Pick<CoreDeps, "spawn" | "env">,
  options: { invalidRepoMessage?: string } = {},
  signal?: AbortSignal,
): Promise<string> {
  const result = await deps.spawn("git", args, {
    cwd,
    env: {
      ...deps.env.env(),
      GIT_TERMINAL_PROMPT: "0",
      GIT_EDITOR: "true",
      GIT_SEQUENCE_EDITOR: "true",
      GIT_PAGER: "cat",
      GIT_ASKPASS: "true",
      GIT_SSH_COMMAND: "ssh -o BatchMode=yes",
    },
    timeoutMs: GIT_TIMEOUT_MS,
    signal,
    captureOutput: "combined",
    maxCaptureBytes: GIT_MAX_CAPTURE_BYTES,
    maxCaptureMode: "ignore",
  });

  if (result.captureLimitExceeded) {
    throw new Error(
      `git ${args.join(" ")} output exceeded ${GIT_MAX_CAPTURE_BYTES} bytes while capturing diff review snapshot`,
    );
  }

  if (result.exitCode === 0) {
    return result.output ?? "";
  }

  if (result.aborted) {
    throw new Error("diff review start aborted");
  }

  const message = (result.output ?? "").trim();
  if (options.invalidRepoMessage && /not a git repository/i.test(message)) {
    throw new Error(options.invalidRepoMessage);
  }

  throw new Error(message || `git ${args.join(" ")} failed`);
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
      byPath.set(file.path, patch);
      if (file.oldPath) {
        byPath.set(file.oldPath, patch);
      }
      if (file.newPath) {
        byPath.set(file.newPath, patch);
      }
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
    byPath.set(file.path, patch);
    if (file.oldPath) {
      byPath.set(file.oldPath, patch);
    }
    if (file.newPath) {
      byPath.set(file.newPath, patch);
    }
  }

  return byPath;
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
