import { link, lstat, mkdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { type ParseArgsConfig, parseArgs } from "node:util";
import type { z } from "zod";
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

export function describeMediaError(error: unknown): string {
  const { code, path } = (error ?? {}) as NodeJS.ErrnoException;
  const location = path ? `: ${path}` : "";
  switch (code) {
    case "EEXIST":
      return `path already exists${location}; existing files were not overwritten`;
    case "ENOENT":
      return `file or parent directory does not exist${location}; check the path and create any missing parent directory`;
    case "EACCES":
    case "EPERM":
      return `permission denied${location}; check file and directory permissions`;
    case "ENOTDIR":
      return `a path component is not a directory${location}; correct the path`;
    case "EISDIR":
      return `expected a file, but found a directory${location}; choose a file path`;
    case "ENOSPC":
    case "EDQUOT":
      return `insufficient disk space or storage quota${location}; make space before saving artifacts`;
    case "EROFS":
      return `filesystem is read-only${location}; use a writable location`;
    default:
      return error instanceof Error ? error.message : String(error);
  }
}

export async function readMediaInput(path: string, label: string): Promise<Buffer> {
  try {
    return await readFile(path);
  } catch (error) {
    throw new ToolCliError(`cannot read ${label}: ${describeMediaError(error)}`);
  }
}

export function parseMediaJson(text: string, label: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new ToolCliError(`${label} is not valid JSON`);
  }
}

export function mediaValidationConstraint(issue: z.core.$ZodIssue): string {
  switch (issue.code) {
    case "invalid_value":
      return `use ${issue.values.map((value) => JSON.stringify(value)).join(" or ")}`;
    case "invalid_type":
      return `expected ${issue.expected}`;
    case "unrecognized_keys":
      return `remove unknown fields: ${issue.keys.join(", ")}`;
    case "too_small":
      return `must contain at least ${issue.minimum} ${issue.origin === "array" ? "item" : "character"}${issue.minimum === 1 ? "" : "s"}`;
    case "invalid_key":
      return `invalid field name: ${issue.issues.map(mediaValidationConstraint).join("; ")}`;
    default:
      return issue.message;
  }
}

export async function readMediaJsonResponse<T>(
  response: Response,
  limit: number,
  schema: z.ZodType<T>,
  label: string,
): Promise<T> {
  const value = parseMediaJson((await readMediaResponse(response, limit)).toString("utf8"), label);
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new ToolCliError(`${label} is missing required fields or contains invalid values`);
  }
  return result.data;
}

export async function prepareMediaOutput(output: string, cwd: string) {
  const path = resolve(cwd, output);
  try {
    await lstat(path);
    throw new ToolCliError(`output already exists: ${path}; choose a fresh --output path`);
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "ENOENT")) {
      throw new ToolCliError(describeMediaError(error));
    }
  }
  const parts = `${path}.parts`;
  try {
    await mkdir(parts, { mode: 0o700 });
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "EEXIST") {
      throw new ToolCliError(
        `artifact directory already exists: ${parts}; choose a fresh --output path and preserve existing recovery artifacts`,
      );
    }
    throw new ToolCliError(`cannot create artifact directory: ${describeMediaError(error)}`);
  }
  return { path, parts };
}

export async function publishMediaArtifact(artifact: string, output: string): Promise<void> {
  try {
    await link(artifact, output);
  } catch (error) {
    throw new ToolCliError(
      `cannot publish output: ${describeMediaError(error)}; completed artifact retained at ${artifact}; copy it to a fresh output path instead of generating again`,
    );
  }
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
