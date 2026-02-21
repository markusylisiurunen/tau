import type { Message } from "@mariozechner/pi-ai";
import { z } from "zod";
import {
  CORE_EVENT_VERSION,
  type CoreEventEnvelope,
  type CoreEventVersion,
  safeParseCoreEventEnvelope,
} from "../events/index.js";
import type { HistoryEntry } from "../session/core_session.js";
import { formatZodError } from "../utils/zod.js";

export const RPC_PROTOCOL_VERSION = 1 as const;

export const RPC_METHODS = [
  "initialize",
  "session.submit",
  "session.interrupt",
  "session.snapshot",
  "session.reset",
  "session.shutdown",
] as const;

export type RpcMethod = (typeof RPC_METHODS)[number];

export const RPC_ERROR_CODES = {
  parseError: "parse_error",
  invalidRequest: "invalid_request",
  methodNotFound: "method_not_found",
  invalidParams: "invalid_params",
  busy: "busy",
  internalError: "internal_error",
} as const;

export type RpcErrorCode = (typeof RPC_ERROR_CODES)[keyof typeof RPC_ERROR_CODES];

export type RpcRequestId = string | number;

export type RpcInitializeParams = {
  client: {
    name: string;
    version: string;
  };
};

export type RpcSessionSubmitParams = {
  text: string;
  historyEntryId?: string;
};

export type RpcSessionInterruptParams = Record<string, never>;
export type RpcSessionSnapshotParams = Record<string, never>;
export type RpcSessionResetParams = Record<string, never>;
export type RpcSessionShutdownParams = Record<string, never>;

export type RpcParamsByMethod = {
  initialize: RpcInitializeParams;
  "session.submit": RpcSessionSubmitParams;
  "session.interrupt": RpcSessionInterruptParams;
  "session.snapshot": RpcSessionSnapshotParams;
  "session.reset": RpcSessionResetParams;
  "session.shutdown": RpcSessionShutdownParams;
};

export type RpcInitializeResult = {
  protocolVersion: typeof RPC_PROTOCOL_VERSION;
  sessionId: string;
  methods: RpcMethod[];
  alreadyInitialized: boolean;
};

export type RpcSessionSubmitResult = {
  userHistoryEntryId: string;
  turn: {
    aborted: boolean;
  };
};

export type RpcSessionInterruptResult = {
  interrupted: boolean;
  isTurnRunning: boolean;
};

export type RpcSessionSnapshotResult = {
  sessionId: string;
  isTurnRunning: boolean;
  historyLength: number;
  history: Message[];
  historyEntries: HistoryEntry[];
};

export type RpcSessionResetResult = {
  previousSessionId: string;
  sessionId: string;
};

export type RpcSessionShutdownResult = {
  shutdown: true;
};

export type RpcResultByMethod = {
  initialize: RpcInitializeResult;
  "session.submit": RpcSessionSubmitResult;
  "session.interrupt": RpcSessionInterruptResult;
  "session.snapshot": RpcSessionSnapshotResult;
  "session.reset": RpcSessionResetResult;
  "session.shutdown": RpcSessionShutdownResult;
};

export type RpcRequestMessage = {
  [M in RpcMethod]: {
    version: typeof RPC_PROTOCOL_VERSION;
    type: "request";
    id: RpcRequestId;
    method: M;
    params: RpcParamsByMethod[M];
  };
}[RpcMethod];

export type RpcSuccessResponseMessage = {
  version: typeof RPC_PROTOCOL_VERSION;
  type: "response";
  id: RpcRequestId;
  ok: true;
  result: RpcResultByMethod[RpcMethod];
};

export type RpcError = {
  code: RpcErrorCode;
  message: string;
  data?: unknown;
};

export type RpcErrorResponseMessage = {
  version: typeof RPC_PROTOCOL_VERSION;
  type: "response";
  id: RpcRequestId | null;
  ok: false;
  error: RpcError;
};

export type RpcResponseMessage = RpcSuccessResponseMessage | RpcErrorResponseMessage;

export type RpcEventMessage = {
  version: typeof RPC_PROTOCOL_VERSION;
  type: "event";
  event: CoreEventEnvelope;
  requestId?: RpcRequestId;
};

