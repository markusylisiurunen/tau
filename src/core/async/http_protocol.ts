import type { IncomingMessage, ServerResponse } from "node:http";
import { z } from "zod";
import { formatZodError } from "../utils/zod.js";

const DEFAULT_MAX_JSON_BODY_BYTES = 1_000_000;

type AsyncHttpDecodedRoute =
  | { route: "healthz" }
  | { route: "create-session" }
  | { route: "list-sessions" }
  | { route: "get-session"; sessionId: string }
  | { route: "get-session-logs"; sessionId: string }
  | { route: "send-message"; sessionId: string }
  | { route: "interrupt-session"; sessionId: string }
  | { route: "list-cron-jobs" }
  | { route: "list-cron-runs" }
  | { route: "trigger-cron-job"; jobId: string };

export class AsyncHttpRequestParseError extends Error {
  readonly statusCode: number;

  constructor(message: string, statusCode = 400) {
    super(message);
    this.name = "AsyncHttpRequestParseError";
    this.statusCode = statusCode;
  }
}

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
  payload: { ok: true; data: T } | { error: string },
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

function decodePathSegment(segment: string, errorMessage: string): string {
  try {
    const decoded = decodeURIComponent(segment);
    if (!decoded) {
      throw new Error("empty");
    }
    return decoded;
  } catch {
    throw new AsyncHttpRequestParseError(errorMessage);
  }
}

function decodeSessionRoute(
  route: "get-session" | "get-session-logs" | "send-message" | "interrupt-session",
): (segment: string) => AsyncHttpDecodedRoute {
  return (segment) => ({
    route,
    sessionId: decodePathSegment(segment, "invalid session id"),
  });
}

const dynamicRoutes = [
  [/^\/v1\/sessions\/([^/]+)$/, "GET", decodeSessionRoute("get-session")],
  [/^\/v1\/sessions\/([^/]+)\/logs$/, "GET", decodeSessionRoute("get-session-logs")],
  [/^\/v1\/sessions\/([^/]+)\/messages$/, "POST", decodeSessionRoute("send-message")],
  [/^\/v1\/sessions\/([^/]+)\/interrupt$/, "POST", decodeSessionRoute("interrupt-session")],
  [
    /^\/v1\/cron\/jobs\/([^/]+)\/run$/,
    "POST",
    (segment: string): AsyncHttpDecodedRoute => ({
      route: "trigger-cron-job",
      jobId: decodePathSegment(segment, "invalid cron job id"),
    }),
  ],
] as const;

export function decodeAsyncHttpRoute(
  method: string,
  pathname: string,
): AsyncHttpDecodedRoute | "not-found" | "method-not-allowed" {
  if (pathname === "/healthz") {
    return { route: "healthz" };
  }

  if (pathname === "/v1/sessions") {
    return method === "POST"
      ? { route: "create-session" }
      : method === "GET"
        ? { route: "list-sessions" }
        : "not-found";
  }

  if (pathname === "/v1/cron/jobs") {
    return method === "GET" ? { route: "list-cron-jobs" } : "method-not-allowed";
  }

  if (pathname === "/v1/cron/runs") {
    return method === "GET" ? { route: "list-cron-runs" } : "method-not-allowed";
  }

  for (const [pattern, expectedMethod, decode] of dynamicRoutes) {
    const segment = pattern.exec(pathname)?.[1];
    if (segment !== undefined) {
      return method === expectedMethod ? decode(segment) : "method-not-allowed";
    }
  }

  return "not-found";
}

const trimmedNonEmptyStringSchema = z
  .string()
  .transform((value) => value.trim())
  .pipe(z.string().min(1));

const createSessionBodySchema = z
  .object({
    projectId: trimmedNonEmptyStringSchema,
    prompt: trimmedNonEmptyStringSchema.optional(),
  })
  .strict();

const sendMessageBodySchema = z.object({ text: trimmedNonEmptyStringSchema }).strict();

const cronRunsQueryInputSchema = z
  .object({
    jobId: z.array(z.string()).max(1).optional(),
    limit: z.array(z.string()).max(1).optional(),
  })
  .strict();

const positiveIntegerSchema = z
  .string()
  .regex(/^\d+$/)
  .transform((value) => Number.parseInt(value, 10))
  .pipe(z.number().int().safe().positive());

function parseSchemaOrThrow<T>(schema: z.ZodType<T>, raw: unknown, context: string): T {
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    throw new AsyncHttpRequestParseError(`${context}: ${formatZodError(parsed.error)}`);
  }
  return parsed.data;
}

export function parseCreateSessionBody(raw: unknown): { projectId: string; prompt?: string } {
  return parseSchemaOrThrow(createSessionBodySchema, raw, "invalid create-session body");
}

export function parseSendMessageBody(raw: unknown): { text: string } {
  return parseSchemaOrThrow(sendMessageBodySchema, raw, "invalid send-message body");
}

export function parseCronRunsQuery(searchParams: URLSearchParams): {
  jobId?: string;
  limit?: number;
} {
  const query: Record<string, string[]> = {};
  for (const [key, value] of searchParams) {
    const values = query[key];
    if (values) {
      values.push(value);
    } else {
      query[key] = [value];
    }
  }

  const parsed = parseSchemaOrThrow(cronRunsQueryInputSchema, query, "invalid cron-runs query");
  const parseOptional = <T>(
    value: string[] | undefined,
    schema: z.ZodType<T>,
    key: "jobId" | "limit",
  ): T | undefined =>
    value
      ? parseSchemaOrThrow(schema, value[0], `invalid cron-runs query parameter ${key}`)
      : undefined;

  const jobId = parseOptional(parsed.jobId, trimmedNonEmptyStringSchema, "jobId");
  const limit = parseOptional(parsed.limit, positiveIntegerSchema, "limit");
  return { ...(jobId === undefined ? {} : { jobId }), ...(limit === undefined ? {} : { limit }) };
}
