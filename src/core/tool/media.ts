import { lstat, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { type ParseArgsConfig, parseArgs } from "node:util";
import { ToolCliError } from "./errors.js";

export function parseMediaArgs<const T extends NonNullable<ParseArgsConfig["options"]>>(
  argv: string[],
  options: T,
) {
  try {
    return parseArgs({ args: argv, options, allowPositionals: false }).values;
  } catch (error) {
    throw new ToolCliError(error instanceof Error ? error.message : String(error));
  }
}

export function requiredArg(value: unknown, name: string): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new ToolCliError(`--${name} is required`);
  }
  return value;
}

export async function prepareMediaOutput(output: string, cwd: string) {
  const path = resolve(cwd, output);
  try {
    await lstat(path);
    throw new ToolCliError(`output already exists: ${path}`);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
      throw error;
    }
  }
  const parts = `${path}.parts`;
  await mkdir(parts, { mode: 0o700 });
  return { path, parts };
}

export async function mediaRequest(
  fetchImpl: typeof fetch,
  url: string,
  init: RequestInit,
): Promise<Response> {
  const response = await fetchImpl(url, {
    ...init,
    redirect: "error",
    signal: AbortSignal.timeout(10 * 60 * 1000),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new ToolCliError(`provider request failed (HTTP ${response.status}); no automatic retry`);
  }
  return response;
}

export async function readMediaResponse(response: Response, limit: number): Promise<Buffer> {
  const reader = response.body?.getReader();
  if (!reader) {
    throw new ToolCliError("provider returned an empty response");
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) {
        break;
      }
      size += value.length;
      if (size > limit) {
        throw new ToolCliError("provider response exceeds the size limit");
      }
      chunks.push(value);
    }
  } finally {
    await reader.cancel();
  }
  return Buffer.concat(chunks);
}
