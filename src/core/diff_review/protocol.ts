import { z } from "zod";
import type { DiffReviewFile } from "./snapshot.js";

export const DIFF_REVIEW_PROTOCOL_VERSION = 1 as const;

export const DIFF_REVIEW_CLIENT_METHODS = [
  "initialize",
  "session.get_context",
  "session.list_files",
  "session.get_diff",
  "session.set_ui_text",
  "thread.submit_message",
  "session.return_review",
  "session.cancel",
] as const;

export const DIFF_REVIEW_SERVER_METHODS = ["session.close"] as const;

export const DIFF_REVIEW_METHODS = [
  ...DIFF_REVIEW_CLIENT_METHODS,
  ...DIFF_REVIEW_SERVER_METHODS,
] as const;

export type DiffReviewClientMethod = (typeof DIFF_REVIEW_CLIENT_METHODS)[number];
export type DiffReviewServerMethod = (typeof DIFF_REVIEW_SERVER_METHODS)[number];
export type DiffReviewMethod = (typeof DIFF_REVIEW_METHODS)[number];

export const DIFF_REVIEW_ERROR_CODES = {
  parseError: "parse_error",
  invalidRequest: "invalid_request",
  methodNotFound: "method_not_found",
  invalidParams: "invalid_params",
  unauthorized: "unauthorized",
  notInitialized: "not_initialized",
  sessionClosed: "session_closed",
  internalError: "internal_error",
} as const;

export type DiffReviewErrorCode =
  (typeof DIFF_REVIEW_ERROR_CODES)[keyof typeof DIFF_REVIEW_ERROR_CODES];

export type DiffReviewRequestId = string | number;

export type DiffReviewInitializeParams = {
  token: string;
};

export type DiffReviewSessionGetContextParams = Record<string, never>;
export type DiffReviewSessionListFilesParams = Record<string, never>;
export type DiffReviewSessionGetDiffParams = {
  path?: string;
};
export type DiffReviewSessionSetUiTextParams = {
  text: string;
};
export type DiffReviewThreadSubmitMessageParams = {
  threadId?: string;
  forkFromThreadId?: string;
  message: string;
};
export type DiffReviewSessionReturnReviewParams = {
  review: string;
};
export type DiffReviewSessionCancelParams = Record<string, never>;
export type DiffReviewSessionCloseParams = Record<string, never>;

export type DiffReviewParamsByMethod = {
  initialize: DiffReviewInitializeParams;
  "session.get_context": DiffReviewSessionGetContextParams;
  "session.list_files": DiffReviewSessionListFilesParams;
  "session.get_diff": DiffReviewSessionGetDiffParams;
  "session.set_ui_text": DiffReviewSessionSetUiTextParams;
  "thread.submit_message": DiffReviewThreadSubmitMessageParams;
  "session.return_review": DiffReviewSessionReturnReviewParams;
  "session.cancel": DiffReviewSessionCancelParams;
  "session.close": DiffReviewSessionCloseParams;
};

export type DiffReviewResultStatus = "returned" | "cancelled";

export type DiffReviewInitializeResult = {
  protocolVersion: typeof DIFF_REVIEW_PROTOCOL_VERSION;
  sessionId: string;
  methods: DiffReviewClientMethod[];
  alreadyInitialized: boolean;
};

export type DiffReviewSessionContextResult = {
  sessionId: string;
  repoRoot: string;
  cwd: string;
  diffArgs: string[];
  diffCommand: string;
};

export type DiffReviewSessionListFilesResult = {
  files: DiffReviewFile[];
};

export type DiffReviewSessionGetDiffResult =
  | {
      scope: "session";
      patch: string;
    }
  | {
      scope: "file";
      path: string;
      patch: string;
    };

export type DiffReviewSessionSetUiTextResult = {
  status: "updated";
};

export type DiffReviewThreadSubmitMessageResult = {
  threadId: string;
  response: string;
};

export type DiffReviewSessionReturnReviewResult = {
  status: Extract<DiffReviewResultStatus, "returned">;
};

export type DiffReviewSessionCancelResult = {
  status: Extract<DiffReviewResultStatus, "cancelled">;
};

export type DiffReviewSessionCloseResult = {
  status: "closed";
};

