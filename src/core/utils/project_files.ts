import { spawnWithCapture } from "./spawn_capture.js";

const MAX_STDOUT_BYTES = 10 * 1024 * 1024;
const MAX_FILE_COUNT = 50_000;
const MAX_DIRECTORY_COUNT = 25_000;
const MAX_ENTRY_COUNT = MAX_FILE_COUNT + MAX_DIRECTORY_COUNT;
const RIPGREP_TIMEOUT_MS = 5000;

async function runRipgrepFiles(cwd: string): Promise<{ status: number; stdout: string }> {
  const result = await spawnWithCapture("rg", ["--files", "--hidden", "--glob", "!.git/"], {
    cwd,
    maxCaptureBytes: MAX_STDOUT_BYTES,
    timeoutMs: RIPGREP_TIMEOUT_MS,
    stdio: ["ignore", "pipe", "ignore"],
  });

  return { status: result.exitCode ?? 1, stdout: result.stdout };
}

function listFilesFromOutput(stdout: string): string[] {
  const files: string[] = [];
  const seen = new Set<string>();

  for (const line of stdout.split("\n")) {
    const file = line.trim();
    if (!file || seen.has(file)) continue;

    files.push(file);
    seen.add(file);

    if (files.length >= MAX_FILE_COUNT) break;
  }

  return files;
}

function listDirectoriesFromFiles(files: string[]): string[] {
  const out = new Set<string>();

  for (const file of files) {
    const parts = file.split("/");
    if (parts.length <= 1) continue;

    for (let i = 1; i < parts.length; i += 1) {
      const dir = parts.slice(0, i).join("/");
      if (dir) out.add(`${dir}/`);
      if (out.size >= MAX_DIRECTORY_COUNT) return [...out];
    }
  }

  return [...out];
}

function combineEntries(files: Iterable<string>, dirs: Iterable<string>): string[] {
  const out = new Set<string>();

  for (const file of files) {
    out.add(file);
    if (out.size >= MAX_ENTRY_COUNT) break;
  }

  if (out.size < MAX_ENTRY_COUNT) {
    for (const dir of dirs) {
      out.add(dir);
      if (out.size >= MAX_ENTRY_COUNT) break;
    }
  }

  return [...out].sort();
}

export async function listProjectFilesAsync(cwd: string): Promise<string[]> {
  try {
    const res = await runRipgrepFiles(cwd);
    if (res.status !== 0 && !res.stdout) return [];

    const files = listFilesFromOutput(res.stdout);
    return combineEntries(files, listDirectoriesFromFiles(files));
  } catch {
    return [];
  }
}
