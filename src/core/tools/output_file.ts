import type { ToolExecutionBackend } from "./execution_backend.js";

const OUTPUT_FILE_TIMEOUT_MS = 2_000;
const OUTPUT_FILE_SCRIPT = `
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { randomUUID } = require("node:crypto");
const file = path.join(os.tmpdir(), "tau-output." + randomUUID());
fs.closeSync(fs.openSync(file, "wx"));
process.stdout.write(file);
`.trim();

async function createOutputFilePath(backend: ToolExecutionBackend): Promise<string | undefined> {
  try {
    const result = await backend.runNodeScript(OUTPUT_FILE_SCRIPT, [], {
      timeoutMs: OUTPUT_FILE_TIMEOUT_MS,
    });
    if (result.exitCode !== 0) return undefined;
    return result.stdout.trim() || undefined;
  } catch {
    return undefined;
  }
}

export async function writeOutputFile(
  backend: ToolExecutionBackend,
  content: string,
): Promise<string | undefined> {
  if (!content) return undefined;
  const tempPath = await createOutputFilePath(backend);
  if (!tempPath) return undefined;
  try {
    const result = await backend.writeFile(tempPath, content);
    return result.path;
  } catch {
    return undefined;
  }
}