export type DiffReviewResultByMethod = {
  initialize: DiffReviewInitializeResult;
  "session.get_context": DiffReviewSessionContextResult;
  "session.list_files": DiffReviewSessionListFilesResult;
  "session.get_diff": DiffReviewSessionGetDiffResult;
  "session.set_ui_text": DiffReviewSessionSetUiTextResult;
  "thread.submit_message": DiffReviewThreadSubmitMessageResult;
  "session.return_review": DiffReviewSessionReturnReviewResult;
  "session.cancel": DiffReviewSessionCancelResult;
  "session.close": DiffReviewSessionCloseResult;
};

export type DiffReviewRequestMessage = {
  [M in DiffReviewMethod]: {
    version: typeof DIFF_REVIEW_PROTOCOL_VERSION;
    type: "request";
    id: DiffReviewRequestId;
    method: M;
    params: DiffReviewParamsByMethod[M];
  };
}[DiffReviewMethod];

export type DiffReviewError = {
  code: DiffReviewErrorCode;
  message: string;
  data?: unknown;
};

export type DiffReviewSuccessResponseMessage = {
  version: typeof DIFF_REVIEW_PROTOCOL_VERSION;
  type: "response";
  id: DiffReviewRequestId;
  ok: true;
  result: DiffReviewResultByMethod[DiffReviewMethod];
};

export type DiffReviewErrorResponseMessage = {
  version: typeof DIFF_REVIEW_PROTOCOL_VERSION;
  type: "response";
  id: DiffReviewRequestId | null;
  ok: false;
  error: DiffReviewError;
};

export type DiffReviewResponseMessage =
  | DiffReviewSuccessResponseMessage
  | DiffReviewErrorResponseMessage;

export type DiffReviewMessage = DiffReviewRequestMessage | DiffReviewResponseMessage;

export type DiffReviewParseFailure = {
  ok: false;
  id: DiffReviewRequestId | null;
  error: DiffReviewError;
};

export type DiffReviewParseSuccess = {
  ok: true;
  request: DiffReviewRequestMessage;
};

export type DiffReviewMessageParseSuccess = {
  ok: true;
  message: DiffReviewMessage;
};

export type DiffReviewParseResult = DiffReviewParseFailure | DiffReviewParseSuccess;
export type DiffReviewMessageParseResult = DiffReviewParseFailure | DiffReviewMessageParseSuccess;

export type DiffReviewParamsValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; error: DiffReviewError };

const EMPTY_OBJECT = Object.freeze({}) as Record<string, never>;

const diffReviewMethodSchema = z.enum(DIFF_REVIEW_METHODS);
const diffReviewRequestIdSchema = z.union([z.string(), z.number()]);
const diffReviewRequestEnvelopeSchema = z
  .object({
    version: z.literal(DIFF_REVIEW_PROTOCOL_VERSION),
    type: z.literal("request"),
    id: diffReviewRequestIdSchema,
    method: z.string(),
    params: z.unknown().optional(),
  })
  .strip();
const diffReviewErrorSchema = z
  .object({
    code: z.string().trim().min(1),
    message: z.string(),
    data: z.unknown().optional(),
  })
  .strip();
const diffReviewSuccessResponseSchema = z
  .object({
    version: z.literal(DIFF_REVIEW_PROTOCOL_VERSION),
    type: z.literal("response"),
    id: diffReviewRequestIdSchema,
    ok: z.literal(true),
    result: z.unknown(),
  })
  .strip();
const diffReviewErrorResponseSchema = z
  .object({
    version: z.literal(DIFF_REVIEW_PROTOCOL_VERSION),
    type: z.literal("response"),
    id: z.union([diffReviewRequestIdSchema, z.null()]),
    ok: z.literal(false),
    error: diffReviewErrorSchema,
  })
  .strip();
const diffReviewResponseSchema = z.union([
  diffReviewSuccessResponseSchema,
  diffReviewErrorResponseSchema,
]);
const diffReviewIdFieldSchema = z.object({ id: z.unknown() }).strip();
const diffReviewVersionFieldSchema = z.object({ version: z.unknown() }).strip();
const diffReviewTypeFieldSchema = z.object({ type: z.unknown() }).strip();
const emptyObjectSchema = z.object({}).strip();

const initializeParamsSchema = z
  .object({
    token: z.string().trim().min(1),
  })
  .strip();
const sessionGetDiffParamsSchema = z
  .object({
    path: z.string().min(1).optional(),
  })
  .strip();
