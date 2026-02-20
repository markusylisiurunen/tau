import type { Message } from "@mariozechner/pi-ai";
import {
  CORE_EVENT_VERSION,
  type CoreEventEnvelope,
  type CoreEventVersion,
} from "../events/types.js";
import type { HistoryEntry } from "../session/core_session.js";

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
  client?: {
    name?: string;
    version?: string;
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

  if (!isRecord(parsed)) {
    return {
      ok: false,
      id: null,
      error: createRpcError(RPC_ERROR_CODES.invalidRequest, "request must be a JSON object"),
    };
  }

  const maybeId = parseRequestId(parsed.id);
  if (!maybeId.ok) {
    return {
      ok: false,
      id: null,
      error: createRpcError(
        RPC_ERROR_CODES.invalidRequest,
        "request id must be a string or number",
      ),
    };
  }

  const id = maybeId.id;

  if (parsed.version !== RPC_PROTOCOL_VERSION) {
    return {
      ok: false,
      id,
      error: createRpcError(
        RPC_ERROR_CODES.invalidRequest,
        `unsupported rpc version: ${String(parsed.version)}`,
      ),
    };
  }

  if (parsed.type !== "request") {
    return {
      ok: false,
      id,
      error: createRpcError(RPC_ERROR_CODES.invalidRequest, 'request.type must be "request"'),
    };
  }

  const method = parsed.method;
  if (typeof method !== "string") {
    return {
      ok: false,
      id,
      error: createRpcError(RPC_ERROR_CODES.invalidRequest, "request.method must be a string"),
    };
  }

  if (!isRpcMethod(method)) {
    return {
      ok: false,
      id,
      error: createRpcError(RPC_ERROR_CODES.methodNotFound, `unsupported method: ${method}`),
    };
  }

  const params = validateRpcParams(method, parsed.params);
  if (!params.ok) {
    return {
      ok: false,
      id,
      error: params.error,
    };
  }

  return {
    ok: true,
    request: {
      version: RPC_PROTOCOL_VERSION,
      type: "request",
      id,
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

  if (!isRecord(parsed)) {
    return outgoingParseFailure(
      null,
      null,
      RPC_ERROR_CODES.invalidRequest,
      "rpc payload must be a JSON object",
    );
  }

  if (parsed.version !== RPC_PROTOCOL_VERSION) {
    return outgoingParseFailure(
      null,
      null,
      RPC_ERROR_CODES.invalidRequest,
      `unsupported rpc version: ${String(parsed.version)}`,
      undefined,
      "unsupported_version",
    );
  }

  if (parsed.type === "ready") {
    return parseRpcReadyMessage(parsed);
  }

  if (parsed.type === "event") {
    return parseRpcEventMessage(parsed);
  }

  if (parsed.type === "response") {
    return parseRpcResponseMessage(parsed);
  }

  return outgoingParseFailure(
    null,
    null,
    RPC_ERROR_CODES.invalidRequest,
    `unsupported rpc message type: ${String(parsed.type)}`,
    undefined,
    "unsupported_message_type",
  );
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
  if (!isRecord(params) || !hasOnlyKeys(params, ["client"])) {
    return invalidParams("initialize params must be an object with optional client metadata");
  }

  const client = params.client;
  if (client === undefined) {
    return { ok: true, value: EMPTY_OBJECT };
  }

  if (!isRecord(client) || !hasOnlyKeys(client, ["name", "version"])) {
    return invalidParams("initialize.client must be an object with optional name/version strings");
  }

  if (
    (client.name !== undefined && typeof client.name !== "string") ||
    (client.version !== undefined && typeof client.version !== "string")
  ) {
    return invalidParams("initialize.client.name and initialize.client.version must be strings");
  }

  return {
    ok: true,
    value: {
      client: {
        ...(client.name !== undefined ? { name: client.name } : {}),
        ...(client.version !== undefined ? { version: client.version } : {}),
      },
    },
  };
}

function validateSubmitParams(params: unknown): RpcParamsValidationResult<RpcSessionSubmitParams> {
  if (!isRecord(params)) {
    return invalidParams("session.submit params must be an object");
  }

  if (!hasOnlyKeys(params, ["text", "historyEntryId"])) {
    return invalidParams("session.submit params only support text and optional historyEntryId");
  }

  if (typeof params.text !== "string") {
    return invalidParams("session.submit params.text must be a string");
  }

  if (params.historyEntryId !== undefined && typeof params.historyEntryId !== "string") {
    return invalidParams("session.submit params.historyEntryId must be a string when provided");
  }

  return {
    ok: true,
    value: {
      text: params.text,
      ...(params.historyEntryId !== undefined ? { historyEntryId: params.historyEntryId } : {}),
    },
  };
}

function validateNoParams(
  method: Exclude<RpcMethod, "initialize" | "session.submit">,
  params: unknown,
): RpcParamsValidationResult<Record<string, never>> {
  if (!isRecord(params) || Object.keys(params).length !== 0) {
    return invalidParams(`${method} params must be an empty object`);
  }

  return { ok: true, value: EMPTY_OBJECT };
}

function parseRpcReadyMessage(payload: Record<string, unknown>): RpcOutgoingParseResult {
  if (typeof payload.sessionId !== "string") {
    return outgoingParseFailure(
      "ready",
      null,
      RPC_ERROR_CODES.invalidRequest,
      "ready.sessionId must be a string",
    );
  }

  if (!Array.isArray(payload.methods) || !payload.methods.every((method) => isRpcMethod(method))) {
    return outgoingParseFailure(
      "ready",
      null,
      RPC_ERROR_CODES.invalidRequest,
      "ready.methods must contain supported rpc methods",
    );
  }

  if (payload.coreEventVersion !== CORE_EVENT_VERSION) {
    return outgoingParseFailure(
      "ready",
      null,
      RPC_ERROR_CODES.invalidRequest,
      `unsupported core event version: ${String(payload.coreEventVersion)}`,
    );
  }

  return {
    ok: true,
    message: {
      version: RPC_PROTOCOL_VERSION,
      type: "ready",
      sessionId: payload.sessionId,
      methods: [...payload.methods],
      coreEventVersion: CORE_EVENT_VERSION,
    },
  };
}

function parseRpcEventMessage(payload: Record<string, unknown>): RpcOutgoingParseResult {
  const event = parseCoreEventEnvelope(payload.event);
  if (!event.ok) {
    return outgoingParseFailure(
      "event",
      null,
      event.error.code,
      event.error.message,
      event.error.data,
    );
  }

  if (payload.requestId !== undefined) {
    const requestId = parseRequestId(payload.requestId);
    if (!requestId.ok) {
      return outgoingParseFailure(
        "event",
        null,
        RPC_ERROR_CODES.invalidRequest,
        "event.requestId must be a string or number when provided",
      );
    }

    return {
      ok: true,
      message: {
        version: RPC_PROTOCOL_VERSION,
        type: "event",
        event: event.envelope,
        requestId: requestId.id,
      },
    };
  }

  return {
    ok: true,
    message: {
      version: RPC_PROTOCOL_VERSION,
      type: "event",
      event: event.envelope,
    },
  };
}

function parseRpcResponseMessage(payload: Record<string, unknown>): RpcOutgoingParseResult {
  const responseId = parseNullableRequestId(payload.id);
  const requestId = responseId.ok ? responseId.id : null;
  if (!responseId.ok) {
    return outgoingParseFailure(
      "response",
      null,
      RPC_ERROR_CODES.invalidRequest,
      "response.id must be a string or number",
      undefined,
      "response_invalid_id",
    );
  }

  if (payload.ok === true) {
    const correlatedId = parseRequestId(payload.id);
    if (!correlatedId.ok) {
      return outgoingParseFailure(
        "response",
        requestId,
        RPC_ERROR_CODES.invalidRequest,
        "successful response.id must be a string or number",
        undefined,
        "response_invalid_id",
      );
    }

    if (!("result" in payload)) {
      return outgoingParseFailure(
        "response",
        correlatedId.id,
        RPC_ERROR_CODES.invalidRequest,
        "successful response must include result",
      );
    }

    return {
      ok: true,
      message: {
        version: RPC_PROTOCOL_VERSION,
        type: "response",
        id: correlatedId.id,
        ok: true,
        result: payload.result as RpcResultByMethod[RpcMethod],
      },
    };
  }

  if (payload.ok === false) {
    if (!isRecord(payload.error)) {
      return outgoingParseFailure(
        "response",
        requestId,
        RPC_ERROR_CODES.invalidRequest,
        "error response.error must be an object",
      );
    }

    const code = payload.error.code;
    const message = payload.error.message;
    if (!isRpcErrorCode(code) || typeof message !== "string") {
      return outgoingParseFailure(
        "response",
        requestId,
        RPC_ERROR_CODES.invalidRequest,
        "error response.error must include a valid code and string message",
      );
    }

    return {
      ok: true,
      message: {
        version: RPC_PROTOCOL_VERSION,
        type: "response",
        id: requestId,
        ok: false,
        error: {
          code,
          message,
          ...("data" in payload.error ? { data: payload.error.data } : {}),
        },
      },
    };
  }

  return outgoingParseFailure(
    "response",
    requestId,
    RPC_ERROR_CODES.invalidRequest,
    "response.ok must be true or false",
  );
}

function parseCoreEventEnvelope(
  value: unknown,
): { ok: true; envelope: CoreEventEnvelope } | { ok: false; error: RpcError } {
  if (!isRecord(value)) {
    return {
      ok: false,
      error: createRpcError(
        RPC_ERROR_CODES.invalidRequest,
        "event.event must be a core event envelope",
      ),
    };
  }

  if (value.version !== CORE_EVENT_VERSION) {
    return {
      ok: false,
      error: createRpcError(
        RPC_ERROR_CODES.invalidRequest,
        `unsupported core event version: ${String(value.version)}`,
      ),
    };
  }

  if (!isRecord(value.event) || typeof value.event.type !== "string") {
    return {
      ok: false,
      error: createRpcError(
        RPC_ERROR_CODES.invalidRequest,
        "event.event.event must be a core event object with a string type",
      ),
    };
  }

  return {
    ok: true,
    envelope: {
      version: CORE_EVENT_VERSION,
      event: value.event as CoreEventEnvelope["event"],
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

function isRpcErrorCode(value: unknown): value is RpcErrorCode {
  return (
    typeof value === "string" && Object.values(RPC_ERROR_CODES).includes(value as RpcErrorCode)
  );
}

function invalidParams(message: string): RpcParamsValidationResult<never> {
  return {
    ok: false,
    error: createRpcError(RPC_ERROR_CODES.invalidParams, message),
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: string[]): boolean {
  const allowed = new Set(keys);
  return Object.keys(value).every((key) => allowed.has(key));
}
