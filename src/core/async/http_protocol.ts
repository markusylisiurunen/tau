import type { IncomingMessage, ServerResponse } from "node:http";
import { isRecord } from "../utils/type_guards.js";

const DEFAULT_MAX_JSON_BODY_BYTES = 1_000_000;

export type AsyncHttpCreateSessionRequest = {
  projectId: string;
  prompt?: string;
};

export type AsyncHttpSendMessageRequest = {
  text: string;
};

export type AsyncHttpErrorResponse = {
  error: string;
};

export type AsyncHttpSuccessResponse<T> = {
  ok: true;
  data: T;
};

export class AsyncHttpBodyTooLargeError extends Error {
  readonly maxBytes: number;

  constructor(maxBytes: number) {
    super(`request body exceeds ${maxBytes} bytes`);
    this.name = "AsyncHttpBodyTooLargeError";
    this.maxBytes = maxBytes;
  }
}

export class AsyncHttpBodyParseError extends Error {
  constructor() {
    super("request body is not valid json");
    this.name = "AsyncHttpBodyParseError";
  }
}

export async function readJsonBody(
  request: IncomingMessage,
  options?: { maxBytes?: number },
): Promise<unknown> {
  const maxBytes = options?.maxBytes ?? DEFAULT_MAX_JSON_BODY_BYTES;
  let body = "";
  let bytes = 0;

  request.setEncoding("utf8");

  for await (const chunk of request) {
    const textChunk = typeof chunk === "string" ? chunk : String(chunk);
    bytes += Buffer.byteLength(textChunk);

    if (bytes > maxBytes) {
      throw new AsyncHttpBodyTooLargeError(maxBytes);
    }

    body += textChunk;
  }

  if (!body.trim()) {
    return {};
  }

  try {
    return JSON.parse(body) as unknown;
  } catch {
    throw new AsyncHttpBodyParseError();
  }
}

export function sendJson<T>(
  response: ServerResponse,
  statusCode: number,
  payload: AsyncHttpSuccessResponse<T> | AsyncHttpErrorResponse,
): void {
  response.statusCode = statusCode;
  response.setHeader("content-type", "application/json; charset=utf-8");
  response.end(`${JSON.stringify(payload)}\n`);
}

export function sendError(response: ServerResponse, statusCode: number, error: string): void {
  sendJson(response, statusCode, { error });
}

export function sendOk<T>(response: ServerResponse, statusCode: number, data: T): void {
  sendJson(response, statusCode, { ok: true, data });
}

export { isRecord };

export function readStringField(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key];
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed || undefined;
}