const sessionSetUiTextParamsSchema = z
  .object({
    text: z.string(),
  })
  .strip();
const threadSubmitMessageParamsSchema = z
  .object({
    threadId: z.string().trim().min(1).optional(),
    forkFromThreadId: z.string().trim().min(1).optional(),
    message: z.string().trim().min(1),
  })
  .strip()
  .superRefine((value, context) => {
    if (value.threadId && value.forkFromThreadId) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["forkFromThreadId"],
        message: "forkFromThreadId can only be used when creating a new thread",
      });
    }
  });
const sessionReturnReviewParamsSchema = z
  .object({
    review: z.string().trim().min(1),
  })
  .strip();

export function createDiffReviewError(
  code: DiffReviewErrorCode,
  message: string,
  data?: unknown,
): DiffReviewError {
  return data === undefined ? { code, message } : { code, message, data };
}

export function createDiffReviewSuccessResponse<M extends DiffReviewMethod>(
  id: DiffReviewRequestId,
  result: DiffReviewResultByMethod[M],
): DiffReviewSuccessResponseMessage {
  return {
    version: DIFF_REVIEW_PROTOCOL_VERSION,
    type: "response",
    id,
    ok: true,
    result,
  };
}

export function createDiffReviewErrorResponse(
  id: DiffReviewRequestId | null,
  code: DiffReviewErrorCode,
  message: string,
  data?: unknown,
): DiffReviewErrorResponseMessage {
  return {
    version: DIFF_REVIEW_PROTOCOL_VERSION,
    type: "response",
    id,
    ok: false,
    error: createDiffReviewError(code, message, data),
  };
}

export function serializeDiffReviewMessage(message: DiffReviewMessage): string {
  return `${JSON.stringify(message)}\n`;
}

export function validateDiffReviewParams<M extends DiffReviewMethod>(
  method: M,
  raw: unknown,
): DiffReviewParamsValidationResult<DiffReviewParamsByMethod[M]> {
  const parsed = (() => {
    switch (method) {
      case "initialize":
        return initializeParamsSchema.safeParse(raw);
      case "session.get_context":
      case "session.list_files":
      case "session.cancel":
      case "session.close":
        return emptyObjectSchema.safeParse(raw ?? EMPTY_OBJECT);
      case "session.get_diff":
        return sessionGetDiffParamsSchema.safeParse(raw ?? EMPTY_OBJECT);
      case "session.set_ui_text":
        return sessionSetUiTextParamsSchema.safeParse(raw);
      case "thread.submit_message":
        return threadSubmitMessageParamsSchema.safeParse(raw);
      case "session.return_review":
        return sessionReturnReviewParamsSchema.safeParse(raw);
    }
  })();

  if (parsed.success) {
    return {
      ok: true,
      value: parsed.data as DiffReviewParamsByMethod[M],
    };
  }

  return {
    ok: false,
    error: createDiffReviewError(
      DIFF_REVIEW_ERROR_CODES.invalidParams,
      formatParamsError(method, parsed.error),
    ),
  };
}

export function parseDiffReviewMessageLine(line: string): DiffReviewMessageParseResult {
  const trimmed = line.trim();
  if (!trimmed) {
    return {
      ok: false,
      id: null,
      error: createDiffReviewError(DIFF_REVIEW_ERROR_CODES.parseError, "request line is empty"),
    };
  }

  let decoded: unknown;
  try {
    decoded = JSON.parse(trimmed) as unknown;
  } catch (error) {
    return {
      ok: false,
      id: null,
      error: createDiffReviewError(
        DIFF_REVIEW_ERROR_CODES.parseError,
        "failed to parse request json",
        { cause: error instanceof Error ? error.message : String(error) },
      ),
    };
  }

  const versionField = diffReviewVersionFieldSchema.safeParse(decoded);
  if (!versionField.success) {
    return {
      ok: false,
      id: null,
      error: createDiffReviewError(
        DIFF_REVIEW_ERROR_CODES.invalidRequest,
        "request must include numeric version field",
      ),
    };
  }

  if (versionField.data.version !== DIFF_REVIEW_PROTOCOL_VERSION) {
    return {
      ok: false,
      id: null,
      error: createDiffReviewError(
        DIFF_REVIEW_ERROR_CODES.invalidRequest,
        `unsupported diff review protocol version: ${String(versionField.data.version)}`,
      ),
    };
  }

  const typeField = diffReviewTypeFieldSchema.safeParse(decoded);
  if (
    !typeField.success ||
    (typeField.data.type !== "request" && typeField.data.type !== "response")
  ) {
    return {
      ok: false,
      id: null,
      error: createDiffReviewError(
        DIFF_REVIEW_ERROR_CODES.invalidRequest,
        "message type must be 'request' or 'response'",
      ),
    };
  }

  if (typeField.data.type === "request") {
    return parseDecodedDiffReviewRequest(decoded);
  }

  return parseDecodedDiffReviewResponse(decoded);
}

