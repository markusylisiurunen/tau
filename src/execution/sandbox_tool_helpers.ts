import type { WriteFileResult } from "../core/tools/execution_backend.js";
import { formatBytes } from "../core/utils/truncate.js";

export const NODE_LIST_DIR_SCRIPT = [
  "const fs = require('fs');",
  "const path = process.argv[1];",
  "const entries = fs.readdirSync(path, { withFileTypes: true }).map((entry) => ({",
  "name: entry.name,",
  "isDirectory: entry.isDirectory(),",
  "isSymlink: entry.isSymbolicLink(),",
  "}));",
  "console.log(JSON.stringify(entries));",
].join("");

export function shellQuote(arg: string): string {
  if (/^[A-Za-z0-9@%+=:,./-]+$/.test(arg)) {
    return arg;
  }
  return `'${arg.replaceAll("'", "'\\''")}'`;
}

export function assertFileWithinMaxBytes(bytes: number, maxBytes: number | undefined): void {
  if (maxBytes !== undefined && bytes > maxBytes) {
    throw new Error(
      `file exceeds maximum size of ${formatBytes(maxBytes)} (got ${formatBytes(bytes)}).`,
    );
  }
}

export function buildWriteFileResult(path: string, content: string): WriteFileResult {
  return {
    path,
    bytes: Buffer.byteLength(content, "utf-8"),
    lines: content.split("\n").length,
  };
}
