import type { IncomingMessage, ServerResponse } from "node:http";

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

export async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  let body = "";
  request.setEncoding("utf8");

  for await (const chunk of request) {
    body += chunk;
  }

  if (!body.trim()) {
    return {};
  }

  return JSON.parse(body) as unknown;
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

export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function readStringField(source: Record<string, unknown>, key: string): string | undefined {
  const value = source[key];
  if (typeof value !== "string") {
    return undefined;
  }

  const trimmed = value.trim();
  return trimmed || undefined;
}
