import { CODE_MODE_MAX_BRIDGE_PAYLOAD_BYTES } from "../core/tools/code_mode_worker.js";

export const TAU_CODE_MODE_MAX_FILES = 128;
export const TAU_CODE_MODE_MAX_TOTAL_FILE_BYTES = 64 * 1024 * 1024;

const FILE_COMMAND_MAX_CAPTURE_BYTES = 8 * 1024 * 1024;

export type TauCodeModeFileAdapterResult = {
  stdout: string;
  stderr: string;
  exitCode: number | null;
};

export type TauCodeModeFileAdapter = {
  runNodeScript(
    script: string,
    options: {
      input: string;
      signal: AbortSignal;
      maxCaptureBytes: number;
    },
  ): Promise<TauCodeModeFileAdapterResult>;
};

export type TauCodeModeFilesOptions = {
  agentId: string;
  adapter: TauCodeModeFileAdapter;
};

export type TauCodeModeFileMetadata = {
  name: string;
  path: string;
  bytes: number;
};

export type TauCodeModeFileList = {
  files: TauCodeModeFileMetadata[];
  totalFiles: number;
  totalBytes: number;
};

type ScratchFileRequest =
  | { operation: "read"; agentId: string; name: string }
  | { operation: "write"; agentId: string; name: string; content: string }
  | { operation: "list"; agentId: string }
  | { operation: "remove"; agentId: string; name: string };

type ScratchFileResponse =
  | { ok: true; value: unknown }
  | { ok: false; error: { name: string; message: string } };

export function createTauCodeModeFilesApi(options: TauCodeModeFilesOptions) {
  if (!options.agentId) throw new Error("code-mode files agentId must not be empty");

  let operationQueue = Promise.resolve();
  const execute = <T>(request: ScratchFileRequest, signal: AbortSignal): Promise<T> => {
    const operation = operationQueue.then(() =>
      executeScratchFileRequest<T>(options.adapter, request, signal),
    );
    operationQueue = operation.then(
      () => undefined,
      () => undefined,
    );
    return operation;
  };

  return {
    read: async (args: unknown[], context: { signal: AbortSignal }) => {
      const [name] = parseArguments(args, ["string"] as const, "files.read");
      return await execute<string>(
        { operation: "read", agentId: options.agentId, name },
        context.signal,
      );
    },
    write: async (args: unknown[], context: { signal: AbortSignal }) => {
      const [name, content] = parseArguments(args, ["string", "string"] as const, "files.write");
      return await execute<{ path: string; bytes: number }>(
        {
          operation: "write",
          agentId: options.agentId,
          name,
          content,
        },
        context.signal,
      );
    },
    list: async (args: unknown[], context: { signal: AbortSignal }) => {
      parseArguments(args, [] as const, "files.list");
      return await execute<TauCodeModeFileList>(
        { operation: "list", agentId: options.agentId },
        context.signal,
      );
    },
    remove: async (args: unknown[], context: { signal: AbortSignal }) => {
      const [name] = parseArguments(args, ["string"] as const, "files.remove");
      return await execute<{ path: string }>(
        {
          operation: "remove",
          agentId: options.agentId,
          name,
        },
        context.signal,
      );
    },
  };
}

function parseArguments<T extends readonly "string"[]>(
  args: unknown[],
  types: T,
  method: string,
): { [K in keyof T]: string } {
  if (args.length !== types.length || args.some((value) => typeof value !== "string")) {
    const signature = types.map((type, index) => `${index === 0 ? "name" : "content"}: ${type}`);
    throw new TypeError(`${method} expects (${signature.join(", ")})`);
  }
  return args as { [K in keyof T]: string };
}

async function executeScratchFileRequest<T>(
  adapter: TauCodeModeFileAdapter,
  request: ScratchFileRequest,
  signal: AbortSignal,
): Promise<T> {
  const result = await adapter.runNodeScript(SCRATCH_FILE_SCRIPT, {
    input: JSON.stringify(request),
    signal,
    maxCaptureBytes: FILE_COMMAND_MAX_CAPTURE_BYTES,
  });
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.trim() || "code-mode scratch file operation failed");
  }

  let response: ScratchFileResponse;
  try {
    response = JSON.parse(result.stdout) as ScratchFileResponse;
  } catch {
    throw new Error("code-mode scratch file operation returned invalid JSON");
  }
  if (!isScratchFileResponse(response)) {
    throw new Error("code-mode scratch file operation returned an invalid response");
  }
  if (!response.ok) {
    const error = new Error(response.error.message);
    error.name = response.error.name;
    throw error;
  }
  return response.value as T;
}

function isScratchFileResponse(value: unknown): value is ScratchFileResponse {
  if (typeof value !== "object" || value === null || !("ok" in value)) return false;
  const response = value as Record<string, unknown>;
  if (response.ok === true) return "value" in response;
  if (response.ok !== false || typeof response.error !== "object" || response.error === null) {
    return false;
  }
  const error = response.error as Record<string, unknown>;
  return typeof error.name === "string" && typeof error.message === "string";
}

