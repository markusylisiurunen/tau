import type { TauSdkSession } from "../../sdk/types.js";

const CHUNK_BYTES = 8_000_000;

export async function storeTelegramAttachment(
  environment: Pick<TauSdkSession, "exec">,
  fileName: string,
  data: Buffer,
  signal: AbortSignal,
): Promise<string> {
  signal.throwIfAborted();
  let path = "";
  try {
    const created = await environment.exec('exec "$0" "$@"', {
      args: ["node", "-e", CREATE_ATTACHMENT_SCRIPT, fileName],
      timeoutMs: 30_000,
      maxCaptureBytes: 4096,
      signal,
    });
    if (created.exitCode !== 0 || created.truncated || created.timedOut || created.aborted) {
      throw new Error("failed to create attachment in the execution environment");
    }
    const targetPath: unknown = JSON.parse(created.stdout);
    if (typeof targetPath !== "string" || !targetPath) {
      throw new Error("invalid attachment path from the execution environment");
    }
    path = targetPath;
    for (let offset = 0; offset < data.length || offset === 0; offset += CHUNK_BYTES) {
      signal.throwIfAborted();
      const result = await environment.exec('exec "$0" "$@"', {
        args: ["node", "-e", WRITE_ATTACHMENT_SCRIPT, path, String(offset)],
        stdin: data.subarray(offset, offset + CHUNK_BYTES),
        timeoutMs: 30_000,
        maxCaptureBytes: 4096,
        signal,
      });
      if (result.exitCode !== 0 || result.truncated || result.timedOut || result.aborted) {
        throw new Error("failed to write attachment in the execution environment");
      }
      signal.throwIfAborted();
    }
    return path;
  } catch (error) {
    if (path) {
      await environment
        .exec('exec "$0" "$@"', {
          args: ["node", "-e", CLEANUP_ATTACHMENT_SCRIPT, path],
          timeoutMs: 10_000,
          maxCaptureBytes: 4096,
        })
        .catch(() => {});
    }
    throw error;
  }
}

const CREATE_ATTACHMENT_SCRIPT = `
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const fileName = process.argv[1];
if (!fileName || path.basename(fileName) !== fileName || fileName === "." || fileName === "..") {
  throw new Error("invalid attachment filename");
}
const directory = fs.mkdtempSync(path.join(os.tmpdir(), "tau-telegram-attachment-"));
process.stdout.write(JSON.stringify(path.join(directory, fileName)));
`.trim();

const WRITE_ATTACHMENT_SCRIPT = `
const fs = require("node:fs");
const [filePath, offsetText] = process.argv.slice(1);
const offset = Number(offsetText);
const data = fs.readFileSync(0);
const fd = fs.openSync(filePath, offset === 0 ? "wx" : "a", 0o600);
try {
  if (fs.fstatSync(fd).size !== offset) throw new Error("attachment changed while writing");
  fs.writeFileSync(fd, data);
} finally {
  fs.closeSync(fd);
}
`.trim();

const CLEANUP_ATTACHMENT_SCRIPT = `
const fs = require("node:fs");
const path = require("node:path");
fs.rmSync(path.dirname(process.argv[1]), { recursive: true, force: true });
`.trim();