export function parseDiffReviewRequestLine(line: string): DiffReviewParseResult {
  const parsed = parseDiffReviewMessageLine(line);
  if (!parsed.ok) {
    return parsed;
  }

  if (parsed.message.type !== "request") {
    return {
      ok: false,
      id: parsed.message.id,
      error: createDiffReviewError(
        DIFF_REVIEW_ERROR_CODES.invalidRequest,
        "message type must be 'request'",
      ),
    };
  }

  return {
    ok: true,
    request: parsed.message,
  };
}

function parseDecodedDiffReviewRequest(decoded: unknown): DiffReviewMessageParseResult {
  const idField = diffReviewIdFieldSchema.safeParse(decoded);
  const parsedId = idField.success ? diffReviewRequestIdSchema.safeParse(idField.data.id) : null;
  const requestId = parsedId?.success ? parsedId.data : null;

  const envelope = diffReviewRequestEnvelopeSchema.safeParse(decoded);
  if (!envelope.success) {
    const hasMethod = envelope.error.issues.some((issue) => issue.path[0] === "method");
    const message = hasMethod
      ? "request must include string method field"
      : "request contains unsupported or invalid top-level fields";
    return {
      ok: false,
      id: requestId,
      error: createDiffReviewError(DIFF_REVIEW_ERROR_CODES.invalidRequest, message),
    };
  }

  const parsedMethod = diffReviewMethodSchema.safeParse(envelope.data.method);
  if (!parsedMethod.success) {
    return {
      ok: false,
      id: envelope.data.id,
      error: createDiffReviewError(
        DIFF_REVIEW_ERROR_CODES.methodNotFound,
        `unknown diff review method '${envelope.data.method}'`,
      ),
    };
  }

  const paramsResult = validateDiffReviewParams(
    parsedMethod.data,
    envelope.data.params ?? EMPTY_OBJECT,
  );
  if (!paramsResult.ok) {
    return {
      ok: false,
      id: envelope.data.id,
      error: paramsResult.error,
    };
  }

  return {
    ok: true,
    message: {
      version: DIFF_REVIEW_PROTOCOL_VERSION,
      type: "request",
      id: envelope.data.id,
      method: parsedMethod.data,
      params: paramsResult.value,
    } as DiffReviewRequestMessage,
  };
}

function parseDecodedDiffReviewResponse(decoded: unknown): DiffReviewMessageParseResult {
  const envelope = diffReviewResponseSchema.safeParse(decoded);
  if (!envelope.success) {
    const idField = diffReviewIdFieldSchema.safeParse(decoded);
    const parsedId = idField.success
      ? z.union([diffReviewRequestIdSchema, z.null()]).safeParse(idField.data.id)
      : null;
    const responseId = parsedId?.success ? parsedId.data : null;

    return {
      ok: false,
      id: responseId,
      error: createDiffReviewError(
        DIFF_REVIEW_ERROR_CODES.invalidRequest,
        "response contains unsupported or invalid top-level fields",
      ),
    };
  }

  return {
    ok: true,
    message: envelope.data as DiffReviewResponseMessage,
  };
}

function formatParamsError(method: DiffReviewMethod, _error: z.ZodError): string {
  switch (method) {
    case "initialize":
      return "initialize.token must be a non-empty string";
    case "session.get_context":
    case "session.list_files":
    case "session.cancel":
    case "session.close":
      return `${method} does not accept parameters`;
    case "session.get_diff":
      return "session.get_diff.path must be a non-empty string when provided";
    case "session.set_ui_text":
      return "session.set_ui_text.text must be a string";
    case "thread.submit_message":
      return "thread.submit_message requires a non-empty message, optional threadId, and optional forkFromThreadId when creating a new thread";
    case "session.return_review":
      return "session.return_review.review must be a non-empty string";
  }
}