const SCRATCH_FILE_SCRIPT = String.raw`
const {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readFileSync,
  readdirSync,
  renameSync,
  unlinkSync,
  writeFileSync,
} = require("node:fs");
const { createHash, randomUUID } = require("node:crypto");
const { tmpdir } = require("node:os");
const { join } = require("node:path");
const { TextDecoder } = require("node:util");

const MAX_NAME_BYTES = 255;
const MAX_OPERATION_BYTES = ${CODE_MODE_MAX_BRIDGE_PAYLOAD_BYTES};
const MAX_FILES = ${TAU_CODE_MODE_MAX_FILES};
const MAX_TOTAL_BYTES = ${TAU_CODE_MODE_MAX_TOTAL_FILE_BYTES};

function fail(message) {
  throw new Error(message);
}

function validateName(name) {
  const bytes = Buffer.byteLength(name, "utf8");
  if (
    bytes === 0 ||
    bytes > MAX_NAME_BYTES ||
    name === "." ||
    name === ".." ||
    name.includes("/") ||
    name.includes("\\") ||
    name.includes("\0")
  ) {
    fail("scratch file name must be a UTF-8 basename between 1 and 255 bytes");
  }
}

function getRoot(agentId) {
  if (typeof agentId !== "string" || agentId.length === 0) fail("agentId must not be empty");
  const scope = createHash("sha256").update(agentId).digest("hex").slice(0, 32);
  const root = join(tmpdir(), "tau-code-mode-files-" + scope);
  try {
    mkdirSync(root, { mode: 0o700 });
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  const stats = lstatSync(root);
  if (stats.isSymbolicLink() || !stats.isDirectory()) {
    fail("code-mode scratch path is not a directory");
  }
  if (typeof process.getuid !== "function" || stats.uid !== process.getuid()) {
    fail("code-mode scratch directory is not owned by the current user");
  }
  if ((stats.mode & 0o077) !== 0) {
    fail("code-mode scratch directory permissions must not allow group or other access");
  }
  return root;
}

function getFilePath(root, name) {
  validateName(name);
  return join(root, name);
}

function getExistingFile(path) {
  let stats;
  try {
    stats = lstatSync(path);
  } catch (error) {
    if (error?.code === "ENOENT") return undefined;
    throw error;
  }
  if (stats.isSymbolicLink() || !stats.isFile()) fail("scratch path is not a regular file");
  return stats;
}

function listFiles(root) {
  const files = [];
  for (const name of readdirSync(root)) {
    const path = join(root, name);
    const stats = lstatSync(path);
    if (stats.isSymbolicLink() || !stats.isFile()) continue;
    files.push({ name, path, bytes: stats.size });
  }
  files.sort((left, right) => left.name.localeCompare(right.name));
  return files;
}

function read(root, name) {
  const path = getFilePath(root, name);
  const descriptor = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const stats = fstatSync(descriptor);
    if (!stats.isFile()) fail("scratch path is not a regular file");
    if (stats.size > MAX_OPERATION_BYTES) {
      fail("scratch file exceeds the 1 MiB read limit");
    }
    const content = readFileSync(descriptor);
    return new TextDecoder("utf-8", { fatal: true }).decode(content);
  } finally {
    closeSync(descriptor);
  }
}

function write(root, name, content) {
  if (typeof content !== "string") fail("scratch file content must be a string");
  const bytes = Buffer.byteLength(content, "utf8");
  if (bytes > MAX_OPERATION_BYTES) fail("scratch file exceeds the 1 MiB write limit");

  const path = getFilePath(root, name);
  const existing = getExistingFile(path);
  const files = listFiles(root);
  const totalBytes = files.reduce((total, file) => total + file.bytes, 0);
  const resultingFiles = files.length + (existing ? 0 : 1);
  const resultingBytes = totalBytes - (existing?.size ?? 0) + bytes;
  if (resultingFiles > MAX_FILES) fail("scratch directory exceeds the 128-file limit");
  if (resultingBytes > MAX_TOTAL_BYTES) fail("scratch directory exceeds the 64 MiB total limit");

  const temporaryPath = join(root, ".tau-write-" + randomUUID());
  let descriptor;
  try {
    descriptor = openSync(
      temporaryPath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
      0o600,
    );
    writeFileSync(descriptor, content, "utf8");
    fsyncSync(descriptor);
    closeSync(descriptor);
    descriptor = undefined;
    renameSync(temporaryPath, path);
  } finally {
    if (descriptor !== undefined) closeSync(descriptor);
    try {
      unlinkSync(temporaryPath);
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  return { path, bytes };
}

function list(root) {
  const allFiles = listFiles(root);
  return {
    files: allFiles.slice(0, MAX_FILES),
    totalFiles: allFiles.length,
    totalBytes: allFiles.reduce((total, file) => total + file.bytes, 0),
  };
}

function remove(root, name) {
  const path = getFilePath(root, name);
  if (!getExistingFile(path)) fail("scratch file does not exist");
  unlinkSync(path);
  return { path };
}

function execute(request) {
  if (typeof request !== "object" || request === null || typeof request.operation !== "string") {
    fail("invalid scratch file request");
  }
  const root = getRoot(request.agentId);
  switch (request.operation) {
    case "read":
      return read(root, request.name);
    case "write":
      return write(root, request.name, request.content);
    case "list":
      return list(root);
    case "remove":
      return remove(root, request.name);
    default:
      fail("unsupported scratch file operation");
  }
}

try {
  const request = JSON.parse(readFileSync(0, "utf8"));
  process.stdout.write(JSON.stringify({ ok: true, value: execute(request) }));
} catch (error) {
  process.stdout.write(
    JSON.stringify({
      ok: false,
      error: {
        name: error instanceof Error ? error.name : "Error",
        message: error instanceof Error ? error.message : String(error),
      },
    }),
  );
}
`;
