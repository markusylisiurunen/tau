import type { z } from "zod";
import { parseMediaJson, readMediaResponse } from "../utils/media_validation.js";
import type { MediaContext } from "./target.js";

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

export async function readMediaJsonResponse<T>(
  response: Response,
  limit: number,
  schema: z.ZodType<T>,
  label: string,
): Promise<T> {
  const value = parseMediaJson((await readMediaResponse(response, limit)).toString("utf8"), label);
  const result = schema.safeParse(value);
  if (!result.success) {
    throw new Error(`${label} is missing required fields or contains invalid values`);
  }
  return result.data;
}

export async function mediaRequest(
  ctx: MediaContext,
  url: string,
  init: RequestInit,
  timeoutMs = 600000,
): Promise<Response> {
  const response = await (ctx.fetchImpl ?? fetch)(url, {
    ...init,
    redirect: "error",
    signal: AbortSignal.any([ctx.signal, AbortSignal.timeout(timeoutMs)]),
  });
  if (!response.ok) {
    await response.body?.cancel();
    throw new Error(`provider request failed (HTTP ${response.status}); no automatic retry`);
  }
  return response;
}