export type RpcReadyMessage = {
  version: typeof RPC_PROTOCOL_VERSION;
  type: "ready";
  sessionId: string;
  methods: RpcMethod[];
  coreEventVersion: CoreEventVersion;
};

export type RpcOutgoingMessage = RpcResponseMessage | RpcEventMessage | RpcReadyMessage;

export type RpcOutgoingParseFailureReason =
  | "invalid_payload"
  | "empty_line"
  | "parse_error"
  | "unsupported_version"
  | "unsupported_message_type"
  | "response_invalid_id";

export type RpcOutgoingParseFailure = {
  ok: false;
  reason: RpcOutgoingParseFailureReason;
  messageType: RpcOutgoingMessage["type"] | null;
  id: RpcRequestId | null;
  error: RpcError;
};

export type RpcOutgoingParseSuccess = {
  ok: true;
  message: RpcOutgoingMessage;
};

export type RpcOutgoingParseResult = RpcOutgoingParseFailure | RpcOutgoingParseSuccess;

export type RpcParseFailure = {
  ok: false;
  id: RpcRequestId | null;
  error: RpcError;
};

export type RpcParseSuccess = {
  ok: true;
  request: RpcRequestMessage;
};

export type RpcParseResult = RpcParseFailure | RpcParseSuccess;

export type RpcParamsValidationResult<T> = { ok: true; value: T } | { ok: false; error: RpcError };

const EMPTY_OBJECT = Object.freeze({}) as Record<string, never>;

const rpcMethodSchema = z.enum(RPC_METHODS);
const rpcErrorCodeSchema = z.enum(
  Object.values(RPC_ERROR_CODES) as [RpcErrorCode, ...RpcErrorCode[]],
);
const rpcRequestIdSchema = z.union([z.string(), z.number()]);
const nullableRpcRequestIdSchema = rpcRequestIdSchema.nullable();

const rpcReadyMessageSchema = z
  .object({
    version: z.literal(RPC_PROTOCOL_VERSION),
    type: z.literal("ready"),
    sessionId: z.string(),
    methods: z.array(rpcMethodSchema),
    coreEventVersion: z.literal(CORE_EVENT_VERSION),
  })
  .strict();

const rpcRequestEnvelopeSchema = z
  .object({
    version: z.literal(RPC_PROTOCOL_VERSION),
    type: z.literal("request"),
    id: rpcRequestIdSchema,
    method: z.string(),
    params: z.unknown().optional(),
  })
  .strict();

const rpcOutgoingRoutingSchema = z
  .object({
    version: z.literal(RPC_PROTOCOL_VERSION),
    type: z.enum(["ready", "event", "response"]),
  })
  .passthrough();

const rpcEventMessageSchema = z
  .object({
    version: z.literal(RPC_PROTOCOL_VERSION),
    type: z.literal("event"),
    event: z.unknown(),
    requestId: rpcRequestIdSchema.optional(),
  })
  .strict();

const rpcIdFieldSchema = z.object({ id: z.unknown() }).passthrough();
const rpcVersionFieldSchema = z.object({ version: z.unknown() }).passthrough();
const rpcTypeFieldSchema = z.object({ type: z.unknown() }).passthrough();

const rpcResponseSuccessSchema = z
  .object({
    version: z.literal(RPC_PROTOCOL_VERSION),
    type: z.literal("response"),
    id: rpcRequestIdSchema,
    ok: z.literal(true),
    result: z.unknown(),
  })
  .strict();

const rpcResponseErrorSchema = z
  .object({
    version: z.literal(RPC_PROTOCOL_VERSION),
    type: z.literal("response"),
    id: nullableRpcRequestIdSchema,
    ok: z.literal(false),
    error: z
      .object({
        code: rpcErrorCodeSchema,
        message: z.string(),
        data: z.unknown().optional(),
      })
      .strict(),
  })
  .strict();

const rpcInitializeParamsSchema = z
  .object({
    client: z
      .object({
        name: z.string().trim().min(1),
        version: z.string().trim().min(1),
      })
      .strict(),
  })
  .strict();

const rpcSessionSubmitParamsSchema = z
  .object({
    text: z.string(),
    historyEntryId: z.string().optional(),
  })
  .strict();

const rpcEmptyParamsSchema = z.object({}).strict();

export function isRpcMethod(value: unknown): value is RpcMethod {
  return typeof value === "string" && RPC_METHODS.includes(value as RpcMethod);
}

export function createRpcError(code: RpcErrorCode, message: string, data?: unknown): RpcError {
  return data === undefined ? { code, message } : { code, message, data };
}

export function createRpcSuccessResponse(
  id: RpcRequestId,
  result: RpcResultByMethod[RpcMethod],
): RpcSuccessResponseMessage {
  return {
    version: RPC_PROTOCOL_VERSION,
    type: "response",
    id,
    ok: true,
    result,
  };
}

export function createRpcErrorResponse(
  id: RpcRequestId | null,
  code: RpcErrorCode,
  message: string,
  data?: unknown,
): RpcErrorResponseMessage {
  return {
    version: RPC_PROTOCOL_VERSION,
    type: "response",
    id,
    ok: false,
    error: createRpcError(code, message, data),
  };
}

export function createRpcEventMessage(
  event: CoreEventEnvelope,
  options: { requestId?: RpcRequestId } = {},
): RpcEventMessage {
  return {
    version: RPC_PROTOCOL_VERSION,
    type: "event",
    event,
    ...(options.requestId !== undefined ? { requestId: options.requestId } : {}),
  };
}

export function createRpcReadyMessage(args: { sessionId: string }): RpcReadyMessage {
  return {
    version: RPC_PROTOCOL_VERSION,
    type: "ready",
    sessionId: args.sessionId,
    methods: [...RPC_METHODS],
    coreEventVersion: CORE_EVENT_VERSION,
  };
}

export function serializeRpcMessage(message: RpcOutgoingMessage): string {
  return JSON.stringify(message);
}

export function parseRpcRequestLine(line: string): RpcParseResult {
  const trimmed = line.trim();
  if (!trimmed) {
    return {
      ok: false,
      id: null,
      error: createRpcError(RPC_ERROR_CODES.invalidRequest, "request line cannot be empty"),
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    return {
      ok: false,
      id: null,
      error: createRpcError(RPC_ERROR_CODES.parseError, "failed to parse JSON request line", {
        cause: error instanceof Error ? error.message : String(error),
      }),
    };
  }

  const parsedIdField = rpcIdFieldSchema.safeParse(parsed);
  const requestIdCandidate = parsedIdField.success
    ? parseNullableRequestId(parsedIdField.data.id)
    : null;
  const requestId = requestIdCandidate?.ok ? requestIdCandidate.id : null;

  const requestEnvelope = rpcRequestEnvelopeSchema.safeParse(parsed);
  if (!requestEnvelope.success) {
    if (hasIssue(requestEnvelope.error, [], "invalid_type")) {
      return {
        ok: false,
        id: null,
        error: createRpcError(RPC_ERROR_CODES.invalidRequest, "request must be a JSON object"),
      };
    }

    if (hasIssue(requestEnvelope.error, ["id"])) {
      return {
        ok: false,
        id: null,
        error: createRpcError(
          RPC_ERROR_CODES.invalidRequest,
          "request id must be a string or number",
        ),
      };
    }

    if (hasIssue(requestEnvelope.error, [], "unrecognized_keys")) {
      return {
        ok: false,
        id: requestId,
        error: createRpcError(
          RPC_ERROR_CODES.invalidRequest,
          "request contains unsupported top-level fields",
        ),
      };
    }

    if (hasIssue(requestEnvelope.error, ["version"])) {
      const parsedVersionField = rpcVersionFieldSchema.safeParse(parsed);
      const version = parsedVersionField.success ? parsedVersionField.data.version : undefined;
      return {
        ok: false,
        id: requestId,
        error: createRpcError(
          RPC_ERROR_CODES.invalidRequest,
          `unsupported rpc version: ${String(version)}`,
        ),
      };
    }

    if (hasIssue(requestEnvelope.error, ["type"])) {
      return {
        ok: false,
        id: requestId,
        error: createRpcError(RPC_ERROR_CODES.invalidRequest, 'request.type must be "request"'),
      };
    }

    if (hasIssue(requestEnvelope.error, ["method"])) {
      return {
        ok: false,
        id: requestId,
        error: createRpcError(RPC_ERROR_CODES.invalidRequest, "request.method must be a string"),
      };
    }

    return {
      ok: false,
      id: requestId,
      error: createRpcError(
        RPC_ERROR_CODES.invalidRequest,
        `request is invalid: ${formatZodError(requestEnvelope.error)}`,
      ),
    };
  }

  const method = requestEnvelope.data.method;
  if (!isRpcMethod(method)) {
    return {
      ok: false,
      id: requestEnvelope.data.id,
      error: createRpcError(RPC_ERROR_CODES.methodNotFound, `unsupported method: ${method}`),
    };
  }

  const params = validateRpcParams(method, requestEnvelope.data.params);
  if (!params.ok) {
    return {
      ok: false,
      id: requestEnvelope.data.id,
      error: params.error,
    };
  }

  return {
    ok: true,
    request: {
      version: RPC_PROTOCOL_VERSION,
      type: "request",
      id: requestEnvelope.data.id,
      method,
      params: params.value,
    } as RpcRequestMessage,
  };
}

export function parseRpcOutgoingLine(line: string): RpcOutgoingParseResult {
  const trimmed = line.trim();
  if (!trimmed) {
    return outgoingParseFailure(
      null,
      null,
      RPC_ERROR_CODES.invalidRequest,
      "rpc line cannot be empty",
      undefined,
      "empty_line",
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(trimmed);
  } catch (error) {
    return outgoingParseFailure(
      null,
      null,
      RPC_ERROR_CODES.parseError,
      "failed to parse JSON rpc line",
      {
        cause: error instanceof Error ? error.message : String(error),
      },
      "parse_error",
    );
  }

  const routing = rpcOutgoingRoutingSchema.safeParse(parsed);
  if (!routing.success) {
    if (hasIssue(routing.error, [], "invalid_type")) {
      return outgoingParseFailure(
        null,
        null,
        RPC_ERROR_CODES.invalidRequest,
        "rpc payload must be a JSON object",
      );
    }

    if (hasIssue(routing.error, ["version"])) {
      const parsedVersionField = rpcVersionFieldSchema.safeParse(parsed);
      const version = parsedVersionField.success ? parsedVersionField.data.version : undefined;
      return outgoingParseFailure(
        null,
        null,
        RPC_ERROR_CODES.invalidRequest,
        `unsupported rpc version: ${String(version)}`,
        undefined,
        "unsupported_version",
      );
    }

    const parsedTypeField = rpcTypeFieldSchema.safeParse(parsed);
    const messageType = parsedTypeField.success ? parsedTypeField.data.type : undefined;
    return outgoingParseFailure(
      null,
      null,
      RPC_ERROR_CODES.invalidRequest,
      `unsupported rpc message type: ${String(messageType)}`,
      undefined,
      "unsupported_message_type",
    );
  }

  if (routing.data.type === "ready") {
    return parseRpcReadyMessage(parsed as Record<string, unknown>);
  }

  if (routing.data.type === "event") {
    return parseRpcEventMessage(parsed);
  }

  return parseRpcResponseMessage(parsed as Record<string, unknown>);
}

export function validateRpcParams(
  method: "initialize",
  params: unknown,
): RpcParamsValidationResult<RpcInitializeParams>;
export function validateRpcParams(
  method: "session.submit",
  params: unknown,
): RpcParamsValidationResult<RpcSessionSubmitParams>;
export function validateRpcParams(
  method: "session.interrupt",
  params: unknown,
): RpcParamsValidationResult<RpcSessionInterruptParams>;
export function validateRpcParams(
  method: "session.snapshot",
  params: unknown,
): RpcParamsValidationResult<RpcSessionSnapshotParams>;
export function validateRpcParams(
  method: "session.reset",
  params: unknown,
): RpcParamsValidationResult<RpcSessionResetParams>;
export function validateRpcParams(
  method: "session.shutdown",
  params: unknown,
): RpcParamsValidationResult<RpcSessionShutdownParams>;
export function validateRpcParams(
  method: RpcMethod,
  params: unknown,
): RpcParamsValidationResult<RpcParamsByMethod[RpcMethod]>;
export function validateRpcParams(
  method: RpcMethod,
  params: unknown,
): RpcParamsValidationResult<RpcParamsByMethod[RpcMethod]> {
  switch (method) {
    case "initialize":
      return validateInitializeParams(params);
    case "session.submit":
      return validateSubmitParams(params);
    case "session.interrupt":
    case "session.snapshot":
    case "session.reset":
    case "session.shutdown":
      return validateNoParams(method, params);
  }
}

function validateInitializeParams(params: unknown): RpcParamsValidationResult<RpcInitializeParams> {
  const parsed = rpcInitializeParamsSchema.safeParse(params);
  if (!parsed.success) {
    const message = hasIssue(parsed.error, [], "invalid_type")
      ? "initialize params must be an object with client metadata"
      : hasIssue(parsed.error, ["client"]) || hasIssue(parsed.error, [], "unrecognized_keys")
        ? "initialize.client must be an object with name/version strings"
        : hasIssue(parsed.error, ["client", "name"])
          ? "initialize.client.name must be a non-empty string"
          : hasIssue(parsed.error, ["client", "version"])
            ? "initialize.client.version must be a non-empty string"
            : `initialize params are invalid: ${formatZodError(parsed.error)}`;
    return invalidParams(message);
  }

  return {
    ok: true,
    value: {
      client: {
        name: parsed.data.client.name,
        version: parsed.data.client.version,
      },
    },
  };
}

function validateSubmitParams(params: unknown): RpcParamsValidationResult<RpcSessionSubmitParams> {
  const parsed = rpcSessionSubmitParamsSchema.safeParse(params);
  if (!parsed.success) {
    const message = hasIssue(parsed.error, [], "invalid_type")
      ? "session.submit params must be an object"
      : hasIssue(parsed.error, [], "unrecognized_keys")
        ? "session.submit params only support text and optional historyEntryId"
        : hasIssue(parsed.error, ["text"])
          ? "session.submit params.text must be a string"
          : hasIssue(parsed.error, ["historyEntryId"])
            ? "session.submit params.historyEntryId must be a string when provided"
            : `session.submit params are invalid: ${formatZodError(parsed.error)}`;
    return invalidParams(message);
  }

  return {
    ok: true,
    value: {
      text: parsed.data.text,
      ...(parsed.data.historyEntryId !== undefined
        ? { historyEntryId: parsed.data.historyEntryId }
        : {}),
    },
  };
}

function validateNoParams(
  method: Exclude<RpcMethod, "initialize" | "session.submit">,
  params: unknown,
): RpcParamsValidationResult<Record<string, never>> {
  const parsed = rpcEmptyParamsSchema.safeParse(params);
  if (!parsed.success) {
    return invalidParams(`${method} params must be an empty object`);
  }

  return { ok: true, value: EMPTY_OBJECT };
}

function parseRpcReadyMessage(payload: Record<string, unknown>): RpcOutgoingParseResult {
  const ready = rpcReadyMessageSchema.safeParse(payload);
  if (!ready.success) {
    return outgoingParseFailure(
      "ready",
      null,
      RPC_ERROR_CODES.invalidRequest,
      `invalid ready message: ${formatZodError(ready.error)}`,
    );
  }

  return {
    ok: true,
    message: {
      version: RPC_PROTOCOL_VERSION,
      type: "ready",
      sessionId: ready.data.sessionId,
      methods: [...ready.data.methods],
      coreEventVersion: CORE_EVENT_VERSION,
    },
  };
}

function parseRpcEventMessage(payload: unknown): RpcOutgoingParseResult {
  const fail = (message: string) =>
    outgoingParseFailure("event", null, RPC_ERROR_CODES.invalidRequest, message);

  const eventMessage = rpcEventMessageSchema.safeParse(payload);
  if (!eventMessage.success) {
    if (hasIssue(eventMessage.error, [], "unrecognized_keys")) {
      return fail("event message contains unsupported fields");
    }

    if (hasIssue(eventMessage.error, ["requestId"])) {
      return fail("event.requestId must be a string or number when provided");
    }

    return fail(`invalid event message: ${formatZodError(eventMessage.error)}`);
  }

  const event = safeParseCoreEventEnvelope(eventMessage.data.event);
  if (!event.ok) {
    return fail(event.message);
  }

  return {
    ok: true,
    message: {
      version: RPC_PROTOCOL_VERSION,
      type: "event",
      event: event.value,
      ...(eventMessage.data.requestId !== undefined
        ? { requestId: eventMessage.data.requestId }
        : {}),
    },
  };
}

function parseRpcResponseMessage(payload: Record<string, unknown>): RpcOutgoingParseResult {
  const responseId = parseNullableRequestId(payload.id);
  const requestId = responseId.ok ? responseId.id : null;
  const fail = (
    message: string,
    reason: RpcOutgoingParseFailureReason = "invalid_payload",
    id: RpcRequestId | null = requestId,
  ) =>
    outgoingParseFailure(
      "response",
      id,
      RPC_ERROR_CODES.invalidRequest,
      message,
      undefined,
      reason,
    );

  if (!responseId.ok) {
    return fail("response.id must be a string or number", "response_invalid_id", null);
  }

  if (payload.ok === true) {
    const successResponse = rpcResponseSuccessSchema.safeParse(payload);
    if (!successResponse.success) {
      if (hasIssue(successResponse.error, [], "unrecognized_keys")) {
        return fail("successful response must only include result payload");
      }

      if (hasIssue(successResponse.error, ["result"], "invalid_type")) {
        return fail("successful response must include result");
      }

      if (hasIssue(successResponse.error, ["id"])) {
        return fail("successful response.id must be a string or number", "response_invalid_id");
      }

      return fail(`invalid successful response: ${formatZodError(successResponse.error)}`);
    }

    return {
      ok: true,
      message: {
        version: RPC_PROTOCOL_VERSION,
        type: "response",
        id: successResponse.data.id,
        ok: true,
        result: successResponse.data.result as RpcResultByMethod[RpcMethod],
      },
    };
  }

  if (payload.ok !== false) {
    return fail("response.ok must be true or false");
  }

  const errorResponse = rpcResponseErrorSchema.safeParse(payload);
  if (!errorResponse.success) {
    if (hasIssue(errorResponse.error, [], "unrecognized_keys")) {
      return fail("error response must only include error payload");
    }

    if (hasIssue(errorResponse.error, ["error"])) {
      return fail("error response.error must be an object");
    }

    if (
      hasIssue(errorResponse.error, ["error", "code"]) ||
      hasIssue(errorResponse.error, ["error", "message"])
    ) {
      return fail("error response.error must include a valid code and string message");
    }

    return fail(`invalid error response: ${formatZodError(errorResponse.error)}`);
  }

  return {
    ok: true,
    message: {
      version: RPC_PROTOCOL_VERSION,
      type: "response",
      id: errorResponse.data.id,
      ok: false,
      error: errorResponse.data.error,
    },
  };
}

function parseRequestId(value: unknown): { ok: true; id: RpcRequestId } | { ok: false } {
  if (typeof value === "string" || typeof value === "number") {
    return { ok: true, id: value };
  }

  return { ok: false };
}

function parseNullableRequestId(
  value: unknown,
): { ok: true; id: RpcRequestId | null } | { ok: false } {
  if (value === null) {
    return { ok: true, id: null };
  }

  const parsed = parseRequestId(value);
  if (!parsed.ok) {
    return { ok: false };
  }

  return { ok: true, id: parsed.id };
}

function outgoingParseFailure(
  messageType: RpcOutgoingMessage["type"] | null,
  id: RpcRequestId | null,
  code: RpcErrorCode,
  message: string,
  data?: unknown,
  reason: RpcOutgoingParseFailureReason = "invalid_payload",
): RpcOutgoingParseFailure {
  return {
    ok: false,
    reason,
    messageType,
    id,
    error: createRpcError(code, message, data),
  };
}

function hasIssue(
  error: z.ZodError,
  path: readonly string[] = [],
  code?: z.ZodIssue["code"],
): boolean {
  return error.issues.some(
    (issue) =>
      (code === undefined || issue.code === code) &&
      issue.path.length === path.length &&
      issue.path.every((segment, i) => segment === path[i]),
  );
}

function invalidParams(message: string): RpcParamsValidationResult<never> {
  return {
    ok: false,
    error: createRpcError(RPC_ERROR_CODES.invalidParams, message),
  };
}
